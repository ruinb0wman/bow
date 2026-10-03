/**
 * ToastManager:底部居中通知视图的 bounds 数学与生命周期。
 *
 * 为什么值得单测:`WebContentsView` **不能点击穿透**(见 `main/toasts.ts` 顶部),所以这个视图的
 * bounds 必须刚好包住卡片 —— 算错的表现是「通知被裁掉」或「底部一片透明视图把页面点击吃掉」,
 * 两者都只能靠真机肉眼发现。这里用假 electron(BrowserWindow / WebContentsView)把几何与
 * 生命周期钉住,真机 E2E(`npm run test:e2e:agent`)再验一次端到端。
 */

import { describe, expect, it, vi } from 'vitest'

class FakeWc {
  readonly sent: Array<[string, unknown]> = []
  readonly handlers = new Map<string, Array<(...args: never[]) => void>>()
  destroyed = false
  loaded: string | null = null

  send(channel: string, payload?: unknown): void {
    this.sent.push([channel, payload])
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.destroyed = true
  }

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
  }

  loadURL(url: string): void {
    this.loaded = url
  }

  loadFile(file: string): void {
    this.loaded = file
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args)
  }

  last(channel: string): unknown {
    return [...this.sent].reverse().find(([c]) => c === channel)?.[1]
  }
}

class FakeView {
  readonly webContents = new FakeWc()
  bounds: { x: number; y: number; width: number; height: number } | null = null
  visible = false
  background: string | null = null

  setBackgroundColor(color: string): void {
    this.background = color
  }

  setVisible(value: boolean): void {
    this.visible = value
  }

  setBounds(bounds: FakeView['bounds']): void {
    this.bounds = bounds
  }
}

class FakeWindow {
  contentSize: [number, number] = [1200, 800]
  destroyed = false
  readonly children: FakeView[] = []
  readonly handlers = new Map<string, Array<(...args: never[]) => void>>()

  readonly contentView = {
    addChildView: (view: FakeView): void => {
      const at = this.children.indexOf(view)
      if (at >= 0) this.children.splice(at, 1)
      this.children.push(view) // 重新 add = 置顶(与 Electron 的文档行为一致)
    },
    removeChildView: (view: FakeView): void => {
      const at = this.children.indexOf(view)
      if (at >= 0) this.children.splice(at, 1)
    }
  }

  getContentSize(): [number, number] {
    return this.contentSize
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(cb)
    this.handlers.set(event, list)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) (cb as (...a: unknown[]) => void)(...args)
  }
}

const created: FakeView[] = []
vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {
    constructor() {
      const view = new FakeView()
      created.push(view)
      return view as unknown as object
    }
  }
}))

const { ToastManager, TOAST_MARGIN, TOAST_WIDTH } = await import('../src/main/toasts')
type AgentToastItem = import('../src/shared/agentState').AgentToastItem

const item = (id: string, tabId = 1, kind: AgentToastItem['kind'] = 'blocked'): AgentToastItem => ({
  id,
  tabId,
  kind,
  agent: 'pi',
  title: kind === 'blocked' ? 'pi 需要确认' : 'pi 已完成',
  text: 'π - repo',
  at: 1
})

function make() {
  created.length = 0
  const win = new FakeWindow()
  const manager = new ToastManager(win as never)
  return { win, manager, view: () => created.at(-1)! }
}

