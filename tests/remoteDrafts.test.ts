/**
 * 手机端草稿的存取(`src/renderer/remote/drafts.ts`)。
 *
 * 这里只钉三件容易错的事:坏 JSON 不炸、cwd 不符不恢复(id 重启后会复用)、上限淘汰最旧。
 */

import { describe, expect, it } from 'vitest'
import {
  DRAFTS_KEY,
  MAX_DRAFT_CHARS,
  MAX_DRAFTS,
  draftFor,
  parseDrafts,
  withDraft,
  withoutDraft
} from '../src/renderer/remote/drafts'

describe('parseDrafts', () => {
  it('坏 JSON / 非对象 / 数组 → 空表', () => {
    expect(parseDrafts('{oops')).toEqual({})
    expect(parseDrafts(null)).toEqual({})
    expect(parseDrafts('[]')).toEqual({})
    expect(parseDrafts('"x"')).toEqual({})
  })

  it('只收「数字键 + 完整条目」,文本按上限截断', () => {
    const raw = JSON.stringify({
      12: { cwd: '/a', text: 'x'.repeat(MAX_DRAFT_CHARS + 10), at: 1 },
      abc: { cwd: '/a', text: 'y', at: 1 },
      13: { cwd: '/a', text: 'z' },
      14: { cwd: '/b', text: 'w', at: 2 }
    })
    const store = parseDrafts(raw)
    expect(Object.keys(store)).toEqual(['12', '14'])
    expect(store['12'].text.length).toBe(MAX_DRAFT_CHARS)
  })
})

describe('draftFor', () => {
  it('cwd 对得上才给草稿(id 重启后会撞)', () => {
    const store = parseDrafts(JSON.stringify({ 3: { cwd: '/bow', text: 'hi', at: 1 } }))
    expect(draftFor(store, 3, '/bow')?.text).toBe('hi')
    expect(draftFor(store, 3, '/exp1')).toBeNull()
    expect(draftFor(store, 4, '/bow')).toBeNull()
  })
})

describe('withDraft', () => {
  it('空文本 = 删掉;专有参数只改新表', () => {
    const start = parseDrafts(JSON.stringify({ 1: { cwd: '/a', text: 'keep', at: 1 } }))
    const kept = withDraft(start, 1, '/a', 'changed', 2)
    expect(kept['1']).toEqual({ cwd: '/a', text: 'changed', at: 2 })
    expect(start['1'].text).toBe('keep')

    const cleared = withDraft(kept, 1, '/a', '   ', 3)
    expect(cleared).toEqual({})
  })

  it('超过上限按写入时刻淘汰最旧的', () => {
    let store = {}
    for (let i = 1; i <= MAX_DRAFTS + 3; i += 1) store = withDraft(store, i, '/a', `d${i}`, i)
    expect(Object.keys(store).length).toBe(MAX_DRAFTS)
    expect(store['1']).toBeUndefined()
    expect(store['3']).toBeUndefined()
    expect(store[String(MAX_DRAFTS + 3)]).toBeDefined()
  })
})

describe('withoutDraft', () => {
  it('键不存在时原样返回(免得多造一个对象)', () => {
    const store = parseDrafts(JSON.stringify({ 1: { cwd: '/a', text: 'x', at: 1 } }))
    expect(withoutDraft(store, 2)).toBe(store)
    expect(withoutDraft(store, 1)).toEqual({})
    expect(DRAFTS_KEY).toBe('bow.remote.drafts')
  })
})
