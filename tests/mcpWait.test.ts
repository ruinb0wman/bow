/**
 * 等待原语(browser_wait / waitUntil)与 MCP 返回体错误标记的单测。
 *
 * actions.ts 与 mcpResult.ts 对 electron 只有 type-only 依赖,故可在 node 环境直接导入。
 * 假 WebContents 会「真的求值」注入源码(并提供极小化的 document / getComputedStyle),
 * 因此选择器状态判定逻辑本身(visible/attached/hidden/detached)也被覆盖,而不只是外层时序。
 */

import { describe, expect, it } from 'vitest'
import { waitForLoad, waitForSelector } from '../src/main/actions'
import { errorContent, imageContent, textContent } from '../src/main/plugins/mcpResult'
import { FakeWc, asWc, sleep } from './fakeWc'

describe('waitForSelector', () => {
  it('元素已可见时立即返回', async () => {
    const wc = new FakeWc()
    wc.elements.set('#a', { visible: true })
    const res = await waitForSelector(asWc(wc), '#a')
    expect(res.ok).toBe(true)
    expect(res).toMatchObject({ selector: '#a', state: 'visible' })
    expect(wc.execCount).toBe(1)
  })

  it('元素稍后出现时轮询命中', async () => {
    const wc = new FakeWc()
    setTimeout(() => wc.elements.set('#b', { visible: true }), 150)
    const res = await waitForSelector(asWc(wc), '#b', 'attached', 3000)
    expect(res.ok).toBe(true)
    expect(wc.execCount).toBeGreaterThan(1)
  })

  it('attached 不要求可见,visible 要求可见', async () => {
    const wc = new FakeWc()
    wc.elements.set('#c', { visible: false })
    expect((await waitForSelector(asWc(wc), '#c', 'attached', 500)).ok).toBe(true)
    expect((await waitForSelector(asWc(wc), '#c', 'visible', 200)).ok).toBe(false)
    expect((await waitForSelector(asWc(wc), '#c', 'hidden', 500)).ok).toBe(true)
  })

  it('detached 对不存在的元素成立', async () => {
    const wc = new FakeWc()
    expect((await waitForSelector(asWc(wc), '#none', 'detached', 500)).ok).toBe(true)
    expect((await waitForSelector(asWc(wc), '#none', 'visible', 200)).ok).toBe(false)
  })

  it('选择器非法时立即失败,不空等到超时', async () => {
    const wc = new FakeWc()
    wc.invalid.add('>>bad>>')
    const started = Date.now()
    const res = await waitForSelector(asWc(wc), '>>bad>>', 'visible', 5000)
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('not a valid selector')
    expect(wc.execCount).toBe(1)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('超时返回明确错误', async () => {
    const wc = new FakeWc()
    const res = await waitForSelector(asWc(wc), '#never', 'visible', 250)
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('等待超时')
  })
})

describe('waitForLoad', () => {
  it('调用时已关闭的标签页立即失败', async () => {
    const wc = new FakeWc()
    wc.destroyed = true
    const res = await waitForLoad(asWc(wc), 500)
    expect(res).toEqual({ ok: false, error: '标签页已关闭' })
  })

  it('等待加载中的页面,并在 did-finish-load 时返回', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => {
      wc.loading = false
      wc.emit('did-finish-load')
    }, 60)
    const res = await waitForLoad(asWc(wc), 3000)
    expect(res.ok).toBe(true)
    expect(res.waited).toBe(true)
  })

  it('调用时页面已就绪:宽限期内返回且 waited=false', async () => {
    const wc = new FakeWc()
    const res = await waitForLoad(asWc(wc), 3000)
    expect(res.ok).toBe(true)
    expect(res.waited).toBe(false)
  })

  it('did-fail-load 主框架失败时上报错误', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', wc.url, true), 40)
    const res = await waitForLoad(asWc(wc), 3000)
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('加载失败(-2)')
  })

  it('ERR_ABORTED(-3) 被忽略,继续等待后续完成信号', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', wc.url, true), 40)
    setTimeout(() => {
      wc.loading = false
      wc.emit('did-finish-load')
    }, 120)
    const res = await waitForLoad(asWc(wc), 3000)
    expect(res.ok).toBe(true)
  })

  it('子框架失败不影响等待结果', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://iframe/', false), 40)
    setTimeout(() => {
      wc.loading = false
      wc.emit('did-finish-load')
    }, 120)
    expect((await waitForLoad(asWc(wc), 3000)).ok).toBe(true)
  })

  it('超时返回明确错误', async () => {
    const wc = new FakeWc()
    wc.loading = true
    const res = await waitForLoad(asWc(wc), 250)
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('等待加载超时')
  })

  it('加载过程中标签页被关闭时立即失败', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => {
      wc.destroyed = true
      wc.emit('destroyed')
    }, 40)
    const res = await waitForLoad(asWc(wc), 3000)
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('关闭')
  })

  it('结束后不再持有监听器(无泄漏)', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => {
      wc.loading = false
      wc.emit('did-finish-load')
    }, 40)
    await waitForLoad(asWc(wc), 3000)
    await sleep(20)
    expect(wc.listenerCount('did-finish-load')).toBe(0)
    expect(wc.listenerCount('did-fail-load')).toBe(0)
    expect(wc.listenerCount('did-start-loading')).toBe(0)
    expect(wc.listenerCount('destroyed')).toBe(0)
  })
})

describe('MCP 返回体错误标记', () => {
  it('ok=false 的返回体被标记 isError', () => {
    const res = textContent({ ok: false, error: '未找到选择器' })
    expect(res.isError).toBe(true)
    expect(JSON.parse((res.content[0] as { text: string }).text).error).toBe('未找到选择器')
  })

  it('成功返回体不带 isError', () => {
    expect(textContent({ ok: true, tabId: 1 }).isError).toBeUndefined()
  })

  it('非对象返回体不会误判', () => {
    expect(textContent('plain').isError).toBeUndefined()
    expect(textContent(null).isError).toBeUndefined()
  })

  it('errorContent 始终标记 isError', () => {
    const res = errorContent('boom')
    expect(res.isError).toBe(true)
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ ok: false, error: 'boom' })
  })

  it('imageContent 返回图片内容', () => {
    const res = imageContent('AAAA')
    expect(res.content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
  })
})
