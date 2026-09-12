/** 浏览历史记录:主进程侧统一记录入口,守卫后走 shared 纯逻辑并持久化 */

import type { HistoryKind } from '@shared/types'
import { addHistoryEntry } from '@shared/history'
import { isHttpUrl } from '@shared/url'
import { getHistoryStore } from './stores'

export interface VisitInput {
  title: string
  url: string
  kind?: HistoryKind
  query?: string
}

/** 记录一次访问:仅记 http(s) 主框架导航;about:blank / 其他 scheme 直接忽略 */
export function recordVisit(v: VisitInput): void {
  const url = v.url.trim()
  if (!isHttpUrl(url)) return
  const store = getHistoryStore()
  store.setRaw(addHistoryEntry(store.get(), { ...v, url }))
}

export function clearHistory(): void {
  getHistoryStore().setRaw([])
}