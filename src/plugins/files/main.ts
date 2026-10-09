/**
 * 文件管理插件主进程侧:**唯一接触 electron 与 node:fs 的地方**。
 *
 * 三条纪律(改代码前先看):
 * 1. **每个入参路径都先过 `checkFilePath()`**(核心的 `src/main/plugins/fileRoots.ts`)——
 *    它做白名单 + realpath + deny 名单(userData),拿到返回的 `abs` 才能碰盘。不做路径拼接猜测。
 * 2. **删除默认进系统回收站**(`shell.trashItem`),这是比确认框更可靠的护栏;`permanent:true` 要设置开关,
 *    而且 `trashItem` 失败时**绝不降级**为永久删 —— 报错比默默毁数据强。
 * 3. **写文件默认不覆盖**:目标已存在且没显式 `overwrite:true` 就直接拒。
 *    这条是从笔记插件学来的(`expectMissing`:一次静默覆盖把用户整页笔记清空过,ARCHITECTURE:575)。
 *
 * 明确的**非目标**(本次不做,见 `.pi/plans/2026-10-09-file-manager-plugin/plan.md`):
 * 浏览面板(步骤 3)、网站文件选择器接管与 `browser_upload`(步骤 4/5,需要 CDP + 常挂标签调试器)。
 * 所以本插件现在只贡献设置页与 9 个 MCP 工具:没有工具栏按钮、没有浮层。
 */

import { BrowserWindow, dialog, shell } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { existsSync, promises as fsp } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { McpToolResult, PluginContext, PluginMain } from '../../main/plugins/types'
import { errorContent, textContent } from '../../main/plugins/mcpResult'
import {
  checkFilePath,
  fileRootsDenyList,
  isInside,
  isSamePath,
  realpathDeepest,
  resolveFileRoots,
  sanitizeRoots
} from '../../main/plugins/fileRoots'
import { resolveDownloadsDir } from '../../main/plugins/exportFile'
import {
  DEFAULT_FILES_SETTINGS,
  DEFAULT_READ_MAX_BYTES,
  FILES_EVENT,
  MAX_LIST_DEPTH,
  READ_MAX_BYTES_LIMIT,
  clampListLimit,
  isHiddenName,
  matchGlob,
  normalizeFilesSettings,
  sortEntries,
  type FilesActionResult,
  type FilesListResult,
  type FilesRootView,
  type FilesSettings,
  type FilesSettingsState,
  type FsEntry,
  type FsEntryType
} from './shared'

/** 一次列目录最多返回多少条 / 最多读多少字节 */
const MAX_LIST_LIMIT = 2000
const MAX_READ_BYTES = READ_MAX_BYTES_LIMIT

const manifest = {
  id: 'files',
  name: '文件管理',
  description:
    '给 AI 一个受白名单约束的本地文件操作面(列出 / 读 / 写 / 新建目录 / 移动 / 复制 / 删除);删除默认进系统回收站',
  version: '0.1.0'
} as const

