/**
 * 远程 WebSocket 协议(纯逻辑:消息形状 + 逐字段校验,可单测)。
 *
 * 一条连接多路复用所有会话 —— 手机切来切去不该反复握手。客户端发的每一个字段都当**不可信输入**:
 * 尺寸夹到与本地终端页同一组范围(2..500 / 2..300),id 必须是正整数,字符串有长度上限。
 *
 * 两种消息:客户端上行(`ClientMessage`)与下行(`HubEvent` 来自 hub + 少量直接回执)。
 * 下行的错一律走 `{t:'error'}` —— 客户端不需要按 HTTP 状态码分支。
 */

import type { SessionInfo } from '../shared'
import type { ChatMessage, AskRequest, ChatStatus } from './piChat'

/** 输入文本的单条上限:按键流很小,超过这个数一定是搞错了 */
export const MAX_INPUT_CHARS = 64 * 1024
/** 手机发一句给 pi 的上限(对话输入,不是按键流) */
export const MAX_PROMPT_CHARS = 32 * 1024
/** read 的尾部上限(与主进程的 replay 上限一致) */
export const MAX_READ_CHARS = 200_000
/** 排队方式:`followUp` = 等这一轮结束再说(默认);`steer` = 现在就插话 */
export type PromptDelivery = 'steer' | 'followUp'
export const PROMPT_DELIVERIES: readonly PromptDelivery[] = ['steer', 'followUp'] as const
export const COLS_RANGE = { min: 2, max: 500 } as const
export const ROWS_RANGE = { min: 2, max: 300 } as const

export type ClientMessage =
  | { t: 'list' }
  | { t: 'attach'; id: number; cols: number; rows: number }
  | { t: 'detach'; id: number }
  | { t: 'input'; id: number; data: string }
  | { t: 'resize'; id: number; cols: number; rows: number }
  | { t: 'read'; id: number; chars?: number }
  | { t: 'create'; command?: string; args?: string[]; cwd?: string; name?: string }
  | { t: 'close'; id: number }
  // ---- 对话(S13):手机不再渲染 xterm,读写都走 pi 的结构化接口 ----
  | { t: 'chat'; id: number }
  | { t: 'prompt'; id: number; text: string; deliverAs?: PromptDelivery }
  | { t: 'abort'; id: number }
  /** 回答 pi 的一个提问(`confirm` 给 boolean,其余给 string) */
  | { t: 'answer'; id: number; requestId: string; value: boolean | string }

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
  /** pi 的状态栏:模型 / 上下文 / 输入输出(手机重连后由 `chat` 快照里的 status 补上) */
  | { t: 'chat-status'; id: number; status: ChatStatus }
  | { t: 'ask'; id: number; ask: AskRequest }
  | { t: 'ask-done'; id: number; requestId: string }
  | { t: 'error'; message: string }

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; error: string }

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, Math.round(n)))
}

