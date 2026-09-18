/**
 * 关闭窗口确认(main/closeConfirm.ts)的拦截规则。
 *
 * 用假 window(EventEmitter)+ FakeTabs + 假 Overlay 覆盖五条判据:
 * 标签数不足放行 / 拦下弹框 / 确认后放行 / 取消不是永久放行 / 二次触发强制放行。
 * electron 只需 mock `app`(logger 在非 MCP 模式下不会真的碰它,import 时却要有)。
 */

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0' } }))

const { installCloseConfirm, confirmWindowClose, CLOSE_CONFIRM_OVERLAY_ID } = await import('../src/main/closeConfirm')
const { FakeTabs } = await import('./fakeTabs')

class FakeWindow extends EventEmitter {
  closeCalls = 0
  /** 最近一次触发 close 时是否被 preventDefault */
  lastPrevented = false

  isDestroyed(): boolean {
    return false
  }

  /** 等价于 Electron 的 win.close():触发 close 事件(处理器可以拦下) */
  close(): void {
    this.closeCalls++
    attemptClose(this)
  }
}

function attemptClose(win: FakeWindow): boolean {
  let prevented = false
  win.emit('close', {
    preventDefault: () => {
      prevented = true
    }
  })
  win.lastPrevented = prevented
  return prevented
}

class FakeOverlay {
  currentId: string | null = null
  shown: Array<{ id: string; payload: unknown; placement: string }> = []

  show(content: { id: string; payload: unknown; placement: string } | null): void {
    this.currentId = content?.id ?? null
    if (content) this.shown.push(content)
  }
}

function setup(tabCount: number, opts: { internal?: number } = {}) {
  const win = new FakeWindow()
  const tabs = new FakeTabs()
  const overlay = new FakeOverlay()
  const internalCount = opts.internal ?? 0
  for (let i = 0; i < tabCount - internalCount; i++) tabs.create(`https://example.com/${i}`)
  for (let i = 0; i < internalCount; i++) tabs.create('bow://settings', true, true)
  installCloseConfirm(win as never, tabs as never, overlay as never)
  return { win, tabs, overlay }
}

describe('关闭窗口确认', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('0 / 1 个标签:不拦,直接关', () => {
    for (const count of [0, 1]) {
      const { win, overlay } = setup(count)
      expect(attemptClose(win)).toBe(false)
      expect(overlay.shown).toEqual([])
    }
  })

  it('2 个标签:拦下并弹确认框(payload 带标签数,full placement)', () => {
    const { win, overlay } = setup(2)
    expect(attemptClose(win)).toBe(true)
    expect(overlay.currentId).toBe(CLOSE_CONFIRM_OVERLAY_ID)
    expect(overlay.shown).toEqual([
      { id: CLOSE_CONFIRM_OVERLAY_ID, payload: { tabCount: 2 }, placement: 'full' }
    ])
  })

  it('计数口径:设置页等内部标签也计入', () => {
    const { win, overlay } = setup(2, { internal: 1 })
    expect(attemptClose(win)).toBe(true)
    expect(overlay.shown[0].payload).toEqual({ tabCount: 2 })
  })

  it('确认后放行:close() 真的执行,且随后的 close 事件不再被拦', () => {
    const { win, overlay } = setup(3)
    attemptClose(win)
    confirmWindowClose(win as never)
    expect(win.closeCalls).toBe(1)
    expect(win.lastPrevented).toBe(false)
    expect(attemptClose(win)).toBe(false)
    expect(overlay.shown).toHaveLength(1)
  })

  it('取消(浮层关闭)不是永久放行:再次触发关闭仍会弹确认框', () => {
    const { win, overlay } = setup(2)
    attemptClose(win)
    overlay.show(null) // 通用 close-request 分支的行为
    expect(attemptClose(win)).toBe(true)
    expect(overlay.shown).toHaveLength(2)
  })

  it('确认框开着时再次触发关闭(Alt+F4 / 窗口管理器)= 强制放行', () => {
    const { win, overlay } = setup(2)
    attemptClose(win)
    expect(attemptClose(win)).toBe(false)
    expect(overlay.shown).toHaveLength(1) // 不重复弹
  })
})
