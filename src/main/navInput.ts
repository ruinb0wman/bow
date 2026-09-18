/**
 * 地址栏输入的导航解析:在 shared 的 `resolveNavigation` 之上补一条「本地文件」分支。
 *
 * 为什么这一层放在主进程:判定文件是否存在要读文件系统,而 `@shared/url` 必须保持
 * 同构纯逻辑(renderer 也在用)。判定顺序刻意是「形态像本地路径 **且真的存在** → 文件」,
 * 其余一律原样回落到 `resolveNavigation` —— 所以 `file.html`、`example.com`、
 * `bow://settings` 的行为零变化。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SearchEngineId } from '@shared/types'
import { expandHome, isFileUrl, looksLikeLocalPath } from '@shared/localFile'
import { resolveNavigation, type ResolveNavigationResult } from '@shared/url'

export interface NavInputDeps {
  /** 路径是否存在(测试注入假实现) */
  exists(path: string): boolean
  /** 家目录(`~` 展开用) */
  home: string
  /** 相对路径的基准目录 */
  cwd: string
}

/** 真实依赖(node:fs / os.homedir);cwd 显式传入,避免隐藏依赖 process.cwd() */
export function defaultNavInputDeps(cwd: string = process.cwd()): NavInputDeps {
  return { exists: existsSync, home: homedir(), cwd }
}

/** 输入 → 绝对路径(相对路径按 deps.cwd 解析);空输入返回 null */
export function toAbsolutePath(input: string, deps: { home: string; cwd: string }): string | null {
  const expanded = expandHome(input, deps.home)
  if (!expanded) return null
  return isAbsolute(expanded) ? normalize(expanded) : resolve(deps.cwd, expanded)
}

/**
 * 地址栏输入 → 最终导航 URL:
 * - `file://…` → 原样返回(不检查存在性,交给 Chromium 报错,与 Chrome 行为一致);
 * - 形态像本地路径且文件存在 → `file://` URL(`~` 展开、相对路径按 cwd 解析);
 * - 其余(含路径不存在、`file.html` 这类域名形态)→ 原 `resolveNavigation`(URL / 搜索)。
 */
export function resolveNavigationWithFiles(
  input: string,
  engine: SearchEngineId,
  deps: NavInputDeps
): ResolveNavigationResult {
  const raw = input.trim()
  if (isFileUrl(raw)) return { parsed: 'url', url: raw }
  if (looksLikeLocalPath(raw)) {
    const abs = toAbsolutePath(raw, deps)
    if (abs && deps.exists(abs)) return { parsed: 'url', url: pathToFileURL(abs).href }
  }
  return resolveNavigation(input, engine)
}
