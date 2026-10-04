/**
 * 书签插件导出路由:注册 `export`,并把整棵树 JSON 落到 bow 下载目录。
 *
 * 落盘由 `tests/exportFile.test.ts` 覆盖;这里只钉「传了什么内容」。
 */

import { describe, expect, it, vi } from 'vitest'

const writeToDownloads = vi.fn((name: string) => ({ ok: true, path: '/tmp/' + name }))

vi.mock('../src/main/plugins/exportFile', () => ({
  dateStamp: () => '2026-10-04',
  writeToDownloads: (...args: unknown[]) => writeToDownloads(...(args as [string, string]))
}))

const { default: plugin } = await import('../src/plugins/bookmarks/main')
type PluginContext = import('../src/main/plugins/types').PluginContext
type PluginStorage = import('../src/main/plugins/types').PluginStorage

interface Recorded {
  routes: Map<string, (...args: unknown[]) => unknown>
  emits: Array<{ event: string; payload?: unknown }>
}

function memStore<T>(defaults: T): PluginStorage<T> {
  let data = JSON.parse(JSON.stringify(defaults)) as T
  return {
    get: () => data,
    set: (patch: Partial<T>) => {
      data = { ...data, ...patch } as T
      return data
    },
    setRaw: (value: T) => {
      data = value
      return data
    }
  }
}

const noop = (): void => {}

function fakeCtx(rec: Recorded): PluginContext {
  const stores = new Map<string, PluginStorage<unknown>>()
  const ctx = {
    id: 'bookmarks',
    log: noop,
    logError: noop,
    storage: <T>(o: { file: string; defaults: T }): PluginStorage<T> => {
      const hit = stores.get(o.file)
      if (hit) return hit as PluginStorage<T>
      const made = memStore(o.defaults)
      stores.set(o.file, made as PluginStorage<unknown>)
      return made
    },
    ipc: {
      handle: (method: string, fn: (...args: unknown[]) => unknown): void => {
        rec.routes.set(method, fn)
      },
      emit: (event: string, payload?: unknown): void => {
        rec.emits.push({ event, payload })
      }
    },
    events: { on: noop, emit: noop },
    suggest: { register: noop },
    mcp: { tool: noop },
    net: { onBeforeRequest: noop, onBeforeSendHeaders: noop, onHeadersReceived: noop },
    content: { inject: noop, refresh: noop },
    pages: {
      activeTabId: () => null,
      focus: noop,
      execute: async () => ({}),
      openDevToolsTab: () => 0
    },
    tabs: { list: () => [], getActive: () => null },
    shortcuts: { register: noop }
  }
  return ctx as unknown as PluginContext
}

function record(): Recorded {
  return { routes: new Map(), emits: [] }
}

describe('书签导出', () => {
  it('注册 export 路由', () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    expect(rec.routes.has('export')).toBe(true)
  })

  it('export 把整棵树 JSON 写到下载目录', () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    ;(rec.routes.get('add') as (...args: unknown[]) => unknown)({
      title: '示例',
      url: 'https://example.com'
    })

    const res = (rec.routes.get('export') as (...args: unknown[]) => unknown)() as {
      ok: boolean
      path?: string
    }
    expect(res.ok).toBe(true)
    expect(writeToDownloads).toHaveBeenCalledTimes(1)

    const [name, content] = writeToDownloads.mock.calls[0] as [string, string]
    expect(name).toBe('bow-bookmarks-2026-10-04.json')
    const tree = JSON.parse(content) as Array<{ type: string; title: string; url?: string }>
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ type: 'bookmark', title: '示例', url: 'https://example.com' })
  })
})
