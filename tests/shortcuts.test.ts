import { describe, expect, it } from 'vitest'
import { isDevToolsHotkey, matchHotkey, matchTabHotkey, switchIndexForDigit } from '../src/shared/shortcuts'
import type { KeyInputLike } from '../src/shared/shortcuts'

function input(patch: Partial<KeyInputLike> = {}): KeyInputLike {
  return {
    type: 'keyDown',
    key: 'i',
    code: 'KeyI',
    control: true,
    meta: false,
    shift: true,
    alt: false,
    isAutoRepeat: false,
    isComposing: false,
    ...patch
  }
}

describe('isDevToolsHotkey DevTools 快捷键识别', () => {
  it('Ctrl/Cmd+Shift+I 命中', () => {
    expect(isDevToolsHotkey(input())).toBe(true)
    expect(isDevToolsHotkey(input({ control: false, meta: true }))).toBe(true)
  })

  it('key 大小写与 code 均可识别', () => {
    expect(isDevToolsHotkey(input({ key: 'I' }))).toBe(true)
    expect(isDevToolsHotkey(input({ key: '', code: 'KeyI' }))).toBe(true)
    expect(isDevToolsHotkey(input({ key: 'i', code: '' }))).toBe(true)
  })

  it('F12 命中(无需修饰键)', () => {
    expect(isDevToolsHotkey(input({ key: 'F12', code: 'F12', control: false, shift: false }))).toBe(true)
  })

  it('缺少修饰键不命中', () => {
    expect(isDevToolsHotkey(input({ shift: false }))).toBe(false)
    expect(isDevToolsHotkey(input({ control: false }))).toBe(false)
    expect(isDevToolsHotkey(input({ control: false, meta: false }))).toBe(false)
  })

  it('带 Alt 的组合不命中', () => {
    expect(isDevToolsHotkey(input({ alt: true }))).toBe(false)
  })

  it('其它按键不命中', () => {
    expect(isDevToolsHotkey(input({ key: 'j', code: 'KeyJ' }))).toBe(false)
    expect(isDevToolsHotkey(input({ key: 'F5', code: 'F5', control: false, shift: false }))).toBe(false)
  })

  it('keyUp / 自动重复 / 输入法组合中不命中', () => {
    expect(isDevToolsHotkey(input({ type: 'keyUp' }))).toBe(false)
    expect(isDevToolsHotkey(input({ isAutoRepeat: true }))).toBe(false)
    expect(isDevToolsHotkey(input({ isComposing: true }))).toBe(false)
  })
})

describe('matchTabHotkey Tab 快捷键识别', () => {
  it('Ctrl/Cmd+T 新建', () => {
    expect(matchTabHotkey(input({ key: 't', code: 'KeyT', shift: false }))).toEqual({ action: 'new' })
    expect(matchTabHotkey(input({ key: 't', code: 'KeyT', shift: false, control: false, meta: true }))).toEqual({ action: 'new' })
  })

  it('Ctrl/Cmd+Shift+T 恢复', () => {
    expect(matchTabHotkey(input({ key: 't', code: 'KeyT' }))).toEqual({ action: 'restore' })
    expect(matchTabHotkey(input({ key: 't', code: 'KeyT', control: false, meta: true }))).toEqual({ action: 'restore' })
  })

  it('Ctrl/Cmd+W 关闭', () => {
    expect(matchTabHotkey(input({ key: 'w', code: 'KeyW', shift: false }))).toEqual({ action: 'close' })
    expect(matchTabHotkey(input({ key: 'w', code: 'KeyW', shift: false, control: false, meta: true }))).toEqual({ action: 'close' })
  })

  it('Ctrl/Cmd+, 打开设置', () => {
    expect(matchTabHotkey(input({ key: ',', code: 'Comma', shift: false }))).toEqual({ action: 'settings' })
    expect(
      matchTabHotkey(input({ key: ',', code: 'Comma', shift: false, control: false, meta: true }))
    ).toEqual({ action: 'settings' })
    // 非 QWERTY:code 为 Comma 时 key 可能是其它符号
    expect(matchTabHotkey(input({ key: '?', code: 'Comma', shift: false }))).toEqual({ action: 'settings' })
  })

  it('Ctrl+Shift+, / 带 Alt 不命中设置快捷键', () => {
    expect(matchTabHotkey(input({ key: ',', code: 'Comma' }))).toBe(null)
    expect(matchTabHotkey(input({ key: ',', code: 'Comma', shift: false, alt: true }))).toBe(null)
  })

  it('Ctrl/Cmd+1..9 切换(code 物理键行优先)', () => {
    expect(matchTabHotkey(input({ key: '1', code: 'Digit1', shift: false }))).toEqual({ action: 'switch', digit: 1 })
    expect(matchTabHotkey(input({ key: '1', code: 'Digit1', shift: false, control: false, meta: true }))).toEqual({ action: 'switch', digit: 1 })
    expect(matchTabHotkey(input({ key: '9', code: 'Digit9', shift: false }))).toEqual({ action: 'switch', digit: 9 })
  })

  it('非 QWERTY 下 code 仍为 DigitN(key 为符号)不依赖 key', () => {
    expect(matchTabHotkey(input({ key: '&', code: 'Digit1', shift: false }))).toEqual({ action: 'switch', digit: 1 })
  })

  it('key 数字回退(code 缺失时)', () => {
    expect(matchTabHotkey(input({ key: '5', code: '', shift: false }))).toEqual({ action: 'switch', digit: 5 })
  })

  it('小键盘 / Ctrl+0 / 其它数字外的键不命中', () => {
    expect(matchTabHotkey(input({ key: '1', code: 'Numpad1', shift: false }))).toBe(null)
    expect(matchTabHotkey(input({ key: '0', code: 'Digit0', shift: false }))).toBe(null)
    expect(matchTabHotkey(input({ key: 'a', code: 'KeyA', shift: false }))).toBe(null)
  })

  it('缺少修饰键 / 带 Alt / 数字带 Shift 不命中', () => {
    expect(matchTabHotkey(input({ key: 't', code: 'KeyT', shift: false, control: false, meta: false }))).toBe(null)
    expect(matchTabHotkey(input({ key: 't', code: 'KeyT', shift: false, alt: true }))).toBe(null)
    expect(matchTabHotkey(input({ key: '1', code: 'Digit1' }))).toBe(null) // Ctrl+Shift+1
  })

  it('keyUp / 自动重复 / 输入法组合中不命中', () => {
    expect(matchTabHotkey(input({ type: 'keyUp', key: 't', code: 'KeyT', shift: false }))).toBe(null)
    expect(matchTabHotkey(input({ isAutoRepeat: true, key: 't', code: 'KeyT', shift: false }))).toBe(null)
    expect(matchTabHotkey(input({ isComposing: true, key: 't', code: 'KeyT', shift: false }))).toBe(null)
  })
})

