/**
 * 最小 CDP(Chrome DevTools Protocol)客户端:只做 bow 需要的那几件事 ——
 * `Runtime.evaluate`、`Page.captureScreenshot`,以及 MCP 操作工具用的 `Input.*` 与事件订阅。
 *
 * 分工:`cdpEvaluate` / `cdpSnapshot` / `cdpScroll` 是**脚本注入**(量坐标、取值、滚页面);
 * `cdpTap` / `cdpType` / `cdpPressKey` 是**真输入事件**(`Input.*`)—— 后者才有 `isTrusted: true`
 * 与完整的焦点链路,这也正是 chrome://inspect 的 screencast 的做法。
 *
 * ## 为什么不需要本地代理(实测结论,2026-09-18)
 *
 * Chromium 的 DevTools 端点会对**带 Origin 头**的 WebSocket 握手做白名单校验
 * (`devtools_http_handler.cc`:非 `devtools://devtools` 且不在 `--remote-allow-origins` 里就 403),
 * 而手机上加不了这个开关。于是「浏览器页面里的 devtools 前端」有被 403 的风险(见计划 §1.2)。
 *
 * 但 **Node 内置的 WebSocket(undici)握手根本不带 Origin 头** —— 实测抓到的 upgrade 请求只有
 * `host / connection / upgrade / sec-websocket-key / sec-websocket-version / sec-websocket-extensions /
 * accept / accept-language / sec-fetch-mode / user-agent / pragma / cache-control / accept-encoding`。
 * 判定分支是 `if (request.headers.count("origin") && …)`,没有 Origin 就**直接放行**。
 *
 * 所以 bow 主进程直连设备(经 adb 转发的端口)发 CDP 命令是可行的,不需要自己写 WS 代理;
 * 需要担心的只有前端页面那条路。复现方式:起一个 http server 抓 `upgrade` 事件的 headers,
 * 再用 `new WebSocket('ws://127.0.0.1:<port>/')` 连它。
 */

import type { PageSnapshot } from '@shared/types'
import {
  consoleEntryOf,
  exceptionEntryOf,
  logEntryOf,
  readEvalOutcome,
  readScreenshotData,
  resolveCdpKey,
  type CdpKeySpec,
  type ConsoleEntry
} from './shared'
import { SCROLL_FN, SNAPSHOT_FN } from '../../main/pageScripts'
import { FOCUS_FN, POINT_FN, READ_FOCUSED_FN } from './scripts'

export interface CdpClient {
  /** 发一条 CDP 命令;超时或对端断开都会 reject */
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  /**
   * 订阅事件通知(如 `Runtime.consoleAPICalled`);返回取消订阅。
   * ⚠️ **只在这个客户端建立之后**收到的事件会被派发 —— 想抓页面加载期的日志,要先订阅再 `Page.reload`
   * (见 `cdpConsole`),不能靠「连上就看历史」。
   */
  on(method: string, cb: (params: Record<string, unknown>) => void): () => void
  close(): void
}

const DEFAULT_TIMEOUT_MS = 15_000

