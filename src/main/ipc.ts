/** 渲染层(Vue UI)与主进程的 IPC 桥:核心 chrome 交互 + 插件调用面 */

import { BrowserWindow, ipcMain } from 'electron'
import { resolveNavigation } from '@shared/url'
import type { OverlayContent, OverlayEvent, Settings, TabInfo } from '@shared/types'
import type { TabManager } from './tabManager'
import type { OverlayManager } from './overlay'
import type { PluginKernel } from './plugins/kernel'
import { getSettingsStore } from './stores'
import { log } from './logger'

export function registerIpc(
  tabs: TabManager,
  mainWindow: BrowserWindow,
  overlay: OverlayManager,
  kernel: PluginKernel
): void {
  const sendTabsList = (): void => {
    mainWindow.webContents.send('tab:list-changed', tabs.listTabs())
  }
  /** 同时通知 chrome、overlay 与内部页面标签(如设置页,设置变更/插件事件) */
  const broadcast = (channel: string, payload: unknown): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    overlay.send(channel, payload)
    tabs.broadcastToInternal(channel, payload)
  }
  const sendSettings = (settings: Settings): void => broadcast('settings:changed', settings)

  tabs.on('tab-updated', (tab) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('tab:updated', tab)
  })
  tabs.on('tabs-changed', sendTabsList)

  ipcMain.handle('tab:create', (_e, url?: string, activate = true): TabInfo => tabs.create(url, activate))
  ipcMain.handle('tab:close', (_e, id: number) => tabs.close(id))
  ipcMain.handle('tab:restore', () => tabs.restoreLastClosed())
  ipcMain.handle('tab:activate', (_e, id: number) => {
    tabs.activate(id)
    return tabs.getActiveTabInfo()
  })
  ipcMain.handle('tab:list', () => tabs.listTabs())
  ipcMain.handle('tab:active', () => tabs.getActiveTabInfo())
  // 激活最近浏览的普通页面标签(设置页的「屏蔽元素」等需要回到真实页面执行)
  ipcMain.handle('tab:activate-last-browsing', () => tabs.activateLastBrowsing())

  ipcMain.handle('nav:go', (_e, input: string) => {
    const res = resolveNavigation(input, getSettingsStore().get().searchEngine)
    if (!res) {
      const tab = tabs.ensureActive()
      return { parsed: null, tabId: tab.id, url: tab.url }
    }
    // 内部页面 URL(bow://settings)→ 打开/聚焦内部标签;活动标签为内部页面时另开新标签
    const tab = tabs.openUrl(res.url)
    if (res.parsed === 'search') {
      // 搜索词富化:发布事件由历史插件记为 search 条目(did-navigate 的 plain 记录按 URL 去重合并)
      kernel.emitEvent('search:performed', { url: res.url, query: res.query, title: res.query })
    }
    return {
      parsed: res.parsed,
      query: res.parsed === 'search' ? res.query : undefined,
      url: res.url,
      tabId: tab.id
    }
  })

  ipcMain.handle('nav:url', (_e, url: string) => {
    const tab = tabs.openUrl(url)
    return { tabId: tab.id }
  })
  ipcMain.handle('nav:back', () => tabs.back(tabs.ensureActive().id))
  ipcMain.handle('nav:forward', () => tabs.forward(tabs.ensureActive().id))
  ipcMain.handle('nav:reload', () => {
    const tab = tabs.ensureActive()
    tabs.reload(tab.id)
  })
  ipcMain.handle('nav:stop', () => {
    const tab = tabs.ensureActive()
    tabs.stop(tab.id)
  })

  // 设置(核心:搜索引擎 / 主页;插件设置由各插件自管)
  ipcMain.handle('settings:get', () => getSettingsStore().get())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const store = getSettingsStore()
    const settings = store.set(patch)
    sendSettings(settings)
    return settings
  })

  // 通用顶层浮层开关(chrome 侧下发内容描述;overlay 页面按 id 渲染注册表组件)
  ipcMain.handle('ui:overlay', (_e, content: OverlayContent | null) => {
    overlay.show(content)
    return true
  })
  // overlay → chrome / 插件:
  // - suggest 下拉事件转发 chrome;
  // - close-request 由主进程统一关闭浮层;
  // - 其余按浮层 id 路由给所属插件 main(约定注册 overlay-event 方法)。
  ipcMain.handle('ui:overlay-event', async (_e, ev: OverlayEvent) => {
    if (ev.id === 'suggest') {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('overlay-event', ev)
      return true
    }
    if (ev.event === 'close-request') {
      overlay.show(null)
      return true
    }
    await kernel.routeOverlayEvent(ev.id, ev.event, ev.args)
    return true
  })

  // ---------- 插件调用面 ----------
  ipcMain.handle('plugins:list', () => kernel.list())
  ipcMain.handle('plugins:set-enabled', (_e, id: string, enabled: boolean) => kernel.setEnabled(id, enabled))
  ipcMain.handle('plugins:invoke', (_e, id: string, method: string, args: unknown[]) =>
    kernel.invoke(id, method, args ?? [])
  )
  ipcMain.handle('plugins:overlay-event', (_e, overlayId: string, event: string, args: unknown) =>
    kernel.routeOverlayEvent(overlayId, event, args)
  )
  ipcMain.handle('plugins:suggest', (_e, input: string) => kernel.suggest(input))

  // 窗口控制
  ipcMain.handle('window:minimize', () => mainWindow.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow.close())

  // chrome 高度(渲染层实测)→ 页面视图布局 + overlay 条带定位
  ipcMain.handle('ui:chrome-height', (_e, height: number) => {
    log('chrome 高度上报', height)
    tabs.setChromeHeight(Math.max(0, Math.round(height)))
    overlay.layout()
    return true
  })

  log('IPC 注册完成')
}
