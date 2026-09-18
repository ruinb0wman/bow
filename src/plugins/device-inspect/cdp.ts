/**
 * 最小 CDP(Chrome DevTools Protocol)客户端:只做 bow 需要的那几件事 ——
 * `Runtime.evaluate` 与 `Page.captureScreenshot`。
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

import { readEvalOutcome, readScreenshotData } from './shared'

export interface CdpClient {
  /** 发一条 CDP 命令;超时或对端断开都会 reject */
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
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

  socket.onclose = () => failAll('调试连接已关闭')
  socket.onerror = () => failAll('调试连接出错')
  socket.onmessage = (event: MessageEvent) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (typeof message.id !== 'number') return // 事件通知(如 Inspector.detached),本客户端不需要
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
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
