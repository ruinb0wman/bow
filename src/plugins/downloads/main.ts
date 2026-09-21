/**
 * 下载插件(主进程侧):接管 `session.defaultSession` 的下载、维护记录并提供 IPC 与 MCP 工具。
 *
 * 三个必须记住的前提:
 * 1. **全仓库只有一个 session**:标签页 / chrome / overlay 都没指定 `partition`,所以一个
 *    `will-download` 监听就覆盖所有下载入口(与 `main/plugins/netHooks.ts` 独占 defaultSession 同理)。
 * 2. **`will-download` 的注册必须在 `activate()` 最末**:内核在 activate 抛错时只调 `ctx.dispose()`,
 *    **不会**调 `module.deactivate`(见 docs/ARCHITECTURE.md §5.3),把注册放前面会漏掉监听器。
 * 3. **保存路径的两条路**:不调 `setSavePath` 时 Electron 走原始流程弹保存对话框(这就是 bow 一直以来的行为);
 *    调了就静默保存。询问模式下 `getSavePath()` 直到 `done` 才有值 —— 对话框没有「结束」事件(electron#41640)。
 *
 * 与 `shared.ts` 的分工:状态语义 / 动作可用性 / 文案全在 shared(可单测),这里只管 IO 与生命周期。
 */

import { BrowserWindow, app, dialog, session, shell } from 'electron'
import type { DownloadItem, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import { errorContent, textContent } from '../../main/plugins/mcpResult'
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  DOWNLOADS_EVENT,
  DOWNLOAD_STATE_LABELS,
  isTerminal,
  normalizeSettings,
  percentOf,
  reconcileOnStart,
  sanitizeRecords,
  sortRecords,
  trimRecords,
  uniqueFileName,
  type DownloadActionResult,
  type DownloadRecord,
  type DownloadState,
  type DownloadsListResult,
  type DownloadsSettings,
  type DownloadsSettingsState
} from './shared'

/** AI 指令:`session.downloadURL()` 触发的下载用它决定落点(并让 `browser_download` 不弹对话框) */
interface Directive {
  url: string
  saveDir?: string
  filename?: string
  /** true = 一定静默保存;false = 遵循「下载前询问保存位置」设置(重新下载走这条) */
  silent: boolean
  retriedFrom?: string
  createdAt: number
  onCreated?: (record: DownloadRecord) => void
}

interface InFlight {
  item: DownloadItem
  record: DownloadRecord
}

/** 进行中记录的落盘节流(终态与状态迁移一律立即落盘) */
const PERSIST_INTERVAL_MS = 1000
/** AI 指令若这么久没被 will-download 消费就作废(地址被拦截 / 下载没起来) */
const DIRECTIVE_TTL_MS = 15_000
/**
 * 无 URL 可匹配时,多久以内的队首指令允许被「认领」。
 * `session.downloadURL()` 触发的下载实测可能拿不到 URL(item.getURL() 为空),
 * 那时只能靠时间窗把指令交给紧随其后的 will-download。
 */
const DIRECTIVE_FRESH_MS = 5000
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const MAX_WAIT_TIMEOUT_MS = 120_000
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 200

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(n)))
}

function clampTimeout(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_WAIT_TIMEOUT_MS
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(1000, Math.floor(n)))
}

