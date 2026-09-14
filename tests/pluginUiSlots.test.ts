import { describe, expect, it } from 'vitest'
import { collectSlot } from '../src/renderer/src/plugins/slots'
import type { SlotContribution } from '../src/renderer/src/plugins/slots'

/** 假组件:纯函数只做摊平,不关心真实的 Vue 组件形状 */
const A = { name: 'A' }
const B = { name: 'B' }
const C = { name: 'C' }

function src(
  id: string,
  slots: Record<string, { name: string }[]> | undefined
): SlotContribution {
  return { id, slots: slots as SlotContribution['slots'] }
}

function names(list: unknown[]): string[] {
  return list.map((c) => (c as { name: string }).name)
}

const registry: SlotContribution[] = [
  src('bookmarks', { 'addressbar-trailing': [A], toolbar: [A] }),
  src('adblock', { toolbar: [B] }),
  src('element-fullscreen', { toolbar: [C] })
]

describe('插件插槽合并', () => {
  it('未指定顺序时按注册顺序摊平', () => {
    expect(names(collectSlot(registry, 'toolbar', () => true))).toEqual(['A', 'B', 'C'])
  })

  it('preferredOrder 决定插件次序,未列出的排在最后', () => {
    const list = collectSlot(registry, 'toolbar', () => true, ['element-fullscreen', 'bookmarks'])
    expect(names(list)).toEqual(['C', 'A', 'B'])
  })

  it('停用的插件不贡献任何组件,且不打乱其余顺序', () => {
    const list = collectSlot(registry, 'toolbar', (id) => id !== 'adblock', [
      'element-fullscreen',
      'bookmarks'
    ])
    expect(names(list)).toEqual(['C', 'A'])
  })

  it('只取指定插槽:addressbar-trailing 不拿 toolbar 的按钮', () => {
    expect(names(collectSlot(registry, 'addressbar-trailing', () => true))).toEqual(['A'])
  })

  it('一个插件贡献多个组件时保持组件内顺序', () => {
    expect(
      names(collectSlot([src('mcp-http', { toolbar: [A, B] })], 'toolbar', () => true))
    ).toEqual(['A', 'B'])
  })

  it('无插槽贡献的插件被安全跳过', () => {
    expect(names(collectSlot([src('history', undefined)], 'toolbar', () => true))).toEqual([])
  })
})
