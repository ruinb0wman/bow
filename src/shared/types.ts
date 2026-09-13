/** 共享类型:main / preload / renderer 三端通用 */

export interface TabInfo {
  id: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
  crashed: boolean
  /** 内部页面标签(如 bow://settings):只承载浏览器自有页面,不允许就地导航到普通站点 */
  internal?: boolean
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
 * 约定:`suggest` = 地址栏建议下拉;设置等浏览器自有页面已改为内部标签页(bow://settings),
 * 不再占用浮层。
 */
export type CoreOverlayContentId = 'suggest'

/** 插件浮层 id 约定:`plugin:<pluginId>:<panelId>` */
export type PluginOverlayContentId = `plugin:${string}`

export type OverlayContentId = CoreOverlayContentId | PluginOverlayContentId

/** 核心内容 id 的类型化 payload;插件浮层 payload 由插件自定义(unknown) */
export interface OverlayContentMap {
  suggest: SuggestPayload
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