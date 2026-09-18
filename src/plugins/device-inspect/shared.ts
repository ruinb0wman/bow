import { devtoolsFrontendUrl, wsParamOf } from '@shared/devtools'

/**
 * 设备检查(手机 WebView / Chrome)的纯逻辑:adb 输出解析、目标列表改写、DevTools 前端 URL 构造。
 *
 * 为什么全部是纯函数(不 import electron / node:child_process / node:fs):
 * 真机只有一台,而解析规则必须被钉死 —— `adb devices -l` 的字段、`/proc/net/unix` 的列宽、
 * `/json` 的字段名都是**外部格式**,它们变化时我们要靠单测立刻发现。与 default-browser 插件
 * 把 Windows 注册表逻辑拆成纯逻辑(`windowsRegistry.ts`)是同一个理由。
 *
 * 术语(下面所有代码都按这套词):
 * - **套接字(socket)**:手机上的抽象 unix socket,如 `@webview_devtools_remote_12345`(某个 App 的
 *   WebView 进程)或 `@chrome_devtools_remote`(Chrome 浏览器)。每个套接字要占一个 `adb forward`
 *   的本地 TCP 端口,是「一个可调试的浏览器实例」的粒度。
 * - **目标(target)**:某个套接字 `/json` 里的一条可调试项(page / webview / iframe / worker…)。
 *   同一个套接字下通常有多个目标(多个标签页 / 多个 WebView)。
 * - **targetKey**:`<serial>|<socket>|<targetId>` —— 跨设备唯一的稳定标识,UI 与 MCP 工具都用它寻址。
 */

// ---------------------------------------------------------------- 类型

export type DeviceState = 'device' | 'unauthorized' | 'offline' | 'unknown'

export interface AdbDevice {
  serial: string
  state: DeviceState
  /** `model:SM_G973F` 里的型号(展示用) */
  model?: string
  product?: string
  transportId?: string
}

export type SocketKind = 'webview' | 'chrome' | 'other'

export interface DevtoolsSocket {
  /** 去掉 `@` 前缀的抽象套接字名,直接用于 `adb forward … localabstract:<name>` */
  name: string
  kind: SocketKind
  /** WebView 套接字名里带的 pid(`webview_devtools_remote_<pid>`) */
  pid?: number
}

export type FrontendStrategy =
  /** bow 自带的 DevTools 前端(`devtools://devtools/bundled/devtools_app.html`)—— 首选 */
  | 'electron-bundled'
  /** 设备自己打包的前端(`http://127.0.0.1:<转发端口>/devtools/inspector.html`)—— 同源豁免,见计划 §1.3 */
  | 'device-bundled'

/** 一条 /json 原始目标(只声明我们真正读的字段,其余字段原样保留) */
export interface RawTarget {
  id?: string
  title?: string
  url?: string
  type?: string
  description?: string
  faviconUrl?: string
  webSocketDebuggerUrl?: string
  devtoolsFrontendUrl?: string
  [key: string]: unknown
}

export interface DeviceTarget {
  /** `<serial>|<socket>|<id>` */
  key: string
  id: string
  serial: string
  socket: string
  type: string
  title: string
  url: string
  /** 已改写成 bow 本地转发端口的 ws 地址 */
  wsUrl: string
  /** 按当前策略算出的 DevTools 前端地址(可直接打开) */
  frontendUrl: string
  /** 该套接字所属 App 包名(来自 /json/version 的 Android-Package) */
  package?: string
}

export interface ForwardRecord {
  serial: string
  socket: string
  /** `adb forward` 的本地端口。**对外暴露的不是它**:前端与 CDP 客户端连的是同一个套接字的中继端口(见 relay.ts) */
  forwardPort: number
}

// ---------------------------------------------------------------- 报告模型
//
// 这几个结构放在纯逻辑模块里(而不是 targets.ts):渲染层的 Vue 组件也要用它们,
// 而 targets.ts 经 adb.ts 依赖 node:child_process —— 渲染层 bundle 不能碰。

