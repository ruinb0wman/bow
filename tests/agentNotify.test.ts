/**
 * AgentNotify:信号 → 角标 + 通知栈 + 三种定时器。
 *
 * 依赖全部以端口注入(假 resolve / 假通知宿主 / 假时钟),所以这里不需要 electron 与真实窗口。
 * 覆盖的重点是「时序」:done 的过期、blocked 的常驻、关标签时宿主映射已摘掉仍能清通知。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0' } }))

const { AgentNotify } = await import('../src/main/agentNotify')
const { AGENT_DONE_BADGE_MS, AGENT_DONE_TOAST_MS } = await import('../src/shared/agentState')
type AgentToastItem = import('../src/shared/agentState').AgentToastItem
type AgentBadge = import('../src/shared/agentState').AgentBadge
type AgentToastPort = import('../src/main/agentNotify').AgentToastPort

/** 假通知宿主:记下每次下发的切片 */
class FakeToasts implements AgentToastPort {
  private current: AgentToastItem[] = []
  renders = 0

  items(): readonly AgentToastItem[] {
    return this.current
  }

  set(next: readonly AgentToastItem[]): void {
    this.current = [...next]
    this.renders += 1
  }

  snap(): AgentToastItem[] {
    return [...this.current]
  }
}

interface FakeTab {
  badge: AgentBadge | null
  setBadgeCalls: number
  toasts: FakeToasts
  closed: boolean
}

/** 假时钟:schedule 只登记,advance 按到点顺序执行 */
function fakeClock() {
  let now = 0
  const pending: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const entry = { at: now + ms, fn, cancelled: false }
      pending.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = pending.filter((p) => !p.cancelled && p.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        due.cancelled = true
        now = due.at
        due.fn()
      }
      now = until
    }
  }
}

function setup(tabs: number[]) {
  const clock = fakeClock()
  const fake = new Map<number, FakeTab>()
  for (const id of tabs) fake.set(id, { badge: null, setBadgeCalls: 0, toasts: new FakeToasts(), closed: false })
  let seq = 0
  const notify = new AgentNotify({
    resolve: (tabId) => {
      const tab = fake.get(tabId)
      if (!tab || tab.closed) return null
      return {
        setBadge: (badge) => {
          tab.badge = badge
          tab.setBadgeCalls += 1
        },
        toasts: tab.toasts
      }
    },
    schedule: clock.schedule,
    now: clock.now,
    nextId: () => `n${++seq}`
  })
  return { notify, fake, clock, tab: (id: number) => fake.get(id)! }
}

describe('AgentNotify:角标', () => {
  it('blocked / working / idle+done 分别落到角标;idle 清掉角标', () => {
    const { notify, tab } = setup([1])
    notify.report({ tabId: 1, v: 1, state: 'working' })
    expect(tab(1).badge).toBe('working')
    notify.report({ tabId: 1, v: 1, state: 'blocked', title: '确认' })
    expect(tab(1).badge).toBe('blocked')
    notify.report({ tabId: 1, v: 1, state: 'idle', done: true })
    expect(tab(1).badge).toBe('done')
    notify.report({ tabId: 1, v: 1, state: 'idle' })
    expect(tab(1).badge).toBeNull()
  })

  it('done 角标自己过期,blocked 不会', () => {
    const { notify, tab, clock } = setup([1])
    notify.report({ tabId: 1, v: 1, state: 'idle', done: true })
    expect(tab(1).badge).toBe('done')
    clock.advance(AGENT_DONE_BADGE_MS - 1)
    expect(tab(1).badge).toBe('done')
    clock.advance(1)
    expect(tab(1).badge).toBeNull()

    notify.report({ tabId: 1, v: 1, state: 'blocked' })
    clock.advance(AGENT_DONE_BADGE_MS * 10)
    expect(tab(1).badge).toBe('blocked')
  })

  it('重复同一状态不重复写角标(避免每次心跳都惊动 TabManager)', () => {
    const { notify, tab } = setup([1])
    notify.report({ tabId: 1, v: 1, state: 'working' })
    const calls = tab(1).setBadgeCalls
    notify.report({ tabId: 1, v: 1, state: 'working' })
    notify.report({ tabId: 1, v: 1, state: 'working' })
    expect(tab(1).setBadgeCalls).toBe(calls)
  })

  it('落到不存在的标签不炸也不留状态', () => {
    const { notify, tab } = setup([1])
    expect(() => notify.report({ tabId: 99, v: 1, state: 'blocked' })).not.toThrow()
    expect(notify.list()).toEqual([])
    expect(tab(1).badge).toBeNull()
  })
})