function createDownloadsPlugin(): PluginMain {
  let store: PluginStorage<DownloadRecord[]> | null = null
  let settingsStore: PluginStorage<DownloadsSettings> | null = null
  /** 内存里的记录表才是真相,store 只是它的落点(节流写盘时两者会短暂不一致) */
  let list: DownloadRecord[] = []
  const live = new Map<string, InFlight>()
  const directives: Directive[] = []
  let onWillDownload: ((event: unknown, item: DownloadItem, wc: WebContents) => void) | null = null
  let lastPersist = 0

  /** deactivate 里落一次盘:store 刻意不置空 —— 停用后 in-flight 的终态仍要写进 downloads.json */
  const flushOnDeactivate = (ctx: PluginContext): void => {
    if (!store) return
    try {
      const max = normalizeSettings(settingsStore?.get(), DEFAULT_DOWNLOAD_SETTINGS).maxRecords
      store.setRaw(trimRecords(list, max))
      lastPersist = Date.now()
    } catch (e) {
      ctx.logError('停用时写入 downloads.json 失败', e)
    }
  }

  return {
    manifest: {
      id: 'downloads',
      name: '下载',
      description:
        '下载记录与管理:暂停 / 恢复 / 重新下载 / 取消,可设置保存目录;并向 AI 提供 browser_list_downloads / browser_download',
      version: '1.0.0'
    },
    capabilities: ['ui', 'mcp'],

    activate(ctx: PluginContext): void {
      const ses = session.defaultSession
      store = ctx.storage<DownloadRecord[]>({ file: 'downloads.json', defaults: [] })
      settingsStore = ctx.storage<DownloadsSettings>({
        file: 'downloads-settings.json',
        defaults: DEFAULT_DOWNLOAD_SETTINGS
      })

      // 读盘 → 归一:进程里已经没有 DownloadItem,所有未完成记录降级为「已中断」(用户可手动重新下载)
      const reconciled = reconcileOnStart(sanitizeRecords(store.get()))
      // 「停用 → 重新启用」发生在同一进程时,in-flight 项的实时状态比磁盘快照新,优先用它
      list = reconciled.map((r) => {
        const entry = live.get(r.id)
        if (!entry) return r
        const cur = entry.record
        return {
          ...r,
          state: cur.state,
          receivedBytes: cur.receivedBytes,
          totalBytes: cur.totalBytes || r.totalBytes,
          bytesPerSecond: cur.bytesPerSecond,
          ...(cur.restarted ? { restarted: true } : {}),
          error: undefined
        }
      })
      store.setRaw(list)
      ctx.log('下载记录已载入', list.length, '条;进行中', live.size)

      // ---------- 基础 ----------
      const settings = (): DownloadsSettings => normalizeSettings(settingsStore?.get(), DEFAULT_DOWNLOAD_SETTINGS)

      const downloadDir = (): string => settings().downloadDir || app.getPath('downloads')

      const settingsState = (): DownloadsSettingsState => {
        const value = settings()
        return { settings: value, dir: value.downloadDir || downloadDir(), dirIsDefault: value.downloadDir === '' }
      }

      const emitChanged = (): void => {
        ctx.ipc.emit(DOWNLOADS_EVENT.changed)
      }

      const commit = (force = false): void => {
        if (!store) return
        list = trimRecords(list, settings().maxRecords)
        const now = Date.now()
        if (!force && now - lastPersist < PERSIST_INTERVAL_MS) return
        lastPersist = now
        store.setRaw(list)
      }

      const withFileExists = (r: DownloadRecord): DownloadRecord =>
        r.state === 'completed' ? { ...r, fileExists: existsSync(r.savePath) } : r

      const snapshot = (): DownloadRecord[] => sortRecords(list).map(withFileExists)

      // ---------- will-download ----------
      const resolveSaveDir = (candidate?: string): string => {
        if (!candidate) return downloadDir()
        if (!isAbsolute(candidate)) {
          ctx.log('忽略非绝对路径的 saveDir', candidate)
          return downloadDir()
        }
        return candidate
      }

      /** 静默保存:确保目录存在 + 同名去重(setSavePath 会**覆盖**已存在的文件,不能直接写) */
      const silentSave = (item: DownloadItem, dir: string, filename: string): void => {
        try {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        } catch (e) {
          ctx.logError('创建下载目录失败', dir, e)
        }
        const target = uniqueFileName(filename, (n) => existsSync(join(dir, n)))
        item.setSavePath(join(dir, target))
        ctx.log('静默保存到', join(dir, target))
      }

      /** 取出与本下载匹配的 AI 指令(顺带清掉过期项)。URL 不匹配就不消费,避免把指令错配给手动下载 */
      const takeDirective = (url: string, chain: string[]): Directive | undefined => {
        const now = Date.now()
        while (directives.length > 0 && now - directives[0].createdAt > DIRECTIVE_TTL_MS) directives.shift()
        const exact = directives.findIndex((d) => d.url === url || chain.includes(d.url))
        if (exact >= 0) return directives.splice(exact, 1)[0]
        // 兜底:`session.downloadURL()` 触发的下载实测可能连 URL 都拿不到(url/urlChain 为空),
        // 这时只有时间窗能把它与紧随其后的 will-download 对上 —— 5s 内的队首才认,
        // 否则宁可让指令过期(宁可 AI 的下载落到默认目录,也不要把用户的下载写进 AI 指定的位置)
        const head = directives[0]
        if (head && now - head.createdAt < DIRECTIVE_FRESH_MS) {
          directives.shift()
          ctx.log('下载 URL 与指令不匹配,按新指令认领', { url, want: head.url })
          return head
        }
        return undefined
      }

      const adopt = (item: DownloadItem, wc: WebContents | undefined): void => {
        const id = randomUUID()
        const url = safe(() => item.getURL(), '') || ''
        const chain = safe(() => item.getURLChain(), [] as string[])
        const filename = (safe(() => item.getFilename(), '') || '').trim() || 'download'
        const directive = takeDirective(url, chain)
        const state = settings()
        const dir = resolveSaveDir(directive?.saveDir)
        // `directive.silent` 只能**强制**静默(true);false/undefined 一律遵循设置
        // —— 否则「重新下载」会在用户已经关掉询问时仍然弹对话框(headless 下直接卡死)
        const silent = directive?.silent === true || !state.askWhereToSave

        if (silent) {
          try {
            silentSave(item, dir, directive?.filename || filename)
          } catch (e) {
            ctx.logError('设置保存路径失败,回落到保存对话框', e)
          }
        } else {
          // 询问模式:不设 savePath → Electron 走原始流程弹对话框;只把默认位置钉到设置目录
          try {
            item.setSaveDialogOptions({ defaultPath: join(dir, filename) })
          } catch (e) {
            ctx.logError('设置保存对话框默认路径失败', e)
          }
        }

        const record: DownloadRecord = {
          id,
          url,
          urlChain: chain.length > 0 ? chain : url ? [url] : [],
          filename,
          savePath: silent ? safe(() => item.getSavePath(), '') : '',
          mimeType: safe(() => item.getMimeType(), '') || '',
          totalBytes: Math.max(0, safe(() => item.getTotalBytes(), 0)),
          receivedBytes: Math.max(0, safe(() => item.getReceivedBytes(), 0)),
          state: 'progressing',
          startedAt: Math.round(safe(() => item.getStartTime(), 0) * 1000) || Date.now(),
          ...(directive?.retriedFrom ? { retriedFrom: directive.retriedFrom } : {}),
          ...(wc && !wc.isDestroyed() && safe(() => wc.getURL(), '') ? { pageUrl: safe(() => wc.getURL(), '') } : {})
        }

        list = [record, ...list]
        live.set(id, { item, record })
        commit(true)
        emitChanged()

        item.on('updated', (_e, downloadState) => {
          const entry = live.get(id)
          if (!entry) return
          const r = entry.record
          const prev = r.state
          const prevReceived = r.receivedBytes
          const received = Math.max(0, safe(() => item.getReceivedBytes(), prevReceived))
          // 观测「恢复时被丢弃的字节」:Chromium 会重发请求,但实测「支持 Range」与「只返回 200」两种
          // 服务器都不会回退 —— 这里只负责在真观测到回退时留下证据(见 shared.ts 的 restarted 注释)
          if (prevReceived > 0 && received < prevReceived) {
            r.restarted = true
            ctx.log('恢复下载时字节回退,服务器不支持续传', id, prevReceived, '→', received)
          }
          r.receivedBytes = received
          const total = safe(() => item.getTotalBytes(), 0)
          if (total > 0) r.totalBytes = total
          const speed = safe(() => item.getCurrentBytesPerSecond(), 0)
          r.bytesPerSecond = speed > 0 ? speed : undefined
          r.state = safe(() => item.isPaused(), false)
            ? 'paused'
            : downloadState === 'interrupted'
              ? 'interrupted'
              : 'progressing'
          if (r.state === 'interrupted') r.error = r.error ?? '下载中断'
          // 进度只节流落盘(不进内存事件),状态迁移才立刻落盘并通知 UI
          if (prev !== r.state) {
            commit(true)
            emitChanged()
          } else {
            commit(false)
          }
        })

        item.once('done', (_e, downloadState) => finish(id, downloadState))

        directive?.onCreated?.(record)
        ctx.log('接管下载', id, url, silent ? `→ ${record.savePath}` : '(等待选择保存位置)')
      }

      const finish = (id: string, downloadState: 'completed' | 'cancelled' | 'interrupted'): void => {
        const entry = live.get(id)
        live.delete(id)
        if (!entry) return
        const { item, record: r } = entry
        r.receivedBytes = Math.max(0, safe(() => item.getReceivedBytes(), r.receivedBytes))
        const total = safe(() => item.getTotalBytes(), 0)
        if (total > 0) r.totalBytes = total
        r.endedAt = Math.round(safe(() => item.getEndTime(), 0) * 1000) || Date.now()
        r.bytesPerSecond = undefined
        // 询问模式下 `getFilename()` 不随用户在对话框里改名更新(electron#41640):真实名字只有 savePath 知道
        const path = safe(() => item.getSavePath(), '') || ''
        if (path) {
          r.savePath = path
          const name = basename(path)
          if (name) r.filename = name
        }
        if (downloadState === 'completed') {
          r.state = 'completed'
          r.error = undefined
        } else if (downloadState === 'cancelled') {
          r.state = 'cancelled'
          r.error = '已取消'
        } else {
          r.state = 'interrupted'
          r.error = '下载中断'
        }
        commit(true)
        emitChanged()
        ctx.log('下载结束', id, downloadState, r.savePath || '(无保存路径)')
      }

      const waitForDone = (created: DownloadRecord, timeoutMs: number): Promise<DownloadRecord> => {
        return new Promise((resolve) => {
          const entry = live.get(created.id)
          const current = list.find((r) => r.id === created.id)
          const settle = (): void => {
            const rec = list.find((r) => r.id === created.id) ?? created
            resolve(withFileExists(rec))
          }
          if (!entry || !current || isTerminal(current.state)) {
            settle()
            return
          }
          const timer = setTimeout(settle, timeoutMs)
          // adopt 里注册的 done 监听先执行(先注册先触发),所以这里读到的一定是终态
          entry.item.once('done', () => {
            clearTimeout(timer)
            settle()
          })
        })
      }

      const brief = (r: DownloadRecord): Record<string, unknown> => ({
        id: r.id,
        filename: r.filename,
        url: r.url,
        state: r.state,
        stateLabel: DOWNLOAD_STATE_LABELS[r.state],
        percent: percentOf(r),
        receivedBytes: r.receivedBytes,
        totalBytes: r.totalBytes,
        bytesPerSecond: r.bytesPerSecond ?? 0,
        savePath: r.savePath,
        fileExists: r.state === 'completed' ? existsSync(r.savePath) : false,
        ...(r.restarted ? { restarted: true } : {}),
        startedAt: r.startedAt,
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
        ...(r.error ? { error: r.error } : {})
      })

      // ---------- IPC 面(渲染层:window.browserAPI.plugins.invoke) ----------
      ctx.ipc.handle(
        'list',
        (): DownloadsListResult => ({ ...settingsState(), records: snapshot(), live: [...live.keys()] })
      )

      ctx.ipc.handle('pause', (id: unknown): DownloadActionResult => {
        const entry = live.get(String(id))
        if (!entry) return { ok: false, error: '这个下载已经不在进行中' }
        try {
          if (!entry.item.isPaused()) entry.item.pause()
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        entry.record.state = 'paused'
        commit(true)
        emitChanged()
        return { ok: true }
      })

      ctx.ipc.handle('resume', (id: unknown): DownloadActionResult => {
        const entry = live.get(String(id))
        if (!entry) return { ok: false, error: '这个下载已经不在进行中,请用「重新下载」' }
        try {
          entry.item.resume()
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        entry.record.state = 'progressing'
        entry.record.error = undefined
        commit(true)
        emitChanged()
        // 是否真能续传不预判:服务器不支持时 Chromium 会丢弃已收字节,
        // 由 updated 里的「字节回退」检测写进记录的 restarted 字段(见 shared.ts)
        return { ok: true }
      })

      ctx.ipc.handle('cancel', (id: unknown): DownloadActionResult => {
        const entry = live.get(String(id))
        if (!entry) return { ok: false, error: '这个下载已经不在进行中' }
        entry.item.cancel() // 会触发 done → finish 写终态
        return { ok: true }
      })

      ctx.ipc.handle('retry', (id: unknown): DownloadActionResult => {
        const rec = list.find((r) => r.id === String(id))
        if (!rec) return { ok: false, error: '记录不存在' }
        if (live.has(rec.id)) return { ok: false, error: '这个下载还在进行中,请先取消' }
        // 用重定向链的最后一跳重下(原始地址常常是个 302)
        const url = rec.urlChain[rec.urlChain.length - 1] ?? rec.url
        if (!/^https?:/i.test(url)) return { ok: false, error: '只能重新下载 http(s) 地址' }
        // silent:false → 遵循设置(询问模式会再弹一次对话框,与用户手动下载一致)
        directives.push({ url, silent: false, retriedFrom: rec.id, createdAt: Date.now() })
        try {
          session.defaultSession.downloadURL(url)
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        return { ok: true }
      })

      ctx.ipc.handle('remove', (id: unknown): DownloadActionResult => {
        const key = String(id)
        const entry = live.get(key)
        const exists = entry != null || list.some((r) => r.id === key)
        if (!exists) return { ok: false, error: '记录不存在' }
        if (entry) {
          safe(() => entry.item.cancel(), undefined)
          live.delete(key)
        }
        list = list.filter((r) => r.id !== key)
        commit(true)
        emitChanged()
        return { ok: true }
      })

      ctx.ipc.handle('clear', (finishedOnly: unknown): DownloadActionResult => {
        if (finishedOnly === false) {
          for (const [id, entry] of [...live.entries()]) {
            safe(() => entry.item.cancel(), undefined)
            live.delete(id)
          }
          list = []
        } else {
          list = list.filter((r) => !isTerminal(r.state))
        }
        commit(true)
        emitChanged()
        return { ok: true }
      })

      ctx.ipc.handle('openFile', async (id: unknown): Promise<DownloadActionResult> => {
        const rec = list.find((r) => r.id === String(id))
        if (!rec) return { ok: false, error: '记录不存在' }
        if (!rec.savePath || !existsSync(rec.savePath)) return { ok: false, error: '文件不在了(可能已被移动或删除)' }
        const err = await shell.openPath(rec.savePath)
        return err ? { ok: false, error: err } : { ok: true }
      })

      ctx.ipc.handle('showInFolder', (id: unknown): DownloadActionResult => {
        const rec = list.find((r) => r.id === String(id))
        if (!rec?.savePath) return { ok: false, error: '这条记录没有保存路径' }
        if (!existsSync(rec.savePath)) return { ok: false, error: '文件不在了(可能已被移动或删除)' }
        shell.showItemInFolder(rec.savePath)
        return { ok: true }
      })

      ctx.ipc.handle('getSettings', (): DownloadsSettingsState => settingsState())

      ctx.ipc.handle('setSettings', (patch: unknown): DownloadsSettingsState => {
        settingsStore?.setRaw(normalizeSettings(patch, settings()))
        return settingsState()
      })

      ctx.ipc.handle('pickDirectory', async (): Promise<DownloadsSettingsState & { canceled?: boolean }> => {
        const options: Electron.OpenDialogOptions = {
          title: '选择下载保存目录',
          defaultPath: downloadDir(),
          properties: ['openDirectory', 'createDirectory']
        }
        const parent = BrowserWindow.getFocusedWindow()
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) return { ...settingsState(), canceled: true }
        settingsStore?.setRaw(normalizeSettings({ downloadDir: result.filePaths[0] }, settings()))
        return settingsState()
      })

      ctx.ipc.handle('revealDir', async (): Promise<DownloadActionResult> => {
        const dir = downloadDir()
        try {
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
        const err = await shell.openPath(dir)
        return err ? { ok: false, error: err } : { ok: true }
      })

      // ---------- MCP 工具 ----------
      const StateSchema = z.enum(['progressing', 'paused', 'completed', 'cancelled', 'interrupted'])

      ctx.mcp.tool(
        'browser_list_downloads',
        {
          description:
            '列出 bow 的下载记录(进行中的在前),含状态、进度百分比、速度、保存路径与文件是否还在磁盘上。进行中的下载可以接着用 browser_download 的返回体或本工具的 id 观察',
          inputSchema: {
            id: z.string().optional().describe('只看某一条(用返回体里的 id)'),
            state: StateSchema.optional().describe('只看某个状态的记录'),
            limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe('最多返回多少条,默认 20')
          }
        },
        (args) => {
          const records = snapshot()
          const id = typeof args.id === 'string' ? args.id : ''
          if (id) {
            const hit = records.find((r) => r.id === id)
            if (!hit) return errorContent(`没有 id 为 ${id} 的下载记录`)
            return textContent({ ok: true, download: brief(hit) })
          }
          const wanted = typeof args.state === 'string' ? (args.state as DownloadState) : null
          const filtered = wanted ? records.filter((r) => r.state === wanted) : records
          return textContent({
            ok: true,
            count: filtered.length,
            downloads: filtered.slice(0, clampLimit(args.limit)).map(brief)
          })
        }
      )

      ctx.mcp.tool(
        'browser_download',
        {
          description:
            '从 url 下载文件(不需要页面上的点击,也不弹保存对话框)。默认保存到 bow 的下载目录并自动重名,可用 saveDir / filename 指定;不等待完成时立即返回 id,之后用 browser_list_downloads 查进度',
          inputSchema: {
            url: z.string().describe('要下载的 http(s) 地址'),
            saveDir: z.string().optional().describe('保存目录的绝对路径;省略则用 bow 的下载目录'),
            filename: z.string().optional().describe('保存的文件名(不含目录);同名文件会自动加 (1)'),
            wait: z.boolean().optional().describe('是否等到下载结束再返回,默认 false'),
            timeoutMs: z.number().int().min(1000).max(MAX_WAIT_TIMEOUT_MS).optional().describe('wait 的超时毫秒数,默认 30000')
          }
        },
        async (args) => {
          const url = String(args.url ?? '').trim()
          if (!/^https?:/i.test(url)) return errorContent('url 必须是 http(s) 地址')
          const rawDir = typeof args.saveDir === 'string' && args.saveDir.trim() ? args.saveDir.trim() : undefined
          if (rawDir && !isAbsolute(rawDir)) return errorContent('saveDir 必须是绝对路径')
          const rawName = typeof args.filename === 'string' ? args.filename.trim() : ''
          const filename = rawName ? basename(rawName) : undefined

          const created = await new Promise<DownloadRecord | null>((resolve) => {
            let settled = false
            let timer: ReturnType<typeof setTimeout> | undefined
            const done = (value: DownloadRecord | null): void => {
              if (settled) return
              settled = true
              if (timer) clearTimeout(timer)
              resolve(value)
            }
            timer = setTimeout(() => done(null), DIRECTIVE_TTL_MS)
            directives.push({
              url,
              saveDir: rawDir,
              filename,
              silent: true, // AI 发起的下载绝不弹对话框:那会让调用卡在等人点确认
              createdAt: Date.now(),
              onCreated: done
            })
            try {
              session.defaultSession.downloadURL(url)
            } catch (e) {
              ctx.logError('downloadURL 失败', e)
              done(null)
            }
          })
          if (!created) return errorContent('下载没有启动(地址被拦截、服务器拒绝或超时)')

          if (args.wait !== true) return textContent({ ok: true, ...brief(created) })
          const final = await waitForDone(created, clampTimeout(args.timeoutMs))
          return textContent({
            ok: final.state === 'completed',
            waited: true,
            ...brief(final),
            ...(final.state === 'progressing' ? { note: '超时仍未结束,下载仍在继续,可用 browser_list_downloads 继续观察' } : {})
          })
        }
      )

      // ⚠️ 注册放在最后:activate 中途抛错时内核只 dispose ctx,不会调 deactivate,提前注册会漏监听器
      onWillDownload = (_event, item, wc) => {
        try {
          adopt(item, wc as WebContents | undefined)
        } catch (e) {
          ctx.logError('接管下载失败', e)
        }
      }
      ses.on('will-download', onWillDownload)
      ctx.log('下载插件已就绪', '保存目录=', downloadDir(), '询问=', settings().askWhereToSave)
    },

    deactivate(ctx: PluginContext): void {
      if (onWillDownload) {
        try {
          session.defaultSession.off('will-download', onWillDownload)
        } catch (e) {
          ctx.logError('移除 will-download 监听失败', e)
        }
        onWillDownload = null
      }
      // 进行中的下载**不取消**:cancel() 会删掉 .crdownload 临时文件,是有损的。
      // 保留它们的 updated/done 监听直到结束(记录仍会落盘),只是不再接管新下载。
      flushOnDeactivate(ctx)
      ctx.log('下载插件已停用,进行中的下载保持运行', live.size)
    }
  }
}

export default createDownloadsPlugin()
