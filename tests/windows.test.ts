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
import type { WindowRole } from '../src/main/windows'

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

function makeCtx(
  manager: InstanceType<typeof WindowManager>,
  tabs: InstanceType<typeof FakeTabs>,
  overlayWc?: object,
  toastsWc?: object,
  role?: WindowRole
) {
  const win = new FakeWin()
  const overlay = {
    hasWebContents: (wc: unknown) => overlayWc != null && wc === overlayWc
  }
  // 通知视图与 overlay 平级,byWebContents 也要认得它(通知页面的 IPC 靠这条路由)
  const toasts = { hasWebContents: (wc: unknown) => toastsWc != null && wc === toastsWc }
  const ctx = manager.register(win as never, tabs as never, overlay as never, toasts as never, role)
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

  it('byWebContents 认出 chrome / overlay / 通知视图 / 标签视图,认不出返回 null', () => {
    const m = new WindowManager()
    const tabsA = new FakeTabs()
    const overlayWc = { id: -1 }
    const toastsWc = { id: -2 }
    const a = makeCtx(m, tabsA, overlayWc, toastsWc)
    const tab = tabsA.create('https://a.example/')
    const tabWc = tabsA.getView(tab.id)!.view.webContents

    expect(m.byWebContents(a.win.webContents as never)?.id).toBe(1)
    expect(m.byWebContents(overlayWc as never)?.id).toBe(1)
    expect(m.byWebContents(toastsWc as never)?.id).toBe(1)
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

describe('WindowManager:窗口角色与 MCP 专属窗口', () => {
  it('register 默认是 user;显式传 agent 才标为 agent', () => {
    const m = new WindowManager()
    const a = makeCtx(m, new FakeTabs())
    const b = makeCtx(m, new FakeTabs(), undefined, undefined, 'agent')
    expect(a.ctx.role).toBe('user')
    expect(b.ctx.role).toBe('agent')
    expect(m.agentWindow()?.id).toBe(b.ctx.id)
  })

  it('只有 user 窗口时 agentWindow 返回 null(不创建、不复用用户窗口)', () => {
    const m = new WindowManager()
    const u = makeCtx(m, new FakeTabs())
    expect(m.agentWindow()).toBeNull()
    expect(m.agentWindow()?.id).not.toBe(u.ctx.id)
  })

  it('createAgentWindow 走注入的工厂并设为默认窗口;没有工厂则返回 null', () => {
    const tabs = new FakeTabs()
    const m = new WindowManager({
      createWindow: (_targets, role) =>
        m.register(
          new FakeWin() as never,
          tabs as never,
          { hasWebContents: () => false } as never,
          { hasWebContents: () => false } as never,
          role
        )
    })
    makeCtx(m, new FakeTabs()) // 用户窗口 id=1
    const ctx = m.createAgentWindow(['https://x.example/'])
    expect(ctx?.role).toBe('agent')
    expect(m.agentWindow()?.id).toBe(ctx?.id)
    expect(m.byId(ctx!.id)).not.toBeNull()
  })

  it('没有 createWindow 能力时 createAgentWindow 返回 null(假注册表路径)', () => {
    const m = new WindowManager()
    makeCtx(m, new FakeTabs())
    expect(m.createAgentWindow()).toBeNull()
    expect(m.agentWindow()).toBeNull()
  })

  it('agent 窗口关掉后 agentWindow 回退到另一个 agent 窗口 / null', () => {
    const m = new WindowManager()
    const a = makeCtx(m, new FakeTabs(), undefined, undefined, 'agent')
    const b = makeCtx(m, new FakeTabs(), undefined, undefined, 'agent')
    expect(m.agentWindow()?.id).toBe(b.ctx.id) // 最近登记的
    b.win.emit('closed')
    expect(m.agentWindow()?.id).toBe(a.ctx.id)
    a.win.emit('closed')
    expect(m.agentWindow()).toBeNull()
  })

  it('markAgentActive 在 agent 窗口之间切换;指针指向 user 窗口时回退到 agent 窗口', () => {
    const m = new WindowManager()
    const a = makeCtx(m, new FakeTabs(), undefined, undefined, 'agent')
    const b = makeCtx(m, new FakeTabs(), undefined, undefined, 'agent')
    const u = makeCtx(m, new FakeTabs())
    expect(m.agentWindow()?.id).toBe(b.ctx.id)
    m.markAgentActive(a.ctx)
    expect(m.agentWindow()?.id).toBe(a.ctx.id)
    m.markAgentActive(u.ctx)
    expect(m.agentWindow()?.id).toBe(b.ctx.id)
    expect(m.agentWindow()?.role).toBe('agent')
  })

  it('agentWindow 不受 OS 焦点 / markActive 影响(MCP 默认目标不随用户点击改变)', () => {
    const m = new WindowManager()
    const u = makeCtx(m, new FakeTabs())
    const a = makeCtx(m, new FakeTabs(), undefined, undefined, 'agent')
    expect(m.agentWindow()?.id).toBe(a.ctx.id)
    m.markActive(u.ctx)
    u.win.emit('focus')
    expect(m.focused()?.id).toBe(u.ctx.id) // 用户侧默认窗口 = 聚焦窗口
    expect(m.agentWindow()?.id).toBe(a.ctx.id) // MCP 侧不受影响
  })
})
