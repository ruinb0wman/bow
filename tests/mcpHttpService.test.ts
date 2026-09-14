/**
 * MCP HTTP 服务插件 —— 内核接线集成测试。
 *
 * 这一层是真正的风险缝隙:插件 activate 早于窗口创建,服务要等内核注入运行时依赖后才能起。
 * 测试用真实 PluginKernel + 真实插件 + 真实 HTTP 服务器(端口 0 由系统分配,
 * 避免撞上开发机上已在监听的 8765),并用真实 MCP 客户端连上去调一个核心工具。
 * 全程不需要显示器。
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 当前用例的 userData:mock 在每次 app.getPath() 时读取它,所以每条用例都能拿到干净目录 */
let userDataDir = ''
vi.mock('electron', async () => {
  const { mkdtempSync: mk } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  userDataDir = mk(j(td(), 'mcp-http-service-test-'))
  return { app: { getPath: () => userDataDir, getVersion: () => '0.0.0' } }
})

const { PluginKernel } = await import('../src/main/plugins/kernel')
const { CORE_MCP_TOOL_NAMES } = await import('../src/main/mcp')
const { mcpActivity } = await import('../src/main/mcpActivity')
const mcpHttpPlugin = (await import('../src/plugins/mcp-http/main')).default
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { FakeTabs } = await import('./fakeTabs')

const kernels: Array<{ mcpHttp: { stop(o?: unknown): Promise<unknown> } }> = []
afterEach(async () => {
  while (kernels.length) await kernels.pop()!.mcpHttp.stop({ source: 'env' })
})

/** 每条用例一份干净的 userData:plugins.json 里的 disabled 状态会跨内核残留,否则会互相污染 */
function seedPluginStorage(port: number): void {
  userDataDir = mkdtempSync(join(tmpdir(), 'mcp-http-service-'))
  writeFileSync(join(userDataDir, 'mcp-http.json'), JSON.stringify({ port, token: '' }), 'utf-8')
}

