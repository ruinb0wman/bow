/**
 * MCP over HTTP(StreamableHTTP 无状态)集成测试。
 *
 * 用真实 node:http 服务器 + 真实 SDK 客户端,在回环地址上跑完整 JSON-RPC,
 * 覆盖:握手与 instructions、工具面(核心 + 插件快照)、无状态多请求、
 * 路径/方法校验、Bearer 令牌、DNS rebinding 防护。
 *
 * 全程不需要显示器。
 */

import { request as httpRequest } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-browser-http-test-'))
  return { app: { getPath: () => dir, getVersion: () => '0.0.0' } }
})

const { startMcpHttpServer, MCP_HTTP_PATH } = await import('../src/main/mcpHttp')
const { MCP_INSTRUCTIONS } = await import('../src/main/mcp')
const { textContent } = await import('../src/main/plugins/mcpResult')
const { FakeKernel } = await import('./fakeKernel')
const { FakeTabs } = await import('./fakeTabs')

const handles: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  while (handles.length) await handles.pop()!.close()
})

async function setup(options: { token?: string } = {}) {
  const tabs = new FakeTabs()
  const kernel = new FakeKernel()
  const handle = await startMcpHttpServer({ tabs: tabs as never, kernel: kernel as never }, { port: 0, ...options })
  handles.push(handle)
  return { handle, tabs, kernel, url: new URL(handle.url) }
}

async function connect(url: URL, headers?: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: headers ? { headers } : undefined
  })
  const client = new Client({ name: 'http-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args })
  const content = (res.content ?? []) as Array<{ type: string; text?: string }>
  const text = content.find((c) => c.type === 'text')?.text ?? ''
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { isError: res.isError === true, data: data as any }
}

/** 绕过 SDK 发原始请求,用于校验 HTTP 层行为 */
function rawRequest(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = ''
      res.setEncoding('utf-8')
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('MCP over HTTP:握手与工具面', () => {
  it('监听回环地址并回报端口与端点', async () => {
    const { handle, url } = await setup()
    expect(handle.port).toBeGreaterThan(0)
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.pathname).toBe(MCP_HTTP_PATH)
  })

  it('客户端握手成功,instructions 与工具面完整', async () => {
    const { url, tabs } = await setup()
    tabs.create('https://start.example/', true)
    const client = await connect(url)
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('browser_navigate')
    expect(names).toContain('browser_wait')
    expect(names).toContain('browser_screenshot')
    await client.close()
  })

  it('无状态:每次请求都是独立实例,同一客户端可连续调用', async () => {
    const { url, tabs } = await setup()
    tabs.create('https://start.example/', true)
    const client = await connect(url)
    const a = await call(client, 'browser_list_tabs')
    const b = await call(client, 'browser_get_info')
    const c = await call(client, 'browser_wait', { selector: '#missing', timeoutMs: 200 })
    expect(a.isError).toBe(false)
    expect(b.isError).toBe(false)
    expect(c.isError).toBe(true)
    await client.close()
  })

  it('第二个客户端可以同时连同一个服务器', async () => {
    const { url, tabs } = await setup()
    tabs.create('https://start.example/', true)
    const c1 = await connect(url)
    const c2 = await connect(url)
    expect((await call(c1, 'browser_get_info')).isError).toBe(false)
    expect((await call(c2, 'browser_get_info')).isError).toBe(false)
    await c1.close()
    await c2.close()
  })

  it('失败的工具调用同样标记 isError', async () => {
    const { url, tabs } = await setup()
    tabs.create('https://start.example/', true)
    const client = await connect(url)
    const res = await call(client, 'browser_click', { selector: '#nope' })
    expect(res.isError).toBe(true)
    expect(res.data.error).toContain('未找到选择器')
    await client.close()
  })

  it('插件工具按声明快照注册,启动后新增的声明也会生效', async () => {
    const { url, kernel } = await setup()
    kernel.declare({
      pluginId: 'demo',
      name: 'demo_before',
      config: { description: '启动前声明' },
      handler: () => textContent({ ok: true, which: 'before' })
    })
    const client = await connect(url)
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('demo_before')

    // 无状态:注册表在每次请求时重读,无需重连即可看到新工具
    kernel.declare({
      pluginId: 'demo',
      name: 'demo_after',
      config: { description: '运行中声明' },
      handler: () => textContent({ ok: false, error: '运行中工具失败' })
    })
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('demo_after')
    const res = await call(client, 'demo_after')
    expect(res.isError).toBe(true)
    expect(res.data.error).toBe('运行中工具失败')
    await client.close()
  })
})

describe('MCP over HTTP:HTTP 层防护', () => {
  it('未知路径返回 404 并提示正确端点', async () => {
    const { handle } = await setup()
    const res = await rawRequest(handle.port, '/nope', 'POST')
    expect(res.status).toBe(404)
    expect(res.body).toContain(MCP_HTTP_PATH)
  })

  it('不支持的方法返回 405', async () => {
    const { handle } = await setup()
    const res = await rawRequest(handle.port, MCP_HTTP_PATH, 'PUT')
    expect(res.status).toBe(405)
  })

  it('未设置令牌时回环请求可直接通过', async () => {
    const { handle } = await setup()
    // 空 body 的 POST 会被 JSON-RPC 层拒绝,但 HTTP 层已放行(不是 401)
    const res = await rawRequest(handle.port, MCP_HTTP_PATH, 'POST', { 'content-type': 'application/json' })
    expect(res.status).not.toBe(401)
  })

  it('设置令牌后无 Authorization 返回 401,带上才放行', async () => {
    const { handle, url } = await setup({ token: 's3cret' })

    const anonymous = await rawRequest(handle.port, MCP_HTTP_PATH, 'POST', {
      'content-type': 'application/json'
    })
    expect(anonymous.status).toBe(401)
    expect(anonymous.body).toContain('Authorization')

    const wrong = await rawRequest(handle.port, MCP_HTTP_PATH, 'POST', {
      'content-type': 'application/json',
      authorization: 'Bearer nope'
    })
    expect(wrong.status).toBe(401)

    const client = await connect(url, { authorization: 'Bearer s3cret' })
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    await client.close()
  })

  it('DNS rebinding 防护:非白名单 Host 被拒', async () => {
    const { handle } = await setup()
    const res = await rawRequest(handle.port, MCP_HTTP_PATH, 'POST', {
      'content-type': 'application/json',
      host: 'evil.example.com'
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).not.toBe(401)
  })
})
