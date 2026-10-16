/**
 * 书签插件导入 / 导出路由。
 *
 * 落盘与文件选择由 `tests/exportFile.test.ts` / `pickJsonFile` 自己覆盖;这里只钉两件事:
 * 传了什么内容(export)、以及「选到的东西怎么进树」(import —— 整树替换、坏输入不动树)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const writeToDownloads = vi.fn((name: string) => ({ ok: true, path: '/tmp/' + name }))
let picked: { canceled: boolean; path?: string; text?: string; error?: string } = { canceled: true }

vi.mock('../src/main/plugins/exportFile', () => ({
  dateStamp: () => '2026-10-04',
  writeToDownloads: (...args: unknown[]) => writeToDownloads(...(args as [string, string]))
}))

// bookmarks/main.ts 现在经 pickJsonFile 引入 electron,所以这个模块必须被 mock
vi.mock('../src/main/plugins/pickJsonFile', () => ({
  pickJsonFile: async () => picked
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
      activate: () => false,
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
  beforeEach(() => {
    picked = { canceled: true }
  })

  it('注册 export / import 路由', () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    expect(rec.routes.has('export')).toBe(true)
    expect(rec.routes.has('import')).toBe(true)
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

describe('书签导入(整树替换)', () => {
  beforeEach(() => {
    picked = { canceled: true }
    writeToDownloads.mockClear()
  })

  function call(rec: Recorded, method: string): unknown {
    return (rec.routes.get(method) as (...args: unknown[]) => unknown)()
  }

  it('用户取消文件选择框:什么都不做', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    ;(rec.routes.get('add') as (...args: unknown[]) => unknown)({ title: '旧的', url: 'https://old.com' })
    expect(await call(rec, 'import')).toEqual({ ok: false, canceled: true })
    expect(call(rec, 'list')).toHaveLength(1)
  })

  it('坏 JSON / 根不是数组:报错且不动现有树', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    ;(rec.routes.get('add') as (...args: unknown[]) => unknown)({ title: '旧的', url: 'https://old.com' })

    picked = { canceled: false, path: '/tmp/x.json', text: '{ 不是 json' }
    expect(await call(rec, 'import')).toMatchObject({ ok: false })

    picked = { canceled: false, path: '/tmp/x.json', text: '{"a":1}' }
    expect(await call(rec, 'import')).toMatchObject({ ok: false, error: '文件内容不是书签树(根应为 JSON 数组)' })

    expect(call(rec, 'list')).toHaveLength(1)
  })

  it('读文件失败:报错且不动现有树', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    picked = { canceled: false, path: '/tmp/x.json', error: 'EACCES' }
    expect(await call(rec, 'import')).toMatchObject({ ok: false, error: '读取文件失败:EACCES' })
  })

  it('合法文件:整树替换,并报出书签 / 目录数', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    ;(rec.routes.get('add') as (...args: unknown[]) => unknown)({ title: '旧的', url: 'https://old.com' })

    picked = {
      canceled: false,
      path: '/tmp/backup.json',
      text: JSON.stringify([
        {
          id: 'f1',
          type: 'folder',
          title: '收藏夹',
          children: [{ id: 'b1', type: 'bookmark', title: 'A', url: 'https://a.com' }]
        },
        { id: 'b2', type: 'bookmark', title: '', url: 'bow://settings' }
      ])
    }
    const res = (await call(rec, 'import')) as Record<string, unknown>
    expect(res).toMatchObject({ ok: true, path: '/tmp/backup.json', bookmarks: 2, folders: 1 })

    const tree = call(rec, 'list') as Array<{ type: string }>
    expect(tree).toHaveLength(2)
    expect(tree.map((n) => n.type)).toEqual(['folder', 'bookmark'])
    // 空标题的书签用 url 兜底(与 addBookmark 同一规则)
    expect(tree[1]).toMatchObject({ title: 'bow://settings', url: 'bow://settings' })
  })

  it('非法 url 被跳过、重复 id 重发、深层嵌套压成一级', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    picked = {
      canceled: false,
      path: '/tmp/backup.json',
      text: JSON.stringify([
        { id: 'x', type: 'bookmark', title: '好', url: 'https://a.com' },
        { id: 'x', type: 'bookmark', title: '重复 id', url: 'https://b.com' },
        { id: 'y', type: 'bookmark', title: '非法协议', url: 'ftp://c.com' },
        { type: 'bookmark', title: '缺 id', url: 'https://d.com' },
        { id: 'z', type: 'folder', title: '外层', children: [{ id: 'f2', type: 'folder', title: '内层', children: [{ id: 'b9', type: 'bookmark', title: '深处', url: 'https://e.com' }] }] }
      ])
    }
    const res = (await call(rec, 'import')) as Record<string, unknown>
    expect(res).toMatchObject({ ok: true, bookmarks: 4, folders: 1, dropped: 1, reissued: 2 })

    const tree = call(rec, 'list') as Array<{ id: string; type: string; children?: unknown[] }>
    // 根:3 个书签 + 1 个目录;目录的子孙已上移,只剩书签
    expect(tree).toHaveLength(4)
    const folder = tree.find((n) => n.type === 'folder')
    expect(folder?.children).toHaveLength(1)
    expect(new Set(tree.map((n) => n.id)).size).toBe(4)
  })
})
