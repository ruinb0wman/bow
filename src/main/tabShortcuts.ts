/**
 * Tab 快捷键全局拦截:对所有 webContents 的 before-input-event 统一处理,
 * 保证页面/地址栏/弹层任何焦点下 Ctrl+T / Ctrl+Shift+T / Ctrl+W / Ctrl+数字 / Ctrl+, 均可生效。
 *
 * 背景:标签页是独立 WebContentsView,按键事件只进入当前聚焦的 webContents,
 * 渲染层 keydown 在页面聚焦时收不到按键,因此必须在主进程拦截。
 * 策略与 devtools.ts 相同:先于任何窗口/视图创建注册,覆盖全部 webContents。
 */

import { app } from 'electron'
import { matchTabHotkey, switchIndexForDigit } from '@shared/shortcuts'
import type { TabManager } from './tabManager'
import type { OverlayManager } from './overlay'
import { log } from './logger'

/**
 * 安装 Tab 快捷键。必须在创建任何窗口/视图之前调用(与 setupDevTools 相同约束);
 * tabs/overlay 通过惰性取值,按键事件只会在窗口加载完成后到达,此时实例已就绪。
 */
export function setupTabShortcuts(getTabs: () => TabManager, getOverlay: () => OverlayManager): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('before-input-event', (event, input) => {
      const hk = matchTabHotkey(input)
      if (!hk) return
      // preventDefault 会同时阻止页面 keydown/keyup 与菜单快捷键
      event.preventDefault()
      const tabs = getTabs()
      switch (hk.action) {
        case 'new': {
          tabs.create('about:blank', true)
          // 全窗弹层(modal)打开时不抢焦点;否则保持"新建即聚焦地址栏"的 UX
          if (!getOverlay().isFullOpen) {
            tabs.window.webContents.send('chrome:focus-address')
          }
          log('快捷键:新建标签(Ctrl+T)')
          break
        }
        case 'settings':
          tabs.openInternal('settings')
          log('快捷键:打开设置(Ctrl+,)')
          break
        case 'restore':
          if (tabs.restoreLastClosed()) log('快捷键:恢复标签(Ctrl+Shift+T)')
          break
        case 'close': {
          const active = tabs.getActiveTabInfo()
          if (active) tabs.close(active.id)
          // 关闭最后一个标签后保留一个空白标签(与渲染层 closeTab 兜底一致)
          if (tabs.listTabs().length === 0) tabs.create('about:blank', true)
          log('快捷键:关闭标签(Ctrl+W)')
          break
        }
        case 'switch': {
          const list = tabs.listTabs()
          const idx = switchIndexForDigit(hk.digit, list.length)
          if (idx !== null) {
            tabs.activate(list[idx].id)
            log('快捷键:切换标签', hk.digit, '→', list[idx].id)
          }
          break
        }
      }
    })
  })
}