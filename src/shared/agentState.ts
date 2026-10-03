/**
 * 「终端里的编码代理(pi)状态」的纯逻辑:**信号解析 + 角标 + 底部居中通知栈的归约**。
 *
 * 三段职责(都在这一份里,因为它们共享同一套类型,且都无 electron / DOM / node 依赖,可直接单测):
 *
 * 1. **信号解析**(`OscSignalParser`):终端里的 pi 把状态写成一条自定义 OSC 控制序列
 *    (`ESC]1337;bow;<JSON>BEL`,协议见下),经由 pty 与它的 TUI 输出混在同一条流里到主进程。
 *    解析器把这条流**边收边剥**:剥出来的文本交回给终端页(xterm 不该看见我们的私有序列),
 *    信号交给终端插件算状态。chunk 边界任意(pty 一读一段),所以它带保留缓冲。
 * 2. **降级信号**:pi 自己有一份内建的进度序列(`ESC]9;4;3` 活动 / `ESC]9;4;0` 清除,受 pi 的
 *    `terminal.showTerminalProgress` 控制,默认关)。不装桥接扩展时靠它至少能显示「正在执行」。
 *    **一旦某个会话见过一次 `1337;bow`,就再也不用 9;4** —— 否则桥接说的 `blocked` 会被它盖成 `working`。
 * 3. **角标与通知栈**:状态 → 标签角标 / 通知条目的**纯归约**(定时器与视图都在主进程那一侧)。
 *
 * 为什么用 OSC 而不是 socket / 状态文件:pty 与状态天然是一对一(会话就是 tabId,见终端插件的
 * 「会话按 tabId 绑定」),不引入端口 / 发现 / 清理,也不需要 bow 在别的终端里也认识这套序列
 * (pi 侧用 `BOW_TERMINAL=1` 门禁,其它终端根本收不到)。pi 自己也用同样的办法写 OSC 9;4。
 *
 * 协议(v1):
 * ```text
 * ESC ] 1337 ; bow ; {"v":1,"state":"blocked","done":false,"agent":"pi","title":"…","text":"…"} BEL
 * ```
 * - 用 JSON 而不是 `;` 分隔:`JSON.stringify` 保证串里不会出现裸 `BEL`(0x07)或 `ESC`(0x1b),
 *   所以「扫到第一个 BEL / ST 就结束」是无歧义的,中文、引号、分号都不用转义;
 * - 负载里**不带 tabId**:权威身份是「信号从哪个 pty 会话进来」,带 id 会变成第二个真相源;
 * - `idle` 与「跑完了」分开:`agent_settled` 与「session 起来了但没干活」都是 idle,
 *   用 `done: true` 区分「完成」与「没跑过」,规则只有一条。
 *
 * 单测在 `tests/agentState.test.ts`。
 */

// ---------- 协议常量 ----------

/**
 * OSC 的私有编号。1337 是 iTerm2 给第三方集成留的私有区间(VS Code 的 shell integration 也用 1337/633),
 * 别的终端对不认识的 `1337;<key>` 一律忽略 —— 所以这套序列即使在别的终端里被放出来也无害。
 */
export const BOW_OSC_CODE = 1337
export const BOW_OSC_KEY = 'bow'
/** 负载版本;不认识的版本整条丢弃(新 pi + 老 bow 不能互相弄坏) */
export const BOW_SIGNAL_VERSION = 1

/** `ESC ] 1337 ; bow ;` */
export const BOW_OSC_PREFIX = `\x1b]${BOW_OSC_CODE};${BOW_OSC_KEY};`

/** 终止符:字符串形式是 BEL(`\x07`),ST(`ESC \`)也认(规范上二者等价) */
const BEL = '\x07'
const ESC = '\x1b'

/** pi 内建进度序列的选择子(降级信号用)。`9;4;0` = 清除,其余(1/2/3/4…)都算「活动」 */
const PROGRESS_SELECTOR = '9;4;'

