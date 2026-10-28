/**
 * 代理状态纯逻辑:OSC 信号解析 + 角标映射 + 通知文案。
 *
 * 这些用例是本方案最值钱的一层 —— 协议边界(pty 的 chunk 切分、非本协议序列必须原样放行、
 * 坏负载不能吞文本、`9;4` 降级)全在这里,任何一条回归都表现为「终端里冒出乱码」或「通知弹错/不消」。
 */

import { describe, expect, it } from 'vitest'
import { AGENT_DONE_BADGE_MS, BOW_OSC_PREFIX, MAX_AGENT_CWD, OscSignalParser, badgeOfSignal, notificationCopy } from '../src/shared/agentState'

const BEL = '\x07'
const ST = '\x1b\\'

function sig(payload: Record<string, unknown>): string {
  return `${BOW_OSC_PREFIX}${JSON.stringify(payload)}${BEL}`
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

  it('cwd 原样带回(两端去空白、超长截断、空白丢弃)', () => {
    const p = new OscSignalParser()
    expect(p.feed(sig({ v: 1, state: 'working', cwd: ' /home/u/proj ' })).signals[0]).toEqual({
      v: 1,
      state: 'working',
      cwd: '/home/u/proj'
    })
    expect(p.feed(sig({ v: 1, state: 'working', cwd: `/${'x'.repeat(2000)}` })).signals[0]?.cwd).toHaveLength(
      MAX_AGENT_CWD
    )
    expect(p.feed(sig({ v: 1, state: 'idle', cwd: '   ' })).signals[0]).toEqual({ v: 1, state: 'idle' })
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

describe('OscSignalParser:shell 的 cwd 序列(OSC 7 / 9;9)', () => {
  it('OSC 7 解出百分号编码后的路径,并从文本里剥掉', () => {
    const p = new OscSignalParser()
    const r = p.feed('a\x1b]7;file://host/home/u/my%20dir\x07b')
    expect(r.cwd).toBe('/home/u/my dir')
    expect(r.text).toBe('ab')
  })

  it('host 为空(file:///…)与 ST 终止符都认;Windows 形式的 /C:/ 去掉前导斜杠', () => {
    const p = new OscSignalParser()
    expect(p.feed('\x1b]7;file:///home/u\x1b\\').cwd).toBe('/home/u')
    expect(p.feed('\x1b]7;file:///C:/Users/u\x07').cwd).toBe('C:/Users/u')
  })

  it('OSC 9;9(Windows Terminal)也能拿到;不是 file: 的 7 系列与坏编码不会抛', () => {
    const p = new OscSignalParser()
    expect(p.feed('\x1b]9;9;C:\\Users\\u\x07').cwd).toBe('C:\\Users\\u')
    expect(p.feed('\x1b]7;not-a-url\x07').cwd).toBeUndefined()
    expect(p.feed('\x1b]7;file:///bad%ZZ\x07').cwd).toBe('/bad%ZZ')
  })

  it('一条序列被切成两个 chunk 也能拼起来(和信号同一条通路)', () => {
    const p = new OscSignalParser()
    const raw = '\x1b]7;file:///home/u/proj\x07'
    expect(p.feed(raw.slice(0, 10)).cwd).toBeUndefined()
    expect(p.feed(raw.slice(10)).cwd).toBe('/home/u/proj')
  })

  it('没看到 cwd 序列时不出现这个键(旧用例的 toEqual 不受影响)', () => {
    const p = new OscSignalParser()
    expect('cwd' in p.feed('hello')).toBe(false)
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

// ---------- ③ 通知文案 ----------

describe('notificationCopy', () => {
  it('blocked 把对话框标题与会话标签都带上;done 用会话标签', () => {
    expect(
      notificationCopy('blocked', { v: 1, state: 'blocked', title: '切换到 build？', text: 'π - bow - repo' })
    ).toEqual({
      title: 'pi 需要确认',
      text: '切换到 build？ · π - bow - repo'
    })
    expect(notificationCopy('blocked', { v: 1, state: 'blocked', text: 'π - bow - repo' })).toEqual({
      title: 'pi 需要确认',
      text: 'π - bow - repo'
    })
    expect(notificationCopy('done', { v: 1, state: 'idle', done: true, agent: 'claude', text: 'π - bow' })).toEqual({
      title: 'claude 已完成',
      text: 'π - bow'
    })
    expect(notificationCopy('done', { v: 1, state: 'idle', done: true })).toEqual({ title: 'pi 已完成' })
  })
})
