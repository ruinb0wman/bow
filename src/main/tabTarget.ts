/**
 * 「这个 tabId 到底指哪个标签 / 哪个窗口」的**唯一**实现。
 *
 * 为什么抽出来:这套语义(MCP 专属窗口 / 内部页面拒绝 / 没标签就建 about:blank)是核心的不变式。
 * 历史上它有两个消费方 —— 核心 MCP 工具与插件的 `pages.uploadFiles`(已随文件管理插件于 2026-10-15 删除);
 * 抽出来的目的仍然成立:将来给插件开页面类能力时**必须复用这里**,两处各写一份必漂移,
 * 而漂移的表现是「插件工具动了用户正在看的窗口」这种要命的事。
 *
 * 语义(照抄第十五节那句不变式):
 * - 给了 `tabId` → 用它(`window.byTabId` 跨窗口解析,显式就是授权);内部页面直接拒。
 * - 没给 `tabId` → **MCP 专属窗口**(agent 窗口,没有就建),**绝不回退到用户窗口**;
 *   活动标签是内部页面时退到最近浏览过的普通标签;一个都没有就新建 `about:blank`。
 */

import type { WebContents } from 'electron'
import type { TabRecord } from './tabManager'
import type { WindowContext, WindowRegistry } from './windows'

export interface TabTarget {
  view: TabRecord | null
  ctx: WindowContext | null
  fail: string | null
}

export interface TabTargets {
  /** MCP 专属窗口(没有就创建);创建失败返回 null */
  agentCtx(): WindowContext | null
  /** 解析目标标签;`fail` 是可直接给 LLM 的失败文案 */
  target(tabId?: number): TabTarget
  /** 只要 WebContents(等待类工具用),拿不到返回 null */
  wcOf(tabId: number): WebContents | null
}

export function createTabTargets(getWindows: () => WindowRegistry): TabTargets {
  const agentCtx = (): WindowContext | null => {
    const windows = getWindows()
    return windows.agentWindow() ?? windows.createAgentWindow()
  }

  const target = (tabId?: number): TabTarget => {
    const windows = getWindows()
    if (tabId != null) {
      const hit = windows.byTabId(tabId)
      if (!hit) return { view: null, ctx: null, fail: `标签 ${tabId} 不存在` }
      if (hit.record.info.internal) {
        return {
          view: null,
          ctx: null,
          fail: `标签 ${tabId} 是浏览器内部页面(设置 / DevTools 前端),不支持页面操作`
        }
      }
      return { view: hit.record, ctx: hit.ctx, fail: null }
    }
    const ctx = agentCtx()
    if (!ctx) return { view: null, ctx: null, fail: '无法创建 MCP 专属窗口' }
    let hit = ctx.tabs.getActiveBrowsingView()
    if (!hit) {
      // 只有内部页面标签(或没有任何标签):新建空白标签作为操作目标
      const created = ctx.tabs.create('about:blank')
      hit = ctx.tabs.getView(created.id)
    }
    if (!hit) return { view: null, ctx, fail: '没有活动标签' }
    return { view: hit, ctx, fail: null }
  }

  const wcOf = (tabId: number): WebContents | null =>
    getWindows().byTabId(tabId)?.record.view.webContents ?? null

  return { agentCtx, target, wcOf }
}
