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
import { readFile as readFileAsync } from 'node:fs/promises'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { LoginThrottle, REMOTE_COOKIE_NAME, REMOTE_COOKIE_TTL_MS, RemoteAuth } from './auth'
import { parseClientMessage } from './protocol'
import { readStaticFile } from './static'
import type { RemoteSessionApi, ServerMessage } from './protocol'
import type { HubEvent, SessionHub, HubSink } from './hub'

/** 应用名:远程页与健康检查都靠它确认「对面是 bow 的终端服务」 */
export const REMOTE_SERVICE_NAME = 'bow-terminal-remote'
/** WS 路径。单独一个常量:客户端与服务端只靠它对上 */
export const REMOTE_WS_PATH = '/ws'
/** 登录接口的请求体上限:口令就几十字节,大 body 只可能是攻击 */
const MAX_LOGIN_BODY_BYTES = 4 * 1024
/** 单条 WS 消息上限:按键流很小,1MB 已经宽松 */
const MAX_WS_PAYLOAD = 1024 * 1024

export interface RemoteServerOptions {
  /** 0 = 让系统分配(单测用) */
  port: number
  bind: 'loopback' | 'lan'
  hub: SessionHub
  /** 鉴权(口令 + 签名密钥);必须由调用方保证口令可用(见 RemoteAuth.isUsablePassword) */
  auth: RemoteAuth
  /** 登录退避;省略时用默认参数(单测可注入假时钟) */
  throttle?: LoginThrottle
  /** 会话操作(由插件实现);也是 `/healthz` 与 `/api/sessions` 的数据源 */
  sessions: RemoteSessionApi
  /**
   * 远程页的构建产物目录(`out/remote`)。省略 = 不提供静态页(单测/纯 API 场景)。
   * 页面本身**不鉴权**:它是登录页 —— 里面没有任何秘密,而 API 与 WS 全要鉴权。
   */
  staticDir?: string
  /** 注入用:读静态文件(单测给假函数) */
  readFile?: (path: string) => Promise<Buffer>
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
  /** 本机 WS 地址(远程页与 e2e 用;浏览器侧按同源自己拼也行) */
  wsUrl: string
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

  // ---------- WebSocket(一条连接多路复用所有会话)----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })
  http.on('upgrade', (req: IncomingMessage, socket, head) => {
    const path = (req.url ?? '/').split('?')[0]
    // 路径不对 / 没登录 / 跨站 Origin:一律在握手阶段拒,不进 WS 世界
    if (path !== REMOTE_WS_PATH || !options.auth.verifyRequest(req.headers)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachClient(options, ws))
  })

  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  const addresses = (options.listAddresses ?? listLanAddresses)()

  return {
    port,
    bind: options.bind,
    host,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}${REMOTE_WS_PATH}`,
    lanUrls: options.bind === 'lan' ? addresses.map((ip) => `http://${ip}:${port}`) : [],
    close: () =>
      new Promise<void>((resolve) => {
        // 先掐 WS(不然它们会把 http.close 拖住),再关监听
        for (const client of wss.clients) {
          try {
            client.close(1001, '服务已停止')
          } catch {
            /* 已经断了 */
          }
        }
        wss.close()
        http.close(() => resolve())
        // keep-alive 连接会卡住 close 的回调:全部掐掉
        http.closeAllConnections?.()
      })
  }
}

/**
 * 一条已鉴权的 WS 连接:订阅 hub + 处理上行消息。
 *
 * hub 事件靠 `HubSink` 转成 JSON 下行;`buffered()` 直接把 ws 的 `bufferedAmount` 交出去,
 * 于是「跟不上的客户端」由 hub 统一判定并踢掉(策略只有一处)。
 */
