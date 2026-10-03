/**
 * 番茄钟纯逻辑(两端安全:不引 electron / node / DOM,主进程与渲染层共用,可单测)。
 *
 * 分工:对「时长 / 阶段转移 / 跨天 / 夹紧 / 剩余时间」的判定全在这里;
 * `main.ts` 只管主进程时钟与 IO,`ui/*.vue` 只管渲染。
 *
 * 时间口径:一律用 **epoch 毫秒**。运行中的阶段只存 `endsAt`(倒计时由渲染层本地插值),
 * 主进程每秒只做一次 `now >= endsAt` 的检查 —— 不做长 `setTimeout`(跨休眠会漂移)。
 */

export type Phase = 'focus' | 'short-break' | 'long-break'

export interface PomoSettings {
  /** 专注时长(分钟) */
  focusMinutes: number
  /** 短休息时长(分钟) */
  shortBreakMinutes: number
  /** 长休息时长(分钟) */
  longBreakMinutes: number
  /** 几个专注后进长休息 */
  roundsBeforeLongBreak: number
  /** 阶段结束后自动开始下一阶段 */
  autoStartNext: boolean
  /** 阶段结束时弹系统桌面通知 */
  notify: boolean
  /** 阶段结束时响提示音(由渲染层 WebAudio 播) */
  sound: boolean
}

export interface PomoState {
  phase: Phase
  running: boolean
  /** epoch ms;仅在 running 时有效 */
  endsAt: number | null
  /** 暂停 / 未开始时的剩余毫秒 */
  remainingMs: number
  /** 本轮已完成的专注数(0..roundsBeforeLongBreak) */
  cycleIndex: number
  completedToday: number
  /** 本地 'YYYY-MM-DD';跨天时 completedToday 归零 */
  completedDate: string
}

export interface PomoSnapshot {
  settings: PomoSettings
  state: PomoState
  /** 主进程的当前时间:渲染层据此算 `endsAt - serverNow` 的偏移,避免两边时钟差异 */
  serverNow: number
}

/** 插件事件名(经 `ctx.ipc.emit` → 渲染层 `plugins.onEvent`) */
export const POMO_EVENT = {
  /** 状态快照整体刷新(开始 / 暂停 / 跳过 / 重置 / 设置变更 / 阶段完成) */
  state: 'state',
  /** 阶段刚结束,用于闪烁 + 提示音(负载 { phase, focus, autoStarted }) */
  phaseEnd: 'phase-end'
} as const

export const DEFAULT_SETTINGS: PomoSettings = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  roundsBeforeLongBreak: 4,
  autoStartNext: false,
  notify: true,
  sound: true
}

export const PHASE_LABELS: Record<Phase, string> = {
  focus: '专注',
  'short-break': '短休息',
  'long-break': '长休息'
}

export const MIN_MINUTES = 1
export const MAX_MINUTES = 180
export const MIN_ROUNDS = 1
export const MAX_ROUNDS = 12
/** remainingMs 的持久化上限(1 天):防止外部写坏文件后显示荒谬的倒计时 */
const MAX_REMAINING_MS = 24 * 60 * 60 * 1000

const PHASES: readonly Phase[] = ['focus', 'short-break', 'long-break']

