/**
 * 内置 OpenKnowledge(OK)的跨端契约 + 纯逻辑(两端安全:不引 electron / DOM,可单测)。
 *
 * 这里只放能用字符串 / JSON 判定的东西:设置归一、从 server 的 stdout 里认出端口、
 * 校验 `.ok/local/server.lock` 的形状。进程与 IPC 全在 main.ts。
 */

import { windowsPathToWsl } from '@shared/localFile'

export interface OkSettings {
  /** 唯一一个 OK 项目目录(必须已 `ok init`);空串 = 还没选 */
  projectPath: string
  /** bow 启动就把服务拉起来,不等用户点按钮 */
  autoStart: boolean
}

export type OkPhase = 'stopped' | 'starting' | 'running' | 'error'

export interface OkState {
  settings: OkSettings
  phase: OkPhase
  /** 就绪时才有:服务端口 */
  port: number | null
  /** `http://127.0.0.1:<port>` */
  url: string | null
  pid: number | null
  /** 服务自报的版本(读自 lock):和机器上那份全局 `ok` 可能是不同版本 */
  runtimeVersion: string | null
  /** 最近一次失败的原因(成功后清空) */
  error: string | null
}

export const OK_EVENT = { changed: 'changed' } as const

/** 自启默认开 —— 用户要的就是「bow 起来知识库就在」 */
export const DEFAULT_SETTINGS: OkSettings = { projectPath: '', autoStart: true }

export function normalizeSettings(raw: unknown): OkSettings {
  const obj = raw && typeof raw === 'object' ? (raw as Partial<OkSettings>) : {}
  return {
    projectPath: typeof obj.projectPath === 'string' ? obj.projectPath.trim() : '',
    autoStart: obj.autoStart !== false
  }
}

/** OK `start` 的横幅长这样:`│  Local:   http://127.0.0.1:45167  │` */
const LOCAL_URL = /127\.0\.0\.1:(\d{2,5})/g

/**
 * 从**累积**的 stdout 里认出端口。
 *
 * 故意不做单块解析:横幅实测会跨 chunk 到达。取最后一个匹配 —— 端口每次随机分配,
 * 后出现的才是当前服务的。
 */
export function parsePortFromStdout(text: string): number | null {
  let port: number | null = null
  for (const m of text.matchAll(LOCAL_URL)) {
    const n = Number.parseInt(m[1], 10)
    if (n > 0 && n < 65536) port = n
  }
  return port
}

/**
 * OK 服务该跑在哪一侧。
 *
 * **Windows 上必须跑在 WSL 里**:pi(以及 pi-acp)只装在发行版里,而 OK 的对话靠「自己派生子进程 +
 * stdio JSON-RPC」驱动 agent —— 只有同 OS 同 PATH 才可能通。实测过反过来的做法(OK 留在 Windows,
 * ACP agent 命令填 `wsl.exe … pi-acp`):握手能过,但 `session/new` 传的 cwd 是 Windows 路径,
 * pi-acp 在 Linux 侧判定「不是绝对路径」直接拒,所以那条路是死的。
 */
export function okRuntime(platform: string): 'wsl' | 'native' {
  return platform === 'win32' ? 'wsl' : 'native'
}

/** 横幅第一行 `open-knowledge v0.88.5`:版本以服务自己报的为准,不是 bow 里装的那个包 */
const BANNER_VERSION = /open-knowledge v(\d+\.\d+\.\d+)/

export function parseRuntimeVersion(text: string): string | null {
  const m = BANNER_VERSION.exec(text)
  return m === null ? null : m[1]
}

/** `\\wsl.localhost\<distro>\home\x` / `\\wsl$\<distro>\home\x` */
const WSL_UNC = /^\\\\wsl(?:\.localhost|\$)?\\[^\\]+\\?(.*)$/i

/**
 * 把用户选的目录换成 **WSL 里的 Linux 路径**(服务跑在那一侧,`cwd` 只能是 Linux 路径)。
 * 已是 Linux 路径原样返回;盘符路径按默认 automount 换算;换算不了返回 null。
 */
export function toWslPath(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('/')) return trimmed
  const unc = WSL_UNC.exec(trimmed)
  if (unc !== null) return `/${unc[1].replace(/\\/g, '/')}`
  return windowsPathToWsl(trimmed)
}

export interface OkLock {
  pid: number
  port: number
  url: string
  runtimeVersion: string | null
}

/**
 * `.ok/local/server.lock` 的形状校验。
 *
 * 服务刚起时这个文件可能正被写(半截 JSON)→ 返回 null,由调用方下一轮重试;
 * 千万别在这里抛异常,启动轮询靠它判断"还没好"。
 */
export function parseLock(text: string): OkLock | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const pid = typeof obj.pid === 'number' && Number.isInteger(obj.pid) && obj.pid > 0 ? obj.pid : null
  const port =
    typeof obj.port === 'number' && Number.isInteger(obj.port) && obj.port > 0 && obj.port < 65536
      ? obj.port
      : null
  if (pid === null || port === null) return null
  return {
    pid,
    port,
    url: typeof obj.url === 'string' && obj.url ? obj.url : `http://127.0.0.1:${port}`,
    runtimeVersion: typeof obj.runtimeVersion === 'string' ? obj.runtimeVersion : null
  }
}
