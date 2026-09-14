/**
 * 单实例启动策略测试。
 *
 * 重点是两条不能错的边界:
 * - stdio 模式**必须**允许并存(否则 MCP 客户端拉起的子进程会立刻退出);
 * - 拿不到锁时必须真的退出,不能继续建窗口(否则单实例形同虚设)。
 */

import { describe, expect, it } from 'vitest'
import { acquireSingletonLock, focusFirstWindow } from '../src/main/singleInstance'

describe('单实例锁:获取策略', () => {
  it('普通启动:拿到锁继续,拿不到就退出', () => {
    expect(acquireSingletonLock({ isStdio: false, requestLock: () => true })).toBe(true)
    expect(acquireSingletonLock({ isStdio: false, requestLock: () => false })).toBe(false)
  })

  it('stdio 模式不抢锁,允许与常驻实例并存', () => {
    let asked = false
    const allowed = acquireSingletonLock({
      isStdio: true,
      requestLock: () => {
        asked = true
        return false
      }
    })
    expect(allowed).toBe(true)
    // 连问都不该问:一旦抢锁就会把 MCP 客户端的子进程顶掉
    expect(asked).toBe(false)
  })
})

describe('单实例锁:聚焦已有窗口', () => {
  const fakeWindow = (minimized: boolean) => {
    const calls: string[] = []
    return {
      calls,
      win: {
        isMinimized: () => minimized,
        restore: () => calls.push('restore'),
        show: () => calls.push('show'),
        focus: () => calls.push('focus')
      }
    }
  }

  it('最小化的窗口先还原,再显示并聚焦', () => {
    const { win, calls } = fakeWindow(true)
    expect(focusFirstWindow([win])).toBe(true)
    expect(calls).toEqual(['restore', 'show', 'focus'])
  })

  it('正常窗口不调用 restore', () => {
    const { win, calls } = fakeWindow(false)
    expect(focusFirstWindow([win])).toBe(true)
    expect(calls).toEqual(['show', 'focus'])
  })

  it('没有窗口时返回 false,不抛错', () => {
    expect(focusFirstWindow([])).toBe(false)
  })

  it('只处理第一个窗口(多窗口时不乱抢焦点)', () => {
    const a = fakeWindow(false)
    const b = fakeWindow(true)
    focusFirstWindow([a.win, b.win])
    expect(a.calls).toEqual(['show', 'focus'])
    expect(b.calls).toEqual([])
  })
})