function existsSafe(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** 生效的白名单(realpath 之后),用于「不许把工作目录本身移走/删掉」 */
function realRoots(): string[] {
  return resolveFileRoots().map((root) => realpathDeepest(resolve(root)))
}

function isRootPath(abs: string): boolean {
  return realRoots().some((root) => isSamePath(root, abs))
}

/** 原子写:`.tmp-<rand>` → rename;rename 失败(Windows 上文件被占)退化为就地写(与笔记插件同源) */
async function writeFileAtomic(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.tmp-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  try {
    await fsp.writeFile(tmp, content, 'utf8')
    await fsp.rename(tmp, abs)
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    await fsp.writeFile(abs, content, 'utf8')
  }
}

function describeError(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  const code = err?.code
  if (code === 'ENOENT') return '路径不存在'
  if (code === 'EACCES' || code === 'EPERM') return `没有权限:${err.message ?? code}`
  if (code === 'EISDIR') return '目标是一个目录'
  if (code === 'ENOTDIR') return '路径中间有一层不是目录'
  if (code === 'ENOTEMPTY' || code === 'EEXIST') return '目标已存在'
  return err?.message ? `${code ? `${code}:` : ''}${err.message}` : String(e)
}

function typeOf(dirent: Dirent): FsEntryType {
  if (dirent.isSymbolicLink()) return 'symlink'
  if (dirent.isDirectory()) return 'dir'
  if (dirent.isFile()) return 'file'
  return 'other'
}

/** 一个条目的展示数据(大小 / mtime 走 lstat,**不跟随符号链接**) */
async function describeEntry(abs: string, name: string, type: FsEntryType): Promise<FsEntry> {
  let size = 0
  let mtimeMs = 0
  try {
    const st = await fsp.lstat(abs)
    mtimeMs = st.mtimeMs
    if (type === 'file') size = st.size
  } catch {
    // 竞态(列目录之后被删):留 0,不让整次调用失败
  }
  return { name, path: abs, type, size, mtimeMs }
}

/**
 * 列目录。`glob` 是对**相对列出目录的路径**过滤(`*` 不跨段 / `**` 跨段);
 * 不跟随符号链接(避免循环,也避免借着链接跑出白名单 —— 反正后续操作会被 guard 拦)。
 */
async function listDirectory(
  inputAbs: string,
  opts: { glob: string; recursive: boolean; limit: number; showHidden: boolean }
): Promise<{ entries: FsEntry[]; truncated: boolean }> {
  const entries: FsEntry[] = []
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    let dirents: Dirent[]
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true })
    } catch (e) {
      // 顶层读不动要报错;子目录读不动(权限 / 刚被删)就跳过
      if (depth === 0) throw e
      return
    }
    for (const dirent of dirents) {
      if (entries.length >= opts.limit) {
        truncated = true
        return
      }
      if (!opts.showHidden && isHiddenName(dirent.name)) continue
      const abs = join(dir, dirent.name)
      const relativePath = relative(inputAbs, abs).split(sep).join('/')
      const type = typeOf(dirent)
      if (matchGlob(opts.glob, relativePath)) entries.push(await describeEntry(abs, dirent.name, type))
      if (opts.recursive && type === 'dir') {
        if (depth + 1 >= MAX_LIST_DEPTH) {
          truncated = true
          continue
        }
        await walk(abs, depth + 1)
      }
    }
  }

  await walk(inputAbs, 0)
  return { entries: sortEntries(entries), truncated }
}

/** 目标是已存在的目录 → 放进去(与 `mv` / `cp` 的直觉一致),返回的 path 才是最终落点 */
async function resolveDestination(toAbs: string, fromAbs: string): Promise<{ dest: string; intoDir: boolean }> {
  try {
    const st = await fsp.stat(toAbs)
    if (st.isDirectory()) return { dest: join(toAbs, basename(fromAbs)), intoDir: true }
  } catch {
    // 目标不存在:按字面路径用
  }
  return { dest: toAbs, intoDir: false }
}

/** 截断处可能切在多字节字符中间:把尾部残缺的 UTF-8 序列去掉,免得读出一个假的替换字符 */
function trimPartialUtf8(buf: Buffer): Buffer {
  let end = buf.length
  let back = 0
  while (end > 0 && back < 3 && (buf[end - 1] as number) >= 0x80 && (buf[end - 1] as number) < 0xc0) {
    end--
    back++
  }
  if (end === 0) return buf.subarray(0, 0)
  const lead = buf[end - 1] as number
  if (lead >= 0xc0) {
    const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2
    if (back + 1 < expected) return buf.subarray(0, end - 1)
  }
  return buf.subarray(0, end)
}

