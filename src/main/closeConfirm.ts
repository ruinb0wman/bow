/**
 * 关闭窗口确认:窗口关闭时若还有 2 个及以上标签,先弹**应用内**确认框拦住,
 * 确认后才真正关闭(= 退出应用,见 index.ts 的 `window-all-closed`)。
 *
 * 为什么在 `close` 上拦:自绘标题栏的关闭按钮走 IPC(`window:close` → `mainWindow.close()`),
 * 而 Alt+F4 / 窗口管理器不经过 IPC —— 两条路径都会触发 BrowserWindow 的 `close` 事件。
 *
 * 为什么不做成设置项:标签页不持久化(没有会话恢复),关掉 = 丢掉全部标签,默认拦住更合理。
 *
 * 两个出口(都必须留着,否则会出现「窗口关不掉」):
 * - 确认框里点「关闭窗口」→ `confirmWindowClose()`;
 * - 确认框已经开着还再次触发关闭(Alt+F4 / 窗口管理器)→ 直接放行。这条不依赖渲染是否成功:
 *   overlay 页面加载失败(dev server 未起等)时遮罩画不出来、按钮点不到,只有它能兜住。
 */

import type { BrowserWindow } from 'electron'
import type { TabManager } from './tabManager'
import type { OverlayManager } from './overlay'
import { log } from './logger'

/** 必须与 OverlayApp.vue 核心注册表里的 key 一致 */
export const CLOSE_CONFIRM_OVERLAY_ID = 'confirm-close'
/** 触发确认的标签数下限:1 个(或 0 个)标签直接关,不打扰 */
const MIN_TABS_TO_CONFIRM = 2

/** 用户已确认关闭。单窗口应用:置位后不再复位(窗口关了进程也就退了),只在 install 时重置 */
let confirmed = false

/** 装上关闭拦截。必须在窗口创建之后调用(窗口自己就是拦截对象) */
export function installCloseConfirm(window: BrowserWindow, tabs: TabManager, overlay: OverlayManager): void {
  confirmed = false // 幂等:重复安装(或测试里逐例安装)都从「未确认」开始
  window.on('close', (e) => {
    if (confirmed) return
    // 确认框已经开着还再次触发关闭 → 视为强制关闭(见文件头注释)
    if (overlay.currentId === CLOSE_CONFIRM_OVERLAY_ID) {
      log('再次触发关闭,跳过确认')
      return
    }
    const tabCount = tabs.listTabs().length
    if (tabCount < MIN_TABS_TO_CONFIRM) return
    e.preventDefault()
    overlay.show({
      id: CLOSE_CONFIRM_OVERLAY_ID,
      payload: { tabCount },
      placement: 'full'
    })
    log('关闭窗口已拦下,等待确认', tabCount)
  })
}

/** 用户在确认框里点了「关闭窗口」:放行本次 close */
export function confirmWindowClose(window: BrowserWindow): void {
  confirmed = true
  if (!window.isDestroyed()) window.close()
}
