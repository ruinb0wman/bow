/** 浏览历史纯逻辑(可单测):按 URL 去重、最近优先、容量上限、搜索与删除 */

import type { HistoryEntry, HistoryKind, HistoryList } from './types'
import { scoreFields } from './suggest'

/** 历史容量上限默认值与有效范围:超出后从尾部(最旧)淘汰 */
export const HISTORY_CAP = 500
export const HISTORY_CAP_MIN = 1
export const HISTORY_CAP_MAX = 100000

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

/** 把任意数值钳制为合法的保留条数:取整到 [MIN, MAX],非法值回退默认上限 */
export function clampHistoryCap(n: number): number {
  if (!Number.isFinite(n)) return HISTORY_CAP
  const int = Math.floor(n)
  if (int < HISTORY_CAP_MIN) return HISTORY_CAP_MIN
  if (int > HISTORY_CAP_MAX) return HISTORY_CAP_MAX
  return int
}

/** 按保留上限裁剪(返回新列表,不修改入参):保留头部最新的 cap 条 */
export function trimHistory(list: HistoryList, cap: number): HistoryList {
  const limit = clampHistoryCap(cap)
  return list.length > limit ? list.slice(0, limit) : list
}

/** 按 id 批量删除(返回新列表,不修改入参):忽略不存在的 id */
export function removeHistoryEntries(list: HistoryList, ids: string[]): HistoryList {
  if (ids.length === 0) return list
  const drop = new Set(ids)
  return list.filter((h) => !drop.has(h.id))
}

/**
 * 搜索历史:
 * - 空 query:按原顺序(最近优先)返回;
 * - 非空:对 query ?? title 与 url 做大小写不敏感模糊子序列匹配,
 *   按 score 降序、visitedAt 降序排序。
 */
export function searchHistory(list: HistoryList, query: string): HistoryList {
  const q = query.trim()
  if (!q) return list
  const hits: Array<{ entry: HistoryEntry; score: number }> = []
  for (const h of list) {
    const score = scoreFields(q, h.query ?? h.title, h.url)
    if (score <= 0) continue
    hits.push({ entry: h, score })
  }
  hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.entry.visitedAt - a.entry.visitedAt))
  return hits.map((h) => h.entry)
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 历史条目相对时间文案:刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / YYYY-MM-DD */
export function formatHistoryTime(ts: number, now = Date.now()): string {
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`

  const d = new Date(ts)
  const today = new Date(now)
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  if (sameDay) return `${Math.floor(diff / 3_600_000)} 小时前`

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  if (isYesterday) return `昨天 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`

  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