function attachClient(options: RemoteServerOptions, ws: WebSocket): void {
  const send = (message: ServerMessage | HubEvent): void => {
    if (ws.readyState !== ws.OPEN) return
    ws.send(JSON.stringify(message))
  }

  const sink: HubSink = {
    buffered: () => ws.bufferedAmount,
    send: (event) => send(event),
    drop: (reason) => {
      try {
        ws.close(1008, reason.slice(0, 100))
      } catch {
        /* 已经断了 */
      }
    }
  }
  const unsubscribe = options.hub.subscribe(sink)
  let closed = false
  const done = (): void => {
    if (closed) return
    closed = true
    unsubscribe()
  }

  ws.on('close', done)
  ws.on('error', done)

  // 首屏:服务名 + 当前台账(客户端不用先发 list)
  send({ t: 'hello', service: REMOTE_SERVICE_NAME, sessions: options.sessions.list() })

  ws.on('message', (raw) => {
    let parsedRaw: unknown
    try {
      parsedRaw = JSON.parse(String(raw))
    } catch {
      send({ t: 'error', message: '消息不是合法 JSON' })
      return
    }
    const parsed = parseClientMessage(parsedRaw)
    if (!parsed.ok) {
      send({ t: 'error', message: parsed.error })
      return
    }
    const msg = parsed.message
    switch (msg.t) {
      case 'list':
        send({ t: 'sessions', sessions: options.sessions.list() })
        return
      case 'attach': {
        const result = options.sessions.attach(msg.id, msg.cols, msg.rows)
        if (!result.ok) send({ t: 'error', message: result.error ?? '会话不存在' })
        else
          send({
            t: 'attached',
            id: msg.id,
            replay: result.replay ?? '',
            cols: result.cols ?? msg.cols,
            rows: result.rows ?? msg.rows,
            title: result.title ?? ''
          })
        return
      }
      case 'detach':
        // 订阅是连接级的(hub),这里没有「单个会话的订阅」要退 —— 留着是为了协议完整
        return
      case 'input':
        if (!options.sessions.input(msg.id, msg.data)) send({ t: 'error', message: '会话不存在' })
        return
      case 'resize':
        if (!options.sessions.resize(msg.id, msg.cols, msg.rows)) send({ t: 'error', message: '会话不存在' })
        return
      case 'read': {
        const result = options.sessions.readTail(msg.id, msg.chars)
        if (!result.ok) send({ t: 'error', message: result.error ?? '读不到这个会话' })
        else send({ t: 'read', id: msg.id, text: result.text ?? '' })
        return
      }
      case 'create': {
        const result = options.sessions.create(msg)
        if (!result.ok || result.id == null) send({ t: 'error', message: result.error ?? '开不了新会话' })
        else send({ t: 'created', id: result.id, state: result.state ?? 'starting' })
        return
      }
      case 'close':
        if (!options.sessions.close(msg.id)) send({ t: 'error', message: '会话不存在' })
        return
    }
  })
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
      sessions: options.sessions.list().length
    })
    return
  }

  // 登录:唯一不要求先有 cookie 的写接口
  if (req.method === 'POST' && path === '/login') {
    await handleLogin(options, req, res, clientKey)
    return
  }

  // 静态页(登录页 + 资源)是公开的:里面没有任何秘密;API 与 WS 全要鉴权
  if ((req.method === 'GET' || req.method === 'HEAD') && options.staticDir && path !== '/api/sessions') {
    const file = await readStaticFile(
      options.staticDir,
      path === '/' || path === '' ? '/index.html' : path,
      options.readFile ?? readFileAsync
    )
    res.writeHead(file.status, { ...file.headers, 'content-length': file.body.length })
    res.end(req.method === 'HEAD' ? undefined : file.body)
    return
  }

  // 以下全部要鉴权(跨站 Origin 也算鉴权失败)
  if (!options.auth.verifyRequest(req.headers)) {
    sendJson(res, 401, { ok: false, error: '未登录' })
    return
  }

  if (req.method === 'GET' && path === '/api/sessions') {
    sendJson(res, 200, { ok: true, sessions: options.sessions.list() })
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
