/**
 * Tab 快捷键全局拦截:对所有 webContents 的 before-input-event 统一处理,
 * 保证页面/地址栏/弹层任何焦点下 Ctrl+T / Ctrl+Shift+T / Ctrl+W / Ctrl+L / Ctrl+Shift+L / Ctrl+Shift+E /
 * Ctrl+数字 / Ctrl+, 均可生效。
 *
 * 背景:标签页是独立 WebContentsView,按键事件只进入当前聚焦的 webContents,
 * 渲染层 keydown 在页面聚焦时收不到按键,因此必须在主进程拦截。
 * 策略与 devtools.ts 相同:先于任何窗口/视图创建注册,覆盖全部 webContents。
 */

import { app } from 'electron'
import {
  matchSplitHotkey,
  matchTabHotkey,
  releasesToTerminal,
  shouldTakeSplitHotkey,
  switchIndexForDigit
} from '@shared/shortcuts'
import { TERMINAL_URL, parseInternalUrl } from '@shared/internalPages'
import type { TabInfo } from '@shared/types'
import type { TabManager } from './tabManager'
import type { OverlayManager } from './overlay'
import type { PluginKernel } from './plugins/kernel'
import { CLOSE_CONFIRM_OVERLAY_ID } from './closeConfirm'
import { log } from './logger'

/** 标签是不是终端页(`bow://terminal`):决定 Ctrl+W / Ctrl+L 归 shell 还是归浏览器 */
function isTerminalTab(tab: TabInfo | null): boolean {
  return !!tab && parseInternalUrl(tab.url) === 'terminal'
}

/**
 * 聚焦地址栏:先把键盘焦点交给 chrome WebContents(否则渲染层的 el.focus() 只是改 DOM 状态、
 * 键盘事件仍进页面),再请求渲染层聚焦并全选地址栏。Ctrl+L 与 Ctrl+T 新建标签共用。
 *
 * 导出是因为渲染层也需要它(工具栏 `+` / 双击标签栏 / 建议面板 cancel):那几条路曾经只手 DOM 焦点,
 * 结果「地址栏看着聚焦了、面板也弹出来了,但打字进不了地址栏、Esc 也失效果」——
 * 渲染层自己做不了这件事,只能经 `chrome:request-focus-address` 请主进程来。
 */
export function focusAddressBar(tabs: TabManager): void {
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
  /**
   * 「关闭窗口」确认框是否开着。它的文案里有「当前有 N 个标签页」,
   * 所以这个框开着期间 `Ctrl+T` / `Ctrl+W` 一律不生效 —— 否则那个数字当场过时
   * (只认这一个弹层,不禁其它 full 弹层如书签面板)。
   */
  const closeConfirmOpen = (): boolean => getOverlay().currentId === CLOSE_CONFIRM_OVERLAY_ID

  app.on('web-contents-created', (_e, contents) => {
    contents.on('before-input-event', (event, input) => {
      const hk = matchTabHotkey(input)
      if (hk) {
        // 放行规则看的是**按键来源的那个窗格**,不是「活动标签」:
        // 焦点在地址栏/浮层时来源拿不到标签 → 一律按浏览器处理(否则 Ctrl+W / Ctrl+L 会变成什么都没做的死键)。
        const srcTabId = getTabs().findTabIdByWebContents(contents)
        const srcTab = srcTabId != null ? getTabs().getView(srcTabId)?.info ?? null : null
        // 终端里的 Ctrl+L(清屏)必须落到 shell 上。
        // 关键点是**不能 preventDefault**:渲染层收不到被 preventDefault 的按键,
        // xterm 也就无法把这个组合送进 pty。
        // (Ctrl+W 自 2026-09-19 不再放行:终端里也要能关聚焦窗格 —— 见 releasesToTerminal 的注释。)
        if (releasesToTerminal(hk) && isTerminalTab(srcTab)) {
          log('快捷键放行给终端', hk.action)
          return
        }
        // preventDefault 会同时阻止页面 keydown/keyup 与菜单快捷键
        event.preventDefault()
        const tabs = getTabs()
        switch (hk.action) {
          case 'new': {
            if (closeConfirmOpen()) break
            tabs.create('about:blank', true)
            // 全窗弹层(modal)打开时不抢焦点;否则保持"新建即聚焦地址栏"的 UX
            if (!getOverlay().isFullOpen) {
              focusAddressBar(tabs)
            }
            log('快捷键:新建标签(Ctrl+T)')
            break
          }
          case 'focus-address':
          case 'focus-address-anywhere': {
            // 全窗弹层(modal)打开时地址栏被遮罩盖住,不抢焦点(与 Ctrl+T 同策略)。
            // 两者唯一的区别在**放行规则**里:focus-address(Ctrl+L)在终端页让给 shell 当清屏,
            // focus-address-anywhere(Ctrl+Shift+L)不过 releasesToTerminal —— 终端里也能跳去地址栏。
            if (!getOverlay().isFullOpen) {
              focusAddressBar(tabs)
              log('快捷键:聚焦地址栏', hk.action === 'focus-address' ? '(Ctrl+L)' : '(Ctrl+Shift+L)')
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
          case 'terminal': {
            // 在聚焦窗格开终端(地址栏输 bow://terminal 的快捷键版):openUrl 会顶替聚焦窗格,
            // 已是终端 → 空操作,没有活动窗格 → 开新标签 —— 与地址栏完全同一条路。
            // 全窗弹层(mask)打开时不抢焦点(与 Ctrl+T / Ctrl+L 同策略)。
            if (!getOverlay().isFullOpen) {
              tabs.openUrl(TERMINAL_URL)
              log('快捷键:在聚焦窗格打开终端(Ctrl+Shift+E)')
            }
            break
          }
          case 'close': {
            // 关「按键来源的那个窗格」:焦点在某个窗格/标签里时用它反查最硬;
            // 拿不到来源(焦点在 chrome / overlay / DevTools 窗口)才退回活动标签。
            if (closeConfirmOpen()) break
            const target = srcTabId ?? tabs.getActiveTabInfo()?.id ?? null
            if (target != null) tabs.close(target)
            // 关闭最后一个标签后保留一个空白标签(与渲染层 closeTab 兜底一致)
            if (tabs.listTabs().length === 0) tabs.create('about:blank', true)
            log('快捷键:关闭标签(Ctrl+W)', target ?? '(无来源)')
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
      // 接管判据在 `shouldTakeSplitHotkey()`:普通网页标签与**终端页**归浏览器
      // (终端页里 xterm 会把这些组合编成 CSI 序列送进 pty,不拦就完全没反应);
      // 地址栏(rec=null)、设置页、DevTools 前端里的这些组合原样留给它们。
      // 代价已记在文档里:普通网页里的输入框、以及终端里的 shell/程序也拿不到这两个组合。
      const splitHk = matchSplitHotkey(input)
      if (splitHk) {
        const tabId = getTabs().findTabIdByWebContents(contents)
        const rec = tabId != null ? getTabs().getView(tabId) : null
        if (
          rec &&
          shouldTakeSplitHotkey({ internal: !!rec.info.internal, internalPageId: rec.internalId })
        ) {
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