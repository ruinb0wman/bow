import { describe, expect, it } from 'vitest'
import { mergeToolbarOrder, moveToolbarEntry } from '../src/shared/toolbarOrder'

const defaults = ['bookmarks', 'downloads', 'mcp-http', 'terminal']
const available = ['bookmarks', 'downloads', 'mcp-http', 'terminal', 'pomo']

describe('工具栏顺序', () => {
  it('没有保存值时按默认顺序,新插件补在末尾', () => {
    expect(mergeToolbarOrder([], defaults, available)).toEqual([...defaults, 'pomo'])
  })

  it('保存值覆盖默认顺序', () => {
    expect(mergeToolbarOrder(['terminal', 'bookmarks'], defaults, available)).toEqual([
      'terminal',
      'bookmarks',
      'downloads',
      'mcp-http',
      'pomo'
    ])
  })

  it('不在可用清单里的 id 被丢弃(插件下线后不留残渣)', () => {
    expect(mergeToolbarOrder(['gone', 'downloads'], defaults, available)).toEqual([
      'downloads',
      'bookmarks',
      'mcp-http',
      'terminal',
      'pomo'
    ])
  })

  it('重复 id 只保留第一次出现的位置', () => {
    expect(mergeToolbarOrder(['pomo', 'pomo', 'downloads'], defaults, available)).toEqual([
      'pomo',
      'downloads',
      'bookmarks',
      'mcp-http',
      'terminal'
    ])
  })

  it('上移/下移相邻换位,越界原样返回', () => {
    expect(moveToolbarEntry(defaults, 'mcp-http', -1)).toEqual([
      'bookmarks',
      'mcp-http',
      'downloads',
      'terminal'
    ])
    expect(moveToolbarEntry(defaults, 'mcp-http', 1)).toEqual([
      'bookmarks',
      'downloads',
      'terminal',
      'mcp-http'
    ])
    expect(moveToolbarEntry(defaults, 'bookmarks', -1)).toEqual(defaults)
    expect(moveToolbarEntry(defaults, 'terminal', 1)).toEqual(defaults)
    expect(moveToolbarEntry(defaults, 'nope', 1)).toEqual(defaults)
  })

  it('moveToolbarEntry 不改原数组', () => {
    const src = [...defaults]
    moveToolbarEntry(src, 'downloads', -1)
    expect(src).toEqual(defaults)
  })
})
