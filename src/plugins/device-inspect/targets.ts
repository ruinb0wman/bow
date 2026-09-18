/**
 * 目标发现 + 转发生命周期(把 adb.ts 的原子操作编排成「设备 → 套接字 → 目标」)。
 *
 * 三件事在这里收口:
 *
 * 1. **端口转发池**:每个套接字一个本地 TCP 端口。转发登记在 **adb server 进程**里,bow 被强杀
 *    不会自动回收,所以记录持久化到插件 store,插件激活时先清一次上次的残留(见 `cleanupPersisted`)。
 * 2. **套接字探活**:拿到端口不等于能用 —— 设备重连后旧转发会失效,所以每次都用 `/json` 探一次,
 *    失败就丢掉旧转发、换端口重试一次(而不是让用户看到「列表里有一个坏条目」)。
 * 3. **失败归类**:把「端口没人监听」「套接字已失效」「设备返回非 200」分成不同的 problem,
 *    对应 shared.ts 里三套不同的用户指引。归类口径见 `classifyFetchError`。
 *
 * 与本机形态相关的关键点(bow 在 Windows,adb 在 WSL):转发建在 WSL 的 netns 里,
 * Windows 侧连 `127.0.0.1:<port>` 只有在 WSL2 镜像网络下才通;不通时的错误是 ECONNREFUSED,
 * 归类成 `port-unreachable`,提示语直接点名 `.wslconfig` 的 `networkingMode=Mirrored`。
 */

import type { AdbSession } from './adb'
import { addForward, allocatePort, removeForward } from './adb'
import { startRelay, type Relay } from './relay'
import {
  androidPackageFromVersion,
  browserNameFromVersion,
  effectiveStrategy,
  firstSuggestedFrontendUrl,
  targetsFromJson,
  type AdbDevice,
  type DeviceReport,
  type DeviceTarget,
  type DevtoolsSocket,
  type DiscoverProblem,
  type DiscoverReport,
  type ForwardRecord,
  type FrontendStrategy,
  type ResolvedFrontendStrategy,
  type SocketReport
} from './shared'

// ---------------------------------------------------------------- HTTP

export interface HttpJsonResult {
  ok: boolean
  status?: number
  json?: unknown
  error?: string
  /** network = 端口没监听;stale = 有监听但连接被对端关掉(通常是设备侧套接字失效) */
  kind?: 'network' | 'stale' | 'http'
}

export interface HttpDeps {
  getJson(url: string, timeoutMs: number): Promise<HttpJsonResult>
  /** 只看状态码(用于探「设备有没有自带前端资源」);失败时 `ok: false` */
  getStatus(url: string, timeoutMs: number): Promise<HttpStatusResult>
}

export interface HttpStatusResult {
  ok: boolean
  status?: number
  error?: string
}

/** 区分「端口没人监听」与「连接被对端掐断」—— 这两者对应完全不同的排查方向 */
export function classifyFetchError(message: string): 'network' | 'stale' {
  return /ECONNRESET|other side closed|socket hang up|UND_ERR_SOCKET|EPIPE/i.test(message)
    ? 'stale'
    : 'network'
}

export function nodeHttpDeps(overrides: Partial<HttpDeps> = {}): HttpDeps {
  return {
    getJson: async (url, timeoutMs) => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          cache: 'no-store',
          headers: { accept: 'application/json' }
        })
        if (!response.ok) {
          return { ok: false, status: response.status, kind: 'http', error: `HTTP ${response.status}` }
        }
        return { ok: true, status: response.status, json: await response.json() }
      } catch (error) {
        const message = describeError(error)
        return { ok: false, kind: classifyFetchError(message), error: message }
      }
    },
    getStatus: async (url, timeoutMs) => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          cache: 'no-store',
          headers: { accept: 'text/html' }
        })
        // 只关心状态码:把 body 丢掉,不要为了一份 html 把整包读进内存
        await response.body?.cancel().catch(() => {})
        return { ok: true, status: response.status }
      } catch (error) {
        return { ok: false, error: describeError(error) }
      }
    },
    ...overrides
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    const causeText =
      cause instanceof Error ? `${(cause as { code?: string }).code ?? ''} ${cause.message}` : ''
    return `${error.name}: ${error.message} ${causeText}`.trim()
  }
  return String(error)
}

