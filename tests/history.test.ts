import { describe, expect, it } from 'vitest'
import {
  HISTORY_CAP,
  HISTORY_CAP_MAX,
  HISTORY_CAP_MIN,
  addHistoryEntry,
  clampHistoryCap,
  formatHistoryTime,
  removeHistoryEntries,
  searchHistory,
  trimHistory
} from '../src/shared/history'
import type { HistoryEntry, HistoryList } from '../src/shared/types'

function visit(title: string, url: string, extra: Partial<{ kind: 'search' | 'page'; query: string; visitedAt: number }> = {}): Parameters<typeof addHistoryEntry>[1] {
  return { title, url, ...extra }
}

describe('历史条目追加', () => {
  it('空列表追加一条:字段齐全、kind 默认 page', () => {
    const list = addHistoryEntry([], visit('GitHub', 'https://github.com'))
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('GitHub')
    expect(list[0].url).toBe('https://github.com')
    expect(list[0].kind).toBe('page')
    expect(list[0].visitedAt).toBeTypeOf('number')
    expect(list[0].id).toBeTruthy()
  })

  it('同 URL 去重并插到头部(最近优先),标题/时间取新值', () => {
    let list: HistoryList = []
    list = addHistoryEntry(list, visit('旧标题', 'https://a.com', { visitedAt: 100 }))
    list = addHistoryEntry(list, visit('新标题', 'https://a.com', { visitedAt: 200 }))
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('新标题')
    expect(list[0].visitedAt).toBe(200)
  })

  it('先 page 后 search(同 URL):kind 升级为 search 并保留 query', () => {
    let list = addHistoryEntry([], visit('t', 'https://a.com', { kind: 'page' }))
    list = addHistoryEntry(list, visit('t', 'https://a.com', { kind: 'search', query: 'hello world', visitedAt: 99 }))
    expect(list).toHaveLength(1)
    expect(list[0].kind).toBe('search')
    expect(list[0].query).toBe('hello world')
  })

  it('先 search 后 page(同 URL):query 与 search 标记不被覆盖', () => {
    let list = addHistoryEntry([], visit('t', 'https://a.com', { kind: 'search', query: 'cats', visitedAt: 99 }))
    list = addHistoryEntry(list, visit('cats - 搜索结果', 'https://a.com', { kind: 'page', visitedAt: 100 }))
    expect(list).toHaveLength(1)
    expect(list[0].query).toBe('cats')
    expect(list[0].kind).toBe('search')
    expect(list[0].title).toBe('cats - 搜索结果')
  })

  it('空标题回退为 URL', () => {
    const list = addHistoryEntry([], visit('   ', 'https://x.com'))
    expect(list[0].title).toBe('https://x.com')
  })

  it('搜索词两端空白被修剪', () => {
    const list = addHistoryEntry([], visit('t', 'https://a.com', { query: '  hi  ' }))
    expect(list[0].query).toBe('hi')
  })

  it('超过上限从尾部(最旧)淘汰', () => {
    let list: HistoryList = []
    for (let i = 0; i < 3; i++) {
      list = addHistoryEntry(list, visit(`t${i}`, `https://site${i}.com`, { visitedAt: i }))
    }
    expect(list).toHaveLength(3)
    list = addHistoryEntry(list, visit('t3', 'https://site3.com', { visitedAt: 3 }))
    expect(list.length).toBeLessThanOrEqual(HISTORY_CAP)
    // 手动小上限验证 LRU
    let small: HistoryList = []
    for (let i = 0; i < 3; i++) {
      small = addHistoryEntry(small, visit(`t${i}`, `https://s${i}.com`, { visitedAt: i }), 2)
    }
    expect(small).toHaveLength(2)
    expect(small.some((h) => h.url === 'https://s0.com')).toBe(false) // 最旧被淘汰
    expect(small[0].url).toBe('https://s2.com') // 最新在头部
  })

  it('不修改入参', () => {
    const input: HistoryList = [
      { id: 'a', title: 'A', url: 'https://a.com', kind: 'page', visitedAt: 1 },
      { id: 'b', title: 'B', url: 'https://b.com', kind: 'page', visitedAt: 2 }
    ]
    const copy = JSON.stringify(input)
    const out = addHistoryEntry(input, visit('C', 'https://c.com'))
    expect(JSON.stringify(input)).toBe(copy)
    expect(out).toHaveLength(3)
    expect(out[0].url).toBe('https://c.com')
  })
})

function entry(id: string, title: string, url: string, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return { id, title, url, kind: 'page', visitedAt: 0, ...extra }
}

