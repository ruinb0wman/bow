/**
 * 设置页分屏键的纯逻辑(`src/renderer/src/lib/splitKeys.ts`)。
 *
 * 这里钉的是两条容易静默失效的契约:
 * 1. 输入框 / 文本域 / 下拉 / contenteditable 里**不接管**(按词选择必须留住);
 * 2. 判据与主进程共用 `matchSplitHotkey()` —— 分屏忽略自动重复、resize 允许自动重复、输入法组合不接管。
 */

import { describe, expect, it } from 'vitest'
import { isEditableTarget, keyInputFromEvent, splitHotkeyFromEvent } from '../src/renderer/src/lib/splitKeys'

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    code: init.key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    ...init
  } as KeyboardEvent
}

describe('isEditableTarget', () => {
  it('输入类元素一律算可编辑', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isEditableTarget({ tagName } as unknown as EventTarget)).toBe(true)
    }
  })

  it('contenteditable 算可编辑', () => {
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
  })

  it('普通元素 / null / 非元素都不算', () => {
    expect(isEditableTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget({} as unknown as EventTarget)).toBe(false)
    // 有 tagName 但不是字符串(如 window / document):不能当元素处理
    expect(isEditableTarget({ tagName: 42 } as unknown as EventTarget)).toBe(false)
  })
})

describe('keyInputFromEvent', () => {
  it('把 KeyboardEvent 的字段一一映射过去(repeat / isComposing 换名字)', () => {
    const input = keyInputFromEvent(
      key({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, shiftKey: true, repeat: true, isComposing: true })
    )
    expect(input).toEqual({
      type: 'keyDown',
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      control: true,
      meta: false,
      shift: true,
      alt: false,
      isAutoRepeat: true,
      isComposing: true
    })
  })
})

describe('splitHotkeyFromEvent', () => {
  it('Ctrl/Cmd+Shift+方向 → 分屏(方向即新窗格位置)', () => {
    expect(splitHotkeyFromEvent(key({ key: 'ArrowRight', ctrlKey: true, shiftKey: true }))).toEqual({
      kind: 'split',
      dir: 'right'
    })
    expect(splitHotkeyFromEvent(key({ key: 'ArrowLeft', metaKey: true, shiftKey: true }))).toEqual({
      kind: 'split',
      dir: 'left'
    })
    expect(splitHotkeyFromEvent(key({ key: 'ArrowUp', ctrlKey: true, shiftKey: true }))).toEqual({
      kind: 'split',
      dir: 'up'
    })
  })

  it('Alt+Shift+方向 → 调大小', () => {
    expect(splitHotkeyFromEvent(key({ key: 'ArrowDown', altKey: true, shiftKey: true }))).toEqual({
      kind: 'resize',
      dir: 'down'
    })
  })

  it('分屏忽略自动重复(长按不会一口气开出一屏窗格),调大小允许自动重复', () => {
    expect(splitHotkeyFromEvent(key({ key: 'ArrowRight', ctrlKey: true, shiftKey: true, repeat: true }))).toBeNull()
    expect(splitHotkeyFromEvent(key({ key: 'ArrowRight', altKey: true, shiftKey: true, repeat: true }))).toEqual({
      kind: 'resize',
      dir: 'right'
    })
  })

  it('输入法组合中 / 无修饰 / 只有 Ctrl 都不接管', () => {
    expect(splitHotkeyFromEvent(key({ key: 'ArrowRight', ctrlKey: true, shiftKey: true, isComposing: true }))).toBeNull()
    expect(splitHotkeyFromEvent(key({ key: 'ArrowRight' }))).toBeNull()
    expect(splitHotkeyFromEvent(key({ key: 'ArrowRight', ctrlKey: true }))).toBeNull()
    expect(splitHotkeyFromEvent(key({ key: 'ArrowRight', shiftKey: true }))).toBeNull()
  })
})