// ---------------------------------------------------------------- 转发池

export interface ForwardPoolDeps {
  adb: AdbSession
  /** 持久化的转发记录(getter/setter 由插件注到 PluginStorage) */
  readForwards(): ForwardRecord[]
  writeForwards(records: ForwardRecord[]): void
  log(...args: unknown[]): void
  /** 端口分配器(可注入以便单测不真绑端口);默认绑 0 拿空闲端口 */
  allocatePort?(avoid: number[]): Promise<number>
  /** 中继工厂(可注入)。真实现是 relay.ts 的 startRelay;真实链路另有对真中继的集成用例 */
  createRelay?(opts: { targetPort: number; log?: (...args: unknown[]) => void }): Promise<Relay>
}

const socketId = (serial: string, socket: string): string => `${serial}|${socket}`

/** 一个套接字对应的两个本地端口:对外暴露的是中继端口,转发端口只给中继自己用 */
export interface SocketPorts {
  /** DevTools 前端与 CDP 客户端连接的端口(中继),`ws=127.0.0.1:<relay>/devtools/page/<id>` */
  relay: number
  /** `adb forward` 建的端口,只被上面的中继连接 */
  forward: number
}

export class ForwardPool {
  private live = new Map<string, SocketPorts & { relayHandle: Relay; suggestedFrontend?: boolean }>()

  constructor(private deps: ForwardPoolDeps) {}

  /** 当前活着的转发(给 UI 显示「已转发 N 个端口」) */
  snapshot(): ForwardRecord[] {
    return [...this.live.entries()].map(([id, ports]) => {
      const [serial, socket] = splitId(id)
      return { serial, socket, forwardPort: ports.forward }
    })
  }

  private persist(): void {
    this.deps.writeForwards(this.snapshot())
  }

  /**
   * 清理上一次运行留下的转发(插件激活时调用一次)。
   *
   * 为什么要清:adb forward 的登记在 adb server 里,`taskkill bow.exe` 之后依然存在;
   * 不清的话端口会被一批早已无人认领的转发长期占住。清理按 store 里的记录逐条 `--remove`,
   * 失败(设备已拔)直接忽略 —— 目的是清干净,不是报告失败。
   */
  async cleanupPersisted(): Promise<void> {
    const persisted = this.deps.readForwards()
    if (persisted.length === 0) return
    for (const record of persisted) {
      await removeForward(this.deps.adb, record.serial, record.forwardPort)
    }
    this.deps.log('清理遗留转发', persisted.length)
    this.deps.writeForwards([])
  }

  /**
   * 保险:如果 store 丢了但 adb 里还有我们格式的转发,尽量也回收掉(只删 localabstract 的)
   *
   * ⚠️ 故意**不做**这件事。`adb forward` 是共享资源:用户自己也可能执行过
   * `adb forward tcp:9222 localabstract:chrome_devtools_remote`(chrome://inspect 的常规用法),
   * 按「像我们的」去删会破坏别人的工作流。我们只回收 store 里记着的那几条(见 cleanupPersisted),
   * 认领不了的就留着 —— 宁可留一个端口,不要删别人的东西。
   */

