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
const writeToDownloads = vi.fn((name: string) => ({ ok: true, path: '/tmp/' + name }))
let picked: { canceled: boolean; path?: string; text?: string; error?: string } = { canceled: true }

vi.mock('electron', () => ({
  clipboard: {
    writeText: (...args: unknown[]) => writeText(...args),
    readText: () => readText(),
    clear: () => clearClipboard()
  }
}))

// 导出落盘由 exportFile 的专门用例覆盖;这里只断言「传了什么内容」
vi.mock('../src/main/plugins/exportFile', () => ({
  dateStamp: () => '2026-10-04',
  writeToDownloads: (...args: unknown[]) => writeToDownloads(...(args as [string, string]))
}))

// 导入的「选文件 + 读文件」在主进程侧共享工具里;mock 它就不必 mock node:fs
vi.mock('../src/main/plugins/pickJsonFile', () => ({
  pickJsonFile: async () => picked
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
  writeToDownloads.mockClear()
  picked = { canceled: true }
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
        'exportBackup',
        'fillEntry',
        'getEntry',
        'getSettings',
        'importBackup',
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

  it('exportBackup:未初始化时拒绝,不写文件', () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    expect(call(rec, 'exportBackup')).toEqual({ ok: false, error: '尚未创建密码库' })
    expect(writeToDownloads).not.toHaveBeenCalled()
  })

  it('exportBackup:导出整库密文,不含明文密码', () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    call(rec, 'setup', 'master-pass')
    call(rec, 'save', { origin: SITE, username: 'alice', password: 's3cret' })

    expect(call<{ ok: boolean; path?: string }>(rec, 'exportBackup').ok).toBe(true)
    expect(writeToDownloads).toHaveBeenCalledTimes(1)
    const [name, content] = writeToDownloads.mock.calls[0] as [string, string]
    expect(name).toBe('bow-passwords-backup-2026-10-04.json')
    expect(content).not.toContain('s3cret')
    const parsed = JSON.parse(content) as {
      version: number
      kdf: unknown
      verifier: unknown
      data: { iv: string; tag: string; ct: string }
    }
    expect(parsed.version).toBe(1)
    expect(parsed.kdf).toBeTruthy()
    expect(parsed.verifier).toBeTruthy()
    expect(typeof parsed.data.ct).toBe('string')
  })

  it('exportBackup:锁定后仍可导出(导出物是密文,不需要密钥)', () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    call(rec, 'setup', 'master-pass')
    call(rec, 'save', { origin: SITE, username: 'alice', password: 's3cret' })
    call(rec, 'lock')

    expect(call<{ ok: boolean }>(rec, 'exportBackup').ok).toBe(true)
    expect(writeToDownloads).toHaveBeenCalledTimes(1)
  })
})

