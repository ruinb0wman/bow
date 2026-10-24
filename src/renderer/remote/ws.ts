/**
 * 远程 WS 客户端:与主进程的 `remote/protocol.ts` 同一套消息。
 *
 * 断线重连是必须的(手机锁屏、切后台、WiFi 抖动):指数退避,封顶 5s;重连成功后由 App 重新
 * 拉一次对话快照 —— 服务端有缓存,所以不用手机自己存历史。
 */

export interface SessionAgentState {
  state: 'working' | 'blocked' | 'idle'
  done?: boolean
  title?: string
  text?: string
  at: number
}

export interface SessionInfo {
  id: number
  title: string
  profileId: string
  cwd: string
  pid: number
  cols: number
  rows: number
  createdAt: number
  lastOutputAt: number | null
  agent: SessionAgentState | null
}

export type ServerMessage =
  | { t: 'hello'; service: string; sessions: SessionInfo[] }
  | { t: 'sessions'; sessions: SessionInfo[] }
  | { t: 'attached'; id: number; replay: string; cols: number; rows: number; title: string }
  | { t: 'data'; id: number; chunk: string }
  | { t: 'exit'; id: number; code: number }
  | { t: 'closed'; id: number; reason: string }
  | { t: 'read'; id: number; text: string }
  | { t: 'created'; id: number; state: 'starting' | 'running' }
  | { t: 'chat'; id: number; live: boolean; messages: ChatMessage[]; busy: boolean; pending: number; asks: AskRequest[]; status?: ChatStatus }
  | { t: 'chat-message'; id: number; message: ChatMessage }
  | { t: 'chat-state'; id: number; live: boolean; busy: boolean; pending: number }
  | { t: 'chat-status'; id: number; status: ChatStatus }
  | { t: 'ask'; id: number; ask: AskRequest }
  | { t: 'ask-done'; id: number; requestId: string }
  | { t: 'error'; message: string }

/** 一条要显示的对话行(与主进程 `remote/piChat.ts` 的 `ChatMessage` 同形) */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'notice'
  text?: string
  toolName?: string
  toolArgs?: string
  toolResult?: string
  toolError?: boolean
}

/** pi 的状态栏数字(与主进程 `remote/piChat.ts` 的 `ChatStatus` 同形;百分比两端各算一次) */
export interface ChatStatus {
  model?: string
  provider?: string
  thinking?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  contextTokens: number | null
  contextWindow: number
}

/** pi 的一个提问(与主进程的 `AskRequest` 同形) */
export interface AskRequest {
  requestId: string
  kind: 'confirm' | 'select' | 'input' | 'editor'
  title: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  timeout?: number
}

export type ClientMessage =
  | { t: 'list' }
  | { t: 'attach'; id: number; cols: number; rows: number }
  | { t: 'input'; id: number; data: string }
  | { t: 'resize'; id: number; cols: number; rows: number }
  | { t: 'create'; command?: string; args?: string[]; cwd?: string; name?: string }
  | { t: 'close'; id: number }
  | { t: 'chat'; id: number }
  | { t: 'prompt'; id: number; text: string; deliverAs?: 'steer' | 'followUp' }
  | { t: 'abort'; id: number }
  | { t: 'answer'; id: number; requestId: string; value: boolean | string }

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'refused'

export interface RemoteSocket {
  send(msg: ClientMessage): void
  close(): void
  readonly state: ConnectionState
}

/** WS 地址按当前页面同源拼(手机是通过 http://192.168.x.x:port 打开的) */
export function wsUrlOf(location: Location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/ws`
}

export function connectRemote(
  url: string,
  handlers: {
    onMessage(msg: ServerMessage): void
    onState(state: ConnectionState): void
  }
): RemoteSocket {
  let socket: WebSocket | null = null
  let closedByUs = false
  let retry = 0
  let timer: number | undefined
  let state: ConnectionState = 'connecting'

  const setState = (next: ConnectionState): void => {
    if (state === next) return
    state = next
    handlers.onState(next)
  }

  const open = (): void => {
    setState('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      setState('refused')
      return
    }
    socket = ws
    ws.onopen = () => {
      retry = 0
      setState('open')
    }
    ws.onmessage = (event) => {
      try {
        handlers.onMessage(JSON.parse(String(event.data)))
      } catch {
        /* 坏帧忽略:服务端的 error 消息会说明问题 */
      }
    }
    ws.onclose = () => {
      socket = null
      if (closedByUs) {
        setState('closed')
        return
      }
      // 握手被拒(鉴权失败)也是 close,但重连没有意义:交给 App 判断要不要回登录页
      setState('refused')
      const delay = Math.min(500 * 2 ** retry, 5000)
      retry += 1
      timer = window.setTimeout(open, delay)
    }
    ws.onerror = () => {
      /* 交给 onclose 处理 */
    }
  }

  open()

  return {
    send(msg) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
    },
    close() {
      closedByUs = true
      if (timer !== undefined) window.clearTimeout(timer)
      socket?.close()
    },
    get state() {
      return state
    }
  }
}
