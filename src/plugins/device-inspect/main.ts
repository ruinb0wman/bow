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
 * 2. **打开前端标签页由内核完成**(`ctx.pages.openDevToolsTab`):插件不自己拼 `devtools://` 地址 ——
 *    前端入口与 `ws=` 参数形态的唯一来源是 `@shared/devtools`。
 */

import { app } from 'electron'
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
import { connectCdp, cdpEvaluate, cdpScreenshot } from './cdp'
import {
  discover,
  nodeHttpDeps,
  ForwardPool,
  targetsOfDevices,
  type HttpDeps
} from './targets'
import {
  DEFAULT_ADB_COMMAND,
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
  /** DevTools 前端来源:bow 自带(Electron)/ 设备自带(同源豁免的兜底) */
  strategy: FrontendStrategy
  /** 上一次运行留下的转发,用于启动清理与端口复用 */
  forwards: ForwardRecord[]
}

const DEFAULT_STATE: InspectState = {
  version: 1,
  adbCommand: '',
  strategy: 'electron-bundled',
  forwards: []
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
    const strategy: FrontendStrategy = state.strategy ?? 'electron-bundled'
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

    const notices = noticesOf(report)
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
  function noticesOf(report: DiscoverReport): InspectNotice[] {
    const out: InspectNotice[] = []
    const push = (problem: DiscoverProblem, scope: string, detail?: string, fatal = false): void => {
      if (out.some((n) => n.problem === problem && n.scope === scope)) return
      out.push({ problem, scope, ...problemHint(problem, { serial: scope, detail }), fatal })
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
    const tabId = context.pages.openDevToolsTab(target.wsUrl, `[检查] ${label}${suffix}`, activate)
    return {
      ok: true,
      tabId,
      target: { title: target.title, url: target.url, type: target.type, package: target.package }
    }
  }

  /** MCP 的 CDP 工具统一入口:连一下、发命令、无论如何都断开(避免把一个 CDP 连接挂在设备上) */
  async function withCdp<T>(
    context: PluginContext,
    targetKey: string | undefined,
    run: (client: Awaited<ReturnType<typeof connectCdp>>) => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const picked = await pickTarget(context, targetKey)
    if (!picked.ok) return picked
    let client: Awaited<ReturnType<typeof connectCdp>>
    try {
      client = await connectCdp(picked.target.wsUrl)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    try {
      return { ok: true, value: await run(client) }
    } finally {
      client.close()
    }
  }

  const plugin: PluginMain = {
    manifest: {
      id: 'device-inspect',
      name: '设备检查(手机)',
      description: '用 adb 发现手机上的可调试 WebView / Chrome,在标签页里打开 DevTools;并提供 AI 可用的 device_* 工具',
      version: '1.0.0'
    },
    capabilities: ['ui', 'mcp'],

    activate(context: PluginContext): void {
      store = context.storage<InspectState>({ file: 'device-inspect.json', defaults: DEFAULT_STATE })
      http = nodeHttpDeps()

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
        return { adbCommand: state.adbCommand, strategy: state.strategy }
      })
      context.ipc.handle('setSettings', async (patch: { adbCommand?: string; strategy?: FrontendStrategy }) => {
        const next = store!.set({
          ...(typeof patch.adbCommand === 'string' ? { adbCommand: patch.adbCommand } : {}),
          ...(patch.strategy ? { strategy: patch.strategy } : {})
        })
        // 换 adb 或换前端策略后:已建立的转发与探测结果都不再可信,全部作废
        const previous = pool
        pool = null
        poolCommand = null
        cachedCommand = null
        sessions.clear()
        await previous?.releaseAll()
        context.ipc.emit('changed')
        return { adbCommand: next.adbCommand, strategy: next.strategy }
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
          const result = await withCdp(context, typeof args.targetKey === 'string' ? args.targetKey : undefined, (client) =>
            cdpEvaluate(client, code)
          )
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
          const result = await withCdp(context, typeof args.targetKey === 'string' ? args.targetKey : undefined, (client) =>
            cdpScreenshot(client, { fullPage: args.fullPage === true })
          )
          if (!result.ok) return textContent({ ok: false, error: result.error })
          if (!result.value.ok) return textContent({ ok: false, error: result.value.error })
          return imageContent(result.value.data)
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