export interface SocketReport {
  socket: DevtoolsSocket
  port?: number
  /** 套接字所属 App 包名(来自 /json/version 的 Android-Package) */
  package?: string
  /** 设备侧浏览器版本串(`Chrome/120.0.6099.43`) */
  browser?: string
  targets: DeviceTarget[]
  problem?: DiscoverProblem
  detail?: string
}

export interface DeviceReport {
  device: AdbDevice
  sockets: SocketReport[]
  /** 设备级问题(未授权 / 离线 / 没有可调试套接字) */
  problem?: DiscoverProblem
  detail?: string
}

export interface DiscoverReport {
  adb: { ok: boolean; version?: string; error?: string }
  devices: DeviceReport[]
  /** 整体性问题(没有 adb / 没有设备);`devices` 非空时为 undefined */
  problem?: DiscoverProblem
  detail?: string
}

/** 给 UI / AI 看的指引(normalize 自 problemHint,文案只写一份) */
export interface InspectNotice {
  problem: DiscoverProblem
  scope: string
  title: string
  detail: string
  /** 致命 = 当前没有任何可用目标;UI 据此决定强调程度 */
  fatal: boolean
}

/** 设备检查面板一次刷新的全部数据(IPC `list` 与 MCP device_list_targets 共用) */
export interface InspectSnapshot {
  ok: boolean
  adb: { command: string; configured: boolean; ok: boolean; version?: string; error?: string }
  strategy: FrontendStrategy
  devices: DeviceReport[]
  notices: InspectNotice[]
  forwards: ForwardRecord[]
  targetCount: number
  error?: string
}

// ---------------------------------------------------------------- adb 命令行

export interface AdbCommand {
  /** 可执行文件(Windows 上可能是 `wsl.exe`) */
  file: string
  /** 前缀参数:整条命令 = `file prefix… args…`,例如 `wsl.exe adb devices -l` 的 prefix = `['adb']` */
  prefix: string[]
}

export const DEFAULT_ADB_COMMAND: AdbCommand = { file: 'adb', prefix: [] }

/**
 * 极简命令行切词:空白分隔 + 双引号包裹。
 * 需要它是因为 adb 的「路径」可能是复合命令:`wsl adb`、`wsl -d Ubuntu-24.04 adb`、
 * `"C:\Program Files\platform-tools\adb.exe"`。不做转义序列(够用且好测)。
 */
