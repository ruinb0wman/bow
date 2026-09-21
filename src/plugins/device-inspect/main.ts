/**
 * 设备检查插件:把手机上的 WebView / Chrome 页面接进 bow 的 DevTools 前端。
 *
 * 它复刻的是 `chrome://inspect` 那条链路:
 *   adb 设备 → `/proc/net/unix` 里的 devtools 套接字 → `adb forward` → `/json` 目标列表
 *   → DevTools 前端(在 bow 的标签页里打开)。
 *
 * 分工(改代码前先看这张表,免得把 I/O 塞进 UI):
 * - `shared.ts`  纯逻辑:adb 输出解析、目标改写、前端 URL、提示文案;
 * - `adb.ts`     adb 执行层(唯一 spawn 的地方);
 * - `targets.ts` 转发池 + 套接字探活 + 失败归类;
 * - `cdp.ts`     最小 CDP 客户端(MCP 的 eval / 截图);
 * - 本文件       IPC 面 + MCP 工具 + 持久化 + 生命周期。
 *
 * 两个必须记住的前提(详见 .pi/plans/device-inspect.md):
 * 1. **adb 可能不在本机**:本机形态是 bow.exe 在 Windows、adb 在 WSL,所以设置里可以填复合命令
 *    (`wsl adb`)。默认按 `adb` → `wsl adb` 依次探测,探测结果只在内存里缓存(不落盘)。
 * 2. **打开前端标签页由内核完成**(`ctx.pages.openDevToolsTab`):插件把**算好的前端地址**交给内核,
 *    不交给它 ws 地址 —— 前端不一定是 bow 自带的那份(见 `shared.effectiveStrategy`)。
 *    两个不变式仍在:`@shared/devtools` 是 bow 自带前端地址的唯一拼装处;`ws=` 参数不带 scheme。
 */

import { app, net } from 'electron'
import { z } from 'zod'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import { textContent, imageContent } from '../../main/plugins/mcpResult'
import {
  adbVersion,
  connectDevice,
  listDevices,
  listSockets,
  nodeExecDeps,
  pairDevice,
  rawAdb,
  type AdbSession
} from './adb'
import { connectCdp, cdpConsole, cdpEvaluate, cdpPressKey, cdpScreenshot, cdpScroll, cdpSnapshot, cdpTap, cdpType } from './cdp'
import {
  discover,
  nodeHttpDeps,
  ForwardPool,
  targetsOfDevices,
  type HttpDeps
} from './targets'
import {
  DEFAULT_ADB_COMMAND,
  isWslAdb,
  normalizeStrategy,
  parseAdbSetting,
  problemHint,
  socketLabel,
  type DeviceReport,
  type DeviceTarget,
  type DiscoverProblem,
  type DiscoverReport,
  type ForwardRecord,
  type FrontendStrategy,
  type InspectNotice,
  type InspectSnapshot
} from './shared'

/** 持久化结构。`forwards` 必须落盘:adb forward 登记在 adb server 里,bow 被强杀后必须能回收 */
export interface InspectState {
  version: number
  /** 置空 = 自动探测(Windows 上依次试 `adb`、`wsl adb`) */
  adbCommand: string
  /**
   * DevTools 前端来源,三选一(默认 `auto`)。
   * 为什么需要 `auto`:前端与设备的 CDP 版本必须对得上 —— bow 自带的前端是 Chromium 152 的,
   * 它在旧设备上取不到 storage key,Application 面板的 Local Storage / IndexedDB 会静默全空。
   * 判定规则见 `shared.effectiveStrategy()`(`device-suggested` = 用设备给的那份前端,
   * 即 `chrome://inspect` 的做法)。
   */
  strategy: FrontendStrategy
  /** 上一次运行留下的转发,用于启动清理与端口复用 */
  forwards: ForwardRecord[]
}

/** 当前状态文件版本;v1 → v2 只是把前端来源默认值换成 `auto` */
const STATE_VERSION = 2

const DEFAULT_STATE: InspectState = {
  version: STATE_VERSION,
  adbCommand: '',
  strategy: 'auto',
  forwards: []
}

