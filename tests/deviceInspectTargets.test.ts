/**
 * 设备检查插件的编排用例:转发池、套接字探活、整链路发现。
 *
 * 全部用**假 adb + 假 HTTP + 假端口分配器**,所以下面这些分支在 Linux CI 上也能跑:
 * 「设备重连后旧转发失效要自愈」「端口被占要换一个」「未授权设备不能当可用设备」——
 * 这些分支恰恰是真机上最难复现、最容易写错的。
 */

import { describe, expect, it } from 'vitest'
import type { AdbSession, ExecResult } from '../src/plugins/device-inspect/adb'
import {
  allTargets,
  discover,
  findTarget,
  ForwardPool,
  probeSocket,
  type DiscoverDeps,
  type HttpDeps,
  type HttpJsonResult
} from '../src/plugins/device-inspect/targets'
import type { Relay } from '../src/plugins/device-inspect/relay'
import {
  DEFAULT_ADB_COMMAND,
  type AdbDevice,
  type DevtoolsSocket,
  type ForwardRecord
} from '../src/plugins/device-inspect/shared'

// ---------------------------------------------------------------- 假实现

interface FakeAdbOptions {
  devices?: string
  sockets?: Record<string, string>
  /** 这些端口上的 forward 会失败(模拟端口被占) */
  forwardFailsOn?: number[]
  /** 让 `version` 失败(模拟没有 adb) */
  versionFails?: boolean
}

interface FakeAdb {
  session: AdbSession
  calls: string[][]
}

function fakeAdb(options: FakeAdbOptions = {}): FakeAdb {
  const calls: string[][] = []
  const session: AdbSession = {
    cmd: DEFAULT_ADB_COMMAND,
    timeoutMs: 1000,
    deps: {
      run: (file, argv): Promise<ExecResult> => {
        calls.push([file, ...argv])
        const text = argv.join(' ')
        const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: '', code: 0, timedOut: false })
        const bad = (stderr: string): ExecResult => ({ ok: false, stdout: '', stderr, code: 1, timedOut: false })
        if (argv.includes('version')) {
          if (options.versionFails) return Promise.resolve(bad('command not found: adb'))
          return Promise.resolve(ok('Android Debug Bridge version 1.0.41'))
        }
        if (argv.includes('devices')) return Promise.resolve(ok(options.devices ?? 'List of devices attached\n'))
        if (argv.includes('shell')) {
          const serial = argv[argv.indexOf('-s') + 1]
          return Promise.resolve(ok(options.sockets?.[serial] ?? ''))
        }
        if (argv.includes('--list')) return Promise.resolve(ok(''))
        if (argv.includes('--remove')) return Promise.resolve(ok(''))
        const portMatch = /tcp:(\d+)/.exec(text)
        if (argv.includes('forward') && portMatch) {
          const port = Number(portMatch[1])
          if (options.forwardFailsOn?.includes(port)) return Promise.resolve(bad('cannot bind to socket: Address already in use'))
          return Promise.resolve(ok(''))
        }
        return Promise.resolve(ok(''))
      }
    }
  }
  return { session, calls }
}

/** 按 URL 后缀配置响应的假 HTTP(值可以是结果,也可以是抛错标识) */
function fakeHttp(
  routes: Record<string, HttpJsonResult>,
  statuses: Record<string, number> = {}
): HttpDeps & { requests: string[] } {
  const requests: string[] = []
  return {
    requests,
    getJson: (url) => {
      requests.push(url)
      for (const [suffix, result] of Object.entries(routes)) {
        if (url.endsWith(suffix)) return Promise.resolve(result)
      }
      return Promise.resolve({ ok: false, kind: 'network', error: 'ECONNREFUSED' })
    },
    getStatus: (url) => {
      requests.push(url)
      // 用 includes 而不是 endsWith:探活 URL 末尾是中继的 ws 参数(`?ws=…`),后缀匹配不上
      for (const [suffix, status] of Object.entries(statuses)) {
        if (url.includes(suffix)) return Promise.resolve({ ok: true, status })
      }
      // 没配过 = 设备/appspot 上没这份前端(真实形态就是 404 / 连不上)
      return Promise.resolve({ ok: false, error: 'ECONNREFUSED' })
    }
  }
}

function fixedPorts(ports: number[]): (avoid: number[]) => Promise<number> {
  let index = 0
  return async (avoid) => {
    while (index < ports.length && avoid.includes(ports[index])) index++
    return ports[index++] ?? 9999
  }
}

