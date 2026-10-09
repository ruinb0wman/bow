/**
 * 文件管理插件:三端安全的纯逻辑(不 import electron / node:fs / node:path)。
 *
 * 分工(改代码前先看这几条):
 * - **本文件**:设置模型与归一、返回体形状、条目排序、glob 匹配、大小格式化 —— 全部可单测;
 * - **`src/main/plugins/fileRoots.ts`(核心)**:路径策略(白名单 / realpath / deny 名单)的**唯一来源**。
 *   它为什么在核心而不在这里:策略要同时挡住「文件管理」插件的 fs 操作与「下载」插件 `browser_download`
 *   的 `saveDir`(见该文件注释);
 * - **`main.ts`**:唯一接触 electron 与 node:fs 的地方(真读真写 / 回收站 / 对话框);
 * - **`ui/*.vue`**:只调 IPC 与渲染,不自己判断路径是否合法(文案与判定都从主进程来)。
 *
 * ⚠️ 纯逻辑必须留在这里 —— vitest 跑在 node 环境,而渲染层**也** import 本文件:
 * `node:path` 一旦进来,两边同时炸(`downloads/shared.ts` 顶部写了同一条约定)。
 */

/** 列表条数上限的钳制范围 */
export const LIST_LIMIT_MIN = 1
export const LIST_LIMIT_MAX = 2000
export const DEFAULT_LIST_LIMIT = 200
/** 递归列出的最大深度:一次调用别把整棵树读出来 */
export const MAX_LIST_DEPTH = 8
/** 设置页最多能配多少个工作目录 */
export const MAX_ROOTS = 32
/** `browser_fs_read` 的默认 / 上限字节数 */
export const DEFAULT_READ_MAX_BYTES = 64 * 1024
export const READ_MAX_BYTES_LIMIT = 1024 * 1024

export interface FilesSettings {
  version: number
  /**
   * 允许读写的工作目录(**绝对**路径)。**生效的白名单 = 这里配的 ∪ 下载目录**(见 `fileRoots.resolveFileRoots`),
   * 所以**空数组 ≠ 哪都能去** —— 它表示「只用 bow 的下载目录」。相对路径在 `sanitizeRoots()` 阶段就被丢掉。
   */
  roots: string[]
  /** 允许 `browser_fs_delete {permanent:true}`:不进系统回收站的删除 */
  allowPermanentDelete: boolean
  /**
   * 接管网站的文件选择框:点网页的上传按钮时不弹系统对话框,改由 bow 面板选文件。
   * 代价:需要对**含 file input 的标签页**一直挂着调试器 → 那些标签页开着 DevTools 会让接管失效
   * (DevTools 赢,我们收到 `onLost` 后不再自动重挂)。
   */
  interceptFileChooser: boolean
  /** 列目录的默认条数 */
  listLimit: number
}

export const DEFAULT_FILES_SETTINGS: FilesSettings = {
  version: 1,
  roots: [],
  allowPermanentDelete: false,
  interceptFileChooser: true,
  listLimit: DEFAULT_LIST_LIMIT
}

/** 插件广播事件名(经 ctx.ipc.emit) */
export const FILES_EVENT = {
  /** 设置变更(工作目录增删 / 开关) */
  changed: 'changed',
  /** 这次文件选择结束了(应答 / 取消 / 过期):让所有窗口收起「选文件」模式 */
  chooserResolved: 'chooser-resolved',
  /** 请工具栏按钮把面板打开(主进程不能直接开浮层;密码插件的 `open-panel` 同路子) */
  openPanel: 'open-panel'
} as const

export type FsEntryType = 'file' | 'dir' | 'symlink' | 'other'

export interface FsEntry {
  name: string
  path: string
  type: FsEntryType
  /** 目录恒为 0(不去 stat 每个子项,省一次系统调用) */
  size: number
  mtimeMs: number
}

/** 设置页/工具里的一条工作目录 */
export interface FilesRootView {
  path: string
  /** 是**下载目录**自动带上来的那一条(设置页不给删,因为删了它也会回来) */
  isDefault: boolean
  exists: boolean
}

/** `getSettings` IPC 的返回体(同时喂设置页与 `browser_fs_roots`) */
export interface FilesSettingsState {
  settings: FilesSettings
  /** **生效**的工作目录(已解析默认项) */
  roots: FilesRootView[]
  /** 永远不许操作的路径(设置页用它来拒绝添加) */
  denyList: string[]
  /** 实际解析出来的下载目录(默认 root 就是它) */
  downloadsDir: string
}