export function splitTokens(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (const ch of text.trim()) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

/** 用户填的 adb 设置 → 可执行文件 + 前缀参数;空值回落 `adb` */
export function parseAdbSetting(setting: string | null | undefined): AdbCommand {
  const tokens = splitTokens(setting ?? '')
  if (tokens.length === 0) return { ...DEFAULT_ADB_COMMAND, prefix: [] }
  return { file: tokens[0], prefix: tokens.slice(1) }
}

/** 拼出完整参数表(执行端只做 `spawn(cmd.file, argv)`) */
export function adbArgv(cmd: AdbCommand, args: string[]): string[] {
  return [...cmd.prefix, ...args]
}

export const adbVersionArgv = (cmd: AdbCommand): string[] => adbArgv(cmd, ['version'])
export const adbDevicesArgv = (cmd: AdbCommand): string[] => adbArgv(cmd, ['devices', '-l'])
export const adbForwardListArgv = (cmd: AdbCommand): string[] => adbArgv(cmd, ['forward', '--list'])
export const adbConnectArgv = (cmd: AdbCommand, address: string): string[] =>
  adbArgv(cmd, ['connect', address])
export const adbPairArgv = (cmd: AdbCommand, address: string, code: string): string[] =>
  adbArgv(cmd, ['pair', address, code])

/** `cat /proc/net/unix` 是唯一稳定的套接字枚举办法(Android 全版本可用,不需要 root) */
export const adbSocketsArgv = (cmd: AdbCommand, serial: string): string[] =>
  adbArgv(cmd, ['-s', serial, 'shell', 'cat /proc/net/unix'])

export const adbForwardAddArgv = (
  cmd: AdbCommand,
  serial: string,
  port: number,
  socket: string
): string[] => adbArgv(cmd, ['-s', serial, 'forward', `tcp:${port}`, `localabstract:${socket}`])

export const adbForwardRemoveArgv = (cmd: AdbCommand, serial: string, port: number): string[] =>
  adbArgv(cmd, ['-s', serial, 'forward', '--remove', `tcp:${port}`])

// ---------------------------------------------------------------- adb 输出解析

const DEVICE_STATES: Record<string, DeviceState> = {
  device: 'device',
  unauthorized: 'unauthorized',
  offline: 'offline'
}

/**
 * 解析 `adb devices -l`:
 *
 * ```
 * List of devices attached
 * R58M12ABCDE   device product:beyond1ltexx model:SM_G973F device:beyond1 transport_id:3
 * 192.168.1.5:5555 device product:x model:y device:z transport_id:4
 * ABC123        unauthorized transport_id:5
 * ```
 *
 * 容忍:`* daemon started successfully *` 之类的提示行、末尾空行、未知状态、字段缺失。
 */
export function parseDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = []
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    if (text.startsWith('*') || text.startsWith('List of devices')) continue
    if (text.startsWith('adb server')) continue
    const parts = text.split(/\s+/)
    if (parts.length < 2) continue
    const [serial, rawState, ...rest] = parts
    // 串号形态两种都合法:USB(`R58M12ABCDE`)与网络(`192.168.1.5:5555`),不做额外校验
    const fields = new Map<string, string>()
    for (const item of rest) {
      const idx = item.indexOf(':')
      if (idx <= 0) continue
      fields.set(item.slice(0, idx), item.slice(idx + 1))
    }
    devices.push({
      serial,
      state: DEVICE_STATES[rawState] ?? 'unknown',
      model: fields.get('model'),
      product: fields.get('product'),
      transportId: fields.get('transport_id')
    })
  }
  return devices
}

/** 抽象套接字名统一去掉前导 `@`(两类写法在不同 Android 版本上都出现过) */
export function normalizeSocketName(name: string): string {
  return name.replace(/^@/, '').trim()
}

/**
 * 文本排序用**码点**比较,不用 `localeCompare`:
 * 后者的结果取决于 ICU 与运行环境 locale —— 同一个列表在 Windows bow 与 Linux CI 上顺序会不一样,
 * 单测也就钉不住。列表顺序对用户没有语义,可预测比「符合语言学直觉」更重要。
 */
function byCodePoint(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * 解析 `/proc/net/unix` 并挑出 DevTools 套接字。
 *
 * 只认名字里带 `devtools_remote` 的抽象套接字;显式排除 `tethering`(它是 Chrome 用来接管
 * 已运行渲染进程的辅助套接字,`/json` 里没有可调试目标,转发了只会得到空列表)。
 */
export function parseSockets(output: string): DevtoolsSocket[] {
  const found = new Map<string, DevtoolsSocket>()
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('Num ')) continue
    if (!text.includes('devtools_remote')) continue
    const path = text.split(/\s+/).pop() ?? ''
    if (!path.includes('devtools_remote')) continue
    const name = normalizeSocketName(path)
    if (!name || name.includes('tethering')) continue
    if (found.has(name)) continue
    const webview = /^webview_devtools_remote_(\d+)$/.exec(name)
    if (webview) {
      found.set(name, { name, kind: 'webview', pid: Number(webview[1]) })
      continue
    }
    if (/^chrome_devtools_remote(_\d+)?$/.test(name)) {
      found.set(name, { name, kind: 'chrome' })
      continue
    }
    found.set(name, { name, kind: 'other' })
  }
  return [...found.values()].sort(
    (a, b) => byCodePoint(a.kind, b.kind) || (a.pid ?? 0) - (b.pid ?? 0) || byCodePoint(a.name, b.name)
  )
}

/**
 * 解析 `adb forward --list`(形如 `R58M12ABCDE tcp:9222 localabstract:webview_devtools_remote_1`)。
 * 用于清理上一次运行留下的转发 —— adb forward 登记在 **adb server 进程**里,bow 被强杀不会自动清。
 */
