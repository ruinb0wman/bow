import { describe, expect, it } from 'vitest'
import { PICKER_JS, PICKER_TEARDOWN_JS } from '../src/plugins/adblock/picker'

describe('元素框选脚本', () => {
  it('PICKER_JS 语法有效', () => {
    expect(() => new Function(PICKER_JS)).not.toThrow()
  })

  it('TEARDOWN_JS 语法有效', () => {
    expect(() => new Function(PICKER_TEARDOWN_JS)).not.toThrow()
  })

  it('暴露取消句柄并使用 adoptedStyleSheets 规避 CSP', () => {
    expect(PICKER_JS).toContain('__bowAdblockPicker')
    expect(PICKER_JS).toContain('adoptedStyleSheets')
    expect(PICKER_JS).toContain('attachShadow')
    expect(PICKER_TEARDOWN_JS).toContain('__bowAdblockPicker')
  })

  it('返回 Promise 且支持 cancelled 结果', () => {
    expect(PICKER_JS).toContain('new Promise')
    expect(PICKER_JS).toContain('cancelled')
  })
})
