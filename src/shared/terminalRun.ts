/**
 * 内核事件 `terminal:run` 的契约:让**别的插件**请求终端插件「在某个标签里跑一条指定命令」。
 *
 * 为什么用事件而不是插件间直接调用:插件拿不到彼此(内核里没有跨插件的 invoke),而 `ctx.events`
 * 是一条现成的全局总线。发起方(典型:编辑器插件)先自己拿到 tabId —— 用 `ctx.tabs.openInternal`
 * 建一个 `bow://terminal` 标签 —— 再把要跑的命令发过来。
 *
 * 时序不变式(收方依赖它,不要打破):`openInternal()` 返回 → `emit()` → 标签页异步加载 →
 * 页面 `invoke('attach')`。所以 attach **一定**晚于 emit,不需要握手。
 *
 * payload 必须自己校验:事件总线是弱类型的,任何插件都能 emit 任意值。
 */

export const TERMINAL_RUN_EVENT = 'terminal:run'

export interface TerminalRunRequest {
  /** 目标标签(发起方用 `ctx.tabs.openInternal('terminal')` 拿到) */
  tabId: number
  /** 要跑的可执行文件,如 `wsl.exe` / `nvim` */
  file: string
  /** 参数(逐项传给 node-pty,不做 shell 拼接) */
  args: string[]
  /** 工作目录;省略 = 用户主目录 */
  cwd?: string
  /** 标签标题里显示的名字,如 `nvim(a.txt)` */
  name?: string
}

/** 合法就返回规范化后的请求,否则返回 null(调用方只记日志、不抛) */
export function parseTerminalRunRequest(payload: unknown): TerminalRunRequest | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = payload as Record<string, unknown>
  const tabId = Number(raw.tabId)
  if (!Number.isInteger(tabId) || tabId <= 0) return null
  const file = typeof raw.file === 'string' ? raw.file.trim() : ''
  if (!file) return null
  if (!Array.isArray(raw.args)) return null
  if (!raw.args.every((a) => typeof a === 'string')) return null
  const cwd = typeof raw.cwd === 'string' ? raw.cwd.trim() : ''
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  return {
    tabId,
    file,
    args: [...(raw.args as string[])],
    ...(cwd ? { cwd } : {}),
    ...(name ? { name } : {})
  }
}