describe('密码库导入(整库替换)', () => {
  /** 造一份「另一个主密码」的备份(走真 createVault,形状才与真实备份一致) */
  async function makeBackup(master: string): Promise<string> {
    const { createVault } = await import('../src/plugins/passwords/vault')
    return JSON.stringify(createVault(master, []).file, null, 2)
  }

  it('未创建密码库时也能导入(换机器 / 重装后的恢复通路)', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    picked = { canceled: false, path: '/tmp/b.json', text: await makeBackup('from-backup') }

    const res = await call<{ ok: boolean; path?: string; backupPath?: string }>(rec, 'importBackup')
    expect(res).toMatchObject({ ok: true, path: '/tmp/b.json' })
    expect(res.backupPath).toBeUndefined()
    // 当前库本来就未初始化 → 不该有「导入前备份」
    expect(writeToDownloads).not.toHaveBeenCalled()
    expect(call(rec, 'status')).toMatchObject({ initialized: true, locked: true })
  })

  it('已初始化时:先把当前库导出一份,再覆盖', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    call(rec, 'setup', 'master-pass')
    call(rec, 'save', { origin: SITE, username: 'alice', password: 's3cret' })

    picked = { canceled: false, path: '/tmp/b.json', text: await makeBackup('from-backup') }
    const res = await call<{ ok: boolean; backupPath?: string }>(rec, 'importBackup')
    expect(res.ok).toBe(true)
    expect(res.backupPath).toBe('/tmp/bow-passwords-preimport-2026-10-04.json')
    expect(writeToDownloads).toHaveBeenCalledTimes(1)

    // 导入后强制锁定,旧条目不可读
    expect(call(rec, 'status')).toMatchObject({ locked: true })
    expect(call(rec, 'list')).toMatchObject({ ok: false })
    // 旧主密码不再能解锁,备份自己的主密码可以
    expect((await call<{ ok: boolean }>(rec, 'unlock', 'master-pass')).ok).toBe(false)
    expect((await call<{ ok: boolean }>(rec, 'unlock', 'from-backup')).ok).toBe(true)
  })

  it('导入前备份失败 → 中止,当前库一点不动', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    call(rec, 'setup', 'master-pass')
    call(rec, 'save', { origin: SITE, username: 'alice', password: 's3cret' })
    writeToDownloads.mockReturnValueOnce({ ok: false, error: 'EACCES' })

    picked = { canceled: false, path: '/tmp/b.json', text: await makeBackup('from-backup') }
    expect(await call(rec, 'importBackup')).toEqual({
      ok: false,
      error: '导入前备份当前密码库失败,已中止:EACCES'
    })
    // 原库照旧:还是老主密码、条目还在
    expect((await call<{ ok: boolean }>(rec, 'unlock', 'master-pass')).ok).toBe(true)
    expect(call<{ ok: boolean; entries?: unknown[] }>(rec, 'list').entries).toHaveLength(1)
  })

  it('取消文件选择框 / 坏文件:什么都不做', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    call(rec, 'setup', 'master-pass')

    picked = { canceled: true }
    expect(await call(rec, 'importBackup')).toEqual({ ok: false, canceled: true })

    picked = { canceled: false, path: '/tmp/b.json', text: '{ 不是 json' }
    expect(await call(rec, 'importBackup')).toMatchObject({ ok: false })

    // 形状不对(缺 data)/ 版本不对 / KDF 参数过大 → 一律拒绝,且不写文件
    const withData = JSON.parse(await makeBackup('m')) as Record<string, unknown>
    for (const bad of [
      { version: 1, kdf: withData.kdf, verifier: null, data: null },
      { version: 2, kdf: withData.kdf, verifier: withData.verifier, data: withData.data },
      {
        version: 1,
        kdf: { algo: 'scrypt', salt: 'x', N: 1 << 20, r: 8, p: 1, keyLen: 32 },
        verifier: { iv: 'a', tag: 'b', ct: 'c' },
        data: { iv: 'a', tag: 'b', ct: 'c' }
      },
      {
        version: 1,
        kdf: { algo: 'scrypt', salt: 'x', N: 1 << 15, r: 8, p: 1, keyLen: 32 },
        verifier: { iv: 'a', tag: '', ct: 'c' },
        data: { iv: 'a', tag: 'b', ct: 'c' }
      }
    ]) {
      picked = { canceled: false, path: '/tmp/b.json', text: JSON.stringify(bad) }
      expect(await call(rec, 'importBackup')).toMatchObject({ ok: false })
    }

    expect(writeToDownloads).not.toHaveBeenCalled()
    expect((await call<{ ok: boolean }>(rec, 'unlock', 'master-pass')).ok).toBe(true)
  })

  it('导入后库里的密文与备份逐字一致(只换文件,不改密文)', async () => {
    const rec = record()
    plugin.activate(fakeCtx(rec))
    const text = await makeBackup('from-backup')
    picked = { canceled: false, path: '/tmp/b.json', text }
    await call(rec, 'importBackup')

    // 用 exportBackup 读回「现在库里是什么」:应与导入的备份一致
    expect(call<{ ok: boolean }>(rec, 'exportBackup').ok).toBe(true)
    const [name, content] = writeToDownloads.mock.calls[0] as [string, string]
    expect(name).toBe('bow-passwords-backup-2026-10-04.json')
    expect(JSON.parse(content)).toEqual(JSON.parse(text))
    expect(call(rec, 'status')).toMatchObject({ initialized: true, locked: true, count: 0 })
  })
})
