/**
 * 远程控制服务的 HTTP 骨架(S5)。
 *
 * 现在只有 `/healthz`:用来把「端口能不能起、绑在哪、局域网地址是什么」这几件事先跑通。
 * S6 加鉴权、S7 加 `/ws`、S8 加静态页 —— 都挂在这个 server 上,监听与关闭只有这一处。
 *
 * 安全姿态(与 `main/mcpHttp.ts` 一致,别另立一套):
 * - 默认只绑回环;局域网是**显式开关**;
 * - `clientError` 直接 destroy,不给慢/坏客户端留连接;
 * - Host / Origin 校验在 S6 做(它属于鉴权,不是传输)。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { SessionHub } from './hub'

/** 应用名:远程页与健康检查都靠它确认「对面是 bow 的终端服务」 */
export const REMOTE_SERVICE_NAME = 'bow-terminal-remote'

export interface RemoteServerOptions {
  /** 0 = 让系统分配(单测用) */
  port: number
  bind: 'loopback' | 'lan'
  hub: SessionHub
  /** 探活之外还带上台账(设置页/远程页首屏用;不含任何凭据) */
  sessions?: () => unknown
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
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
  const url = req.url ?? '/'
  const path = url.split('?')[0]

  if (req.method === 'GET' && path === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      service: REMOTE_SERVICE_NAME,
      // 回环/LAN 只是「怎么连」,不是凭据;不带头号以外的信息
      bind: options.bind,
      ...(options.sessions ? { sessions: options.sessions() } : {})
    })
    return
  }

  sendJson(res, 404, { ok: false, error: '未知路径' })
}
