/**
 * Tab 快捷键全局拦截:对所有 webContents 的 before-input-event 统一处理,
 * 保证页面/地址栏/弹层任何焦点下 Ctrl+T / Ctrl+Shift+T / Ctrl+W / Ctrl+L / Ctrl+数字 / Ctrl+, 均可生效。
 *
 * 背景:标签页是独立 WebContentsView,按键事件只进入当前聚焦的 webContents,
 * 渲染层 keydown 在页面聚焦时收不到按键,因此必须在主进程拦截。
 * 策略与 devtools.ts 相同:先于任何窗口/视图创建注册,覆盖全部 webContents。
 */

import { app } from 'electron'
import { matchSplitHotkey, matchTabHotkey, releasesToTerminal, switchIndexForDigit } from '@shared/shortcuts'
import { parseInternalUrl } from '@shared/internalPages'
import type { TabInfo } from '@shared/types'
import type { TabManager } from './tabManager'
import type { OverlayManager } from './overlay'
import type { PluginKernel } from './plugins/kernel'
import { log } from './logger'

/** 活动标签是不是终端页(`bow://terminal`):决定 Ctrl+W / Ctrl+L 归 shell 还是归浏览器 */
function isTerminalTab(tab: TabInfo | null): boolean {
  return !!tab && parseInternalUrl(tab.url) === 'terminal'
}

/**
 * 聚焦地址栏:先把键盘焦点交给 chrome WebContents(否则渲染层的 el.focus() 只是改 DOM 状态、
 * 键盘事件仍进页面),再请求渲染层聚焦并全选地址栏。Ctrl+L 与 Ctrl+T 新建标签共用。
 */
function focusAddressBar(tabs: TabManager): void {
  const wc = tabs.window.webContents
  if (wc.isDestroyed()) return
  wc.focus()
  wc.send('chrome:focus-address')
}

/**
 * 安装 Tab 快捷键。必须在创建任何窗口/视图之前调用(与 setupDevTools 相同约束);
 * tabs/overlay/kernel 通过惰性取值,按键事件只会在窗口加载完成后到达,此时实例已就绪。
 */
export function setupTabShortcuts(
  getTabs: () => TabManager,
  getOverlay: () => OverlayManager,
  getKernel: () => PluginKernel
): void {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('before-input-event', (event, input) => {
      const hk = matchTabHotkey(input)
      if (hk) {
        // 终端里的 Ctrl+W(删词)/ Ctrl+L(清屏)必须落到 shell 上。
        // 关键点是**不能 preventDefault**:渲染层收不到被 preventDefault 的按键,
        // xterm 也就无法把这两个组合送进 pty。
        if (releasesToTerminal(hk) && isTerminalTab(getTabs().getActiveTabInfo())) {
          log('快捷键放行给终端', hk.action)
          return
        }
        // preventDefault 会同时阻止页面 keydown/keyup 与菜单快捷键
        event.preventDefault()
        const tabs = getTabs()
        switch (hk.action) {
          case 'new': {
            tabs.create('about:blank', true)
            // 全窗弹层(modal)打开时不抢焦点;否则保持"新建即聚焦地址栏"的 UX
            if (!getOverlay().isFullOpen) {
              focusAddressBar(tabs)
            }
            log('快捷键:新建标签(Ctrl+T)')
            break
          }
          case 'focus-address': {
            // 全窗弹层(modal)打开时地址栏被遮罩盖住,不抢焦点(与 Ctrl+T 同策略)
            if (!getOverlay().isFullOpen) {
              focusAddressBar(tabs)
              log('快捷键:聚焦地址栏(Ctrl+L)')
            }
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
            // 数字指的是**标签栏第几项 = 第几个标签组**(普通组一个标签、分屏组两个标签)
            const list = tabs.listGroups()
            const idx = switchIndexForDigit(hk.digit, list.length)
            if (idx !== null) {
              tabs.activateGroup(list[idx].id)
              log('快捷键:切换标签组', hk.digit, '→', list[idx].id)
            }
            break
          }
        }
        return
      }
      // 分屏快捷键:`Ctrl/Cmd+Shift+方向` 分屏、`Alt+Shift+方向` 调整当前窗格大小。
      // 只在「聚焦的 webContents 属于**普通网页标签**」时接管 —— 地址栏、`bow://settings`、终端页、
      // DevTools 前端里的这些组合(按词选择 / xterm 的选择扩展 / 前端自己的快捷键)必须原样留给它们。
      // 代价已记在文档里:普通网页里的输入框也拿不到 `Ctrl+Shift+方向`。
      const splitHk = matchSplitHotkey(input)
      if (splitHk) {
        const tabId = getTabs().findTabIdByWebContents(contents)
        const rec = tabId != null ? getTabs().getView(tabId) : null
        if (rec && !rec.info.internal) {
          // 全窗弹层开着时不抢焦点也不分屏(与 Ctrl+T / Ctrl+L 同策略)
          if (getOverlay().isFullOpen) return
          // preventDefault 会同时阻止页面 keydown/keyup 与菜单快捷键
          event.preventDefault()
          if (splitHk.kind === 'split') getTabs().splitFocused(splitHk.dir)
          else getTabs().resizeFocused(splitHk.dir)
          log('快捷键:分屏/调整大小', splitHk.kind, splitHk.dir)
        }
        return
      }
      // 核心快捷键未命中:交给插件注册的热键(如元素全屏 Ctrl+Shift+F)
      if (getKernel()?.handleHotkey(input)) {
        event.preventDefault()
        log('快捷键:插件热键')
      }
    })
  })
}