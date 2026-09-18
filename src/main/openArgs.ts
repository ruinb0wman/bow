/**
 * 启动参数 → 要打开的目标列表(命令行、文件管理器「用 bow 打开」、第二个实例共用)。
 *
 * 纯解析:`existsSync` / `isDirectory` / `cwd` / `home` 全部由调用方注入 —— 这个模块要能在
 * vitest(node 环境)里单测,所以**不能 import electron**。
 *
 * 规则:
 * - 前 `skip` 个参数是 electron 自身的调用形态(dev 是 `electron . <args>`,打包后是 `bow <args>`);
 * - `--xxx` 一律当开关忽略(Chromium / Electron 自家参数不该被当成文件);
 * - `http:` / `https:` / `file:` 原样保留(经规范化后),其它 scheme(`mailto:` 等)忽略;
 * - 裸路径:`~` 展开 + 相对 `cwd` 解析 + 必须**存在且不是目录**;
 * - 目录 / 不存在的路径 / 认不出的参数一律忽略,原因通过 `onSkip` 交回调用方记日志
 *   (否则用户只会看到「双击了没反应」)。
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, normalize, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expandHome, isFileUrl, looksLikeLocalPath } from '@shared/localFile'
import { isHttpUrl } from '@shared/url'

/** 形如 `scheme:` 的开头 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

export type ArgKind = 'file-url' | 'http' | 'local-path' | 'scheme' | 'other'

/**
 * 单个启动参数的分类(**判定顺序本身就是被测的行为**,不是实现细节):
 * 1. `file://` → file-url;
 * 2. `http(s)://` → http;
 * 3. 本地路径(`~/…`、`./…`、`/abs`、Windows 盘符 `C:\…`、UNC `\\server\share\…`)→ local-path;
 * 4. 其它带 scheme 的(`mailto:`、`bow://` 等)→ scheme;
 * 5. 其余 → other。
 *
 * ⚠️ 第 3 步必须排在**第 4 步之前**:`C:\Users\x\a.html` 的 `C:` 完全符合 scheme 语法,
 * 先判 scheme 会把每一个 Windows 盘符路径都判成「不支持的协议」—— 这就是
 * 「Windows 上双击 html / 右键「用 bow 打开」完全没反应」的根因
 * (回归用例:`tests/openArgs.test.ts` 的「判定顺序」一组)。
 */
export function classifyArg(arg: string): ArgKind {
  if (isFileUrl(arg)) return 'file-url'
  if (isHttpUrl(arg)) return 'http'
  if (looksLikeLocalPath(arg)) return 'local-path'
  if (SCHEME_RE.test(arg)) return 'scheme'
  return 'other'
}

export interface OpenTargetDeps {
  existsSync(path: string): boolean
  isDirectory(path: string): boolean
  home: string
  cwd: string
}

export interface CollectOptions {
  /** 被忽略的参数与原因(记日志用,可选) */
  onSkip?(arg: string, reason: string): void
}

/** 真实依赖(node:fs / os.homedir);cwd 显式传入:第二个实例要用事件给的 workingDirectory */
export function defaultOpenTargetDeps(cwd: string = process.cwd()): OpenTargetDeps {
  return {
    existsSync,
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    },
    home: homedir(),
    cwd
  }
}

/** 输入 → 绝对路径(相对路径按 deps.cwd 解析) */
function toAbsolutePath(arg: string, deps: { home: string; cwd: string }): string {
  const expanded = expandHome(arg, deps.home)
  return isAbsolute(expanded) ? normalize(expanded) : resolve(deps.cwd, expanded)
}

/**
 * 从 argv 里挑出可打开的目标,返回顺序与输入一致、已去重。
 * 结果要么是 http(s) URL,要么是**已确认存在**的 `file://` URL。
 */
export function collectOpenTargets(
  argv: string[],
  skip: number,
  deps: OpenTargetDeps,
  opts: CollectOptions = {}
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (target: string): void => {
    if (seen.has(target)) return
    seen.add(target)
    out.push(target)
  }

  for (const arg of argv.slice(Math.max(0, skip))) {
    if (!arg || arg === '--') continue
    if (arg.startsWith('-')) {
      opts.onSkip?.(arg, '命令行开关')
      continue
    }

    switch (classifyArg(arg)) {
      // file:// URL → 规范化成本机路径再判定(不存在/目录一律忽略)
      case 'file-url': {
        let path: string
        try {
          path = fileURLToPath(arg)
        } catch {
          opts.onSkip?.(arg, '非本机 file URL')
          break
        }
        if (!deps.existsSync(path)) {
          opts.onSkip?.(arg, '文件不存在')
          break
        }
        if (deps.isDirectory(path)) {
          opts.onSkip?.(arg, '目录')
          break
        }
        push(pathToFileURL(path).href)
        break
      }

      case 'http':
        push(arg)
        break

      case 'local-path': {
        const abs = toAbsolutePath(arg, deps)
        if (!deps.existsSync(abs)) {
          opts.onSkip?.(arg, '文件不存在')
          break
        }
        if (deps.isDirectory(abs)) {
          opts.onSkip?.(arg, '目录')
          break
        }
        push(pathToFileURL(abs).href)
        break
      }

      case 'scheme':
        opts.onSkip?.(arg, '不支持的协议')
        break

      default:
        opts.onSkip?.(arg, '既不是 URL 也不是本地路径')
    }
  }

  return out
}
