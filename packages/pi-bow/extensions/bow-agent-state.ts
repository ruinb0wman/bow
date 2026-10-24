/**
 * bow 终端状态桥(pi 扩展)
 *
 * managed by bow; reinstall overwrites this file(由 `scripts/install-pi-agent-state.mjs` 写入,
 * 请把自定义改动放到**别的**扩展文件里 —— 这行标记也是安装脚本用来判断「这文件是不是 bow 装的」的依据)。
 *
 * 作用:把 pi 的三态写成一条自定义 OSC 控制序列,bow 的终端插件在 pty 输出里把它剥出来,
 * 于是终端标签能显示「正在执行」角标,并在**需要用户确认** / **任务完成**时弹出系统通知
 * (点通知进入对应标签)。协议与解析见 bow 仓库的 `src/shared/agentState.ts`。
 *
 * 序列形状:
 *   ESC ] 1337 ; bow ; {"v":1,"state":"blocked","title":"…","text":"…"} BEL
 * 1337 是第三方终端集成常用的私有区间;别的终端对不认识的键一律忽略,所以即使在别的终端里
 * 被放出来也无害 —— 何况这里用 `BOW_TERMINAL` 做了门禁(见下)。
 *
 * 为什么不解析 TUI 文本:pi 自己就有这些事件(`agent_start` / `agent_settled` /
 * `ui_prompt_start` / `ui_prompt_end`,后者自 pi 0.84.4 起提供),不需要猜屏幕内容。
 * 为什么用 `agent_settled` 而不是 `agent_end`:`agent_end` 之后 pi 可能还会重试、压缩或续跑排队的消息,
 * 只有 `agent_settled` 表示「这一轮彻底结束了」。
 *
 * 装法(三种,选一个):
 *   ① 整包:`pi install <bow 仓库>/packages/pi-bow`(推荐,同一个包里还有 MCP 自动注册与 `/bow` 命令);
 *   ② 单文件:bow 设置页 → 终端 → 「Pi 状态联动」的安装按钮(离线可用);
 *   ③ 命令行:`node scripts/install-pi-agent-state.mjs`(幂等,可 --uninstall)。
 * 手动试用:`pi --extension <此文件的绝对路径>`。
 *
 * ⚠️ **本文件必须自包含**:它会被单独复制到 `~/.pi/agent/extensions/`,所以只能 import
 *    `node:` 内建与 pi 的类型(`import type`),不能 import 包内其它文件 —— 复制过去之后相对路径会找不到。
 * ⚠️ 本文件由 bow 安装脚本管理:重装会覆盖它,请把自定义改动放到别的文件里。
 * ⚠️ 需要 pi ≥ 0.84.4(`ui_prompt_start` / `ui_prompt_end` 引入的版本);更老的 pi 上只是少了
 *    「需要确认」那一档,不会报错(未知事件名的注册永远不触发)。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

/** 必须与 bow 侧 `BOW_OSC_PREFIX`(`src/shared/agentState.ts`)逐字一致;字面量而不是 import,见上面的「自包含」 */
const OSC_PREFIX = '\x1b]1337;bow;'
const BEL = '\x07'
const SIGNAL_VERSION = 1

/** bow 的终端插件给 pty 注入的门禁(见 bow 的 `cleanEnv`);其它终端里这个扩展什么都不做 */
const IN_BOW = process.env.BOW_TERMINAL === '1'

/**
 * 对话桥的接头暗号(同一个门禁里再细分):会话 id + 服务地址 + 本会话的控制令牌。
 * 三个都齐才开通道 —— 老版本的 bow 只注入 `BOW_TERMINAL`,那时这里静默不做事。
 */
const CHAT_SESSION_ID = Number(process.env.BOW_SESSION_ID ?? '')
const CHAT_URL = process.env.BOW_REMOTE_URL ?? ''
const CHAT_TOKEN = process.env.BOW_CONTROL_TOKEN ?? ''

/** 对话消息:与 bow 侧 `remote/piChat.ts` 的 `ChatMessage` 同形(自包含,不 import) */
interface ChatMsg {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'notice'
  text?: string
  toolName?: string
  toolArgs?: string
  toolResult?: string
  toolError?: boolean
}