  /** 打开(或复用)某个套接字的本地端口:先建 `adb forward`,再在它前面套一个剥 Origin 的中继 */
  async open(serial: string, socket: string): Promise<({ ok: true } & SocketPorts) | { ok: false; error: string }> {
    const id = socketId(serial, socket)
    const existing = this.live.get(id)
    if (existing) return { ok: true, relay: existing.relay, forward: existing.forward }

    const persisted = this.deps.readForwards().find((r) => r.serial === serial && r.socket === socket)
    const candidates: number[] = []
    if (persisted) {
      // 优先复用上次的转发端口:端口号稳定,用户/文档里的地址不会每次都变
      await removeForward(this.deps.adb, serial, persisted.forwardPort)
      candidates.push(persisted.forwardPort)
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (candidates.length <= attempt) {
        candidates.push(await this.allocate())
      }
      const forward = candidates[attempt]
      const result = await addForward(this.deps.adb, serial, forward, socket)
      if (!result.ok) {
        this.deps.log('转发失败,换端口重试', serial, socket, forward, result.error ?? '')
        continue
      }
      try {
        const factory = this.deps.createRelay ?? startRelay
        const relayHandle = await factory({ targetPort: forward, log: this.deps.log })
        this.live.set(id, { relay: relayHandle.port, forward, relayHandle })
        this.persist()
        return { ok: true, relay: relayHandle.port, forward }
      } catch (error) {
        // 中继起不来(本机 127.0.0.1 被限制?):把转发回收掉,不要留个用不了的端口
        await removeForward(this.deps.adb, serial, forward)
        this.deps.log('中继启动失败', serial, socket, String(error))
      }
    }
    return { ok: false, error: 'adb forward / 本地中继连续失败(端口可能被占用,或设备已断开)' }
  }

  /**
   * 「设备指定的前端能不能打开」——**按套接字只探一次**(结果给 `effectiveStrategy()` 用)。
   *
   * 之所以要探:这件事没有可靠的本地判据 —— 设备给的地址可能是它自带的前端(本地),
   * 也可能是 appspot 上它那个 revision 的前端(需要外网:实测 vivo 系统 WebView 就是这种)。
   * 探测走回调注入:转发池只管生命周期,不管 HTTP(与 `allocatePort` / `createRelay` 同一套路)。
   * 回调返回 `undefined` = 没探出结论(超时/连不上),此时**不缓存**,下一次发现会再探;
   * 只有确定的结论(200 或 404)才记住。缓存挂在活着的转发条目上,转发一失效就会重新探。
   */
  async ensureSuggestedFrontend(
    serial: string,
    socket: string,
    probe: () => Promise<boolean | undefined>
  ): Promise<boolean> {
    const entry = this.live.get(socketId(serial, socket))
    if (!entry) return false
    if (entry.suggestedFrontend === undefined) {
      const result = await probe()
      if (result === undefined) return false // 探不出来就先按最保守的来(本地前端一定能加载)
      entry.suggestedFrontend = result
    }
    return entry.suggestedFrontend
  }

  private allocate(): Promise<number> {
    const custom = this.deps.allocatePort
    if (custom) return custom([...this.live.values()].map((p) => p.forward))
    return allocatePort([...this.live.values()].map((p) => p.forward))
  }

  /** 丢弃某个套接字的转发与中继(探活失败时用) */
  async release(serial: string, socket: string): Promise<void> {
    const id = socketId(serial, socket)
    const ports = this.live.get(id)
    if (!ports) return
    this.live.delete(id)
    this.persist()
    await ports.relayHandle.close()
    await removeForward(this.deps.adb, serial, ports.forward)
  }

  /** 全部回收(插件停用 / bow 退出) */
  async releaseAll(): Promise<void> {
    const entries = [...this.live.entries()]
    this.live.clear()
    this.deps.writeForwards([])
    for (const [id, ports] of entries) {
      const [serial] = splitId(id)
      await ports.relayHandle.close()
      await removeForward(this.deps.adb, serial, ports.forward)
    }
    if (entries.length > 0) this.deps.log('回收转发与中继', entries.length)
  }
}

function splitId(id: string): [string, string] {
  const idx = id.indexOf('|')
  return [id.slice(0, idx), id.slice(idx + 1)]
}

// ---------------------------------------------------------------- 发现

