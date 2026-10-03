/**
 * 「把 pi 状态桥扩展装进 pi 的扩展目录」的可复用逻辑(设置页 → 终端 → Pi 状态联动的「一键接入」用)。
 *
 * 为什么应用里要再实现一份:仓库脚本 `scripts/install-pi-agent-state.mjs` 是给**开发者/命令行**的,
 * 而打包后的应用里既没有 `scripts/`(electron-builder 只打 `out/**`)也没有可用的 `node` CLI。
 * 两份实现共享的不变式由 `tests/piBridgeExtension.test.ts` 钉住(文件名 / 归属标记 / 源路径),
 * 改一处必须同步改另一处。
 *
 * 三个刻意的设计:
 * 1. **归属标记**:目标文件带 `managed by bow` 才算「bow 装的」。没有标记却存在 → 拒写/拒删
 *    (除非显式 force),绝不覆盖用户自己的扩展;
 * 2. **幂等**:内容一致时什么都不做,返回 `unchanged`;
 * 3. I/O 全部注入(`PiBridgeIo`):这样这段逻辑能在 vitest 里用临时目录跑真 fs,
 *    也能在需要时用假 fs 测边界(目录不存在 / 读不到源 / 目标不是 bow 的)。
 *
 * ⚠️ 源的定位依赖打包配置:`app.getAppPath()/integrations/pi/bow-agent-state.ts`。
 * 所以 `package.json` 的 `build.files` 必须包含 `integrations` 目录,否则打包版里
 * `sourceAvailable` 为 false(设置页会把它显示出来,而不是静默失败)。
 */

import { join } from 'node:path'
import type { PiBridgeResult, PiBridgeStatus, PiBridgeWslHint } from './shared'

export const PI_BRIDGE_FILENAME = 'bow-agent-state.ts'
/** 与安装脚本逐字一致;也是「这文件是不是 bow 装的」的判据 */
export const PI_BRIDGE_MARKER = 'managed by bow'
/** 源文件相对应用根目录的位置(打包后的 asar 里也走这条相对路径) */
export const PI_BRIDGE_SOURCE_REL = ['integrations', 'pi', PI_BRIDGE_FILENAME] as const

/** 注入的 I/O(node:fs 的一小部分;测试可全用真实 fs + 临时目录) */
export interface PiBridgeIo {
  exists(path: string): boolean
  readFile(path: string): string | null
  writeFile(path: string, content: string): void
  mkdirp(path: string): void
  remove(path: string): void
}

export interface PiBridgeEnv {
  /** 用户主目录 */
  home: string
  /** 应用根目录(`app.getAppPath()`) */
  appPath: string
  /** 环境变量(只读 `PI_CODING_AGENT_DIR`) */
  env?: Record<string, string | undefined>
  /** 运行平台(默认 `process.platform`;注入是为了能在测试里验 Windows 分支) */
  platform?: string
}

// 跨端类型(`PiBridgeStatus` / `PiBridgeResult` 等)在 `./shared`:设置页也要 import 它们,
// 而本文件是主进程侧模块。

/** agent 目录 → extensions 目录 → 目标文件;环境变量优先(与 pi 自己的解析一致) */
export function bridgePaths(env: PiBridgeEnv): { agentDir: string; dir: string; target: string; source: string } {
  const configured = env.env?.PI_CODING_AGENT_DIR?.trim()
  const agentDir = configured || join(env.home, '.pi', 'agent')
  const dir = join(agentDir, 'extensions')
  return {
    agentDir,
    dir,
    target: join(dir, PI_BRIDGE_FILENAME),
    source: join(env.appPath, ...PI_BRIDGE_SOURCE_REL)
  }
}

function readSource(io: PiBridgeIo, source: string): string | null {
  return io.exists(source) ? io.readFile(source) : null
}

/**
 * Windows 路径 → WSL 里的挂载路径:`C:\Users\me\.pi\x.ts` → `/mnt/c/Users/me/.pi/x.ts`。
 * 按默认的 automount root(`/mnt`)换算;不是盘符路径(如 UNC `\\wsl$\…`)时返回 null ——
 * 那种情况给不出一行可靠的命令,宁可不说,也不要给一条复制过去就跑不通的命令。
 */
