/** 地址栏模糊匹配与建议纯逻辑(可单测):子序列匹配 + 历史/书签合并建议 */

import type { FlatBookmark, HistoryEntry, Suggestion } from './types'

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

/** 标题/URL 双字段综合分:标题命中权重 ×2,取两者最高分 */
function entryScore(query: string, title: string, url: string): number {
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

/**
 * 由输入生成地址栏建议:
 * - 输入为空/纯空白:仅返回最近的 limit 条历史(不合并书签、不发搜索建议);
 * - 非空:首行固定搜索建议,随后按综合分降序合并历史与书签命中(标题命中 > URL 命中),
 *   同分按 visitedAt 降序;URL 冲突时书签行优先;总条数截断至 limit。
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
    return history.slice(0, limit).map((h): Suggestion => ({
      kind: 'history',
      id: h.id,
      title: h.query ?? h.title,
      url: h.url,
      query: h.query,
      visitedAt: h.visitedAt
    }))
  }

  const out: Suggestion[] = [
    { kind: 'search', id: '__suggest_search__', title: query, query }
  ]

  const byUrl = new Map<string, { s: Suggestion; score: number }>()
  const place = (url: string, s: Suggestion, score: number): void => {
    const prev = byUrl.get(url)
    // 书签优先于历史;同优先级取高分者
    const prevPriority = prev ? (prev.s.kind === 'bookmark' ? 2 : 1) : 0
    const curPriority = s.kind === 'bookmark' ? 2 : 1
    if (!prev || curPriority > prevPriority || (curPriority === prevPriority && score > prev.score)) {
      byUrl.set(url, { s, score })
    }
  }

  for (const h of history) {
    const score = entryScore(query, h.query ?? h.title, h.url)
    if (score <= 0) continue
    place(h.url, {
      kind: 'history',
      id: h.id,
      title: h.query ?? h.title,
      url: h.url,
      query: h.query,
      visitedAt: h.visitedAt
    }, score)
  }
  for (const b of bookmarks) {
    const score = entryScore(query, b.title, b.url ?? '')
    if (score <= 0) continue
    place(b.url ?? b.id, {
      kind: 'bookmark',
      id: b.id,
      title: b.title,
      url: b.url,
      path: b.path,
      visitedAt: 0
    }, score)
  }

  const ranked = [...byUrl.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return (b.s.visitedAt ?? 0) - (a.s.visitedAt ?? 0)
  })
  out.push(...ranked.slice(0, Math.max(0, limit - 1)).map((r) => r.s))
  return out
}