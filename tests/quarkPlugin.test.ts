/**
 * 夸克插件主进程侧用例。
 *
 * 重点不是「能不能跑」,而是几条容易静默失效的契约:
 * - 非夸克页面必须**明确报错**(不能拿着别的页面的 React 状态去猜);
 * - 取直链接口必须带伪装 UA 与 cookie 域罐里的登录态;
 * - 交给 aria2 的 header 里**只有**白名单命中的直链域名才会带 Cookie(会话泄露边界);
 * - 接口错误码(31001 / 23018)要变成人能看懂的话。
 */

import { describe, expect, it, vi } from 'vitest'

const FID_A = 'a'.repeat(32)
const FID_B = 'b'.repeat(32)
const CDN_URL = 'https://cdn-1.quark.cn/f/a.mkv?sig=xyz'
const ARIA2_URL = 'http://localhost:16800/jsonrpc'

const netFetch = vi.fn()

vi.mock('electron', () => ({
  net: { fetch: (...args: unknown[]) => netFetch(...args) },
  session: {
    defaultSession: {
      cookies: {
        get: async (filter: { url?: string; domain?: string }) =>
          filter.domain === 'quark.cn' ? [{ name: '__pus', value: 'LOGIN' }] : []
      }
    }
  }
}))

const { default: quarkPlugin } = await import('../src/plugins/quark/main')
type PluginContext = import('../src/main/plugins/types').PluginContext
type TabInfo = import('../src/shared/types').TabInfo

const QUARK_URL = 'https://pan.quark.cn/list#/list/all'

function tabInfo(url: string, id = 7): TabInfo {
  return { id, url, title: '夸克网盘', loading: false, canGoBack: false, canGoForward: false, active: true, crashed: false }
}

const SNAPSHOT = {
  ok: true,
  url: QUARK_URL,
  folderName: '我的资源',
  files: [
    { fid: FID_A, name: 'a.mkv', size: 1024, isFile: true },
    { fid: FID_B, name: 'dir', size: 0, isFile: false }
  ],
  selected: [FID_A],
  diagnostics: { selector: '.file-list', classList: 'file-list', fiberKeyPrefix: '__reactFiber$', listLength: 2, propKeys: ['list'], stage: 'done' }
}

interface Recorded {
  ipc: Map<string, (...args: never[]) => unknown>
  executed: Array<{ tabId: number; code: string }>
  logLines: string[]
}

interface Setup {
  rec: Recorded
  ctx: PluginContext
}

function setup(opts: { tab?: TabInfo | null; executeResult?: unknown; executeThrows?: boolean } = {}): Setup {
  const rec: Recorded = { ipc: new Map(), executed: [], logLines: [] }
  const tab = opts.tab === undefined ? tabInfo(QUARK_URL) : opts.tab
  const stores = new Map<string, unknown>()

  const noop = (): void => {}
  const ctx = {
    id: 'quark',
    log: (...a: unknown[]) => rec.logLines.push(a.map(String).join(' ')),
    logError: noop,
    storage: <T>(o: { file: string; defaults: T }) => {
      if (!stores.has(o.file)) stores.set(o.file, o.defaults)
      return {
        get: () => stores.get(o.file) as T,
        set: (patch: Partial<T>) => {
          stores.set(o.file, { ...(stores.get(o.file) as object), ...patch } as T)
          return stores.get(o.file) as T
        },
        setRaw: (v: T) => {
          stores.set(o.file, v)
          return v
        }
      }
    },
    ipc: {
      handle: (method: string, fn: (...args: never[]) => unknown) => rec.ipc.set(method, fn),
      emit: noop
    },
    events: { on: noop, emit: noop },
    suggest: { register: noop },
    mcp: { tool: noop },
    net: {
      onBeforeRequest: noop,
      onBeforeSendHeaders: () => {
        throw new Error('夸克插件不应注册网络钩子')
      },
      onHeadersReceived: noop
    },
    content: { inject: noop, refresh: noop },
    pages: {
      activeTabId: () => (tab ? tab.id : null),
      focus: noop,
      execute: async (tabId: number, code: string) => {
        rec.executed.push({ tabId, code })
        if (opts.executeThrows) throw new Error('标签页已关闭')
        return opts.executeResult === undefined ? SNAPSHOT : opts.executeResult
      }
    },
    tabs: { list: () => (tab ? [tab] : []), getActive: () => tab },
    service: {} as never,
    shortcuts: { register: noop }
  }
  quarkPlugin.activate(ctx as unknown as PluginContext)
  return { rec, ctx: ctx as unknown as PluginContext }
}

