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
}

export type BookmarkNode =
  | { id: string; type: 'bookmark'; title: string; url: string }
  | { id: string; type: 'folder'; title: string; children: BookmarkNode[] }

export type BookmarkTree = BookmarkNode[]

export type SearchEngineId = 'google' | 'duckduckgo' | 'bing' | 'baidu'

/** 顶层 Overlay 弹层类型(chrome UI 通过 ui:modal 开关) */
export type ModalKind = 'bookmarks' | 'settings'

export interface Settings {
  searchEngine: SearchEngineId
  homepage: string
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