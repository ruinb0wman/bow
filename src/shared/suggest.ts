/** 地址栏模糊匹配与建议纯逻辑(可单测):子序列匹配 + 历史/书签合并建议 */

import type { FlatBookmark, HistoryEntry, Suggestion, SuggestRow } from './types'
import type { SuggestItem } from './plugins'

/** 是否为词边界(行首或前一个字符非字母数字):命中边界加分,让 "git" 优先命中 "GitHub" 而非 "digit" */
function isBoundary(text: string, i: number): boolean {
  if (i <= 0) return true
  return !/[a-z0-9]/i.test(text[i - 1])
}

/**
 * 子序列模糊匹配:query 字符在 text 中按序逐一出现即可(不必连续),忽略大小写。
 * 空 query 恒为 true(用于"什么都不输入也能匹配文本"的场景)。
 */
export function fuzzyMatch(query: string, text: string): boolean {
  return fuzzyScore(query, text) > 0
}

/**
 * 模糊匹配得分:0 表示不匹配,正数越高越优。启发式:
 * - 首个匹配字符越靠前分越高;
 * - 连续字符段加分;命中词边界加分;文本越短小加分。
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 1
  if (!t) return 0
  let ti = 0
  let firstIdx = -1
  let lastIdx = -1
  let contiguous = 0
  let boundaryHits = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    while (ti < t.length && t[ti] !== ch) ti++
    if (ti >= t.length) return 0
    if (firstIdx < 0) firstIdx = ti
    if (lastIdx >= 0 && ti === lastIdx + 1) contiguous++
    if (isBoundary(t, ti)) boundaryHits++
    lastIdx = ti
    ti++
  }
  let score = 1000 - firstIdx * 10
  score += contiguous * 20
  score += boundaryHits * 15
  score += Math.max(0, 50 - t.length)
  return score
}

/** 返回匹配字符的区间(连续段合并为 [start, end)),供 UI 高亮 */
export function highlightRanges(query: string, text: string): Array<[number, number]> {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let ti = 0
  const points: number[] = []
  for (let qi = 0; qi < q.length; qi++) {
    while (ti < t.length && t[ti] !== q[qi]) ti++
    if (ti >= t.length) break
    points.push(ti)
    ti++
  }
  const ranges: Array<[number, number]> = []
  for (const p of points) {
    const last = ranges[ranges.length - 1]
    if (last && p === last[1]) last[1] = p + 1
    else ranges.push([p, p + 1])
  }
  return ranges
}

/** 标题/URL 双字段综合分:标题命中权重 ×2,取两者最高分。导出供各插件建议源复用 */
export function scoreFields(query: string, title: string, url: string): number {
  const ts = fuzzyScore(query, title)
  const us = fuzzyScore(query, url)
  if (ts > 0 && us > 0) return Math.max(ts * 2, us)
  if (ts > 0) return ts * 2
  return us
}

export interface BuildSuggestOptions {
  /** 建议总数上限(默认 9:1 条搜索建议 + 8 条命中) */
  limit?: number
}

export interface SuggestProviderInput {
  /** 同 URL 冲突时的优先级(大者胜) */
  priority: number
  items: SuggestItem[]
}

/**
 * 多来源建议合并(插件内核与兼容包装共用):
 * - 按 URL 去重,同 URL 取「来源优先级高 > score 高」者;
 * - 全局按 score 降序、visitedAt 降序;同分书签优先由各来源的 priority 在冲突时体现;
 * - 非空 query 时首行固定搜索建议,总条数截断至 limit;空 query 不插搜索行。
 */
export function mergeSuggestions(
  query: string,
  providers: SuggestProviderInput[],
  opts: BuildSuggestOptions = {}
): Suggestion[] {
  const limit = opts.limit ?? 9
  const q = query.trim()

  const byUrl = new Map<string, { s: SuggestItem; priority: number }>()
  for (const p of providers) {
    for (const item of p.items) {
      if (item.score <= 0) continue
      const key = item.url ?? item.id
      const prev = byUrl.get(key)
      if (!prev || p.priority > prev.priority || (p.priority === prev.priority && item.score > prev.s.score)) {
        byUrl.set(key, { s: item, priority: p.priority })
      }
    }
  }

  const ranked = [...byUrl.values()].sort((a, b) => {
    if (b.s.score !== a.s.score) return b.s.score - a.s.score
    return (b.s.visitedAt ?? 0) - (a.s.visitedAt ?? 0)
  })

  const strip = (s: SuggestItem): Suggestion => {
    const { score: _score, ...rest } = s
    return rest
  }

  if (!q) {
    return ranked.slice(0, limit).map((r) => strip(r.s))
  }

  const out: Suggestion[] = [{ kind: 'search', id: '__suggest_search__', title: q, query: q }]
  out.push(...ranked.slice(0, Math.max(0, limit - 1)).map((r) => strip(r.s)))
  return out
}

