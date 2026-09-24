/**
 * WindowManager(多窗口注册表)单测。
 *
 * 守住四条多窗口不变式:
 * - 进程级 tabId/groupId 分配器(全局唯一,窗口间不撞号);
 * - byTabId / allTabs 跨窗口解析,allTabs 每条补 windowId;
 * - byWebContents 能认出 chrome / overlay / 标签视图(IPC 与快捷键路由的基础);
 * - focused 在无 OS 焦点时回退到最近登记/聚焦的窗口。
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

// WindowManager 默认走 BrowserWindow.getFocusedWindow();这里统一返回 null,测回退路径
vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null } }))

const { WindowManager } = await import('../src/main/windows')
const { FakeTabs } = await import('./fakeTabs')

class FakeWin extends EventEmitter {
  webContents = { id: Math.random() }
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  focus(): void {}
}

function makeCtx(manager: InstanceType<typeof WindowManager>, tabs: InstanceType<typeof FakeTabs>, overlayWc?: object) {
  const win = new FakeWin()
  const overlay = {
    hasWebContents: (wc: unknown) => overlayWc != null && wc === overlayWc
  }
  const ctx = manager.register(win as never, tabs as never, overlay as never)
  return { ctx, win }
}

describe('WindowManager:多窗口注册表', () => {
  it('窗口 id 与 tabId/groupId 分配器都是进程级(全局唯一)', () => {
    const m = new WindowManager()
    const a = makeCtx(m, new FakeTabs())
    const b = makeCtx(m, new FakeTabs())
    expect([a.ctx.id, b.ctx.id]).toEqual([1, 2])
    expect([m.ids.allocTabId(), m.ids.allocTabId(), m.ids.allocTabId()]).toEqual([1, 2, 3])
    expect([m.ids.allocGroupId(), m.ids.allocGroupId()]).toEqual([1, 2])
  })

  it('focused 在无 OS 焦点时回退到最近聚焦/登记的窗口', () => {
    const m = new WindowManager()
    const a = makeCtx(m, new FakeTabs())
    const b = makeCtx(m, new FakeTabs())
    expect(m.focused()?.id).toBe(b.ctx.id)
    a.win.emit('focus') // 模拟 A 拿到 OS 焦点
    expect(m.focused()?.id).toBe(a.ctx.id)
  })

  it('markActive 显式指定默认窗口,真实 focus 事件一到就失效', () => {
    const m = new WindowManager()
    const a = makeCtx(m, new FakeTabs())
    const b = makeCtx(m, new FakeTabs())
    m.markActive(a.ctx) // 模拟 browser_switch_tab:Wayland 下 focus() 被拒也能改默认窗口
    expect(m.focused()?.id).toBe(a.ctx.id)
    b.win.emit('focus') // 用户手动切到 B → 显式指定失效
    expect(m.focused()?.id).toBe(b.ctx.id)
  })

  it('byTabId / allTabs 跨窗口解析,allTabs 补 windowId', () => {
    const m = new WindowManager()
    const tabsA = new FakeTabs()
    const tabsB = new FakeTabs()
    tabsB.nextId = 100 // 模拟全局唯一 id(真实由分配器保证)
    makeCtx(m, tabsA)
    makeCtx(m, tabsB)
    const ta = tabsA.create('https://a.example/')
    const tb = tabsB.create('https://b.example/')

    expect(m.byTabId(ta.id)?.ctx.id).toBe(1)
    expect(m.byTabId(tb.id)?.ctx.id).toBe(2)
    expect(m.byTabId(9999)).toBeNull()
    expect(m.allTabs().map((t) => [t.id, t.windowId])).toEqual([
      [ta.id, 1],
      [tb.id, 2]
    ])
  })

  it('byWebContents 认出 chrome / overlay / 标签视图,认不出返回 null', () => {
    const m = new WindowManager()
    const tabsA = new FakeTabs()
    const overlayWc = { id: -1 }
    const a = makeCtx(m, tabsA, overlayWc)
    const tab = tabsA.create('https://a.example/')
    const tabWc = tabsA.getView(tab.id)!.view.webContents

    expect(m.byWebContents(a.win.webContents as never)?.id).toBe(1)
    expect(m.byWebContents(overlayWc as never)?.id).toBe(1)
    expect(m.byWebContents(tabWc as never)?.id).toBe(1)
    expect(m.byWebContents({ id: -999 } as never)).toBeNull()
  })

  it('窗口 closed 后从注册表移除', () => {
    const m = new WindowManager()
    const a = makeCtx(m, new FakeTabs())
    expect(m.count).toBe(1)
    a.win.emit('closed')
    expect(m.count).toBe(0)
    expect(m.byId(a.ctx.id)).toBeNull()
  })
})
