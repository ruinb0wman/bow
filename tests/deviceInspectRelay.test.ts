/**
 * 中继(relay.ts)的真实链路用例。
 *
 * 为什么会有一个「假设备」:中继存在的唯一理由就是**目标侧会拒掉带 Origin 的握手**
 * (Chromium: `if (request.headers.count("origin") && !is_same_origin && !allowlist…) Send403`)。
 * 所以这里起一个真的 TCP 服务端,把收到的首部**原样记录下来**,再断言:
 *   1. 客户端发过去的 Origin 在到达「设备」时已经没了;
 *   2. 首部之后的字节是双向透传的(WebSocket 帧也一样,因为中继完全不解析帧)。
 *
 * 纯函数部分(splitHandshakeHead / withoutHeader / rewriteHead)在同一文件里单测。
 */

import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { connect, createServer as createTcpServer } from 'node:net'
import type { Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { rewriteHead, splitHandshakeHead, startRelay, withoutHeader, type HandshakeHead, type Relay } from '../src/plugins/device-inspect/relay'

// ---------------------------------------------------------------- 纯函数

describe('splitHandshakeHead', () => {
  it('首部没收全时返回 null(必须等 \\r\\n\\r\\n)', () => {
    expect(splitHandshakeHead(Buffer.from('GET /x HTTP/1.1\r\nHost: a'))).toBeNull()
    expect(splitHandshakeHead(Buffer.alloc(0))).toBeNull()
  })

  it('切出请求行 / 头 / 剩余字节', () => {
    const raw = Buffer.from('GET /devtools/page/T1 HTTP/1.1\r\nHost: 127.0.0.1:9301\r\nOrigin: devtools://devtools\r\n\r\n\x81\x05hello', 'latin1')
    const head = splitHandshakeHead(raw) as HandshakeHead
    expect(head.requestLine).toBe('GET /devtools/page/T1 HTTP/1.1')
    expect(head.headers).toEqual(['Host: 127.0.0.1:9301', 'Origin: devtools://devtools'])
    expect(head.rest.toString('latin1')).toBe('\x81\x05hello')
  })
})

describe('withoutHeader', () => {
  it('大小写不敏感地删掉全部同名列', () => {
    const out = withoutHeader(['Host: a', 'origin: x', 'Origin: y', 'Upgrade: websocket'], 'origin')
    expect(out.removed).toBe(true)
    expect(out.headers).toEqual(['Host: a', 'Upgrade: websocket'])
  })

  it('没有该头时原样返回', () => {
    const out = withoutHeader(['Host: a'], 'origin')
    expect(out.removed).toBe(false)
    expect(out.headers).toEqual(['Host: a'])
  })

  it('不会误删前缀相同但名字不同的头(origin-* 不是 Origin)', () => {
    const out = withoutHeader(['Origin-Agent-Cluster: ?1'], 'origin')
    expect(out.headers).toEqual(['Origin-Agent-Cluster: ?1'])
  })
})

describe('rewriteHead', () => {
  it('重组出合法的首部并报告是否删过 Origin', () => {
    const raw = Buffer.from('GET /devtools/page/T1 HTTP/1.1\r\nOrigin: devtools://devtools\r\nUpgrade: websocket\r\n\r\n', 'latin1')
    const head = splitHandshakeHead(raw) as HandshakeHead
    const out = rewriteHead(head)
    expect(out.removedOrigin).toBe(true)
    expect(out.text).toBe('GET /devtools/page/T1 HTTP/1.1\r\nUpgrade: websocket\r\n\r\n')
  })
})

// ---------------------------------------------------------------- 真实链路

interface FakeDevice {
  port: number
  /** 收到过的原始字节(按到达顺序拼接前的分片) */
  received(): string
  send(text: string): void
  close(): Promise<void>
}

/** 一个只会记录 + 回显的「设备」 */
function startFakeDevice(): Promise<FakeDevice> {
  const chunks: string[] = []
  const sockets = new Set<Socket>()
  const server: Server = createTcpServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk) => {
      chunks.push(chunk.toString('latin1'))
      socket.write('ECHO')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        received: () => chunks.join(''),
        send: (text) => {
          for (const socket of sockets) socket.write(text)
        },
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

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup(): Promise<{ device: FakeDevice; relay: Relay }> {
  const device = await startFakeDevice()
  const relay = await startRelay({ targetPort: device.port })
  cleanups.push(() => relay.close(), () => device.close())
  return { device, relay }
}

/** 连中继、发一段字节、等首个响应字节;返回收到的内容 */
function roundTrip(port: number, payload: string, opts: { waitFor?: number; tolerateReset?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let received = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(received)
    }, opts.waitFor ?? 500)
    socket.on('connect', () => socket.write(payload, 'latin1'))
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1')
      if (received.includes('ECHO')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      // 中继主动断开(EAGER 上限保护)会让客户端看到 ECONNRESET —— 这正是被验的行为
      if (opts.tolerateReset) resolve(received)
      else reject(error)
    })
  })
}