function okResponse(body: unknown): { status: number; text: () => Promise<string> } {
  return { status: 200, text: async () => JSON.stringify(body) }
}

function okDownloadBody(fid: string, name: string, url: string): unknown {
  return { code: 0, data: [{ fid, file_name: name, size: 1024, download_url: url }] }
}

/** 假夸克接口 + 假 aria2 RPC;返回 aria2 收到的请求体 */
function stubQuarkThenAria2(apiBody: unknown, rpcBody: unknown = { result: 'gid-1' }): void {
  netFetch.mockReset()
  netFetch.mockResolvedValueOnce(okResponse(apiBody))
  netFetch.mockResolvedValueOnce(okResponse(rpcBody))
}

const invoke = (s: Setup, method: string, ...args: unknown[]): Promise<never> =>
  Promise.resolve(s.rec.ipc.get(method)?.apply(null, args as never[])) as Promise<never>

describe('夸克插件:注册面', () => {
  it('manifest 与能力声明(只有界面,不注册 MCP / 网络钩子)', () => {
    expect(quarkPlugin.manifest.id).toBe('quark')
    expect(quarkPlugin.manifest.name).toBe('夸克网盘')
    expect(quarkPlugin.capabilities).toEqual(['ui'])
  })

  it('IPC 方法齐全(面板与设置页依赖这些名字)', () => {
    const { rec } = setup()
    for (const m of ['listFiles', 'pushAria2', 'getSettings', 'setSettings', 'testAria2']) {
      expect(rec.ipc.has(m), `缺少 IPC ${m}`).toBe(true)
    }
    expect([...rec.ipc.keys()].sort()).toEqual(['getSettings', 'listFiles', 'pushAria2', 'setSettings', 'testAria2'])
  })

  it('activate 时不注册任何网络钩子(取直链是主动 fetch,不需要拦截)', () => {
    expect(() => setup()).not.toThrow()
  })
})

describe('夸克插件:读页面', () => {
  it('非夸克页面明确报错,并且不去执行页面脚本', async () => {
    const s = setup({ tab: tabInfo('https://example.com/') })
    const res = (await invoke(s, 'listFiles')) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不是夸克个人网盘页')
    expect(s.rec.executed).toHaveLength(0)
  })

  it('分享页也不算(本次范围外)', async () => {
    const s = setup({ tab: tabInfo('https://pan.quark.cn/s/abc123') })
    const res = (await invoke(s, 'listFiles')) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('不是夸克个人网盘页')
  })

  it('没有活动标签时报错', async () => {
    const s = setup({ tab: null })
    const res = (await invoke(s, 'listFiles')) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('没有可用的标签页')
  })

  it('页面脚本抛错 → 可读文案', async () => {
    const s = setup({ executeThrows: true })
    const res = (await invoke(s, 'listFiles')) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('标签页已关闭')
  })

  it('成功时列出文件、标出文件夹、带诊断', async () => {
    const s = setup()
    const res = (await invoke(s, 'listFiles')) as {
      ok: boolean
      files: Array<{ fid: string; name: string; isFile: boolean; sizeText: string }>
      selected: string[]
      diagnostics: { stage: string }
    }
    expect(res.ok).toBe(true)
    expect(res.files.map((f) => f.name)).toEqual(['a.mkv', 'dir'])
    expect(res.files[0].sizeText).toBe('1.0 KB')
    expect(res.files[1].isFile).toBe(false)
    expect(res.selected).toEqual([FID_A])
    expect(res.diagnostics.stage).toBe('done')
    // 只执行了读列表的脚本(EXTRACT_JS)
    expect(s.rec.executed).toHaveLength(1)
    expect(s.rec.executed[0].code).toContain('bowQuarkWalk')
  })

  it('页面脚本返回垃圾 → 归一失败但带诊断出来', async () => {
    const s = setup({ executeResult: { ok: false, error: '没找到文件列表容器', diagnostics: { stage: 'container' } } })
    const res = (await invoke(s, 'listFiles')) as { ok: boolean; error: string; diagnostics?: { stage: string } }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('没找到文件列表容器')
    expect(res.diagnostics?.stage).toBe('container')
  })
})