function positiveId(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 解析一条上行消息。不是对象 / 未知 `t` / 必填字段坏掉 → `{ok:false}`(调用方回 error 即可) */
export function parseClientMessage(raw: unknown): ParseResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '消息必须是 JSON 对象' }
  const msg = raw as Record<string, unknown>
  const t = typeof msg.t === 'string' ? msg.t : ''

  switch (t) {
    case 'list':
      return { ok: true, message: { t: 'list' } }

    case 'attach':
    case 'resize': {
      const id = positiveId(msg.id)
      if (id === null) return { ok: false, error: 'id 必须是正整数' }
      const cols = clampInt(msg.cols, COLS_RANGE.min, COLS_RANGE.max)
      const rows = clampInt(msg.rows, ROWS_RANGE.min, ROWS_RANGE.max)
      if (cols === null || rows === null) return { ok: false, error: 'cols/rows 必须是数字' }
      return { ok: true, message: { t, id, cols, rows } as ClientMessage }
    }

    case 'detach':
    case 'close': {
      const id = positiveId(msg.id)
      if (id === null) return { ok: false, error: 'id 必须是正整数' }
      return { ok: true, message: { t, id } as ClientMessage }
    }

    case 'input': {
      const id = positiveId(msg.id)
      if (id === null) return { ok: false, error: 'id 必须是正整数' }
      if (typeof msg.data !== 'string') return { ok: false, error: 'data 必须是字符串' }
      if (msg.data.length > MAX_INPUT_CHARS) return { ok: false, error: 'data 太长' }
      return { ok: true, message: { t: 'input', id, data: msg.data } }
    }

    case 'read': {
      const id = positiveId(msg.id)
      if (id === null) return { ok: false, error: 'id 必须是正整数' }
      const chars =
        msg.chars === undefined ? undefined : (clampInt(msg.chars, 1, MAX_READ_CHARS) ?? undefined)
      if (msg.chars !== undefined && chars === undefined) return { ok: false, error: 'chars 必须是数字' }
      return { ok: true, message: { t: 'read', id, ...(chars === undefined ? {} : { chars }) } }
    }

    case 'create': {
      // command 可省略:那就是「开一个默认 shell」—— 手机在空列表时也要能自己开一个
      const command = typeof msg.command === 'string' ? msg.command.trim() : ''
      if (msg.command !== undefined && !command) return { ok: false, error: 'command 不能是空串' }
      const args = Array.isArray(msg.args) ? msg.args.filter((a): a is string => typeof a === 'string') : []
      if (Array.isArray(msg.args) && args.length !== msg.args.length) {
        return { ok: false, error: 'args 必须是字符串数组' }
      }
      const cwd = typeof msg.cwd === 'string' && msg.cwd.trim() ? msg.cwd.trim() : undefined
      const name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : undefined
      return {
        ok: true,
        message: { t: 'create', ...(command ? { command } : {}), args, ...(cwd ? { cwd } : {}), ...(name ? { name } : {}) }
      }
    }

    // ---- 对话 ----
    case 'chat':
    case 'abort': {
      const id = positiveId(msg.id)
      if (id === null) return { ok: false, error: 'id 必须是正整数' }
      return { ok: true, message: { t, id } as ClientMessage }
    }

    case 'prompt': {
      const id = positiveId(msg.id)
      if (id === null) return { ok: false, error: 'id 必须是正整数' }
      const text = typeof msg.text === 'string' ? msg.text : ''
      if (!text.trim()) return { ok: false, error: 'text 不能是空的' }
      if (text.length > MAX_PROMPT_CHARS) return { ok: false, error: 'text 太长' }
      if (msg.deliverAs !== undefined && !PROMPT_DELIVERIES.includes(msg.deliverAs as PromptDelivery)) {
        return { ok: false, error: 'deliverAs 只能是 steer 或 followUp' }
      }
      return {
        ok: true,
        message: {
          t: 'prompt',
          id,
          text,
          ...(msg.deliverAs === undefined ? {} : { deliverAs: msg.deliverAs as PromptDelivery })
        }
      }
    }

    case 'answer': {
      const id = positiveId(msg.id)
      if (id === null) return { ok: false, error: 'id 必须是正整数' }
      const requestId = typeof msg.requestId === 'string' ? msg.requestId.trim() : ''
      if (!requestId || requestId.length > 80) return { ok: false, error: 'requestId 必须是字符串' }
      const value = msg.value
      if (typeof value !== 'boolean' && typeof value !== 'string') {
        return { ok: false, error: 'value 必须是布尔或字符串' }
      }
      if (typeof value === 'string' && value.length > MAX_PROMPT_CHARS) return { ok: false, error: 'value 太长' }
      return { ok: true, message: { t: 'answer', id, requestId, value } }
    }

    default:
      return { ok: false, error: `未知消息类型:${t || '(空)'}` }
  }
}

/**
 * 远程要的那批会话操作。由插件实现(它持有 pty 会话表),server 只管把 WS 消息翻成这些调用。
 *
 * 为什么不让 server 直接拿会话表:传输层不该知道 pty、回放缓冲、进程树这些事;
 * 反过来插件也不该知道 WS 长什么样。两边只共享这个窄接口。
 */
export interface RemoteSessionApi {
  list(): SessionInfo[]
  /**
   * 订阅一个**已存在**的会话(远程 attach 不 spawn —— 那是 `create` 的事)。
   * `cols/rows` 会顺手推给 pty:「最后一个 resize 的客户端胜」是这套方案对多视图的约定。
   */
  attach(
    id: number,
    cols: number,
    rows: number
  ): { ok: boolean; replay?: string; cols?: number; rows?: number; title?: string; error?: string }
  input(id: number, data: string): boolean
  resize(id: number, cols: number, rows: number): boolean
  readTail(id: number, chars?: number): { ok: boolean; text?: string; error?: string }
  /** `command` 省略 = 默认 shell profile(与面板的「新终端」一致) */
  create(input: { command?: string; args?: string[]; cwd?: string; name?: string }): {
    ok: boolean
    id?: number
    state?: 'starting' | 'running'
    error?: string
  }
  /** 结束会话(与面板的 × 同义:连标签一起收) */
  close(id: number): boolean
  /**
   * 这个会话的控制令牌(pty spawn 时随机生成,经环境变量交给 pi 里的扩展)。
   * WS 的 `role=pi` 只认它 —— 于是同机别的进程没法冒充某个会话的控制端。
   */
  controlToken(id: number): string | null
}
