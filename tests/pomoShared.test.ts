/**
 * 番茄钟纯逻辑用例:状态机是插件的核心正确性,这里把它钉死。
 * 重点:四连专注后进长休、长休后计数归零、跳过不计数、跨天归零、暂停剩余精确、设置夹紧。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  MAX_MINUTES,
  MAX_ROUNDS,
  MIN_MINUTES,
  MIN_ROUNDS,
  completePhase,
  durationMs,
  formatClock,
  initialState,
  localDateKey,
  normalizeSettings,
  normalizeState,
  pausePhase,
  remainingMsOf,
  resetPhase,
  rolloverDay,
  roundLabel,
  startPhase,
  type PomoSettings,
  type PomoState
} from '../src/plugins/pomo/shared'

const T0 = Date.UTC(2026, 9, 3, 9, 0, 0) // 固定基准时刻(测试里只做相对运算)

function fresh(settings: PomoSettings = DEFAULT_SETTINGS, now = T0): PomoState {
  return initialState(settings, now)
}

/** 从当前状态跑完一个完整阶段(自然完成,count=true) */
function runPhase(
  state: PomoState,
  settings: PomoSettings,
  now: number,
  opts: { count?: boolean; autoStart?: boolean } = {}
): PomoState {
  const started = startPhase(state, settings, now)
  const endsAt = started.endsAt ?? now
  return completePhase(started, settings, endsAt, {
    count: opts.count ?? true,
    autoStart: opts.autoStart ?? false
  }).next
}

describe('番茄钟:设置夹紧', () => {
  it('缺省补默认', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('越界夹紧、小数取整、非法值兜底', () => {
    const s = normalizeSettings({
      focusMinutes: 999,
      shortBreakMinutes: 0,
      longBreakMinutes: 12.6,
      roundsBeforeLongBreak: -3,
      autoStartNext: 'yes',
      notify: true,
      sound: 1
    })
    expect(s.focusMinutes).toBe(MAX_MINUTES)
    expect(s.shortBreakMinutes).toBe(MIN_MINUTES)
    expect(s.longBreakMinutes).toBe(13)
    expect(s.roundsBeforeLongBreak).toBe(MIN_ROUNDS)
    expect(s.autoStartNext).toBe(DEFAULT_SETTINGS.autoStartNext)
    expect(s.notify).toBe(true)
    expect(s.sound).toBe(DEFAULT_SETTINGS.sound)
  })

  it('rounds 上限生效', () => {
    expect(normalizeSettings({ roundsBeforeLongBreak: 100 }).roundsBeforeLongBreak).toBe(MAX_ROUNDS)
  })
})

describe('番茄钟:时钟与日期', () => {
  it('formatClock 是 mm:ss 且分钟不封顶', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(59_999)).toBe('00:59')
    expect(formatClock(60_000)).toBe('01:00')
    expect(formatClock(25 * 60_000)).toBe('25:00')
    expect(formatClock(180 * 60_000)).toBe('180:00')
    expect(formatClock(-5)).toBe('00:00')
  })

  it('localDateKey 用本地日期,跨天把 completedToday 归零', () => {
    const now = Date.UTC(2026, 9, 3, 12, 0, 0)
    const state: PomoState = { ...fresh(DEFAULT_SETTINGS, now), completedToday: 7, completedDate: localDateKey(now) }
    // 同一天:原样
    expect(rolloverDay(state, now + 60_000)).toBe(state)
    // 第二天:归零
    const rolled = rolloverDay(state, now + 24 * 3600_000)
    expect(rolled.completedToday).toBe(0)
    expect(rolled.completedDate).not.toBe(state.completedDate)
  })
})

describe('番茄钟:开始 / 暂停 / 重置', () => {
  it('开始设 endsAt,暂停固化剩余', () => {
    const s = DEFAULT_SETTINGS
    const started = startPhase(fresh(s), s, T0)
    expect(started.running).toBe(true)
    expect(started.endsAt).toBe(T0 + durationMs('focus', s))
    expect(remainingMsOf(started, T0 + 60_000)).toBe(durationMs('focus', s) - 60_000)

    const paused = pausePhase(started, T0 + 60_000)
    expect(paused.running).toBe(false)
    expect(paused.endsAt).toBeNull()
    expect(paused.remainingMs).toBe(durationMs('focus', s) - 60_000)
    // 暂停后时间流逝不影响剩余
    expect(remainingMsOf(paused, T0 + 10 * 60_000)).toBe(durationMs('focus', s) - 60_000)
  })

  it('继续用剩余时长,不回到满时长', () => {
    const s = DEFAULT_SETTINGS
    const paused = pausePhase(startPhase(fresh(s), s, T0), T0 + 60_000)
    const resumed = startPhase(paused, s, T0 + 5 * 60_000)
    expect(resumed.remainingMs).toBe(durationMs('focus', s) - 60_000)
    expect(resumed.endsAt).toBe(T0 + 5 * 60_000 + durationMs('focus', s) - 60_000)
  })

  it('重置回满时长且暂停', () => {
    const s = DEFAULT_SETTINGS
    const reset = resetPhase(startPhase(fresh(s), s, T0), s)
    expect(reset.running).toBe(false)
    expect(reset.endsAt).toBeNull()
    expect(reset.remainingMs).toBe(durationMs('focus', s))
  })
})

