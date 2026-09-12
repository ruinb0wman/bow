/** 浏览历史纯逻辑(可单测):按 URL 去重、最近优先、容量上限 */

import type { HistoryEntry, HistoryKind, HistoryList } from './types'

/** 历史容量上限:超出后从尾部(最旧)淘汰 */
export const HISTORY_CAP = 5000

let idCounter = 0
export function genId(prefix = 'hist'): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export interface NewVisit {
  title: string
  url: string
  kind?: HistoryKind
  query?: string
  visitedAt?: number
}

/**
 * 追加一次访问(返回新列表,不修改入参):
 * - 按 URL 精确去重:同 URL 的旧条目移除,合并后的新条目插入头部(最近优先);
 * - 合并时保留更丰富的信息:任一方为搜索则 kind 保持 'search',query 取先有的非空值;
 * - 空标题回退为 URL;超过 cap 从尾部截断。
 */
export function addHistoryEntry(list: HistoryList, visit: NewVisit, cap = HISTORY_CAP): HistoryList {
  const url = (visit.url || '').trim()
  const title = visit.title.trim() || url
  const query = visit.query?.trim() || undefined
  const kind: HistoryKind = visit.kind ?? (query ? 'search' : 'page')
  const fresh: HistoryEntry = {
    id: genId(),
    title,
    url,
    kind,
    query,
    visitedAt: visit.visitedAt ?? Date.now()
  }

  const old = list.find((h) => h.url === url)
  const next: HistoryEntry[] = [old ? mergeEntry(old, fresh) : fresh]
  for (const h of list) {
    if (h.url !== url) next.push(h)
  }
  if (next.length > cap) next.length = cap
  return next
}

/** 同 URL 新旧条目合并:搜索信息优先保留,标题取新值 */
function mergeEntry(old: HistoryEntry, fresh: HistoryEntry): HistoryEntry {
  return {
    ...fresh,
    kind: old.kind === 'search' || fresh.kind === 'search' ? 'search' : 'page',
    query: fresh.query ?? old.query,
    title: fresh.title || old.title
  }
}