export function windowsPathToWsl(path: string): string | null {
  const m = /^([A-Za-z]):[\\/](.+)$/.exec(path)
  if (!m) return null
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

/**
 * 「bow 在 Windows、pi 在 WSL2 里跑」时的提醒:标题栏那个按钮装的是 **Windows** 的家目录,
 * 而发行版里的 pi 读的是 **WSL2** 的家目录 —— 这条给出在 WSL2 终端里执行的那一行命令。
 *
 * 只有满足两个前提才给:① bow 自己跑在 Windows 上(否则不存在“两个系统”这回事,
 * 比如 bow 就跑在 WSL 里时它俩家目录是同一个);② 目标路径能换算成 `/mnt/<盘>/…`。
 */
export function wslHint(env: PiBridgeEnv): PiBridgeWslHint | undefined {
  if ((env.platform ?? process.platform) !== 'win32') return undefined
  const from = windowsPathToWsl(bridgePaths(env).target)
  if (!from) return undefined
  const to = '~/.pi/agent/extensions'
  return { from, to, command: `mkdir -p ${to} && cp "${from}" ${to}/` }
}

/** 当前状态(设置页进来就先看它);不抛错,失败信息放在 `error` 里 */
export function piBridgeStatus(io: PiBridgeIo, env: PiBridgeEnv): PiBridgeStatus {
  const { agentDir, target, source } = bridgePaths(env)
  const sourceText = readSource(io, source)
  const existing = io.exists(target) ? io.readFile(target) : null
  const status: PiBridgeStatus = {
    agentDir,
    target,
    source,
    agentDirExists: io.exists(agentDir),
    installed: existing !== null,
    upToDate: existing !== null && sourceText !== null && existing === sourceText,
    foreign: existing !== null && !existing.includes(PI_BRIDGE_MARKER),
    sourceAvailable: sourceText !== null
  }
  const wsl = wslHint(env)
  if (wsl) status.wsl = wsl
  if (sourceText === null) status.error = `读不到 bow 自带的扩展源码:${source}`
  else if (status.foreign) status.error = `目标文件已存在且不是 bow 装的,不会覆盖:${target}`
  return status
}

/**
 * 安装 / 更新。`force` 才允许覆盖「不是 bow 装的」同名文件。
 * 返回的 `action` 就是界面要显示的那句话的来源。
 */
export function installPiBridge(io: PiBridgeIo, env: PiBridgeEnv, opts: { force?: boolean } = {}): PiBridgeResult {
  const { dir } = bridgePaths(env)
  const before = piBridgeStatus(io, env)
  if (!before.sourceAvailable) {
    return { ok: false, action: 'failed', message: before.error ?? '读不到扩展源码', status: before }
  }
  if (before.foreign && !opts.force) {
    return { ok: false, action: 'refused', message: before.error ?? '目标文件不是 bow 装的', status: before }
  }

  const sourceText = readSource(io, before.source)!
  if (before.upToDate) return { ok: true, action: 'unchanged', message: '已是最新', status: before }

  try {
    io.mkdirp(dir)
    io.writeFile(before.target, sourceText)
  } catch (e) {
    const status = { ...before, error: e instanceof Error ? e.message : String(e) }
    return { ok: false, action: 'failed', message: `写入失败:${status.error}`, status }
  }
  return {
    ok: true,
    action: before.installed ? 'updated' : 'installed',
    message: before.installed ? '已更新(在 pi 里 /reload 或重开终端生效)' : '已安装(在 pi 里重开或 /reload 生效)',
    status: piBridgeStatus(io, env)
  }
}

/** 卸载:只删带标记的那个文件(别人放的同名文件要 `force` 才动) */
export function uninstallPiBridge(io: PiBridgeIo, env: PiBridgeEnv, opts: { force?: boolean } = {}): PiBridgeResult {
  const status = piBridgeStatus(io, env)
  if (!status.installed) return { ok: true, action: 'absent', message: '未安装', status }
  if (status.foreign && !opts.force) {
    return { ok: false, action: 'refused', message: status.error ?? '目标文件不是 bow 装的', status }
  }
  try {
    io.remove(status.target)
  } catch (e) {
    const next = { ...status, error: e instanceof Error ? e.message : String(e) }
    return { ok: false, action: 'failed', message: `删除失败:${next.error}`, status: next }
  }
  return { ok: true, action: 'removed', message: '已卸载', status: piBridgeStatus(io, env) }
}