/**
 * 解析 `adb forward --list`(形如 `R58M12ABCDE tcp:9222 localabstract:webview_devtools_remote_1`)。
 *
 * ⚠️ 现在**没有调用方**:插件只回收自己 `device-inspect.json` 里记着的转发,不去动用户手建的
 * `adb forward tcp:9222 …`(那是 chrome://inspect 的常规用法,删了就是破坏别人的工作流)。
 * 保留解析函数是作为诊断手段与格式证据,用例见 `tests/deviceInspect.test.ts`。
 */
export interface AdbForwardEntry {
  serial: string
  localPort: number
  socket: string
}

export function parseForwardList(output: string): AdbForwardEntry[] {
  const out: AdbForwardEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    const parts = text.split(/\s+/)
    if (parts.length < 3) continue
    const [serial, local, remote] = parts
    const portMatch = /^tcp:(\d+)$/.exec(local)
    if (!portMatch) continue
    out.push({ serial, localPort: Number(portMatch[1]), socket: normalizeSocketName(remote.replace(/^localabstract:/, '')) })
  }
  return out
}

// ---------------------------------------------------------------- /json 改写

/** `ws://localhost:9222/devtools/page/X` → `/devtools/page/X`(拿不到就用 `/devtools/page/<id>`) */
export function wsPathOf(wsUrl: string, targetId: string): string {
  try {
    const parsed = new URL(wsUrl)
    if (parsed.pathname.startsWith('/devtools/')) return parsed.pathname
  } catch {
    /* 设备返回的不是合法 URL:退回按 id 拼 */
  }
  return `/devtools/page/${targetId}`
}

/** 设备侧地址(`ws://localhost:9222/devtools/page/X`)→ 本地转发地址 */
export function rewriteWsUrl(wsUrl: string, targetId: string, localPort: number): string {
  return `ws://127.0.0.1:${localPort}${wsPathOf(wsUrl, targetId)}`
}

/** 设备自带前端的相对入口(`chrome://inspect` 用的就是它;与策略名 `device-bundled` 对应) */
export const DEVICE_BUNDLED_FRONTEND_ENTRY = 'devtools/inspector.html'

/**
 * 目标 → 可直接打开的 DevTools 前端地址。
 *
 * 两种策略**都指向本机中继端口**(见 `relay.ts`):浏览器页面一定带 `Origin`,而设备的 Origin 校验
 * 只有中继能过。特别提醒:**别指望「同源豁免」** —— Android 的 devtools 服务在 unix 套接字上,
 * `server_ip_address_` 为 null,`is_same_origin` 恒为 false(实测结论见 relay.ts 顶部)。
 *
 * - `electron-bundled`:用 bow(Electron)自带的前端,不依赖设备提供前端资源(默认);
 * - `device-bundled`:从设备自己的 CDP 端点取前端(经同一个中继),前端版本与设备完全一致。
 */
export function frontendUrlFor(
  strategy: FrontendStrategy,
  args: { wsUrl: string; localPort: number }
): string {
  if (strategy === 'device-bundled') {
    return `http://127.0.0.1:${args.localPort}/${DEVICE_BUNDLED_FRONTEND_ENTRY}?ws=${wsParamOf(args.wsUrl)}`
  }
  return devtoolsFrontendUrl(args.wsUrl)
}

export interface TargetContext {
  serial: string
  socket: string
  localPort: number
  package?: string
  strategy: FrontendStrategy
}

export function targetKey(serial: string, socket: string, targetId: string): string {
  return `${serial}|${socket}|${targetId}`
}

export function splitTargetKey(key: string): { serial: string; socket: string; targetId: string } | null {
  const idx = key.indexOf('|')
  const last = key.lastIndexOf('|')
  if (idx <= 0 || last <= idx) return null
  return { serial: key.slice(0, idx), socket: key.slice(idx + 1, last), targetId: key.slice(last + 1) }
}

