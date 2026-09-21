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
import { cdpConsole, cdpEvaluate, cdpPressKey, cdpScroll, cdpScreenshot, cdpSnapshot, cdpTap, cdpType, connectCdp } from '../src/plugins/device-inspect/cdp'

interface FakeServer {
  url: string
  /** 收到过的 upgrade 请求头(断言 Origin 用) */
  upgrades: IncomingMessage['headers'][]
  /** 收到过的命令(顺序敏感:断言「脚本注入 → 真输入事件」的次序用) */
  requests: Array<{ method: string; params: Record<string, unknown> }>
  /** 推一条**事件通知**(没有 id 的帧,如 Runtime.consoleAPICalled) */
  push(payload: unknown): void
  close(): Promise<void>
}

type Behavior = 'respond' | 'silent' | 'drop' | 'error'

/** results 的值可以是固定结果,也可以是「看参数再决定」的函数(同一个 method 的两次调用结果不同时用) */
type Results = Record<string, unknown | ((params: Record<string, unknown>) => unknown)>

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

function startFakeCdp(
  behavior: (method: string) => Behavior,
  results: Results,
  onRequest?: (method: string, params: Record<string, unknown>) => void
): Promise<FakeServer> {
  const upgrades: IncomingMessage['headers'][] = []
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
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
        let request: { id?: number; method?: string; params?: Record<string, unknown> }
        try {
          request = JSON.parse(frame.payload)
        } catch {
          continue
        }
        const method = String(request.method ?? '')
        const params = request.params ?? {}
        requests.push({ method, params })
        onRequest?.(method, params)
        const action = behavior(method)
        if (action === 'silent') continue
        if (action === 'drop') {
          socket.destroy()
          continue
        }
        if (action === 'error') {
          if (!socket.destroyed) {
            socket.write(encodeFrame(JSON.stringify({ id: request.id, error: { message: `${method} 失败` } })))
          }
          continue
        }
        const entry = results[method]
        const result =
          typeof entry === 'function'
            ? entry(params)
            : (entry ?? results[`${method}:${JSON.stringify(params)}`] ?? {})
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
        requests,
        push: (payload: unknown) => {
          for (const socket of sockets) {
            if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(payload)))
          }
        },
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

