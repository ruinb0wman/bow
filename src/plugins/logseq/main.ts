/**
 * 笔记插件主进程侧:图目录选择、文件读写(原子写 + 路径校验 + mtime 冲突检测)、`fs.watch` 增量重载、
 * 索引与反链、以及给 `bow://logseq` 页面用的 IPC 面。
 *
 * 关键设计(改代码前先看这几条):
 *
 * 1. **唯一碰磁盘的地方**。渲染层没有 fs(它连 node 都没有),所有读写都过 `plugins.invoke('logseq', …)`;
 *    解析/编辑/反链的**纯逻辑**在 `format.ts` / `shared.ts` / `graph.ts`,那些文件都有单测,这里只做接线。
 * 2. **只写 `journals/` 与 `pages/` 下的 `.md`**:改文件之前一律 `assertWritable()`
 *    (resolve 后必须在图目录内、必须在两个内容目录下、必须 `.md`)。`logseq/config.edn` 只读、永不写回。
 * 3. **原子写 + 冲突检测**:`.tmp-<rand>` → rename(失败退化为就地写,Windows 上文件被别的进程占着时
 *    rename 可能 EPERM);`savePage` 带 `baseMtimeMs`,磁盘 mtime 变过就返回 `conflict`,**绝不覆盖**。
 * 4. **视图状态按 tabId 绑定**(与终端把会话绑到 tabId 同一套路):标签刷新后回到同一页,
 *    `tab:closed` 清理。内部页面的 URL 不能带路径(`parseInternalUrl` 只认 `bow://<id>`),
 *    所以「当前在哪一页」只能存在这里。
 * 5. **自己写的文件要吞掉自己的 watcher 回声**(`recentWrites`),否则每敲一个字都会触发一次重载。
 *    判定不能靠「事件到达时刻查时间戳」—— 通知在 `rename` 那一刻就产生了,而我们记账还要等一轮
 *    线程池往返,必然比通知晚。所以:**写之前**就把「路径 + 写入内容」记下来,等 flush 时再用
 *    **磁盘内容是否仍等于我们写的那份**判回声(内容被第三方改过就照常上报,不靠时间窗蒙)。
 */

