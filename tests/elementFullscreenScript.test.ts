import { describe, expect, it } from 'vitest'
import {
  PICK_JS,
  PICK_TEARDOWN_JS,
  RESTORE_JS,
  buildApplyScript
} from '../src/plugins/element-fullscreen/scripts'

describe('元素全屏注入脚本', () => {
  it('PICK_JS / PICK_TEARDOWN_JS / RESTORE_JS 语法有效', () => {
    expect(() => new Function(PICK_JS)).not.toThrow()
    expect(() => new Function(PICK_TEARDOWN_JS)).not.toThrow()
    expect(() => new Function(RESTORE_JS)).not.toThrow()
  })

  it('框选器使用 Shadow DOM + adoptedStyleSheets 规避 CSP,返回 Promise 与 cancelled', () => {
    expect(PICK_JS).toContain('__bowElementFullscreenPicker')
    expect(PICK_JS).toContain('attachShadow')
    expect(PICK_JS).toContain('adoptedStyleSheets')
    expect(PICK_JS).toContain('new Promise')
    expect(PICK_JS).toContain('cancelled')
    expect(PICK_JS).toContain('Escape')
    expect(PICK_JS).toContain('ArrowUp')
    expect(PICK_JS).toContain('ArrowDown')
    expect(PICK_TEARDOWN_JS).toContain('__bowElementFullscreenPicker')
  })

  it('框选器拒绝 html/body 并内联 isHudEvent 事件隔离', () => {
    expect(PICK_JS).toContain('document.documentElement')
    expect(PICK_JS).toContain('document.body')
    expect(PICK_JS).toContain('isHudEvent')
  })

  it('apply 脚本内联选择器且语法有效(含引号 / 反斜杠 / 组合符)', () => {
    const selectors = [
      'img.hero',
      'div[data-x="a\\"b"]',
      '#a > .b:nth-of-type(2)',
      'a[href="x\\\\y"]',
      'video#main-video'
    ]
    for (const selector of selectors) {
      const code = buildApplyScript(selector)
      expect(() => new Function(code), selector).not.toThrow()
      expect(code).toContain(JSON.stringify(selector))
    }
  })

  it('apply 脚本包含关键覆盖样式与还原标记', () => {
    const code = buildApplyScript('video#v')
    expect(code).toContain('__bowElementFullscreen')
    expect(code).toContain('position')
    expect(code).toContain('100vw')
    expect(code).toContain('100vh')
    expect(code).toContain("'important'")
    expect(code).toContain('setProperty')
    expect(code).toContain('object-fit')
    expect(code).toContain('__bow-element-fullscreen-backdrop')
    expect(code).toContain('Escape')
    expect(code).toContain('getComputedStyle')
    expect(code).toContain('restore')
  })

  it('RESTORE_JS 引用同一运行时句柄且幂等', () => {
    expect(RESTORE_JS).toContain('__bowElementFullscreen')
    expect(RESTORE_JS).toContain('restored')
  })
})
