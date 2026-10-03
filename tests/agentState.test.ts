/**
 * 代理状态纯逻辑:OSC 信号解析 + 角标 + 通知栈归约。
 *
 * 这些用例是本方案最值钱的一层 —— 协议边界(pty 的 chunk 切分、非本协议序列必须原样放行、
 * 坏负载不能吞文本、`9;4` 降级)全在这里,任何一条回归都表现为「终端里冒出乱码」或「通知弹错/不消」。
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_DONE_BADGE_MS,
  BOW_OSC_PREFIX,
  MAX_AGENT_TOASTS,
  OscSignalParser,
  badgeOfSignal,
  normalizeAgentSignal,
  reduceToasts,
  toastHeadline,
  toastsWouldChange
} from '../src/shared/agentState'
import type { AgentToastItem, ToastAction, ToastContext } from '../src/shared/agentState'

const BEL = '\x07'
const ST = '\x1b\\'

function sig(payload: Record<string, unknown>): string {
  return `${BOW_OSC_PREFIX}${JSON.stringify(payload)}${BEL}`
}

function ctx(): ToastContext {
  let n = 0
  return { id: () => `t${++n}`, now: () => 1_000_000 + n }
}

function signalAction(tabId: number, payload: Record<string, unknown>, c: ToastContext): ToastAction {
  return { type: 'signal', tabId, signal: normalizeAgentSignal({ v: 1, ...payload })!, id: c.id(), at: c.now() }
}

// ---------- ① 解析 ----------

describe('OscSignalParser:文本与信号的分离', () => {
  it('没有 OSC 时原样返回', () => {
    const p = new OscSignalParser()
    expect(p.feed('hello π\n')).toEqual({ text: 'hello π\n', signals: [], progress: null })
  })

  it('剥掉信号但保留它前后的文本(顺序不变)', () => {
    const p = new OscSignalParser()
    const r = p.feed(`A${sig({ v: 1, state: 'blocked', title: '确认执行 bash' })}B`)
    expect(r.text).toBe('AB')
    expect(r.signals).toEqual([{ v: 1, state: 'blocked', title: '确认执行 bash' }])
  })

  it('一条信号被切成两个 chunk 也能拼起来', () => {
    const p = new OscSignalParser()
    const raw = sig({ v: 1, state: 'idle', done: true })
    const cut = 12
    const first = p.feed(`x${raw.slice(0, cut)}`)
    expect(first.text).toBe('x')
    expect(first.signals).toEqual([])
    const second = p.feed(raw.slice(cut) + 'y')
    expect(second.text).toBe('y')
    expect(second.signals).toEqual([{ v: 1, state: 'idle', done: true }])
  })

  it('一个 chunk 里多条信号按顺序返回', () => {
    const p = new OscSignalParser()
    const r = p.feed(sig({ v: 1, state: 'working' }) + sig({ v: 1, state: 'blocked', title: 'q' }))
    expect(r.text).toBe('')
    expect(r.signals.map((s) => s.state)).toEqual(['working', 'blocked'])
  })

  it('中文 / 引号 / 分号都靠 JSON 逃逸,不需要额外转义', () => {
    const p = new OscSignalParser()
    const title = '“危险”;rm -rf / 与 emoji 🚀'
    const r = p.feed(sig({ v: 1, state: 'blocked', title }))
    expect(r.signals[0]?.title).toBe(title)
  })

  it('ST(ESC \\) 也能作终止符', () => {
    const p = new OscSignalParser()
    const r = p.feed(`${BOW_OSC_PREFIX}${JSON.stringify({ v: 1, state: 'working' })}${ST}`)
    expect(r.text).toBe('')
    expect(r.signals).toHaveLength(1)
  })

  it('非本协议的 OSC 原样放行(标题 / 超链接不能被我们吃掉)', () => {
    const p = new OscSignalParser()
    const title = '\x1b]0;my-title\x07'
    const link = '\x1b]8;;https://example.com\x07link\x1b]8;;\x07'
    const r = p.feed(`${title}${link}`)
    expect(r.text).toBe(`${title}${link}`)
    expect(r.signals).toEqual([])
  })

  it('JSON 坏掉 / 版本不认识 / state 不认识:整条吃掉,不吐信号(也不吞周围文本)', () => {
    const p = new OscSignalParser()
    const bad = `${BOW_OSC_PREFIX}{oops${BEL}`
    const future = sig({ v: 99, state: 'working' })
    const unknownState = sig({ v: 1, state: 'sleeping' })
    const r = p.feed(`a${bad}b${future}c${unknownState}d`)
    expect(r.text).toBe('abcd')
    expect(r.signals).toEqual([])
  })

  it('working/blocked 上带 done 一律忽略(避免「边跑边弹完成」)', () => {
    const p = new OscSignalParser()
    const r = p.feed(sig({ v: 1, state: 'working', done: true }))
    expect(r.signals).toEqual([{ v: 1, state: 'working' }])
  })

  it('永不结束的序列最终当普通文本放行(坏流不能把内存吃掉)', () => {
    const p = new OscSignalParser()
    const junk = `\x1b]1337;bow;${'x'.repeat(5000)}`
    const r = p.feed(junk)
    expect(r.text).toBe(junk)
    expect(r.signals).toEqual([])
    // 放行之后缓冲应已清空,不会滚到下一段
    expect(p.feed('tail').text).toBe('tail')
  })

  it('reset 丢掉半条序列', () => {
    const p = new OscSignalParser()
    p.feed(`${BOW_OSC_PREFIX}{"v":1,`)
    p.reset()
    expect(p.feed('rest').text).toBe('rest')
  })
})

describe('OscSignalParser:pi 内建的进度序列(降级信号)', () => {
  it('9;4;3 → active,9;4;0 → clear,带百分比也算 active', () => {
    const p = new OscSignalParser()
    expect(p.feed('\x1b]9;4;3\x07').progress).toBe('active')
    expect(p.feed('\x1b]9;4;0\x07').progress).toBe('clear')
    expect(p.feed('\x1b]9;4;1;50\x07').progress).toBe('active')
  })

  it('进度序列被吃掉(它已变成 bow 自己的角标数据源,不再交给 xterm)', () => {
    const p = new OscSignalParser()
    const r = p.feed('x\x1b]9;4;3\x07y')
    expect(r.text).toBe('xy')
    expect(r.progress).toBe('active')
  })
})

// ---------- ② 角标 ----------

describe('badgeOfSignal', () => {
  it('blocked / working 直接映射,idle 只在 done 时给角标', () => {
    expect(badgeOfSignal({ v: 1, state: 'blocked' })).toBe('blocked')
    expect(badgeOfSignal({ v: 1, state: 'working' })).toBe('working')
    expect(badgeOfSignal({ v: 1, state: 'idle', done: true })).toBe('done')
    expect(badgeOfSignal({ v: 1, state: 'idle' })).toBeNull()
  })

  it('done 角标有存活时长(常量被主进程用来起定时器)', () => {
    expect(AGENT_DONE_BADGE_MS).toBeGreaterThan(0)
  })
})

// ---------- ③ 通知栈 ----------

describe('reduceToasts', () => {
  it('blocked 入栈;同一标签再来一条 blocked 是替换而不是堆叠', () => {
    const c = ctx()
    let items: AgentToastItem[] = []
    items = reduceToasts(items, signalAction(1, { v: 1, state: 'blocked', title: '第一个' }, c), c)
    expect(items).toHaveLength(1)
    items = reduceToasts(items, signalAction(1, { v: 1, state: 'blocked', title: '第二个' }, c), c)
    expect(items).toHaveLength(1)
    expect(items[0]?.text).toBe('第二个')
  })

  it('blocked → working:撤掉该标签的等待通知(用户答了)', () => {
    const c = ctx()
    let items = reduceToasts([], signalAction(1, { v: 1, state: 'blocked' }, c), c)
    items = reduceToasts(items, signalAction(1, { v: 1, state: 'working' }, c), c)
    expect(items).toEqual([])
  })

  it('idle(非 done)不弹任何东西,但会撤掉 blocked', () => {
    const c = ctx()
    let items = reduceToasts([], signalAction(1, { v: 1, state: 'blocked' }, c), c)
    items = reduceToasts(items, signalAction(1, { v: 1, state: 'idle' }, c), c)
    expect(items).toEqual([])
    items = reduceToasts([], signalAction(1, { v: 1, state: 'idle' }, c), c)
    expect(items).toEqual([])
  })

  it('idle + done 入 done 通知;再来一次是替换', () => {
    const c = ctx()
    let items = reduceToasts([], signalAction(1, { v: 1, state: 'idle', done: true, text: 'π - bow' }, c), c)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('done')
    expect(items[0]?.text).toBe('π - bow')
    items = reduceToasts(items, signalAction(1, { v: 1, state: 'idle', done: true }, c), c)
    expect(items).toHaveLength(1)
  })

  it('done 通知不被随后的 working 抹掉(它是提醒,不是状态)', () => {
    const c = ctx()
    let items = reduceToasts([], signalAction(1, { v: 1, state: 'idle', done: true }, c), c)
    items = reduceToasts(items, signalAction(1, { v: 1, state: 'working' }, c), c)
    expect(items).toHaveLength(1)
  })

  it('不同标签互不影响', () => {
    const c = ctx()
    let items = reduceToasts([], signalAction(1, { v: 1, state: 'blocked' }, c), c)
    items = reduceToasts(items, signalAction(2, { v: 1, state: 'blocked' }, c), c)
    items = reduceToasts(items, signalAction(1, { v: 1, state: 'working' }, c), c)
    expect(items.map((t) => t.tabId)).toEqual([2])
  })

  it('dismiss 按 id 移除;tab-closed 清掉该标签的全部通知', () => {
    const c = ctx()
    let items = reduceToasts([], signalAction(1, { v: 1, state: 'blocked' }, c), c)
    items = reduceToasts(items, signalAction(2, { v: 1, state: 'idle', done: true }, c), c)
    const first = items[0]!
    expect(reduceToasts(items, { type: 'dismiss', id: first.id }, c)).toHaveLength(1)
    expect(reduceToasts(items, { type: 'tab-closed', tabId: 1 }, c).map((t) => t.tabId)).toEqual([2])
  })

  it('超过上限丢最旧的', () => {
    const c = ctx()
    let items: AgentToastItem[] = []
    for (let tab = 1; tab <= MAX_AGENT_TOASTS + 1; tab++) {
      items = reduceToasts(items, signalAction(tab, { v: 1, state: 'blocked' }, c), c)
    }
    expect(items).toHaveLength(MAX_AGENT_TOASTS)
    expect(items.map((t) => t.tabId)).toEqual([2, 3, 4, 5])
  })
})

describe('toastsWouldChange', () => {
  it('只在该动的动作上为真(避免心跳把视图重画)', () => {
    const c = ctx()
    const items = reduceToasts([], signalAction(1, { v: 1, state: 'blocked' }, c), c)
    expect(toastsWouldChange(items, signalAction(1, { v: 1, state: 'blocked' }, c))).toBe(true)
    expect(toastsWouldChange(items, signalAction(1, { v: 1, state: 'working' }, c))).toBe(true)
    expect(toastsWouldChange(items, signalAction(2, { v: 1, state: 'working' }, c))).toBe(false)
    expect(toastsWouldChange(items, signalAction(2, { v: 1, state: 'idle' }, c))).toBe(false)
    expect(toastsWouldChange(items, signalAction(2, { v: 1, state: 'idle', done: true }, c))).toBe(true)
  })
})

describe('toastHeadline', () => {
  it('blocked 把对话框标题与会话标签都带上;done 用会话标签', () => {
    expect(
      toastHeadline('blocked', { v: 1, state: 'blocked', title: '切换到 build？', text: 'π - bow - repo' })
    ).toEqual({
      title: 'pi 需要确认',
      text: '切换到 build？ · π - bow - repo'
    })
    expect(toastHeadline('blocked', { v: 1, state: 'blocked', text: 'π - bow - repo' })).toEqual({
      title: 'pi 需要确认',
      text: 'π - bow - repo'
    })
    expect(toastHeadline('done', { v: 1, state: 'idle', done: true, agent: 'claude', text: 'π - bow' })).toEqual({
      title: 'claude 已完成',
      text: 'π - bow'
    })
    expect(toastHeadline('done', { v: 1, state: 'idle', done: true })).toEqual({ title: 'pi 已完成' })
  })
})