/** pi 的消息形状(只用到这里列出的字段;pi 的消息类型比这多得多) */
interface PiPart {
  type?: string
  text?: string
  id?: string
  name?: string
  arguments?: unknown
}
interface PiMessage {
  role?: string
  content?: string | PiPart[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  timestamp?: number
}

type State = 'working' | 'blocked' | 'idle'

interface Payload {
  v: number
  state: State
  done?: boolean
  agent?: string
  title?: string
  text?: string
}

export default function (pi: ExtensionAPI) {
  if (!IN_BOW) return

  /** 只有顶层会话上报:子代理跑在独立进程里、输出也不进这个 pty,但双重保险不嫌多 */
  let root = false
  /** agent 正在跑 */
  let active = false
  /** 这一轮真的开跑过(`agent_settled` 时区分「完成」与「本来就没跑」) */
  let activeRun = false
  /** `ctx.ui.*` 对话框的嵌套深度(select 里再弹 confirm 是两层) */
  let promptDepth = 0
  let promptTitle: string | undefined
  /** 去重键:同一状态不重复喊(心跳式输出会白白惊动 bow 的标签栏) */
  let lastKey = ''

  /** 会话标签:有名字用名字,否则用 cwd 的目录名(`π - bow - /path/to/repo`) */
  function sessionLabel(): string {
    let name: string | undefined
    try {
      name = (pi as unknown as { getSessionName?: () => string | undefined }).getSessionName?.()
    } catch {
      name = undefined
    }
    const dir = basename(process.cwd()) || process.cwd()
    return name ? `π - ${name} - ${dir}` : `π - ${dir}`
  }

  function emit(state: State, done = false, title?: string, text?: string): void {
    const key = [state, done ? 1 : 0, title ?? '', text ?? ''].join('|')
    if (key === lastKey) return
    lastKey = key
    const payload: Payload = { v: SIGNAL_VERSION, state, agent: 'pi' }
    if (done) payload.done = true
    if (title) payload.title = title
    if (text) payload.text = text
    // 只写一条零宽 OSC:与 pi 自己的 TUI 渲染同线程串行,不会撕裂在某一帧中间
    // (pi 自己的 `9;4` 进度序列就是这么写的)。JSON.stringify 保证串里不会出现裸 BEL / ESC。
    process.stdout.write(`${OSC_PREFIX}${JSON.stringify(payload)}${BEL}`)
  }

  /** 由当前记账推出该报哪一态 */
  function publish(done = false): void {
    const label = sessionLabel()
    if (promptDepth > 0) emit('blocked', false, promptTitle, label)
    else if (active) emit('working', false, undefined, label)
    else emit('idle', done, undefined, label)
  }

  pi.on('session_start', (_event, ctx) => {
    // 只有交互式 TUI 有 pty;RPC / JSON / print 模式没有「终端标签」可显示
    if (ctx?.mode !== 'tui') return
    root = true
    active = typeof ctx.isIdle === 'function' ? ctx.isIdle() === false : false
    // reload 会替换扩展运行时:若此刻 agent 正在跑,reload 不会再发 agent_start
    activeRun = active
    publish()
  })

  pi.on('agent_start', () => {
    if (!root) return
    active = true
    activeRun = true
    publish()
  })

  pi.on('agent_settled', (_event, ctx) => {
    if (!root) return
    if (typeof ctx?.isIdle === 'function' && ctx.isIdle() !== true) return
    const done = activeRun
    active = false
    activeRun = false
    publish(done)
  })

  pi.on('ui_prompt_start', (event) => {
    if (!root) return
    promptDepth += 1
    promptTitle = typeof event?.title === 'string' ? event.title : undefined
    publish()
  })

  pi.on('ui_prompt_end', () => {
    if (!root) return
    promptDepth = Math.max(0, promptDepth - 1)
    if (promptDepth === 0) promptTitle = undefined
    publish()
  })

  // 压缩 / 切分支之后,服务端缓存的那份就是旧的了 —— 重发一份快照让手机跟上
  pi.on('session_compact', () => {
    snapshot()
  })
  pi.on('session_tree', () => {
    snapshot()
  })

  pi.on('session_shutdown', () => {
    if (!root) return
    emit('idle')
  })

  // 兜底:被 Ctrl+C / 异常路径带走时也别让 bow 的角标永远停在「正在执行」。
  // pty 上的小写入是同步的(`process.stdout` 指向 tty 时 Node 用同步写),exit 钩子里写得出去。
  process.on('exit', () => emit('idle'))

  startChatBridge(pi)
}

// --------------------------------------------------------------------------------------------
// 对话桥(手机端不用 xterm 了:读的是 pi 的消息对象,不是终端字节)
// --------------------------------------------------------------------------------------------

interface WsLike {
  readyState: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}
type WsCtor = new (url: string) => WsLike

/** 会话上下文里这里用到的部分(不 import 类型,保持自包含) */
interface ChatCtx {
  abort?: () => void
  hasPendingMessages?: () => boolean
  sessionManager?: { buildContextEntries?: () => Array<{ type?: string; message?: PiMessage }> }
  /** pi 的对话框接口(`select` / `confirm` / `input` / `editor`);下面会包一层 */
  ui?: Record<string, unknown>
}

/** 手机上的题面(与 bow 侧 `remote/piChat.ts` 的 `AskRequest` 同形) */
interface AskRequest {
  requestId: string
  kind: 'confirm' | 'select' | 'input' | 'editor'
  title: string
  message?: string
  options?: string[]
  placeholder?: string
  prefill?: string
  timeout?: number
}

function textOf(content: string | PiPart[] | undefined): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim()
}