describe('夸克插件:取直链', () => {
  it('POST 到官方接口,带伪装 UA 与 cookie 域罐里的登录态', async () => {
    const s = setup()
    stubQuarkThenAria2(okDownloadBody(FID_A, 'a.mkv', CDN_URL))
    const res = (await invoke(s, 'pushAria2', { fids: [FID_A] })) as { ok: boolean; results: Array<{ ok: boolean }> }
    expect(res.ok).toBe(true)

    const [url, init] = netFetch.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }]
    expect(url).toContain('drive-pc.quark.cn/1/clouddrive/file/download')
    expect(init.method).toBe('POST')
    expect(init.headers['User-Agent']).toContain('quark-cloud-drive/')
    expect(init.headers.Cookie).toContain('__pus=LOGIN')
    // 实测:net.fetch 带 Origin 必定 net::ERR_FAILED
    expect(init.headers).not.toHaveProperty('Origin')
    expect(JSON.parse(init.body)).toEqual({ fids: [FID_A] })
  })

  it('31001 → 提示先登录(不推送)', async () => {
    const s = setup()
    netFetch.mockReset()
    netFetch.mockResolvedValueOnce(okResponse({ code: 31001, message: 'require login' }))
    const res = (await invoke(s, 'pushAria2', { fids: [FID_A] })) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('登录')
    expect(netFetch).toHaveBeenCalledTimes(1) // 没有第二次(aria2)请求
  })

  it('23018 → 游客超限文案', async () => {
    const s = setup()
    netFetch.mockReset()
    netFetch.mockResolvedValueOnce(okResponse({ code: 23018, message: `guest limit [${FID_A}]` }))
    const res = (await invoke(s, 'pushAria2', { fids: [FID_A] })) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('游客')
  })

  it('网络异常 → 可读文案(不抛到渲染层)', async () => {
    const s = setup()
    netFetch.mockReset()
    netFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = (await invoke(s, 'pushAria2', { fids: [FID_A] })) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ECONNREFUSED')
  })

  it('文件夹不会被取直链,也不会被推送', async () => {
    const s = setup()
    netFetch.mockReset()
    const res = (await invoke(s, 'pushAria2', { fids: [FID_B] })) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('没有匹配到')
    expect(netFetch).not.toHaveBeenCalled()
  })
})

