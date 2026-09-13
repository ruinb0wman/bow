import { describe, expect, it } from 'vitest'
import { isTopmost } from '../src/renderer/src/lib/modalStack'

describe('弹层栈:Esc 只作用于栈顶', () => {
  const outer = Symbol('outer')
  const inner = Symbol('inner')

  it('空栈无人响应', () => {
    expect(isTopmost([], outer)).toBe(false)
  })

  it('嵌套时只有内层(栈顶)响应', () => {
    expect(isTopmost([outer, inner], inner)).toBe(true)
    expect(isTopmost([outer, inner], outer)).toBe(false)
  })

  it('内层关闭后外层恢复响应', () => {
    const stack = [outer, inner]
    stack.pop()
    expect(isTopmost(stack, outer)).toBe(true)
    expect(isTopmost(stack, inner)).toBe(false)
  })
})