describe('番茄钟:阶段转移', () => {
  it('专注 → 短休,计数 +1', () => {
    const s = DEFAULT_SETTINGS
    const { next, completed } = completePhase(startPhase(fresh(s), s, T0), s, T0 + durationMs('focus', s), {
      count: true,
      autoStart: false
    })
    expect(completed).toEqual({ phase: 'focus', focus: true })
    expect(next.phase).toBe('short-break')
    expect(next.cycleIndex).toBe(1)
    expect(next.completedToday).toBe(1)
    expect(next.running).toBe(false)
    expect(next.remainingMs).toBe(durationMs('short-break', s))
  })

  it('第 4 个专注之后进长休,长休结束后计数归零', () => {
    const s = DEFAULT_SETTINGS
    let state = fresh(s)
    const now = { t: T0 }

    for (let i = 1; i <= 3; i++) {
      state = runPhase(state, s, now.t) // 专注 i
      expect(state.phase).toBe('short-break')
      expect(state.cycleIndex).toBe(i)
      state = runPhase(state, s, now.t) // 短休 i
      expect(state.phase).toBe('focus')
    }

    state = runPhase(state, s, now.t) // 第 4 个专注
    expect(state.phase).toBe('long-break')
    expect(state.cycleIndex).toBe(4)
    expect(state.completedToday).toBe(4)

    state = runPhase(state, s, now.t) // 长休
    expect(state.phase).toBe('focus')
    expect(state.cycleIndex).toBe(0)
  })

  it('skip 不计数但仍切阶段', () => {
    const s = DEFAULT_SETTINGS
    const started = startPhase(fresh(s), s, T0)
    const { next } = completePhase(started, s, T0 + 1000, { count: false, autoStart: false })
    expect(next.phase).toBe('short-break')
    expect(next.cycleIndex).toBe(0)
    expect(next.completedToday).toBe(0)
  })

  it('autoStart 让下一阶段立刻开跑', () => {
    const s = DEFAULT_SETTINGS
    const at = T0 + durationMs('focus', s)
    const { next } = completePhase(startPhase(fresh(s), s, T0), s, at, { count: true, autoStart: true })
    expect(next.running).toBe(true)
    expect(next.endsAt).toBe(at + durationMs('short-break', s))
  })

  it('跨天完成时把昨日完成数归零再加一', () => {
    const s = DEFAULT_SETTINGS
    const day1 = Date.UTC(2026, 9, 3, 12, 0, 0)
    const day2 = Date.UTC(2026, 9, 4, 12, 0, 0)
    const state: PomoState = { ...fresh(s, day1), completedToday: 9, completedDate: localDateKey(day1) }
    const { next } = completePhase(startPhase(state, s, day2), s, day2 + durationMs('focus', s), {
      count: true,
      autoStart: false
    })
    expect(next.completedToday).toBe(1)
    expect(next.completedDate).toBe(localDateKey(day2))
  })
})

describe('番茄钟:normalizeState 自洽', () => {
  it('running 但 endsAt 缺失 → 退化为暂停', () => {
    const s = normalizeState({ phase: 'focus', running: true, endsAt: null, remainingMs: 1000 }, DEFAULT_SETTINGS, T0)
    expect(s.running).toBe(false)
    expect(s.remainingMs).toBe(1000)
  })

  it('非法阶段兜底为专注,剩余时长夹进上限', () => {
    const s = normalizeState({ phase: 'nope', remainingMs: Number.MAX_SAFE_INTEGER }, DEFAULT_SETTINGS, T0)
    expect(s.phase).toBe('focus')
    expect(s.remainingMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })

  it('空输入得到默认初始状态', () => {
    const s = normalizeState(undefined, DEFAULT_SETTINGS, T0)
    expect(s).toEqual(fresh(DEFAULT_SETTINGS, T0))
  })
})

describe('番茄钟:轮次文案', () => {
  it('专注中显示 cycleIndex + 1,并夹在 1..n', () => {
    const s = DEFAULT_SETTINGS
    expect(roundLabel({ ...fresh(s), phase: 'focus', cycleIndex: 0 }, s)).toBe('第 1 / 4 个番茄')
    expect(roundLabel({ ...fresh(s), phase: 'focus', cycleIndex: 3 }, s)).toBe('第 4 / 4 个番茄')
    expect(roundLabel({ ...fresh(s), phase: 'short-break', cycleIndex: 1 }, s)).toBe('第 1 / 4 个番茄')
    expect(roundLabel({ ...fresh(s), phase: 'long-break', cycleIndex: 4 }, s)).toBe('第 4 / 4 个番茄')
  })
})
