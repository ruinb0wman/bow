/**
 * 页内查找(Ctrl+F):几何纯函数 + 主进程会话状态机。
 *
 * 为什么值得单测:
 * - `findBarRect` 直接决定 overlay 视图的 bounds —— `WebContentsView` 没有点击穿透,
 *   算错的表现是「查找条被裁掉」或「页面右上角一片透明视图吃掉点击」,只能靠真机肉眼发现;
 * - `findBar` 的异步结果 / 迟到请求 / 被别的浮层顶掉,这些分支在真机上很难逐个复现。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => '0.0.0' } }))

import {
  FIND_BAR_HEIGHT,
  FIND_BAR_MARGIN,
  FIND_BAR_MIN_WIDTH,
  FIND_BAR_WIDTH,
  findBarRect
} from '../src/shared/find'
import {
  closeFind,
  handleFindEvent,
  onTabActivated,
  onTabClosed,
  onTabNavigated,
  openFind
} from '../src/main/findBar'
import type { WindowContext } from '../src/main/windows'
import type { OverlayContent } from '../src/shared/types'
import { FakeTabs } from './fakeTabs'

// ---------- 几何 ----------

describe('findBarRect 查找条几何', () => {
  it('常态:贴页面区右上角', () => {
    expect(findBarRect({ windowWidth: 1280, windowHeight: 800, chromeHeight: 70 })).toEqual({
      x: 1280 - FIND_BAR_WIDTH - FIND_BAR_MARGIN,
      y: 70 + FIND_BAR_MARGIN,
      width: FIND_BAR_WIDTH,
      height: FIND_BAR_HEIGHT
    })
  })

  it('窄窗口:宽度取最小可用宽度,右侧仍留白', () => {
    const r = findBarRect({ windowWidth: 200, windowHeight: 600, chromeHeight: 60 })
    expect(r.width).toBe(FIND_BAR_MIN_WIDTH)
    expect(r.x).toBe(FIND_BAR_MARGIN)
  })

  it('chrome 高度很靠底:y 被夹住,不越出窗口', () => {
    const expected = 120 - FIND_BAR_HEIGHT - FIND_BAR_MARGIN
    expect(findBarRect({ windowWidth: 800, windowHeight: 120, chromeHeight: 110 }).y).toBe(expected)
  })

  it('极小窗口不产出负坐标', () => {
    const r = findBarRect({ windowWidth: 100, windowHeight: 50, chromeHeight: 40 })
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.y).toBeGreaterThanOrEqual(0)
    expect(r.width).toBeGreaterThan(0)
    expect(r.height).toBeGreaterThan(0)
  })
})

// ---------- 会话状态机 ----------

class FakeOverlay {
  currentId: string | null = null
  contents: Array<OverlayContent | null> = []
  sent: Array<[string, unknown]> = []

  get isFullOpen(): boolean {
    return this.currentId === 'confirm-close'
  }

  show(content: OverlayContent | null): void {
    this.contents.push(content)
    this.currentId = content?.id ?? null
  }

  send(channel: string, ...args: unknown[]): void {
    this.sent.push([channel, args[0]])
  }
}

function makeCtx(): { ctx: WindowContext; overlay: FakeOverlay; tabs: FakeTabs } {
  const tabs = new FakeTabs()
  tabs.create('https://example.com/', true)
  const overlay = new FakeOverlay()
  const ctx = { id: 1, window: {}, tabs, overlay, toasts: {} } as unknown as WindowContext
  return { ctx, overlay, tabs }
}

describe('findBar 会话状态机', () => {
  it('打开:显示 page-top-right 查找条,目标为来源窗格', () => {
    const { ctx, overlay } = makeCtx()
    openFind(ctx, 1)
    expect(overlay.contents.at(-1)).toMatchObject({
      id: 'find',
      placement: 'page-top-right',
      payload: { query: '', matchCase: false }
    })
    expect(overlay.currentId).toBe('find')
  })

  it('查询 → findNext:false;下一个 → findNext:true;结果推 find:state', () => {
    const { ctx, overlay, tabs } = makeCtx()
    const wc = tabs.getView(1)!.view.webContents
    openFind(ctx, 1)

    handleFindEvent(ctx, { id: 'find', event: 'query', args: { text: 'foo', matchCase: false } })
    expect(wc.findCalls).toEqual([
      { text: 'foo', options: { forward: true, findNext: false, matchCase: false } }
    ])

    wc.emitFoundInPage({ requestId: 1, activeMatchOrdinal: 2, matches: 5, finalUpdate: true })
    expect(overlay.sent.at(-1)).toEqual([
      'find:state',
      { requestId: 1, matches: 5, activeMatchOrdinal: 2, finalUpdate: true }
    ])

    handleFindEvent(ctx, { id: 'find', event: 'next', args: { forward: false } })
    expect(wc.findCalls.at(-1)!.options).toEqual({ forward: false, findNext: true, matchCase: false })
  })

  it('matchCase 开关进入 findInPage', () => {
    const { ctx, tabs } = makeCtx()
    const wc = tabs.getView(1)!.view.webContents
    openFind(ctx, 1)
    handleFindEvent(ctx, { id: 'find', event: 'query', args: { text: 'Foo', matchCase: true } })
    expect(wc.findCalls.at(-1)!.options).toMatchObject({ matchCase: true })
  })

  it('迟到的旧 requestId 被丢弃', () => {
    const { ctx, overlay, tabs } = makeCtx()
    const wc = tabs.getView(1)!.view.webContents
    openFind(ctx, 1)
    handleFindEvent(ctx, { id: 'find', event: 'query', args: { text: 'foo', matchCase: false } })
    overlay.sent.length = 0
    wc.emitFoundInPage({ requestId: 999, activeMatchOrdinal: 1, matches: 9, finalUpdate: true })
    expect(overlay.sent).toEqual([])
    wc.emitFoundInPage({ requestId: 1, activeMatchOrdinal: 1, matches: 2, finalUpdate: true })
    expect(overlay.sent).toHaveLength(1)
  })

  it('查找条被别的浮层替换后不再推结果(不把别的浮层顶掉)', () => {
    const { ctx, overlay, tabs } = makeCtx()
    const wc = tabs.getView(1)!.view.webContents
    openFind(ctx, 1)
    handleFindEvent(ctx, { id: 'find', event: 'query', args: { text: 'foo', matchCase: false } })
    overlay.show({ id: 'suggest', placement: 'below-chrome', payload: {} as never })
    overlay.sent.length = 0
    wc.emitFoundInPage({ requestId: 1, activeMatchOrdinal: 1, matches: 2, finalUpdate: true })
    expect(overlay.sent).toEqual([])
  })

  it('清空查询:停止查找并推 0/0', () => {
    const { ctx, overlay, tabs } = makeCtx()
    const wc = tabs.getView(1)!.view.webContents
    openFind(ctx, 1)
    handleFindEvent(ctx, { id: 'find', event: 'query', args: { text: 'foo', matchCase: false } })
    handleFindEvent(ctx, { id: 'find', event: 'query', args: { text: '', matchCase: false } })
    expect(wc.stopFindCalls).toContain('clearSelection')
    expect(overlay.sent.at(-1)).toEqual([
      'find:state',
      { requestId: 1, matches: 0, activeMatchOrdinal: 0, finalUpdate: true }
    ])
  })

  it('关闭:清高亮 + 关浮层', () => {
    const { ctx, overlay, tabs } = makeCtx()
    const wc = tabs.getView(1)!.view.webContents
    openFind(ctx, 1)
    closeFind(ctx)
    expect(wc.stopFindCalls).toContain('clearSelection')
    expect(overlay.contents.at(-1)).toBe(null)
  })

  it('同一标签再次 Ctrl+F:refocus,不清空查询', () => {
    const { ctx, overlay, tabs } = makeCtx()
    const wc = tabs.getView(1)!.view.webContents
    openFind(ctx, 1)
    handleFindEvent(ctx, { id: 'find', event: 'query', args: { text: 'foo', matchCase: false } })
    overlay.sent.length = 0
    openFind(ctx, 1)
    expect(overlay.sent.at(-1)).toEqual(['find:state', { refocus: true }])
    expect(wc.findCalls).toHaveLength(1) // 没有重新发起查询
    expect(overlay.currentId).toBe('find')
  })

  it('切到别的标签 / 导航 / 关标签都收起查找条', () => {
    for (const fire of [
      (ctx: WindowContext) => onTabActivated(ctx, 2),
      (ctx: WindowContext) => onTabNavigated(ctx, 1),
      (ctx: WindowContext) => onTabClosed(ctx, 1)
    ]) {
      const { ctx, overlay } = makeCtx()
      openFind(ctx, 1)
      fire(ctx)
      expect(overlay.contents.at(-1)).toBe(null)
    }
  })

  it('激活的还是同一个标签时不收起', () => {
    const { ctx, overlay } = makeCtx()
    openFind(ctx, 1)
    onTabActivated(ctx, 1)
    expect(overlay.currentId).toBe('find')
  })

  it('全窗浮层开着(replace)时不打开', () => {
    const { ctx, overlay } = makeCtx()
    overlay.show({ id: 'confirm-close', placement: 'full', payload: { tabCount: 2 } })
    openFind(ctx, 1)
    expect(overlay.contents).toHaveLength(1) // 只剩那条 confirm-close
  })
})
