import { describe, expect, it } from 'vitest'
import { isDevToolsHotkey } from '../src/shared/shortcuts'
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