describe('ToastManager:bounds 与可见性', () => {
  it('没有通知时不建视图、不占任何区域', () => {
    const { manager } = make()
    manager.set([])
    expect(created).toHaveLength(0)
  })

  it('首条通知:底部居中,高度先用估算值(渲染层还没量)', () => {
    const { manager, view } = make()
    manager.set([item('a')])
    expect(view().visible).toBe(true)
    expect(view().bounds).toEqual({
      x: (1200 - TOAST_WIDTH) / 2,
      y: 800 - 104 - TOAST_MARGIN,
      width: TOAST_WIDTH,
      height: 104
    })
    expect(view().background).toBe('#00000000') // 透明:只露出卡片
    expect(view().webContents.last('toast:show')).toEqual({ items: [item('a')] })
  })

  it('渲染层量出的高度说了算(可以比估算小 —— 否则会白挡一片区域)', () => {
    const { manager, view } = make()
    manager.set([item('a')])
    manager.setHeight(72)
    expect(view().bounds?.height).toBe(72)
    expect(view().bounds?.y).toBe(800 - 72 - TOAST_MARGIN)
  })

  it('条数变了就不采信旧实测,先回到估算', () => {
    const { manager, view } = make()
    manager.set([item('a')])
    manager.setHeight(72)
    manager.set([item('a'), item('b', 2, 'done')])
    expect(view().bounds?.height).toBe(208)
    manager.setHeight(160)
    expect(view().bounds?.height).toBe(160)
  })

  it('窄窗口不会把通知挤出屏幕', () => {
    const { manager, view, win } = make()
    win.contentSize = [300, 400]
    manager.set([item('a')])
    expect(view().bounds?.width).toBe(300 - TOAST_MARGIN * 2)
    expect(view().bounds?.x).toBe(TOAST_MARGIN)
    // 高度也不能超过窗口
    manager.setHeight(9999)
    expect(view().bounds?.height).toBe(400 - TOAST_MARGIN * 2)
  })

  it('窗口 resize 后自动重排', () => {
    const { manager, view, win } = make()
    manager.set([item('a')])
    win.contentSize = [800, 600]
    win.emit('resize')
    expect(view().bounds?.x).toBe((800 - TOAST_WIDTH) / 2)
    expect(view().bounds?.y).toBe(600 - 104 - TOAST_MARGIN)
  })

  it('set([]) 只隐藏、不销毁视图(下次还能复用),并把空栈同步给渲染层', () => {
    const { manager, view } = make()
    manager.set([item('a')])
    const handle = view()
    handle.webContents.sent.length = 0
    manager.set([])
    expect(handle.visible).toBe(false)
    expect(handle.webContents.destroyed).toBe(false)
    expect(handle.webContents.last('toast:show')).toEqual({ items: [] })
    manager.set([item('b')])
    expect(view()).toBe(handle)
    expect(handle.visible).toBe(true)
  })

  it('raise() 把自己重新置顶(新标签视图 / 浮层之后必须重抬)', () => {
    const { manager, view, win } = make()
    manager.set([item('a')])
    const other = new FakeView()
    win.contentView.addChildView(other)
    expect(win.children.at(-1)).toBe(other)
    manager.raise()
    expect(win.children.at(-1)).toBe(view())
  })

  it('hasWebContents 认出自己的视图(byWebContents 路由通知页面的 IPC 靠它)', () => {
    const { manager, view } = make()
    manager.set([item('a')])
    expect(manager.hasWebContents(view().webContents as never)).toBe(true)
    expect(manager.hasWebContents(new FakeWc() as never)).toBe(false)
  })

  it('渲染进程崩溃后重建,并把现有通知重新推一次', () => {
    const { manager, view } = make()
    manager.set([item('a')])
    const first = view()
    first.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(first.webContents.destroyed).toBe(true)
    const second = view()
    expect(second).not.toBe(first)
    expect(second.webContents.last('toast:show')).toEqual({ items: [item('a')] })
  })

  it('首次加载完成时补发当前栈(第一次 show 可能错过)', () => {
    const { manager, view } = make()
    manager.set([item('a')])
    const v = view()
    expect(v.webContents.last('toast:show')).toBeTruthy()
    v.webContents.sent.length = 0
    v.webContents.emit('did-finish-load')
    expect(v.webContents.last('toast:show')).toEqual({ items: [item('a')] })
  })

  it('窗口已销毁后 set 是空操作(不能对已销毁窗口建视图)', () => {
    const { manager, win } = make()
    manager.set([item('a')])
    win.emit('closed') // Electron:先是 isDestroyed() === true,随后才发 closed
    win.destroyed = true
    const before = created.length
    expect(() => manager.set([item('b')])).not.toThrow()
    expect(created.length).toBe(before)
    expect(manager.items()).toEqual([])
  })

  it('窗口关闭后清空状态', () => {
    const { manager, win, view } = make()
    manager.set([item('a')])
    const v = view()
    win.emit('closed')
    expect(v.webContents.destroyed).toBe(true)
    expect(manager.items()).toEqual([])
  })
})
