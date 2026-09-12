import { describe, expect, it } from 'vitest'
import { addHistoryEntry, HISTORY_CAP } from '../src/shared/history'
import type { HistoryList } from '../src/shared/types'

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