async function bootKernel(port = 0): Promise<InstanceType<typeof PluginKernel>> {
  seedPluginStorage(port)
  const kernel = new PluginKernel()
  kernels.push(kernel)
  kernel.reserveMcpToolNames(CORE_MCP_TOOL_NAMES)
  kernel.registerAll([mcpHttpPlugin])
  await kernel.activateEnabled()
  return kernel
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`等待条件超时(${timeoutMs}ms)`)
}
describe('MCP HTTP 服务插件:内核接线', () => {
  it('注入依赖并通知就绪后,端点真的在监听', async () => {
    const kernel = await bootKernel()
    expect(kernel.mcpHttp.status().running).toBe(false) // 依赖未注入:还没起

    const tabs = new FakeTabs()
    kernel.attachMcpHttpDeps({ tabs: tabs as never, kernel })
    kernel.notifyMcpHttpReady()

    await waitFor(() => kernel.mcpHttp.status().running)
    const status = kernel.mcpHttp.status()
    expect(status.ready).toBe(true)
    expect(status.url).toBe(`http://127.0.0.1:${status.port}/mcp`)
    expect(status.error).toBeUndefined()
  })

  it('端点对外是一个可用的 MCP 服务(真实客户端握手 + 调核心工具)', async () => {
    const kernel = await bootKernel()
    const tabs = new FakeTabs()
    tabs.create('https://probe.example/', true)
    kernel.attachMcpHttpDeps({ tabs: tabs as never, kernel })
    kernel.notifyMcpHttpReady()
    await waitFor(() => kernel.mcpHttp.status().running)

    const client = new Client({ name: 'service-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(kernel.mcpHttp.status().url!)))
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('browser_navigate')
    expect(names).toContain('browser_list_tabs')

    const res = await client.callTool({ name: 'browser_list_tabs', arguments: {} })
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text)
    expect(parsed.ok).toBe(true)
    expect(parsed.tabs).toHaveLength(1)
    await client.close()
  })

  it('客户端保持着长连接时不会把状态灯钉在「调用中」(长驻 GET SSE 流不计入活动)', async () => {
    const kernel = await bootKernel()
    const tabs = new FakeTabs()
    tabs.create('https://probe.example/', true)
    kernel.attachMcpHttpDeps({ tabs: tabs as never, kernel })
    kernel.notifyMcpHttpReady()
    await waitFor(() => kernel.mcpHttp.status().running)

    const client = new Client({ name: 'idle-test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(kernel.mcpHttp.status().url!)))
    // 握手 + tools/list + 长驻 SSE 读流都建好了,但这些都不是「在用浏览器」
    await client.listTools()
    await new Promise((r) => setTimeout(r, 400))
    expect(mcpActivity.snapshot().inFlight).toBe(0)

    // 真正调工具时才进入「调用中」,调用结束又回到空闲
    const pending = client.callTool({
      name: 'browser_wait',
      arguments: { selector: '#never-appears', timeoutMs: 1500 }
    })
    await waitFor(() => mcpActivity.snapshot().inFlight > 0, 2000)
    expect(mcpActivity.snapshot().lastTool).toBe('browser_wait')
    await pending
    await waitFor(() => mcpActivity.snapshot().inFlight === 0, 2000)

    await client.close()
  })

  it('停用插件即关闭端点(内核回收路径生效)', async () => {
    const kernel = await bootKernel()
    const tabs = new FakeTabs()
    kernel.attachMcpHttpDeps({ tabs: tabs as never, kernel })
    kernel.notifyMcpHttpReady()
    await waitFor(() => kernel.mcpHttp.status().running)

    await kernel.setEnabled('mcp-http', false)
    expect(kernel.mcpHttp.status().running).toBe(false)
  })

  it('插件被停用时,重新激活会再次拉起端点', async () => {
    const kernel = await bootKernel()
    const tabs = new FakeTabs()
    kernel.attachMcpHttpDeps({ tabs: tabs as never, kernel })
    kernel.notifyMcpHttpReady()
    await waitFor(() => kernel.mcpHttp.status().running)

    await kernel.setEnabled('mcp-http', false)
    expect(kernel.mcpHttp.status().running).toBe(false)

    await kernel.setEnabled('mcp-http', true)
    await waitFor(() => kernel.mcpHttp.status().running)
    expect(kernel.mcpHttp.status().port).toBeGreaterThan(0)
  })
})

describe('MCP HTTP 服务插件:与强制模式的优先级', () => {
  it('环境变量先起时归 env,随后插件的启动请求是幂等的', async () => {
    const kernel = await bootKernel()
    const tabs = new FakeTabs()
    kernel.attachMcpHttpDeps({ tabs: tabs as never, kernel })

    // 模拟 index.ts:MCP_HTTP=1 先强制启动,再唤醒插件
    const forced = await kernel.mcpHttp.start({ port: 0, source: 'env' })
    expect(forced.running).toBe(true)
    kernel.notifyMcpHttpReady()
    await waitFor(() => kernel.mcpHttp.status().running)

    const status = kernel.mcpHttp.status()
    expect(status.forced).toBe(true)
    expect(status.port).toBe(forced.port) // 没有被插件起第二份
  })

  it('停用插件不会关掉环境变量强制开启的端点', async () => {
    const kernel = await bootKernel()
    const tabs = new FakeTabs()
    kernel.attachMcpHttpDeps({ tabs: tabs as never, kernel })
    await kernel.mcpHttp.start({ port: 0, source: 'env' })
    kernel.notifyMcpHttpReady()
    await waitFor(() => kernel.mcpHttp.status().running)

    await kernel.setEnabled('mcp-http', false)
    const status = kernel.mcpHttp.status()
    expect(status.running).toBe(true)
    expect(status.forced).toBe(true)
  })
})
