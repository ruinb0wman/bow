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
import type { LayoutPreset, PaneDir } from '../shared/split'

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
  // 内部页面认领自己所属的标签 id(终端页据此绑定会话);不是标签页(null)的返回 null
  getSelfTabId: () => Promise<number | null>
  // 剪贴板(经主进程,避免 renderer 侧 clipboard 的权限/secure context 差异)
  readClipboardText: () => Promise<string>
  writeClipboardText: (text: string) => Promise<boolean>
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
  // 标签组(标签栏一项 = 一个组;组里是嵌套分屏树)
  getGroups: () => Promise<TabGroupInfo[]>
  groupsActivate: (groupId: number) => Promise<TabGroupInfo[]>
  // 分屏 / 调整大小:键盘入口在主进程(tabShortcuts.ts);这两条是渲染层兜底与 E2E 的入口
  splitPane: (dir: PaneDir) => Promise<TabGroupInfo[]>
  resizePane: (dir: PaneDir) => Promise<TabGroupInfo[]>
  groupsUngroup: () => Promise<TabGroupInfo[]>
  // 保存的分屏布局(只存结构;套用时在新标签组里开)
  getLayouts: () => Promise<LayoutPreset[]>
  saveLayout: (name?: string) => Promise<LayoutPreset[]>
  applyLayout: (id: string) => Promise<TabGroupInfo[]>
  deleteLayout: (id: string) => Promise<LayoutPreset[]>
  // 通用顶层浮层(chrome 侧):打开/更新/关闭任意 Overlay 内容
  showOverlay: (content: OverlayContent | null) => Promise<boolean>
  // 通用浮层事件(overlay 页面 → chrome / 所属插件)
  onOverlayEvent: (cb: (ev: OverlayEvent) => void) => () => void
  // 主进程 Ctrl+T 新建标签后要求 chrome 聚焦地址栏
  onFocusAddressRequest: (cb: () => void) => () => void
  /**
   * 请求**真正的**地址栏聚焦(键盘焦点交给 chrome webContents,不只是 DOM focus)。
   * 渲染层自己 `el.focus()` 只改 DOM 状态:键盘事件仍进页面,表现为「看着聚焦了但打不进字」。
   */
  requestAddressFocus: () => Promise<boolean>
  // 主进程窗口失焦:chrome 侧主动释放地址栏焦点
  onWindowBlur: (cb: () => void) => () => void
  /**
   * 主进程:键盘焦点已交给某个页面视图 —— chrome 必须收起自己的瞬态面板
   * (地址栏建议下拉 / 分屏面板)。跨 WebContentsView 的焦点切换没有可靠的 DOM 信号。
   */
  onPageFocus: (cb: () => void) => () => void
  // 标签组变化(建组/拆组/分屏/关窗格/聚焦窗格变化/窗口缩放)
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
  getSelfTabId: () => ipcRenderer.invoke('tab:self'),
  readClipboardText: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
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
  splitPane: (dir) => ipcRenderer.invoke('groups:split', dir),
  resizePane: (dir) => ipcRenderer.invoke('groups:resize', dir),
  groupsUngroup: () => ipcRenderer.invoke('groups:ungroup'),
  getLayouts: () => ipcRenderer.invoke('layouts:list'),
  saveLayout: (name) => ipcRenderer.invoke('layouts:save', name),
  applyLayout: (id) => ipcRenderer.invoke('layouts:apply', id),
  deleteLayout: (id) => ipcRenderer.invoke('layouts:delete', id),
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
  requestAddressFocus: () => ipcRenderer.invoke('chrome:request-focus-address'),
  onWindowBlur: (cb) => subscribe('chrome:window-blur', cb),
  onPageFocus: (cb) => subscribe('chrome:page-focus', cb),
  onGroupsChanged: (cb) => subscribe('groups:changed', cb),
  onSettingsChanged: (cb) => subscribe('settings:changed', cb)
}

contextBridge.exposeInMainWorld('browserAPI', api)
