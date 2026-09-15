/**
 * 等待原语(browser_wait / waitUntil)与 MCP 返回体错误标记的单测。
 *
 * actions.ts 与 mcpResult.ts 对 electron 只有 type-only 依赖,故可在 node 环境直接导入。
 * 假 WebContents 会「真的求值」注入源码(并提供极小化的 document / getComputedStyle),
 * 因此选择器状态判定逻辑本身(visible/attached/hidden/detached)也被覆盖,而不只是外层时序。
 */

import { describe, expect, it } from 'vitest'
import { sameUrl, waitForLoad, waitForSelector } from '../src/main/actions'
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
    const res = await waitForLoad(asWc(wc), { mode: 'idle', timeoutMs: 500 })
    expect(res).toEqual({ ok: false, error: '标签页已关闭' })
  })

  it('等待加载中的页面,并在 did-finish-load 时返回', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => wc.stopLoad('https://example.org/'), 60)
    const res = await waitForLoad(asWc(wc), { mode: 'idle', timeoutMs: 3000 })
    expect(res).toEqual({ ok: true, url: 'https://example.org/', waited: true })
  })

  it('调用时页面已就绪:idle 模式立即返回且 waited=false', async () => {
    const wc = new FakeWc()
    const startedAt = Date.now()
    const res = await waitForLoad(asWc(wc), { mode: 'idle', timeoutMs: 3000 })
    expect(res).toEqual({ ok: true, url: 'https://example.com/', waited: false })
    expect(Date.now() - startedAt).toBeLessThan(200)
  })

  it('did-fail-load 主框架失败时上报错误', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', wc.url, true), 40)
    const res = await waitForLoad(asWc(wc), { mode: 'idle', timeoutMs: 3000 })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('加载失败(-2)')
  })

  it('ERR_ABORTED(-3) 被忽略,继续等待后续完成信号', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', wc.url, true), 40)
    setTimeout(() => wc.stopLoad('https://example.org/'), 120)
    const res = await waitForLoad(asWc(wc), { mode: 'idle', timeoutMs: 3000 })
    expect(res).toEqual({ ok: true, url: 'https://example.org/', waited: true })
  })

  it('子框架失败不影响等待结果', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => wc.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://iframe/', false), 40)
    setTimeout(() => wc.stopLoad('https://example.org/'), 120)
    expect((await waitForLoad(asWc(wc), { mode: 'idle', timeoutMs: 3000 })).ok).toBe(true)
  })

  it('超时返回明确错误', async () => {
    const wc = new FakeWc()
    wc.loading = true
    const res = await waitForLoad(asWc(wc), { mode: 'idle', timeoutMs: 250 })
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
    const res = await waitForLoad(asWc(wc), { mode: 'idle', timeoutMs: 3000 })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('关闭')
  })

  it('结束后不再持有监听器(无泄漏)', async () => {
    const wc = new FakeWc()
    wc.loading = true
    setTimeout(() => wc.stopLoad('https://example.org/'), 40)
    await waitForLoad(asWc(wc), { mode: 'idle', timeoutMs: 3000 })
    await sleep(20)
    for (const event of [
      'did-start-loading',
      'did-finish-load',
      'did-stop-loading',
      'did-start-navigation',
      'did-navigate',
      'did-fail-load',
      'destroyed'
    ] as const) {
      expect(wc.listenerCount(event)).toBe(0)
    }
  })
})

/**
 * 竞态回归:2026-09-15 在 HTTP 调用下偶发命中 ——
 * navigate{tabId} 之后立刻 get_info 看到的是「上一个标签的旧地址 + loading:true」,
 * 根因是等待被「上一次导航迟到的完成事件」或「300ms 宽限期」提前结算。
 * A/B/C 三条在修复前必定失败(见 commit message 里的旧实现对照)。
 */