/**
 * 由输入生成地址栏建议(历史 + 书签):
 * - 输入为空/纯空白:仅返回最近的 limit 条历史(不合并书签、不发搜索建议);
 * - 非空:首行固定搜索建议,随后按综合分降序合并历史与书签命中(标题命中 > URL 命中),
 *   同分按 visitedAt 降序;URL 冲突时书签行优先;总条数截断至 limit。
 *
 * 兼容包装:插件化后内核改走各来源的 SuggestProvider + mergeSuggestions。
 */
export function buildSuggestions(
  input: string,
  history: HistoryEntry[],
  bookmarks: FlatBookmark[],
  opts: BuildSuggestOptions = {}
): Suggestion[] {
  const limit = opts.limit ?? 9
  const query = input.trim()

  if (!query) {
    return mergeSuggestions(
      '',
      [
        {
          priority: 10,
          items: history.slice(0, limit).map((h): SuggestItem => ({
            kind: 'history',
            id: h.id,
            title: h.query ?? h.title,
            url: h.url,
            query: h.query,
            visitedAt: h.visitedAt,
            score: 1
          }))
        }
      ],
      { limit }
    )
  }

  const historyItems: SuggestItem[] = []
  for (const h of history) {
    const score = scoreFields(query, h.query ?? h.title, h.url)
    if (score <= 0) continue
    historyItems.push({
      kind: 'history',
      id: h.id,
      title: h.query ?? h.title,
      url: h.url,
      query: h.query,
      visitedAt: h.visitedAt,
      score
    })
  }
  const bookmarkItems: SuggestItem[] = []
  for (const b of bookmarks) {
    const url = b.url ?? ''
    const score = scoreFields(query, b.title, url)
    if (score <= 0) continue
    bookmarkItems.push({
      kind: 'bookmark',
      id: b.id,
      title: b.title,
      url: b.url,
      path: b.path,
      visitedAt: 0,
      score
    })
  }

  return mergeSuggestions(
    query,
    [
      { priority: 10, items: historyItems },
      { priority: 20, items: bookmarkItems }
    ],
    { limit }
  )
}

/** 标题高亮分段:match 到的字符用 .hl 包裹 */
function titleSegments(s: Suggestion, query: string): SuggestRow['segments'] {
  const text = s.title
  const q = query.trim()
  if (!q || s.kind === 'search') return [{ text, hl: false }]
  const segs: Array<{ text: string; hl: boolean }> = []
  let cur = 0
  for (const [st, en] of highlightRanges(q, text)) {
    if (st > cur) segs.push({ text: text.slice(cur, st), hl: false })
    segs.push({ text: text.slice(st, en), hl: true })
    cur = en
  }
  if (cur < text.length) segs.push({ text: text.slice(cur), hl: false })
  return segs
}

/** 副标题(展示用):搜索行显示引擎 label,其他行显示书签路径或 URL */
function subText(s: Suggestion, searchLabel?: string): string {
  if (s.kind === 'search') return `使用 ${searchLabel ?? '搜索引擎'} 搜索`
  if (s.kind === 'bookmark') return s.path ?? s.url ?? ''
  return s.url ?? ''
}

export interface BuildSuggestRowsOptions {
  /** 搜索建议行副标题里的引擎名(如 'Google'),缺省显示“搜索引擎” */
  searchLabel?: string
}

/**
 * 由建议列表生成面板渲染行模型(buildSuggestions 的输出 → SuggestRow[]),
 * chrome 与 suggest 面板共用;纯函数可单测。
 */
export function buildSuggestRows(
  items: Suggestion[],
  query: string,
  opts: BuildSuggestRowsOptions = {}
): SuggestRow[] {
  return items.map((s) => ({
    kind: s.kind,
    segments: titleSegments(s, query),
    sub: subText(s, opts.searchLabel)
  }))
}
