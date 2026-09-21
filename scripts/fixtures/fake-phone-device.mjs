/**
 * 假「手机上的 DevTools 端点」:在一个端口上同时提供
 *   - HTTP `/json` 与 `/json/version`(发现阶段用)
 *   - WebSocket `/devtools/page/FAKE-TARGET-1`(CDP:Runtime.evaluate / Input.* / enable 系列)
 *
 * 每条收到的 CDP 命令都按行写进 `cdp-log.jsonl`,E2E 驱动据它断言「工具真的发对了命令」。
 * `Runtime.evaluate` 按**被注入的那个函数名**分发(快照 / 点定位 / 聚焦 / 读回 / 滚动),
 * 这样断言的就是真实插件代码发出去的那份脚本,而不是「大概调了 evaluate」。
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = process.env.BOW_E2E_DIR ?? join(tmpdir(), 'bow-e2e')
const CDP_LOG = `${DIR}/cdp-log.jsonl`
const port = Number(process.argv[2])
const TARGET_ID = 'FAKE-TARGET-1'

const SNAPSHOT = {
  title: '假设备上的 H5 页面',
  url: 'https://example.test/h5',
  elements: [
    { tag: 'button', id: 'go', text: '去下单', selector: '#go', visible: true },
    { tag: 'input', id: 'q', text: '', selector: '#q', visible: true }
  ]
}

function log(event) {
  appendFileSync(CDP_LOG, JSON.stringify(event) + '\n')
}

function encodeFrame(text) {
  const payload = Buffer.from(text)
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

function decodeFrames(buffer) {
  const frames = []
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
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    }
    frames.push({ opcode, payload: payload.toString('utf8') })
    rest = rest.subarray(offset + length)
  }
  return { frames, rest }
}

function json(res, body) {
  const text = JSON.stringify(body)
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const server = createServer((req, res) => {
  const url = String(req.url ?? '')
  if (url.startsWith('/json/version')) {
    json(res, {
      Browser: 'Chrome/138.0.7204.179',
      'Android-Package': 'com.example.fake',
      'Protocol-Version': '1.3'
    })
    return
  }
  if (url.startsWith('/json')) {
    json(res, [
      {
        id: TARGET_ID,
        type: 'page',
        title: '假设备上的 H5 页面',
        url: 'https://example.test/h5',
        webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/${TARGET_ID}`
      }
    ])
    return
  }
  res.writeHead(404)
  res.end('nope')
})

server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1')
    .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  // 注意:不回 permessage-deflate(不回 = 客户端就不会压缩,省掉解压逻辑)
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  )

  let buffer = Buffer.alloc(0)
  let focusedValue = ''
  const push = (method, params) => {
    if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify({ method, params })))
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    const { frames, rest } = decodeFrames(buffer)
    buffer = rest
    for (const frame of frames) {
      if (frame.opcode === 8) {
        socket.destroy()
        continue
      }
      if (frame.opcode !== 1 || !frame.payload) continue
      let command
      try {
        command = JSON.parse(frame.payload)
      } catch {
        continue
      }
      const method = String(command.method ?? '')
      const params = command.params ?? {}
      log({ t: Date.now(), method, params })
      const reply = (result) => {
        if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify({ id: command.id, result })))
      }
      const expression = String(params.expression ?? '')

      switch (method) {
        case 'Runtime.evaluate': {
          if (expression.includes('__mcpSnapshot__')) reply({ result: { type: 'object', value: SNAPSHOT } })
          else if (expression.includes('__bowDevicePoint__')) reply({ result: { type: 'object', value: { x: 120, y: 240 } } })
          else if (expression.includes('__bowDeviceFocus__'))
            reply({ result: { type: 'object', value: { selector: '#q', tag: 'input', cleared: true } } })
          else if (expression.includes('__bowDeviceReadFocused__'))
            reply({ result: { type: 'object', value: { value: focusedValue } } })
          else if (expression.includes('__mcpScroll__')) reply({ result: { type: 'object', value: { top: 321 } } })
          else reply({ result: { type: 'object', value: null } })
          break
        }
        case 'Runtime.enable': {
          reply({})
          push('Runtime.consoleAPICalled', {
            type: 'error',
            args: [{ type: 'string', value: '来自假设备的日志' }, { type: 'number', value: 42 }],
            timestamp: 1,
            stackTrace: {
              callFrames: [{ functionName: 'boom', url: 'https://example.test/app.js', lineNumber: 9, columnNumber: 0 }]
            }
          })
          push('Runtime.exceptionThrown', {
            timestamp: 2,
            exceptionDetails: {
              text: 'Uncaught',
              exception: { description: 'Error: 假异常' },
              url: 'https://example.test/app.js',
              lineNumber: 19
            }
          })
          break
        }
        case 'Log.enable': {
          reply({})
          push('Log.entryAdded', {
            entry: {
              source: 'network',
              level: 'error',
              text: 'Failed to load resource',
              url: 'https://example.test/x.png',
              lineNumber: 0,
              timestamp: 3
            }
          })
          break
        }
        case 'Input.insertText': {
          focusedValue = String(params.text ?? '')
          reply({})
          break
        }
        default: {
          // Input.dispatchTouchEvent / dispatchMouseEvent / dispatchKeyEvent / Emulation.* / Page.* 都只需要一个空回执
          reply({})
        }
      }
    }
  })
  socket.on('error', () => socket.destroy())
})

server.listen(port, '127.0.0.1', () => {
  log({ t: Date.now(), event: 'listen', port })
})
