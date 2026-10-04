/**
 * AgentNotify:信号 → 标签角标 + 系统通知。
 *
 * 依赖全部以端口注入(假 resolve / 假通知出口 / 假时钟),所以这里不需要 electron 与真实窗口。
 * 覆盖的重点是**时机**:done 角标的过期、`blocked` 通知在「代理继续 / 关标签」时被撤回、
 * 以及「通知只发给存在的标签」。
 *
 * 通知文案本身(标题/正文怎么拼)由 `tests/agentState.test.ts` 钉住;这里只断言转发与撤回。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0' } }))

const { AgentNotify } = await import('../src/main/agentNotify')
const { AGENT_DONE_BADGE_MS } = await import('../src/shared/agentState')
type AgentBadge = import('../src/shared/agentState').AgentBadge
type AgentNotice = import('../src/main/systemNotify').AgentNotice
type NoticeHandle = import('../src/main/systemNotify').NoticeHandle
type SystemNotifyPort = import('../src/main/systemNotify').SystemNotifyPort

/** 假系统通知出口:记下每条 show 与被 close 的句柄下标 */
class FakeNotify implements SystemNotifyPort {
  shown: AgentNotice[] = []
  /** 与 shown 同下标的句柄是否已被 close */
  closed: boolean[] = []

  show(notice: AgentNotice): NoticeHandle {
    const index = this.shown.push(notice) - 1
    this.closed[index] = false
    return {
      close: () => {
        this.closed[index] = true
      }
    }
  }

  /** 第 i 条通知是否被撤回 */
  isClosed(i: number): boolean {
    return this.closed[i] === true
  }

  kinds(): string[] {
    return this.shown.map((n) => n.kind)
  }
}

interface FakeTab {
  badge: AgentBadge | null
  setBadgeCalls: number
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
  const notify = new FakeNotify()
  const fake = new Map<number, FakeTab>()
  for (const id of tabs) fake.set(id, { badge: null, setBadgeCalls: 0, closed: false })
  const agentNotify = new AgentNotify({
    resolve: (tabId) => {
      const tab = fake.get(tabId)
      if (!tab || tab.closed) return null
      return {
        setBadge: (badge) => {
          tab.badge = badge
          tab.setBadgeCalls += 1
        }
      }
    },
    notify,
    schedule: clock.schedule
  })
  return { agentNotify, fake, clock, notify, tab: (id: number) => fake.get(id)! }
}

describe('AgentNotify:角标', () => {
  it('blocked / working / idle+done 分别落到角标;idle 清掉角标', () => {
    const { agentNotify, tab } = setup([1])
    agentNotify.report({ tabId: 1, v: 1, state: 'working' })
    expect(tab(1).badge).toBe('working')
    agentNotify.report({ tabId: 1, v: 1, state: 'blocked', title: '确认' })
    expect(tab(1).badge).toBe('blocked')
    agentNotify.report({ tabId: 1, v: 1, state: 'idle', done: true })
    expect(tab(1).badge).toBe('done')
    agentNotify.report({ tabId: 1, v: 1, state: 'idle' })
    expect(tab(1).badge).toBeNull()
  })

  it('done 角标自己过期,blocked 不会', () => {
    const { agentNotify, tab, clock } = setup([1])
    agentNotify.report({ tabId: 1, v: 1, state: 'idle', done: true })
    expect(tab(1).badge).toBe('done')
    clock.advance(AGENT_DONE_BADGE_MS - 1)
    expect(tab(1).badge).toBe('done')
    clock.advance(1)
    expect(tab(1).badge).toBeNull()

    agentNotify.report({ tabId: 1, v: 1, state: 'blocked' })
    clock.advance(AGENT_DONE_BADGE_MS * 10)
    expect(tab(1).badge).toBe('blocked')
  })

  it('重复同一状态不重复写角标(避免每次心跳都惊动 TabManager)', () => {
    const { agentNotify, tab } = setup([1])
    agentNotify.report({ tabId: 1, v: 1, state: 'working' })
    const calls = tab(1).setBadgeCalls
    agentNotify.report({ tabId: 1, v: 1, state: 'working' })
    agentNotify.report({ tabId: 1, v: 1, state: 'working' })
    expect(tab(1).setBadgeCalls).toBe(calls)
  })

  it('落到不存在的标签不炸、不发通知、不留状态', () => {
    const { agentNotify, tab, notify } = setup([1])
    expect(() => agentNotify.report({ tabId: 99, v: 1, state: 'blocked', title: '确认' })).not.toThrow()
    expect(notify.shown).toEqual([])
    expect(tab(1).badge).toBeNull()
  })
})