/**
 * `/json` 响应 → 我们自己的目标模型。
 *
 * 容错口径:`/json` 不是数组、缺 `id`、缺 ws 地址都跳过而不是抛错 —— 设备侧可能同时返回
 * `browser` / worker 之类的条目,一个坏条目不该毁掉整个列表。
 */
export function targetsFromJson(raw: unknown, ctx: TargetContext): DeviceTarget[] {
  if (!Array.isArray(raw)) return []
  const out: DeviceTarget[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const target = item as RawTarget
    const id = typeof target.id === 'string' && target.id ? target.id : ''
    if (!id) continue
    const rawWs = typeof target.webSocketDebuggerUrl === 'string' ? target.webSocketDebuggerUrl : ''
    const wsUrl = rewriteWsUrl(rawWs, id, ctx.localPort)
    out.push({
      key: targetKey(ctx.serial, ctx.socket, id),
      id,
      serial: ctx.serial,
      socket: ctx.socket,
      type: typeof target.type === 'string' && target.type ? target.type : 'page',
      title: typeof target.title === 'string' ? target.title : '',
      url: typeof target.url === 'string' ? target.url : '',
      wsUrl,
      frontendUrl: frontendUrlFor(ctx.strategy, { wsUrl, localPort: ctx.localPort }),
      package: ctx.package
    })
  }
  return sortTargets(out)
}

/** 交互型目标优先(page/webview/iframe),worker 类靠后 —— 与 chrome://inspect 的观感一致 */
const PRIMARY_TYPES = new Set(['page', 'webview', 'iframe'])

export function isPrimaryTarget(target: Pick<DeviceTarget, 'type'>): boolean {
  return PRIMARY_TYPES.has(target.type)
}

export function sortTargets(targets: DeviceTarget[]): DeviceTarget[] {
  return [...targets].sort((a, b) => {
    const primary = Number(isPrimaryTarget(b)) - Number(isPrimaryTarget(a))
    if (primary !== 0) return primary
    return byCodePoint(a.title || a.url, b.title || b.url)
  })
}

/** `/json/version` 里的浏览器版本串(`Chrome/120.0.6099.43` / `WebView/…`),用于展示与排查 */
export function browserNameFromVersion(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined
  const value = (json as { Browser?: unknown }).Browser
  return typeof value === 'string' && value ? value : undefined
}

/** `/json/version` 的 `Android-Package`(Chromium 在 Android 上才会带)→ 该套接字属于哪个 App */
export function androidPackageFromVersion(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined
  const value = (json as { 'Android-Package'?: unknown })['Android-Package']
  return typeof value === 'string' && value ? value : undefined
}

// ---------------------------------------------------------------- CDP 结果解析

export interface CdpEvalOutcome {
  ok: boolean
  /** `Runtime.evaluate` 的返回值(`undefined` 归一为 null,与核心工具 browser_eval 一致) */
  result?: unknown
  error?: string
}

/**
 * `Runtime.evaluate` 的响应 → 我们的结果模型。
 *
 * 两个真实存在的形状都要认:
 * - 正常:`{ result: { type: 'string'|'number'|…, value } }`,而 `type: 'undefined'` 时没有 `value`;
 * - 页面抛错:`{ result: {...}, exceptionDetails: { text, exception: { description } } }` ——
 *   这种情况 CDP **不报错**,脚本内部异常就藏在 exceptionDetails 里,把它当成功会直接误导 AI。
 */
export function readEvalOutcome(raw: unknown): CdpEvalOutcome {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'CDP 返回体不是对象' }
  const payload = raw as {
    result?: { type?: string; value?: unknown }
    exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } }
  }
  const exception = payload.exceptionDetails
  if (exception) {
    const detail =
      exception.exception?.description || exception.exception?.value || exception.text || '页面脚本抛错'
    return { ok: false, error: String(detail) }
  }
  const result = payload.result
  if (!result) return { ok: true, result: null }
  if (result.type === 'undefined') return { ok: true, result: null }
  return { ok: true, result: result.value ?? null }
}

