/**
 * MCP 服务器端到端集成测试(进程内、无需显示器)。
 *
 * 通过 InMemoryTransport 与真实的 McpServer + Client 握手,用假 TabManager 驱动,覆盖:
 * instructions 下发、工具面与 schema、waitUntil 等待语义、失败一律标记 isError、
 * 内部页面标签边界、静默新建标签的回显、插件工具的错误传播。
 *
 * 这样无需图形环境也能守住「AI 能否精确调用浏览器」这条线;
 * 真实渲染行为仍由 scripts/mcp-smoke.mjs 在桌面环境验证。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import type { TabInfo } from '../src/shared/types'
import type { FakeWc } from './fakeWc'
import { FakeKernel } from './fakeKernel'
import { FakeTabs } from './fakeTabs'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-browser-test-'))
  return { app: { getPath: () => dir, getVersion: () => '0.0.0' } }
})

const { startMcpServer, MCP_INSTRUCTIONS } = await import('../src/main/mcp')
const { textContent } = await import('../src/main/plugins/mcpResult')
interface Ctx {
  client: Client
  tabs: FakeTabs
  kernel: FakeKernel
}

async function setup(): Promise<Ctx> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const tabs = new FakeTabs()
  const kernel = new FakeKernel()
  await startMcpServer({ tabs: tabs as never, kernel: kernel as never }, serverTransport)
  const client = new Client({ name: 'mcp-browser-test', version: '0.0.0' })
  await client.connect(clientTransport)
  return { client, tabs, kernel }
}

interface CallResult {
  isError: boolean
  data: any
  text: string
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const res = await client.callTool({ name, arguments: args })
  const content = (res.content ?? []) as Array<{ type: string; text?: string }>
  const text = content.find((c) => c.type === 'text')?.text ?? ''
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { isError: res.isError === true, data, text }
}

/** 建一个普通网页标签并返回它的假 WebContents */
function browsingTab(tabs: FakeTabs, url = 'https://start.example/'): FakeWc {
  const tab = tabs.create(url, true)
  return tabs.getView(tab.id)!.view.webContents
}

const activeWc = (tabs: FakeTabs): FakeWc => tabs.getActiveView()!.view.webContents