const UPGRADE_WITH_ORIGIN = [
  'GET /devtools/page/T1 HTTP/1.1',
  'Host: 127.0.0.1:9301',
  'Connection: Upgrade',
  'Upgrade: websocket',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version: 13',
  'Origin: devtools://devtools',
  '',
  ''
].join('\r\n')

describe('中继:剥掉 Origin 再转发', () => {
  it('设备侧收到的首部里没有 Origin(这就是 Android 上能连上的唯一原因)', async () => {
    const { device, relay } = await setup()
    const received = await roundTrip(relay.port, UPGRADE_WITH_ORIGIN)
    expect(received).toContain('ECHO')
    const seen = device.received()
    expect(seen).toContain('GET /devtools/page/T1 HTTP/1.1')
    expect(seen).toContain('Sec-WebSocket-Version: 13')
    expect(seen.toLowerCase()).not.toContain('origin:')
  })

  it('没有 Origin 时也照常转发(不依赖客户端一定带它)', async () => {
    const { device, relay } = await setup()
    await roundTrip(relay.port, 'GET /json HTTP/1.1\r\nHost: 127.0.0.1:9301\r\n\r\n')
    expect(device.received()).toContain('GET /json HTTP/1.1')
  })

  it('首部之后的字节双向透传(中继不解析帧,WebSocket 数据原样过)', async () => {
    const { device, relay } = await setup()
    await roundTrip(relay.port, UPGRADE_WITH_ORIGIN)
    // 握手完成后再发一段「帧」字节,设备侧应当也能收到,且我们收到设备主动推的字节
    await new Promise((r) => setTimeout(r, 100))
    device.send('FROM-DEVICE')
    const echoed = await roundTrip(relay.port, `${UPGRADE_WITH_ORIGIN}\x81\x05hello`)
    expect(echoed).toContain('ECHO')
    expect(device.received()).toContain('\x81\x05hello')
  })

  it('首部超过上限直接断开(防本机客户端把内存撑爆)', async () => {
    const { device, relay } = await setup()
    const huge = 'GET /x HTTP/1.1\r\n' + 'X-Pad: ' + 'a'.repeat(70 * 1024) // 没有 \r\n\r\n 结尾
    const received = await roundTrip(relay.port, huge, { waitFor: 300, tolerateReset: true })
    expect(received).toBe('')
    expect(device.received()).toBe('')
  })

  it('close() 之后端口不再接受连接(插件停用/退出时必须能收干净)', async () => {
    const device = await startFakeDevice()
    const relay = await startRelay({ targetPort: device.port })
    await relay.close()
    await device.close()
    await expect(roundTrip(relay.port, 'GET / HTTP/1.1\r\n\r\n', { waitFor: 300 })).rejects.toThrow()
  })
})

// 说明:中继只碰 HTTP 首部,不需要 WebSocket 实现 —— 这也是选择「TCP 中继」而不是
// 「本地 WS 代理」的原因(后者要么引 ws 依赖,要么自己写帧编解码;实测那个更容易写错)。
describe('中继:不需要 WebSocket 实现', () => {
  it('对普通 HTTP 服务(非 upgrade)同样透传', async () => {
    const backend = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: req.url, origin: req.headers.origin ?? null }))
    })
    await new Promise<void>((r) => backend.listen(0, '127.0.0.1', () => r()))
    const address = backend.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const relay = await startRelay({ targetPort: port })
    cleanups.push(
      () => relay.close(),
      () => new Promise<void>((done) => backend.close(() => done()))
    )

    const body = await new Promise<string>((resolve, reject) => {
      const socket = connect(relay.port, '127.0.0.1')
      let data = ''
      socket.on('connect', () =>
        socket.write('GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:9999\r\nOrigin: devtools://devtools\r\nConnection: close\r\n\r\n')
      )
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8')
      })
      socket.on('close', () => resolve(data))
      socket.on('error', reject)
    })
    expect(body).toContain('"path":"/json/version"')
    expect(body).toContain('"origin":null') // 后端看到的是被剥掉 Origin 后的请求
  })
})
