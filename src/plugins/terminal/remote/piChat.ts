/**
 * pi 对话桥:把「终端里的 pi」的结构化对话搬到手机,并把手机的话送回 pi。
 *
 * 为什么不用 pty 字节流:`working` 这类 TUI 动画是「光标移动 + 局部重绘」,回放/滚动缓冲里
 * 必然留下每一帧的残渣;而宽度一改,pi 按新宽度重排,旧宽度画的行还在缓冲里 —— 两个几何叠在
 * 一条流里,手机端怎么渲染都是乱的。所以手机读的是 pi 的消息对象,不是屏幕字节。
 *
 * 三块状态:
 * - `pis`:每个会话一条「pi 端」连接(pi 里的扩展连上来的控制通道),会话 id → sink;
 * - `viewers`:手机连接(只读镜像),广播目标是它们;
 * - `chats`:每个会话最近 N 条消息 + 忙/排队数。**缓存放在服务端**:手机切走再切回来、
 *   或重连时不必等 pi 再吐一遍(pi 那边只有一份真值,重连时会自己补发 snapshot)。
 *
 * 慢消费者**跳过这一条而不是断开**:对话消息不像终端字节流,丢一条不会让画面永久错位
 * (下一条会自然覆盖状态,历史还能重新拉)。
 */

export type ChatRole = 'user' | 'assistant' | 'tool' | 'notice'

/**
 * 一条要显示的对话消息。`tool` 行由工具调用与它的结果**两条** pi 消息合成一条 ——
 * 它们共用 `id`(pi 的 `toolCallId`),所以手机端按 id 就地更新即可。
 */
export interface ChatMessage {
  id: string
  role: ChatRole
  text?: string
  toolName?: string
  toolArgs?: string
  toolResult?: string
  toolError?: boolean
}

export interface ChatSnapshot {
  id: number
  /** 有 pi 端连着 = 这个会话能读能写;否则手机上只能看历史 */
  live: boolean
  messages: ChatMessage[]
  busy: boolean
  pending: number
  /** 正在等回答的题(手机重连后要把卡片重新画出来) */
  asks: AskRequest[]
  status?: ChatStatus
}

/**
 * pi 的状态栏数字:模型 / 上下文 / 输入输出 token。
 *
 * 口径与 pi 桌面 footer 一致(`input`/`output` 是**整会话累计**,不含缓存读写;
 * `contextTokens` 是估算值,compact 刚做完时 pi 自己也不知道 → null)。
 * 百分比不在这里算:两端拿同一对 (tokens, contextWindow) 各算一次,省一个要校验的字段。
 */
export interface ChatStatus {
  model?: string
  provider?: string
  /** 思考等级(只在这轮模型支持 reasoning 时才有) */
  thinking?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  contextTokens: number | null
  contextWindow: number
}

/** 每个会话保留的消息条数(手机只显示最近的;再往前的去电脑上看) */
export const MAX_CHAT_MESSAGES = 60
/** 单条正文上限(字符)。pi 的长回答会超,截断比把手机内存打爆好 */
export const MAX_CHAT_TEXT = 4000
/** 工具参数 / 结果上限 */
export const MAX_CHAT_TOOL = 1200
/** viewer 的积压上限:超过就跳过这一条(见文件头) */
export const CHAT_MAX_BUFFERED = 1024 * 1024

/**
 * pi 的一个提问(权限门 / `ask_user_question` / plan 批准……)——手机要能就地点。
 * 与扩展里的 `AskRequest` 同形;`custom()`(自定义组件)不接管,所以没有这个 kind。
 */
export interface AskRequest {
  requestId: string
  kind: 'confirm' | 'select' | 'input' | 'editor'
  title: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  /** pi 自己给的超时(到点它会自己选默认值) */
  timeout?: number
}

export interface ChatSink {
  send(message: unknown): void
  /** 已排队还没发出去的字节(WS 的 `bufferedAmount`) */
  buffered(): number
  /** 服务停机时断开这个连接(可选:单测的假 sink 不需要) */
  drop?(reason: string): void
}

interface ChatState {
  messages: ChatMessage[]
  busy: boolean
  pending: number
  status?: ChatStatus
}

function cap(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 999) : 0
}

/** 上行消息逐字段校验:pi 那头是我们自己的扩展,但仍然是**跨进程输入**,一律不信形状 */
export function sanitizeChatMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const role = m.role
  if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'notice') return null
  const id = cap(m.id, 80)
  if (!id) return null
  const out: ChatMessage = { id: id.trim(), role }
  const text = cap(m.text, MAX_CHAT_TEXT)
  if (text) out.text = text
  const toolName = cap(m.toolName, 60)
  if (toolName) out.toolName = toolName
  const toolArgs = cap(m.toolArgs, MAX_CHAT_TOOL)
  if (toolArgs) out.toolArgs = toolArgs
  const toolResult = cap(m.toolResult, MAX_CHAT_TOOL)
  if (toolResult) out.toolResult = toolResult
  if (m.toolError === true) out.toolError = true
  return out
}