async function connect(
  behavior: Behavior | ((method: string) => Behavior) = 'respond',
  results: Results = {},
  onRequest?: (method: string, params: Record<string, unknown>) => void
) {
  const server = await startFakeCdp(typeof behavior === 'function' ? behavior : () => behavior, results, onRequest)
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

// ---------------------------------------------------------------- MCP 操作工具

/** 等到假服务端收到某条命令(事件订阅必须先于 push,否则会掉消息) */
async function waitForRequest(server: FakeServer, method: string, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (!server.requests.some((r) => r.method === method)) {
    if (Date.now() - started > timeoutMs) throw new Error(`假服务端没等到 ${method}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const METHODS = (server: FakeServer): string[] => server.requests.map((r) => r.method)

/** `Runtime.evaluate` 的返回体:页面脚本返回一个对象 */
const evaluateReturns = (value: unknown): Results => ({
  'Runtime.evaluate': { result: { type: 'object', value } }
})

describe('cdpSnapshot 元素快照', () => {
  it('注入核心 SNAPSHOT_FN,元素列表原样回传(与 browser_snapshot 同形状)', async () => {
    const { server, client } = await connect(
      'respond',
      evaluateReturns({ title: 'T', url: 'https://a/', elements: [{ tag: 'button', selector: '#go' }] })
    )
    expect(await cdpSnapshot(client, 50)).toEqual({
      ok: true,
      data: { title: 'T', url: 'https://a/', elements: [{ tag: 'button', selector: '#go' }] }
    })
    const call = server.requests[0]
    expect(call.method).toBe('Runtime.evaluate')
    expect(String(call.params.expression)).toContain('__mcpSnapshot__')
    expect(String(call.params.expression)).toContain('(50)')
    expect(call.params.returnByValue).toBe(true)
    client.close()
  })

  it('页面没给出 elements → 明确失败(不把空对象当成功)', async () => {
    const { client } = await connect('respond', evaluateReturns({ title: 'T' }))
    expect(await cdpSnapshot(client)).toEqual({ ok: false, error: '页面没有返回元素列表' })
    client.close()
  })
})

describe('cdpTap 点击', () => {
  it('给 selector:先量坐标再发 touchStart/touchEnd(CSS 像素,不乘 dpr)', async () => {
    const { server, client } = await connect('respond', evaluateReturns({ x: 100, y: 50 }))
    expect(await cdpTap(client, { selector: '#go' })).toEqual({ ok: true, mode: 'touch', x: 100, y: 50 })
    expect(METHODS(server)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchTouchEvent',
      'Input.dispatchTouchEvent'
    ])
    expect(String(server.requests[0].params.expression)).toContain('__bowDevicePoint__')
    expect(server.requests[1].params.type).toBe('touchStart')
    expect(server.requests[2].params.type).toBe('touchEnd')
    const points = server.requests[1].params.touchPoints as Array<Record<string, unknown>>
    expect(points[0]).toMatchObject({ x: 100, y: 50 })
    client.close()
  })

  it('给 x/y:不注入脚本,只发两个 touch 事件', async () => {
    const { server, client } = await connect()
    expect(await cdpTap(client, { x: 7.4, y: 8.6 })).toEqual({ ok: true, mode: 'touch', x: 7, y: 9 })
    expect(METHODS(server)).toEqual(['Input.dispatchTouchEvent', 'Input.dispatchTouchEvent'])
    client.close()
  })

  it('触摸被拒 → 先开触摸模拟再重试(chrome://inspect 的做法)', async () => {
    let touches = 0
    const { server, client } = await connect(
      (method) => {
        if (method !== 'Input.dispatchTouchEvent') return 'respond'
        touches += 1
        return touches === 1 ? 'error' : 'respond'
      },
      evaluateReturns({ x: 1, y: 2 })
    )
    expect(await cdpTap(client, { selector: '#go' })).toEqual({ ok: true, mode: 'touch', x: 1, y: 2 })
    expect(METHODS(server)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchTouchEvent',
      'Emulation.setTouchEmulationEnabled',
      'Input.dispatchTouchEvent',
      'Input.dispatchTouchEvent'
    ])
    expect(server.requests[2].params).toMatchObject({ enabled: true })
    client.close()
  })

  it('触摸与模拟都失败 → 退回鼠标,返回实际生效的 mode=mouse', async () => {
    const { server, client } = await connect(
      (method) =>
        method === 'Input.dispatchTouchEvent' || method === 'Emulation.setTouchEmulationEnabled'
          ? 'error'
          : 'respond',
      evaluateReturns({ x: 5, y: 6 })
    )
    expect(await cdpTap(client, { selector: '#go' })).toEqual({ ok: true, mode: 'mouse', x: 5, y: 6 })
    expect(METHODS(server)).toEqual([
      'Runtime.evaluate',
      'Input.dispatchTouchEvent',
      'Emulation.setTouchEmulationEnabled',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent'
    ])
    expect(server.requests[3].params).toMatchObject({ type: 'mousePressed', button: 'left', x: 5, y: 6 })
    client.close()
  })

  it('mode=mouse 直接走鼠标,不试触摸', async () => {
    const { server, client } = await connect()
    expect(await cdpTap(client, { x: 3, y: 4, mode: 'mouse' })).toEqual({ ok: true, mode: 'mouse', x: 3, y: 4 })
    expect(METHODS(server)).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'])
    client.close()
  })

  it('selector 与 x/y 同时给 / 都不给 → 参数错误且不发任何 CDP 命令', async () => {
    const { server, client } = await connect()
    expect(await cdpTap(client, { selector: '#go', x: 1, y: 2 })).toEqual({
      ok: false,
      error: 'selector 与 x/y 只能给一个'
    })
    expect(await cdpTap(client, {})).toEqual({
      ok: false,
      error: '要给 selector,或同时给 x 与 y(视口 CSS 像素)'
    })
    expect(server.requests).toHaveLength(0)
    client.close()
  })

  it('元素找不到(脚本返回 error)→ 顶层失败文案就用页面那句', async () => {
    const { client } = await connect('respond', evaluateReturns({ error: '未找到选择器: #nope' }))
    expect(await cdpTap(client, { selector: '#nope' })).toEqual({ ok: false, error: '未找到选择器: #nope' })
    client.close()
  })
})

describe('cdpType 输入', () => {
  it('先聚焦+全选,再 insertText,最后读回聚焦元素的值', async () => {
    const { server, client } = await connect('respond', {
      'Runtime.evaluate': (params) =>
        String(params.expression).includes('__bowDeviceFocus__')
          ? { result: { type: 'object', value: { selector: '#q', tag: 'input', cleared: true } } }
          : { result: { type: 'object', value: { value: 'hello' } } }
    })
    expect(await cdpType(client, { selector: '#q', text: 'hello' })).toEqual({ ok: true, value: 'hello' })
    expect(METHODS(server)).toEqual(['Runtime.evaluate', 'Input.insertText', 'Runtime.evaluate'])
    expect(server.requests[1].params).toEqual({ text: 'hello' })
    expect(String(server.requests[0].params.expression)).toContain('"#q", true')
    client.close()
  })

  it('clear:false → 不全选(保留原内容,插入到光标处)', async () => {
    const { server, client } = await connect('respond', {
      'Runtime.evaluate': (params) =>
        String(params.expression).includes('__bowDeviceFocus__')
          ? { result: { type: 'object', value: { cleared: false } } }
          : { result: { type: 'object', value: { value: 'ab' } } }
    })
    expect(await cdpType(client, { selector: '#q', text: 'b', clear: false })).toEqual({
      ok: true,
      value: 'ab'
    })
    expect(String(server.requests[0].params.expression)).toContain('"#q", false')
    client.close()
  })

  it('目标不是可输入元素 → 失败,且不插入任何文字', async () => {
    const { server, client } = await connect(
      'respond',
      evaluateReturns({ error: '目标不是可输入元素: div' })
    )
    expect(await cdpType(client, { selector: '#box', text: 'x' })).toEqual({
      ok: false,
      error: '目标不是可输入元素: div'
    })
    expect(METHODS(server)).toEqual(['Runtime.evaluate'])
    client.close()
  })
})

describe('cdpPressKey 按键', () => {
  it('Enter → keyDown 带 text "\\r" + keyUp', async () => {
    const { server, client } = await connect()
    expect(await cdpPressKey(client, 'enter')).toMatchObject({
      ok: true,
      key: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }
    })
    expect(METHODS(server)).toEqual(['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent'])
    expect(server.requests[0].params).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: '\r'
    })
    expect(server.requests[1].params).toMatchObject({ type: 'keyUp', key: 'Enter' })
    client.close()
  })

  it('方向键 → rawKeyDown(不产生字符)', async () => {
    const { server, client } = await connect()
    expect(await cdpPressKey(client, 'ArrowDown')).toMatchObject({ ok: true })
    expect(server.requests[0].params).toMatchObject({ type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown' })
    expect(server.requests[0].params.text).toBeUndefined()
    client.close()
  })

  it('不认识的键 → 失败且一条 CDP 命令都不发', async () => {
    const { server, client } = await connect()
    expect(await cdpPressKey(client, 'F5')).toMatchObject({ ok: false })
    expect(server.requests).toHaveLength(0)
    client.close()
  })
})

describe('cdpScroll 滚动', () => {
  it('复用核心 SCROLL_FN,回传 top', async () => {
    const { server, client } = await connect('respond', evaluateReturns({ top: 120 }))
    expect(await cdpScroll(client, { direction: 'down', amount: 100 })).toEqual({ ok: true, top: 120 })
    const expression = String(server.requests[0].params.expression)
    expect(expression).toContain('__mcpScroll__')
    expect(expression).toContain('"down", 100')
    client.close()
  })

  it('脚本报错(方向非法 / 元素不存在)→ 提升为失败', async () => {
    const { client } = await connect('respond', evaluateReturns({ error: '未找到选择器: #x' }))
    expect(await cdpScroll(client, { selector: '#x', direction: 'down' })).toEqual({
      ok: false,
      error: '未找到选择器: #x'
    })
    client.close()
  })
})

describe('cdpConsole 日志观测', () => {
  it('三类事件都收,条目按上限截断但 total 是窗口内真实条数', async () => {
    const { server, client } = await connect()
    const pending = cdpConsole(client, { durationMs: 60, maxEntries: 2 })
    await waitForRequest(server, 'Runtime.enable')
    server.push({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'a' }] } })
    server.push({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'boom' } } })
    server.push({ method: 'Log.entryAdded', params: { entry: { source: 'network', level: 'error', text: 'c' } } })
    const res = await pending
    expect(res).toMatchObject({ ok: true, total: 3, truncated: true })
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries.map((e) => e.text)).toEqual(['a', 'boom'])
    expect(res.entries.map((e) => e.source)).toEqual(['console', 'exception'])
    expect(METHODS(server)).toContain('Log.enable')
    client.close()
  })

  it('订阅在 enable 之前就位 —— enable 那一瞬间的日志不会漏(事件先于响应帧到达)', async () => {
    const holder: { server: FakeServer | null } = { server: null }
    const { server, client } = await connect('respond', {}, (method) => {
      if (method !== 'Runtime.enable') return
      holder.server?.push({
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [{ type: 'string', value: 'early' }] }
      })
    })
    holder.server = server
    const res = await cdpConsole(client, { durationMs: 60 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.entries.map((e) => e.text)).toContain('early')
    client.close()
  })

  it('reload:true → 先 Page.enable + Page.reload(抓加载期日志)', async () => {
    const { server, client } = await connect()
    const res = await cdpConsole(client, { durationMs: 50, reload: true })
    expect(res.ok).toBe(true)
    expect(METHODS(server)).toEqual(['Runtime.enable', 'Log.enable', 'Page.enable', 'Page.reload'])
    client.close()
  })

  it('两个 enable 都被拒 → 明确失败(不是空数组)', async () => {
    const { client } = await connect((method) =>
      method === 'Runtime.enable' || method === 'Log.enable' ? 'error' : 'respond'
    )
    expect(await cdpConsole(client, { durationMs: 50 })).toEqual({
      ok: false,
      error: '目标拒绝了 Runtime.enable 与 Log.enable,拿不到日志'
    })
    client.close()
  })
})