export interface FilesListResult {
  ok: boolean
  /** 实际列出的目录 */
  path?: string
  entries?: FsEntry[]
  /** 命中上限 / 深度上限被截断 */
  truncated?: boolean
  /** 本次返回了多少条(`entries.length`,省得调用方再数一遍) */
  count?: number
  error?: string
}

export interface FilesActionResult {
  ok: boolean
  /** 动作真正落到的路径(move/copy 传目录时它会多出一层 basename,以这个为准) */
  path?: string
  error?: string
}

export interface FilesInfoResult {
  ok: boolean
  path?: string
  exists?: boolean
  type?: FsEntryType
  size?: number
  mtimeMs?: number
  isRoot?: boolean
  error?: string
}

export interface FilesReadResult {
  ok: boolean
  path?: string
  size?: number
  mtimeMs?: number
  truncated?: boolean
  text?: string
  error?: string
}

export interface FilesWriteResult extends FilesActionResult {
  bytes?: number
  size?: number
  overwrote?: boolean
}

export interface FilesNewResult extends FilesActionResult {
  /** 目录是不是这次真新建的(false = 本来就存在) */
  created?: boolean
}

export interface FilesMoveResult extends FilesActionResult {
  from?: string
  /** `to` 指向的是已存在的目录,东西被放进了它里面 */
  intoDir?: boolean
}

export interface FilesDeleteResult extends FilesActionResult {
  permanent?: boolean
  trashed?: boolean
}

/** 面板的批量删除结果:部分失败不算整体失败,逐条报 */
export interface FilesDeleteManyResult {
  ok: boolean
  deleted: string[]
  failed: Array<{ path: string; error: string }>
}

/** 目录选择框(「移动到…」/「复制到…」用)的结果 */
export interface FilesPickDirResult {
  canceled?: boolean
  path?: string
}

/** 面板一次最多列多少条(不做分页,到上限就提示缩小范围) */
export const PANEL_LIST_LIMIT = 500

export function clampListLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_LIST_LIMIT
  return Math.min(LIST_LIMIT_MAX, Math.max(LIST_LIMIT_MIN, Math.floor(n)))
}

/** 归一设置:只认自己认识的形状。只做**形状**清洗,绝对路径与 deny 名单由 `fileRoots.sanitizeRoots()` 管 */
export function normalizeFilesSettings(input: unknown): FilesSettings {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const roots: string[] = []
  if (Array.isArray(raw.roots)) {
    for (const item of raw.roots) {
      if (typeof item !== 'string') continue
      const value = item.trim()
      if (!value || roots.includes(value)) continue
      roots.push(value)
      if (roots.length >= MAX_ROOTS) break
    }
  }
  return {
    version: DEFAULT_FILES_SETTINGS.version,
    roots,
    allowPermanentDelete: raw.allowPermanentDelete === true,
    // 默认**开**:用户要的就是「在 bow 内部选文件」;显式 false 才关
    interceptFileChooser: raw.interceptFileChooser !== false,
    listLimit: clampListLimit(raw.listLimit)
  }
}

/** 点号开头的项(工具默认不列,`showHidden:true` 才列) */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** 目录在前,然后按名字(数字按数值比,大小写不敏感) */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  const rank = (e: FsEntry): number => (e.type === 'dir' ? 0 : 1)
  return [...entries].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/**
 * glob → 正则:星号不跨段、双星跨段、`?` 一个字符,其余字符转义。
 * 双星后面跟斜杠时写成「可选的任意目录前缀」,所以 `**` + `/*.md` **也**能命中当前层的 `a.md`(与常见 glob 语义一致)。
 * **不区分大小写**(Windows 上用户写的 `*.MD` 与 `*.md` 应当都命中);`/` 是唯一的分隔符,
 * 调用方负责把平台分隔符换成 `/`。
 */
export function globToRegExp(pattern: string): RegExp {
  const src = pattern.trim()
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string
    if (ch === '*') {
      if (src[i + 1] === '*') {
        i++
        if (src[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

/** 空模式 = 全匹配 */
export function matchGlob(pattern: string, relativePath: string): boolean {
  if (!pattern.trim()) return true
  return globToRegExp(pattern).test(relativePath.split('\\').join('/'))
}
