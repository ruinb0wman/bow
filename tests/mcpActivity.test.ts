/**
 * MCP 调用活动跟踪单测。
 *
 * 这是地址栏状态灯「调用中变蓝」的数据源,关键性质:
 * 计数必须成对归零(异常路径也不能卡在调用中)、工具名与累计次数按调用记录。
 */

import { describe, expect, it, vi } from 'vitest'
import { McpActivityTracker } from '../src/main/mcpActivity'

describe('McpActivityTracker', () => {
  it('初始快照全为零', () => {
    expect(new McpActivityTracker().snapshot()).toEqual({
      inFlight: 0,
      calls: 0,
      lastTool: null,
      lastAt: null
    })
  })

  it('beginTool 的离开函数幂等,重复调用不会把计数减成负数', () => {
    const t = new McpActivityTracker()
    const leave = t.beginTool('browser_click')
    expect(t.snapshot().inFlight).toBe(1)
    leave()
    expect(t.snapshot().inFlight).toBe(0)
    expect(t.snapshot().lastAt).not.toBeNull()
    leave()
    expect(t.snapshot().inFlight).toBe(0)
  })

  it('嵌套的工具调用逐个归零(并行调用互不影响)', () => {
    const t = new McpActivityTracker()
    const a = t.beginTool('browser_navigate')
    const b = t.beginTool('browser_snapshot')
    expect(t.snapshot().inFlight).toBe(2)
    a()
    expect(t.snapshot().inFlight).toBe(1)
    b()
    expect(t.snapshot().inFlight).toBe(0)
  })

  it('只有工具调用会进入「调用中」:traker 没有非工具的活动入口', () => {
    // 回归护栏:曾经把 HTTP 请求也算作活动,而 StreamableHTTP 客户端会挂一条长驻 GET SSE 流,
    // 结果状态灯一连接就永远停在蓝色。现在活动只能来自 beginTool/wrapTool。
    const t = new McpActivityTracker()
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(t)).sort()).toEqual([
      'beginTool',
      'constructor',
      'emit',
      'onChange',
      'snapshot',
      'wrapTool'
    ])
  })

  it('beginTool 累计次数并记录最近工具名', () => {
    const t = new McpActivityTracker()
    t.beginTool('browser_snapshot')()
    t.beginTool('browser_click')()
    expect(t.snapshot()).toMatchObject({ inFlight: 0, calls: 2, lastTool: 'browser_click' })
  })

  it('wrapTool 无论成功、抛错还是异步都保证退出调用中', async () => {
    const t = new McpActivityTracker()
    await expect(t.wrapTool('ok', () => 'r')).resolves.toBe('r')
    expect(t.snapshot().inFlight).toBe(0)

    await expect(
      t.wrapTool('boom', () => {
        throw new Error('nope')
      })
    ).rejects.toThrow('nope')
    expect(t.snapshot().inFlight).toBe(0)

    await expect(t.wrapTool('later', () => Promise.resolve(1))).resolves.toBe(1)
    expect(t.snapshot()).toMatchObject({ inFlight: 0, calls: 3 })
  })

  it('wrapTool 在异步期间保持调用中(状态灯有稳定的蓝色窗口)', async () => {
    const t = new McpActivityTracker()
    let release!: (v: number) => void
    const p = t.wrapTool('slow', () => new Promise<number>((r) => (release = r)))
    expect(t.snapshot()).toMatchObject({ inFlight: 1, lastTool: 'slow' })
    release(7)
    await expect(p).resolves.toBe(7)
    expect(t.snapshot().inFlight).toBe(0)
  })

  it('onChange 在进入/离开时各触发一次,取消订阅后不再触发', () => {
    const t = new McpActivityTracker()
    const seen: number[] = []
    const off = t.onChange((s) => seen.push(s.inFlight))
    const leave = t.beginTool('browser_eval')
    leave()
    expect(seen).toEqual([1, 0])
    off()
    t.beginTool('browser_eval')()
    expect(seen).toEqual([1, 0])
  })

  it('订阅者抛错不打断被跟踪的调用', () => {
    const t = new McpActivityTracker()
    t.onChange(() => {
      throw new Error('subscriber bug')
    })
    const spy = vi.fn()
    t.onChange(spy)
    expect(() => t.beginTool('x')()).not.toThrow()
    expect(spy).toHaveBeenCalled()
    expect(t.snapshot().inFlight).toBe(0)
  })
})
