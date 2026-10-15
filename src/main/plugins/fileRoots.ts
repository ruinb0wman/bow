/**
 * 本地文件访问策略(核心层,**唯一来源**)。
 *
 * 唯一使用者:「下载」插件的 `browser_download` 的 `saveDir`(`downloads/main.ts` 只校验了 `isAbsolute`,
 * 不接这里的话白名单就是装饰)。历史上它同时挡住「文件管理」插件的全部 fs 操作 ——
 * 那个插件已于 2026-10-15 删除,**它的设置形状(类型 + 归一化)因此搬进了本文件**。
 *
 * ⚠️ 插件删除后全仓库**已无任何写入方**:`<userData>/files-settings.json` 现在是只读配置,
 * 想加工作目录只能手改它的 `roots` 数组(**生效白名单 = `roots` ∪ bow 的下载目录**)——
 * 没有设置页入口,别再去找 UI。
 *
 * 三条硬规则(都有回归用例,别随手放宽):
 * 1. **包含判定不能用 `startsWith`** —— `/a/bc` 会被 `/a/b` 误判成在内(用 `path.relative`);
 * 2. **必须 realpath** —— 只 `resolve()` 的话,工作目录里一个指向 `/etc` 的符号链接就能把 LLM 带出去
 *    (`logseq/main.ts` 的 `assertWritable()` 就是这个洞,它是「图目录 + 两个子目录」的旧场景,不动它);
 * 3. **bow 自己的数据目录永远不许碰** —— 那里是密码库密文、书签、插件设置。
 */

import { app } from 'electron'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveDownloadsDir } from './exportFile'

/** 文件系统依赖(注入以便单测):只用到这两件事 */
export interface GuardIo {
  exists(path: string): boolean
  realpath(path: string): string
}

export type PathCheck = { ok: true; abs: string } | { ok: false; error: string }

/**
 * `abs` 是否在 `root` 之内(**含相等**)。
 * 用 `relative` 而不是 `startsWith`:后者会把 `/a/bc` 当成 `/a/b` 的子路径;
 * 盘符不同时 `relative` 返回绝对路径,这一条也顺带覆盖了。
 */
export function isInside(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** 同一个路径(Windows 下的盘符 / 大小写差异由 `path.relative` 抹平) */
export function isSamePath(a: string, b: string): boolean {
  return relative(a, b) === ''
}

/** 真实文件系统上的 GuardIo */
export const fileGuardIo: GuardIo = {
  exists: (path) => {
    try {
      return existsSync(path)
    } catch {
      return false
    }
  },
  realpath: (path) => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
}

/**
 * 对**最深的已存在祖先**做 realpath,再把还不存在的尾段拼回去。
 *
 * 为什么不直接对目标 realpath:创建新文件(以及 `createDirs`)时它还不存在,`realpath` 会 ENOENT;
 * 而只 `resolve()` 不 realpath 又会被符号链接带走 —— 两者必须合起来做。
 */
export function realpathDeepest(abs: string, io: GuardIo = fileGuardIo): string {
  let current = abs
  const tail: string[] = []
  while (!io.exists(current)) {
    const parent = dirname(current)
    if (parent === current) return abs
    tail.unshift(basename(current))
    current = parent
  }
  const real = io.realpath(current)
  return tail.length === 0 ? real : join(real, ...tail)
}

/** 禁止操作的路径:bow 自己的数据目录(userData) */
export function fileRootsDenyList(): string[] {
  try {
    return [app.getPath('userData')]
  } catch {
    return []
  }
}

/**
 * 校验一个用户/LLM 给的路径:非空、无 NUL、支持的前缀、落在某个 root 内(realpath 之后)、
 * 且不在 deny 名单里。**返回的 `abs` 才是应该拿去操作的那个路径**(它已经过 realpath)。
 */
export function checkPath(
  raw: unknown,
  roots: readonly string[],
  io: GuardIo = fileGuardIo,
  deny: readonly string[] = []
): PathCheck {
  const input = typeof raw === 'string' ? raw.trim() : ''
  if (!input) return { ok: false, error: '路径不能为空' }
  if (input.includes('\0')) return { ok: false, error: '路径包含非法字符' }
  // \\?\ 前缀会绕过长路径规范化,破坏下面的前缀判定,直接拒
  if (input.startsWith('\\\\?\\')) return { ok: false, error: '不支持 \\\\?\\ 前缀的路径' }
  if (roots.length === 0) return { ok: false, error: '还没有配置允许的工作目录' }

  const abs = resolve(input)
  const target = realpathDeepest(abs, io)

  for (const item of deny) {
    const denied = realpathDeepest(resolve(item), io)
    if (isSamePath(denied, target) || isInside(denied, target)) {
      return { ok: false, error: `该路径属于 bow 自身的数据目录,不允许操作:${abs}` }
    }
  }

  const hit = roots.some((root) => isInside(realpathDeepest(resolve(root), io), target))
  if (!hit) {
    return {
      ok: false,
      error: `路径不在允许的工作目录内:${abs}(白名单见 <userData>/files-settings.json 的 roots)`
    }
  }
  return { ok: true, abs: target }
}

// ---------- 设置形状(原先在 plugins/files/shared.ts;插件删除后搬进核心) ----------

/** 工作目录数量上限(不让设置文件无限膨胀) */
export const MAX_ROOTS = 32

export interface FilesSettings {
  version: number
  /** 允许读写的工作目录(**绝对**路径);生效白名单 = 这里配的 ∪ 下载目录,见 `resolveFileRoots()` */
  roots: string[]
}

export const DEFAULT_FILES_SETTINGS: FilesSettings = { version: 1, roots: [] }

/**
 * 归一设置:只做**形状**清洗 —— 去空、去首尾空格、去重、丢掉非字符串、截断上限。
 * 路径合法性(绝对路径 / deny 名单)由 `sanitizeRoots()` 管。
 *
 * 历史上这个文件还有 `allowPermanentDelete` / `listLimit` / `interceptFileChooser` 三个键,
 * 它们只服务于已删除的文件管理插件 —— 从此**只读不认**(老 json 里留着无害,不会被写回)。
 */
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
  return { version: DEFAULT_FILES_SETTINGS.version, roots }
}

