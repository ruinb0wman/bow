/** 共享类型:main / preload / renderer 三端通用 */

import type { LayoutPreset, PaneBox, Rect } from './split'

export interface TabInfo {
  id: number
  /** 所属窗口 id(多窗口下由 `WindowManager.allTabs()` 补上;tabId 全局唯一) */
  windowId?: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
  crashed: boolean
  /** 内部页面标签(如 bow://settings):只承载浏览器自有页面,不允许就地导航到普通站点 */
  internal?: boolean
  /** DevTools 前端标签(远程调试用,devtools://…):与内部页面一样不是「可浏览页面」,但不给 preload */
  inspector?: boolean
  /** 所属标签组(标签栏的一项);MCP / 插件据此看出哪两个标签是一对 */
  groupId?: number
}

/**
 * 标签组快照(标签栏 + 分屏面板的渲染数据)。组本身的语义见 `@shared/groups`:
 * **标签栏里的每一项就是一个组**,组里是一棵可任意嵌套的分屏布局树。
 *
 * 不下发布局树本身 —— 渲染层只需要「窗格顺序 + 主进程算好的几何」。
 */
export interface TabGroupInfo {
  id: number
  /** 组内窗格标签 id(阅读顺序 = 树先序) */
  tabIds: number[]
  /** 聚焦的窗格标签 id */
  focus: number
  /** 活动组的窗格几何(窗口内容坐标,只含可见叶子);非活动组为 `[]` */
  panes: PaneBox[]
  /** 活动组的分隔条带(同上);非活动组为 `[]` */
  dividers: Rect[]
}

export type BookmarkNode =
  | { id: string; type: 'bookmark'; title: string; url: string }
  | { id: string; type: 'folder'; title: string; children: BookmarkNode[] }

export type BookmarkTree = BookmarkNode[]

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'baidu'

/** 浏览历史条目:kind 为 search 时记录原始搜索词(query)便于展示与匹配 */
export type HistoryKind = 'search' | 'page'

export interface HistoryEntry {
  id: string
  title: string
  url: string
  kind: HistoryKind
  query?: string
  visitedAt: number // epoch ms
}

export type HistoryList = HistoryEntry[]

/** 历史插件配置:保留的条数上限 */
export interface HistorySettings {
  maxEntries: number
}

/** 地址栏下拉建议行 */
export type SuggestionKind = 'search' | 'history' | 'bookmark'

// ---------- 通用 Overlay 浮层框架(复用契约) ----------
/** 浮层布局位:full=全窗遮罩(modal);below-chrome=页面区条带(不遮工具栏/标签栏) */
export type OverlayPlacement = 'full' | 'below-chrome'

/**
 * 核心 Overlay 内容标识(渲染层组件注册表的 key)。
 * 约定:`suggest` = 地址栏建议下拉;`confirm-close` = 关闭窗口确认(多标签时);
 * `split-menu` = 分屏下拉面板(工具栏按钮触发);
 * 设置等浏览器自有页面已改为内部标签页(bow://settings),不再占用浮层。
 */
export type CoreOverlayContentId = 'suggest' | 'confirm-close' | 'split-menu'

/** 插件浮层 id 约定:`plugin:<pluginId>:<panelId>` */
export type PluginOverlayContentId = `plugin:${string}`

export type OverlayContentId = CoreOverlayContentId | PluginOverlayContentId

/** 关闭窗口确认浮层:标签数按主进程拦下 close 时的快照(见 main/closeConfirm.ts) */
export interface CloseConfirmPayload {
  tabCount: number
}

/**
 * 分屏面板浮层的 payload(由 chrome 侧组装;面板只读它、回传事件)。
 * `rect` 与 `SuggestPayload.rect` 同形 —— `OverlayManager.bandTopOf()` 就是靠它把条带贴到按钮底下。
 */
export interface SplitPaneInfo {
  tabId: number
  title: string
  url: string
  crashed: boolean
}

export interface SplitMenuPayload {
  rect: { x: number; y: number; width: number; height: number }
  /** 当前活动组的窗格(阅读顺序) */
  panes: SplitPaneInfo[]
  /** 聚焦的窗格;没有窗格时为 null */
  focusedTabId: number | null
  /** 已保存的布局(只存结构;套用时在新标签组里打开) */
  layouts: LayoutPreset[]
}

/** 核心内容 id 的类型化 payload;插件浮层 payload 由插件自定义(unknown) */
export interface OverlayContentMap {
  suggest: SuggestPayload
  'confirm-close': CloseConfirmPayload
  'split-menu': SplitMenuPayload
}

export type OverlayPayload<K extends OverlayContentId> = K extends keyof OverlayContentMap
  ? OverlayContentMap[K]
  : unknown

/** chrome 侧打开/更新浮层时下发的内容描述 */
export interface OverlayContent<K extends OverlayContentId = OverlayContentId> {
  id: K
  payload: OverlayPayload<K>
  placement: OverlayPlacement
}

/** 主进程转发给 overlay 页面的展示消息(meta 由主进程注入) */
export interface OverlayShowMessage<K extends OverlayContentId = OverlayContentId> extends OverlayContent<K> {
  meta: { bandTop: number }
}

/** overlay 页面 → chrome 的泛型事件(name 由各内容组件自定) */
export interface OverlayEvent {
  id: OverlayContentId
  event: string
  args?: unknown
}

/** 建议面板的渲染行模型(与 Suggestion 平行,chrome 侧按索引还原执行动作) */
export interface SuggestRow {
  kind: SuggestionKind
  segments: Array<{ text: string; hl: boolean }>
  sub: string
}

export interface SuggestPayload {
  rows: SuggestRow[]
  /** 与 rows 平行的原始建议列表,chrome 侧 pick 时按索引还原 */
  suggestions: Suggestion[]
  activeIdx: number
  /** 地址栏在窗口内的实测矩形(用于面板定位) */
  rect: { x: number; y: number; width: number; height: number }
}

export interface Suggestion {
  kind: SuggestionKind
  id: string
  title: string
  url?: string
  query?: string
  path?: string // 书签路径(文件夹/书名)
  visitedAt?: number
}

export interface Settings {
  searchEngine: SearchEngineId
  homepage: string
  /** 总开关:开启时对白名单主机的响应注入 CORS 放行头 */
  corsBypassEnabled: boolean
  /** CORS 放行白名单:域名 / IP / host:端口 / *.子域,匹配规则见 @shared/cors */
  corsWhitelist: string[]
}

export interface FlatBookmark {
  id: string
  type: 'bookmark' | 'folder'
  title: string
  url?: string
  path: string // 展示用的路径,如 "文件夹/子文件夹"
}

export interface SnapshotElement {
  tag: string
  role?: string
  id?: string
  name?: string
  type?: string
  label?: string
  href?: string
  text: string
  selector: string
  visible: boolean
}

export interface PageSnapshot {
  title: string
  url: string
  elements: SnapshotElement[]
}

export interface ActionResult {
  ok: boolean
  error?: string
  [key: string]: unknown
}