export interface ProbeResult {
  socket: DevtoolsSocket
  ok: boolean
  port?: number
  package?: string
  browser?: string
  /** 实际采用的 DevTools 前端来源(设置里选 auto 时可能与设置值不同) */
  frontendStrategy?: ResolvedFrontendStrategy
  targets: DeviceTarget[]
  problem?: DiscoverProblem
  detail?: string
}

export interface DiscoverDeps {
  adb: AdbSession
  http: HttpDeps
  pool: ForwardPool
  log(...args: unknown[]): void
}

/**
 * 探一个套接字:确保有转发 → 拉 `/json` → 拉 `/json/version` → 改写目标。
 *
 * 关键设计:**第一次失败不直接报错,而是丢掉转发换端口重试一次**。
 * 因为「端口拿到手但连不上」的最常见原因就是设备重连后旧转发失效,重试能自愈;
 * 重试仍失败才归类上报(见 classifyFetchError 的两种 kind)。
 */
export async function probeSocket(
  deps: DiscoverDeps,
  args: { serial: string; socket: DevtoolsSocket; strategy: FrontendStrategy }
): Promise<ProbeResult> {
  const { serial, socket, strategy } = args
  const base: ProbeResult = { socket, ok: false, targets: [] }

  for (let attempt = 0; attempt < 2; attempt++) {
    const opened = await deps.pool.open(serial, socket.name)
    if (!opened.ok) {
      return { ...base, problem: 'forward-failed', detail: opened.error }
    }
    // 探活用**中继端口**:它就是前端与 CDP 客户端要连的那个口,要验就验它(顺带覆盖「中继能否工作」)
    const endpoint = `http://127.0.0.1:${opened.relay}`
    const json = await deps.http.getJson(`${endpoint}/json`, 5_000)
    if (!json.ok) {
      if (attempt === 0) {
        // 旧转发/旧端口:丢掉重来一次
        await deps.pool.release(serial, socket.name)
        continue
      }
      if (json.kind === 'stale') {
        return {
          ...base,
          port: opened.relay,
          problem: 'no-targets',
          detail: `套接字 ${socket.name} 已失效(应用进程可能已退出):${json.error ?? ''}`
        }
      }
      if (json.kind === 'network') {
        return {
          ...base,
          port: opened.relay,
          problem: 'port-unreachable',
          detail: `无法访问 127.0.0.1:${opened.relay} —— ${json.error ?? ''}`
        }
      }
      return { ...base, port: opened.relay, problem: 'forward-failed', detail: json.error }
    }

    const version = await deps.http.getJson(`${endpoint}/json/version`, 5_000)
    const browser = browserNameFromVersion(version.json)
    // 设备自己给的前端地址(设备自带 / appspot 按它的 revision),取一条探活就行
    const suggested = firstSuggestedFrontendUrl(json.json, { localPort: opened.relay })
    const frontendStrategy = await resolveFrontendStrategy(deps, {
      serial,
      socket: socket.name,
      requested: strategy,
      browser,
      suggested
    })
    const targets = targetsFromJson(json.json, {
      serial,
      socket: socket.name,
      localPort: opened.relay,
      strategy: frontendStrategy,
      package: androidPackageFromVersion(version.json)
    })
    if (targets.length === 0) {
      return { ...base, port: opened.relay, problem: 'no-targets' }
    }
    return {
      socket,
      ok: true,
      port: opened.relay,
      package: androidPackageFromVersion(version.json),
      browser,
      frontendStrategy,
      targets
    }
  }

  return { ...base, problem: 'forward-failed' }
}

/* SocketReport / DeviceReport / DiscoverReport 的类型定义在 ./shared(渲染层也要用,不能被 node 依赖拖下去) */

/**
 * 设置里的策略 + 设备情况 → **实际**前端来源。
 *
 * 只有真的要用「设备指定的前端」时才去探一次它能不能打开 —— 现代设备(版本对得上)不会多出任何请求。
 * 探测结果按套接字缓存,见 `ensureSuggestedFrontend`。
 */