describe('MCP 服务器:握手与工具面', () => {
  it('instructions 随 initialize 下发,且含关键约定', async () => {
    const { client } = await setup()
    const instructions = client.getInstructions()
    expect(instructions).toBe(MCP_INSTRUCTIONS)
    expect(instructions).toContain('isError')
    expect(instructions).toContain('browser_wait')
    expect(instructions).toContain('bow://settings')
    expect(instructions).toContain('internal: true')
    await client.close()
  })

  it('核心工具与等待工具全部注册,waitUntil/timeoutMs 出现在 schema 中', async () => {
    const { client } = await setup()
    const tools = (await client.listTools()).tools
    const names = tools.map((t) => t.name)
    for (const core of [
      'browser_navigate',
      'browser_search',
      'browser_eval',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_scroll',
      'browser_back',
      'browser_forward',
      'browser_reload',
      'browser_stop',
      'browser_new_tab',
      'browser_close_tab',
      'browser_switch_tab',
      'browser_list_tabs',
      'browser_screenshot',
      'browser_get_info',
      'browser_wait'
    ]) {
      expect(names).toContain(core)
    }
    const propsOf = (name: string): string[] => {
      const tool = tools.find((t) => t.name === name)
      return Object.keys((tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
    }
    expect(propsOf('browser_navigate')).toEqual(expect.arrayContaining(['url', 'waitUntil', 'timeoutMs']))
    expect(propsOf('browser_click')).toEqual(expect.arrayContaining(['selector', 'waitUntil']))
    expect(propsOf('browser_wait')).toEqual(
      expect.arrayContaining(['tabId', 'selector', 'state', 'timeoutMs'])
    )
    await client.close()
  })
})

describe('MCP 服务器:导航等待语义', () => {
  it('非法 URL 返回 ok=false 并标记 isError', async () => {
    const { client } = await setup()
    const res = await call(client, 'browser_navigate', { url: 'javascript:alert(1)' })
    expect(res.isError).toBe(true)
    expect(res.data.error).toContain('http/https')
    await client.close()
  })

  it('waitUntil 缺省时真的等到 did-finish-load(waited=true)', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)
    wc.loading = true
    setTimeout(() => wc.finishLoad('https://target.example/'), 60)

    const res = await call(client, 'browser_navigate', { url: 'https://target.example/' })
    expect(res.isError).toBe(false)
    expect(res.data.waited).toBe(true)
    expect(res.data.createdTab).toBe(false)
    await client.close()
  })

  it('waitUntil:none 立即返回,不等待也不带 waited', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)
    wc.loading = true // 一直加载中:若等待必然超时
    const res = await call(client, 'browser_navigate', {
      url: 'https://fast.example/',
      waitUntil: 'none'
    })
    expect(res.isError).toBe(false)
    expect(res.data.waited).toBeUndefined()
    await client.close()
  })

  it('加载一直不结束时超时报错并标记 isError', async () => {
    const { client, tabs } = await setup()
    browsingTab(tabs).loading = true
    const res = await call(client, 'browser_navigate', {
      url: 'https://slow.example/',
      timeoutMs: 200
    })
    expect(res.isError).toBe(true)
    expect(res.data.error).toContain('等待加载超时')
    await client.close()
  })

  it('活动标签是内部页面时另开标签,并用 createdTab 回显', async () => {
    const { client, tabs } = await setup()
    tabs.create('bow://settings', true, true)
    const res = await call(client, 'browser_navigate', {
      url: 'https://fresh.example/',
      waitUntil: 'none'
    })
    expect(res.isError).toBe(false)
    expect(res.data.createdTab).toBe(true)
    expect(tabs.getView(res.data.tabId)?.info.internal).toBeUndefined()
    await client.close()
  })

  it('reload / back / forward 默认等待加载完成', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)

    // reload 会把假标签置为 loading,再手动完成
    setTimeout(() => wc.finishLoad(), 60)
    const reload = await call(client, 'browser_reload', {})
    expect(reload.isError).toBe(false)
    expect(reload.data.waited).toBe(true)

    wc.loading = true
    setTimeout(() => wc.finishLoad(), 60)
    const back = await call(client, 'browser_back', {})
    expect(back.data.waited).toBe(true)

    wc.loading = true
    setTimeout(() => wc.finishLoad(), 60)
    const forward = await call(client, 'browser_forward', {})
    expect(forward.data.waited).toBe(true)

    const stop = await call(client, 'browser_stop', {})
    expect(stop.isError).toBe(false)
    await client.close()
  })

  it('new_tab 带 url 时等到就绪,不报超时', async () => {
    const { client, tabs } = await setup()
    const res = await call(client, 'browser_new_tab', { url: 'https://t.example/' })
    expect(res.isError).toBe(false)
    expect(res.data.waited).toBe(false) // 假页面从一开始就处于就绪状态
    expect(tabs.getView(res.data.tabId)?.info.url).toBe('https://t.example/')
    await client.close()
  })

  it('new_tab 拒绝非 http(s) 地址', async () => {
    const { client } = await setup()
    const res = await call(client, 'browser_new_tab', { url: 'file:///etc/passwd' })
    expect(res.isError).toBe(true)
    await client.close()
  })
})

describe('MCP 服务器:browser_wait', () => {
  it('等元素:命中已存在元素', async () => {
    const { client, tabs } = await setup()
    browsingTab(tabs).elements.set('#ready', { visible: true })
    const res = await call(client, 'browser_wait', { selector: '#ready', timeoutMs: 1000 })
    expect(res.isError).toBe(false)
    expect(res.data).toMatchObject({ ok: true, selector: '#ready', state: 'visible', waited: true })
    await client.close()
  })

  it('等元素:超时报错并标记 isError', async () => {
    const { client, tabs } = await setup()
    browsingTab(tabs)
    const res = await call(client, 'browser_wait', { selector: '#never', timeoutMs: 250 })
    expect(res.isError).toBe(true)
    expect(res.data.error).toContain('等待超时')
    await client.close()
  })

  it('等元素:非法选择器立即失败,不空等到超时', async () => {
    const { client, tabs } = await setup()
    browsingTab(tabs).invalid.add('>>bad>>')
    const started = Date.now()
    const res = await call(client, 'browser_wait', { selector: '>>bad>>', timeoutMs: 8000 })
    expect(res.isError).toBe(true)
    expect(res.data.error).toContain('not a valid selector')
    expect(Date.now() - started).toBeLessThan(1500)
    await client.close()
  })

  it('等元素:attached 不要求可见,visible 要求可见', async () => {
    const { client, tabs } = await setup()
    browsingTab(tabs).elements.set('#hidden', { visible: false })
    const attached = await call(client, 'browser_wait', {
      selector: '#hidden',
      state: 'attached',
      timeoutMs: 1000
    })
    expect(attached.isError).toBe(false)
    const visible = await call(client, 'browser_wait', {
      selector: '#hidden',
      state: 'visible',
      timeoutMs: 250
    })
    expect(visible.isError).toBe(true)
    await client.close()
  })

  it('省略 selector 时等待页面加载完成', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)
    wc.loading = true
    setTimeout(() => wc.finishLoad(), 60)
    const res = await call(client, 'browser_wait', { timeoutMs: 3000 })
    expect(res.isError).toBe(false)
    expect(res.data.waited).toBe(true)
    await client.close()
  })
})