describe('历史容量配置', () => {
  it('clampHistoryCap:取整并钳制到有效范围', () => {
    expect(clampHistoryCap(0)).toBe(HISTORY_CAP_MIN)
    expect(clampHistoryCap(-5)).toBe(HISTORY_CAP_MIN)
    expect(clampHistoryCap(1)).toBe(1)
    expect(clampHistoryCap(500.9)).toBe(500)
    expect(clampHistoryCap(HISTORY_CAP_MAX)).toBe(HISTORY_CAP_MAX)
    expect(clampHistoryCap(HISTORY_CAP_MAX + 1)).toBe(HISTORY_CAP_MAX)
  })

  it('clampHistoryCap:非法值回退默认上限', () => {
    expect(clampHistoryCap(Number.NaN)).toBe(HISTORY_CAP)
    expect(clampHistoryCap(Number.POSITIVE_INFINITY)).toBe(HISTORY_CAP)
  })

  it('默认上限为 500', () => {
    expect(HISTORY_CAP).toBe(500)
  })

  it('trimHistory:超限保留最新,不修改入参', () => {
    const input: HistoryList = [
      entry('a', 'A', 'https://a.com'),
      entry('b', 'B', 'https://b.com'),
      entry('c', 'C', 'https://c.com')
    ]
    const copy = JSON.stringify(input)
    const out = trimHistory(input, 2)
    expect(out.map((h) => h.id)).toEqual(['a', 'b'])
    expect(JSON.stringify(input)).toBe(copy)
  })

  it('trimHistory:未超限时原样返回', () => {
    const input: HistoryList = [entry('a', 'A', 'https://a.com')]
    expect(trimHistory(input, 10)).toBe(input)
  })
})

describe('历史删除', () => {
  const list: HistoryList = [
    entry('a', 'A', 'https://a.com'),
    entry('b', 'B', 'https://b.com'),
    entry('c', 'C', 'https://c.com')
  ]

  it('按 id 删除并忽略未知 id', () => {
    const out = removeHistoryEntries(list, ['b', 'nope'])
    expect(out.map((h) => h.id)).toEqual(['a', 'c'])
  })

  it('空数组 no-op 且不修改入参', () => {
    const copy = JSON.stringify(list)
    expect(removeHistoryEntries(list, [])).toBe(list)
    const out = removeHistoryEntries(list, ['a'])
    expect(JSON.stringify(list)).toBe(copy)
    expect(out).toHaveLength(2)
  })
})

describe('历史搜索', () => {
  const list: HistoryList = [
    entry('s1', 'cats - 搜索结果', 'https://google.com/search?q=cats', { kind: 'search', query: 'cats', visitedAt: 100 }),
    entry('p1', 'GitHub', 'https://github.com/explore', { visitedAt: 200 }),
    entry('p2', 'git 教程', 'https://example.com/git-guide', { visitedAt: 50 })
  ]

  it('空 query 原样返回', () => {
    expect(searchHistory(list, '')).toBe(list)
    expect(searchHistory(list, '   ')).toBe(list)
  })

  it('命中搜索词 / 标题 / URL(大小写不敏感)', () => {
    expect(searchHistory(list, 'CATS').map((h) => h.id)).toContain('s1')
    expect(searchHistory(list, 'github').map((h) => h.id)).toEqual(['p1'])
    expect(searchHistory(list, 'git-guide').map((h) => h.id)).toEqual(['p2'])
  })

  it('无匹配返回空', () => {
    expect(searchHistory(list, 'zzzzz')).toEqual([])
  })

  it('命中结果的相对顺序稳定(同分按 visitedAt 降序)', () => {
    const same: HistoryList = [
      entry('old', 'docs', 'https://docs.example.com', { visitedAt: 100 }),
      entry('new', 'docs', 'https://docs.example.com/new', { visitedAt: 200 })
    ]
    expect(searchHistory(same, 'docs').map((h) => h.id)).toEqual(['new', 'old'])
  })
})

describe('历史时间文案', () => {
  const now = new Date(2025, 0, 15, 12, 0, 0).getTime()

  it('刚刚 / 分钟 / 小时', () => {
    expect(formatHistoryTime(now - 10_000, now)).toBe('刚刚')
    expect(formatHistoryTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(formatHistoryTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
  })

  it('昨天带时分', () => {
    const ts = new Date(2025, 0, 14, 9, 5, 0).getTime()
    expect(formatHistoryTime(ts, now)).toBe('昨天 09:05')
  })

  it('更早显示日期', () => {
    const ts = new Date(2025, 0, 10, 9, 5, 0).getTime()
    expect(formatHistoryTime(ts, now)).toBe('2025-01-10')
  })
})