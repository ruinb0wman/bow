import { describe, expect, it } from 'vitest'
import {
  blurredSession,
  dismissedSession,
  focusedSession,
  lostFocusSession,
  newSession,
  withResults
} from '../src/renderer/src/lib/suggestSession'
import type { SuggestSession } from '../src/renderer/src/lib/suggestSession'

/** 模拟一次「聚焦 → 结果落地」 */
function focusedWithResults(rowCount: number): { session: SuggestSession; snap: number } {
  const session = focusedSession(newSession())
  return { session: withResults(session, session.seq, rowCount), snap: session.seq }
}

describe('地址栏建议会话:可见性只由「键盘焦点 + 请求代」决定', () => {
  it('初始不可见', () => {
    expect(newSession()).toEqual({ focused: false, seq: 0, visible: false })
  })

  it('聚焦后有结果 → 面板可见', () => {
    expect(focusedWithResults(3).session.visible).toBe(true)
  })

  it('聚焦后结果为空 → 不开面板', () => {
    expect(focusedWithResults(0).session.visible).toBe(false)
  })

  it('失焦后结果落地 → 丢弃(绝不用迟到的响应把面板弹回来)', () => {
    const { session, snap } = focusedWithResults(3)
    const blurred = blurredSession(session)
    const next = withResults(blurred, snap, 3)
    expect(next).toBe(blurred) // 同一个对象 = 调用方跳过赋值
    expect(next.visible).toBe(true) // 可见性归 120ms 兜底管,失焦本身不动它
  })

  it('键盘焦点交给页面视图 → 面板立刻不可见,且此后结果一律丢弃', () => {
    const { session, snap } = focusedWithResults(3)
    const lost = lostFocusSession(session)
    expect(lost.visible).toBe(false)
    expect(lost.focused).toBe(false)
    expect(withResults(lost, snap, 3)).toBe(lost)
  })

  it('显式关闭(Esc/选中)后在途响应不复活面板', () => {
    const { session, snap } = focusedWithResults(3)
    const dismissed = dismissedSession(session)
    expect(dismissed.visible).toBe(false)
    expect(withResults(dismissed, snap, 3)).toBe(dismissed)
  })

  it('失焦后重新聚焦:上一代的结果不会落地到新会话', () => {
    const { snap } = focusedWithResults(3)
    const refocused = focusedSession(blurredSession(newSession()))
    expect(refocused.seq).not.toBe(snap)
    expect(withResults(refocused, snap, 3)).toBe(refocused)
    expect(refocused.visible).toBe(false)
  })

  it('每次转移都 +1 代(过期判据的唯一依据)', () => {
    const s = newSession()
    expect(focusedSession(s).seq).toBe(1)
    expect(blurredSession(s).seq).toBe(1)
    expect(lostFocusSession(s).seq).toBe(1)
    expect(dismissedSession(s).seq).toBe(1)
  })

  it('失焦不清 visible:点面板那一下的 blur 不能把面板收掉', () => {
    const { session } = focusedWithResults(3)
    expect(blurredSession(session).visible).toBe(true)
  })

  it('关闭分屏面板这类操作不改变焦点标记(只作废请求代)', () => {
    const { session } = focusedWithResults(3)
    const dismissed = dismissedSession(session)
    expect(dismissed.focused).toBe(true)
    expect(dismissed.seq).toBe(session.seq + 1)
  })
})
