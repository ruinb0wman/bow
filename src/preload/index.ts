import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  OverlayContent,
  OverlayContentId,
  OverlayEvent,
  OverlayShowMessage,
  Settings,
  Suggestion,
  SuggestRow,
  TabInfo
} from '../shared/types'
import type { PluginInfo } from '../shared/plugins'
import type { TabGroupInfo } from '../shared/types'

export interface PluginHostEvent {
  id: string
  event: string
  args?: unknown
}

export interface BrowserAPI {
  // 标签页
  createTab: (url?: string, activate?: boolean) => Promise<TabInfo>
  closeTab: (id: number) => Promise<{ ok: boolean }>
  restoreTab: () => Promise<TabInfo | null>
  activateTab: (id: number) => Promise<TabInfo | null>
  listTabs: () => Promise<TabInfo[]>
  getActiveTab: () => Promise<TabInfo | null>
  // 激活最近浏览的普通页面标签(设置页的「屏蔽元素」等需要回到真实页面执行)
  activateLastBrowsingTab: () => Promise<TabInfo | null>
  // 导航
  go: (input: string) => Promise<{ parsed: string | null; query?: string; url?: string; tabId: number }>
  goUrl: (url: string) => Promise<{ tabId: number }>
  back: () => Promise<boolean>
  forward: () => Promise<boolean>
  reload: () => Promise<void>
  stop: () => Promise<void>
  // 设置(核心:搜索引擎 / 主页)
  getSettings: () => Promise<Settings>
  setSettings: (patch: Partial<Settings>) => Promise<Settings>
  // 窗口
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  closeWindow: () => Promise<void>
  reportChromeHeight: (height: number) => Promise<boolean>
  // 标签组(标签栏一项 = 一个组;分屏组的两个标签在同一项里)
  getGroups: () => Promise<TabGroupInfo[]>
  groupsActivate: (groupId: number) => Promise<TabGroupInfo[]>
  groupsAddTab: (tabId?: number) => Promise<TabGroupInfo[]>
  groupsUngroup: () => Promise<TabGroupInfo[]>
  groupsSetPreset: (presetId: string) => Promise<TabGroupInfo[]>
  // 通用顶层浮层(chrome 侧):打开/更新/关闭任意 Overlay 内容
  showOverlay: (content: OverlayContent | null) => Promise<boolean>
  // 通用浮层事件(overlay 页面 → chrome / 所属插件)
  onOverlayEvent: (cb: (ev: OverlayEvent) => void) => () => void
  // 主进程 Ctrl+T 新建标签后要求 chrome 聚焦地址栏
  onFocusAddressRequest: (cb: () => void) => () => void
  // 主进程窗口失焦:chrome 侧主动释放地址栏焦点
  onWindowBlur: (cb: () => void) => () => void
  // 标签组变化(建组/拆组/换成员/聚焦成员变化/宽度档位变化/窗口缩放)
  onGroupsChanged: (cb: (groups: TabGroupInfo[]) => void) => () => void
  // 以下仅 overlay 页面使用
  onOverlayShow: (cb: (msg: OverlayShowMessage | null) => void) => () => void
  overlayEmit: (id: OverlayContentId, event: string, args?: unknown) => Promise<boolean>
  // 插件调用面
  plugins: {
    list: () => Promise<PluginInfo[]>
    setEnabled: (id: string, enabled: boolean) => Promise<PluginInfo[]>
    invoke: <T = unknown>(id: string, method: string, ...args: unknown[]) => Promise<T>
    overlayEvent: (overlayId: string, event: string, args?: unknown) => Promise<boolean>
    suggest: (input: string) => Promise<{ rows: SuggestRow[]; suggestions: Suggestion[] }>
    onChanged: (cb: (list: PluginInfo[]) => void) => () => void
    onEvent: (cb: (ev: PluginHostEvent) => void) => () => void
  }
  // 事件订阅(返回取消订阅函数)
  onTabUpdated: (cb: (tab: TabInfo) => void) => () => void
  onTabsChanged: (cb: (tabs: TabInfo[]) => void) => () => void
  onTabActivated: (cb: (id: number) => void) => () => void
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
  activateLastBrowsingTab: () => ipcRenderer.invoke('tab:activate-last-browsing'),
  go: (input) => ipcRenderer.invoke('nav:go', input),
  goUrl: (url) => ipcRenderer.invoke('nav:url', url),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),
  stop: () => ipcRenderer.invoke('nav:stop'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  reportChromeHeight: (height) => ipcRenderer.invoke('ui:chrome-height', height),
  getGroups: () => ipcRenderer.invoke('groups:get'),
  groupsActivate: (groupId) => ipcRenderer.invoke('groups:activate', groupId),
  groupsAddTab: (tabId) => ipcRenderer.invoke('groups:add-tab', tabId),
  groupsUngroup: () => ipcRenderer.invoke('groups:ungroup'),
  groupsSetPreset: (presetId) => ipcRenderer.invoke('groups:set-preset', presetId),
  showOverlay: (content) => ipcRenderer.invoke('ui:overlay', content),
  onOverlayEvent: (cb) => subscribe('overlay-event', cb),
  onOverlayShow: (cb) => subscribe('overlay:show', cb),
  overlayEmit: (id, event, args) => ipcRenderer.invoke('ui:overlay-event', { id, event, args }),
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins:set-enabled', id, enabled),
    invoke: (id, method, ...args) => ipcRenderer.invoke('plugins:invoke', id, method, args),
    overlayEvent: (overlayId, event, args) => ipcRenderer.invoke('plugins:overlay-event', overlayId, event, args),
    suggest: (input) => ipcRenderer.invoke('plugins:suggest', input),
    onChanged: (cb) => subscribe('plugins:changed', cb),
    onEvent: (cb) => subscribe('plugin:event', cb)
  },
  onTabUpdated: (cb) => subscribe('tab:updated', cb),
  onTabsChanged: (cb) => subscribe('tab:list-changed', cb),
  onTabActivated: (cb) => subscribe('tab:activated', cb),
  onFocusAddressRequest: (cb) => subscribe('chrome:focus-address', cb),
  onWindowBlur: (cb) => subscribe('chrome:window-blur', cb),
  onGroupsChanged: (cb) => subscribe('groups:changed', cb),
  onSettingsChanged: (cb) => subscribe('settings:changed', cb)
}

contextBridge.exposeInMainWorld('browserAPI', api)
