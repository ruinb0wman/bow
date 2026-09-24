/**
 * 多窗口注册表。
 *
 * 单窗口时代,`index.ts` 里 `tabs` / `overlay` 是模块级单例,`ipc.ts` 直接闭包捕获 `mainWindow`。
 * 多窗口后必须有一个「谁是哪个窗口」的权威:
 *   - 按 webContents 反查窗口(IPC 的 `event.sender`、快捷键的 `contents` 都靠它);
 *   - 按 tabId 反查窗口(MCP / 插件只拿到 tabId);
 *   - 「聚焦窗口」(MCP 省略 tabId、插件 `ctx.tabs.getActive()` 的默认目标);
 *   - **进程级** tabId / groupId 分配器(否则两个窗口各自从 1 编号会撞号)。
 *
 * 本类不负责创建 BrowserWindow —— 窗口的接线(含 `installHooks` 必须先于窗口创建这类时序约束)
 * 留在 `index.ts`,`register()` 只登记已建好的三件套。这样 `WindowManager` 不依赖 Electron 的
 * 窗口创建路径,便于用假对象单测。
 */

import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import type { TabInfo } from '@shared/types'
import type { TabIdAllocator, TabManager, TabRecord } from './tabManager'
import type { OverlayManager } from './overlay'

/** 一个窗口的全部运行时对象(id 进程内唯一) */
export interface WindowContext {
  id: number
  window: BrowserWindow
  tabs: TabManager
  overlay: OverlayManager
}

/** tabId → 所属窗口 + 该标签记录 */
export interface TabResolution {
  ctx: WindowContext
  record: TabRecord
}

/** MCP / 插件内核只依赖这个窄接口(便于测试注入 FakeWindows) */
export interface WindowRegistry {
  byId(id: number): WindowContext | null
  byTabId(tabId: number): TabResolution | null
  focused(): WindowContext | null
  /**
   * 显式指定「MCP / 插件后续操作的默认窗口」(browser_switch_tab 用)。
   * 必须在 Wayland 上靠它:窗口管理器可能拒绝 `window.focus()`,单靠 OS 焦点改不了默认窗口。
   * 下一次真实 focus 事件到来即失效(用户手动切窗口优先)。
   */
  markActive(ctx: WindowContext): void
  /** 所有窗口的标签汇总,每条补上 `windowId` */
  allTabs(): TabInfo[]
}

export interface WindowManagerDeps {
  /** 覆盖「当前聚焦窗口」的判定(测试用);默认走 `BrowserWindow.getFocusedWindow()` */
  getFocusedWindow?: () => BrowserWindow | null
}

export class WindowManager implements WindowRegistry {
  private nextWindowId = 1
  private nextTabId = 1
  private nextGroupId = 1
  private contexts: WindowContext[] = []
  /** 最近一次获得过 OS 焦点的窗口 id:聚焦窗口查不到时的回退 */
  private lastFocusedId: number | null = null
  /**
   * `markActive()` 显式指定的活动窗口。优先级高于 OS 焦点 —— 因为 Wayland 下
   * `window.focus()` 可能被窗口管理器拒绝,browser_switch_tab 靠它才能真的改变
   * 「省略 tabId 时的默认目标」。真实 focus 事件一到就清除(用户手动切窗口优先)。
   */
  private explicitActiveId: number | null = null

  /** 注入给每个 `TabManager`,保证 tabId / groupId 跨窗口全局唯一 */
  readonly ids: TabIdAllocator = {
    allocTabId: () => this.nextTabId++,
    allocGroupId: () => this.nextGroupId++
  }

  constructor(private readonly deps: WindowManagerDeps = {}) {}

  get list(): readonly WindowContext[] {
    return this.contexts
  }

  get count(): number {
    return this.contexts.length
  }

  /** 登记一个已建好的窗口三件套。窗口 focus/closed 由这里接管(不额外占用调用方的监听) */
  register(window: BrowserWindow, tabs: TabManager, overlay: OverlayManager): WindowContext {
    const ctx: WindowContext = { id: this.nextWindowId++, window, tabs, overlay }
    this.contexts.push(ctx)
    this.lastFocusedId = ctx.id
    window.on('focus', () => {
      this.lastFocusedId = ctx.id
      // 真实焦点事件优先:用户手动切窗口后,显式指定失效
      this.explicitActiveId = null
    })
    window.on('closed', () => this.remove(ctx))
    return ctx
  }

  byId(id: number): WindowContext | null {
    return this.contexts.find((c) => c.id === id) ?? null
  }

  /** 由 webContents 反查窗口:chrome / overlay / 任意标签视图(含内部页)都认 */
  byWebContents(wc: WebContents): WindowContext | null {
    for (const ctx of this.contexts) {
      if (ctx.window.isDestroyed()) continue
      if (ctx.window.webContents === wc) return ctx
      if (ctx.overlay.hasWebContents(wc)) return ctx
      if (ctx.tabs.findTabIdByWebContents(wc) != null) return ctx
    }
    return null
  }

  byTabId(tabId: number): TabResolution | null {
    for (const ctx of this.contexts) {
      const record = ctx.tabs.getView(tabId)
      if (record) return { ctx, record }
    }
    return null
  }

  /** 显式把某窗口设为后续操作的默认窗口(见 `WindowRegistry.markActive` 注释) */
  markActive(ctx: WindowContext): void {
    this.explicitActiveId = ctx.id
    this.lastFocusedId = ctx.id
  }

  /**
   * 当前聚焦窗口。优先级:显式指定(`markActive`)→ OS 焦点 → 最近聚焦过的 → 最后一个窗口。
   * 保证调用方总能拿到一个窗口而不是 null(除非一个窗口都没有)。
   */
  focused(): WindowContext | null {
    if (this.explicitActiveId != null) {
      const explicit = this.byId(this.explicitActiveId)
      if (explicit) return explicit
      this.explicitActiveId = null
    }
    const getFocused = this.deps.getFocusedWindow ?? (() => BrowserWindow.getFocusedWindow())
    const win = getFocused()
    if (win && !win.isDestroyed()) {
      const hit = this.contexts.find((c) => c.window === win)
      if (hit) return hit
    }
    if (this.lastFocusedId != null) {
      const remembered = this.byId(this.lastFocusedId)
      if (remembered) return remembered
    }
    return this.contexts[this.contexts.length - 1] ?? null
  }

  allTabs(): TabInfo[] {
    const out: TabInfo[] = []
    for (const ctx of this.contexts) {
      for (const tab of ctx.tabs.listTabs()) out.push({ ...tab, windowId: ctx.id })
    }
    out.sort((a, b) => a.id - b.id)
    return out
  }

  /** 向所有窗口的 chrome / overlay / 内部页面标签广播(插件事件、设置变更) */
  broadcast(channel: string, payload: unknown): void {
    for (const ctx of this.contexts) {
      if (ctx.window.isDestroyed()) continue
      const wc = ctx.window.webContents
      if (wc && !wc.isDestroyed()) wc.send(channel, payload)
      ctx.overlay.send(channel, payload)
      ctx.tabs.broadcastToInternal(channel, payload)
    }
  }

  remove(ctx: WindowContext): void {
    this.contexts = this.contexts.filter((c) => c !== ctx)
    if (this.lastFocusedId === ctx.id) this.lastFocusedId = null
    if (this.explicitActiveId === ctx.id) this.explicitActiveId = null
  }
}
