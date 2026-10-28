import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useFlash } from '../src/renderer/src/lib/useFlash'

describe('useFlash', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('写入后到点自动清空', () => {
    const { notice, flash } = useFlash(1000)
    flash('已保存')
    expect(notice.value).toBe('已保存')
    vi.advanceTimersByTime(999)
    expect(notice.value).toBe('已保存')
    vi.advanceTimersByTime(1)
    expect(notice.value).toBe('')
  })

  it('新提示顶掉旧的,并从调用那一刻重新计时', () => {
    const { notice, flash } = useFlash(1000)
    flash('第一条')
    vi.advanceTimersByTime(600)
    flash('第二条')
    vi.advanceTimersByTime(600)
    expect(notice.value).toBe('第二条')
    vi.advanceTimersByTime(400)
    expect(notice.value).toBe('')
  })

  it('单次调用可以覆盖显示时长', () => {
    const { notice, flash } = useFlash(1000)
    flash('久一点', 3000)
    vi.advanceTimersByTime(2000)
    expect(notice.value).toBe('久一点')
    vi.advanceTimersByTime(1000)
    expect(notice.value).toBe('')
  })

  it('作用域销毁后不再写 notice(组件卸载后 setTimeout 不该回来改状态)', () => {
    const scope = effectScope()
    const { notice, flash } = scope.run(() => useFlash(1000))!
    flash('已保存')
    scope.stop()
    vi.advanceTimersByTime(5000)
    expect(notice.value).toBe('已保存')
  })
})