function isPhase(value: unknown): value is Phase {
  return typeof value === 'string' && (PHASES as readonly string[]).includes(value)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 阶段时长(毫秒) */
export function durationMs(phase: Phase, settings: PomoSettings): number {
  const minutes =
    phase === 'focus'
      ? settings.focusMinutes
      : phase === 'short-break'
        ? settings.shortBreakMinutes
        : settings.longBreakMinutes
  return Math.max(1, minutes) * 60_000
}

/** 本地日期键(YYYY-MM-DD):用本地时区,不用 UTC(跨天在用户眼里是本地午夜) */
export function localDateKey(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** mm:ss;分钟数不封顶(用户可以设 180 分钟) */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 任意输入 → 合法设置(越界夹紧、缺省补默认;未知字段忽略) */
export function normalizeSettings(input: unknown): PomoSettings {
  const o = (input && typeof input === 'object' ? input : {}) as Partial<PomoSettings>
  return {
    focusMinutes: clampInt(o.focusMinutes, MIN_MINUTES, MAX_MINUTES, DEFAULT_SETTINGS.focusMinutes),
    shortBreakMinutes: clampInt(o.shortBreakMinutes, MIN_MINUTES, MAX_MINUTES, DEFAULT_SETTINGS.shortBreakMinutes),
    longBreakMinutes: clampInt(o.longBreakMinutes, MIN_MINUTES, MAX_MINUTES, DEFAULT_SETTINGS.longBreakMinutes),
    roundsBeforeLongBreak: clampInt(
      o.roundsBeforeLongBreak,
      MIN_ROUNDS,
      MAX_ROUNDS,
      DEFAULT_SETTINGS.roundsBeforeLongBreak
    ),
    autoStartNext: bool(o.autoStartNext, DEFAULT_SETTINGS.autoStartNext),
    notify: bool(o.notify, DEFAULT_SETTINGS.notify),
    sound: bool(o.sound, DEFAULT_SETTINGS.sound)
  }
}

/** 初始状态:专注阶段、暂停、满时长 */
export function initialState(settings: PomoSettings, now: number): PomoState {
  return {
    phase: 'focus',
    running: false,
    endsAt: null,
    remainingMs: durationMs('focus', settings),
    cycleIndex: 0,
    completedToday: 0,
    completedDate: localDateKey(now)
  }
}

/** 跨天归零 `completedToday`(纯函数:同一日期原样返回) */
export function rolloverDay(state: PomoState, now: number): PomoState {
  const today = localDateKey(now)
  if (state.completedDate === today) return state
  return { ...state, completedToday: 0, completedDate: today }
}

/** 任意输入 → 自洽状态:非法阶段/时长兜底、跨天归零、`running` 无 `endsAt` 退化为暂停 */
export function normalizeState(input: unknown, settings: PomoSettings, now: number): PomoState {
  const o = (input && typeof input === 'object' ? input : {}) as Partial<PomoState>
  const phase = isPhase(o.phase) ? o.phase : 'focus'
  const base: PomoState = {
    phase,
    running: o.running === true,
    endsAt: typeof o.endsAt === 'number' && Number.isFinite(o.endsAt) ? o.endsAt : null,
    remainingMs: clampInt(o.remainingMs, 0, MAX_REMAINING_MS, durationMs(phase, settings)),
    cycleIndex: clampInt(o.cycleIndex, 0, MAX_ROUNDS, 0),
    completedToday: clampInt(o.completedToday, 0, 9999, 0),
    completedDate: typeof o.completedDate === 'string' ? o.completedDate : localDateKey(now)
  }
  const coherent = base.running && base.endsAt == null ? { ...base, running: false } : base
  return rolloverDay(coherent, now)
}

/** 剩余毫秒:运行中按 `endsAt` 算,否则用存下来的 `remainingMs` */
export function remainingMsOf(state: PomoState, now: number): number {
  if (state.running && state.endsAt != null) return Math.max(0, state.endsAt - now)
  return Math.max(0, state.remainingMs)
}

/** 开始 / 继续:有剩余就用剩余,否则给满时长;不改变阶段与计数 */
export function startPhase(state: PomoState, settings: PomoSettings, now: number): PomoState {
  const base = rolloverDay(state, now)
  const remaining = remainingMsOf(base, now)
  const ms = remaining > 0 ? remaining : durationMs(base.phase, settings)
  return { ...base, running: true, endsAt: now + ms, remainingMs: ms }
}

/** 暂停:把剩余量固化进 `remainingMs` */
export function pausePhase(state: PomoState, now: number): PomoState {
  if (!state.running) return state
  return { ...state, running: false, endsAt: null, remainingMs: remainingMsOf(state, now) }
}

/** 重置当前阶段:满时长、暂停 */
export function resetPhase(state: PomoState, settings: PomoSettings): PomoState {
  return { ...state, running: false, endsAt: null, remainingMs: durationMs(state.phase, settings) }
}

/**
 * 完成当前阶段并切到下一阶段。
 *
 * - `count=false`(skip)不增加今日完成数 / `cycleIndex`;
 * - 专注 → 短休;第 `roundsBeforeLongBreak` 个专注之后 → 长休;休息 → 专注(长休后 `cycleIndex` 归零);
 * - `autoStart` 决定下一阶段是否立刻开跑。
 */
export function completePhase(
  state: PomoState,
  settings: PomoSettings,
  now: number,
  opts: { count: boolean; autoStart: boolean }
): { next: PomoState; completed: { phase: Phase; focus: boolean } } {
  const base = rolloverDay(state, now)
  const finished = base.phase
  const focus = finished === 'focus'
  let cycleIndex = base.cycleIndex
  let completedToday = base.completedToday

  if (focus && opts.count) {
    completedToday += 1
    cycleIndex += 1
  }

  let nextPhase: Phase
  if (focus) {
    nextPhase = cycleIndex >= settings.roundsBeforeLongBreak ? 'long-break' : 'short-break'
  } else {
    nextPhase = 'focus'
    if (finished === 'long-break') cycleIndex = 0
  }

  const full = durationMs(nextPhase, settings)
  const next: PomoState = {
    phase: nextPhase,
    running: opts.autoStart,
    endsAt: opts.autoStart ? now + full : null,
    remainingMs: full,
    cycleIndex,
    completedToday,
    completedDate: localDateKey(now)
  }
  return { next, completed: { phase: finished, focus } }
}

/**
 * 面板上的「第 k / n 个番茄」:
 * 专注进行中显示 `cycleIndex + 1`,休息中显示刚完成的 `cycleIndex`,都夹在 `1..n`。
 */
export function roundLabel(state: PomoState, settings: PomoSettings): string {
  const n = settings.roundsBeforeLongBreak
  const raw = state.phase === 'focus' ? state.cycleIndex + 1 : state.cycleIndex
  const k = Math.min(Math.max(raw, 1), n)
  return `第 ${k} / ${n} 个番茄`
}
