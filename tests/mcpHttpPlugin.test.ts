/**
 * MCP HTTP 服务插件测试。
 *
 * 插件不接触 Electron:只做「端口/令牌持久化 + 依赖就绪后的启停决策 + 状态上报」,
 * 所以这里用手写假上下文(与 elementFullscreenPlugin.test.ts 同风格)驱动,
 * 真正的监听语义由 mcpHttpHost.test.ts 与 mcpHttp.test.ts 覆盖。
 */

import { describe, expect, it } from 'vitest'
import type { McpHttpStatus } from '../src/main/plugins/mcpHttpHost'
import mcpHttp from '../src/plugins/mcp-http/main'
import type { PluginContext } from '../src/main/plugins/types'

interface Call {
  port: number
  token?: string
}

interface Harness {
  ctx: PluginContext
  calls: { start: Call[]; restart: Call[]; stop: number }
  emits: Array<{ event: string; payload?: unknown }>
  handlers: Map<string, (...args: unknown[]) => unknown>
  readySubscribed: boolean
  fireReady: () => Promise<void>
  markReady: () => void
  failNextStart: (message: string) => void
  statusNow: () => McpHttpStatus
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function harness(): Harness {
  const calls = { start: [] as Call[], restart: [] as Call[], stop: 0 }
  const emits: Array<{ event: string; payload?: unknown }> = []
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const readyCbs: Array<() => void> = []
  let status: McpHttpStatus = { ready: false, running: false }
  let pendingError: string | null = null

  /** 内存存储:复刻 JsonStore 的默认值覆盖语义 */
  let stored: Record<string, unknown> = {}
  const defaults = { port: 8765, token: '' }
  const store = {
    get: () => ({ ...defaults, ...stored }) as { port: number; token: string },
    set: (patch: Record<string, unknown>) => {
      stored = { ...stored, ...patch }
      return store.get()
    },
    setRaw: (value: Record<string, unknown>) => {
      stored = { ...value }
      return store.get()
    }
  }

  const applied = (opts: Call): McpHttpStatus => {
    if (pendingError) {
      const error = pendingError
      pendingError = null
      return { ready: true, running: false, error }
    }
    return {
      ready: true,
      running: true,
      port: opts.port,
      url: `http://127.0.0.1:${opts.port}/mcp`,
      ...(opts.token ? { token: true } : {})
    }
  }

  const ctx = {
    id: 'mcp-http',
    log: () => {},
    logError: () => {},
    storage: () => store,
    ipc: {
      handle: (method: string, fn: (...args: unknown[]) => unknown): void => {
        handlers.set(method, fn)
      },
      emit: (event: string, payload?: unknown): void => {
        emits.push({ event, payload })
      }
    },
    events: { on: () => {}, emit: () => {} },
    suggest: { register: () => {} },
    mcp: { tool: () => {} },
    net: { onBeforeRequest: () => {}, onBeforeSendHeaders: () => {}, onHeadersReceived: () => {} },
    content: { inject: () => {}, refresh: () => {} },
    pages: { activeTabId: () => null, focus: () => {}, execute: async () => null },
    tabs: { list: () => [], getActive: () => null },
    shortcuts: { register: () => {} },
    service: {
      onMcpHttpReady: (cb: () => void): void => {
        readyCbs.push(cb)
      },
      mcpHttp: {
        status: (): McpHttpStatus => status,
        start: (opts: Call): Promise<McpHttpStatus> => {
          calls.start.push(opts)
          status = applied(opts)
          return Promise.resolve(status)
        },
        stop: (): Promise<McpHttpStatus> => {
          calls.stop += 1
          status = { ready: true, running: false }
          return Promise.resolve(status)
        },
        restart: (opts: Call): Promise<McpHttpStatus> => {
          calls.restart.push(opts)
          status = applied(opts)
          return Promise.resolve(status)
        }
      }
    }
  }

  return {
    ctx: ctx as unknown as PluginContext,
    calls,
    emits,
    handlers,
    // 必须是 getter:activate() 之前构造返回对象时 readyCbs 还是空的
    get readySubscribed(): boolean {
      return readyCbs.length > 0
    },
    fireReady: async () => {
      status = { ready: true, running: false }
      for (const cb of readyCbs) cb()
      await flush()
    },
    /** 模拟「内核依赖早已就绪」:用于重现停用后再启用的场景 */
    markReady: () => {
      status = { ready: true, running: false }
    },
    failNextStart: (message: string) => {
      pendingError = message
    },
    statusNow: () => status
  }
}

function activate(h: Harness): void {
  mcpHttp.activate(h.ctx)
}

const invoke = async (h: Harness, method: string, ...args: unknown[]): Promise<any> =>
  await h.handlers.get(method)!(...args)

describe('MCP HTTP 服务插件:声明', () => {
  it('manifest 与能力声明正确,且标记为核心(关掉会影响 AI 接入)', () => {
    expect(mcpHttp.manifest.id).toBe('mcp-http')
    expect(mcpHttp.manifest.name).toBe('MCP HTTP 服务')
    expect(mcpHttp.manifest.core).toBe(true)
    expect(mcpHttp.capabilities).toEqual(['ui', 'service'])
  })

  it('激活时注册设置面 IPC 并订阅内核就绪事件', () => {
    const h = harness()
    activate(h)
    expect([...h.handlers.keys()].sort()).toEqual(['getState', 'restart', 'setSettings'])
    expect(h.readySubscribed).toBe(true)
  })
})

describe('MCP HTTP 服务插件:默认开启', () => {
  it('内核依赖未就绪时不启动', async () => {
    const h = harness()
    activate(h)
    await flush()
    expect(h.calls.start).toHaveLength(0)
    expect(h.statusNow().running).toBe(false)
  })

  it('就绪后按默认端口 8765 自动启动(这就是「默认开启」)', async () => {
    const h = harness()
    activate(h)
    await h.fireReady()
    expect(h.calls.start).toEqual([{ port: 8765, token: undefined }])
    expect(h.statusNow().running).toBe(true)
    expect(h.statusNow().url).toBe('http://127.0.0.1:8765/mcp')
  })

  it('启动成功/失败都会向设置页广播状态', async () => {
    const h = harness()
    activate(h)
    await h.fireReady()
    expect(h.emits.map((e) => e.event)).toEqual(['changed'])
  })

  it('内核依赖早已就绪时(停用后再启用),重新激活即启动,不依赖 ready 事件', async () => {
    const h = harness()
    h.markReady()
    activate(h)
    await flush()
    expect(h.calls.start).toEqual([{ port: 8765, token: undefined }])
    expect(h.statusNow().running).toBe(true)
  })

  it('启动失败时状态里带 error,激活与就绪流程不受影响', async () => {
    const h = harness()
    activate(h)
    h.failNextStart('listen EADDRINUSE: address already in use')
    await h.fireReady()
    const state = await invoke(h, 'getState')
    expect(state.status.running).toBe(false)
    expect(state.status.error).toContain('EADDRINUSE')
  })
})

describe('MCP HTTP 服务插件:设置', () => {
  it('改端口后按新端口重启', async () => {
    const h = harness()
    activate(h)
    await h.fireReady()
    const state = await invoke(h, 'setSettings', { port: 9000 })
    expect(h.calls.restart).toEqual([{ port: 9000, token: undefined }])
    expect(state.settings.port).toBe(9000)
    expect(state.status.url).toBe('http://127.0.0.1:9000/mcp')
  })

  it('非法端口回落默认值,避免写坏存储后再也起不来', async () => {
    const h = harness()
    activate(h)
    await h.fireReady()
    const state = await invoke(h, 'setSettings', { port: Number.NaN })
    expect(state.settings.port).toBe(8765)
    const outOfRange = await invoke(h, 'setSettings', { port: 70000 })
    expect(outOfRange.settings.port).toBe(8765)
  })

  it('令牌非空时透传给服务,空串归一为「不需要令牌」', async () => {
    const h = harness()
    activate(h)
    await h.fireReady()
    await invoke(h, 'setSettings', { token: 'shh' })
    expect(h.calls.restart).toEqual([{ port: 8765, token: 'shh' }])
    await invoke(h, 'setSettings', { token: '' })
    expect(h.calls.restart[1]).toEqual({ port: 8765, token: undefined })
  })

  it('参数没变时不重启,避免打断已连接的客户端', async () => {
    const h = harness()
    activate(h)
    await h.fireReady()
    const before = h.calls.restart.length
    await invoke(h, 'setSettings', { port: 8765 })
    expect(h.calls.restart).toHaveLength(before)
  })

  it('restart 按当前存储重起,并广播状态', async () => {
    const h = harness()
    activate(h)
    await h.fireReady()
    h.emits.length = 0
    const state = await invoke(h, 'restart')
    expect(h.calls.restart).toEqual([{ port: 8765, token: undefined }])
    expect(state.status.running).toBe(true)
    expect(h.emits.map((e) => e.event)).toEqual(['changed'])
  })
})

describe('MCP HTTP 服务插件:停用', () => {
  it('停用插件即关闭端点', async () => {
    const h = harness()
    activate(h)
    await h.fireReady()
    expect(h.statusNow().running).toBe(true)
    await mcpHttp.deactivate!(h.ctx)
    expect(h.calls.stop).toBe(1)
    expect(h.statusNow().running).toBe(false)
  })
})