/** 上行状态逐字段校验:数值夹到非负整数,文本截断;没有 contextWindow 也留着(手机只显示 token 数) */
export function sanitizeStatus(raw: unknown): ChatStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const num = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 1_000_000_000) : 0
  }
  const out: ChatStatus = {
    input: num(m.input),
    output: num(m.output),
    cacheRead: num(m.cacheRead),
    cacheWrite: num(m.cacheWrite),
    contextTokens: m.contextTokens === null || m.contextTokens === undefined ? null : num(m.contextTokens),
    contextWindow: num(m.contextWindow)
  }
  const model = cap(m.model, 60)
  if (model) out.model = model.trim()
  const provider = cap(m.provider, 40)
  if (provider) out.provider = provider.trim()
  const thinking = cap(m.thinking, 20)
  if (thinking) out.thinking = thinking.trim()
  return out
}

export class PiChatHub {
  private readonly pis = new Map<number, ChatSink>()
  private readonly viewers = new Set<ChatSink>()
  private readonly chats = new Map<number, ChatState>()
  /** sessionId → (requestId → 题面):只在有人答/pi 自己收掉时才删 */
  private readonly asks = new Map<number, Map<string, AskRequest>>()

  /** 手机连接数(测试/日志用) */
  get viewerCount(): number {
    return this.viewers.size
  }

  /** 当前有控制通道的会话 id */
  piSessions(): number[] {
    return [...this.pis.keys()]
  }

  attachViewer(sink: ChatSink): () => void {
    this.viewers.add(sink)
    return () => {
      this.viewers.delete(sink)
    }
  }

  /** pi 扩展连上来(= 这个会话能读能写);同一个会话重复连接时后来者胜(pi /reload 后的新连接) */
  attachPi(sessionId: number, sink: ChatSink): () => void {
    this.pis.set(sessionId, sink)
    this.broadcast({ t: 'chat-state', id: sessionId, live: true, ...this.stateOf(sessionId) })
    return () => {
      if (this.pis.get(sessionId) !== sink) return
      this.pis.delete(sessionId)
      this.broadcast({ t: 'chat-state', id: sessionId, live: false, ...this.stateOf(sessionId) })
    }
  }

  snapshot(sessionId: number): ChatSnapshot {
    const state = this.stateOf(sessionId)
    return { id: sessionId, live: this.pis.has(sessionId), ...state, asks: [...(this.asks.get(sessionId)?.values() ?? [])] }
  }

  /**
   * pi → 手机:处理扩展发来的三种记录。
   * `snapshot`(连接后回填历史)/ `message`(一条新消息)/ `state`(忙、排队数)。
   */
  fromPi(sessionId: number, raw: unknown): void {
    if (!this.pis.has(sessionId)) return
    if (!raw || typeof raw !== 'object') return
    const msg = raw as Record<string, unknown>
    const chat = this.chats.get(sessionId) ?? { messages: [], busy: false, pending: 0 }

    switch (msg.type) {
      case 'snapshot': {
        const messages = Array.isArray(msg.messages)
          ? msg.messages
              .map((m) => sanitizeChatMessage(m))
              .filter((m): m is ChatMessage => m !== null)
              .slice(-MAX_CHAT_MESSAGES)
          : []
        chat.messages = messages
        chat.busy = msg.busy === true
        chat.pending = count(msg.pending)
        const status = sanitizeStatus(msg.status)
        if (status) chat.status = status
        this.chats.set(sessionId, chat)
        this.broadcast({ t: 'chat', id: sessionId, live: true, ...chat })
        return
      }
      case 'status': {
        const status = sanitizeStatus(msg.status)
        if (!status) return
        chat.status = status
        this.chats.set(sessionId, chat)
        this.broadcast({ t: 'chat-status', id: sessionId, status })
        return
      }
      case 'message': {
        const message = sanitizeChatMessage(msg.message)
        if (!message) return
        // 同一个 (role, id) 就地更新而不是追加:
        // ① 工具调用与它的结果共用 toolCallId → 合并成一行;
        // ② 同一个扩展被加载两次(比如装了一份又用 --extension 加一份)时,两条连接会发同一条消息 → 去重。
        const index = chat.messages.findIndex((m) => m.role === message.role && m.id === message.id)
        if (index >= 0) chat.messages[index] = { ...chat.messages[index], ...message }
        else chat.messages = [...chat.messages, message].slice(-MAX_CHAT_MESSAGES)
        this.chats.set(sessionId, chat)
        this.broadcast({
          t: 'chat-message',
          id: sessionId,
          message: index >= 0 ? chat.messages[index] : message
        })
        return
      }
      case 'state': {
        chat.busy = msg.busy === true
        chat.pending = count(msg.pending)
        this.chats.set(sessionId, chat)
        this.broadcast({ t: 'chat-state', id: sessionId, live: true, busy: chat.busy, pending: chat.pending })
        return
      }
      // ---- 提问:手机要么答、要么等 pi 自己收(终端里还能点) ----
      case 'ask': {
        const ask = sanitizeAsk(msg.ask)
        if (!ask) return
        const bySession = this.asks.get(sessionId) ?? new Map<string, AskRequest>()
        bySession.set(ask.requestId, ask)
        this.asks.set(sessionId, bySession)
        this.broadcast({ t: 'ask', id: sessionId, ask })
        return
      }
      case 'ask-done': {
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
        if (!requestId) return
        this.asks.get(sessionId)?.delete(requestId)
        this.broadcast({ t: 'ask-done', id: sessionId, requestId })
        return
      }
      default:
        return
    }
  }