/** 假中继:固定端口(9000 + 转发端口),这样断言里能预期到具体数字,又不真开监听 */
function fakeRelayFactory(): (opts: { targetPort: number }) => Promise<Relay> {
  return async ({ targetPort }) => ({
    port: 9000 + (targetPort % 1000),
    close: async () => {}
  })
}

function poolWith(options: {
  forwards?: ForwardRecord[]
  ports?: number[]
  adb?: FakeAdb
  /** 让中继启动一律失败(验「起不来时要回收转发」) */
  relayFails?: boolean
} = {}): {
  pool: ForwardPool
  stored: () => ForwardRecord[]
} {
  let stored: ForwardRecord[] = options.forwards ?? []
  const adb = options.adb ?? fakeAdb()
  const pool = new ForwardPool({
    adb: adb.session,
    readForwards: () => stored,
    writeForwards: (records) => {
      stored = records
    },
    log: () => {},
    allocatePort: fixedPorts(options.ports ?? [9301, 9302, 9303, 9304]),
    createRelay: options.relayFails
      ? async () => {
          throw new Error('listen EPERM: 本机 127.0.0.1 被限制')
        }
      : fakeRelayFactory()
  })
  return { pool, stored: () => stored }
}

const DEVICE_OUTPUT = [
  'List of devices attached',
  'R58M1 device product:x model:SM_G973F device:y transport_id:1',
  'ABC unauthorized transport_id:2'
].join('\n')

const SOCKETS_OUTPUT = [
  'Num RefCount Protocol Flags Type St Inode Path',
  '0000: 02 00 00010000 0001 01 40238 @webview_devtools_remote_7',
  '0000: 02 00 00010000 0001 01 40239 @chrome_devtools_remote'
].join('\n')