import { app, BrowserWindow, dialog } from 'electron'
import { promises as fsp, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import {
  DEFAULT_GRAPH_CONFIG,
  compileDateFormat,
  decodePageName,
  defaultSettings,
  encodePageName,
  expandTemplate,
  favoritesFor,
  formatJournalStem,
  isJournalDay,
  LOGSEQ_EVENT,
  normalizeSettings,
  normalizeView,
  parseConfigEdn,
  parseView,
  todayDay,
  viewKey,
  withGraph,
  type FileRead,
  type GraphConfig,
  type GraphState,
  type GraphSwitchResult,
  type LogseqClientSettings,
  type LogseqSettings,
  type LogseqView,
  type SaveResult
} from './shared'
import {
  backlinksOf,
  buildIndex,
  indexStats,
  journalDays,
  MAX_INDEX_FILES,
  parseIndexedFile,
  resolvePage,
  scanGraph,
  searchPages,
  type GraphIndex,
  type GraphIo,
  type IndexedFile
} from './graph'

/** watcher 防抖:Logseq 保存时常常连着好几个事件 */
const WATCH_DEBOUNCE_MS = 250
/** `recentWrites` 记录的保留时长(只用于清理;回声判定看内容,不比时间) */
const SELF_WRITE_MS = 3000
/** 模板目录(Logseq 约定:图根下的 templates/) */
const TEMPLATES_DIR = 'templates'

interface GraphRuntime {
  root: string
  config: GraphConfig
  index: GraphIndex | null
  watcher: FSWatcher | null
  /** 自己写的文件:路径 → 写入时刻 + 写进去的内容(判回声靠内容比对,见文件头第 5 条) */
  recentWrites: Map<string, { at: number; raw: string }>
  /** 待处理的 watcher 变更(相对路径) */
  pending: Set<string>
  timer: NodeJS.Timeout | null
  /** 正在进行的扫描:并发调用要共享同一个 promise,否则后到的调用会拿到 null */
  scanPromise: Promise<GraphIndex | null> | null
}

function createLogseqPlugin(): PluginMain {
  let context: PluginContext | null = null
  let store: PluginStorage<LogseqSettings> | null = null
  let runtime: GraphRuntime | null = null
  /** tabId → 该标签正在看的页 */
  const sessions = new Map<number, LogseqView>()
  /** 下一个新开的编辑器标签要打开的页(「在新窗格打开」用) */
  let pendingPage: string | null = null
  let onBeforeQuit: (() => void) | null = null

  // ---------- 文件访问(注入给纯逻辑) ----------

  const io: GraphIo = {
    async listDir(path: string): Promise<string[] | null> {
      try {
        const items = await fsp.readdir(path, { withFileTypes: true })
        return items.filter((item) => item.isFile()).map((item) => item.name)
      } catch {
        return null
      }
    },
    async readText(path: string): Promise<string> {
      return await fsp.readFile(path, 'utf8')
    },
    async mtimeMs(path: string): Promise<number | null> {
      try {
        const stat = await fsp.stat(path)
        return stat.mtimeMs
      } catch {
        return null
      }
    },
    join: (...parts: string[]): string => join(...parts)
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path)
      return true
    } catch {
      return false
    }
  }

  async function readIfExists(path: string): Promise<string | null> {
    try {
      return await fsp.readFile(path, 'utf8')
    } catch {
      return null
    }
  }

  // ---------- 图目录校验 ----------

  /** 打开一个图:校验 → 记设置 → 起 watcher → 建索引 */
  async function openGraph(input: string): Promise<{ ok: boolean; error?: string }> {
    const root = resolve(input.trim())
    if (!input.trim()) return { ok: false, error: '图目录为空' }
    if (!(await exists(root))) return { ok: false, error: `目录不存在:${root}` }

    // DB 图(Logseq Desktop 的新形态)是另一个存储引擎:明确拒绝,不要半支持
    if ((await exists(join(root, 'logseq', 'db.sqlite'))) || (await exists(join(root, 'logseq', 'db')))) {
      return { ok: false, error: '这是 Logseq 的 DB 图(logseq/db),本插件只支持文件图(journals/ + pages/)' }
    }
    const looksLikeGraph =
      (await exists(join(root, 'logseq'))) ||
      (await exists(join(root, 'journals'))) ||
      (await exists(join(root, 'pages'))) ||
      (await exists(join(root, 'logseq', 'config.edn')))
    if (!looksLikeGraph) {
      return { ok: false, error: '不是 Logseq 图目录(没有 logseq/、journals/ 或 pages/)' }
    }

    await closeRuntime()
    const configText = (await readIfExists(join(root, 'logseq', 'config.edn'))) ?? ''
    runtime = {
      root,
      config: parseConfigEdn(configText),
      index: null,
      watcher: null,
      recentWrites: new Map<string, { at: number; raw: string }>(),
      pending: new Set(),
      timer: null,
      scanPromise: null
    }
    store!.set({ ...withGraph(store!.get(), root) })
    startWatching()
    context?.log('图已打开', root, 'journals=', runtime.config.journalsDir, 'pages=', runtime.config.pagesDir)
    void ensureIndex()
    return { ok: true }
  }

  async function closeRuntime(): Promise<void> {
    if (!runtime) return
    if (runtime.timer) clearTimeout(runtime.timer)
    runtime.watcher?.close()
    runtime = null
  }

  /** 目录监听:递归 + 防抖。回声过滤不在回调里做(那时记账可能还没落地),统一放到 flushWatch —— 见文件头第 5 条 */
  function startWatching(): void {
    if (!runtime) return
    try {
      runtime.watcher = watch(runtime.root, { recursive: true }, (_event, filename) => {
        if (!runtime) return
        const rel = filename ? String(filename).split(sep).join('/') : ''
        runtime.pending.add(rel)
        if (runtime.timer) clearTimeout(runtime.timer)
        runtime.timer = setTimeout(() => {
          void flushWatch()
        }, WATCH_DEBOUNCE_MS)
      })
    } catch (e) {
      context?.logError('监听图目录失败(自动重载不可用,可手动刷新)', String(e))
      if (runtime) runtime.watcher = null
    }
  }

  /**
   * 这条事件是不是「我们自己那次写入」的回声。
   *
   * 判据是**磁盘内容仍等于我们写的那份**:相等 ⇒ 没人动过它,是我们自己写的(吞掉);不相等 ⇒
   * 有人在我们之后又改了,照常上报 —— 所以不存在「写完 3 秒内外部改动被吞掉」的盲窗。
   * 原子写的 `.tmp-*` 临时文件没有正文可比(它们也不是 `.md`,`refreshIndexedFile` 本来就会跳过)。
   * 记录只在 SELF_WRITE_MS 内有效:更久之后的事件就算内容相同也照常上报(避免「永久吞声」)。
   */
  async function isSelfWriteEcho(rel: string): Promise<boolean> {
    if (!runtime || !rel) return false
    const now = Date.now()
    for (const [written, record] of runtime.recentWrites) {
      if (now - record.at > SELF_WRITE_MS) continue
      if (rel.startsWith(`${written}.tmp-`)) return true
      if (rel !== written) continue
      const disk = await readIfExists(join(runtime.root, rel))
      return disk !== null && disk === record.raw
    }
    return false
  }

  async function flushWatch(): Promise<void> {
    if (!runtime) return
    const paths = [...runtime.pending]
    runtime.pending.clear()
    if (paths.length === 0) return
    const configChanged = paths.some((p) => p === 'logseq/config.edn' || p.endsWith('/config.edn'))
    // 自家写入的回声不刷索引也不广播 —— 否则页面会把「自己刚存下去的东西」当成外部改动
    // 静默重载一次,编辑态(连带焦点与撤销栈)就全没了
    // recentWrites 只用来判回声,先把过期项清掉,免得越攒越多(而且过期记录不能再用)
    const now = Date.now()
    for (const [path, record] of runtime.recentWrites) if (now - record.at > SELF_WRITE_MS) runtime.recentWrites.delete(path)
    const kept: string[] = []
    for (const rel of paths) {
      if (await isSelfWriteEcho(rel)) continue
      kept.push(rel)
    }
    if (kept.length === 0) return
    if (configChanged) {
      const text = (await readIfExists(join(runtime.root, 'logseq', 'config.edn'))) ?? ''
      runtime.config = parseConfigEdn(text)
      runtime.index = null
      void ensureIndex()
    } else {
      for (const rel of kept) await refreshIndexedFile(rel)
    }
    context?.ipc.emit(LOGSEQ_EVENT.graphChanged, { paths: kept })
  }

  /**
   * 建/刷新索引。**并发调用共享同一个 promise** —— `openGraph` 是 fire-and-forget 的,
   * 紧接着 `getState` / `listPages` 就会来问,若只用一个 `scanning` 标志提前返回,
   * 它们会拿到 `null` 并显示成「图是空的」。
   */
  async function ensureIndex(force = false): Promise<GraphIndex | null> {
    if (!runtime) return null
    if (runtime.index && !force) return runtime.index
    if (runtime.scanPromise) return runtime.scanPromise
    const target = runtime
    const promise = (async (): Promise<GraphIndex | null> => {
      try {
        const index = await scanGraph(io, target.root, target.config, force ? null : target.index)
        if (runtime !== target) return index
        target.index = index
        if (index.tooLarge) context?.log('图文件数超过上限,反链/搜索退化为按需扫描', MAX_INDEX_FILES)
        return index
      } finally {
        if (runtime === target) target.scanPromise = null
      }
    })()
    target.scanPromise = promise
    return promise
  }

  /** 单个文件变化:重读并替换索引里的那一条(比全量重扫便宜得多) */
  async function refreshIndexedFile(rel: string): Promise<void> {
    if (!runtime?.index || !rel) return
    const normalized = rel.split(sep).join('/')
    const isContent =
      normalized.startsWith(`${runtime.config.journalsDir}/`) || normalized.startsWith(`${runtime.config.pagesDir}/`)
    if (!isContent || !/\.md$/i.test(normalized)) return
    const path = join(runtime.root, normalized)
    const mtimeMs = await io.mtimeMs(path)
    const files = runtime.index.files.filter((f) => f.rel !== normalized)
    if (mtimeMs !== null) {
      const raw = await readIfExists(path)
      if (raw === null) return
      files.push(
        parseIndexedFile({
          path,
          rel: normalized,
          mtimeMs,
          raw,
          format: compileDateFormat(runtime.config.fileFormat),
          isJournal: normalized.startsWith(`${runtime.config.journalsDir}/`)
        })
      )
    }
    runtime.index = rebuildIndex(files)
  }

  /**
   * 重拼索引(单个文件变化 / 写完之后)。
   *
   * ⚠️ 必须走 `buildIndex()` —— 这里曾经手抄了一份 map 构造(`byPath`/`byDay`/`byTitle`),
   * 加新索引(`byStem`)时漏改它就会静默失效。
   */
  function rebuildIndex(files: IndexedFile[]): GraphIndex | null {
    if (!runtime) return null
    return buildIndex({
      root: runtime.root,
      config: runtime.config,
      format: compileDateFormat(runtime.config.fileFormat),
      files,
      tooLarge: files.length >= MAX_INDEX_FILES
    })
  }

  // ---------- 路径与写入 ----------

  function contentDirs(): { journals: string; pages: string } {
    return {
      journals: join(runtime!.root, runtime!.config.journalsDir),
      pages: join(runtime!.root, runtime!.config.pagesDir)
    }
  }

  /** 只允许写图目录内 `journals/` 与 `pages/` 下的 `.md`;越界一律抛错 */
  function assertWritable(path: string): void {
    if (!runtime) throw new Error('还没有选择图目录')
    const abs = resolve(path)
    const dirs = contentDirs()
    const inside = (dir: string): boolean => abs === dir || abs.startsWith(dir + sep)
    if (!inside(runtime.root)) throw new Error(`路径不在图目录内:${abs}`)
    if (!inside(dirs.journals) && !inside(dirs.pages)) {
      throw new Error(`只允许写 ${runtime.config.journalsDir}/ 与 ${runtime.config.pagesDir}/ 下的文件`)
    }
    if (!/\.md$/i.test(abs)) throw new Error('只允许写 .md 文件')
  }

  /** 原子写:.tmp → rename;rename 失败(文件被占)退化为就地写 */
  async function writeFileAtomic(path: string, content: string): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`
    try {
      await fsp.writeFile(tmp, content, 'utf8')
      await fsp.rename(tmp, path)
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      context?.log('原子写失败,改为就地写', path, String(e))
      await fsp.writeFile(path, content, 'utf8')
    }
  }

  function noteRecentWrite(rel: string, raw: string): void {
    runtime?.recentWrites.set(rel, { at: Date.now(), raw })
  }

  async function relOf(path: string): Promise<string> {
    if (!runtime) return ''
    const abs = resolve(path)
    return abs === runtime.root ? '' : abs.slice(runtime.root.length + 1).split(sep).join('/')
  }

  // ---------- 读:日志 / 页面 ----------

  async function readJournal(day: string): Promise<FileRead> {
    if (!runtime) throw new Error('还没有选择图目录')
    const index = runtime.index ?? (await ensureIndex())
    const existing = index?.byDay.get(day)
    const path = existing?.path ?? join(runtime.root, runtime.config.journalsDir, `${formatJournalStem(day, runtime.config.fileFormat)}.md`)
    const raw = await readIfExists(path)
    if (raw !== null) {
      const mtimeMs = await io.mtimeMs(path)
      return { view: { kind: 'journal', day }, path, rel: await relOf(path), exists: true, raw, mtimeMs, title: day }
    }
    // 文件还不存在:有默认模板就把它渲染出来(与 Logseq 新建日志的行为一致),但不落盘
    const templateName = runtime.config.defaultJournalTemplate.trim()
    let content = ''
    let fromTemplate: string | undefined
    if (templateName) {
      const template = await readIfExists(join(runtime.root, TEMPLATES_DIR, `${templateName}.md`))
      if (template !== null) {
        content = expandTemplate(template, { day, page: day })
        fromTemplate = templateName
      }
    }
    return { view: { kind: 'journal', day }, path, rel: await relOf(path), exists: false, raw: content, mtimeMs: null, fromTemplate, title: day }
  }

  async function readPage(name: string): Promise<FileRead> {
    if (!runtime) throw new Error('还没有选择图目录')
    const trimmed = name.trim()
    // `[[2026-09-20]]` 这种指向日志的链接,走日志那条路
    if (isJournalDay(trimmed)) {
      const journal = await readJournal(trimmed)
      return { ...journal, title: trimmed }
    }
    const index = runtime.index ?? (await ensureIndex())
    const resolved = index ?? rebuildIndex([])
    const existing = resolved ? resolvePage(resolved, trimmed) : null
    if (existing) {
      const raw = (await readIfExists(existing.path)) ?? ''
      const mtimeMs = await io.mtimeMs(existing.path)
      return {
        view: { kind: 'page', name: existing.title },
        path: existing.path,
        rel: existing.rel,
        exists: true,
        raw,
        mtimeMs,
        title: existing.title
      }
    }
    const stem = encodePageName(trimmed)
    const path = join(runtime.root, runtime.config.pagesDir, `${stem}.md`)
    const losesTitle = decodePageName(stem) !== trimmed
    return {
      view: { kind: 'page', name: trimmed },
      path,
      rel: await relOf(path),
      exists: false,
      raw: losesTitle ? `title:: ${trimmed}\n` : '',
      mtimeMs: null,
      titleProp: losesTitle ? trimmed : undefined,
      title: trimmed
    }
  }

  // ---------- 写 ----------

  async function savePage(input: {
    path?: unknown
    raw?: unknown
    baseMtimeMs?: unknown
    expectMissing?: unknown
  }): Promise<SaveResult> {
    if (!runtime) return { ok: false, error: '还没有选择图目录' }
    const path = typeof input?.path === 'string' ? input.path : ''
    const raw = typeof input?.raw === 'string' ? input.raw : ''
    if (!path) return { ok: false, error: '缺少 path' }
    try {
      assertWritable(path)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    const base = typeof input.baseMtimeMs === 'number' ? input.baseMtimeMs : null
    const diskMtime = await io.mtimeMs(path)
    // 编辑器**以为这个文件还不存在**(新建页面 / 今天的日志还没落盘):那就绝不允许静默覆盖 ——
    // 打开之后才出现的文件(Logseq 先建了今天的日志、或两个工具在抢同一页)走冲突那条路,
    // 用户在横幅上选「用磁盘版本重载」还是「强行覆盖」。
    if (input.expectMissing === true && diskMtime !== null) {
      const diskRaw = (await readIfExists(path)) ?? ''
      return { ok: false, conflict: true, diskRaw, mtimeMs: diskMtime }
    }
    if (base !== null && diskMtime !== null && Math.abs(diskMtime - base) > 1) {
      const diskRaw = (await readIfExists(path)) ?? ''
      return { ok: false, conflict: true, diskRaw, mtimeMs: diskMtime }
    }
    const rel = await relOf(path)
    // **先记账再写**:fs 通知在 rename 那一刻就产生了,写完再记必然记不住 —— 那正是
    // 「每次自动保存都静默重载一次、编辑器退出、焦点丢」的根因
    noteRecentWrite(rel, raw)
    try {
      await writeFileAtomic(path, raw)
    } catch (e) {
      runtime.recentWrites.delete(rel)
      const message = e instanceof Error ? e.message : String(e)
      context?.logError('写文件失败', path, message)
      return { ok: false, error: message }
    }
    const mtimeMs = (await io.mtimeMs(path)) ?? Date.now()
    if (runtime.index && rel && /\.md$/i.test(rel)) {
      const replace = runtime.index.files.filter((f) => f.rel !== rel)
      replace.push(
        parseIndexedFile({
          path,
          rel,
          mtimeMs,
          raw,
          format: compileDateFormat(runtime.config.fileFormat),
          isJournal: rel.startsWith(`${runtime.config.journalsDir}/`)
        })
      )
      runtime.index = rebuildIndex(replace)
    }
    return { ok: true, mtimeMs }
  }

  // ---------- 状态与模板 ----------

  async function templates(): Promise<string[]> {
    if (!runtime) return []
    const names = await io.listDir(join(runtime.root, TEMPLATES_DIR))
    if (!names) return []
    return names.filter((n) => /\.md$/i.test(n)).map((n) => n.replace(/\.md$/i, ''))
  }

  function dateFormatState(format: string): GraphState['dateFormat'] {
    const spec = compileDateFormat(format)
    return { format: spec.format, ok: spec.ok, unsupported: spec.unsupported }
  }

  // ---------- 渲染页面偏好(字号 / 收藏) ----------

  /**
   * 页面需要的偏好。收藏只给**当前图**的一份(图还没打开就为空) ——
   * 与 `state()` 一样是「现读 store + runtime」,不缓存。
   */
  function clientSettings(): LogseqClientSettings {
    const settings = store!.get()
    return {
      fontSize: settings.fontSize,
      favorites: runtime ? favoritesFor(settings, runtime.root) : []
    }
  }

  /** 把某个图的一份收藏写回 store(按图分开存;空数组会被规范化掉,等于删掉该图的键) */
  function setFavorites(root: string, views: LogseqView[]): void {
    const current = store!.get()
    store!.setRaw(normalizeSettings({ ...current, favorites: { ...current.favorites, [root]: views } }))
  }

  async function state(): Promise<GraphState> {
    const settings = store!.get()
    const base: GraphState = {
      graphPath: settings.graphPath,
      recentGraphs: settings.recentGraphs,
      config: runtime?.config ?? DEFAULT_GRAPH_CONFIG,
      ok: false,
      template: { configured: runtime?.config.defaultJournalTemplate ?? '', available: [] },
      dateFormat: dateFormatState(runtime?.config.fileFormat ?? DEFAULT_GRAPH_CONFIG.fileFormat),
      today: todayDay()
    }
    if (!runtime) return { ...base, error: settings.graphPath ? '图目录已失效,请重新选择' : '还没有选择图目录' }
    const index = runtime.index ?? (await ensureIndex())
    base.ok = true
    base.template.available = await templates()
    if (index) {
      const stats = indexStats(index)
      base.index = { ...stats, tooLarge: index.tooLarge }
    }
    return base
  }

  // ---------- 生命周期 ----------

  return {
    manifest: {
      id: 'logseq',
      name: '笔记',
      description:
        '兼容 Logseq 的极简笔记页(bow://logseq):日志 + 双向链接 + 反链 + 实时 markdown + 日志模板;直接读写你已有的 Logseq 文件图',
      version: '1.0.0'
    },
    capabilities: ['ui'],

    activate(ctx: PluginContext): void {
      context = ctx
      store = ctx.storage<LogseqSettings>({ file: 'logseq.json', defaults: defaultSettings() })
      const normalized = normalizeSettings(store.get())
      if (JSON.stringify(normalized) !== JSON.stringify(store.get())) store.setRaw(normalized)

      // ---------- 状态 ----------
      ctx.ipc.handle('getState', () => state())

      // ---------- 页面偏好(字号 / 收藏) ----------
      ctx.ipc.handle('getSettings', (): LogseqClientSettings => clientSettings())
      ctx.ipc.handle('setSettings', (patch: unknown): LogseqClientSettings => {
        const raw = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
        const current = store!.get()
        // 只认字号:收藏走 toggleFavorite(避免两个入口互相覆盖)。
        // fallback 传 current:坏输入/缺字段都保留上一次的好值,而不是跳回默认
        store!.setRaw(normalizeSettings({ ...current, fontSize: raw.fontSize }, current))
        const next = clientSettings()
        ctx.ipc.emit(LOGSEQ_EVENT.settingsChanged, next)
        return next
      })
      ctx.ipc.handle('toggleFavorite', (view: unknown) => {
        const parsed = parseView(view)
        if (!runtime || !parsed) {
          return { favorites: runtime ? favoritesFor(store!.get(), runtime.root) : [], on: false }
        }
        const root = runtime.root
        const list = favoritesFor(store!.get(), root)
        const key = viewKey(parsed)
        const exists = list.some((item) => viewKey(item) === key)
        // 新增插到最前(最近收藏优先);删除直接滤掉。上限由 normalizeSettings 兜底
        const next = exists ? list.filter((item) => viewKey(item) !== key) : [parsed, ...list]
        setFavorites(root, next)
        const favorites = favoritesFor(store!.get(), root)
        ctx.ipc.emit(LOGSEQ_EVENT.favoritesChanged, favorites)
        return { favorites, on: !exists }
      })
      ctx.ipc.handle('pickGraph', async (): Promise<GraphSwitchResult> => {
        const options: Electron.OpenDialogOptions = {
          title: '选择 Logseq 图目录',
          properties: ['openDirectory', 'createDirectory']
        }
        const parent = BrowserWindow.getFocusedWindow()
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) return { ok: false as const, state: await state() }
        const opened = await openGraph(result.filePaths[0])
        return { ok: opened.ok, error: opened.error, state: await state() }
      })
      ctx.ipc.handle('setGraph', async (path: unknown): Promise<GraphSwitchResult> => {
        const opened = await openGraph(typeof path === 'string' ? path : '')
        return { ok: opened.ok, error: opened.error, state: await state() }
      })
      ctx.ipc.handle('rebuildIndex', async () => {
        if (runtime) runtime.index = null
        await ensureIndex(true)
        return state()
      })

      // ---------- 读 ----------
      ctx.ipc.handle('readJournal', (day: unknown) => readJournal(typeof day === 'string' ? day : todayDay()))
      ctx.ipc.handle('readPage', (name: unknown) => readPage(typeof name === 'string' ? name : ''))
      ctx.ipc.handle('listJournals', async () => {
        const index = runtime?.index ?? (await ensureIndex())
        const days = index ? journalDays(index) : []
        return { days, first: days[days.length - 1] ?? null, last: days[0] ?? null, today: todayDay() }
      })
      ctx.ipc.handle('listPages', async (query: unknown) => {
        const index = runtime?.index ?? (await ensureIndex())
        if (!index) return []
        return searchPages(index, typeof query === 'string' ? query : '', 30).map((hit) => ({
          name: hit.name,
          day: hit.day,
          rel: hit.rel
        }))
      })
      ctx.ipc.handle('backlinks', async (name: unknown) => {
        const index = runtime?.index ?? (await ensureIndex())
        if (!index || typeof name !== 'string') return { total: 0, groups: [] }
        return backlinksOf(index, name)
      })
      ctx.ipc.handle('listTemplates', async () => ({ names: await templates() }))

      // ---------- 写 ----------
      ctx.ipc.handle('savePage', (input: { path?: unknown; raw?: unknown; baseMtimeMs?: unknown }) => savePage(input ?? {})),

      // ---------- 视图状态(按 tabId) ----------
      ctx.ipc.handle('attach', (tabId: unknown) => {
        const id = Number(tabId)
        const fallback: LogseqView = pendingPage ? { kind: 'page', name: pendingPage } : { kind: 'journal', day: todayDay() }
        pendingPage = null
        if (!Number.isInteger(id) || id <= 0) return { view: fallback }
        const view = sessions.get(id) ?? fallback
        sessions.set(id, view)
        return { view }
      })
      ctx.ipc.handle('setView', (tabId: unknown, view: unknown) => {
        const id = Number(tabId)
        if (!Number.isInteger(id) || id <= 0) return false
        sessions.set(id, normalizeView(view, { kind: 'journal', day: todayDay() }))
        return true
      })
      ctx.ipc.handle('openInNewPane', (name: unknown) => {
        pendingPage = typeof name === 'string' && name.trim() ? name.trim() : null
        return true
      })

      ctx.events.on('tab:closed', (tab: { id?: unknown } | null | undefined) => {
        const id = Number(tab?.id)
        if (Number.isInteger(id)) sessions.delete(id)
      })

      onBeforeQuit = (): void => {
        void closeRuntime()
      }
      app.on('before-quit', onBeforeQuit)

      const settings = store.get()
      if (settings.graphPath) {
        void openGraph(settings.graphPath).then((result) => {
          if (!result.ok) context?.log('上次的图目录打开失败', settings.graphPath, result.error)
        })
      }
      ctx.log('笔记已就绪', settings.graphPath ? `图=${settings.graphPath}` : '(还没选图)')
    },

    deactivate(): void {
      if (onBeforeQuit) {
        app.removeListener('before-quit', onBeforeQuit)
        onBeforeQuit = null
      }
      void closeRuntime()
      sessions.clear()
      pendingPage = null
      store = null
      context = null
    }
  }
}

export default createLogseqPlugin()