/**
 * 「设备给的前端入口能不能打开」的探活必须走 **Chromium 的网络栈**。
 *
 * 为什么不能用 `nodeHttpDeps` 默认的 undici:它不认系统代理(`http_proxy` 也不认),
 * 而随后真正加载那个页面的**标签页是 Chromium 在请求**。设备给的前端很可能在
 * `chrome-devtools-frontend.appspot.com`(实测 vivo 系统 WebView 就是),在需要代理的机器上
 * 用 undici 探会「打不开」—— 那就白白回退到 bow 自带前端(存储面板依旧空),而实际上标签页是能打开的。
 * 探活用 GET + 丢掉 body(只取状态码),不读内容。
 */
function electronFrontendStatus(
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: { ok: boolean; status?: number; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        request.abort()
      } catch {
        /* 已经结束 */
      }
      done({ ok: false, error: `探活超时(${timeoutMs}ms)` })
    }, timeoutMs)
    const request = net.request({ method: 'GET', url, redirect: 'follow' })
    request.on('response', (response) => {
      response.on('data', () => {}) // 排空 body:只需要状态码,不要为一个 HTML 保留连接
      response.on('end', () => done({ ok: true, status: response.statusCode }))
      response.on('error', (error) => done({ ok: false, error: error.message }))
    })
    request.on('error', (error) => done({ ok: false, error: error.message }))
    request.end()
  })
}

