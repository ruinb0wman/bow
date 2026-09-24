/** 测试用假 WindowRegistry:把单个 FakeTabs 包装成一个窗口(多数用例只有单窗口) */

import type { TabInfo } from '../src/shared/types'
import type { TabResolution, WindowContext, WindowRegistry } from '../src/main/windows'
import type { FakeTabs } from './fakeTabs'

export interface FakeWindowsOptions {
  /** 窗口 id(默认 1) */
  id?: number
}

export function fakeWindows(tabs: FakeTabs, opts: FakeWindowsOptions = {}): WindowRegistry {
  const id = opts.id ?? 1
  const ctx: WindowContext = {
    id,
    window: { isDestroyed: () => false, focus: () => {} } as never,
    tabs: tabs as never,
    overlay: {} as never
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
    allTabs: (): TabInfo[] => tabs.listTabs().map((t) => ({ ...t, windowId: id }))
  }
}