describe('MCP 服务器:页面操作', () => {
  it('click 找不到选择器时报错(不再伪装成成功)', async () => {
    const { client, tabs } = await setup()
    browsingTab(tabs)
    const res = await call(client, 'browser_click', { selector: '#nope' })
    expect(res.isError).toBe(true)
    expect(res.data.ok).toBe(false)
    expect(res.data.error).toContain('未找到选择器')
    await client.close()
  })

  it('click 成功后可等待点击引发的跳转', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)
    wc.elements.set('#go', { tag: 'a', visible: true })
    wc.loading = true
    setTimeout(() => wc.finishLoad('https://next.example/'), 60)
    const res = await call(client, 'browser_click', { selector: '#go', waitUntil: 'load' })
    expect(res.isError).toBe(false)
    expect(res.data.waited).toBe(true)
    await client.close()
  })

  it('click 默认不等待', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)
    wc.elements.set('#go', { tag: 'a', visible: true })
    wc.loading = true // 若等待就会超时
    const res = await call(client, 'browser_click', { selector: '#go' })
    expect(res.isError).toBe(false)
    expect(res.data.waited).toBeUndefined()
    await client.close()
  })

  it('type 成功写回输入值', async () => {
    const { client, tabs } = await setup()
    browsingTab(tabs).elements.set('#q', { tag: 'input', visible: true })
    const res = await call(client, 'browser_type', { selector: '#q', text: 'hello' })
    expect(res.isError).toBe(false)
    expect(res.data.value).toBe('hello')
    await client.close()
  })

  it('type 目标不可输入时报错', async () => {
    const { client, tabs } = await setup()
    browsingTab(tabs).elements.set('#btn', { tag: 'button', visible: true })
    const res = await call(client, 'browser_type', { selector: '#btn', text: 'x' })
    expect(res.isError).toBe(true)
    expect(res.data.error).toContain('不是可输入元素')
    await client.close()
  })

  it('scroll 成功返回位置,选择器不存在时报错', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)
    wc.elements.set('#s', { tag: 'div', visible: true })
    const ok = await call(client, 'browser_scroll', { selector: '#s', direction: 'top' })
    expect(ok.isError).toBe(false)
    expect(ok.data.top).toBe(0)
    const bad = await call(client, 'browser_scroll', { selector: '#missing', direction: 'down' })
    expect(bad.isError).toBe(true)
    expect(bad.data.error).toContain('未找到选择器')
    await client.close()
  })

  it('press_key 发送原生按键事件', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)
    const res = await call(client, 'browser_press_key', { key: 'Enter' })
    expect(res.isError).toBe(false)
    expect(res.data.pressed).toBe('Enter')
    expect(wc.sentEvents).toHaveLength(3)
    await client.close()
  })

  it('press_key F5 会等到重新加载完成', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)
    setTimeout(() => wc.finishLoad(), 60)
    const res = await call(client, 'browser_press_key', { key: 'F5' })
    expect(res.isError).toBe(false)
    expect(res.data.waited).toBe(true)
    await client.close()
  })

  it('press_key 不支持的按键报错', async () => {
    const { client, tabs } = await setup()
    browsingTab(tabs)
    const res = await call(client, 'browser_press_key', { key: '+' })
    expect(res.isError).toBe(true)
    expect(res.data.error).toContain('不支持的按键')
    await client.close()
  })

  it('press_key Ctrl+W 直接关闭标签页', async () => {
    const { client, tabs } = await setup()
    const tab = tabs.create('https://close.example/', true)
    const res = await call(client, 'browser_press_key', { key: 'Ctrl+W' })
    expect(res.isError).toBe(false)
    expect(res.data.closed).toBe(true)
    expect(tabs.getView(tab.id)).toBeNull()
    await client.close()
  })

  it('snapshot 返回页面标题/URL 与元素列表', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs, 'https://snap.example/')
    wc.elements.set('#a', { tag: 'a', visible: true, text: '链接' })
    wc.elements.set('#b', { tag: 'input', visible: false })
    const res = await call(client, 'browser_snapshot', { maxElements: 10 })
    expect(res.isError).toBe(false)
    expect(res.data.data.url).toBe('https://snap.example/')
    expect(res.data.data.title).toBe('Fake Page')
    expect(res.data.data.elements).toHaveLength(2)
    expect(res.data.data.elements.map((e: { tag: string }) => e.tag)).toEqual(['a', 'input'])
    await client.close()
  })

  it('eval 成功返回结果,脚本抛错时报错', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)
    wc.raw.set('1 + 1', 2)
    const ok = await call(client, 'browser_eval', { code: '1 + 1' })
    expect(ok.isError).toBe(false)
    expect(ok.data.result).toBe(2)

    wc.throwOn.add('boom')
    const bad = await call(client, 'browser_eval', { code: 'boom' })
    expect(bad.isError).toBe(true)
    expect(bad.data.error).toContain('boom')
    await client.close()
  })

  it('eval 返回 undefined 时归一为 null', async () => {
    const { client, tabs } = await setup()
    const wc = browsingTab(tabs)
    wc.raw.set('void 0', undefined)
    const res = await call(client, 'browser_eval', { code: 'void 0' })
    expect(res.isError).toBe(false)
    expect(res.data.result).toBeNull()
    await client.close()
  })
})