function createDeviceInspectPlugin(): PluginMain {
  /** 每个插件实例一份状态;`activate` 里初始化,`deactivate` 里清空 */
  let store: PluginStorage<InspectState> | null = null
  let pool: ForwardPool | null = null
  let poolCommand: string | null = null
  let http: HttpDeps | null = null
  let cachedCommand: string | null = null
  let onBeforeQuit: (() => void) | null = null
  const sessions = new Map<string, AdbSession>()

  /** adb 候选命令(顺序 = 探测顺序):Windows 上先试原生 adb,再试 WSL 里的 adb */
  const candidates = (): string[] => (process.platform === 'win32' ? ['adb', 'wsl adb'] : ['adb'])

  function sessionFor(command: string): AdbSession {
    const hit = sessions.get(command)
    if (hit) return hit
    const session: AdbSession = {
      cmd: command ? parseAdbSetting(command) : { ...DEFAULT_ADB_COMMAND, prefix: [] },
      deps: nodeExecDeps(),
      timeoutMs: 15_000
    }
    sessions.set(command, session)
    return session
  }

  /** 解析出真正可用的 adb 命令:设置里有就用设置的,否则探测一次并缓存 */
  async function resolveCommand(
    configured: string
  ): Promise<{ command: string; ok: boolean; version?: string; error?: string }> {
    const explicit = configured.trim()
    if (explicit) {
      const version = await adbVersion(sessionFor(explicit))
      return { command: explicit, ok: version.ok, version: version.stdout, error: version.error }
    }
    if (cachedCommand) {
      const version = await adbVersion(sessionFor(cachedCommand))
      if (version.ok) return { command: cachedCommand, ok: true, version: version.stdout }
      cachedCommand = null
    }
    let lastError = ''
    for (const candidate of candidates()) {
      const version = await adbVersion(sessionFor(candidate))
      if (version.ok) {
        cachedCommand = candidate
        return { command: candidate, ok: true, version: version.stdout }
      }
      lastError = version.error ?? lastError
    }
    return {
      command: candidates()[0],
      ok: false,
      error: lastError || '找不到 adb(在「设备检查」面板里填写,如 `wsl adb`)'
    }
  }

  /**
   * 转发池必须与「当前解析出来的 adb 命令」绑定:命令从 `adb` 变成 `wsl adb` 时,
   * 旧池里的 `adb forward` 与端口都可能是另一个 adb server 的。
   */
  function poolFor(context: PluginContext, command: string): ForwardPool {
    if (pool && poolCommand === command) return pool
    pool = new ForwardPool({
      adb: sessionFor(command),
      readForwards: () => store?.get().forwards ?? [],
      writeForwards: (records) => {
        store?.set({ forwards: records })
      },
      log: (...args) => context.log(...args)
    })
    poolCommand = command
    return pool
  }

  /** 跑一次完整发现;所有 IPC / MCP 入口都经过它,保证「看到的」与「点开的」是同一份数据 */
  async function snapshot(context: PluginContext): Promise<InspectSnapshot> {
    const state = store!.get()
    const strategy: FrontendStrategy = normalizeStrategy(state.strategy)
    const resolved = await resolveCommand(state.adbCommand ?? '')
    if (!resolved.ok) {
      const hint = problemHint('no-adb', { detail: resolved.error })
      return {
        ok: false,
        adb: { command: resolved.command, configured: Boolean(state.adbCommand?.trim()), ok: false, error: resolved.error },
        strategy,
        devices: [],
        notices: [{ problem: 'no-adb', scope: 'adb', ...hint, fatal: true }],
        forwards: [],
        targetCount: 0,
        error: resolved.error
      }
    }

    const session = sessionFor(resolved.command)
    const activePool = poolFor(context, resolved.command)
    const report: DiscoverReport = await discover(
      {
        adb: session,
        http: http!,
        pool: activePool,
        log: (...args) => context.log(...args),
        version: async () => ({ ok: true, version: resolved.version }),
        listDevices: () => listDevices(session),
        listSockets: (serial: string) => listSockets(session, serial)
      },
      { strategy }
    )

    const notices = noticesOf(report, { wsl: isWslAdb(resolved.command) })
    const targetCount = targetsOfDevices(report.devices).length
    return {
      ok: targetCount > 0,
      adb: { command: resolved.command, configured: Boolean(state.adbCommand?.trim()), ok: true, version: resolved.version },
      strategy,
      devices: report.devices,
      notices,
      forwards: activePool.snapshot(),
      targetCount,
      ...(targetCount === 0 && notices.length > 0 ? { error: notices[0].title } : {})
    }
  }

  /** 把报告里的问题摊平成给用户/AI 看的指引(文案统一来自 shared.problemHint) */
  function noticesOf(report: DiscoverReport, ctx: { wsl: boolean } = { wsl: false }): InspectNotice[] {
    const out: InspectNotice[] = []
    const push = (problem: DiscoverProblem, scope: string, detail?: string, fatal = false): void => {
      if (out.some((n) => n.problem === problem && n.scope === scope)) return
      out.push({ problem, scope, ...problemHint(problem, { serial: scope, detail, wsl: ctx.wsl }), fatal })
    }
    if (report.problem) push(report.problem, '全局', report.detail, true)
    for (const device of report.devices) {
      if (device.problem) push(device.problem, device.device.serial, device.detail, true)
      for (const socket of device.sockets) {
        if (socket.problem) push(socket.problem, `${device.device.serial} · ${socket.socket.name}`, socket.detail)
      }
    }
    return out
  }

  /** 取目标:显式 targetKey 优先;只有一个目标时可以省略(不做隐式猜测) */
  async function pickTarget(
    context: PluginContext,
    targetKey: string | undefined
  ): Promise<{ ok: true; snapshot: InspectSnapshot; target: DeviceTarget } | { ok: false; error: string }> {
    const snap = await snapshot(context)
    const targets = targetsOfDevices(snap.devices)
    if (targets.length === 0) {
      return {
        ok: false,
        error: snap.error ? `${snap.error};${snap.notices[0]?.detail ?? ''}` : '没有可调试的目标'
      }
    }
    const target = targetKey
      ? targets.find((t) => t.key === targetKey)
      : targets.length === 1
        ? targets[0]
        : undefined
    if (!target) {
      return {
        ok: false,
        error: targetKey
          ? `目标不存在(页面可能已关闭或设备已断开):${targetKey}`
          : `当前有 ${targets.length} 个可调试目标,请显式指定 targetKey(先用 device_list_targets 查看)`
      }
    }
    return { ok: true, snapshot: snap, target }
  }

  async function openTarget(
    context: PluginContext,
    targetKey: string | undefined,
    activate: boolean
  ): Promise<
    | { ok: true; tabId: number; target: { title: string; url: string; type: string; package?: string } }
    | { ok: false; error: string }
  > {
    const picked = await pickTarget(context, targetKey)
    if (!picked.ok) return picked
    const { target } = picked
    const label = target.title || target.url || target.id
    const suffix = target.package ? ` — ${target.package}` : ''
    // 用**目标自己算好的前端地址**:设备版本与 bow 自带前端不匹配时它是设备指定的那份
    // (见 shared.effectiveStrategy);不再把 ws 地址交给内核去拼,否则永远只能得到 bow 自带前端
    const tabId = context.pages.openDevToolsTab(target.frontendUrl, `[检查] ${label}${suffix}`, activate)
    return {
      ok: true,
      tabId,
      target: { title: target.title, url: target.url, type: target.type, package: target.package }
    }
  }

  /**
   * MCP 的 CDP 工具统一入口:连一下、发命令、无论如何都断开(避免把一个 CDP 连接挂在设备上)。
   * `run` 的第二个参数是**实际选中的目标** —— 返回体里带上 `targetKey` 让 AI 在后续调用里显式寻址
   * (省略 targetKey 只在「恰好一个目标」时生效,目标一变就得重新指定)。
   */
  async function withCdp<T>(
    context: PluginContext,
    targetKey: string | undefined,
    run: (client: Awaited<ReturnType<typeof connectCdp>>, target: DeviceTarget) => Promise<T>
  ): Promise<{ ok: true; value: T; target: DeviceTarget } | { ok: false; error: string }> {
    const picked = await pickTarget(context, targetKey)
    if (!picked.ok) return picked
    const { target } = picked
    let client: Awaited<ReturnType<typeof connectCdp>>
    try {
      client = await connectCdp(target.wsUrl)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    try {
      return { ok: true, value: await run(client, target), target }
    } finally {
      client.close()
    }
  }

  /** MCP 参数里的 targetKey(unknown → string | undefined);空串与缺省等价 */
  const targetKeyOf = (args: Record<string, unknown>): string | undefined =>
    typeof args.targetKey === 'string' && args.targetKey.trim() ? args.targetKey.trim() : undefined

  const plugin: PluginMain = {
    manifest: {
      id: 'device-inspect',
      name: '设备检查(手机)',
      description:
        '用 adb 发现手机上的可调试 WebView / Chrome,在标签页里打开 DevTools;并提供 AI 可用的 device_* 工具(列目标 / 截图 / 评估,以及快照、点击、输入、按键、滚动、日志观测)',
      version: '1.0.0'
    },
    capabilities: ['ui', 'mcp'],

    activate(context: PluginContext): void {
      store = context.storage<InspectState>({ file: 'device-inspect.json', defaults: DEFAULT_STATE })
      http = nodeHttpDeps({ getStatus: (url, timeoutMs) => electronFrontendStatus(url, timeoutMs) })

      // v1 → v2:前端来源多了一个 `auto`。v1 里只有两个值,'electron-bundled' 就是当时的**默认值**
      // (那时无法区分「用户显式选的」与「没动过」),所以迁到 auto 才能把老设备的修复真正打开;
      // 显式选过 device-bundled 的保持「设备指定」(v2 里它改名叫 device-suggested)。
      const persisted = store.get()
      const migrated = normalizeStrategy(persisted.strategy)
      if ((persisted.version ?? 1) < STATE_VERSION) {
        store.set({ version: STATE_VERSION, strategy: migrated === 'electron-bundled' ? 'auto' : migrated })
        context.log('device-inspect 状态升级到 v' + STATE_VERSION, '前端来源=', store.get().strategy)
      } else if (migrated !== persisted.strategy) {
        store.set({ strategy: migrated }) // 只是旧名字(device-bundled)
      }

      // 上次运行(可能是被强杀)留下的转发在这里回收;不阻塞激活,失败只记日志
      void (async () => {
        try {
          const state = store!.get()
          if ((state.forwards ?? []).length === 0) return
          const resolved = await resolveCommand(state.adbCommand ?? '')
          if (!resolved.ok) return
          await poolFor(context, resolved.command).cleanupPersisted()
        } catch (error) {
          context.log('清理遗留转发失败', String(error))
        }
      })()

      // ---------- IPC 面(渲染层:window.browserAPI.plugins.invoke) ----------
      context.ipc.handle('list', () => snapshot(context))
      context.ipc.handle('open', (input: { targetKey?: string; activate?: boolean } = {}) =>
        openTarget(context, input.targetKey, input.activate !== false)
      )
      context.ipc.handle('getSettings', () => {
        const state = store!.get()
        return { adbCommand: state.adbCommand, strategy: normalizeStrategy(state.strategy) }
      })
      context.ipc.handle('setSettings', async (patch: { adbCommand?: string; strategy?: FrontendStrategy }) => {
        const next = store!.set({
          ...(typeof patch.adbCommand === 'string' ? { adbCommand: patch.adbCommand } : {}),
          ...(patch.strategy ? { strategy: normalizeStrategy(patch.strategy) } : {})
        })
        // 换 adb 或换前端策略后:已建立的转发与探测结果都不再可信,全部作废
        const previous = pool
        pool = null
        poolCommand = null
        cachedCommand = null
        sessions.clear()
        await previous?.releaseAll()
        context.ipc.emit('changed')
        return { adbCommand: next.adbCommand, strategy: normalizeStrategy(next.strategy) }
      })
      context.ipc.handle('checkAdb', async (command?: string) => {
        const target = String(command ?? store!.get().adbCommand ?? '').trim()
        const resolved = await resolveCommand(target)
        return {
          ok: resolved.ok,
          command: resolved.command,
          version: resolved.version?.split(/\r?\n/)[0],
          error: resolved.error
        }
      })
      context.ipc.handle('connect', async (address: string) => {
        const resolved = await resolveCommand(store!.get().adbCommand ?? '')
        if (!resolved.ok) return { ok: false, error: resolved.error ?? 'adb 不可用' }
        const result = await connectDevice(sessionFor(resolved.command), String(address ?? '').trim())
        return { ok: result.ok, message: result.stdout, error: result.error }
      })
      context.ipc.handle('pair', async (input: { address?: string; code?: string } = {}) => {
        const resolved = await resolveCommand(store!.get().adbCommand ?? '')
        if (!resolved.ok) return { ok: false, error: resolved.error ?? 'adb 不可用' }
        const result = await pairDevice(
          sessionFor(resolved.command),
          String(input.address ?? '').trim(),
          String(input.code ?? '').trim()
        )
        return { ok: result.ok, message: result.stdout, error: result.error }
      })
      context.ipc.handle('cleanupForwards', async () => {
        await pool?.releaseAll()
        context.ipc.emit('changed')
        return { ok: true }
      })
      context.ipc.handle('rawAdb', async (args: string[]) => {
        const resolved = await resolveCommand(store!.get().adbCommand ?? '')
        if (!resolved.ok) return { ok: false, error: resolved.error ?? 'adb 不可用', output: '' }
        const result = await rawAdb(sessionFor(resolved.command), Array.isArray(args) ? args.map(String) : [])
        return { ok: result.ok, output: result.stdout, error: result.error }
      })

      // ---------- MCP 工具 ----------
      context.mcp.tool(
        'device_list_targets',
        {
          description:
            '列出通过 adb 连接的可调试手机目标(Android 应用里的 WebView / Chrome 标签页)。返回设备、套接字(含所属 App 包名)与每个可调试页面的 targetKey —— 其它 device_* 工具都用 targetKey 寻址',
          inputSchema: { serial: z.string().optional().describe('只看某台设备(串号),缺省为全部设备') }
        },
        async (args) => {
          const snap = await snapshot(context)
          const serial = typeof args.serial === 'string' && args.serial ? args.serial : undefined
          const devices = serial ? snap.devices.filter((d) => d.device.serial === serial) : snap.devices
          return textContent({
            ok: snap.ok,
            adb: snap.adb,
            devices: devices.map((device) => ({
              serial: device.device.serial,
              state: device.device.state,
              model: device.device.model,
              problem: device.problem,
              sockets: device.sockets.map((socket) => ({
                name: socket.socket.name,
                label: socketLabel(socket.socket, socket.package),
                port: socket.port,
                package: socket.package,
                browser: socket.browser,
                // 实际生效的前端来源(设置选 auto 时可能与设置值不同),AI 据此判断面板空白的版本原因
                frontendStrategy: socket.frontendStrategy,
                problem: socket.problem,
                targets: socket.targets.map((target) => ({
                  targetKey: target.key,
                  type: target.type,
                  title: target.title,
                  url: target.url
                }))
              }))
            })),
            notices: snap.notices.map((n) => ({ scope: n.scope, title: n.title, detail: n.detail })),
            ...(snap.ok ? {} : { error: snap.error ?? '没有可调试的目标' })
          })
        }
      )

      context.mcp.tool(
        'device_inspect',
        {
          description: '在 bow 的标签页里打开某个手机目标的 DevTools 前端(等同于 chrome://inspect 的 inspect 按钮)',
          inputSchema: {
            targetKey: z.string().describe('目标标识,由 device_list_targets 返回'),
            activate: z.boolean().optional().describe('是否切到该标签页,默认 true')
          }
        },
        async (args) => {
          const result = await openTarget(context, String(args.targetKey ?? ''), args.activate !== false)
          return textContent(
            result.ok ? { ok: true, tabId: result.tabId, target: result.target } : { ok: false, error: result.error }
          )
        }
      )

      context.mcp.tool(
        'device_eval',
        {
          description:
            '在手机页面的上下文里执行 JavaScript(Runtime.evaluate)。作用对象是**手机上的页面**,与 browser_eval(作用于 bow 自己的标签页)是两回事',
          inputSchema: {
            code: z.string().describe('要执行的 JavaScript 表达式/语句,返回最后一个表达式的值'),
            targetKey: z.string().optional().describe('目标标识;只有一个目标时可省略')
          }
        },
        async (args) => {
          const code = String(args.code ?? '')
          if (!code.trim()) return textContent({ ok: false, error: 'code 不能为空' })
          const result = await withCdp(context, targetKeyOf(args), (client) => cdpEvaluate(client, code))
          if (!result.ok) return textContent({ ok: false, error: result.error })
          return textContent(
            result.value.ok ? { ok: true, result: result.value.result ?? null } : { ok: false, error: result.value.error }
          )
        }
      )

      context.mcp.tool(
        'device_screenshot',
        {
          description:
            '截取手机页面(Page.captureScreenshot),以 PNG 图片内容返回。注意截的是**手机上的页面**,不是 bow 的标签页',
          inputSchema: {
            targetKey: z.string().optional().describe('目标标识;只有一个目标时可省略'),
            fullPage: z.boolean().optional().describe('是否截整页(含滚动到视口外的内容),默认只截视口')
          }
        },
        async (args) => {
          const result = await withCdp(context, targetKeyOf(args), (client) => cdpScreenshot(client, { fullPage: args.fullPage === true }))
          if (!result.ok) return textContent({ ok: false, error: result.error })
          if (!result.value.ok) return textContent({ ok: false, error: result.value.error })
          return imageContent(result.value.data)
        }
      )

      // ---------- 操作 + 观测(真输入事件 / 元素快照 / 日志) ----------
      // 这一组的定位:让 AI 能**像人一样**操作手机页面(isTrusted 的 touch/key/输入),
      // 而不是只能 device_eval 里 document.querySelector().click()(合成事件、拿不到焦点链路)。
      // 分工:注入脚本只负责量坐标/摆焦点,真事件一律走 CDP Input.*(见 cdp.ts 顶部注释)。

      context.mcp.tool(
        'device_snapshot',
        {
          description:
            '拿手机页面的可操作元素快照(与 browser_snapshot 同一份脚本、同一种返回形状)。返回的 selector 可以直接喂给 device_tap / device_type —— 不要自己猜 CSS 选择器,也不要用 device_eval 反复手写查询',
          inputSchema: {
            targetKey: z.string().optional().describe('目标标识;只有一个目标时可省略'),
            maxElements: z.number().int().positive().max(1000).optional().describe('最多返回元素数,默认 200')
          }
        },
        async (args) => {
          const result = await withCdp(context, targetKeyOf(args), (client) =>
            cdpSnapshot(client, typeof args.maxElements === 'number' ? args.maxElements : 200)
          )
          if (!result.ok) return textContent({ ok: false, error: result.error })
          if (!result.value.ok) return textContent({ ok: false, error: result.value.error })
          return textContent({ ok: true, targetKey: result.target.key, data: result.value.data })
        }
      )

      context.mcp.tool(
        'device_tap',
        {
          description:
            '在手机页面上点一下(默认发真实触摸事件 Input.dispatchTouchEvent,与 chrome://inspect 的 screencast 同款)。至少要给 selector 或 x/y 之一。作用对象是**手机上的页面**,不是 bow 的标签页',
          inputSchema: {
            targetKey: z.string().optional().describe('目标标识;只有一个目标时可省略'),
            selector: z.string().optional().describe('CSS 选择器(优先用 device_snapshot 返回的那个)'),
            x: z.number().optional().describe('视口 CSS 像素;与 y 同时给,和 selector 二选一'),
            y: z.number().optional().describe('视口 CSS 像素;与 x 同时给'),
            mode: z
              .enum(['touch', 'mouse'])
              .optional()
              .describe('输入事件的起点:默认 touch(手机真实路径);touch 不可用时自动降级为 mouse —— 以返回的 mode 为准')
          }
        },
        async (args) => {
          const selector =
            typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : undefined
          const x = typeof args.x === 'number' ? args.x : undefined
          const y = typeof args.y === 'number' ? args.y : undefined
          const mode = args.mode === 'mouse' ? 'mouse' : 'touch'
          const result = await withCdp(context, targetKeyOf(args), (client) =>
            cdpTap(client, { selector, x, y, mode })
          )
          if (!result.ok) return textContent({ ok: false, error: result.error })
          if (!result.value.ok) return textContent({ ok: false, error: result.value.error })
          return textContent({
            ok: true,
            targetKey: result.target.key,
            mode: result.value.mode,
            x: result.value.x,
            y: result.value.y,
            ...(selector ? { selector } : {})
          })
        }
      )

      context.mcp.tool(
        'device_type',
        {
          description:
            '往手机页面的输入框里输文字(聚焦 + 可选全选,再 Input.insertText 走 IME 路径 —— 受控输入框的 onChange / beforeinput 都会收到真事件)。省略 selector 则输入到当前聚焦元素;传空 text 即「清空当前选区」(个别 WebView 上偶有差异,必要时用 device_eval 兜底)',
          inputSchema: {
            targetKey: z.string().optional().describe('目标标识;只有一个目标时可省略'),
            selector: z.string().optional().describe('CSS 选择器(优先用 device_snapshot 返回的那个);省略则用当前聚焦元素'),
            text: z.string().describe('要输入的文字'),
            clear: z.boolean().optional().describe('输入前是否全选替换原内容,默认 true;false = 插入到光标处')
          }
        },
        async (args) => {
          const text = String(args.text ?? '')
          const selector =
            typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : undefined
          const result = await withCdp(context, targetKeyOf(args), (client) =>
            cdpType(client, { selector, text, clear: args.clear !== false })
          )
          if (!result.ok) return textContent({ ok: false, error: result.error })
          if (!result.value.ok) return textContent({ ok: false, error: result.value.error })
          return textContent({
            ok: true,
            targetKey: result.target.key,
            typed: text,
            value: result.value.value
          })
        }
      )

      context.mcp.tool(
        'device_press_key',
        {
          description:
            '在手机页面上按一个功能键(Enter / Tab / Escape / Backspace / Delete / 四个方向键 / Home / End / PageUp / PageDown) —— 输入文字请用 device_type,这里不接受单个字符',
          inputSchema: {
            targetKey: z.string().optional().describe('目标标识;只有一个目标时可省略'),
            key: z.string().describe('按键名,如 Enter / ArrowDown / Esc;大小写不敏感')
          }
        },
        async (args) => {
          const key = String(args.key ?? '')
          const result = await withCdp(context, targetKeyOf(args), (client) => cdpPressKey(client, key))
          if (!result.ok) return textContent({ ok: false, error: result.error })
          if (!result.value.ok) return textContent({ ok: false, error: result.value.error })
          return textContent({
            ok: true,
            targetKey: result.target.key,
            pressed: result.value.key.input,
            keyCode: result.value.key.keyCode
          })
        }
      )

      context.mcp.tool(
        'device_scroll',
        {
          description:
            '滚动手机页面或页面内的某个可滚动容器(与 browser_scroll 同一套语义)。注意:这是脚本滚动(改 scrollTop),不是触摸手势 —— 自定义手势滚动条目前不在工具面里',
          inputSchema: {
            targetKey: z.string().optional().describe('目标标识;只有一个目标时可省略'),
            selector: z.string().optional().describe('要滚动的元素;省略则滚页面本身'),
            direction: z.enum(['up', 'down', 'top', 'bottom']).describe('滚动方向'),
            amount: z.number().positive().optional().describe('滚动像素;缺省滚动约一屏的 70%')
          }
        },
        async (args) => {
          const direction = String(args.direction ?? '')
          const result = await withCdp(context, targetKeyOf(args), (client) =>
            cdpScroll(client, {
              ...(typeof args.selector === 'string' && args.selector.trim() ? { selector: args.selector.trim() } : {}),
              direction,
              ...(typeof args.amount === 'number' ? { amount: args.amount } : {})
            })
          )
          if (!result.ok) return textContent({ ok: false, error: result.error })
          if (!result.value.ok) return textContent({ ok: false, error: result.value.error })
          return textContent({
            ok: true,
            targetKey: result.target.key,
            direction,
            top: result.value.top
          })
        }
      )

      context.mcp.tool(
        'device_console',
        {
          description:
            '采集手机页面在**接下来这段时间**里的控制台输出、未捕获异常与浏览器日志(Runtime.enable + Log.enable)。⚠️ 只能看到调用期间产生的新日志:要看页面加载期的日志请传 reload: true(会重载页面)',
          inputSchema: {
            targetKey: z.string().optional().describe('目标标识;只有一个目标时可省略'),
            durationMs: z.number().int().positive().max(10000).optional().describe('采集窗口毫秒数,默认 800'),
            reload: z.boolean().optional().describe('是否先重载页面以捕获加载期日志(会丢当前页面状态),默认 false'),
            maxEntries: z.number().int().positive().max(500).optional().describe('最多返回多少条,默认 100')
          }
        },
        async (args) => {
          const result = await withCdp(context, targetKeyOf(args), (client) =>
            cdpConsole(client, {
              ...(typeof args.durationMs === 'number' ? { durationMs: args.durationMs } : {}),
              reload: args.reload === true,
              ...(typeof args.maxEntries === 'number' ? { maxEntries: args.maxEntries } : {})
            })
          )
          if (!result.ok) return textContent({ ok: false, error: result.error })
          if (!result.value.ok) return textContent({ ok: false, error: result.value.error })
          return textContent({
            ok: true,
            targetKey: result.target.key,
            durationMs: result.value.durationMs,
            total: result.value.total,
            truncated: result.value.truncated,
            entries: result.value.entries
          })
        }
      )

      context.mcp.tool(
        'device_connect',
        {
          description:
            '连接一个已开启无线调试的 Android 设备(等价于 adb connect <address>)。首次配对要在手机上打开「无线调试 → 使用配对码配对设备」,用 bow 的「设备检查」面板填配对码',
          inputSchema: {
            address: z.string().describe('手机地址,形如 192.168.1.5:5555(无线调试界面会显示 IP 与端口)')
          }
        },
        async (args) => {
          const resolved = await resolveCommand(store!.get().adbCommand ?? '')
          if (!resolved.ok) return textContent({ ok: false, error: resolved.error ?? 'adb 不可用' })
          const result = await connectDevice(sessionFor(resolved.command), String(args.address ?? '').trim())
          return textContent({ ok: result.ok, message: result.stdout, ...(result.ok ? {} : { error: result.error }) })
        }
      )

      // 退出时回收转发:adb forward 登记在 adb server 进程里,不回收会一直占着端口
      onBeforeQuit = (): void => {
        void pool?.releaseAll()
      }
      app.on('before-quit', onBeforeQuit)
      context.log('设备检查已就绪', `平台=${process.platform}`, 'adb 设置=', store.get().adbCommand || '(自动探测)')
    },

    async deactivate(): Promise<void> {
      if (onBeforeQuit) {
        app.removeListener('before-quit', onBeforeQuit)
        onBeforeQuit = null
      }
      await pool?.releaseAll()
      pool = null
      poolCommand = null
      http = null
      store = null
      cachedCommand = null
      sessions.clear()
    }
  }

  return plugin
}

export default createDeviceInspectPlugin()
