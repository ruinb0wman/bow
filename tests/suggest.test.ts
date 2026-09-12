import { describe, expect, it } from 'vitest'
import { buildSuggestions, fuzzyMatch, fuzzyScore, highlightRanges } from '../src/shared/suggest'
import type { FlatBookmark, HistoryEntry } from '../src/shared/types'

const history: HistoryEntry[] = [
  { id: 'h1', title: 'GitHub', url: 'https://github.com', kind: 'page', visitedAt: 3000 },
  { id: 'h2', title: 'YouTube', url: 'https://www.youtube.com', kind: 'page', visitedAt: 2000 },
  { id: 'h3', title: '谷歌地图', url: 'https://maps.google.com', kind: 'search', query: '谷歌地图', visitedAt: 1000 }
]

const bookmarks: FlatBookmark[] = [
  { id: 'b1', type: 'bookmark', title: 'GitHub', url: 'https://github.com', path: '开发/GitHub' },
  { id: 'b2', type: 'bookmark', title: 'MDN Web Docs', url: 'https://developer.mozilla.org', path: '开发/MDN Web Docs' }
]

describe('子序列模糊匹配 fuzzyMatch', () => {
  it('字符按序但不连续即可匹配', () => {
    expect(fuzzyMatch('gh', 'GitHub')).toBe(true)
    expect(fuzzyMatch('yu', 'YouTube')).toBe(true)
    expect(fuzzyMatch('ggl', 'google')).toBe(true)
  })
  it('忽略大小写', () => {
    expect(fuzzyMatch('GIT', 'github')).toBe(true)
    expect(fuzzyMatch('GitHub', 'GITHUB')).toBe(true)
  })
  it('中文逐字匹配', () => {
    expect(fuzzyMatch('谷', '谷歌地图')).toBe(true)
    expect(fuzzyMatch('地圖', '百度地图')).toBe(false) // 简体/繁体不同字
  })
  it('不匹配反例与空输入', () => {
    expect(fuzzyMatch('abc', 'acb')).toBe(false)
    expect(fuzzyMatch('xyz', 'github')).toBe(false)
    expect(fuzzyMatch('', 'anything')).toBe(true)
    expect(fuzzyMatch('a', '')).toBe(false)
  })
})

describe('fuzzyScore 排序启发', () => {
  it('首个匹配字符越靠前分越高', () => {
    expect(fuzzyScore('ab', 'aXb')).toBeGreaterThan(fuzzyScore('ab', 'caXb'))
  })
  it('命中词边界加分(git 优先命 Git 而非 digit)', () => {
    expect(fuzzyScore('git', 'git')).toBeGreaterThan(fuzzyScore('git', 'digit'))
  })
  it('不匹配返回 0', () => {
    expect(fuzzyScore('zz', 'github')).toBe(0)
  })
})

describe('highlightRanges', () => {
  it('先原始顺序再合并连续段', () => {
    expect(highlightRanges('gh', 'GitHub')).toEqual([
      [0, 1],
      [3, 4]
    ])
    expect(highlightRanges('google', 'Google Maps')).toEqual([[0, 6]])
    expect(highlightRanges('xyz', 'github')).toEqual([])
  })
})

describe('buildSuggestions', () => {
  it('空输入:只返回最近历史,无搜索建议、不合并书签', () => {
    const out = buildSuggestions('', history, bookmarks)
    expect(out).toHaveLength(3)
    expect(out.every((s) => s.kind === 'history')).toBe(true)
    expect(out[0].visitedAt).toBe(3000) // 最近优先
    expect(out[0].id).toBe('h1')
  })

  it('非空输入:首行固定搜索建议', () => {
    const out = buildSuggestions('git', history, bookmarks)
    expect(out[0].kind).toBe('search')
    expect(out[0].query).toBe('git')
  })

  it('标题命中排在 URL 命中之前', () => {
    const hist2: HistoryEntry[] = [
      { id: 'a', title: '无关页面', url: 'https://git.example.com', kind: 'page', visitedAt: 1 },
      { id: 'b', title: 'Git examples', url: 'https://example.com', kind: 'page', visitedAt: 2 }
    ]
    const out = buildSuggestions('git', hist2, [])
    const rows = out.filter((s) => s.kind !== 'search')
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('同 URL 时书签优先(只出一条)', () => {
    const out = buildSuggestions('github', history, bookmarks)
    const gh = out.filter((s) => (s as { url?: string }).url === 'https://github.com')
    expect(gh).toHaveLength(1)
    expect(gh[0].kind).toBe('bookmark')
  })

  it('历史搜索词也可作为匹配文本(query 即历史行标题)', () => {
    const out = buildSuggestions('谷歌', history, bookmarks)
    const row = out.find((s) => s.id === 'h3')
    expect(row).toBeTruthy()
    expect(row?.title).toBe('谷歌地图')
  })

  it('limit 截断总数(含搜索建议行)', () => {
    const big = history.concat(
      Array.from({ length: 20 }, (_, i): HistoryEntry => ({
        id: `x${i}`,
        title: `Page ${i}`,
        url: `https://page${i}.com`,
        kind: 'page',
        visitedAt: 9999 - i
      }))
    )
    const out = buildSuggestions('page', big, [], { limit: 5 })
    expect(out.length).toBeLessThanOrEqual(5)
    expect(out[0].kind).toBe('search')
  })

  it('空输入与 limit:只返回 limit 条最近历史', () => {
    const big = Array.from({ length: 30 }, (_, i): HistoryEntry => ({
      id: `x${i}`,
      title: `Page ${i}`,
      url: `https://page${i}.com`,
      kind: 'page',
      visitedAt: 9999 - i
    }))
    const out = buildSuggestions('', big, [])
    expect(out).toHaveLength(9)
    expect(out[0].id).toBe('x0') // 最近的在最前
  })
})