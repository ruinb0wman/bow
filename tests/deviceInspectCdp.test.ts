/**
 * CDP 客户端与一个**真实的**本地 WebSocket 服务端对打。
 *
 * 为什么值得手搓一个假的 CDP 服务端(约 70 行):
 * 1. 「Node 的 WebSocket 握手不带 Origin 头」是整套设计的地基 —— 因为不带 Origin,
 *    才不需要在 bow 里再写一个 WS 代理去绕开 Chromium 的 `--remote-allow-origins` 白名单。
 *    这个事实只能靠**观察真实握手请求头**来钉住,注释说明不了问题;
 * 2. id 匹配、超时、对端断开这三条错误路径只有真的走一遍才可靠(它们是最容易写错的部分)。
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { cdpEvaluate, cdpScreenshot, connectCdp } from '../src/plugins/device-inspect/cdp'

interface FakeServer {
  url: string
  /** 收到过的 upgrade 请求头(断言 Origin 用) */
  upgrades: IncomingMessage['headers'][]
  close(): Promise<void>
}

type Behavior = 'respond' | 'silent' | 'drop'

function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text)
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

/** 解析客户端帧(带掩码),返回帧列表与剩余缓冲。只关心文本帧,但**必须把其它帧消费掉**,否则会错位 */
function decodeFrames(buffer: Buffer): { frames: Array<{ opcode: number; payload: string }>; rest: Buffer } {
  const frames: Array<{ opcode: number; payload: string }> = []
  let rest = buffer
  for (;;) {
    if (rest.length < 2) break
    const opcode = rest[0] & 0x0f
    const masked = (rest[1] & 0x80) !== 0
    let length = rest[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (rest.length < 4) break
      length = rest.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (rest.length < 10) break
      length = Number(rest.readBigUInt64BE(2))
      offset = 10
    }
    const maskOffset = offset
    if (masked) offset += 4
    if (rest.length < offset + length) break
    const payload = Buffer.from(rest.subarray(offset, offset + length))
    if (masked) {
      const mask = rest.subarray(maskOffset, maskOffset + 4)
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    }
    frames.push({ opcode, payload: payload.toString('utf8') })
    rest = rest.subarray(offset + length)
  }
  return { frames, rest }
}

function startFakeCdp(behavior: (method: string) => Behavior, results: Record<string, unknown>): Promise<FakeServer> {
  const upgrades: IncomingMessage['headers'][] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer()
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    upgrades.push(req.headers)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const accept = createHash('sha1')
      .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const { frames, rest } = decodeFrames(buffer)
      buffer = rest
      for (const frame of frames) {
        // 8 = close、9 = ping、10 = pong:这些帧没有 JSON 负载,但要消费掉(否则后续帧会错位)
        if (frame.opcode === 8) {
          socket.destroy()
          continue
        }
        if (frame.opcode !== 1 || !frame.payload) continue
        let request: { id?: number; method?: string; params?: unknown }
        try {
          request = JSON.parse(frame.payload)
        } catch {
          continue
        }
        const method = String(request.method ?? '')
        const action = behavior(method)
        if (action === 'silent') continue
        if (action === 'drop') {
          socket.destroy()
          continue
        }
        const key = `${method}:${JSON.stringify(request.params ?? {})}`
        const result = results[method] ?? results[key] ?? {}
        if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify({ id: request.id, result })))
      }
    })
  })

  return new Promise<FakeServer>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `ws://127.0.0.1:${port}/devtools/page/TEST`,
        upgrades,
        close: () =>
          new Promise<void>((done) => {
            // 升级过的 socket 不在 closeAllConnections 的管辖范围里,必须自己销毁,否则 server.close() 永远不回调
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.close(() => done())
          })
      })
    })
  })
}

const servers: FakeServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
})

async function connect(behavior: Behavior = 'respond', results: Record<string, unknown> = {}) {
  const server = await startFakeCdp(() => behavior, results)
  servers.push(server)
  const client = await connectCdp(server.url)
  return { server, client }
}

describe('CDP 客户端', () => {
  it('握手不带 Origin 头 —— 这是「不需要本地代理」的依据', async () => {
    const { server, client } = await connect()
    client.close()
    expect(server.upgrades).toHaveLength(1)
    expect(server.upgrades[0].origin).toBeUndefined()
    // 顺带钉住:必须带升级三件套,否则这不是一个 WS 握手
    expect(String(server.upgrades[0].upgrade).toLowerCase()).toBe('websocket')
  })

  it('按 id 匹配响应,并发调用不会串线', async () => {
    const { client } = await connect('respond', {
      'Runtime.evaluate': { result: { type: 'string', value: 'ok' } }
    })
    const [a, b] = await Promise.all([client.send('Runtime.evaluate', { expression: '1' }), client.send('Runtime.evaluate', { expression: '2' })])
    expect(a).toEqual({ result: { type: 'string', value: 'ok' } })
    expect(b).toEqual(a)
    client.close()
  })

  it('对端不回应该条命令 → 超时 reject(不会永远挂着)', async () => {
    const { client } = await connect('silent')
    await expect(client.send('Runtime.evaluate', {}, 300)).rejects.toThrow(/超时/)
    client.close()
  })

  it('对端断开 → 在途命令 reject', async () => {
    const { client } = await connect('drop')
    await expect(client.send('Runtime.evaluate', {}, 3000)).rejects.toThrow(/关闭|出错/)
    client.close()
  })

  it('连不上的地址 → 直接抛出可读错误', async () => {
    await expect(connectCdp('ws://127.0.0.1:1/devtools/page/X', { timeoutMs: 1500 })).rejects.toThrow(
      /无法连接调试目标/
    )
  })
})

describe('cdpEvaluate', () => {
  it('正常返回', async () => {
    const { client } = await connect('respond', {
      'Runtime.evaluate': { result: { type: 'string', value: 'hello' } }
    })
    expect(await cdpEvaluate(client, '1')).toEqual({ ok: true, result: 'hello' })
    client.close()
  })

  it('页面抛错(exceptionDetails)必须算失败,不能当成功', async () => {
    const { client } = await connect('respond', {
      'Runtime.evaluate': {
        result: { type: 'object' },
        exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } }
      }
    })
    expect(await cdpEvaluate(client, 'throw new Error("boom")')).toEqual({ ok: false, error: 'Error: boom' })
    client.close()
  })

  it('undefined 归一成 null(与核心工具 browser_eval 一致)', async () => {
    const { client } = await connect('respond', { 'Runtime.evaluate': { result: { type: 'undefined' } } })
    expect(await cdpEvaluate(client, 'void 0')).toEqual({ ok: true, result: null })
    client.close()
  })
})

describe('cdpScreenshot', () => {
  it('拿回 base64 PNG', async () => {
    const { client } = await connect('respond', { 'Page.captureScreenshot': { data: 'AAAA' } })
    expect(await cdpScreenshot(client)).toEqual({ ok: true, data: 'AAAA' })
    client.close()
  })

  it('没有 data 字段 → 明确失败(不发空图片)', async () => {
    const { client } = await connect('respond', { 'Page.captureScreenshot': {} })
    expect(await cdpScreenshot(client)).toEqual({ ok: false, error: '目标没有返回截图数据' })
    client.close()
  })
})
