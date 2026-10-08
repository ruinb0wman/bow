/**
 * 书签插件:主进程与渲染层共用的 IPC 返回形状(避免两边各写一份)。
 * 纯类型,不 import electron —— 渲染层(设置页的 `BookmarksSettings.vue`)也要用。
 */

export interface OkResult {
  ok: boolean
  error?: string
}

/** 导出整棵书签树到 bow 下载目录 */
export interface BookmarkExportResult extends OkResult {
  /** 实际落盘的绝对路径 */
  path?: string
}

/**
 * 导入一份 JSON 书签树(**整树替换**)。
 * `canceled` = 用户在文件选择框里取消,不是错误;`dropped` / `reissued` 见 `normalizeImportedTree()`。
 */
export interface BookmarkImportResult extends OkResult {
  canceled?: boolean
  path?: string
  bookmarks?: number
  folders?: number
  dropped?: number
  reissued?: number
}
