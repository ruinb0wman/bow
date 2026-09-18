/**
 * 「剥 Origin」的本地 TCP 中继 —— 手机调试能不能用,**全看这个文件**。
 *
 * ## 为什么必须要它
 *
 * Chromium 的 DevTools 端点在 `devtools_http_handler.cc` 里对 WebSocket 握手做来源校验:
 *
 * ```cc
 * bool is_same_origin = server_ip_address_ && url::Origin::Create(GURL("http://" + server_ip_address_->ToString()))
 *                           .IsSameOriginWith(GURL(request.GetHeaderValue("origin")));
 * if (request.headers.count("origin") && !is_same_origin &&
 *     !remote_allow_origins_.count(lower(origin)) && !remote_allow_origins_.count("*")) Send403(...);
 * ```
 *
 * 三个推论,缺一个都会把方案选错:
 *
 * 1. **白名单唯一来源是 `--remote-allow-origins`**,手机上加不了这个开关;
 * 2. **Android 上「同源豁免」永远不成立**:Android 的 devtools 服务挂在 unix 抽象套接字上
 *    (`aw_devtools_server.cc` 的 `UnixDomainServerSocketFactory`),`server_ip_address_` 为 null,
 *    所以 `is_same_origin` 恒为 false —— 「用设备自带前端凑同源」这条退路在手机上是无效的;
 * 3. 而浏览器页面里加载的 devtools 前端**必定**带 `Origin: devtools://devtools`(2026-09-18 实测:
 *    Electron 里的前端在目标侧被这句校验拒掉,日志打的就是 `Rejected an incoming WebSocket connection
 *    from the devtools://devtools origin`)。所以前端**不能**直连设备。
 *
 * ## 解法(与 Chrome 自己对 Android 设备做的事同一个思路:由宿主进程代理)
 *
 * 在 bow 侧开一个 TCP 监听,把客户端请求的 HTTP 首部里的 `Origin` 头删掉再转发给 `adb forward`
 * 的端口,之后**纯字节管道**。关键认识:**不需要实现 WebSocket** —— WS 握手就是一个 HTTP 请求,
 * 我们只改首部,帧数据原样透传。
 *
 * 实测(2026-09-18,Electron 44 + 目标**不带** `--remote-allow-origins`):
 * 前端经这个中继后 Elements/Console/Network 全部可用,目标侧不再报 Origin 拒绝。
 *
 * 另外,主进程自己的 CDP 客户端(Node 的 `WebSocket`)本来就不发 Origin,所以 `device_eval` /
 * `device_screenshot` 走不走中继都行 —— 它们复用同一个 `ws` 地址,少一条路径。
 */

import { connect, createServer } from 'node:net'
import type { Server, Socket } from 'node:net'

/** 首部过大直接断开:正常握手首部只有几百字节,防的是本机恶意客户端把内存撑爆 */
const MAX_HEAD_BYTES = 64 * 1024

export interface HandshakeHead {
  requestLine: string
  headers: string[]
  /** 首部之后剩下的字节(可能已经带了 WebSocket 帧的开头) */
  rest: Buffer
}

/** 从缓冲里切出 HTTP 首部(到 `\r\n\r\n` 为止);还没收全返回 null */
export function splitHandshakeHead(buffer: Buffer): HandshakeHead | null {
  const end = buffer.indexOf('\r\n\r\n')
  if (end < 0) return null
  const text = buffer.subarray(0, end).toString('latin1')
  const [requestLine = '', ...headers] = text.split('\r\n')
  return { requestLine, headers, rest: buffer.subarray(end + 4) }
}

/** 按名字删头(大小写不敏感,保持其余顺序) */
export function withoutHeader(headers: string[], name: string): { headers: string[]; removed: boolean } {
  const wanted = `${name.toLowerCase()}:`
  const kept = headers.filter((line) => !line.toLowerCase().startsWith(wanted))
  return { headers: kept, removed: kept.length !== headers.length }
}

/** 首部 → 去掉 Origin 后的原始字节 + 是否真的删掉了 */
export function rewriteHead(head: HandshakeHead): { text: string; removedOrigin: boolean } {
  const { headers, removed } = withoutHeader(head.headers, 'origin')
  return {
    text: [head.requestLine, ...headers].join('\r\n') + '\r\n\r\n',
    removedOrigin: removed
  }
}

export interface Relay {
  port: number
  close(): Promise<void>
}

/**
 * 起一个中继:`listenPort`(默认由系统分配)→ `127.0.0.1:targetPort`(某个 `adb forward` 端口)。
 *
 * 每个套接字一个中继 —— 不按 URL 路由,是因为中继只认字节流、不该知道 CDP 目标的存在。
 */
export function startRelay(opts: { targetPort: number; listenPort?: number; log?: (...args: unknown[]) => void }): Promise<Relay> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((client: Socket) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => client.destroy())

    let buffer = Buffer.alloc(0)
    let upstream: Socket | null = null
    let opened = false

    const onData = (chunk: Buffer): void => {
      if (opened) return
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_HEAD_BYTES) {
        client.destroy()
        return
      }
      const head = splitHandshakeHead(buffer)
      if (!head) return
      opened = true
      client.removeListener('data', onData)
      const { text, removedOrigin } = rewriteHead(head)
      upstream = connect(opts.targetPort, '127.0.0.1', () => {
        upstream?.write(text, 'latin1')
        if (head.rest.length) upstream?.write(head.rest)
        client.pipe(upstream as Socket)
        ;(upstream as Socket).pipe(client)
      })
      upstream.on('error', () => client.destroy())
      upstream.on('close', () => client.destroy())
      opts.log?.('中继转发', opts.targetPort, removedOrigin ? '(已剥离 Origin)' : '(无 Origin)')
    }

    client.on('data', onData)
    client.on('close', () => upstream?.destroy())
  })

  return new Promise<Relay>((resolve, reject) => {
    server.on('error', reject)
    server.listen(opts.listenPort ?? 0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.close(() => done())
          })
      })
    })
  })
}