/** 连接一个 `ws://…/devtools/page/<id>` 目标;失败(403/连不上/握手失败)直接抛出可读错误 */
export async function connectCdp(
  wsUrl: string,
  opts: { timeoutMs?: number } = {}
): Promise<CdpClient> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  const openTimer = setTimeout(() => {
    try {
      socket.close()
    } catch {
      /* 已经关了 */
    }
  }, timeoutMs)

  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        clearTimeout(openTimer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(openTimer)
        reject(new Error(`无法连接调试目标:${wsUrl}(可能被目标拒绝,或转发端口已失效)`))
      }
    })
  } catch (error) {
    clearTimeout(openTimer)
    throw error
  }

  const failAll = (reason: string): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
  }

  /** 事件订阅表:method → 回调集(每条 CDP 事件可能被多处订阅) */
  const listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()

  socket.onclose = () => failAll('调试连接已关闭')
  socket.onerror = () => failAll('调试连接出错')
  socket.onmessage = (event: MessageEvent) => {
    let message: {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { message?: string }
    }
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    // 没有 id = 事件通知(如 Runtime.consoleAPICalled / Inspector.detached):按 method 派发给订阅者
    if (typeof message.id !== 'number') {
      const method = typeof message.method === 'string' ? message.method : ''
      if (!method) return
      for (const cb of listeners.get(method) ?? []) {
        try {
          cb(message.params ?? {})
        } catch {
          /* 订阅者自己抛错不能拖垮整个客户端 */
        }
      }
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message ?? 'CDP 调用失败'))
    else entry.resolve(message.result)
  }

  return {
    send(method, params, callTimeoutMs = DEFAULT_TIMEOUT_MS) {
      const id = nextId++
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP ${method} 超时(${callTimeoutMs}ms)`))
        }, callTimeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          socket.send(JSON.stringify(params ? { id, method, params } : { id, method }))
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    on(method, cb) {
      const set = listeners.get(method) ?? new Set()
      set.add(cb)
      listeners.set(method, set)
      return () => {
        set.delete(cb)
        if (set.size === 0) listeners.delete(method)
      }
    },
    close() {
      failAll('调试连接已关闭')
      try {
        socket.close()
      } catch {
        /* 已经关了 */
      }
    }
  }
}

/** 在目标页面里执行 JS(等价于核心工具的 browser_eval,只是作用在手机上) */
export async function cdpEvaluate(
  client: CdpClient,
  code: string,
  timeoutMs?: number
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const raw = await client.send(
      'Runtime.evaluate',
      { expression: code, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs
    )
    return readEvalOutcome(raw)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 截图(base64 PNG);`fullPage` 用 captureBeyondViewport 拿滚动到视口外的部分 */
export async function cdpScreenshot(
  client: CdpClient,
  opts: { fullPage?: boolean; timeoutMs?: number } = {}
): Promise<{ ok: true; data: string } | { ok: false; error: string }> {
  try {
    const raw = await client.send(
      'Page.captureScreenshot',
      opts.fullPage ? { format: 'png', captureBeyondViewport: true } : { format: 'png' },
      opts.timeoutMs ?? 20_000
    )
    const data = readScreenshotData(raw)
    if (!data) return { ok: false, error: '目标没有返回截图数据' }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

// ---------------------------------------------------------------- MCP 操作(真输入事件 + 注入)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 发送成功返回 true(用于「不支持就算了」的命令,如 Log.enable / Page.enable) */
async function bestEffort(client: CdpClient, method: string, params?: Record<string, unknown>): Promise<boolean> {
  try {
    await client.send(method, params)
    return true
  } catch {
    return false
  }
}

/**
 * 把一个「函数声明字符串」当表达式执行:`(fn)(arg1, arg2)`。
 * 参数用 `JSON.stringify` 内联(与核心 `actions.ts` 的 `runInPage` 同一思路),避免引号注入。
 */
async function evalFunction(
  client: CdpClient,
  fnSource: string,
  args: unknown[],
  timeoutMs?: number
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const expression = `(${fnSource})(${args.map((a) => JSON.stringify(a)).join(', ')})`
  try {
    const raw = await client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs
    )
    return readEvalOutcome(raw)
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/** 注入脚本把失败放在 `result.error`(不抛出)⇒ 这里提升为顶层失败,与核心 `lift()` 同口径 */
function scriptError(result: unknown): string | null {
  const error = (result as { error?: unknown } | null)?.error
  return typeof error === 'string' && error ? error : null
}

/** 元素快照:与核心 `browser_snapshot` **同一份脚本**、同一种返回形状(`PageSnapshot`) */
export async function cdpSnapshot(
  client: CdpClient,
  maxElements = 200
): Promise<{ ok: true; data: PageSnapshot } | { ok: false; error: string }> {
  const outcome = await evalFunction(client, SNAPSHOT_FN, [maxElements])
  if (!outcome.ok) return { ok: false, error: outcome.error ?? '快照失败' }
  const data = outcome.result as PageSnapshot | null
  if (!data || !Array.isArray(data.elements)) return { ok: false, error: '页面没有返回元素列表' }
  return { ok: true, data }
}

export interface TapRequest {
  /** CSS 选择器(与 `x`/`y` 二选一) */
  selector?: string
  x?: number
  y?: number
  /** `touch`(默认,手机页面的真实路径)/ `mouse`(兼容模式) */
  mode?: 'touch' | 'mouse'
}

export type TapOutcome =
  | { ok: true; mode: 'touch' | 'mouse'; x: number; y: number }
  | { ok: false; error: string }

type PointOutcome = { ok: true; x: number; y: number } | { ok: false; error: string }

/** selector → 视口中心点;`x`/`y` 直接用(CSS 像素,不乘 dpr) */
export async function resolvePoint(client: CdpClient, request: TapRequest): Promise<PointOutcome> {
  const selector = typeof request.selector === 'string' ? request.selector.trim() : ''
  const hasPoint =
    typeof request.x === 'number' &&
    typeof request.y === 'number' &&
    Number.isFinite(request.x) &&
    Number.isFinite(request.y)
  if (selector && hasPoint) return { ok: false, error: 'selector 与 x/y 只能给一个' }
  if (!selector && !hasPoint) return { ok: false, error: '要给 selector,或同时给 x 与 y(视口 CSS 像素)' }
  if (hasPoint) return { ok: true, x: Math.round(request.x as number), y: Math.round(request.y as number) }
  const outcome = await evalFunction(client, POINT_FN, [selector])
  if (!outcome.ok) return { ok: false, error: outcome.error ?? '定位元素失败' }
  const found = scriptError(outcome.result)
  if (found) return { ok: false, error: found }
  const value = outcome.result as { x?: unknown; y?: unknown } | null
  if (!value || typeof value.x !== 'number' || typeof value.y !== 'number') {
    return { ok: false, error: '定位元素失败:页面没有返回坐标' }
  }
  return { ok: true, x: value.x, y: value.y }
}

/** 触摸点击:**同一组 touchPoints** 发 touchStart/touchEnd(chrome://inspect 的 screencast 同款) */
async function dispatchTouchTap(client: CdpClient, x: number, y: number): Promise<string | null> {
  const touchPoints = [{ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 }]
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints })
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

/** 鼠标点击(press + release 在同一点:Chromium 在 mouseup 时合成 click) */
async function dispatchMouseTap(client: CdpClient, x: number, y: number): Promise<string | null> {
  const base = { x, y, button: 'left', clickCount: 1 }
  try {
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

/**
 * 点击:默认发**触摸事件**(手机页面的真实路径);失败才开触摸模拟重试一次,仍失败退回鼠标。
 *
 * 顺序是刻意的:真机本来就支持触摸,先开 `Emulation.setTouchEmulationEnabled` 会把页面的
 * `maxTouchPoints` 改成我们给的值、平白改动观感 —— 只在报错后才动它。
 * 返回体里的 `mode` 是**实际生效**的那个(可能与 `request.mode` 不同):LLM 据此判断走了哪条路。
 */
export async function cdpTap(client: CdpClient, request: TapRequest): Promise<TapOutcome> {
  const point = await resolvePoint(client, request)
  if (!point.ok) return point
  const { x, y } = point
  if (request.mode === 'mouse') {
    const error = await dispatchMouseTap(client, x, y)
    return error ? { ok: false, error } : { ok: true, mode: 'mouse', x, y }
  }
  const first = await dispatchTouchTap(client, x, y)
  if (!first) return { ok: true, mode: 'touch', x, y }
  const emulated = await bestEffort(client, 'Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 5
  })
  if (emulated) {
    const second = await dispatchTouchTap(client, x, y)
    if (!second) return { ok: true, mode: 'touch', x, y }
  }
  const mouse = await dispatchMouseTap(client, x, y)
  if (mouse) return { ok: false, error: `触摸事件失败(${first});鼠标事件也失败(${mouse})` }
  return { ok: true, mode: 'mouse', x, y }
}

export interface TypeRequest {
  /** CSS 选择器;省略则用当前聚焦元素 */
  selector?: string
  text: string
  /** 是否先全选(再插入 = 替换原内容),默认 true */
  clear?: boolean
}

/**
 * 输入文字:先聚焦 + 可选全选,再 `Input.insertText`(IME 路径,受控组件与 `beforeinput` 都能收到)。
 * 与核心 `browser_type` 的逐字符 `setter + 手工派发` 不同 —— 手机上那条路拿不到真事件。
 */
export async function cdpType(
  client: CdpClient,
  request: TypeRequest
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const selector = typeof request.selector === 'string' ? request.selector.trim() : ''
  const focus = await evalFunction(client, FOCUS_FN, [selector, request.clear !== false])
  if (!focus.ok) return { ok: false, error: focus.error ?? '聚焦输入目标失败' }
  const focusError = scriptError(focus.result)
  if (focusError) return { ok: false, error: focusError }
  try {
    await client.send('Input.insertText', { text: request.text })
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  const read = await evalFunction(client, READ_FOCUSED_FN, [])
  const value = (read.result as { value?: unknown } | null)?.value
  return { ok: true, value: typeof value === 'string' ? value : '' }
}

/** 按键:有 `text` 的键发 `keyDown`(Chromium 会顺带产生字符),否则 `rawKeyDown`;随后 `keyUp` */
export async function cdpPressKey(
  client: CdpClient,
  key: string
): Promise<{ ok: true; key: CdpKeySpec } | { ok: false; error: string }> {
  const spec = resolveCdpKey(key)
  if (!spec) {
    return { ok: false, error: `不支持的按键:${key}(文字输入请用 device_type)` }
  }
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode
  }
  try {
    await client.send(
      'Input.dispatchKeyEvent',
      spec.text === undefined ? { type: 'rawKeyDown', ...base } : { type: 'keyDown', ...base, text: spec.text }
    )
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  return { ok: true, key: spec }
}

/**
 * 滚动:复用核心 `SCROLL_FN`(与 `browser_scroll` 同一套语义:方向 / 步长 / 返回 `top`)。
 * 刻意**不用**手势或滚轮事件 —— 自定义滚动容器在手机上很常见,脚本直接量/改 `scrollTop` 才确定。
 */
export async function cdpScroll(
  client: CdpClient,
  request: { selector?: string; direction: string; amount?: number }
): Promise<{ ok: true; top: number | null } | { ok: false; error: string }> {
  const selector = typeof request.selector === 'string' && request.selector.trim() ? request.selector.trim() : null
  const outcome = await evalFunction(client, SCROLL_FN, [selector, request.direction, request.amount ?? 0])
  if (!outcome.ok) return { ok: false, error: outcome.error ?? '滚动失败' }
  const scrollError = scriptError(outcome.result)
  if (scrollError) return { ok: false, error: scrollError }
  const value = outcome.result as { top?: unknown } | null
  return { ok: true, top: typeof value?.top === 'number' ? value.top : null }
}

export interface ConsoleRequest {
  /** 采集窗口(毫秒),默认 800,夹在 50..10000 */
  durationMs?: number
  /** 是否先重载页面以捕获**加载期**日志(会丢当前页面状态),默认 false */
  reload?: boolean
  /** 最多返回多少条(超出只计数),默认 100,夹在 1..500 */
  maxEntries?: number
}

export interface ConsoleOutcome {
  ok: true
  /** 实际生效的采集窗口(毫秒;已夹到 50..10000) */
  durationMs: number
  entries: ConsoleEntry[]
  /** 窗口内实际收到的总条数(可能大于 `entries.length`) */
  total: number
  truncated: boolean
}

/** 事件缓冲的硬上限:页面狂喷日志时不能把主进程内存吃光 */
const MAX_CONSOLE_BUFFER = 2000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 控制台/异常/浏览器日志观测(`Runtime.enable` + `Log.enable`,可选先 reload)。
 *
 * 语义是「**订阅窗口**」而不是「读历史」:CDP 不提供带缓冲的事件回放,想看加载期日志只能
 * 先订阅再重载。这条限制写在工具描述与 MCP_INSTRUCTIONS 里(否则 AI 会误判「没有日志」)。
 */
export async function cdpConsole(
  client: CdpClient,
  request: ConsoleRequest = {}
): Promise<ConsoleOutcome | { ok: false; error: string }> {
  const durationMs = clamp(request.durationMs ?? 800, 50, 10_000)
  const maxEntries = clamp(request.maxEntries ?? 100, 1, 500)
  const entries: ConsoleEntry[] = []
  let total = 0
  const collect = (entry: ConsoleEntry | null): void => {
    if (!entry) return
    total += 1
    if (entries.length < MAX_CONSOLE_BUFFER) entries.push(entry)
  }
  const offs = [
    client.on('Runtime.consoleAPICalled', (params) => collect(consoleEntryOf(params))),
    client.on('Runtime.exceptionThrown', (params) => collect(exceptionEntryOf(params))),
    client.on('Log.entryAdded', (params) => collect(logEntryOf(params)))
  ]
  try {
    const runtime = await bestEffort(client, 'Runtime.enable')
    const log = await bestEffort(client, 'Log.enable')
    if (!runtime && !log) {
      return { ok: false, error: '目标拒绝了 Runtime.enable 与 Log.enable,拿不到日志' }
    }
    if (request.reload) {
      await bestEffort(client, 'Page.enable')
      await bestEffort(client, 'Page.reload')
    }
    await delay(durationMs)
    return {
      ok: true,
      durationMs,
      entries: entries.slice(0, maxEntries),
      total,
      truncated: total > Math.min(entries.length, maxEntries)
    }
  } finally {
    for (const off of offs) off()
  }
}
