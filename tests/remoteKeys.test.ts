/**
 * 远程页按键条的纯逻辑:粘滞 Ctrl / Alt 对下一个字符的改写。
 *
 * 这是手机端能不能真正操作 shell 的关键(软键盘发不出 Ctrl+C)。只处理**单个字符** ——
 * 一次粘贴一大段被整体改写会毁掉内容。
 */

import { describe, expect, it } from 'vitest'
import { QUICK_KEYS, applyModifiers } from '../src/renderer/remote/keys'

describe('applyModifiers', () => {
  it('没有修饰时原样返回', () => {
    expect(applyModifiers('a', { ctrl: false, alt: false })).toBe('a')
    expect(applyModifiers('\r', { ctrl: false, alt: false })).toBe('\r')
  })

  it('Ctrl + 字母 → 控制码(c/C 都给 0x03)', () => {
    expect(applyModifiers('c', { ctrl: true, alt: false })).toBe('\x03')
    expect(applyModifiers('C', { ctrl: true, alt: false })).toBe('\x03')
    expect(applyModifiers('d', { ctrl: true, alt: false })).toBe('\x04')
    expect(applyModifiers('z', { ctrl: true, alt: false })).toBe('\x1a')
  })

  it('Ctrl + 标点:[ \\ ] 也映射到 0x1b..0x1d', () => {
    expect(applyModifiers('[', { ctrl: true, alt: false })).toBe('\x1b')
    expect(applyModifiers('\\', { ctrl: true, alt: false })).toBe('\x1c')
    expect(applyModifiers(']', { ctrl: true, alt: false })).toBe('\x1d')
  })

  it('Alt → ESC 前缀;Ctrl+Alt 两个都生效', () => {
    expect(applyModifiers('b', { ctrl: false, alt: true })).toBe('\x1bb')
    expect(applyModifiers('b', { ctrl: true, alt: true })).toBe('\x1b\x02')
  })

  it('多字符(粘贴)不被改写 —— 否则一次粘贴会被整体变成控制码', () => {
    expect(applyModifiers('echo hi\r', { ctrl: true, alt: true })).toBe('echo hi\r')
    expect(applyModifiers('', { ctrl: true, alt: false })).toBe('')
  })

  it('非 ASCII 字符不被 Ctrl 改写(只加 Alt 前缀)', () => {
    expect(applyModifiers('中', { ctrl: true, alt: false })).toBe('中')
    expect(applyModifiers('中', { ctrl: false, alt: true })).toBe('\x1b中')
  })
})

describe('QUICK_KEYS', () => {
  it('含手机上最需要的那些键,且序列正确', () => {
    const byLabel = new Map(QUICK_KEYS.map((k) => [k.label, k.data]))
    expect(byLabel.get('Esc')).toBe('\x1b')
    expect(byLabel.get('Tab')).toBe('\t')
    expect(byLabel.get('↑')).toBe('\x1b[A')
    expect(byLabel.get('→')).toBe('\x1b[C')
    expect(byLabel.get('C-c')).toBe('\x03')
    expect(byLabel.get('C-d')).toBe('\x04')
  })
})