describe('matchHotkey 插件热键识别', () => {
  const spec = { key: 'f', code: 'KeyF', ctrl: true, shift: true }

  it('Ctrl/Cmd+Shift+F 命中', () => {
    expect(matchHotkey(input({ key: 'f', code: 'KeyF' }), spec)).toBe(true)
    expect(matchHotkey(input({ key: 'F', code: 'KeyF' }), spec)).toBe(true)
    expect(matchHotkey(input({ key: 'f', code: 'KeyF', control: false, meta: true }), spec)).toBe(true)
  })

  it('非 QWERTY:code 命中即可(key 为其它字符)', () => {
    expect(matchHotkey(input({ key: '\u0192', code: 'KeyF' }), spec)).toBe(true)
  })

  it('code 缺省时回退按 key 匹配', () => {
    expect(matchHotkey(input({ key: 'f', code: '' }), { key: 'f', ctrl: true, shift: true })).toBe(true)
    expect(matchHotkey(input({ key: 'g', code: '' }), { key: 'f', ctrl: true, shift: true })).toBe(false)
  })

  it('修饰键需精确一致', () => {
    expect(matchHotkey(input({ key: 'f', code: 'KeyF', shift: false }), spec)).toBe(false)
    expect(matchHotkey(input({ key: 'f', code: 'KeyF', control: false, meta: false }), spec)).toBe(false)
    expect(matchHotkey(input({ key: 'f', code: 'KeyF', alt: true }), spec)).toBe(false)
  })

  it('无 Ctrl 的规格只匹配无 Ctrl/Cmd 输入', () => {
    const plain = { key: 'f', code: 'KeyF' }
    expect(matchHotkey(input({ key: 'f', code: 'KeyF', control: false, shift: false }), plain)).toBe(true)
    expect(matchHotkey(input({ key: 'f', code: 'KeyF', control: true, shift: false }), plain)).toBe(false)
    expect(matchHotkey(input({ key: 'f', code: 'KeyF', control: false, meta: true, shift: false }), plain)).toBe(
      false
    )
  })

  it('keyUp / 自动重复 / 输入法组合中不命中', () => {
    expect(matchHotkey(input({ type: 'keyUp', key: 'f', code: 'KeyF' }), spec)).toBe(false)
    expect(matchHotkey(input({ key: 'f', code: 'KeyF', isAutoRepeat: true }), spec)).toBe(false)
    expect(matchHotkey(input({ key: 'f', code: 'KeyF', isComposing: true }), spec)).toBe(false)
  })

  it('其它按键不命中', () => {
    expect(matchHotkey(input({ key: 'g', code: 'KeyG' }), spec)).toBe(false)
    expect(matchHotkey(input({ key: 'i', code: 'KeyI' }), spec)).toBe(false)
  })
})

describe('switchIndexForDigit 数字到标签索引', () => {
  it('1..8 取第 digit 个', () => {
    expect(switchIndexForDigit(1, 3)).toBe(0)
    expect(switchIndexForDigit(2, 10)).toBe(1)
  })

  it('越界数字返回 null', () => {
    expect(switchIndexForDigit(8, 3)).toBe(null)
    expect(switchIndexForDigit(5, 3)).toBe(null)
  })

  it('9 取最后一个标签', () => {
    expect(switchIndexForDigit(9, 3)).toBe(2)
    expect(switchIndexForDigit(9, 1)).toBe(0)
  })

  it('无标签时返回 null', () => {
    expect(switchIndexForDigit(9, 0)).toBe(null)
    expect(switchIndexForDigit(1, 0)).toBe(null)
  })
})
