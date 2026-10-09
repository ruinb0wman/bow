/**
 * 文件管理插件主进程侧:**唯一接触 electron 与 node:fs 的地方**。
 *
 * 三层,职责不要混:
 * 1. **操作层**(本文件里那些 `listDir` / `writeTextFile` / `deletePath`…):只接受**已经过 guard 的**绝对路径,
 *    返回 `{ok:...}` 结果对象(不抛、不拼 MCP 返回体)。MCP 工具与浏览面板 IPC **共用同一套** ——
 *    语义只能有一份,否则面板点删除与 AI 调工具会走出两种行为;
 * 2. **MCP 工具层**:校验入参类型(插件工具的 schema **不做 strict 校验**,ARCHITECTURE §6.2)→ guard → 调操作层;
 * 3. **IPC 层**:给设置页与浏览面板用(面板要的是数据,不要 `{content:[{text}]}` 那种 MCP 包装)。
 *
 * 三条纪律(改代码前先看):
 * 1. **每个入参路径都先过 `checkFilePath()`**(核心的 `src/main/plugins/fileRoots.ts`)——
 *    它做白名单 + realpath + deny 名单(userData),拿到返回的 `abs` 才能碰盘。不做路径拼接猜测。
 * 2. **删除默认进系统回收站**(`shell.trashItem`),这是比确认框更可靠的护栏;`permanent:true` 要设置开关,
 *    而且 `trashItem` 失败时**绝不降级**为永久删 —— 报错比默默毁数据强。
 * 3. **写文件默认不覆盖**:目标已存在且没显式 `overwrite:true` 就直接拒。
 *    这条是从笔记插件学来的(`expectMissing`:一次静默覆盖把用户整页笔记清空过,ARCHITECTURE:575)。
 *
 * 明确的**非目标**(见 `.pi/plans/2026-10-09-file-manager-plugin/plan.md`):
 * 网站文件选择器接管与 `browser_upload`(步骤 4/5,需要 CDP + 常挂标签调试器)还没做。
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
  sanitizeRoots,
  type PathCheck
} from '../../main/plugins/fileRoots'
import { resolveDownloadsDir } from '../../main/plugins/exportFile'
import {
  DEFAULT_FILES_SETTINGS,
  DEFAULT_READ_MAX_BYTES,
  FILES_EVENT,
  MAX_LIST_DEPTH,
  PANEL_LIST_LIMIT,
  READ_MAX_BYTES_LIMIT,
  clampListLimit,
  isHiddenName,
  matchGlob,
  normalizeFilesSettings,
  sortEntries,
  type FilesActionResult,
  type FilesDeleteManyResult,
  type FilesDeleteResult,
  type FilesInfoResult,
  type FilesListResult,
  type FilesMoveResult,
  type FilesNewResult,
  type FilesPickDirResult,
  type FilesReadResult,
  type FilesRootView,
  type FilesSettings,
  type FilesSettingsState,
  type FilesWriteResult,
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

/** 名字里不能有这些东西(面板的「重命名」用;路径分隔符会把操作变成移动) */
function checkEntryName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) return { ok: false, error: '名字不能为空' }
  if (name === '.' || name === '..') return { ok: false, error: '这个名字不合法' }
  if (name.includes('/') || name.includes('\\')) return { ok: false, error: '名字里不能带路径分隔符' }
  if (name.includes('\0')) return { ok: false, error: '名字里不能带 NUL 字符' }
  if (name.length > 255) return { ok: false, error: '名字太长(超过 255 个字符)' }
  return { ok: true, name }
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
     * `isDefault` 只用来标「这条是下载目录自动带的」,与「有没有额外配目录」无关。
     */
    function effectiveRootViews(): FilesRootView[] {
      let downloadsDir = ''
      try {
        downloadsDir = resolveDownloadsDir()
      } catch {
        downloadsDir = ''
      }
      return resolveFileRoots().map((path) => ({
        path,
        isDefault: downloadsDir !== '' && isSamePath(path, downloadsDir),
        exists: existsSafe(path)
      }))
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

    // ---------- 操作层:全部只接受**已 guard 的**绝对路径,返回结果对象(不抛) ----------

    async function listDir(
      abs: string,
      opts: { glob?: string; recursive?: boolean; limit?: number; showHidden?: boolean } = {}
    ): Promise<FilesListResult> {
      let stat
      try {
        stat = await fsp.stat(abs)
      } catch (e) {
        return { ok: false, error: describeError(e) }
      }
      if (!stat.isDirectory()) return { ok: false, error: `不是目录:${abs}(要读文件用 browser_fs_read)` }
      const limit = Math.min(MAX_LIST_LIMIT, clampListLimit(opts.limit ?? settings().listLimit))
      try {
        const { entries, truncated } = await listDirectory(abs, {
          glob: opts.glob ?? '',
          recursive: opts.recursive === true,
          limit,
          showHidden: opts.showHidden === true
        })
        return { ok: true, path: abs, entries, truncated, count: entries.length }
      } catch (e) {
        return { ok: false, error: describeError(e) }
      }
    }

    async function infoPath(abs: string): Promise<FilesInfoResult> {
      try {
        const st = await fsp.lstat(abs)
        const type: FsEntryType = st.isSymbolicLink()
          ? 'symlink'
          : st.isDirectory()
            ? 'dir'
            : st.isFile()
              ? 'file'
              : 'other'
        return {
          ok: true,
          path: abs,
          exists: true,
          type,
          size: st.isFile() ? st.size : 0,
          mtimeMs: st.mtimeMs,
          isRoot: isRootPath(abs)
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, path: abs, exists: false }
        return { ok: false, error: describeError(e) }
      }
    }

    async function readTextFile(abs: string, maxBytes: number): Promise<FilesReadResult> {
      const cap = Math.min(MAX_READ_BYTES, Math.max(1, Math.floor(maxBytes) || DEFAULT_READ_MAX_BYTES))
      try {
        const st = await fsp.stat(abs)
        if (st.isDirectory()) return { ok: false, error: `是目录不是文件:${abs}(用 browser_fs_list)` }
        if (!st.isFile()) return { ok: false, error: `不是普通文件,不读:${abs}` }
        const handle = await fsp.open(abs, 'r')
        try {
          const buf = Buffer.alloc(Math.min(cap, st.size))
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
          const slice = buf.subarray(0, bytesRead)
          if (slice.includes(0)) return { ok: false, error: `看起来是二进制文件(含 NUL 字节),不读:${abs}` }
          const truncated = st.size > bytesRead
          return {
            ok: true,
            path: abs,
            size: st.size,
            mtimeMs: st.mtimeMs,
            truncated,
            text: (truncated ? trimPartialUtf8(slice) : slice).toString('utf8')
          }
        } finally {
          await handle.close()
        }
      } catch (e) {
        return { ok: false, error: describeError(e) }
      }
    }

    async function writeTextFile(
      abs: string,
      content: string,
      opts: { overwrite?: boolean; createDirs?: boolean } = {}
    ): Promise<FilesWriteResult> {
      const overwrite = opts.overwrite === true
      const createDirs = opts.createDirs !== false
      try {
        const existing = await fsp.lstat(abs).catch(() => null)
        if (existing) {
          if (existing.isDirectory()) return { ok: false, error: `目标是一个目录:${abs}` }
          if (!overwrite) {
            return {
              ok: false,
              error: `文件已存在,拒绝覆盖:${abs}(确认要覆盖就传 overwrite:true;想改名请用 browser_fs_move)`
            }
          }
        }
        if (createDirs) {
          await fsp.mkdir(dirname(abs), { recursive: true })
        } else {
          const parent = await fsp.stat(dirname(abs)).catch(() => null)
          if (!parent) return { ok: false, error: `父目录不存在:${dirname(abs)}(可传 createDirs:true)` }
        }
        await writeFileAtomic(abs, content)
        const st = await fsp.lstat(abs)
        return {
          ok: true,
          path: abs,
          bytes: Buffer.byteLength(content, 'utf8'),
          size: st.size,
          overwrote: existing !== null
        }
      } catch (e) {
        return { ok: false, error: describeError(e) }
      }
    }

    async function makeDir(abs: string, recursive = true): Promise<FilesNewResult> {
      try {
        const existing = await fsp.stat(abs).catch(() => null)
        if (existing?.isDirectory()) return { ok: true, path: abs, created: false }
        if (existing) return { ok: false, error: `同名路径已存在且不是目录:${abs}` }
        await fsp.mkdir(abs, { recursive })
        return { ok: true, path: abs, created: true }
      } catch (e) {
        return { ok: false, error: describeError(e) }
      }
    }

    /** 移动 / 重命名(两端都必须是已 guard 的绝对路径) */
    async function movePath(fromAbs: string, toAbs: string, overwrite = false): Promise<FilesMoveResult> {
      try {
        const source = await fsp.lstat(fromAbs).catch(() => null)
        if (!source) return { ok: false, error: `源路径不存在:${fromAbs}` }
        if (isRootPath(fromAbs)) return { ok: false, error: `不许移动工作目录本身:${fromAbs}` }

        const { dest, intoDir } = await resolveDestination(toAbs, fromAbs)
        const destCheck = checkFilePath(dest)
        if (!destCheck.ok) return { ok: false, error: `to:${destCheck.error}` }
        const target = destCheck.abs
        if (isInside(fromAbs, target)) {
          return { ok: false, error: `不许把目录移动到它自己里面:${fromAbs} → ${target}` }
        }
        const existing = await fsp.lstat(target).catch(() => null)
        if (existing && !overwrite) {
          return { ok: false, error: `目标已存在,拒绝覆盖:${target}(确认要覆盖就传 overwrite:true)` }
        }
        if (existing?.isDirectory() && source.isDirectory()) {
          return { ok: false, error: `目标是一个已存在的目录:${target}(想放进去请把 to 指到它里面)` }
        }
        try {
          await fsp.rename(fromAbs, target)
        } catch (e) {
          // 只有跨卷(rename 做不到)才回落成 copy + unlink。别的错误码(EPERM 被占 / EACCES 没权限)
          // 直接报出去 —— 那种情况下 copy 也会失败,而半拷贝状态比报错更难收拾
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
          ctx.log('跨卷移动,回落为复制 + 删除', fromAbs, target)
          await fsp.cp(fromAbs, target, { recursive: true, force: overwrite, errorOnExist: !overwrite })
          await fsp.rm(fromAbs, { recursive: true, force: true })
        }
        return { ok: true, path: target, from: fromAbs, intoDir }
      } catch (e) {
        return { ok: false, error: describeError(e) }
      }
    }

    /** 面板的「重命名」= 同一个目录里换个名字(带分隔符的名字会被 `checkEntryName` 拒掉) */
    async function renameEntry(abs: string, rawName: unknown): Promise<FilesMoveResult> {
      const named = checkEntryName(rawName)
      if (!named.ok) return { ok: false, error: named.error }
      const target = join(dirname(abs), named.name)
      if (isSamePath(abs, target)) return { ok: true, path: abs, from: abs, intoDir: false }
      const check = checkFilePath(target)
      if (!check.ok) return { ok: false, error: check.error }
      return movePath(abs, check.abs, false)
    }

    async function copyPath(
      fromAbs: string,
      toAbs: string,
      opts: { overwrite?: boolean; recursive?: boolean } = {}
    ): Promise<FilesMoveResult> {
      const overwrite = opts.overwrite === true
      const recursive = opts.recursive === true
      try {
        const source = await fsp.lstat(fromAbs).catch(() => null)
        if (!source) return { ok: false, error: `源路径不存在:${fromAbs}` }
        if (source.isDirectory() && !recursive) {
          return { ok: false, error: `源是目录,复制目录要传 recursive:true:${fromAbs}` }
        }
        const { dest, intoDir } = await resolveDestination(toAbs, fromAbs)
        const destCheck = checkFilePath(dest)
        if (!destCheck.ok) return { ok: false, error: `to:${destCheck.error}` }
        const target = destCheck.abs
        if (isInside(fromAbs, target)) {
          return { ok: false, error: `不许把目录复制到它自己里面:${fromAbs} → ${target}` }
        }
        const existing = await fsp.lstat(target).catch(() => null)
        if (existing && !overwrite) {
          return { ok: false, error: `目标已存在,拒绝覆盖:${target}(确认要覆盖就传 overwrite:true)` }
        }
        await fsp.cp(fromAbs, target, { recursive, force: overwrite, errorOnExist: !overwrite })
        return { ok: true, path: target, from: fromAbs, intoDir }
      } catch (e) {
        return { ok: false, error: describeError(e) }
      }
    }

    async function deletePath(
      abs: string,
      opts: { recursive?: boolean; permanent?: boolean } = {}
    ): Promise<FilesDeleteResult> {
      const recursive = opts.recursive === true
      const permanent = opts.permanent === true
      try {
        const st = await fsp.lstat(abs).catch(() => null)
        if (!st) return { ok: false, error: `路径不存在:${abs}` }
        if (isRootPath(abs)) return { ok: false, error: `不许删除工作目录本身:${abs}` }
        if (st.isDirectory() && !recursive) {
          return { ok: false, error: `是目录,删目录要传 recursive:true:${abs}` }
        }
        if (permanent) {
          if (!settings().allowPermanentDelete) {
            return {
              ok: false,
              error:
                '永久删除已被关闭:请让用户在 bow://settings 的「文件管理」里打开「允许永久删除」,或改用默认的回收站删除'
            }
          }
          await fsp.rm(abs, { recursive, force: false })
          ctx.log('永久删除', abs)
          return { ok: true, path: abs, permanent: true }
        }
        try {
          await shell.trashItem(abs)
        } catch (e) {
          return {
            ok: false,
            error: `移到回收站失败:${describeError(e)}(没有降级为永久删除;若确实要真删,请在设置页打开「允许永久删除」后传 permanent:true)`
          }
        }
        ctx.log('移入回收站', abs)
        return { ok: true, path: abs, permanent: false, trashed: true }
      } catch (e) {
        return { ok: false, error: describeError(e) }
      }
    }

    // ---------- IPC ----------

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

    // ---- 下面是浏览面板的面(全部走同一个 guard;渲染层拿不到白名单外的任何东西)----

    ctx.ipc.handle('list', async (path: unknown, opts: unknown): Promise<FilesListResult> => {
      const check = checkFilePath(path)
      if (!check.ok) return { ok: false, error: check.error }
      const raw = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      return listDir(check.abs, {
        glob: typeof raw.glob === 'string' ? raw.glob : '',
        recursive: raw.recursive === true,
        limit: clampListLimit(raw.limit ?? PANEL_LIST_LIMIT),
        showHidden: raw.showHidden === true
      })
    })

    ctx.ipc.handle('readText', async (path: unknown): Promise<FilesReadResult> => {
      const check = checkFilePath(path)
      if (!check.ok) return { ok: false, error: check.error }
      return readTextFile(check.abs, DEFAULT_READ_MAX_BYTES)
    })

    ctx.ipc.handle('mkdir', async (path: unknown): Promise<FilesNewResult> => {
      const check = checkFilePath(path)
      if (!check.ok) return { ok: false, error: check.error }
      return makeDir(check.abs, true)
    })

    ctx.ipc.handle('rename', async (path: unknown, name: unknown): Promise<FilesMoveResult> => {
      const check = checkFilePath(path)
      if (!check.ok) return { ok: false, error: check.error }
      return renameEntry(check.abs, name)
    })

    ctx.ipc.handle(
      'move',
      async (from: unknown, to: unknown, overwrite: unknown): Promise<FilesMoveResult> => {
        const src = checkFilePath(from)
        if (!src.ok) return { ok: false, error: src.error }
        const dest = checkFilePath(to)
        if (!dest.ok) return { ok: false, error: dest.error }
        if (isSamePath(src.abs, dest.abs)) return { ok: false, error: '源与目标相同' }
        return movePath(src.abs, dest.abs, overwrite === true)
      }
    )

    ctx.ipc.handle(
      'copy',
      async (from: unknown, to: unknown, overwrite: unknown): Promise<FilesMoveResult> => {
        const src = checkFilePath(from)
        if (!src.ok) return { ok: false, error: src.error }
        const dest = checkFilePath(to)
        if (!dest.ok) return { ok: false, error: dest.error }
        if (isSamePath(src.abs, dest.abs)) return { ok: false, error: '源与目标相同' }
        return copyPath(src.abs, dest.abs, { overwrite: overwrite === true, recursive: true })
      }
    )

    ctx.ipc.handle('remove', async (paths: unknown): Promise<FilesDeleteManyResult> => {
      const list = Array.isArray(paths) ? paths : []
      const deleted: string[] = []
      const failed: Array<{ path: string; error: string }> = []
      for (const item of list) {
        const check = checkFilePath(item)
        if (!check.ok) {
          failed.push({ path: typeof item === 'string' ? item : String(item), error: check.error })
          continue
        }
        const result = await deletePath(check.abs, { recursive: true })
        if (result.ok) deleted.push(check.abs)
        else failed.push({ path: check.abs, error: result.error ?? '删除失败' })
      }
      return { ok: failed.length === 0, deleted, failed }
    })

    ctx.ipc.handle('pickDirectory', async (start: unknown): Promise<FilesPickDirResult> => {
      const check = checkFilePath(start)
      const fallback = check.ok ? check.abs : resolveFileRoots()[0]
      const options: OpenDialogOptions = {
        title: '选择目标目录',
        properties: ['openDirectory'],
        ...(fallback ? { defaultPath: fallback } : {})
      }
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return { canceled: true }
      return { path: result.filePaths[0] }
    })

    ctx.ipc.handle('openPath', async (path: unknown): Promise<FilesActionResult> => {
      const check = checkFilePath(path)
      if (!check.ok) return { ok: false, error: check.error }
      const err = await shell.openPath(check.abs)
      return err ? { ok: false, error: err } : { ok: true, path: check.abs }
    })

    ctx.ipc.handle('showInFolder', (path: unknown): FilesActionResult => {
      const check = checkFilePath(path)
      if (!check.ok) return { ok: false, error: check.error }
      shell.showItemInFolder(check.abs)
      return { ok: true, path: check.abs }
    })

    // ---------- MCP 工具 ----------
    // ⚠️ 插件工具的 schema **不做 strict 校验**(ARCHITECTURE §6.2),所以每个参数都要自己判类型。

    const str = (raw: unknown): string => (typeof raw === 'string' ? raw : '')

    /**
     * 工具层的统一收尾:结果对象 → MCP 返回体。
     * **不能只取 error 字段** —— `browser_upload` 失败时还要带回 `candidates`(多个输入框时让 LLM 自己挑)、
     * 成功时带回 `input`(页面侧真实的 files)。
     */
    const reply = (result: { ok: boolean; error?: string }): McpToolResult =>
      result.ok ? textContent(result) : textContent({ ...result, error: result.error ?? '操作失败' })

    /** guard 失败的收尾 */
    const guardReply = (check: PathCheck): McpToolResult | null =>
      check.ok ? null : errorContent(check.error)

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
        const failed = guardReply(check)
        if (failed || !check.ok) return failed ?? errorContent('路径校验失败')
        return reply(
          await listDir(check.abs, {
            glob: str(args.glob),
            recursive: args.recursive === true,
            limit: args.limit === undefined ? undefined : clampListLimit(args.limit),
            showHidden: args.showHidden === true
          })
        )
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
        const failed = guardReply(check)
        if (failed || !check.ok) return failed ?? errorContent('路径校验失败')
        return reply(await infoPath(check.abs))
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
        const failed = guardReply(check)
        if (failed || !check.ok) return failed ?? errorContent('路径校验失败')
        const maxBytes = args.maxBytes === undefined ? DEFAULT_READ_MAX_BYTES : Number(args.maxBytes)
        return reply(await readTextFile(check.abs, maxBytes))
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
        const failed = guardReply(check)
        if (failed || !check.ok) return failed ?? errorContent('路径校验失败')
        if (typeof args.content !== 'string') return errorContent('content 必须是字符串')
        return reply(
          await writeTextFile(check.abs, args.content, {
            overwrite: args.overwrite === true,
            createDirs: args.createDirs !== false
          })
        )
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
        const failed = guardReply(check)
        if (failed || !check.ok) return failed ?? errorContent('路径校验失败')
        return reply(await makeDir(check.abs, args.recursive !== false))
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
        return reply(await movePath(from.abs, to.abs, args.overwrite === true))
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
        return reply(
          await copyPath(from.abs, to.abs, { overwrite: args.overwrite === true, recursive: args.recursive === true })
        )
      }
    )

    ctx.mcp.tool(
      'browser_upload',
      {
        description:
          '把一个或多个**本地文件**塞进**网页**的 `<input type=file>`(CDP 直接设置,不弹任何文件对话框)。推荐流程:先本工具(传 selector),再用 browser_click 点提交按钮。省略 selector 时只有当页面恰好一个文件输入框才生效;多个就用 browser_snapshot 拿选择器。省略 tabId 时作用于 MCP 专属窗口的活动标签',
        inputSchema: {
          path: z.string().optional().describe('要上传的单个文件路径(与 paths 二选一)'),
          paths: z.array(z.string()).optional().describe('要上传的多个文件路径'),
          selector: z.string().optional().describe('目标文件输入框的 CSS 选择器;省略 = 页面上唯一那个 file input'),
          tabId: z.number().int().optional().describe('目标标签;省略 = MCP 专属窗口的活动标签')
        }
      },
      async (args): Promise<McpToolResult> => {
        const raw = [
          ...(Array.isArray(args.paths) ? args.paths : []),
          ...(typeof args.path === 'string' && args.path.trim() ? [args.path] : [])
        ]
        if (raw.length === 0) return errorContent('要传 path 或 paths')

        const files: string[] = []
        for (const item of raw) {
          const check = checkFilePath(item)
          if (!check.ok) return errorContent(check.error)
          const info = await infoPath(check.abs)
          if (!info.exists || info.type === 'dir') {
            return errorContent(`只能上传文件,这个不是文件:${check.abs}`)
          }
          files.push(check.abs)
        }

        try {
          const result = await ctx.pages.uploadFiles({
            ...(typeof args.tabId === 'number' ? { tabId: args.tabId } : {}),
            files,
            ...(str(args.selector).trim() ? { selector: str(args.selector).trim() } : {})
          })
          return reply(result)
        } catch (e) {
          // EMPTY_PAGE_API(内核还没注入页面 API)会 reject
          return errorContent(`上传失败:${describeError(e)}`)
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
        const failed = guardReply(check)
        if (failed || !check.ok) return failed ?? errorContent('路径校验失败')
        return reply(
          await deletePath(check.abs, { recursive: args.recursive === true, permanent: args.permanent === true })
        )
      }
    )
  }
} satisfies PluginMain
