/**
 * 「点代理通知 = 进入对应标签」的唯一实现。
 *
 * 两处调用方共用它,所以绝不能各写一份:
 * - 系统通知的 `'click'`(见 `main/systemNotify.ts`,由 `index.ts` 接线);
 * - 以前的窗内通知视图(`toast:activate` 的 IPC)已随窗内通知一整套删除。
 *
 * 为什么这几步都要做:切标签只改「哪个标签是活动标签」,通知可能来自**后台窗口**,
 * 或者用户只是把键盘焦点给了别处 —— 所以要把窗口提到前台、把键盘焦点交给页面视图。
 * `TabManager.activate()` 对**已激活**的标签会早退,不补最后那次 `focus()`
 * 就会出现「看得见但打不进字」(键盘焦点还留在触发通知的那个 webContents 上)。
 */

import type { WindowRegistry } from './windows'
import { log } from './logger'

export function activateAgentTab(
  deps: Pick<WindowRegistry, 'byTabId' | 'markActive'>,
  tabId: number
): boolean {
  const hit = deps.byTabId(tabId)
  if (!hit) return false
  deps.markActive(hit.ctx)
  hit.ctx.tabs.activate(tabId)
  const view = hit.record.view.webContents
  if (!view.isDestroyed()) view.focus()
  if (hit.ctx.window.isMinimized()) hit.ctx.window.restore()
  hit.ctx.window.show()
  hit.ctx.window.focus()
  log('代理通知已点开', tabId)
  return true
}
