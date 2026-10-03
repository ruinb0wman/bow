/** 测试用假 WindowRegistry:把单个 FakeTabs 包装成一个窗口(多数用例只有单窗口) */

import type { TabInfo } from '../src/shared/types'
import type { TabResolution, WindowContext, WindowRegistry, WindowRole } from '../src/main/windows'
import type { FakeTabs } from './fakeTabs'

export interface FakeWindowsOptions {
  /** 窗口 id(默认 1) */
  id?: number
  /**
   * 窗口角色。默认 `'agent'` —— 单窗口用例里这个假窗口**既是**唯一窗口也是 MCP 的专属窗口,
   * 于是「省略 tabId」的行为与引入 agent 窗口之前完全一致(`agentWindow()` 返回它)。
   * 要测「用户窗口不被 MCP 碰」就传 `'user'`(此时 `agentWindow()` 返回 null)。
   */
  role?: WindowRole
}

export function fakeWindows(tabs: FakeTabs, opts: FakeWindowsOptions = {}): WindowRegistry {
  const id = opts.id ?? 1
  const role = opts.role ?? 'agent'
  const ctx: WindowContext = {
    id,
    role,
    window: { isDestroyed: () => false, focus: () => {} } as never,
    tabs: tabs as never,
    overlay: {} as never,
    toasts: {} as never
  }
  let activeId = id
  return {
    byId: (windowId: number) => (windowId === id ? ctx : null),
    byTabId: (tabId: number): TabResolution | null => {
      const record = tabs.getView(tabId)
      return record ? { ctx, record: record as never } : null
    },
    focused: () => (activeId === id ? ctx : null),
    markActive: () => {
      activeId = id
    },
    allTabs: (): TabInfo[] => tabs.listTabs().map((t) => ({ ...t, windowId: id })),
    agentWindow: () => (role === 'agent' ? ctx : null),
    // 单窗口假注册表没有创建能力:agent 窗口就是自己(没有则 null)
    createAgentWindow: () => (role === 'agent' ? ctx : null),
    markAgentActive: () => {}
  }
}