/** 一条 OSC 没结束时的保留上限:超过就当坏流放行,避免内存被一段永远不结束的流吃掉 */
const MAX_OSC_LENGTH = 4096

// ---------- 类型 ----------

/** 代理的三态:在跑 / 等用户 / 闲着 */
export type AgentState = 'working' | 'blocked' | 'idle'

/** 标签角标:`done` 是「刚刚跑完」的短时状态(过期后清掉) */
export type AgentBadge = 'working' | 'blocked' | 'done'

/** 桥接扩展发出来的一条信号(解析后的形状) */
export interface AgentSignal {
  v: number
  state: AgentState
  /** 仅随 `state: "idle"` 出现:这一轮**跑完了**(区别于「本来就没跑」) */
  done?: boolean
  /** 代理名,默认 `pi`;只用于通知标题 */
  agent?: string
  /** 对话框标题(blocked)或会话名 */
  title?: string
  /** 副标题(如 `π - bow - /path/to/cwd`) */
  text?: string
}

/** 降级进度信号(pi 内建 OSC 9;4) */
export type OscProgressHint = 'active' | 'clear'

export interface OscParseResult {
  /** 剥掉本协议序列之后、可以原样交给 xterm 的文本 */
  text: string
  /** 本 chunk 里解析出的信号(按出现顺序) */
  signals: AgentSignal[]
  /** 本 chunk 里看到的内建进度信号(多个时取最后一个);从未见到为 null */
  progress: OscProgressHint | null
}

/** 主进程 → 通知视图的一条通知 */
export interface AgentToastItem {
  id: string
  tabId: number
  kind: 'blocked' | 'done'
  /** 代理名(标题用) */
  agent: string
  /** 主标题(bow 自己组装,如「pi 等待确认」) */
  title: string
  /** 副标题(对话框标题 / 会话名 / cwd 标签) */
  text?: string
  /** 入栈时间(epoch ms) */
  at: number
}

/** `done` 角标的存活时长;到点由主进程清掉(避免遗留一个「已完成」钉子) */
export const AGENT_DONE_BADGE_MS = 10_000
/** `done` 通知的自动关闭时长(`blocked` 不自动关:它就是要等你看) */
export const AGENT_DONE_TOAST_MS = 8_000
/** 通知栈上限(超出丢最旧的) */
export const MAX_AGENT_TOASTS = 4

const AGENT_STATES: readonly AgentState[] = ['working', 'blocked', 'idle']

function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value)
}

// ---------- ① 信号解析 ----------

/**
 * 把任意 JSON 输入夹成合法信号;不合法返回 null(坏负载整条丢弃,绝不抛)。
 *
 * 判据刻意宽松:只要求 `v === 1` 与 `state` 合法,其余字段尽力而为 ——
 * 这样 pi 侧将来加字段不会让老 bow 整条丢掉状态。
 */
export function normalizeAgentSignal(input: unknown): AgentSignal | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  if (raw.v !== BOW_SIGNAL_VERSION) return null
  if (!isAgentState(raw.state)) return null
  const signal: AgentSignal = { v: BOW_SIGNAL_VERSION, state: raw.state }
  // `done` 只在 idle 上有意义:working/blocked 带着它一律忽略(避免「边跑边弹完成」)
  if (raw.state === 'idle' && raw.done === true) signal.done = true
  if (typeof raw.agent === 'string' && raw.agent.trim()) signal.agent = raw.agent.trim()
  if (typeof raw.title === 'string' && raw.title) signal.title = raw.title
  if (typeof raw.text === 'string' && raw.text) signal.text = raw.text
  return signal
}