function safeJson(value: unknown, max = 1200): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  } catch {
    text = String(value)
  }
  if (typeof text !== 'string') text = ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * pi 的一条消息 → 手机上的若干行。
 * 工具调用与它的结果共用 `toolCallId` 作 id,bow 侧会合并成一行(一次调用只占一行)。
 */
function chatMessages(message: PiMessage | undefined): ChatMsg[] {
  if (!message) return []
  const ts = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
  const base = `${ts}-${Math.random().toString(36).slice(2, 8)}`
  if (message.role === 'user') {
    const text = textOf(message.content)
    return text ? [{ id: base, role: 'user', text }] : []
  }
  if (message.role === 'assistant') {
    const out: ChatMsg[] = []
    const text = textOf(message.content)
    if (text) out.push({ id: base, role: 'assistant', text })
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type !== 'toolCall') continue
      out.push({
        id: typeof part.id === 'string' && part.id ? part.id : `${base}-${out.length}`,
        role: 'tool',
        ...(part.name ? { toolName: part.name } : {}),
        ...(part.arguments === undefined ? {} : { toolArgs: safeJson(part.arguments) })
      })
    }
    return out
  }
  if (message.role === 'toolResult') {
    const result = textOf(message.content)
    return [
      {
        id: message.toolCallId || base,
        role: 'tool',
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(result ? { toolResult: result } : {}),
        ...(message.isError ? { toolError: true } : {})
      }
    ]
  }
  return []
}

/** WSL2 里 bow(Windows 侧)的回环地址是发行版自己的回环 —— 要走默认网关的 IP */
function wslGateway(): string | null {
  try {
    if (!/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return null
    for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 3 || cols[1] !== '00000000') continue
      const hex = cols[2]
      if (!/^[0-9a-fA-F]{8}$/.test(hex)) continue
      return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.')
    }
  } catch {
    /* 不是 Linux / 读不到路由表 */
  }
  return null
}

function chatUrls(): string[] {
  if (!CHAT_URL) return []
  const url = `${CHAT_URL}${CHAT_URL.includes('?') ? '&' : '?'}role=pi&session=${CHAT_SESSION_ID}&token=${encodeURIComponent(
    CHAT_TOKEN
  )}`
  const out = [url]
  const gateway = wslGateway()
  if (gateway) {
    try {
      const parsed = new URL(url)
      if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
        parsed.hostname = gateway
        out.push(parsed.toString())
      }
    } catch {
      /* URL 坏就算了 */
    }
  }
  return out
}

/**
 * 对话桥:与 bow 的远程服务维持一条 WS,把 pi 的消息推过去,把手机的话收进来。
 *
 * 为什么不自己写队列:pi 自己的 `sendUserMessage(text, { deliverAs })` 就是队列 ——
 * `followUp` 排在这一轮之后,`steer` 立刻插话。这里只负责「忙的时候别忘了带参数」
 * (不带 `deliverAs` 在 streaming 中会直接抛错)。
 */
