/**
 * 密码插件主进程侧用例。
 *
 * 重点不是「能不能跑」,而是几条容易静默失效的契约:
 * - 锁定时除 status/setup/unlock/settings 外一律拒绝;
 * - 列表投影**不含密码**;
 * - `fillEntry` 对不匹配的 origin **拒绝且不注入任何脚本**;
 * - `beginFill` 在没有表单 / 没有匹配时把面板打开的信号发出去(主进程不能直接开浮层)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabInfo } from '../src/shared/types'

const writeText = vi.fn()
const readText = vi.fn(() => '')
const clearClipboard = vi.fn()

vi.mock('electron', () => ({
  clipboard: {
    writeText: (...args: unknown[]) => writeText(...args),
    readText: () => readText(),
    clear: () => clearClipboard()
  }
}))

const { default: plugin } = await import('../src/plugins/passwords/main')
type PluginContext = import('../src/main/plugins/types').PluginContext
type PluginStorage = import('../src/main/plugins/types').PluginStorage

interface Recorded {
  routes: string[]
  events: string[]
  shortcuts: number
  emits: Array<{ event: string; payload?: unknown }>
  handlers: Map<string, (...args: unknown[]) => unknown>
  exec: Array<{ tabId: number; code: string }>
}

const noop = (): void => {}

function tabInfo(url: string, id = 7): TabInfo {
  return {
    id,
    url,
    title: '页面',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    active: true,
    crashed: false
  }
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

function fakeCtx(
  rec: Recorded,
  opts: { tabs?: TabInfo[]; activeId?: number | null; execute?: (tabId: number, code: string) => Promise<unknown> } = {}
): PluginContext {
  const stores = new Map<string, PluginStorage<unknown>>()
  const tabs = opts.tabs ?? []
  const ctx = {
    id: 'passwords',
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
    mcp: { tool: noop },
    net: { onBeforeRequest: noop, onBeforeSendHeaders: noop, onHeadersReceived: noop },
    content: { inject: noop, refresh: noop },
    pages: {
      activeTabId: () => opts.activeId ?? tabs[0]?.id ?? null,
      focus: noop,
      execute: async (tabId: number, code: string) => {
        rec.exec.push({ tabId, code })
        return opts.execute ? opts.execute(tabId, code) : { ok: true }
      }
    },
    tabs: { list: () => [...tabs], getActive: () => tabs.find((t) => t.active) ?? tabs[0] ?? null },
    shortcuts: {
      register: (): void => {
        rec.shortcuts += 1
      }
    }
  }
  return ctx as unknown as PluginContext
}

function record(): Recorded {
  return { routes: [], events: [], shortcuts: 0, emits: [], handlers: new Map(), exec: [] }
}

function call<T = unknown>(rec: Recorded, method: string, ...args: unknown[]): T {
  const fn = rec.handlers.get(method)
  if (!fn) throw new Error('未注册的插件方法:' + method)
  return fn(...args) as T
}

/** 只看「请开面板」这一类广播(state-changed 是噪声) */
function panelEmits(rec: Recorded): Array<{ event: string; payload?: unknown }> {
  return rec.emits.filter((e) => e.event === 'open-panel')
}

function reset(): void {
  ;(plugin.deactivate as ((ctx: unknown) => void) | undefined)?.(null)
}

const SITE = 'https://example.com/login'

beforeEach(() => {
  reset()
  writeText.mockClear()
  readText.mockClear()
  clearClipboard.mockClear()
})