/**
 * 流式 OSC 解析器:一次喂一个 chunk,吐「干净文本 + 信号」。
 *
 * 不变式(测试覆盖):
 * - **不是本协议的序列原样放行**(如 pi 的标题 `ESC]0;…BEL`、超链接 `ESC]8;…`),
 *   它们必须原封不动进 xterm —— 这里只吃 `1337;bow;` 与已变成 bow 数据源的 `9;4`(进度);
 * - 一条信号被切成两个 chunk → 缓冲到下次喂进来;
 * - 文本与信号的**相对顺序**保持(文本按出现顺序拼,信号按出现顺序入数组);
 * - 坏 JSON / 未知版本 / 未知 state → 丢弃该条(且不吞掉它周围的文本);
 * - 保留缓冲超上限 → 当普通文本放行(坏流不能让内存无限涨)。
 */
export class OscSignalParser {
  /** 上一 chunk 末尾没结束的那一段(`ESC]` 开头) */
  private carry = ''

  reset(): void {
    this.carry = ''
  }

  feed(chunk: string): OscParseResult {
    const input = this.carry + chunk
    this.carry = ''
    let text = ''
    const signals: AgentSignal[] = []
    let progress: OscProgressHint | null = null

    let i = 0
    while (i < input.length) {
      const start = input.indexOf(`${ESC}]`, i)
      if (start < 0) {
        text += input.slice(i)
        break
      }
      text += input.slice(i, start)
      const parsed = readOsc(input, start)
      if (!parsed) {
        // 序列没结束:留在缓冲里等下一段
        this.carry = input.slice(start)
        break
      }
      const hint = progressHintOf(parsed.body)
      if (hint) {
        progress = hint
      } else if (!consumeBowSignal(parsed.body, signals)) {
        // 不是本协议 -- 原样交回文本,让 xterm 自己处理
        text += input.slice(start, parsed.end)
      }
      i = parsed.end
    }

    if (this.carry.length > MAX_OSC_LENGTH) {
      text += this.carry
      this.carry = ''
    }
    return { text, signals, progress }
  }
}

/** 在 `input[start]` 处(`ESC]`)读一条完整 OSC;没结束返回 null */
function readOsc(input: string, start: number): { body: string; end: number } | null {
  for (let i = start + 2; i < input.length; i++) {
    const ch = input[i]
    if (ch === BEL) return { body: input.slice(start + 2, i), end: i + 1 }
    if (ch === ESC) {
      if (i + 1 >= input.length) return null // `ESC` 是最后一个字符:ST 可能要等下一段
      if (input[i + 1] === '\\') return { body: input.slice(start + 2, i), end: i + 2 }
    }
  }
  return null
}

/** `9;4;<n>` 的 `n`:0 = 清除,其余都是「活动」;不是进度序列返回 null */
function progressHintOf(body: string): OscProgressHint | null {
  if (!body.startsWith(PROGRESS_SELECTOR)) return null
  const state = body.slice(PROGRESS_SELECTOR.length).split(';')[0]
  return state === '0' ? 'clear' : 'active'
}

/**
 * 处理一条完整的 OSC 体(不含 `ESC]` 与终止符)。
 * 返回 `false` = 「不是本协议」,调用方把它原样交回文本;`true` = 已消费(剥掉)。
 */
function consumeBowSignal(body: string, out: AgentSignal[]): boolean {
  if (!body.startsWith(`${BOW_OSC_CODE};${BOW_OSC_KEY};`)) return false
  const payload = body.slice(`${BOW_OSC_CODE};${BOW_OSC_KEY};`.length)
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return true // 是我们协议的形状但 JSON 坏了:吃掉(它本来也不该显示给用户)
  }
  const signal = normalizeAgentSignal(parsed)
  if (signal) out.push(signal)
  return true
}

// ---------- ② 状态 → 角标 ----------

/** 信号 → 标签角标;`null` = 没有角标(清掉) */
export function badgeOfSignal(signal: AgentSignal): AgentBadge | null {
  if (signal.state === 'blocked') return 'blocked'
  if (signal.state === 'working') return 'working'
  return signal.done ? 'done' : null
}

// ---------- ③ 通知栈归约 ----------

