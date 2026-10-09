/**
 * 本地文件访问策略(核心层,**唯一来源**)。
 *
 * 为什么不是插件私有:这套策略要同时挡住两条路 ——
 * 1. 「文件管理」插件(`src/plugins/files/`)的全部 fs 操作;
 * 2. 「下载」插件 `browser_download` 的 `saveDir`(`downloads/main.ts` 只校验了 `isAbsolute`,
 *    不接这里的话白名单就是装饰)。
 *
 * 插件之间不能互相调 IPC,而**已经确立的跨插件共用方式**正是本目录的 `exportFile.ts`:
 * 核心读插件自己的设置文件,**每次现读、不缓存、不写**。内核那句「插件间共享 storage 文件名是错误用法」
 * 针对的是「两个 JsonStore 各持一份内存快照」——这里每次现读,不存在那个问题。
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
import { DEFAULT_FILES_SETTINGS, normalizeFilesSettings, type FilesSettings } from '@plugins/files/shared'
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
    return { ok: false, error: `路径不在允许的工作目录内:${abs}(可在 bow://settings 的「文件管理」里添加)` }
  }
  return { ok: true, abs: target }
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
 * **生效**的白名单:显式配的工作目录;一个都没配 → bow 的下载目录。
 * 注意这与「哪都能去」是两件事 —— 空数组绝不代表放开。
 */
export function resolveFileRoots(): string[] {
  const settings = readFilesSettingsRaw()
  const explicit = sanitizeRoots(settings.roots)
  if (explicit.length > 0) return explicit
  return [resolveDownloadsDir()]
}

/** 所有 fs 操作与 `saveDir` 的统一入口:白名单 + deny 名单 + realpath */
export function checkFilePath(raw: unknown, io: GuardIo = fileGuardIo): PathCheck {
  return checkPath(raw, resolveFileRoots(), io, fileRootsDenyList())
}