async function resolveFrontendStrategy(
  deps: DiscoverDeps,
  args: { serial: string; socket: string; requested: FrontendStrategy; browser?: string; suggested: string | null }
): Promise<ResolvedFrontendStrategy> {
  const wanted = effectiveStrategy(args.requested, { browser: args.browser })
  if (wanted !== 'device-suggested') return wanted
  // 设备连前端地址都没给(极少):直接回退,不用探
  if (!args.suggested) return 'electron-bundled'
  const available = await deps.pool.ensureSuggestedFrontend(args.serial, args.socket, async () => {
    const result = await deps.http.getStatus(args.suggested as string, 8_000)
    // 有明确状态码才有结论(404 = 设备/appspot 上没这份前端);网络层失败返回 undefined,下次刷新再探
    return result.ok ? result.status === 200 : undefined
  })
  return available ? 'device-suggested' : 'electron-bundled'
}

/**
 * 完整发现流程。`listSockets` 由调用方注入(它需要按设备串号走 adb shell),
 * 这样这个函数只依赖三个可替换的接口,单测能用假 adb + 假 HTTP 跑完。
 */
export async function discover(
  deps: DiscoverDeps & {
    listDevices(): Promise<{ ok: boolean; devices: AdbDevice[]; error?: string }>
    listSockets(serial: string): Promise<{ ok: boolean; sockets: DevtoolsSocket[]; error?: string }>
    version(): Promise<{ ok: boolean; version?: string; error?: string }>
  },
  opts: { strategy: FrontendStrategy }
): Promise<DiscoverReport> {
  const version = await deps.version()
  if (!version.ok) {
    return { adb: { ok: false, error: version.error }, devices: [], problem: 'no-adb', detail: version.error }
  }

  const listed = await deps.listDevices()
  if (!listed.ok) {
    return {
      adb: { ok: true, version: version.version },
      devices: [],
      problem: 'no-devices',
      detail: listed.error
    }
  }
  if (listed.devices.length === 0) {
    return { adb: { ok: true, version: version.version }, devices: [], problem: 'no-devices' }
  }

  const reports: DeviceReport[] = []
  for (const device of listed.devices) {
    if (device.state !== 'device') {
      reports.push({
        device,
        sockets: [],
        problem: device.state === 'unauthorized' ? 'unauthorized' : 'offline'
      })
      continue
    }
    const sockets = await deps.listSockets(device.serial)
    if (!sockets.ok) {
      reports.push({ device, sockets: [], problem: 'no-sockets', detail: sockets.error })
      continue
    }
    if (sockets.sockets.length === 0) {
      reports.push({ device, sockets: [], problem: 'no-sockets' })
      continue
    }
    const probes: SocketReport[] = []
    for (const socket of sockets.sockets) {
      const probe = await probeSocket(deps, { serial: device.serial, socket, strategy: opts.strategy })
      probes.push({
        socket,
        port: probe.port,
        package: probe.package,
        browser: probe.browser,
        frontendStrategy: probe.frontendStrategy,
        targets: probe.targets,
        problem: probe.problem,
        detail: probe.detail
      })
    }
    reports.push({ device, sockets: probes })
  }

  return { adb: { ok: true, version: version.version }, devices: reports }
}

/** 设备报告列表 → 所有目标(UI 的「全部」视图与 MCP 工具用) */
export function targetsOfDevices(devices: DeviceReport[]): DeviceTarget[] {
  return devices.flatMap((d) => d.sockets.flatMap((s) => s.targets))
}

/** 把报告摊平成所有目标 */
export function allTargets(report: DiscoverReport): DeviceTarget[] {
  return targetsOfDevices(report.devices)
}

/** 按 targetKey 找目标 —— MCP 工具的统一寻址入口 */
export function findTarget(report: DiscoverReport, key: string): DeviceTarget | null {
  return allTargets(report).find((t) => t.key === key) ?? null
}