function startChatBridge(pi: ExtensionAPI): void {
  if (!IN_BOW) return
  if (!Number.isInteger(CHAT_SESSION_ID) || CHAT_SESSION_ID <= 0) return
  const Ctor = (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket
  if (!Ctor || !CHAT_URL || !CHAT_TOKEN) return

  const urls = chatUrls()
  if (!urls.length) return

  let socket: WsLike | null = null
  let stopped = false
  let retry = 0
  let attempt = 0
  let timer: NodeJS.Timeout | null = null
  let busy = false
  let ctx: ChatCtx | null = null

  const send = (payload: unknown): void => {
    if (!socket || socket.readyState !== 1) return
    try {
      socket.send(JSON.stringify(payload))
    } catch {
      /* 断线由 onclose 处理 */
    }
  }

  /** `hasPendingMessages()` 只有布尔值:这里当「有没有排队」的标记用(手机上显示「有排队」) */
  const pending = (): number => {
    try {
      return ctx?.hasPendingMessages?.() ? 1 : 0
    } catch {
      return 0
    }
  }

  const state = (): void => send({ type: 'state', busy, pending: pending() })
  const stateSoon = (): void => {
    const t = setTimeout(state, 60)
    t.unref?.()
  }

  /** 手机正在等回答的题:requestId → resolve(手机返回的值) */
  const pendingAsks = new Map<string, (value: unknown) => void>()
  /**
   * 已经包过的 `ctx.ui`。
   * ⚠️ 不能用「对象身份」去重:pi 每次给的 `ctx`(连带 `ui`)可能是**新对象**,
   * 那样会反复包装形成链条 —— 实测表现是**一次提问出现两条** `extension_ui_request`,
   * 结果也变得随机。所以改为在**包装函数自己身上**打标记,看到标记就不再包。
   */
  const wrappedMark = Symbol.for('bow.chat.uiWrapped')

  const askId = (): string => `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  const limit = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string' || !value) return undefined
    return value.length > max ? `${value.slice(0, max)}…` : value
  }

  /**
   * 接管 pi 的对话框。关键:**原始方法照旧调** —— 终端里那条路一点不变;
   * 同时把题面发到手机,谁先答要谁。手机先答就用 `opts.signal` 把终端的框程序化关掉
   * (`ExtensionUIDialogOptions.signal` 的语义就是「程序化 dismiss」);
   * 关不掉(editor 没有 opts)也不影响结果 —— 那个框晚一点被点掉而已。
   */
  function wrapDialogs(context: ChatCtx): void {
    const ui = context.ui
    if (!ui || typeof ui !== 'object') return

    /**
     * 自定义组件(`ctx.ui.custom`)没法搬到手机上 —— 它是任意 TUI 组件。
     * 但**支持 RPC 回退的扩展**(典型:`ask_user_question`)在 `custom()` 返回 `undefined` 时
     * 会改用 `select` / `input` 逐个问,而那两个我们能接管。
     * 所以 bow 里默认让 `custom()` 返回 `undefined`(手机上因此能答),代价是终端里不再渲染那种
     * 自定义浮层;想保留浮层就设 `BOW_PI_CUSTOM_UI=native`。
     */
    const customNative = process.env.BOW_PI_CUSTOM_UI === 'native'
    if (!customNative && typeof ui.custom === 'function') {
      const patched = ui.custom as unknown as Record<symbol, unknown>
      if (!patched[wrappedMark]) {
        const fallback = (async (): Promise<undefined> => undefined) as unknown as Record<symbol, unknown> & (() => Promise<undefined>)
        fallback[wrappedMark] = true
        ui.custom = fallback
      }
    }

    for (const kind of ['confirm', 'select', 'input', 'editor'] as const) {
      const original = ui[kind]
      if (typeof original !== 'function') continue
      if ((original as unknown as Record<symbol, unknown>)[wrappedMark]) continue
      const wrapped = async (...args: unknown[]): Promise<unknown> => {
        const requestId = askId()
        const controller = new AbortController()
        // editor(title, prefill) 没有第三个参数,也就没有 signal 能用来关掉终端的框
        const given = kind === 'editor' ? undefined : (args[2] as { signal?: AbortSignal; timeout?: number } | undefined)
        if (given?.signal) {
          if (given.signal.aborted) controller.abort()
          else given.signal.addEventListener('abort', () => controller.abort(), { once: true })
        }
        const ask: AskRequest = {
          requestId,
          kind,
          title: limit(args[0], 300) ?? kind,
          ...(kind === 'confirm' ? { message: limit(args[1], 2000) ?? '' } : {}),
          ...(kind === 'select' && Array.isArray(args[1])
            ? { options: (args[1] as unknown[]).map((option) => limit(option, 200) ?? '').slice(0, 20) }
            : {}),
          ...(kind === 'input' ? { placeholder: limit(args[1], 200) ?? '' } : {}),
          ...(kind === 'editor' ? { prefill: limit(args[1], 4000) ?? '' } : {}),
          ...(given?.timeout ? { timeout: given.timeout } : {})
        }
        send({ type: 'ask', ask })

        const fromPhone = new Promise<{ from: 'phone'; value: unknown }>((resolve) => {
          pendingAsks.set(requestId, (value) => resolve({ from: 'phone', value }))
        })
        const patched =
          kind === 'editor' ? args : [...args.slice(0, 2), { ...(given ?? {}), signal: controller.signal }]
        const fromTerminal = (original as (...a: unknown[]) => Promise<unknown>)
          .apply(ui, patched)
          .then((value) => ({ from: 'terminal' as const, value }))
          .catch(() => ({ from: 'terminal' as const, value: undefined }))

        const first = await Promise.race([fromPhone, fromTerminal])
        pendingAsks.delete(requestId)
        if (first.from === 'phone') {
          try {
            controller.abort()
          } catch {
            /* 已经结束了 */
          }
        }
        send({ type: 'ask-done', requestId })
        return first.value
      }
      ;(wrapped as unknown as Record<symbol, unknown>)[wrappedMark] = true
      ui[kind] = wrapped
    }
  }

  const snapshot = (): void => {
    const messages: ChatMsg[] = []
    try {
      for (const entry of ctx?.sessionManager?.buildContextEntries?.() ?? []) {
        if (entry?.type !== 'message') continue
        for (const message of chatMessages(entry.message)) messages.push(message)
      }
    } catch {
      /* 拿不到历史就只发状态 */
    }
    send({ type: 'snapshot', messages: messages.slice(-60), busy, pending: pending() })
  }

  const onDown = (raw: string): void => {
    let msg: { type?: string; text?: unknown; deliverAs?: unknown; requestId?: unknown; value?: unknown } | null = null
    try {
      msg = JSON.parse(raw) as typeof msg
    } catch {
      return
    }
    if (!msg || typeof msg.type !== 'string') return
    if (msg.type === 'history') {
      snapshot()
      return
    }
    // 手机答了某个题:resolve 给等着的那一层(原始的终端对话框由 controller.abort 收掉)
    if (msg.type === 'answer' && typeof msg.requestId === 'string') {
      const resolve = pendingAsks.get(msg.requestId)
      if (resolve) resolve(msg.value)
      return
    }
    if (msg.type === 'abort') {
      try {
        ctx?.abort?.()
      } catch {
        /* 没在跑 */
      }
      stateSoon()
      return
    }
    if (msg.type === 'prompt' && typeof msg.text === 'string' && msg.text.trim()) {
      const deliverAs = msg.deliverAs === 'steer' || msg.deliverAs === 'followUp' ? msg.deliverAs : undefined
      try {
        // streaming 中不带 deliverAs 会抛错 —— 所以忙的时候一律当「排队」
        if (deliverAs) pi.sendUserMessage(msg.text, { deliverAs })
        else if (busy) pi.sendUserMessage(msg.text, { deliverAs: 'followUp' })
        else pi.sendUserMessage(msg.text)
      } catch (err) {
        send({
          type: 'message',
          message: {
            id: `err-${Date.now()}`,
            role: 'notice',
            text: `发送失败:${err instanceof Error ? err.message : String(err)}`
          }
        })
      }
      stateSoon()
    }
  }

  const schedule = (): void => {
    if (stopped || timer) return
    const delay = Math.min(3000 * 2 ** Math.min(retry, 3), 30_000)
    retry += 1
    attempt += 1
    timer = setTimeout(() => {
      timer = null
      connect()
    }, delay)
    timer.unref?.()
  }

  function connect(): void {
    if (stopped) return
    const url = urls[attempt % urls.length]
    let sock: WsLike
    try {
      sock = new Ctor!(url)
    } catch {
      schedule()
      return
    }
    socket = sock
    sock.onopen = () => {
      retry = 0
      snapshot()
    }
    sock.onmessage = (event) => onDown(String(event.data))
    sock.onclose = () => {
      if (socket === sock) socket = null
      schedule()
    }
    sock.onerror = () => {
      /* 交给 onclose */
    }
  }

  pi.on('session_start', (_event, eventCtx) => {
    ctx = eventCtx as unknown as ChatCtx
    wrapDialogs(ctx)
    stateSoon()
  })
  pi.on('agent_start', (_event, eventCtx) => {
    ctx = eventCtx as unknown as ChatCtx
    wrapDialogs(ctx)
    busy = true
    state()
  })
  pi.on('agent_settled', (_event, eventCtx) => {
    ctx = eventCtx as unknown as ChatCtx
    wrapDialogs(ctx)
    busy = false
    state()
  })
  pi.on('message_end', (event, eventCtx) => {
    // 顺手把可能新出现的 ui 对象也包上(pi 每次给的 ctx 可能是新对象)
    if (eventCtx) wrapDialogs(eventCtx as unknown as ChatCtx)
    const messages = chatMessages((event as { message?: PiMessage }).message)
    for (const message of messages) send({ type: 'message', message })
  })
  pi.on('session_shutdown', () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    // 还挂着没人答的题:直接放掉(终端那条路会自己收)
    pendingAsks.clear()
    try {
      socket?.close()
    } catch {
      /* 已经断了 */
    }
    socket = null
  })

  connect()
}