describe('AgentNotify:通知栈', () => {
  it('blocked 入栈并下发;working 撤掉它', () => {
    const { notify, tab } = setup([1])
    notify.report({ tabId: 1, v: 1, state: 'blocked', title: '切换到 build？' })
    expect(tab(1).toasts.snap().map((t) => t.kind)).toEqual(['blocked'])
    expect(tab(1).toasts.snap()[0]?.text).toBe('切换到 build？')

    notify.report({ tabId: 1, v: 1, state: 'working' })
    expect(tab(1).toasts.snap()).toEqual([])
  })

  it('done 通知自动关闭(到点从栈里消失)', () => {
    const { notify, tab, clock } = setup([1])
    notify.report({ tabId: 1, v: 1, state: 'idle', done: true, text: 'π - bow' })
    expect(tab(1).toasts.snap()).toHaveLength(1)
    clock.advance(AGENT_DONE_TOAST_MS - 1)
    expect(tab(1).toasts.snap()).toHaveLength(1)
    clock.advance(1)
    expect(tab(1).toasts.snap()).toEqual([])
    expect(notify.list()).toEqual([])
  })

  it('blocked 不会自动关闭', () => {
    const { notify, tab, clock } = setup([1])
    notify.report({ tabId: 1, v: 1, state: 'blocked' })
    clock.advance(AGENT_DONE_TOAST_MS * 20)
    expect(tab(1).toasts.snap()).toHaveLength(1)
  })

  it('dismiss 关掉通知并取消它的自动关闭(不会关两次)', () => {
    const { notify, tab, clock } = setup([1])
    notify.report({ tabId: 1, v: 1, state: 'idle', done: true })
    const id = notify.list()[0]!.id
    notify.dismiss(id)
    expect(tab(1).toasts.snap()).toEqual([])
    const renders = tab(1).toasts.renders
    clock.advance(AGENT_DONE_TOAST_MS * 2)
    expect(tab(1).toasts.renders).toBe(renders)
  })

  it('关标签:即便此时 byTabId 已查不到,也能把通知从那个窗口摘掉', () => {
    const { notify, tab } = setup([1, 2])
    notify.report({ tabId: 1, v: 1, state: 'blocked' })
    notify.report({ tabId: 2, v: 1, state: 'blocked' })
    expect(tab(1).toasts.snap()).toHaveLength(1)

    // 模拟 TabManager.close():先让 resolve 失效,再发 tab-closed
    tab(1).closed = true
    notify.tabClosed(1)
    expect(notify.list().map((t) => t.tabId)).toEqual([2])
    expect(tab(1).toasts.snap()).toEqual([])
    expect(tab(2).toasts.snap()).toHaveLength(1)
  })

  it('关标签同时取消该标签的 done 定时器(不再触碰已关的标签)', () => {
    const { notify, tab, clock } = setup([1])
    notify.report({ tabId: 1, v: 1, state: 'idle', done: true })
    tab(1).closed = true
    notify.tabClosed(1)
    const badgeCalls = tab(1).setBadgeCalls
    clock.advance(AGENT_DONE_BADGE_MS * 2)
    expect(tab(1).setBadgeCalls).toBe(badgeCalls)
  })

  it('多标签各自成条,栈上限 4', () => {
    const { notify } = setup([1, 2, 3, 4, 5])
    for (const id of [1, 2, 3, 4, 5]) notify.report({ tabId: id, v: 1, state: 'blocked' })
    expect(notify.list().map((t) => t.tabId)).toEqual([2, 3, 4, 5])
  })
})