describe('MCP 服务器:目标标签边界', () => {
  it('页面工具拒绝内部页面标签', async () => {
    const { client, tabs } = await setup()
    const internal = tabs.create('bow://settings', true, true)
    const res = await call(client, 'browser_snapshot', { tabId: internal.id })
    expect(res.isError).toBe(true)
    expect(res.data.error).toContain('内部页面')
    await client.close()
  })

  it('不存在的标签报错', async () => {
    const { client } = await setup()
    const res = await call(client, 'browser_get_info', { tabId: 9999 })
    expect(res.isError).toBe(true)
    expect(res.data.error).toContain('不存在')
    await client.close()
  })

  it('只有内部页面标签时自动新建 about:blank 作为操作目标', async () => {
    const { client, tabs } = await setup()
    tabs.create('bow://settings', true, true)
    const res = await call(client, 'browser_get_info')
    expect(res.isError).toBe(false)
    expect(res.data.info.internal).toBeUndefined()
    expect(res.data.info.url).toBe('about:blank')
    await client.close()
  })

  it('list_tabs 用 internal 标出内部页面标签', async () => {
    const { client, tabs } = await setup()
    tabs.create('https://a.example/', true)
    tabs.create('bow://settings', true, true)
    const res = await call(client, 'browser_list_tabs')
    expect(res.isError).toBe(false)
    expect(res.data.tabs.filter((t: TabInfo) => t.internal === true)).toHaveLength(1)
    await client.close()
  })

  it('switch_tab / close_tab 正常返回与报错', async () => {
    const { client, tabs } = await setup()
    const tab = tabs.create('https://switch.example/', true)
    const switched = await call(client, 'browser_switch_tab', { tabId: tab.id })
    expect(switched.isError).toBe(false)
    const closed = await call(client, 'browser_close_tab', { tabId: tab.id })
    expect(closed.isError).toBe(false)
    expect(closed.data.closed).toBe(tab.id)
    const again = await call(client, 'browser_close_tab', { tabId: tab.id })
    expect(again.isError).toBe(true)
    await client.close()
  })
})

describe('MCP 服务器:插件工具', () => {
  it('插件的失败返回体同样标记 isError', async () => {
    const { client, kernel } = await setup()
    expect(kernel.attachFns).toHaveLength(1)
    kernel.declare({
      pluginId: 'demo',
      name: 'demo_tool',
      config: { description: '演示工具' },
      handler: () => textContent({ ok: false, error: '插件侧失败' })
    })
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('demo_tool')
    const res = await call(client, 'demo_tool')
    expect(res.isError).toBe(true)
    expect(res.data.error).toBe('插件侧失败')
    await client.close()
  })

  it('插件的成功返回体不带 isError', async () => {
    const { client, kernel } = await setup()
    kernel.declare({
      pluginId: 'demo',
      name: 'demo_ok',
      config: { description: '演示工具' },
      handler: () => textContent({ ok: true, value: 42 })
    })
    const res = await call(client, 'demo_ok')
    expect(res.isError).toBe(false)
    expect(res.data.value).toBe(42)
    await client.close()
  })
})
