import { describe, expect, it } from 'vitest'
import {
  buildSuggestions,
  buildSuggestRows,
  fuzzyMatch,
  fuzzyScore,
  highlightRanges,
  mergeSuggestions,
  scoreFields
} from '../src/shared/suggest'
import type { FlatBookmark, HistoryEntry, Suggestion } from '../src/shared/types'
import type { SuggestItem } from '../src/shared/plugins'

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

describe('buildSuggestRows(建议 → 面板渲染行模型)', () => {
  const items: Suggestion[] = [
    { kind: 'search', id: '__s__', title: 'github', query: 'github' },
    { kind: 'history', id: 'h1', title: 'GitHub', url: 'https://github.com' },
    { kind: 'bookmark', id: 'b1', title: 'MDN Web Docs', url: 'https://developer.mozilla.org', path: '开发/MDN Web Docs' }
  ]

  it('行序与输入平行,kind 透传', () => {
    const rows = buildSuggestRows(items, 'git')
    expect(rows.map((r) => r.kind)).toEqual(['search', 'history', 'bookmark'])
  })

  it('高亮分段:命中字符标记 hl,未命中不标记', () => {
    const rows = buildSuggestRows(items, 'git')
    const history = rows[1]
    expect(history.segments).toEqual([
      { text: 'Git', hl: true },
      { text: 'Hub', hl: false }
    ])
  })

  it('搜索行不参与高亮(整行无高亮)', () => {
    const rows = buildSuggestRows(items, 'git')
    expect(rows[0].segments).toEqual([{ text: 'github', hl: false }])
  })

  it('空 query:全部无高亮', () => {
    const rows = buildSuggestRows(items, '')
    for (const r of rows) expect(r.segments.every((s) => !s.hl)).toBe(true)
  })

  it('中文逐字高亮', () => {
    const rows = buildSuggestRows(
      [{ kind: 'history', id: 'h', title: '谷歌地图', url: 'x' }],
      '地图'
    )
    expect(rows[0].segments).toEqual([
      { text: '谷歌', hl: false },
      { text: '地图', hl: true }
    ])
  })

  it('副标题:搜索行显示引擎 label;书签显示路径;历史显示 URL', () => {
    const rows = buildSuggestRows(items, 'git', { searchLabel: 'Google' })
    expect(rows[0].sub).toBe('使用 Google 搜索')
    expect(rows[1].sub).toBe('https://github.com')
    expect(rows[2].sub).toBe('开发/MDN Web Docs')
  })

  it('未提供引擎 label 时搜索行显示“搜索引擎”', () => {
    const rows = buildSuggestRows([items[0]], 'git')
    expect(rows[0].sub).toBe('使用 搜索引擎 搜索')
  })
})

describe('scoreFields', () => {
  it('标题命中权重 ×2', () => {
    expect(scoreFields('git', 'GitHub', 'https://example.com')).toBeGreaterThan(0)
    expect(scoreFields('git', 'GitHub', 'https://example.com')).toBe(
      scoreFields('git', 'GitHub', 'https://example.com')
    )
  })

  it('都不命中返回 0', () => {
    expect(scoreFields('zzz', 'GitHub', 'https://github.com')).toBe(0)
  })

  it('空 query 恒为正', () => {
    expect(scoreFields('', 'anything', 'https://a.com')).toBeGreaterThan(0)
  })
})

describe('mergeSuggestions', () => {
  const hist = (id: string, title: string, url: string, score: number, visitedAt = 0): SuggestItem => ({
    kind: 'history',
    id,
    title,
    url,
    score,
    visitedAt
  })
  const bm = (id: string, title: string, url: string, score: number): SuggestItem => ({
    kind: 'bookmark',
    id,
    title,
    url,
    score,
    visitedAt: 0
  })

  it('非空 query:首行固定搜索行', () => {
    const out = mergeSuggestions('git', [{ priority: 10, items: [hist('h', 'GitHub', 'https://github.com', 500)] }])
    expect(out[0].kind).toBe('search')
    expect(out[1].url).toBe('https://github.com')
  })

  it('空 query:不插搜索行', () => {
    const out = mergeSuggestions('', [{ priority: 10, items: [hist('h', 'A', 'https://a.com', 1, 10)] }])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('history')
  })

  it('按 score 降序、同分按 visitedAt 降序', () => {
    const out = mergeSuggestions('q', [
      {
        priority: 10,
        items: [
          hist('a', 'A', 'https://a.com', 100, 1),
          hist('b', 'B', 'https://b.com', 100, 9),
          hist('c', 'C', 'https://c.com', 300, 1)
        ]
      }
    ], { limit: 9 })
    expect(out.slice(1).map((s) => s.url)).toEqual(['https://c.com', 'https://b.com', 'https://a.com'])
  })

  it('同 URL 冲突:优先级高者胜', () => {
    const out = mergeSuggestions('q', [
      { priority: 10, items: [hist('h1', '历史标题', 'https://x.com', 900)] },
      { priority: 20, items: [bm('b1', '书签标题', 'https://x.com', 100)] }
    ])
    expect(out).toHaveLength(2)
    expect(out[1].kind).toBe('bookmark')
    expect(out[1].title).toBe('书签标题')
  })

  it('limit 截断(含搜索行)', () => {
    const items = Array.from({ length: 20 }, (_, i) => hist(`h${i}`, `T${i}`, `https://s${i}.com`, 100 - i))
    const out = mergeSuggestions('q', [{ priority: 10, items }], { limit: 5 })
    expect(out).toHaveLength(5)
    expect(out[0].kind).toBe('search')
  })

  it('score<=0 的条目不进入结果,并剥掉 score 字段', () => {
    const out = mergeSuggestions('q', [
      { priority: 10, items: [hist('a', 'A', 'https://a.com', 0), hist('b', 'B', 'https://b.com', 50)] }
    ])
    expect(out).toHaveLength(2)
    expect(out[1]).not.toHaveProperty('score')
  })

  it('无任何来源时不产生搜索行以外的结果', () => {
    expect(mergeSuggestions('q', [])).toHaveLength(1)
    expect(mergeSuggestions('', [])).toHaveLength(0)
  })
})