  /** 手机 → pi。没有控制通道时如实报错(客户端据此显示「重开终端」) */
  prompt(sessionId: number, text: string, deliverAs?: 'steer' | 'followUp'): { ok: boolean; error?: string } {
    const sink = this.pis.get(sessionId)
    if (!sink) return { ok: false, error: '这个会话还没有控制通道(在 bow 里重开终端即可)' }
    try {
      sink.send({ type: 'prompt', text, ...(deliverAs ? { deliverAs } : {}) })
      return { ok: true }
    } catch {
      return { ok: false, error: '发给 pi 失败' }
    }
  }

  abort(sessionId: number): boolean {
    const sink = this.pis.get(sessionId)
    if (!sink) return false
    try {
      sink.send({ type: 'abort' })
      return true
    } catch {
      return false
    }
  }

  /**
   * 手机回答一个提问。**先删后转**:卡片立刻消失,不等 pi 回话;
   * pi 那边答完还会发一条 `ask-done`(幂等)。
   */
  answer(sessionId: number, requestId: string, value: boolean | string): { ok: boolean; error?: string } {
    const sink = this.pis.get(sessionId)
    if (!sink) return { ok: false, error: '这个会话还没有控制通道(在 bow 里重开终端即可)' }
    const ask = this.asks.get(sessionId)?.get(requestId)
    if (!ask) return { ok: false, error: '这个提问已经不在了(可能已在电脑上答过)' }
    if (ask.kind === 'confirm' && typeof value !== 'boolean') return { ok: false, error: '这个提问要的是「是 / 否」' }
    if (ask.kind !== 'confirm' && typeof value !== 'string') return { ok: false, error: '这个提问要的是一个选项或一段文字' }
    try {
      sink.send({ type: 'answer', requestId, value })
    } catch {
      return { ok: false, error: '发给 pi 失败' }
    }
    this.asks.get(sessionId)?.delete(requestId)
    this.broadcast({ t: 'ask-done', id: sessionId, requestId })
    return { ok: true }
  }

  /** 会话被关掉:丢缓存(重新开的会话是新的) */
  forget(sessionId: number): void {
    this.chats.delete(sessionId)
    this.asks.delete(sessionId)
  }

  /** 服务停机:断开所有连接,但**保留缓存** —— 重新启用后手机还能看到上次的对话 */
  clear(reason = '服务已停止'): void {
    for (const sink of [...this.viewers]) {
      this.viewers.delete(sink)
      closeQuietly(sink, reason)
    }
    for (const sink of [...this.pis.values()]) closeQuietly(sink, reason)
    this.pis.clear()
  }

  private stateOf(sessionId: number): ChatState {
    const state = this.chats.get(sessionId)
    return state ?? { messages: [], busy: false, pending: 0 }
  }

  /**
   * 广播给手机。遍历快照,所以 send 里再订阅/退订不会打乱这次遍历;
   * 单个 sink 出错只踢它自己。
   */
  private broadcast(message: unknown): void {
    for (const sink of [...this.viewers]) {
      try {
        if (sink.buffered() > CHAT_MAX_BUFFERED) continue
        sink.send(message)
      } catch {
        this.viewers.delete(sink)
      }
    }
  }
}

function closeQuietly(sink: ChatSink, reason: string): void {
  try {
    sink.drop?.(reason)
  } catch {
    /* 已经断了 */
  }
}

/** 上行提问逐字段校验(跨进程输入一律不信形状) */
export function sanitizeAsk(raw: unknown): AskRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const requestId = cap(m.requestId, 80)
  const title = cap(m.title, 300)
  if (!requestId || !title) return null
  const kind = m.kind
  if (kind !== 'confirm' && kind !== 'select' && kind !== 'input' && kind !== 'editor') return null
  const out: AskRequest = { requestId: requestId.trim(), kind, title: title.trim() }
  const message = cap(m.message, 2000)
  if (message) out.message = message
  if (Array.isArray(m.options)) {
    out.options = m.options
      .map((option) => cap(option, 200))
      .filter((option): option is string => option !== undefined)
      .slice(0, 20)
  }
  const placeholder = cap(m.placeholder, 200)
  if (placeholder) out.placeholder = placeholder
  const prefill = cap(m.prefill, 4000)
  if (prefill) out.prefill = prefill
  const timeout = count(m.timeout)
  if (timeout) out.timeout = timeout
  return out
}
