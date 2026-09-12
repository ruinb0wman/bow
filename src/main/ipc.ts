/** 渲染层(Vue UI)与主进程的 IPC 桥:所有 chrome 交互走这里 */

import { BrowserWindow, ipcMain } from 'electron'
import { resolveNavigation } from '@shared/url'
import {
  addBookmark,
  addFolder,
  findByUrl,
  findNode,
  moveNode,
  removeNode,
  updateNode
} from '@shared/bookmarkTree'
import type { ModalKind, Settings, TabInfo } from '@shared/types'
import type { TabManager } from './tabManager'
import type { OverlayManager } from './overlay'
import { getBookmarksStore, getSettingsStore, getHistoryStore } from './stores'
import { recordVisit, clearHistory } from './history'
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
    if (res.parsed === 'search') {
      // 搜索词富化:记 search 条目,与 tabManager did-navigate 的 plain 记录按 URL 去重合并
      recordVisit({ title: res.query, url: res.url, kind: 'search', query: res.query })
    }
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
    // 一级目录结构:文件夹始终创建在根目录,忽略调用方传入的 parentId
    const added = addFolder(store.get(), { title: input.title ?? '', parentId: null })
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
    const tree = store.get()
    const node = findNode(tree, id)
    if (!node) return { ok: false, error: '书签不存在' }
    // 一级目录不变量:目录恒在根;书签目标仅限根或根级目录
    const rootFolderIds = new Set<string>()
    for (const n of tree) if (n.type === 'folder') rootFolderIds.add(n.id)
    if (node.type === 'folder') {
      if (targetFolderId !== null) return { ok: false, error: '目录只能位于根目录' }
      return { ok: true } // 已在根,无需操作
    }
    if (targetFolderId !== null && !rootFolderIds.has(targetFolderId)) {
      return { ok: false, error: '目标必须是根级目录' }
    }
    const moved = moveNode(tree, id, targetFolderId)
    if (!moved) return { ok: false, error: '移动失败(目标文件夹不存在或形成循环)' }
    store.setRaw(moved)
    sendBookmarks()
    return { ok: true }
  })
  ipcMain.handle('bookmarks:find-by-url', (_e, url: string) => findByUrl(getBookmarksStore().get(), url))

  // 浏览历史
  ipcMain.handle('history:list', () => getHistoryStore().get())
  ipcMain.handle('history:clear', () => {
    clearHistory()
    return true
  })

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