describe('夸克插件:推送 aria2', () => {
  /** 取出 aria2 那次请求的 options */
  function aria2Options(expectedUrl = CDN_URL): { out?: string; header?: string[]; dir?: string } {
    const [url, init] = netFetch.mock.calls[1] as [string, { method: string; body: string }]
    expect(url).toBe(ARIA2_URL)
    const body = JSON.parse(init.body) as { method: string; params: unknown[] }
    expect(body.method).toBe('aria2.addUri')
    expect(body.params[0]).toBe('token:')
    expect(body.params[1]).toEqual([expectedUrl])
    return body.params[2] as { out?: string; header?: string[] }
  }

  it('RPC body 带 out 与 header(UA + Referer),直链在白名单内才带 Cookie', async () => {
    const s = setup()
    stubQuarkThenAria2(okDownloadBody(FID_A, 'a.mkv', CDN_URL))
    const res = (await invoke(s, 'pushAria2', { fids: [FID_A] })) as {
      ok: boolean
      results: Array<{ fid: string; ok: boolean }>
      hosts: Array<{ host: string; count: number }>
    }
    expect(res.ok).toBe(true)
    expect(res.results[0]).toMatchObject({ fid: FID_A, ok: true })
    expect(res.hosts).toEqual([{ host: 'cdn-1.quark.cn', count: 1 }])

    const options = aria2Options()
    expect(options.out).toBe('a.mkv')
    expect(options.header?.some((h) => h.startsWith('User-Agent:') && h.includes('quark-cloud-drive/'))).toBe(true)
    expect(options.header).toContain('Referer:https://pan.quark.cn/')
    expect(options.header?.some((h) => h.startsWith('Cookie:') && h.includes('__pus=LOGIN'))).toBe(true)
  })

  it('直链域名不在白名单 → 绝不把 Cookie 交给 aria2(会话泄露边界)', async () => {
    const s = setup()
    stubQuarkThenAria2(okDownloadBody(FID_A, 'a.mkv', 'https://bucket.aliyuncs.com/f/a.mkv'))
    await invoke(s, 'pushAria2', { fids: [FID_A] })
    const options = aria2Options('https://bucket.aliyuncs.com/f/a.mkv')
    expect(options.header?.some((h) => h.startsWith('Cookie:'))).toBe(false)
    expect(options.header?.some((h) => h.startsWith('User-Agent:'))).toBe(true)
  })

  it('文件没拿到直链 → 单独报错,不发 aria2 请求', async () => {
    const s = setup()
    netFetch.mockReset()
    netFetch.mockResolvedValueOnce(okResponse({ code: 0, data: [{ fid: FID_A, file_name: 'a.mkv', size: 1 }] }))
    const res = (await invoke(s, 'pushAria2', { fids: [FID_A] })) as { ok: boolean; results: Array<{ error?: string }> }
    expect(res.ok).toBe(false)
    expect(res.results[0].error).toContain('没有返回这个文件的直链')
    expect(netFetch).toHaveBeenCalledTimes(1)
  })

  it('aria2 返回 error → 该条失败但整体不抛', async () => {
    const s = setup()
    stubQuarkThenAria2(okDownloadBody(FID_A, 'a.mkv', CDN_URL), { error: { message: 'Unauthorized' } })
    const res = (await invoke(s, 'pushAria2', { fids: [FID_A] })) as { ok: boolean; results: Array<{ ok: boolean; error?: string }> }
    expect(res.ok).toBe(false)
    expect(res.results[0].error).toContain('Unauthorized')
  })

  it('aria2 连不上 → 每条都带可读错误', async () => {
    const s = setup()
    netFetch.mockReset()
    netFetch.mockResolvedValueOnce(okResponse(okDownloadBody(FID_A, 'a.mkv', CDN_URL)))
    netFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = (await invoke(s, 'pushAria2', { fids: [FID_A] })) as { ok: boolean; results: Array<{ error?: string }> }
    expect(res.ok).toBe(false)
    expect(res.results[0].error).toContain('ECONNREFUSED')
  })
})

describe('夸克插件:设置与 aria2 连通性', () => {
  it('setSettings 归一后落盘,getSettings 读回', async () => {
    const s = setup()
    const saved = (await invoke(s, 'setSettings', { userAgent: '  UA/9  ', aria2: { port: '70000' } })) as {
      userAgent: string
      aria2: { port: string }
    }
    expect(saved.userAgent).toBe('UA/9')
    expect(saved.aria2.port).toBe('16800') // 越界回退默认
    const read = (await invoke(s, 'getSettings')) as { userAgent: string }
    expect(read.userAgent).toBe('UA/9')
  })

  it('testAria2 成功时返回版本号', async () => {
    const s = setup()
    netFetch.mockReset()
    netFetch.mockResolvedValueOnce(okResponse({ result: { version: '1.37.0' } }))
    const res = (await invoke(s, 'testAria2')) as { ok: boolean; version?: string }
    expect(res).toEqual({ ok: true, version: '1.37.0' })
    const [url, init] = netFetch.mock.calls[0] as [string, { body: string }]
    expect(url).toBe(ARIA2_URL)
    expect(JSON.parse(init.body)).toMatchObject({ method: 'aria2.getVersion' })
  })

  it('testAria2 失败时返回可读错误', async () => {
    const s = setup()
    netFetch.mockReset()
    netFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = (await invoke(s, 'testAria2')) as { ok: boolean; error?: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ECONNREFUSED')
  })
})
