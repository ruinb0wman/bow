/**
 * adb 的 I/O 层:唯一碰 `node:child_process` 的地方。
 *
 * 所有执行都走注入的 `ExecDeps`,所以单测可以用假执行器跑完整流程(与 default-browser 的
 * `RegistrationDeps` 同一套路:真机只有一台,编排逻辑必须能在没有设备的地方测)。
 *
 * 本机形态(用户确认):**bow 是 Windows 上的常驻 bow.exe,而 adb 在 WSL 里** ——
 * 所以 adb 设置允许写成复合命令(`wsl adb` / `wsl -d Ubuntu-24.04 adb`),解析见 shared.ts
 * 的 `parseAdbSetting`。由此带来两个后果,都已在本文件里处理:
 *   1. 每条命令都是「冷启动一个 wsl.exe」→ 必须有超时,且不能用固定 sleep 探路;
 *   2. `adb forward` 建在 WSL 的 netns 里 → Windows 侧能否访问取决于 WSL2 **镜像网络**
 *      (`networkingMode=Mirrored`)。连不上时由 targets.ts 归类成 `port-unreachable`,
 *      提示语见 shared.ts 的 `problemHint`。
 */

import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import {
  adbArgv,
  adbConnectArgv,
  adbDevicesArgv,
  adbForwardAddArgv,
  adbForwardListArgv,
  adbForwardRemoveArgv,
  adbPairArgv,
  adbSocketsArgv,
  adbVersionArgv,
  parseDevices,
  parseForwardList,
  parseSockets,
  type AdbCommand,
  type AdbDevice,
  type AdbForwardEntry,
  type DevtoolsSocket
} from './shared'

export interface ExecResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  /** 超时被杀(与「命令自己失败」要分开:前者几乎总是 adb server 冷启动慢) */
  timedOut: boolean
}

export interface ExecDeps {
  run(file: string, argv: string[], opts: { timeoutMs: number }): Promise<ExecResult>
}

export interface AdbSession {
  cmd: AdbCommand
  deps: ExecDeps
  /** 默认单条命令超时 */
  timeoutMs: number
}

/** 真实执行器:不走 shell(参数原样传给 wsl.exe),隐藏窗口,限制缓冲 */
export function nodeExecDeps(): ExecDeps {
  return {
    run: (file, argv, opts) =>
      new Promise<ExecResult>((resolve) => {
        execFile(
          file,
          argv,
          {
            timeout: opts.timeoutMs,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            encoding: 'utf8',
            // `wsl.exe adb …` 需要继承环境(WSL 的 PATH 里才有 adb)
            env: process.env
          },
          (error, stdout, stderr) => {
            const timedOut = Boolean(
              error && typeof error === 'object' && 'killed' in error && (error as { killed?: boolean }).killed
            )
            const code =
              error && typeof error === 'object' && 'code' in error
                ? typeof (error as { code?: unknown }).code === 'number'
                  ? ((error as { code: number }).code as number)
                  : null
                : null
            resolve({
              ok: !error,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
              code,
              timedOut
            })
          }
        )
      })
  }
}

function failed(result: ExecResult, fallback: string): string {
  if (result.timedOut) return `命令超时(${fallback})`
  const text = (result.stderr || result.stdout).trim()
  return text ? text.split(/\r?\n/).slice(-3).join(' ') : fallback
}

export interface AdbTextResult {
  ok: boolean
  stdout: string
  error?: string
}

async function run(session: AdbSession, argv: string[], timeoutMs?: number): Promise<ExecResult> {
  return session.deps.run(session.cmd.file, argv, { timeoutMs: timeoutMs ?? session.timeoutMs })
}

/** `adb version`:既用于「探测 adb 是否可用」,也用于设置页显示版本 */
export async function adbVersion(session: AdbSession): Promise<AdbTextResult> {
  const result = await run(session, adbVersionArgv(session.cmd), 15_000)
  if (!result.ok) return { ok: false, stdout: '', error: failed(result, 'adb 不可用') }
  return { ok: true, stdout: result.stdout.trim() }
}

export interface DeviceListResult {
  ok: boolean
  devices: AdbDevice[]
  error?: string
}