/**
 * `Page.captureScreenshot` 的响应 → base64 PNG。
 * 拿不到 `data` 时返回 null,让调用方报「截图失败」而不是把空串当成图片送出去。
 */
export function readScreenshotData(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const data = (raw as { data?: unknown }).data
  return typeof data === 'string' && data ? data : null
}

// ---------------------------------------------------------------- 展示与提示

export const TARGET_TYPE_LABELS: Record<string, string> = {
  page: '页面',
  webview: 'WebView',
  iframe: '内嵌框架',
  worker: 'Worker',
  shared_worker: '共享 Worker',
  service_worker: 'Service Worker',
  browser: '浏览器',
  other: '其它'
}

export function targetTypeLabel(type: string): string {
  return TARGET_TYPE_LABELS[type] ?? type
}

/** 套接字行的人类可读标签:`com.tencent.mm · WebView #12345` */
export function socketLabel(socket: DevtoolsSocket, pkg?: string): string {
  const kind = socket.kind === 'chrome' ? 'Chrome' : socket.kind === 'webview' ? 'WebView' : 'DevTools'
  const pid = socket.pid != null ? ` #${socket.pid}` : ''
  return pkg ? `${pkg} · ${kind}${pid}` : `${kind}${pid}`
}

export type DiscoverProblem =
  | 'no-adb'
  | 'no-devices'
  | 'unauthorized'
  | 'offline'
  | 'no-sockets'
  | 'no-targets'
  | 'forward-failed'
  | 'port-unreachable'

export interface ProblemHint {
  title: string
  detail: string
}

/**
 * 失败态 → 可执行的下一步。
 * 写在这里而不是散在 Vue 里,是因为「看不到我的页面」的绝大多数原因就这几种,
 * 文案必须一致(否则用户与 AI 看到的是两套说法)。
 */
export function problemHint(problem: DiscoverProblem, ctx: { serial?: string; socket?: string; detail?: string } = {}): ProblemHint {
  const tail = ctx.detail ? `\n(${ctx.detail})` : ''
  switch (problem) {
    case 'no-adb':
      return {
        title: '找不到 adb',
        detail: `在设置里填写 adb 命令:Windows 侧没有 adb 时可填 \`wsl adb\`(本机就是这种)。${tail}`
      }
    case 'no-devices':
      return {
        title: '没有检测到设备',
        detail: `插上数据线并在手机上允许 USB 调试;或确认已执行 \`adb connect <手机IP:端口>\`。${tail}`
      }
    case 'unauthorized':
      return {
        title: `设备 ${ctx.serial ?? ''} 未授权`,
        detail: '解锁手机屏幕,在「允许 USB 调试吗?」弹窗里点允许(建议勾选「一律允许」)。'
      }
    case 'offline':
      return {
        title: `设备 ${ctx.serial ?? ''} 处于离线状态`,
        detail: `执行 \`adb reconnect ${ctx.serial ?? ''}\`,或重新插拔数据线。${tail}`
      }
    case 'no-sockets':
      return {
        title: '没有发现可调试的 WebView / Chrome',
        detail:
          '该应用没有开启 WebView 调试。让开发在 Application.onCreate 里调用 WebView.setWebContentsDebuggingEnabled(true)(debug 包默认开启,release 包必须显式调用);' +
          '如果是 Chrome,打开任意标签页即可出现。' +
          tail
      }
    case 'no-targets':
      return {
        title: '套接字存在但没有可调试页面',
        detail: `把应用切到前台并让 WebView 真正加载过页面后再刷新。${tail}`
      }
    case 'forward-failed':
      return {
        title: '端口转发失败',
        detail: `执行 \`adb forward --remove-all\` 清理一下(其它工具可能占了同名转发),再重试。${tail}`
      }
    case 'port-unreachable':
      return {
        title: '转发端口连不上',
        detail:
          '转发是在 WSL 里建的、而 bow 在 Windows 上跑,需要 WSL2 镜像网络(`.wslconfig` 的 `networkingMode=Mirrored`)两边才共享 127.0.0.1。' +
          tail
      }
  }
}
