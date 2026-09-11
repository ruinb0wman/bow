/** 渲染层(Vue UI)与主进程的 IPC 桥:所有 chrome 交互走这里 */

import { BrowserWindow, ipcMain } from 'electron'
import { resolveNavigation } from '@shared/url'
import {
  addBookmark,
  addFolder,
  findByUrl,
  moveNode,
  removeNode,
  updateNode
} from '@shared/bookmarkTree'
import type { ModalKind, Settings, TabInfo } from '@shared/types'
import type { TabManager } from './tabManager'
import type { OverlayManager } from './overlay'
import { getBookmarksStore, getSettingsStore } from './stores'
import { log } from './logger'

export function registerIpc(tabs: TabManager, mainWindow: BrowserWindow, overlay: OverlayManager): void {
  const sendTabsList = (): void => {
    mainWindow.webContents.send('tab:list-changed', tabs.listTabs())
  }
  /** 同时通知 chrome 与 overlay 两个页面(书签/设置变更) */
  const broadcast = (channel: string, payload: unknown): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    overlay.send(channel, payload)
  }
  const sendBookmarks = (): void => broadcast('bookmarks:changed', getBookmarksStore().get())
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

  ipcMain.handle('nav:go', (_e, input: string) => {
    const tab = tabs.ensureActive()
    const res = resolveNavigation(input, getSettingsStore().get().searchEngine)
    if (!res) return { parsed: null, tabId: tab.id, url: tab.url }
    tabs.navigate(tab.id, res.url)
    return {
      parsed: res.parsed,
      query: res.parsed === 'search' ? res.query : undefined,
      url: res.url,
      tabId: tab.id
    }
  })

  ipcMain.handle('nav:url', (_e, url: string) => {
    const tab = tabs.ensureActive()
    tabs.navigate(tab.id, url)
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

  // 书签
  ipcMain.handle('bookmarks:list', () => getBookmarksStore().get())
  ipcMain.handle('bookmarks:add', (_e, input: { title?: string; url: string; folderId?: string | null }) => {
    const store = getBookmarksStore()
    const added = addBookmark(store.get(), { title: input.title ?? '', url: input.url, folderId: input.folderId ?? null })
    store.setRaw(added.tree)
    sendBookmarks()
    return added.node
  })
  ipcMain.handle('bookmarks:add-folder', (_e, input: { title?: string; parentId?: string | null }) => {
    const store = getBookmarksStore()
    const added = addFolder(store.get(), { title: input.title ?? '', parentId: input.parentId ?? null })
    store.setRaw(added.tree)
    sendBookmarks()
    return added.node
  })
  ipcMain.handle('bookmarks:update', (_e, id: string, patch: { title?: string; url?: string }) => {
    const store = getBookmarksStore()
    const tree = updateNode(store.get(), id, patch)
    if (tree) {
      store.setRaw(tree)
      sendBookmarks()
      return { ok: true }
    }
    return { ok: false, error: '书签不存在' }
  })
  ipcMain.handle('bookmarks:remove', (_e, id: string) => {
    const store = getBookmarksStore()
    const res = removeNode(store.get(), id)
    if (res.removed) {
      store.setRaw(res.tree)
      sendBookmarks()
    }
    return res
  })
  ipcMain.handle('bookmarks:move', (_e, id: string, targetFolderId: string | null) => {
    const store = getBookmarksStore()
    const tree = moveNode(store.get(), id, targetFolderId)
    if (tree) {
      store.setRaw(tree)
      sendBookmarks()
      return { ok: true }
    }
    return { ok: false, error: '移动失败(目标文件夹不存在或形成循环)' }
  })
  ipcMain.handle('bookmarks:find-by-url', (_e, url: string) => findByUrl(getBookmarksStore().get(), url))

  // 设置
  ipcMain.handle('settings:get', () => getSettingsStore().get())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const store = getSettingsStore()
    const settings = store.set(patch)
    sendSettings(settings)
    return settings
  })

  // 顶层弹层开关
  ipcMain.handle('ui:modal', (_e, kind: ModalKind | null) => {
    if (kind == null) overlay.close()
    else overlay.open(kind)
    return true
  })

  // 注:DevTools 快捷键统一由 setupDevTools() 全局处理(独立窗口),此处不再注册

  // 窗口控制
  ipcMain.handle('window:minimize', () => mainWindow.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow.close())

  // chrome 高度(渲染层实测)
  ipcMain.handle('ui:chrome-height', (_e, height: number) => {
    log('chrome 高度上报', height)
    tabs.setChromeHeight(Math.max(0, Math.round(height)))
    return true
  })

  log('IPC 注册完成')
}