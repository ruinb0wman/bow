import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  BookmarkTree,
  BookmarkNode,
  FlatBookmark,
  HistoryEntry,
  OverlayContent,
  OverlayContentId,
  OverlayEvent,
  OverlayShowMessage,
  Settings,
  TabInfo
} from '../shared/types'

export interface BrowserAPI {
  // 标签页
  createTab: (url?: string, activate?: boolean) => Promise<TabInfo>
  closeTab: (id: number) => Promise<{ ok: boolean }>
  restoreTab: () => Promise<TabInfo | null>
  activateTab: (id: number) => Promise<TabInfo | null>
  listTabs: () => Promise<TabInfo[]>
  getActiveTab: () => Promise<TabInfo | null>
  // 导航
  go: (input: string) => Promise<{ parsed: string | null; query?: string; url?: string; tabId: number }>
  goUrl: (url: string) => Promise<{ tabId: number }>
  back: () => Promise<boolean>
  forward: () => Promise<boolean>
  reload: () => Promise<void>
  stop: () => Promise<void>
  // 书签
  listBookmarks: () => Promise<BookmarkTree>
  addBookmark: (input: { title?: string; url: string; folderId?: string | null }) => Promise<BookmarkNode>
  addFolder: (input: { title?: string; parentId?: string | null }) => Promise<BookmarkNode>
  updateBookmark: (id: string, patch: { title?: string; url?: string }) => Promise<{ ok: boolean; error?: string }>
  removeBookmark: (id: string) => Promise<{ tree: BookmarkTree; removed: boolean }>
  moveBookmark: (id: string, targetFolderId: string | null) => Promise<{ ok: boolean; error?: string }>
  findBookmarksByUrl: (url: string) => Promise<FlatBookmark[]>
  // 浏览历史
  listHistory: () => Promise<HistoryEntry[]>
  clearHistory: () => Promise<boolean>
  // 设置
  getSettings: () => Promise<Settings>
  setSettings: (patch: Partial<Settings>) => Promise<Settings>
  // 窗口
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  closeWindow: () => Promise<void>
  reportChromeHeight: (height: number) => Promise<boolean>
  // 通用顶层浮层(chrome 侧):打开/更新/关闭任意 Overlay 内容
  showOverlay: (content: OverlayContent | null) => Promise<boolean>
  // 通用浮层事件(overlay 页面 → chrome,由 chrome 按 id 分发)
  onOverlayEvent: (cb: (ev: OverlayEvent) => void) => () => void
  // 以下仅 overlay 页面使用
  onOverlayShow: (cb: (msg: OverlayShowMessage | null) => void) => () => void
  overlayEmit: (id: OverlayContentId, event: string, args?: unknown) => Promise<boolean>
  // 事件订阅(返回取消订阅函数)
  onTabUpdated: (cb: (tab: TabInfo) => void) => () => void
  onTabsChanged: (cb: (tabs: TabInfo[]) => void) => () => void
  onTabActivated: (cb: (id: number) => void) => () => void
  onBookmarksChanged: (cb: (tree: BookmarkTree) => void) => () => void
  onSettingsChanged: (cb: (settings: Settings) => void) => () => void
}

const subscribe = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: BrowserAPI = {
  createTab: (url, activate) => ipcRenderer.invoke('tab:create', url, activate),
  closeTab: (id) => ipcRenderer.invoke('tab:close', id),
  restoreTab: () => ipcRenderer.invoke('tab:restore'),
  activateTab: (id) => ipcRenderer.invoke('tab:activate', id),
  listTabs: () => ipcRenderer.invoke('tab:list'),
  getActiveTab: () => ipcRenderer.invoke('tab:active'),
  go: (input) => ipcRenderer.invoke('nav:go', input),
  goUrl: (url) => ipcRenderer.invoke('nav:url', url),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),
  stop: () => ipcRenderer.invoke('nav:stop'),
  listBookmarks: () => ipcRenderer.invoke('bookmarks:list'),
  addBookmark: (input) => ipcRenderer.invoke('bookmarks:add', input),
  addFolder: (input) => ipcRenderer.invoke('bookmarks:add-folder', input),
  updateBookmark: (id, patch) => ipcRenderer.invoke('bookmarks:update', id, patch),
  removeBookmark: (id) => ipcRenderer.invoke('bookmarks:remove', id),
  moveBookmark: (id, targetFolderId) => ipcRenderer.invoke('bookmarks:move', id, targetFolderId),
  findBookmarksByUrl: (url) => ipcRenderer.invoke('bookmarks:find-by-url', url),
  listHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  reportChromeHeight: (height) => ipcRenderer.invoke('ui:chrome-height', height),
  showOverlay: (content) => ipcRenderer.invoke('ui:overlay', content),
  onOverlayEvent: (cb) => subscribe('overlay-event', cb),
  onOverlayShow: (cb) => subscribe('overlay:show', cb),
  overlayEmit: (id, event, args) => ipcRenderer.invoke('ui:overlay-event', { id, event, args }),
  onTabUpdated: (cb) => subscribe('tab:updated', cb),
  onTabsChanged: (cb) => subscribe('tab:list-changed', cb),
  onTabActivated: (cb) => subscribe('tab:activated', cb),
  onBookmarksChanged: (cb) => subscribe('bookmarks:changed', cb),
  onSettingsChanged: (cb) => subscribe('settings:changed', cb)
}

contextBridge.exposeInMainWorld('browserAPI', api)