describe('AgentNotify:系统通知', () => {
  it('blocked → 发一条,标题/正文来自 notificationCopy', () => {
    const { agentNotify, notify } = setup([1])
    agentNotify.report({ tabId: 1, v: 1, state: 'blocked', title: '切换到 build？', text: 'π - bow - repo' })
    expect(notify.shown).toEqual([
      { kind: 'blocked', title: 'pi 需要确认', body: '切换到 build？ · π - bow - repo', tabId: 1 }
    ])
  })

  it('同一标签再来一条 blocked:先撤回旧的,再发新的(不堆两条)', () => {
    const { agentNotify, notify } = setup([1])
    agentNotify.report({ tabId: 1, v: 1, state: 'blocked', title: '第一个' })
    agentNotify.report({ tabId: 1, v: 1, state: 'blocked', title: '第二个' })
    expect(notify.shown).toHaveLength(2)
    expect(notify.isClosed(0)).toBe(true)
    expect(notify.isClosed(1)).toBe(false)
    expect(notify.shown[1]?.body).toBe('第二个')
  })

  it('blocked → working:撤回那条等待通知(用户已经在终端里答完了)', () => {
    const { agentNotify, notify } = setup([1])
    agentNotify.report({ tabId: 1, v: 1, state: 'blocked', title: '确认' })
    agentNotify.report({ tabId: 1, v: 1, state: 'working' })
    expect(notify.shown).toHaveLength(1)
    expect(notify.isClosed(0)).toBe(true)
  })

  it('idle(非 done)也撤回 blocked,但自己不弹通知', () => {
    const { agentNotify, notify } = setup([1])
    agentNotify.report({ tabId: 1, v: 1, state: 'blocked' })
    agentNotify.report({ tabId: 1, v: 1, state: 'idle' })
    expect(notify.kinds()).toEqual(['blocked'])
    expect(notify.isClosed(0)).toBe(true)
  })

  it('idle + done → 发 done 通知(不等于是 blocked,也不撤回别的标签的)', () => {
    const { agentNotify, notify } = setup([1, 2])
    agentNotify.report({ tabId: 1, v: 1, state: 'blocked' })
    agentNotify.report({ tabId: 2, v: 1, state: 'idle', done: true, text: 'π - bow' })
    expect(notify.kinds()).toEqual(['blocked', 'done'])
    expect(notify.shown[1]).toEqual({ kind: 'done', title: 'pi 已完成', body: 'π - bow', tabId: 2 })
    expect(notify.isClosed(0)).toBe(false)
  })

  it('没有 blocked 在途时收到 working 不会瞎 close', () => {
    const { agentNotify, notify } = setup([1])
    agentNotify.report({ tabId: 1, v: 1, state: 'working' })
    expect(notify.shown).toEqual([])
    expect(notify.closed).toEqual([])
  })

  it('关标签:撤回 blocked 通知,并取消该标签的角标定时器', () => {
    const { agentNotify, tab, clock, notify } = setup([1, 2])
    agentNotify.report({ tabId: 1, v: 1, state: 'blocked' })
    agentNotify.report({ tabId: 2, v: 1, state: 'idle', done: true })
    expect(tab(2).badge).toBe('done')

    // 模拟 TabManager.close():先摘 record 再发 tab-closed(这里直接发事件看清理结果)
    const badgeCalls = tab(2).setBadgeCalls
    agentNotify.tabClosed(1)
    agentNotify.tabClosed(2)

    expect(notify.isClosed(0)).toBe(true)
    // 定时器被取消:到点不会再写角标(否则 resolve(2) 仍会命中,调用数会涨)
    clock.advance(AGENT_DONE_BADGE_MS * 2)
    expect(tab(2).setBadgeCalls).toBe(badgeCalls)
  })
})
