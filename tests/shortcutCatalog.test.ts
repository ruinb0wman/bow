import { describe, expect, it } from 'vitest'
import { SHORTCUT_GROUPS } from '../src/shared/shortcutCatalog'
import type { ShortcutItem } from '../src/shared/shortcutCatalog'

function allItems(): Array<{ groupId: string; item: ShortcutItem }> {
  return SHORTCUT_GROUPS.flatMap((g) => g.items.map((item) => ({ groupId: g.id, item })))
}

describe('设置页快捷键清单', () => {
  it('分组齐全且顺序固定', () => {
    expect(SHORTCUT_GROUPS.map((g) => g.id)).toEqual([
      'tabs',
      'nav',
      'split',
      'view',
      'terminal',
      'window'
    ])
  })

  it('每个分组都有非空 label 与非空条目', () => {
    for (const g of SHORTCUT_GROUPS) {
      expect(g.label.length).toBeGreaterThan(0)
      expect(g.items.length).toBeGreaterThan(0)
    }
  })

  it('每条条目的按键与标签都非空', () => {
    for (const { groupId, item } of allItems()) {
      expect(item.label.length, `${groupId} / ${item.keys.join('+')}`).toBeGreaterThan(0)
      expect(item.keys.length, `${groupId} / ${item.label}`).toBeGreaterThan(0)
      for (const k of item.keys) expect(k.length, `${groupId} / ${item.label}`).toBeGreaterThan(0)
      for (const alt of item.alternatives ?? []) {
        expect(alt.length, `${groupId} / ${item.label} 的备用组合`).toBeGreaterThan(0)
      }
    }
  })

  it('同组内没有重复的「按键 + 标签」', () => {
    const seen = new Set<string>()
    for (const { groupId, item } of allItems()) {
      const key = `${groupId}|${item.keys.join('+')}|${item.label}`
      expect(seen.has(key), `重复条目:${key}`).toBe(false)
      seen.add(key)
    }
  })

  it('关键键位都在册', () => {
    const has = (keys: string[]): boolean =>
      allItems().some(({ item }) => item.keys.join('+') === keys.join('+'))
    expect(has(['Ctrl', 'T'])).toBe(true)
    expect(has(['Ctrl', 'Shift', 'T'])).toBe(true)
    expect(has(['Ctrl', 'W'])).toBe(true)
    expect(has(['Ctrl', 'F'])).toBe(true)
    expect(has(['Ctrl', 'Shift', 'E'])).toBe(true)
    expect(has(['Ctrl', 'Shift', 'I'])).toBe(true)
    expect(has(['Shift'])).toBe(true)
    expect(has(['Alt', 'F4'])).toBe(true)
  })

  it('平台受限条目单独标注(macOS 的 Ctrl+←/→)', () => {
    const back = allItems().find(({ item }) => item.keys.join('+') === 'Ctrl+← / →' && item.label.includes('后退'))
    expect(back?.item.platformNote).toContain('macOS')
  })

  it('展示文案是纯文本(设置页是直接插值,不渲染 Markdown/代码)', () => {
    // 写 note 时很容易顺手带 `**加粗**` 或 `` `code` `` —— 在设置页会原样显示出来。
    const texts: Array<[string, string | undefined]> = []
    for (const g of SHORTCUT_GROUPS) {
      texts.push([`${g.id}/label`, g.label], [`${g.id}/hint`, g.hint])
      for (const item of g.items) {
        texts.push([`${g.id}/${item.label}/label`, item.label])
        texts.push([`${g.id}/${item.label}/note`, item.note])
        texts.push([`${g.id}/${item.label}/platformNote`, item.platformNote])
        for (const k of item.keys) texts.push([`${g.id}/${item.label}/key`, k])
        for (const alt of item.alternatives ?? []) for (const k of alt) texts.push([`${g.id}/${item.label}/alt`, k])
      }
    }
    for (const [where, text] of texts) {
      expect(text ?? '', where).not.toContain('**')
      expect(text ?? '', where).not.toContain('`')
    }
  })
})