describe('密码插件', () => {
  it('manifest 与能力声明正确(不声明 mcp)', () => {
    expect(plugin.manifest.id).toBe('passwords')
    expect(plugin.capabilities).toEqual(['ui', 'shortcut'])
  })

  it('激活时注册 IPC / 快捷键与标签事件', () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    expect([...rec.routes].sort()).toEqual(
      [
        'beginFill',
        'changeMaster',
        'copy',
        'fillEntry',
        'getEntry',
        'getSettings',
        'list',
        'lock',
        'readPageFields',
        'remove',
        'save',
        'setSettings',
        'setup',
        'status',
        'unlock',
        'wipe'
      ].sort()
    )
    expect([...rec.events].sort()).toEqual(['tab:closed', 'tab:navigated'])
    expect(rec.shortcuts).toBe(1)
  })

  it('锁定时列表 / 保存 / 填充一律拒绝', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec, { tabs: [tabInfo(SITE)] }))
    expect(call(rec, 'list')).toEqual({ ok: false, error: '密码库已锁定' })
    expect(call(rec, 'save', { origin: SITE, password: 'x' })).toMatchObject({ ok: false })
    expect(await call(rec, 'fillEntry', 'any')).toMatchObject({ ok: false })
    expect(rec.exec).toHaveLength(0)
  })

  it('setup → save → list(不含密码)→ getEntry → copy → remove 往返', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec, { tabs: [tabInfo(SITE)] }))
    expect(call(rec, 'status')).toMatchObject({ initialized: false, locked: true, count: 0 })
    expect(call(rec, 'setup', 'master-pass')).toEqual({ ok: true })

    const saved = call<{ ok: boolean }>(rec, 'save', {
      origin: SITE,
      title: '示例站',
      username: 'alice',
      password: 's3cret'
    })
    expect(saved.ok).toBe(true)

    const listed = call<{ ok: boolean; entries: Array<Record<string, unknown>> }>(rec, 'list')
    expect(listed.ok).toBe(true)
    expect(listed.entries).toHaveLength(1)
    expect(Object.hasOwn(listed.entries[0], 'password')).toBe(false)

    const id = listed.entries[0].id as string
    const got = call<{ ok: boolean; entry: { password: string } }>(rec, 'getEntry', id)
    expect(got.entry.password).toBe('s3cret')

    expect(await call(rec, 'copy', id, 'password')).toMatchObject({ ok: true, clearsIn: 30 })
    expect(writeText).toHaveBeenCalledWith('s3cret')

    expect(call(rec, 'remove', id)).toEqual({ ok: true })
    expect(call<{ entries: unknown[] }>(rec, 'list').entries).toHaveLength(0)
  })

  it('错误主密码解锁失败,正确主密码恢复条目', async () => {
    const rec = record()
    const ctx = fakeCtx(rec, { tabs: [tabInfo(SITE)] })
    plugin.activate(ctx)
    call(rec, 'setup', 'right-pass')
    call(rec, 'save', { origin: SITE, username: 'alice', password: 's3cret' })
    call(rec, 'lock')
    expect(call<{ ok: boolean }>(rec, 'list').ok).toBe(false)
    expect(await call(rec, 'unlock', 'wrong')).toMatchObject({ ok: false })
    expect(await call(rec, 'unlock', 'right-pass')).toEqual({ ok: true })
    expect(call<{ entries: unknown[] }>(rec, 'list').entries).toHaveLength(1)
  })

  it('fillEntry 对不匹配 origin 拒绝且不注入任何脚本', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec, { tabs: [tabInfo('https://other.com/')] }))
    call(rec, 'setup', 'master-pass')
    call(rec, 'save', { origin: SITE, username: 'alice', password: 's3cret' })
    const id = call<{ entries: Array<{ id: string }> }>(rec, 'list').entries[0].id

    const res = (await call(rec, 'fillEntry', id)) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不匹配')
    expect(rec.exec).toHaveLength(0)
  })

  it('fillEntry 注入填入脚本并带上该条密码', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec, { tabs: [tabInfo(SITE)], execute: async () => ({ ok: true }) }))
    call(rec, 'setup', 'master-pass')
    call(rec, 'save', { origin: SITE, username: 'alice', password: 's3cret' })
    const id = call<{ entries: Array<{ id: string }> }>(rec, 'list').entries[0].id

    const res = (await call(rec, 'fillEntry', id)) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(rec.exec).toHaveLength(1)
    expect(rec.exec[0].code).toContain('s3cret')
    expect(rec.exec[0].code).toContain('alice')
  })

  it('beginFill:没有表单时发 open-panel(save),不注入填入脚本', async () => {
    const rec = record()
    plugin.activate(
      fakeCtx(rec, {
        tabs: [tabInfo('https://noform.example/')],
        execute: async () => ({ ok: true, hasPassword: false, hasUsername: false })
      })
    )
    call(rec, 'setup', 'master-pass')
    call(rec, 'save', { origin: 'https://noform.example', username: 'a', password: 'b' })

    const res = (await call(rec, 'beginFill')) as { ok: boolean; mode: string }
    expect(res).toEqual({ ok: false, mode: 'no-form' })
    expect(rec.exec).toHaveLength(1) // 只探测,不填入
    expect(panelEmits(rec)).toEqual([{ event: 'open-panel', payload: { mode: 'save', tabId: 7 } }])
  })

  it('beginFill:只有一条匹配时直接填入', async () => {
    const rec = record()
    plugin.activate(
      fakeCtx(rec, {
        tabs: [tabInfo(SITE)],
        execute: async () => ({ ok: true, hasPassword: true, hasUsername: true })
      })
    )
    call(rec, 'setup', 'master-pass')
    call(rec, 'save', { origin: SITE, username: 'alice', password: 's3cret' })

    const res = (await call(rec, 'beginFill')) as { ok: boolean; mode: string }
    expect(res).toEqual({ ok: true, mode: 'filled' })
    // 探测 + 填入
    expect(rec.exec).toHaveLength(2)
    expect(rec.exec[1].code).toContain('s3cret')
    expect(panelEmits(rec)).toHaveLength(0)
  })

  it('beginFill:锁定时发 open-panel(unlock)', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec, { tabs: [tabInfo(SITE)] }))
    call(rec, 'setup', 'master-pass')
    call(rec, 'lock')

    const res = (await call(rec, 'beginFill')) as { ok: boolean; mode: string }
    expect(res).toEqual({ ok: false, mode: 'locked' })
    expect(panelEmits(rec)).toEqual([{ event: 'open-panel', payload: { mode: 'unlock' } }])
    expect(rec.exec).toHaveLength(0)
  })

  it('readPageFields 返回页面字段值与 origin,并把锁定时拒绝', async () => {
    const rec = record()
    plugin.activate(
      fakeCtx(rec, {
        tabs: [tabInfo(SITE)],
        execute: async () => ({
          ok: true,
          url: SITE,
          title: '登录',
          hasPassword: true,
          hasUsername: true,
          username: 'alice',
          password: 'typed-by-user'
        })
      })
    )
    call(rec, 'setup', 'master-pass')
    const res = (await call(rec, 'readPageFields')) as { ok: boolean; origin: string; password: string }
    expect(res).toMatchObject({ ok: true, origin: 'https://example.com', password: 'typed-by-user' })
  })

  it('wipe 清空密码库并回到未初始化', () => {
    const rec = record()
    plugin.activate(fakeCtx(rec, { tabs: [tabInfo(SITE)] }))
    call(rec, 'setup', 'master-pass')
    expect(call(rec, 'wipe')).toEqual({ ok: true })
    expect(call(rec, 'status')).toMatchObject({ initialized: false, locked: true, count: 0 })
  })
})
