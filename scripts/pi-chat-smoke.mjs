#!/usr/bin/env node
/**
 * 对话桥冒烟(真 pi + 真扩展 + 假 bow 服务)。
 *
 * 为什么 vitest 盖不到:`tests/terminalRemoteChat.test.ts` 用的是假 pi 客户端,验的是
 * 「协议与路由」;这里验的是**另一半** —— 真 pi 里的扩展会不会按约定连上来、把消息吐出来、
 * 把手机的话变成一轮 agent 运行。
 *
 * 用 `pi --mode rpc` 而不是 TUI:扩展 API 是同一套(`sendUserMessage` / 事件 / ctx.abort),
 * 但 RPC 模式没有 TUI 重绘的干扰,能干净地断言「收到哪几条记录」。
 *
 * 用法(需要一个能跑 pi 的环境 + 模型凭据):
 * ```bash
 * npm run test:pi:chat
 * ```
 * 会真的调用一次模型(极小 prompt),耗时约 10–40 秒。
 */

import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'

const EXTENSION = new URL('../packages/pi-bow/extensions/bow-agent-state.ts', import.meta.url).pathname
const SESSION_ID = '1'
const TOKEN = 'smoke-token'
const PROMPT = '只回复 PONG 这四个字母,不要别的'

const checks = []
function check(ok, label, detail) {
  checks.push({ ok: Boolean(ok), label, detail })
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms))
  ])
}

async function main() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => wss.once('listening', resolve))
  const port = wss.address().port

  /** 扩展发来的记录;以及一个等待器 */
  const received = []
  const waiters = []
  function push(record) {
    received.push(record)
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(record)) {
        const [w] = waiters.splice(i, 1)
        clearTimeout(w.timer)
        w.resolve(record)
      }
    }
  }
  function waitFor(match, ms, label) {
    const hit = received.find(match)
    if (hit) return Promise.resolve(hit)
    return withTimeout(
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((w) => w.resolve === resolve)
          if (index >= 0) waiters.splice(index, 1)
        }, ms)
        waiters.push({ match, resolve, timer })
      }),
      ms,
      label
    )
  }

  let piSocket = null
  let handshakeUrl = ''
  let handshakeOk = false
  wss.on('connection', (ws, req) => {
    handshakeUrl = String(req.url ?? '')
    const url = new URL(handshakeUrl, `http://127.0.0.1:${port}`)
    handshakeOk =
      url.searchParams.get('role') === 'pi' &&
      url.searchParams.get('session') === SESSION_ID &&
      url.searchParams.get('token') === TOKEN
    piSocket = ws
    ws.on('message', (raw) => {
      try {
        push(JSON.parse(String(raw)))
      } catch {
        /* 坏帧忽略 */
      }
    })
    // 真 bow 在握手后立刻请求历史
    ws.send(JSON.stringify({ type: 'history' }))
  })

  const child = spawn('pi', ['--mode', 'rpc', '--no-session', '--extension', EXTENSION], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BOW_TERMINAL: '1',
      BOW_SESSION_ID: SESSION_ID,
      BOW_REMOTE_URL: `ws://127.0.0.1:${port}/ws`,
      BOW_CONTROL_TOKEN: TOKEN
    }
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += String(d)
  })

  try {
    // ① 扩展按约定连上来
    await waitFor(() => true, 30_000, '等扩展连接').catch(() => null)
    await withTimeout(
      new Promise((resolve) => {
        const timer = setInterval(() => {
          if (piSocket) {
            clearInterval(timer)
            resolve()
          }
        }, 100)
        setTimeout(() => {
          clearInterval(timer)
          resolve()
        }, 30_000)
      }),
      31_000,
      '等扩展连接'
    )
    check(piSocket !== null, '扩展连上了 bow 的 WS')
    if (!piSocket) {
      console.log('— pi stderr —\n' + stderr.slice(-2000))
      return
    }
    check(handshakeOk, '握手带上了 role=pi / session / token', handshakeUrl)

    // ② 收到 history 后回一份快照(空会话也要回,手机靠它判断 live)
    const snapshot = await waitFor((r) => r.type === 'snapshot', 20_000, '等 snapshot')
    check(Array.isArray(snapshot.messages), '收到 snapshot(带 messages 数组)', snapshot)

    // ③ 手机发话 → pi 真的跑起来(忙状态 + 用户消息回显 + 助手回复)
    piSocket.send(JSON.stringify({ type: 'prompt', text: PROMPT }))
    const busy = await waitFor((r) => r.type === 'state' && r.busy === true, 20_000, '等 busy')
    check(busy.busy === true, '发话后收到 busy 状态')

    const echoed = await waitFor(
      (r) => r.type === 'message' && r.message?.role === 'user' && String(r.message.text ?? '').includes('PONG'),
      20_000,
      '等用户消息回显'
    )
    check(echoed.message.role === 'user', '自己发的话作为 user 消息回到手机(输入真的进了 agent)')

    const reply = await waitFor(
      (r) => r.type === 'message' && r.message?.role === 'assistant' && String(r.message.text ?? '').length > 0,
      120_000,
      '等助手回复'
    )
    check(/PONG/.test(String(reply.message.text)), '收到助手的结构化回复(不是终端字节)', reply.message.text)

    const idle = await waitFor((r) => r.type === 'state' && r.busy === false, 60_000, '等 settle')
    check(idle.busy === false, '这一轮结束后回到 idle')
  } finally {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已经退了 */
    }
    for (const ws of wss.clients) ws.close()
    wss.close()
  }
}

main()
  .catch((e) => {
    check(false, '冒烟跑完', e instanceof Error ? e.message : String(e))
  })
  .finally(() => {
    const failed = checks.filter((c) => !c.ok)
    console.log(failed.length ? `\n失败 ${failed.length} 项` : `\n全部通过(${checks.length} 项)`)
    process.exit(failed.length ? 1 : 0)
  })