/** 归约动作。`id`/`at` 由调用方给(纯函数里不取时钟、不生成随机数) */
export type ToastAction =
  | { type: 'signal'; tabId: number; signal: AgentSignal; id: string; at: number }
  | { type: 'dismiss'; id: string }
  | { type: 'tab-closed'; tabId: number }

export interface ToastContext {
  id: () => string
  now: () => number
}

/** 通知标题(文案集中在纯函数里,便于单测与以后换措辞) */
export function toastHeadline(kind: 'blocked' | 'done', signal: AgentSignal): { title: string; text?: string } {
  const agent = signal.agent || 'pi'
  if (kind === 'done') {
    const text = signal.text || signal.title
    return { title: `${agent} 已完成`, ...(text ? { text } : {}) }
  }
  // blocked:`title` 是对话框标题(如「切换到 build？」),`text` 是会话标签;两个都有就都显示
  const text = [signal.title, signal.text].filter((part): part is string => !!part).join(' · ')
  return { title: `${agent} 需要确认`, ...(text ? { text } : {}) }
}

/**
 * 通知栈的纯归约。规则:
 * - `blocked` → 入栈(**同一标签只留一条**,重复的新对话替换旧的);`done` → 入栈(同样只留一条);
 * - `working` / `idle`(非 done)→ **把该标签的 `blocked` 通知撤掉**(用户答了、agent 继续了),
 *   `done` 通知不受影响(它只是提醒,不该被后续状态立刻抹掉);
 * - `dismiss` / `tab-closed` → 按 id / tabId 移除;
 * - 超过 `MAX_AGENT_TOASTS` → 丢最旧的(新通知比旧的有用)。
 */
export function reduceToasts(
  items: readonly AgentToastItem[],
  action: ToastAction,
  ctx: ToastContext
): AgentToastItem[] {
  if (action.type === 'dismiss') return items.filter((t) => t.id !== action.id)
  if (action.type === 'tab-closed') return items.filter((t) => t.tabId !== action.tabId)

  const { tabId, signal } = action
  // 先把「被这次状态作废的旧通知」摘掉,再决定是否入栈
  const kept = items.filter((t) => {
    if (t.tabId !== tabId) return true
    if (signal.state === 'blocked') return t.kind !== 'blocked'
    if (signal.state === 'working') return t.kind !== 'blocked'
    // idle
    return signal.done ? t.kind !== 'done' : t.kind !== 'blocked'
  })

  if (signal.state === 'blocked') {
    const head = toastHeadline('blocked', signal)
    kept.push({ id: ctx.id(), tabId, kind: 'blocked', agent: signal.agent || 'pi', title: head.title, text: head.text, at: ctx.now() })
  } else if (signal.state === 'idle' && signal.done) {
    const head = toastHeadline('done', signal)
    kept.push({ id: ctx.id(), tabId, kind: 'done', agent: signal.agent || 'pi', title: head.title, text: head.text, at: ctx.now() })
  }

  return kept.length > MAX_AGENT_TOASTS ? kept.slice(kept.length - MAX_AGENT_TOASTS) : kept
}

/**
 * 某个信号是否让通知栈发生变化。
 * 主进程据此决定要不要真的推给视图(避免每次 `9;4` 心跳 / 重复上报都把视图重画一遍)。
 */
export function toastsWouldChange(items: readonly AgentToastItem[], action: ToastAction): boolean {
  if (action.type === 'dismiss') return items.some((t) => t.id === action.id)
  if (action.type === 'tab-closed') return items.some((t) => t.tabId === action.tabId)
  const mine = items.filter((t) => t.tabId === action.tabId)
  const { signal } = action
  if (signal.state === 'blocked' || (signal.state === 'idle' && signal.done)) return true // 入栈/替换标题
  if (signal.state === 'working') return mine.some((t) => t.kind === 'blocked')
  return mine.some((t) => t.kind === 'blocked')
}