/** `adb devices -l`(首次调用会拉起 adb server,给足超时) */
export async function listDevices(session: AdbSession): Promise<DeviceListResult> {
  const result = await run(session, adbDevicesArgv(session.cmd), 20_000)
  if (!result.ok) {
    return { ok: false, devices: [], error: failed(result, 'adb devices 失败') }
  }
  return { ok: true, devices: parseDevices(result.stdout) }
}

/** `cat /proc/net/unix` → 该设备上所有可调试的 WebView / Chrome 套接字 */
export async function listSockets(
  session: AdbSession,
  serial: string
): Promise<{ ok: boolean; sockets: DevtoolsSocket[]; error?: string }> {
  const result = await run(session, adbSocketsArgv(session.cmd, serial), 15_000)
  if (!result.ok) return { ok: false, sockets: [], error: failed(result, '读取 /proc/net/unix 失败') }
  // 老设备上 `/proc/net/unix` 可能因权限只给出部分行;空结果不算错误,交给上层提示
  return { ok: true, sockets: parseSockets(result.stdout) }
}

/** `adb forward tcp:<port> localabstract:<socket>` */
export async function addForward(
  session: AdbSession,
  serial: string,
  port: number,
  socket: string
): Promise<AdbTextResult> {
  const result = await run(session, adbForwardAddArgv(session.cmd, serial, port, socket), 15_000)
  if (!result.ok) return { ok: false, stdout: '', error: failed(result, 'adb forward 失败') }
  return { ok: true, stdout: result.stdout.trim() }
}

/** 回收转发。**设备已拔时必须忽略错误**:目的是清干净,不是报告失败 */
export async function removeForward(session: AdbSession, serial: string, port: number): Promise<void> {
  await run(session, adbForwardRemoveArgv(session.cmd, serial, port), 8_000)
}

/**
 * `adb forward --list` 的原始视图。**现在没有调用方**(仅作为诊断手段与格式证据)。
 * 之所以不去用它「清理像我们的转发」:那是共享资源,用户自己也可能建过同名转发。
 */
export async function listForwards(session: AdbSession): Promise<AdbForwardEntry[]> {
  const result = await run(session, adbForwardListArgv(session.cmd), 10_000)
  if (!result.ok) return []
  return parseForwardList(result.stdout)
}

/** 无线调试:`adb connect host:port` */
export async function connectDevice(session: AdbSession, address: string): Promise<AdbTextResult> {
  const result = await run(session, adbConnectArgv(session.cmd, address), 20_000)
  const text = (result.stdout + result.stderr).trim()
  // adb connect 会用退出码 0 + "failed to connect" 文案表达失败,所以要同时看文本
  const ok = result.ok && !/fail|unable|cannot/i.test(text)
  return ok ? { ok: true, stdout: text } : { ok: false, stdout: text, error: text || 'adb connect 失败' }
}

/** Android 11+ 首次无线配对:`adb pair host:port <配对码>`(必须在手机的配对弹窗打开期间执行) */
export async function pairDevice(
  session: AdbSession,
  address: string,
  code: string
): Promise<AdbTextResult> {
  const result = await run(session, adbPairArgv(session.cmd, address, code), 25_000)
  const text = (result.stdout + result.stderr).trim()
  const ok = result.ok && /successfully paired/i.test(text)
  return ok ? { ok: true, stdout: text } : { ok: false, stdout: text, error: text || 'adb pair 失败' }
}

/** 直接跑一条自由形式的 adb 子命令(设置页的「adb 自检」用) */
export async function rawAdb(
  session: AdbSession,
  args: string[]
): Promise<AdbTextResult> {
  const result = await run(session, adbArgv(session.cmd, args), 15_000)
  const text = (result.stdout + result.stderr).trim()
  return result.ok ? { ok: true, stdout: text } : { ok: false, stdout: text, error: text }
}

/**
 * 分配一个本地空闲端口给转发用。
 *
 * 做法是「绑 0 → 读端口 → 立刻释放」:存在极小的竞态窗口(释放后别的进程可能占走),
 * 所以调用方 **必须** 用 `adb forward` 的返回值确认成败,失败就换端口重试(见 targets.ts)。
 * 之所以不用固定端口段:用户机器上可能已有别的工具占着 9222/9223 这类常用端口。
 */
export function allocatePort(avoid: Iterable<number> = []): Promise<number> {
  const used = new Set(avoid)
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => {
        if (!port || used.has(port)) reject(new Error('无法分配空闲端口'))
        else resolve(port)
      })
    })
  })
}
