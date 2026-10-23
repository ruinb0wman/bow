/**
 * 远程控制服务的 HTTP 层。
 *
 * S5:`/healthz`(公开)+ 监听;S6:`POST /login` 与鉴权守卫;S7 加 `/ws`;S8 加静态页。
 * 监听与关闭只有这一处。
 *
 * 安全姿态(与 `main/mcpHttp.ts` 一致,别另立一套):
 * - 默认只绑回环;局域网是**显式开关**;
 * - `clientError` 直接 destroy,不给慢/坏客户端留连接;
 * - `/healthz` 不鉴权但**不带任何内容**(只回服务名/绑定/会话数量);
 * - 其它路径一律要鉴权(cookie 或 Bearer),且跨站 Origin 直接拒。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { LoginThrottle, REMOTE_COOKIE_NAME, REMOTE_COOKIE_TTL_MS, RemoteAuth } from './auth'
import type { SessionHub } from './hub'
import type { SessionInfo } from '../shared'

/** 应用名:远程页与健康检查都靠它确认「对面是 bow 的终端服务」 */
export const REMOTE_SERVICE_NAME = 'bow-terminal-remote'
/** 登录接口的请求体上限:口令就几十字节,大 body 只可能是攻击 */
const MAX_LOGIN_BODY_BYTES = 4 * 1024

export interface RemoteServerOptions {
  /** 0 = 让系统分配(单测用) */
  port: number
  bind: 'loopback' | 'lan'
  hub: SessionHub
  /** 鉴权(口令 + 签名密钥);必须由调用方保证口令可用(见 RemoteAuth.isUsablePassword) */
  auth: RemoteAuth
  /** 登录退避;省略时用默认参数(单测可注入假时钟) */
  throttle?: LoginThrottle
  /** 台账(登录后的首屏 / healthz 的数量) */
  sessions?: () => SessionInfo[]
  /** 注入用:列出本机非回环 IPv4 地址(单测不碰真实网卡) */
  listAddresses?: () => string[]
}

export interface RemoteServerHandle {
  port: number
  bind: 'loopback' | 'lan'
  /** 实际监听的地址:回环模式是 127.0.0.1,局域网模式是 0.0.0.0 */
  host: string
  /** 本机访问地址(设置页/复制用) */
  url: string
  /** 局域网访问地址(仅 lan 模式非空) */
  lanUrls: string[]
  close(): Promise<void>
}

export function hostOf(bind: 'loopback' | 'lan'): string {
  return bind === 'lan' ? '0.0.0.0' : '127.0.0.1'
}

/**
 * 本机非回环 IPv4。只取 IPv4:手机浏览器手输 IPv6 地址的体验比「扫码/点链接」差太多,
 * 而局域网里 IPv4 基本一定存在。
 */
export function listLanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      out.push(addr.address)
    }
  }
  return out
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    // 登录/状态类响应一律不缓存:否则手机浏览器会把 401 或旧 cookie 状态缓存起来
    'cache-control': 'no-store',
    ...headers
  })
  res.end(text)
}

/** 读请求体(有大小上限;超了立刻断开,不把内存交给客户端) */
async function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_LOGIN_BODY_BYTES) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

/** 登录态 cookie。**故意不加 `Secure`**:局域网是 http,加了手机浏览器就不会存 —— 详见 README 的安全说明 */
function cookieHeader(value: string): string {
  return `${REMOTE_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
    REMOTE_COOKIE_TTL_MS / 1000
  )}`
}

export async function startRemoteServer(options: RemoteServerOptions): Promise<RemoteServerHandle> {
  const host = hostOf(options.bind)
  const http: Server = createServer((req, res) => handle(options, req, res))
  // 半截请求/畸形请求:直接断开,不在服务里留垃圾连接
  http.on('clientError', (_e, socket) => socket.destroy())

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, host, () => {
      http.removeListener('error', reject)
      resolve()
    })
  })

  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  const addresses = (options.listAddresses ?? listLanAddresses)()

  return {
    port,
    bind: options.bind,
    host,
    url: `http://127.0.0.1:${port}`,
    lanUrls: options.bind === 'lan' ? addresses.map((ip) => `http://${ip}:${port}`) : [],
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve())
        // keep-alive 连接会卡住 close 的回调:全部掐掉
        http.closeAllConnections?.()
      })
  }
}

function handle(options: RemoteServerOptions, req: IncomingMessage, res: ServerResponse): void {
  void route(options, req, res).catch(() => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: '服务器内部错误' })
    else res.end()
  })
}

async function route(options: RemoteServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/'
  const path = url.split('?')[0]
  const clientKey = req.socket.remoteAddress ?? 'unknown'

  // 公开:探活。只回「活着 + 绑定模式 + 会话数量」——绝不回标题/路径/输出
  if (req.method === 'GET' && path === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      service: REMOTE_SERVICE_NAME,
      bind: options.bind,
      sessions: options.sessions?.().length ?? 0
    })
    return
  }

  // 登录:唯一不要求先有 cookie 的写接口
  if (req.method === 'POST' && path === '/login') {
    await handleLogin(options, req, res, clientKey)
    return
  }

  // 以下全部要鉴权(跨站 Origin 也算鉴权失败)
  if (!options.auth.verifyRequest(req.headers)) {
    sendJson(res, 401, { ok: false, error: '未登录' })
    return
  }

  if (req.method === 'GET' && path === '/api/sessions') {
    sendJson(res, 200, { ok: true, sessions: options.sessions?.() ?? [] })
    return
  }

  sendJson(res, 404, { ok: false, error: '未知路径' })
}

async function handleLogin(
  options: RemoteServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
  clientKey: string
): Promise<void> {
  const throttle = options.throttle ?? new LoginThrottle()
  const gate = throttle.check(clientKey)
  if (!gate.allowed) {
    sendJson(
      res,
      429,
      { ok: false, error: `尝试太频繁,请 ${Math.ceil(gate.retryAfterMs / 1000)} 秒后再试` },
      { 'retry-after': String(Math.ceil(gate.retryAfterMs / 1000)) }
    )
    return
  }

  const raw = await readBody(req)
  if (raw === null) {
    sendJson(res, 413, { ok: false, error: '请求体过大' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw || '{}')
  } catch {
    sendJson(res, 400, { ok: false, error: '请求体不是 JSON' })
    return
  }

  const password = (parsed as { password?: unknown } | null)?.password
  if (!options.auth.checkPassword(password)) {
    const blocked = throttle.fail(clientKey)
    sendJson(
      res,
      401,
      { ok: false, error: '口令不对', ...(blocked ? { retryAfterSec: Math.ceil(blocked / 1000) } : {}) },
      blocked ? { 'retry-after': String(Math.ceil(blocked / 1000)) } : {}
    )
    return
  }

  throttle.success(clientKey)
  res.writeHead(204, { 'set-cookie': cookieHeader(options.auth.issue()), 'cache-control': 'no-store' })
  res.end()
}
