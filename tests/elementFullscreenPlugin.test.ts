import { describe, expect, it } from 'vitest'
import type { TabInfo } from '../src/shared/types'
import elementFullscreen from '../src/plugins/element-fullscreen/main'
import type { PluginContext } from '../src/main/plugins/types'

interface Recorded {
  routes: string[]
  events: string[]
  mcp: string[]
  shortcuts: number
  emits: Array<{ event: string; payload?: unknown }>
  handlers: Map<string, (...args: unknown[]) => unknown>
}

const noop = (): void => {}

function fakeCtx(rec: Recorded): PluginContext {
  const ctx = {
    id: 'element-fullscreen',
    log: noop,
    logError: noop,
    storage: () => {
      throw new Error('元素全屏插件不应使用存储')
    },
    ipc: {
      handle: (method: string, fn: (...args: unknown[]) => unknown): void => {
        rec.routes.push(method)
        rec.handlers.set(method, fn)
      },
      emit: (event: string, payload?: unknown): void => {
        rec.emits.push({ event, payload })
      }
    },
    events: {
      on: (name: string): void => {
        rec.events.push(name)
      },
      emit: noop
    },
    suggest: { register: noop },
    mcp: {
      tool: (name: string): void => {
        rec.mcp.push(name)
      }
    },
    net: { onBeforeRequest: noop, onBeforeSendHeaders: noop, onHeadersReceived: noop },
    content: { inject: noop, refresh: noop },
    pages: { activeTabId: () => null, focus: noop, execute: async () => ({ ok: true }) },
    tabs: { list: (): TabInfo[] => [], getActive: () => null },
    shortcuts: {
      register: (): void => {
        rec.shortcuts += 1
      }
    }
  }
  return ctx as unknown as PluginContext
}

function record(): Recorded {
  return { routes: [], events: [], mcp: [], shortcuts: 0, emits: [], handlers: new Map() }
}

describe('元素全屏插件', () => {
  it('manifest 与能力声明正确', () => {
    expect(elementFullscreen.manifest.id).toBe('element-fullscreen')
    expect(elementFullscreen.manifest.name).toBe('元素全屏')
    expect(elementFullscreen.capabilities).toEqual(['ui', 'shortcut', 'mcp'])
  })

  it('激活时注册 IPC / MCP / 快捷键与标签事件', () => {
    const rec = record()
    elementFullscreen.activate(fakeCtx(rec))

    expect([...rec.routes].sort()).toEqual(['exitFullscreen', 'getState', 'pickAndFullscreen'])
    expect([...rec.mcp].sort()).toEqual(['browser_exit_fullscreen', 'browser_fullscreen_element'])
    expect([...rec.events].sort()).toEqual(['tab:activated', 'tab:closed', 'tab:navigated'])
    expect(rec.shortcuts).toBe(1)
  })

  it('getState 在无活动标签时返回空状态', () => {
    const rec = record()
    elementFullscreen.activate(fakeCtx(rec))
    expect(rec.handlers.get('getState')?.()).toEqual({ tabId: null, fullscreen: false, picking: false })
  })
})