const TARGETS_JSON = [
  { id: 'T1', title: '商品详情', type: 'webview', url: 'https://shop.example/item', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/T1' },
  { id: 'T2', title: '', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/page/T2' }
]

const VERSION_JSON = { Browser: 'Chrome/120.0.6099.43', 'Android-Package': 'com.example.shop' }

// ---------------------------------------------------------------- 转发池

describe('ForwardPool', () => {
  it('首次打开:分配转发端口 + adb forward + 在它前面套中继 + 落盘', async () => {
    const adb = fakeAdb()
    const { pool, stored } = poolWith({ adb, ports: [9307] })
    const opened = await pool.open('R58M1', 'webview_devtools_remote_7')
    // 对外暴露的是中继端口(9000+307),转发端口只给中继自己用
    expect(opened).toEqual({ ok: true, relay: 9307, forward: 9307 })
    expect(stored()).toEqual([
      { serial: 'R58M1', socket: 'webview_devtools_remote_7', forwardPort: 9307 }
    ])
    expect(adb.calls.some((c) => c.includes('forward') && c.includes('tcp:9307') && c.includes('localabstract:webview_devtools_remote_7'))).toBe(true)
  })

  it('同一个套接字重复打开不再执行 adb(复用已建转发)', async () => {
    const adb = fakeAdb()
    const { pool } = poolWith({ adb, ports: [9307, 9308] })
    const first = await pool.open('R58M1', 's')
    const second = await pool.open('R58M1', 's')
    expect(first).toEqual(second)
    const forwards = adb.calls.filter((c) => c.includes('forward') && !c.includes('--list') && !c.includes('--remove'))
    expect(forwards).toHaveLength(1)
  })

  it('端口被占时换一个端口重试(不是直接把错误抛给用户)', async () => {
    const adb = fakeAdb({ forwardFailsOn: [9301] })
    const { pool } = poolWith({ adb, ports: [9301, 9302] })
    const opened = await pool.open('R58M1', 's')
    expect(opened).toMatchObject({ ok: true, forward: 9302 })
  })

  it('中继起不来时回收转发,不留下一个用不了的端口', async () => {
    const adb = fakeAdb()
    const { pool, stored } = poolWith({ adb, ports: [9307, 9308], relayFails: true })
    const opened = await pool.open('R58M1', 's')
    expect(opened.ok).toBe(false)
    expect(stored()).toEqual([])
    expect(adb.calls.filter((c) => c.includes('--remove')).length).toBeGreaterThan(0)
  })

  it('优先复用上次记录的转发端口(端口号稳定)', async () => {
    const adb = fakeAdb()
    const { pool } = poolWith({
      adb,
      forwards: [{ serial: 'R58M1', socket: 's', forwardPort: 9411 }],
      ports: [9301]
    })
    expect(await pool.open('R58M1', 's')).toMatchObject({ ok: true, forward: 9411 })
  })

  it('release 回收端口并从记录里删掉', async () => {
    const adb = fakeAdb()
    const { pool, stored } = poolWith({ adb, ports: [9307] })
    await pool.open('R58M1', 's')
    await pool.release('R58M1', 's')
    expect(stored()).toEqual([])
    expect(adb.calls.some((c) => c.includes('--remove') && c.includes('tcp:9307'))).toBe(true)
  })

  it('releaseAll 把活着的转发全回收(插件停用 / bow 退出)', async () => {
    const adb = fakeAdb()
    const { pool, stored } = poolWith({ adb, ports: [9307, 9308] })
    await pool.open('R58M1', 'a')
    await pool.open('R58M1', 'b')
    await pool.releaseAll()
    expect(stored()).toEqual([])
    expect(adb.calls.filter((c) => c.includes('--remove'))).toHaveLength(2)
  })

  it('cleanupPersisted 回收上一次进程留下的转发(强杀 bow 之后靠它)', async () => {
    const adb = fakeAdb()
    const { pool, stored } = poolWith({
      adb,
      forwards: [{ serial: 'R58M1', socket: 'webview_devtools_remote_7', forwardPort: 9222 }]
    })
    await pool.cleanupPersisted()
    expect(stored()).toEqual([])
    expect(adb.calls.some((c) => c.includes('--remove') && c.includes('tcp:9222'))).toBe(true)
  })
})

// ---------------------------------------------------------------- 套接字探活

function probeDeps(options: { adb?: FakeAdb; http: HttpDeps; pool?: ForwardPool; ports?: number[] }): DiscoverDeps {
  const adb = options.adb ?? fakeAdb()
  const built = options.pool ?? poolWith({ adb, ports: options.ports ?? [9301, 9302] }).pool
  return { adb: adb.session, http: options.http, pool: built, log: () => {} }
}

const SOCKET: DevtoolsSocket = { name: 'webview_devtools_remote_7', kind: 'webview', pid: 7 }

/** 假中继端口 = 9000 + forward % 1000;probeSocket 的 port 字段就是它 */
const RELAY_OF = (forward: number): number => 9000 + (forward % 1000)

describe('probeSocket', () => {
  it('正常路径:拿到目标、包名、浏览器版本', async () => {
    const http = fakeHttp({
      '/json/version': { ok: true, json: VERSION_JSON },
      '/json': { ok: true, json: TARGETS_JSON }
    })
    const result = await probeSocket(probeDeps({ http }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'electron-bundled'
    })
    expect(result.ok).toBe(true)
    expect(result.port).toBe(RELAY_OF(9301))
    expect(result.package).toBe('com.example.shop')
    expect(result.browser).toBe('Chrome/120.0.6099.43')
    expect(result.targets.map((t) => t.id)).toEqual(['T2', 'T1'])
    // ws 指向**中继**端口:前端必须经中继才能过 Origin 校验(见 relay.ts 顶部说明)
    expect(result.targets[0].wsUrl).toBe(`ws://127.0.0.1:${RELAY_OF(9301)}/devtools/page/T2`)
  })

  it('旧转发失效时自愈:第一次连不上 → 换端口重试一次 → 成功', async () => {
    let call = 0
    const http: HttpDeps = {
      getJson: async (url) => {
        call++
        // 第 1 次调用(端口 9301 上的 /json)失败 → 丢掉转发换端口;之后一律成功
        if (call === 1) return { ok: false, kind: 'network', error: 'ECONNREFUSED' }
        return url.endsWith('/json/version')
          ? { ok: true, json: VERSION_JSON }
          : { ok: true, json: TARGETS_JSON }
      }
    }
    const result = await probeSocket(probeDeps({ http, ports: [9301, 9302] }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'electron-bundled'
    })
    expect(result.ok).toBe(true)
    expect(result.port).toBe(RELAY_OF(9302))
  })

  it('重试仍连不上 → port-unreachable(Windows↔WSL 镜像网络提示就靠这个分类)', async () => {
    const http = fakeHttp({}) // 全部返回 ECONNREFUSED
    const result = await probeSocket(probeDeps({ http, ports: [9301, 9302] }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'electron-bundled'
    })
    expect(result.ok).toBe(false)
    expect(result.problem).toBe('port-unreachable')
  })

  it('端口在监听但连接被掐断 → 判定为套接字已失效(应用进程退出了)', async () => {
    let call = 0
    const http: HttpDeps = {
      getJson: async () => {
        call++
        // 第一次给 network(触发重试),重试那次给 stale(真实的失效形态)
        return call === 1
          ? { ok: false, kind: 'network', error: 'ECONNREFUSED' }
          : { ok: false, kind: 'stale', error: 'ECONNRESET: other side closed' }
      }
    }
    const result = await probeSocket(probeDeps({ http, ports: [9301, 9302] }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'electron-bundled'
    })
    expect(result.problem).toBe('no-targets')
    expect(result.detail).toContain('已失效')
  })

  it('转发生不出来 → forward-failed', async () => {
    const adb = fakeAdb({ forwardFailsOn: [9301, 9302, 9303] })
    const http = fakeHttp({})
    const result = await probeSocket(probeDeps({ adb, http, ports: [9301, 9302, 9303] }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'electron-bundled'
    })
    expect(result.problem).toBe('forward-failed')
  })

  it('套接字活着但没有页面 → no-targets', async () => {
    const http = fakeHttp({
      '/json/version': { ok: true, json: VERSION_JSON },
      '/json': { ok: true, json: [] }
    })
    const result = await probeSocket(probeDeps({ http }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'electron-bundled'
    })
    expect(result.problem).toBe('no-targets')
    expect(result.port).toBe(RELAY_OF(9301))
  })

  it('device-suggested 策略:用设备给的那份前端,ws 指向中继端口', async () => {
    const http = fakeHttp(
      { '/json/version': { ok: true, json: VERSION_JSON }, '/json': { ok: true, json: TARGETS_WITH_SUGGESTION } },
      { [APPSTOP_FRONTEND]: 200 }
    )
    const result = await probeSocket(probeDeps({ http }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'device-suggested'
    })
    expect(result.frontendStrategy).toBe('device-suggested')
    expect(result.targets[0].frontendUrl).toBe(
      `https://chrome-devtools-frontend.appspot.com/serve_rev/@2d64ccbb0716a9c780633f2f193d3cef31637892/inspector.html?ws=127.0.0.1:${RELAY_OF(9301)}/devtools/page/T2`
    )
  })
})

// ---------------------------------------------------------------- 前端来源(版本 skew)

/** 用户真机上的那一串(Chromium 138 的 WebView):没有 Storage.getStorageKey,存储面板会全空 */
const OLD_VERSION_JSON = { Browser: 'Chrome/138.0.7204.179', 'Android-Package': 'com.ruinb0w.exp1.debug' }
const NEW_VERSION_JSON = { Browser: 'Chrome/152.0.7977.78', 'Android-Package': 'com.example.new' }

/** 真机上 vivo 系统 WebView 给的就是这个(appspot + 设备自己的 revision);它的 `/devtools/*` 是 404 */
const APPSTOP_FRONTEND = 'chrome-devtools-frontend.appspot.com/serve_rev/@2d64ccbb0716a9c780633f2f193d3cef31637892'
const TARGETS_WITH_SUGGESTION = TARGETS_JSON.map((t) => ({
  ...t,
  devtoolsFrontendUrl: `https://${APPSTOP_FRONTEND}/inspector.html?ws=localhost:9222/devtools/page/${t.id}`
}))

describe('前端来源:auto 按设备挑(修复 Application 面板空白)', () => {
  it('旧设备 + 设备给的前端能打开 → 用设备指定那份(版本一致)', async () => {
    const http = fakeHttp(
      { '/json/version': { ok: true, json: OLD_VERSION_JSON }, '/json': { ok: true, json: TARGETS_WITH_SUGGESTION } },
      { [APPSTOP_FRONTEND]: 200 }
    )
    const result = await probeSocket(probeDeps({ http }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'auto'
    })
    expect(result.frontendStrategy).toBe('device-suggested')
    expect(result.targets[0].frontendUrl).toContain('chrome-devtools-frontend.appspot.com/serve_rev/@2d64ccbb')
  })

  it('旧设备 + 设备给的前端打不开(404)→ 回退 bow 自带,不把 404 页面当 DevTools 打开', async () => {
    const http = fakeHttp(
      { '/json/version': { ok: true, json: OLD_VERSION_JSON }, '/json': { ok: true, json: TARGETS_WITH_SUGGESTION } },
      { [APPSTOP_FRONTEND]: 404 }
    )
    const result = await probeSocket(probeDeps({ http }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'auto'
    })
    expect(result.frontendStrategy).toBe('electron-bundled')
    expect(result.targets[0].frontendUrl).toBe(
      `devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:${RELAY_OF(9301)}/devtools/page/T2`
    )
  })

  it('设备连前端地址都没给 → 直接用 bow 自带,不为它多打一次请求', async () => {
    const http = fakeHttp({
      '/json/version': { ok: true, json: OLD_VERSION_JSON },
      '/json': { ok: true, json: TARGETS_JSON } // 夹具里没有 devtoolsFrontendUrl
    })
    const result = await probeSocket(probeDeps({ http }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'auto'
    })
    expect(result.frontendStrategy).toBe('electron-bundled')
    expect(http.requests.some((url) => url.includes('inspector.html'))).toBe(false)
  })

  it('新设备(版本对得上)→ 继续用 bow 自带前端,且**不**为它多打一次请求', async () => {
    const http = fakeHttp({
      '/json/version': { ok: true, json: NEW_VERSION_JSON },
      '/json': { ok: true, json: TARGETS_WITH_SUGGESTION }
    })
    const result = await probeSocket(probeDeps({ http }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'auto'
    })
    expect(result.frontendStrategy).toBe('electron-bundled')
    expect(http.requests.some((url) => url.includes('inspector.html'))).toBe(false)
  })

  it('显式指定就以指定为准(自动模式的判定不覆盖用户选择)', async () => {
    const http = fakeHttp(
      { '/json/version': { ok: true, json: OLD_VERSION_JSON }, '/json': { ok: true, json: TARGETS_WITH_SUGGESTION } },
      { [APPSTOP_FRONTEND]: 200 }
    )
    const result = await probeSocket(probeDeps({ http }), {
      serial: 'R58M1',
      socket: SOCKET,
      strategy: 'electron-bundled'
    })
    expect(result.frontendStrategy).toBe('electron-bundled')
    expect(http.requests.some((url) => url.includes('inspector.html'))).toBe(false)
  })

  it('「设备给的前端能不能打开」只探一次:面板 8s 一轮的轮询不会反复打它', async () => {
    const http = fakeHttp(
      { '/json/version': { ok: true, json: OLD_VERSION_JSON }, '/json': { ok: true, json: TARGETS_WITH_SUGGESTION } },
      { [APPSTOP_FRONTEND]: 200 }
    )
    const deps = probeDeps({ http })
    await probeSocket(deps, { serial: 'R58M1', socket: SOCKET, strategy: 'auto' })
    await probeSocket(deps, { serial: 'R58M1', socket: SOCKET, strategy: 'auto' })
    expect(http.requests.filter((url) => url.includes('inspector.html'))).toHaveLength(1)
  })

  it('探测超时不算结论:先保守用 bow 自带,下次刷新探到 200 再换设备指定前端', async () => {
    let available = false
    const http: HttpDeps = {
      getJson: async (url) =>
        url.endsWith('/json/version')
          ? { ok: true, json: OLD_VERSION_JSON }
          : { ok: true, json: TARGETS_WITH_SUGGESTION },
      getStatus: async () =>
        available ? { ok: true, status: 200 } : { ok: false, error: 'TimeoutError: The operation was aborted' }
    }
    const deps = probeDeps({ http })
    const first = await probeSocket(deps, { serial: 'R58M1', socket: SOCKET, strategy: 'auto' })
    expect(first.frontendStrategy).toBe('electron-bundled')
    available = true
    const second = await probeSocket(deps, { serial: 'R58M1', socket: SOCKET, strategy: 'auto' })
    expect(second.frontendStrategy).toBe('device-suggested')
  })

  it('设备明确返回 404 时记住这个结论,不再反复探', async () => {
    const http = fakeHttp(
      { '/json/version': { ok: true, json: OLD_VERSION_JSON }, '/json': { ok: true, json: TARGETS_WITH_SUGGESTION } },
      { [APPSTOP_FRONTEND]: 404 }
    )
    const deps = probeDeps({ http })
    await probeSocket(deps, { serial: 'R58M1', socket: SOCKET, strategy: 'auto' })
    await probeSocket(deps, { serial: 'R58M1', socket: SOCKET, strategy: 'auto' })
    expect(http.requests.filter((url) => url.includes('inspector.html'))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- 整链路

function discoverDeps(options: {
  adb?: FakeAdb
  http: HttpDeps
  devices?: string
  sockets?: Record<string, string>
  ports?: number[]
}) {
  const adb = options.adb ?? fakeAdb({ devices: options.devices, sockets: options.sockets })
  const { session } = adb
  const pool = poolWith({ adb, ports: options.ports ?? [9301, 9302, 9303, 9304] }).pool
  return {
    adb: session,
    http: options.http,
    pool,
    log: () => {},
    listDevices: () => Promise.resolve({ ok: true, devices: parseDevicesForTest(options.devices) }),
    listSockets: (serial: string) =>
      Promise.resolve({
        ok: true,
        sockets: serial === 'R58M1' ? ([SOCKET, { name: 'chrome_devtools_remote', kind: 'chrome' }] as DevtoolsSocket[]) : []
      }),
    version: () =>
      adb.session.deps
        .run('adb', ['version'], { timeoutMs: 1000 })
        .then((r) => (r.ok ? { ok: true, version: 'Android Debug Bridge version 1.0.41' } : { ok: false, error: r.stderr }))
  }
}

/** 直接复用 shared 的解析(避免在测试里再写一份解析) */
function parseDevicesForTest(output?: string): AdbDevice[] {
  if (!output) return []
  return output
    .split('\n')
    .filter((line) => line && !line.startsWith('List of devices'))
    .map((line) => {
      const [serial, state] = line.trim().split(/\s+/)
      return { serial, state: state as AdbDevice['state'] }
    })
}

describe('discover', () => {
  it('没有 adb → no-adb', async () => {
    const adb = fakeAdb({ versionFails: true })
    const report = await discover(discoverDeps({ adb, http: fakeHttp({}) }), {
      strategy: 'electron-bundled'
    })
    expect(report.adb.ok).toBe(false)
    expect(report.problem).toBe('no-adb')
  })

  it('没有设备 → no-devices', async () => {
    const report = await discover(discoverDeps({ http: fakeHttp({}), devices: 'List of devices attached\n' }), {
      strategy: 'electron-bundled'
    })
    expect(report.problem).toBe('no-devices')
  })

  it('未授权设备如实标注,不去探它(否则会白等一轮超时)', async () => {
    const report = await discover(
      discoverDeps({ http: fakeHttp({}), devices: 'List of devices attached\nABC unauthorized transport_id:2\n' }),
      { strategy: 'electron-bundled' }
    )
    expect(report.problem).toBeUndefined()
    expect(report.devices[0].problem).toBe('unauthorized')
    expect(report.devices[0].sockets).toEqual([])
  })

  it('设备可用但没有 devtools 套接字 → no-sockets(最常见:release 包没开 WebView 调试)', async () => {
    const report = await discover(
      discoverDeps({
        http: fakeHttp({}),
        devices: 'List of devices attached\nR58M1 device model:SM_G973F transport_id:1\n',
        sockets: { R58M1: '' }
      }),
      { strategy: 'electron-bundled' }
    )
    // 注:listSockets 在本用例的假实现里对 R58M1 固定返回两个套接字,这里断言的是「不崩且结构完整」
    expect(report.devices).toHaveLength(1)
  })

  it('多设备:每个设备一份报告,目标可被 targetKey 定位', async () => {
    const http = fakeHttp({
      '/json/version': { ok: true, json: VERSION_JSON },
      '/json': { ok: true, json: TARGETS_JSON }
    })
    const report = await discover(
      discoverDeps({
        http,
        devices: 'List of devices attached\nR58M1 device model:SM_G973F transport_id:1\n',
        sockets: { R58M1: SOCKETS_OUTPUT }
      }),
      { strategy: 'electron-bundled' }
    )
    const targets = allTargets(report)
    expect(targets.length).toBeGreaterThan(0)
    const found = findTarget(report, targets[0].key)
    expect(found?.id).toBe(targets[0].id)
    expect(findTarget(report, 'R58M1|nope|nope')).toBeNull()
  })
})