describe('waitForLoad 竞态回归', () => {
  it('A: 上一次导航迟到的 did-finish-load 不得结算本次等待', async () => {
    const wc = new FakeWc()
    const p = waitForLoad(asWc(wc), { mode: 'navigation', expectUrl: 'https://example.org/', timeoutMs: 3000 })
    let settled = false
    void p.then(() => {
      settled = true
    })
    await sleep(30)
    wc.emit('did-finish-load') // 没有配对的 start:属于上一次导航的迟到完成事件
    await sleep(150)
    expect(settled).toBe(false) // 旧实现此刻已以 ok/waited=true 结算,且 url 是旧地址
    wc.startLoad('https://example.org/')
    await sleep(30)
    wc.stopLoad()
    await expect(p).resolves.toEqual({ ok: true, url: 'https://example.org/', waited: true })
  })

  it('B: 加载开始晚于旧的 300ms 宽限期时也必须等到真实完成', async () => {
    const wc = new FakeWc()
    const p = waitForLoad(asWc(wc), { mode: 'maybe-navigation', graceMs: 800, timeoutMs: 3000 })
    let settled = false
    void p.then(() => {
      settled = true
    })
    await sleep(420) // 旧实现:120ms 轮询越过 300ms 宽限期,此处已 waited=false 返回
    expect(settled).toBe(false)
    wc.startLoad('https://example.org/')
    await sleep(30)
    wc.stopLoad()
    await expect(p).resolves.toEqual({ ok: true, url: 'https://example.org/', waited: true })
  })

  it('C: navigation 模式在地址未到达前不得因「此刻空闲」提前返回', async () => {
    const wc = new FakeWc()
    const p = waitForLoad(asWc(wc), { mode: 'navigation', expectUrl: 'https://example.org/', timeoutMs: 3000 })
    let settled = false
    void p.then(() => {
      settled = true
    })
    await sleep(500) // 旧实现:约 360ms 就以 waited=false 返回
    expect(settled).toBe(false)
    wc.startLoad('https://example.org/')
    await sleep(30)
    wc.stopLoad()
    await expect(p).resolves.toEqual({ ok: true, url: 'https://example.org/', waited: true })
  })

  it('D: idle 模式在加载中等到停止,空闲时立即返回', async () => {
    const busy = new FakeWc()
    busy.loading = true
    setTimeout(() => busy.stopLoad('https://example.org/'), 60)
    await expect(waitForLoad(asWc(busy), { mode: 'idle', timeoutMs: 3000 })).resolves.toEqual({
      ok: true,
      url: 'https://example.org/',
      waited: true
    })

    const idle = new FakeWc()
    const startedAt = Date.now()
    await expect(waitForLoad(asWc(idle), { mode: 'idle', timeoutMs: 3000 })).resolves.toEqual({
      ok: true,
      url: 'https://example.com/',
      waited: false
    })
    expect(Date.now() - startedAt).toBeLessThan(200)
  })

  it('E: navigation 模式在已处于目标地址时立即返回 waited=false', async () => {
    const wc = new FakeWc()
    wc.url = 'https://example.org/' // 与 expectUrl 只差末尾斜杠
    const startedAt = Date.now()
    await expect(
      waitForLoad(asWc(wc), { mode: 'navigation', expectUrl: 'https://example.org', timeoutMs: 3000 })
    ).resolves.toEqual({ ok: true, url: 'https://example.org/', waited: false })
    expect(Date.now() - startedAt).toBeLessThan(200)
  })

  it('F: 子框架/同文档导航开始不算本次加载的配对信号', async () => {
    const wc = new FakeWc()
    const p = waitForLoad(asWc(wc), { mode: 'maybe-navigation', graceMs: 120, timeoutMs: 3000 })
    wc.emitStartNavigation('https://iframe.example/', false) // 子框架
    wc.emitStartNavigation('https://example.com/#h', true, true) // 同文档
    await sleep(30)
    wc.emit('did-finish-load') // 没有合格配对,不得结算
    await expect(p).resolves.toEqual({ ok: true, url: 'https://example.com/', waited: false })
  })
})

describe('sameUrl', () => {
  it('忽略 #hash 与末尾斜杠', () => {
    expect(sameUrl('https://a/x/', 'https://a/x')).toBe(true)
    expect(sameUrl('https://a/x#h', 'https://a/x')).toBe(true)
    expect(sameUrl('https://a/x', 'https://a/y')).toBe(false)
    expect(sameUrl('', '')).toBe(true)
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