/** 读一次 `files-settings.json`;坏 JSON / 文件不存在 / 读不到 → 默认设置 */
export function readFilesSettingsRaw(): FilesSettings {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'files-settings.json'), 'utf-8')
    return normalizeFilesSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_FILES_SETTINGS, roots: [] }
  }
}

/**
 * 清洗用户配的工作目录:丢掉**非绝对路径**(相对路径会按进程 cwd 解析,含义随启动方式漂移)、
 * 丢掉 deny 名单里的、去重。写盘前与读盘后都要过一遍。
 */
export function sanitizeRoots(roots: readonly string[], deny: readonly string[] = fileRootsDenyList()): string[] {
  const out: string[] = []
  for (const item of roots) {
    const value = typeof item === 'string' ? item.trim() : ''
    if (!value || !isAbsolute(value)) continue
    const abs = resolve(value)
    if (deny.some((d) => isInside(resolve(d), abs))) continue
    if (out.some((existing) => isSamePath(existing, abs))) continue
    out.push(abs)
  }
  return out
}

/**
 * **生效**的白名单:**你配的工作目录 ∪ bow 的下载目录**。
 *
 * 下载目录**永远**在里面(排在你配的那些后面)。为什么不让它只当「没配时才用的默认值」:
 * 一旦你添了任何工作目录,下载目录就不再是 root,于是 `browser_download {saveDir: <下载目录>}`
 * 会开始报「不在允许的工作目录内」—— 而不传 saveDir 的同一次下载照样写进同一个目录,自相矛盾。
 *
 * 注意这与「哪个目录都能去」是两件事:一个都没配 ≈ 只有下载目录。
 * 另外 bow 数据目录永远不会因为它而被放行(`checkPath` 先查 deny 名单)。
 */
export function resolveFileRoots(): string[] {
  const settings = readFilesSettingsRaw()
  const configured = sanitizeRoots(settings.roots)
  const downloads = downloadDirSafe()
  if (!downloads) return configured
  if (configured.some((root) => isSamePath(root, downloads))) return configured
  return [...configured, downloads]
}

/** 下载目录解析失败时不要拖垮整个白名单(宁可只剩你配的那几个,也不要抛) */
function downloadDirSafe(): string {
  try {
    return resolveDownloadsDir()
  } catch {
    return ''
  }
}

/** 所有 fs 操作与 `saveDir` 的统一入口:白名单 + deny 名单 + realpath */
export function checkFilePath(raw: unknown, io: GuardIo = fileGuardIo): PathCheck {
  return checkPath(raw, resolveFileRoots(), io, fileRootsDenyList())
}
