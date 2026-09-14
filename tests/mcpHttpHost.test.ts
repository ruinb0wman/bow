/**
 * MCP HTTP 服务宿主测试。
 *
 * 用真实 node:http(端口 0 由系统分配)覆盖:
 * 依赖注入前后的行为、幂等启动、并发启动串行化、端口占用失败、环境变量强制模式的归属语义。
 * 全程不需要显示器。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mcp-http-host-test-'))
  return { app: { getPath: () => dir, getVersion: () => '0.0.0' } }
})

const { McpHttpHost } = await import('../src/main/plugins/mcpHttpHost')
const { FakeKernel } = await import('./fakeKernel')
const { FakeTabs } = await import('./fakeTabs')

const hosts: Array<{ stop(): Promise<unknown> }> = []
afterEach(async () => {
  while (hosts.length) await hosts.pop()!.stop({ source: 'env' } as never)
})

function makeHost(): InstanceType<typeof McpHttpHost> {
  const host = new McpHttpHost()
  hosts.push(host)
  return host
}

function deps(): { tabs: never; kernel: never } {
  return { tabs: new FakeTabs() as never, kernel: new FakeKernel() as never }
}

describe('McpHttpHost:依赖就绪前', () => {
  it('未注入依赖时启动失败,并给出可诊断的原因', async () => {
    const host = makeHost()
    const status = await host.start({ port: 0 })
    expect(status.running).toBe(false)
    expect(status.ready).toBe(false)
    expect(status.error).toContain('内核运行时依赖尚未就绪')
  })

  it('只 attach 不启动:ready 为 true 但未监听', () => {
    const host = makeHost()
    host.attach(deps() as never)
    const status = host.status()
    expect(status.ready).toBe(true)
    expect(status.running).toBe(false)
  })
})

describe('McpHttpHost:启停', () => {
  it('注入依赖后可启动,状态里带真实端口与端点', async () => {
    const host = makeHost()
    host.attach(deps() as never)
    const status = await host.start({ port: 0 })
    expect(status.running).toBe(true)
    expect(status.port).toBeGreaterThan(0)
    expect(status.url).toBe(`http://127.0.0.1:${status.port}/mcp`)
    expect(status.error).toBeUndefined()
  })

  it('启动是幂等的:重复调用不会重复监听,端口不变', async () => {
    const host = makeHost()
    host.attach(deps() as never)
    const first = await host.start({ port: 0 })
    const second = await host.start({ port: 0 })
    expect(second.port).toBe(first.port)
    expect(second.url).toBe(first.url)
    expect(second.error).toBeUndefined()
  })

  it('并发启动被串行化,不会有第二次监听(环境变量路径与插件路径同时触发)', async () => {
    const host = makeHost()
    host.attach(deps() as never)
    const [a, b] = await Promise.all([
      host.start({ port: 0, source: 'env' }),
      host.start({ port: 0, source: 'plugin' })
    ])
    expect(a.port).toBe(b.port)
    expect(a.error).toBeUndefined()
    expect(b.error).toBeUndefined()
  })

  it('停止后端口释放,可再次启动', async () => {
    const host = makeHost()
    host.attach(deps() as never)
    const first = await host.start({ port: 0 })
    const stopped = await host.stop()
    expect(stopped.running).toBe(false)
    // 端口已释放:同一端口再起一次应当成功
    const again = await host.start({ port: first.port! })
    expect(again.running).toBe(true)
    expect(again.port).toBe(first.port)
  })

  it('端口被占用时把原因落在 status.error,不抛异常', async () => {
    const a = makeHost()
    a.attach(deps() as never)
    const taken = await a.start({ port: 0 })

    const b = makeHost()
    b.attach(deps() as never)
    const failed = await b.start({ port: taken.port! })
    expect(failed.running).toBe(false)
    expect(failed.error).toMatch(/EADDRINUSE|address already in use/i)
  })
})

describe('McpHttpHost:环境变量强制模式', () => {
  it('source=env 的实例标记 forced,插件路径无权停掉它', async () => {
    const host = makeHost()
    host.attach(deps() as never)
    await host.start({ port: 0, source: 'env' })
    expect(host.status().forced).toBe(true)

    const pluginStop = await host.stop({ source: 'plugin' })
    expect(pluginStop.running).toBe(true)
    expect(pluginStop.forced).toBe(true)

    const envStop = await host.stop({ source: 'env' })
    expect(envStop.running).toBe(false)
  })

  it('插件路径启动的实例不带 forced,插件可自行停止', async () => {
    const host = makeHost()
    host.attach(deps() as never)
    await host.start({ port: 0, source: 'plugin' })
    expect(host.status().forced).toBeUndefined()
    expect((await host.stop({ source: 'plugin' })).running).toBe(false)
  })
})

describe('McpHttpHost:重启与令牌', () => {
  it('restart 换端口后在新端口监听', async () => {
    const host = makeHost()
    host.attach(deps() as never)
    const first = await host.start({ port: 0 })
    const moved = await host.restart({ port: 0 })
    expect(moved.running).toBe(true)
    expect(moved.port).toBeGreaterThan(0)
    // 旧端口已释放
    const other = makeHost()
    other.attach(deps() as never)
    expect((await other.start({ port: first.port! })).running).toBe(true)
  })

  it('status 只暴露是否启用令牌,不回显令牌本身', async () => {
    const host = makeHost()
    host.attach(deps() as never)
    const status = await host.start({ port: 0, token: 'super-secret' })
    expect(status.token).toBe(true)
    expect(JSON.stringify(status)).not.toContain('super-secret')
  })
})