export default {
  manifest,
  capabilities: ['ui', 'mcp'],
  activate(ctx: PluginContext): void {
    const store = ctx.storage<FilesSettings>({
      file: 'files-settings.json',
      defaults: { ...DEFAULT_FILES_SETTINGS }
    })

    function settings(): FilesSettings {
      return normalizeFilesSettings(store.get())
    }

    /**
     * 生效的工作目录视图。路径取 `resolveFileRoots()`(**guard 真正会放行的那份**,每次现读磁盘),
     * 而不是内存里的 settings —— 两者正常同源,但「AI 会看到什么」必须以后者为准:
     * 一旦有人手改了 files-settings.json,`browser_fs_roots` 就不该报一份与守卫不一致的清单。
     */
    function effectiveRootViews(): FilesRootView[] {
      const isDefault = sanitizeRoots(settings().roots, fileRootsDenyList()).length === 0
      return resolveFileRoots().map((path) => ({ path, isDefault, exists: existsSafe(path) }))
    }

    function settingsState(): FilesSettingsState {
      const current = settings()
      return {
        settings: { ...current, roots: sanitizeRoots(current.roots, fileRootsDenyList()) },
        roots: effectiveRootViews(),
        denyList: fileRootsDenyList(),
        downloadsDir: resolveDownloadsDir()
      }
    }

    function commit(next: FilesSettings): FilesSettingsState {
      const denyList = fileRootsDenyList()
      store.setRaw({ ...normalizeFilesSettings(next), roots: sanitizeRoots(next.roots, denyList) })
      const state = settingsState()
      ctx.ipc.emit(FILES_EVENT.changed, state)
      return state
    }

    // ---------- IPC(设置页用;本次**不**给渲染层任何 fs 操作面)----------

    ctx.ipc.handle('getSettings', (): FilesSettingsState => settingsState())

    ctx.ipc.handle('setSettings', (patch: unknown): FilesSettingsState => {
      const raw = (patch && typeof patch === 'object' ? patch : {}) as Partial<FilesSettings>
      return commit(normalizeFilesSettings({ ...settings(), ...raw }))
    })

    ctx.ipc.handle(
      'pickRoots',
      async (): Promise<FilesSettingsState & { canceled?: boolean; rejected?: string[] }> => {
        const options: OpenDialogOptions = {
          title: '选择允许 AI 读写的工作目录',
          properties: ['openDirectory', 'multiSelections']
        }
        const parent = BrowserWindow.getFocusedWindow()
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) return { ...settingsState(), canceled: true }
        const current = settings()
        const denyList = fileRootsDenyList()
        // 被静默丢掉的那些要说出来:否则用户点了 userData 会以为「加了但不好使」
        const rejected = result.filePaths.filter((p) => sanitizeRoots([p], denyList).length === 0)
        const next = commit(normalizeFilesSettings({ ...current, roots: [...current.roots, ...result.filePaths] }))
        return rejected.length > 0 ? { ...next, rejected } : next
      }
    )

    ctx.ipc.handle('removeRoot', (path: unknown): FilesSettingsState => {
      const target = typeof path === 'string' ? path.trim() : ''
      const current = settings()
      return commit(normalizeFilesSettings({ ...current, roots: current.roots.filter((r) => r !== target) }))
    })

    ctx.ipc.handle('openRoot', async (path: unknown): Promise<FilesActionResult> => {
      const check = checkFilePath(path)
      if (!check.ok) return { ok: false, error: check.error }
      const err = await shell.openPath(check.abs)
      return err ? { ok: false, error: err } : { ok: true, path: check.abs }
    })

    // ---------- MCP 工具 ----------
    // ⚠️ 插件工具的 schema **不做 strict 校验**(ARCHITECTURE §6.2),所以每个参数都要自己判类型。

    const str = (raw: unknown): string => (typeof raw === 'string' ? raw : '')

    ctx.mcp.tool(
      'browser_fs_roots',
      {
        description:
          '列出 AI 被允许读写的本地工作目录(白名单)。**动任何文件之前先调它** —— 白名单外的路径一律会被拒绝,别猜路径。无参数',
        inputSchema: {}
      },
      () => {
        const state = settingsState()
        return textContent({
          ok: true,
          roots: state.roots,
          downloadsDir: state.downloadsDir,
          allowPermanentDelete: state.settings.allowPermanentDelete,
          note:
            '路径必须落在上面这些目录之内(符号链接按真实路径判定);bow 自身的数据目录永远不可操作。' +
            'list 默认返回 200 条,可用 limit 调整'
        })
      }
    )

    ctx.mcp.tool(
      'browser_fs_list',
      {
        description:
          '列出允许目录里的条目(目录在前)。省略 path 用第一个工作目录。glob 用 * 不跨段、** 跨段、? 一个字符(不区分大小写);只有 recursive:true 才递归(最多 8 层,不跟随符号链接)',
        inputSchema: {
          path: z.string().optional().describe('要列出的目录;省略 = 第一个工作目录'),
          glob: z.string().optional().describe('按相对路径过滤,如 **/*.md'),
          recursive: z.boolean().optional().describe('是否递归子目录,默认 false'),
          limit: z.number().int().min(1).max(2000).optional().describe('最多返回多少条,默认取设置里的值'),
          showHidden: z.boolean().optional().describe('是否列出点号开头的项,默认 false')
        }
      },
      async (args): Promise<McpToolResult> => {
        const target = str(args.path).trim() || resolveFileRoots()[0] || ''
        const check = checkFilePath(target)
        if (!check.ok) return errorContent(check.error)

        let stat
        try {
          stat = await fsp.stat(check.abs)
        } catch (e) {
          return errorContent(describeError(e))
        }
        if (!stat.isDirectory()) return errorContent(`不是目录:${check.abs}(用 browser_fs_read 读文件)`)

        const limit = Math.min(MAX_LIST_LIMIT, clampListLimit(args.limit ?? settings().listLimit))
        try {
          const { entries, truncated } = await listDirectory(check.abs, {
            glob: str(args.glob),
            recursive: args.recursive === true,
            limit,
            showHidden: args.showHidden === true
          })
          const result: FilesListResult = { ok: true, path: check.abs, entries, truncated }
          return textContent({ ...result, count: entries.length })
        } catch (e) {
          return errorContent(describeError(e))
        }
      }
    )

    ctx.mcp.tool(
      'browser_fs_info',
      {
        description: '看一个路径是否存在、什么类型、多大、最后改于何时。路径不存在也是 ok:true(exists:false),不算失败',
        inputSchema: { path: z.string().describe('要查的路径') }
      },
      async (args): Promise<McpToolResult> => {
        const check = checkFilePath(args.path)
        if (!check.ok) return errorContent(check.error)
        try {
          const st = await fsp.lstat(check.abs)
          const type: FsEntryType = st.isSymbolicLink()
            ? 'symlink'
            : st.isDirectory()
              ? 'dir'
              : st.isFile()
                ? 'file'
                : 'other'
          return textContent({
            ok: true,
            path: check.abs,
            exists: true,
            type,
            size: st.isFile() ? st.size : 0,
            mtimeMs: st.mtimeMs,
            isRoot: isRootPath(check.abs)
          })
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return textContent({ ok: true, path: check.abs, exists: false })
          }
          return errorContent(describeError(e))
        }
      }
    )

    ctx.mcp.tool(
      'browser_fs_read',
      {
        description:
          '读一个文本文件(UTF-8)。默认最多读 64 KiB,超长会截断并标记 truncated。二进制文件(含 NUL 字节)会被拒绝 —— 那种文件用浏览器下载 / 上传处理',
        inputSchema: {
          path: z.string().describe('要读的文件路径'),
          maxBytes: z.number().int().min(1).max(1048576).optional().describe('最多读多少字节,默认 65536')
        }
      },
      async (args): Promise<McpToolResult> => {
        const check = checkFilePath(args.path)
        if (!check.ok) return errorContent(check.error)
        const maxBytes = Math.min(
          MAX_READ_BYTES,
          Math.max(1, Math.floor(Number(args.maxBytes) || DEFAULT_READ_MAX_BYTES))
        )
        try {
          const st = await fsp.stat(check.abs)
          if (st.isDirectory()) return errorContent(`是目录不是文件:${check.abs}(用 browser_fs_list)`)
          if (!st.isFile()) return errorContent(`不是普通文件,不读:${check.abs}`)
          const handle = await fsp.open(check.abs, 'r')
          try {
            const buf = Buffer.alloc(Math.min(maxBytes, st.size))
            const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
            const slice = buf.subarray(0, bytesRead)
            if (slice.includes(0)) return errorContent(`看起来是二进制文件(含 NUL 字节),不读:${check.abs}`)
            const truncated = st.size > bytesRead
            return textContent({
              ok: true,
              path: check.abs,
              size: st.size,
              mtimeMs: st.mtimeMs,
              truncated,
              text: (truncated ? trimPartialUtf8(slice) : slice).toString('utf8')
            })
          } finally {
            await handle.close()
          }
        } catch (e) {
          return errorContent(describeError(e))
        }
      }
    )

    ctx.mcp.tool(
      'browser_fs_write',
      {
        description:
          '写一个文本文件(原子写:.tmp → rename)。**目标已存在时必须显式 overwrite:true**,否则拒绝 —— 不会静默覆盖。父目录默认自动创建(createDirs:false 可关)',
        inputSchema: {
          path: z.string().describe('要写的文件路径'),
          content: z.string().describe('文件内容(UTF-8 文本)'),
          overwrite: z.boolean().optional().describe('目标已存在时是否允许覆盖,默认 false'),
          createDirs: z.boolean().optional().describe('父目录不存在时是否创建,默认 true')
        }
      },
      async (args): Promise<McpToolResult> => {
        const check = checkFilePath(args.path)
        if (!check.ok) return errorContent(check.error)
        if (typeof args.content !== 'string') return errorContent('content 必须是字符串')
        const content = args.content
        const overwrite = args.overwrite === true
        const createDirs = args.createDirs !== false
        try {
          const existing = await fsp.lstat(check.abs).catch(() => null)
          if (existing) {
            if (existing.isDirectory()) return errorContent(`目标是一个目录:${check.abs}`)
            if (!overwrite) {
              return errorContent(
                `文件已存在,拒绝覆盖:${check.abs}(确认要覆盖就传 overwrite:true;想改名请用 browser_fs_move)`
              )
            }
          }
          if (createDirs) {
            await fsp.mkdir(dirname(check.abs), { recursive: true })
          } else {
            const parent = await fsp.stat(dirname(check.abs)).catch(() => null)
            if (!parent) return errorContent(`父目录不存在:${dirname(check.abs)}(可传 createDirs:true)`)
          }
          await writeFileAtomic(check.abs, content)
          const st = await fsp.lstat(check.abs)
          return textContent({
            ok: true,
            path: check.abs,
            bytes: Buffer.byteLength(content, 'utf8'),
            size: st.size,
            overwrote: existing !== null
          })
        } catch (e) {
          return errorContent(describeError(e))
        }
      }
    )

    ctx.mcp.tool(
      'browser_fs_mkdir',
      {
        description: '新建目录。recursive:true(默认)时连父目录一起建,且目录已存在不算失败',
        inputSchema: {
          path: z.string().describe('要建的目录路径'),
          recursive: z.boolean().optional().describe('是否递归创建,默认 true')
        }
      },
      async (args): Promise<McpToolResult> => {
        const check = checkFilePath(args.path)
        if (!check.ok) return errorContent(check.error)
        try {
          const existing = await fsp.stat(check.abs).catch(() => null)
          if (existing?.isDirectory()) return textContent({ ok: true, path: check.abs, created: false })
          if (existing) return errorContent(`同名路径已存在且不是目录:${check.abs}`)
          await fsp.mkdir(check.abs, { recursive: args.recursive !== false })
          return textContent({ ok: true, path: check.abs, created: true })
        } catch (e) {
          return errorContent(describeError(e))
        }
      }
    )

    ctx.mcp.tool(
      'browser_fs_move',
      {
        description:
          '移动 / 重命名。**to 是已存在的目录时,文件会被放进去**(与 mv 一致),返回的 path 才是最终落点。目标已存在时必须 overwrite:true。工作目录本身不许被移走',
        inputSchema: {
          from: z.string().describe('源路径'),
          to: z.string().describe('目标路径(或已存在的目标目录)'),
          overwrite: z.boolean().optional().describe('目标已存在时是否允许覆盖,默认 false')
        }
      },
      async (args): Promise<McpToolResult> => {
        const from = checkFilePath(args.from)
        if (!from.ok) return errorContent(`from:${from.error}`)
        const to = checkFilePath(args.to)
        if (!to.ok) return errorContent(`to:${to.error}`)
        if (isSamePath(from.abs, to.abs)) return errorContent('源与目标相同')

        const overwrite = args.overwrite === true
        try {
          const source = await fsp.lstat(from.abs).catch(() => null)
          if (!source) return errorContent(`源路径不存在:${from.abs}`)
          if (isRootPath(from.abs)) return errorContent(`不许移动工作目录本身:${from.abs}`)

          const { dest, intoDir } = await resolveDestination(to.abs, from.abs)
          const destCheck = checkFilePath(dest)
          if (!destCheck.ok) return errorContent(`to:${destCheck.error}`)
          const target = destCheck.abs
          if (isInside(from.abs, target)) return errorContent(`不许把目录移动到它自己里面:${from.abs} → ${target}`)

          const existing = await fsp.lstat(target).catch(() => null)
          if (existing && !overwrite) {
            return errorContent(`目标已存在,拒绝覆盖:${target}(确认要覆盖就传 overwrite:true)`)
          }
          if (existing?.isDirectory() && source.isDirectory()) {
            return errorContent(`目标是一个已存在的目录:${target}(想放进去请把 to 指到它里面)`)
          }
          try {
            await fsp.rename(from.abs, target)
          } catch (e) {
            // 只有跨卷(rename 做不到)才回落成 copy + unlink。别的错误码(EPERM 被占 / EACCES 没权限)
            // 直接报出去 —— 那种情况下 copy 也会失败,而半拷贝状态比报错更难收拾
            if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
            ctx.log('跨卷移动,回落为复制 + 删除', from.abs, target)
            await fsp.cp(from.abs, target, { recursive: true, force: overwrite, errorOnExist: !overwrite })
            await fsp.rm(from.abs, { recursive: true, force: true })
          }
          const result: FilesActionResult = { ok: true, path: target }
          return textContent({ ...result, from: from.abs, intoDir })
        } catch (e) {
          return errorContent(describeError(e))
        }
      }
    )

    ctx.mcp.tool(
      'browser_fs_copy',
      {
        description:
          '复制文件或目录。目录必须 recursive:true。to 是已存在的目录时会被复制进去(返回的 path 是最终落点)。目标已存在时必须 overwrite:true',
        inputSchema: {
          from: z.string().describe('源路径'),
          to: z.string().describe('目标路径(或已存在的目标目录)'),
          overwrite: z.boolean().optional().describe('目标已存在时是否允许覆盖,默认 false'),
          recursive: z.boolean().optional().describe('目录必须传 true,默认 false')
        }
      },
      async (args): Promise<McpToolResult> => {
        const from = checkFilePath(args.from)
        if (!from.ok) return errorContent(`from:${from.error}`)
        const to = checkFilePath(args.to)
        if (!to.ok) return errorContent(`to:${to.error}`)
        if (isSamePath(from.abs, to.abs)) return errorContent('源与目标相同')

        const overwrite = args.overwrite === true
        const recursive = args.recursive === true
        try {
          const source = await fsp.lstat(from.abs).catch(() => null)
          if (!source) return errorContent(`源路径不存在:${from.abs}`)
          if (source.isDirectory() && !recursive) {
            return errorContent(`源是目录,复制目录要传 recursive:true:${from.abs}`)
          }
          const { dest, intoDir } = await resolveDestination(to.abs, from.abs)
          const destCheck = checkFilePath(dest)
          if (!destCheck.ok) return errorContent(`to:${destCheck.error}`)
          const target = destCheck.abs
          if (isInside(from.abs, target)) return errorContent(`不许把目录复制到它自己里面:${from.abs} → ${target}`)

          const existing = await fsp.lstat(target).catch(() => null)
          if (existing && !overwrite) {
            return errorContent(`目标已存在,拒绝覆盖:${target}(确认要覆盖就传 overwrite:true)`)
          }
          await fsp.cp(from.abs, target, { recursive, force: overwrite, errorOnExist: !overwrite })
          const result: FilesActionResult = { ok: true, path: target }
          return textContent({ ...result, from: from.abs, intoDir })
        } catch (e) {
          return errorContent(describeError(e))
        }
      }
    )

    ctx.mcp.tool(
      'browser_fs_delete',
      {
        description:
          '删除。**默认移到系统回收站(可恢复)**;permanent:true 才是真删,而且需要用户在设置里打开「允许永久删除」。删目录必须 recursive:true。工作目录本身不许删',
        inputSchema: {
          path: z.string().describe('要删的路径'),
          recursive: z.boolean().optional().describe('删目录必须传 true,默认 false'),
          permanent: z.boolean().optional().describe('是否永久删除(不进回收站),默认 false')
        }
      },
      async (args): Promise<McpToolResult> => {
        const check = checkFilePath(args.path)
        if (!check.ok) return errorContent(check.error)
        const recursive = args.recursive === true
        const permanent = args.permanent === true
        try {
          const st = await fsp.lstat(check.abs).catch(() => null)
          if (!st) return errorContent(`路径不存在:${check.abs}`)
          if (isRootPath(check.abs)) return errorContent(`不许删除工作目录本身:${check.abs}`)
          if (st.isDirectory() && !recursive) {
            return errorContent(`是目录,删目录要传 recursive:true:${check.abs}`)
          }
          if (permanent) {
            if (!settings().allowPermanentDelete) {
              return errorContent(
                '永久删除已被关闭:请让用户在 bow://settings 的「文件管理」里打开「允许永久删除」,或改用默认的回收站删除'
              )
            }
            await fsp.rm(check.abs, { recursive, force: false })
            ctx.log('永久删除', check.abs)
            return textContent({ ok: true, path: check.abs, permanent: true })
          }
          try {
            await shell.trashItem(check.abs)
          } catch (e) {
            return errorContent(
              `移到回收站失败:${describeError(e)}(没有降级为永久删除;若确实要真删,请在设置页打开「允许永久删除」后传 permanent:true)`
            )
          }
          ctx.log('移入回收站', check.abs)
          return textContent({ ok: true, path: check.abs, permanent: false, trashed: true })
        } catch (e) {
          return errorContent(describeError(e))
        }
      }
    )
  }
} satisfies PluginMain
