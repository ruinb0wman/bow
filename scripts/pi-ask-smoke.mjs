#!/usr/bin/env node
/**
 * 「手机回答 pi 的提问」冒烟(真 pi + 真扩展 + 假 bow 服务)。
 *
 * 这一段要验的正是 P1 的那个未知数:`ctx.ui.confirm` 被我们的扩展包住之后,
 * **别的扩展**发起的提问会不会也被拦到手机上(pi 是否给每个扩展发同一个 `ctx.ui` 对象)。
 *
 * 两个场景:
 * A. 手机答 → confirm 的返回值来自手机(true);终端那一路的原始对话框仍被请求过(不会断);
 * B. 手机不答、终端答(模拟人在电脑上点)→ 返回值来自终端(false)。
 *
 * 不需要模型:探针扩展在 `session_start` 之后自己弹一个 confirm,不跑 agent。
 *
 * 用法:
 * ```bash
 * npm run test:pi:ask
 * ```
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

const EXTENSION = new URL('../packages/pi-bow/extensions/bow-agent-state.ts', import.meta.url).pathname
const SESSION_ID = '1'
const TOKEN = 'ask-token'
const TITLE = '要跑一下测试吗?'
const MESSAGE = '这会执行 npm test'

const checks = []
function check(ok, label, detail) {
  checks.push({ ok: Boolean(ok), label })
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 探针扩展:它**不是** bow 的扩展,而是「另一个扩展」(相当于 ask_user_question / 权限门)。
 * 结果写到文件里 —— 它自己拿不到 bow 的连接。
 */
const PROBE_SOURCE = `
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { appendFileSync } from 'node:fs'
const OUT = process.env.PROBE_OUT
const log = (o: unknown) => appendFileSync(String(OUT), JSON.stringify(o) + '\\n')

export default function (pi: ExtensionAPI) {
  let fired = false
  pi.on('session_start', (_event, ctx) => {
    if (fired) return
    fired = true
    setTimeout(async () => {
      try {
        if (process.env.PROBE_MODE === 'custom-then-select') {
          // 模拟 ask_user_question 的走法:先 custom(它在 bow 里返回 undefined),
          // 再退回 select —— 这才是手机上能答的那条路。
          const custom = await (ctx as any).ui.custom(() => ({ render: () => [] }))
          log({ t: 'custom', result: custom === undefined ? 'undefined' : typeof custom })
          if (custom === undefined) {
            const picked = await (ctx as any).ui.select('选一个继续', ['甲', '乙'])
            log({ t: 'select', answer: picked })
          }
          return
        }
        const answer = await (ctx as any).ui.confirm(${JSON.stringify(TITLE)}, ${JSON.stringify(MESSAGE)}, { timeout: 25000 })
        log({ t: 'confirm', answer })
      } catch (err) {
        log({ t: 'confirm-error', err: String(err) })
      }
    }, 4000)
  })
}
`

/** 起一个假 bow:收 ask、可回 answer */
async function startFakeBow() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => wss.once('listening', resolve))
  const t0 = Date.now()
  const state = { port: wss.address().port, asks: [], socket: null, handshake: '', answered: 0, timeline: [] }
  wss.on('connection', (ws, req) => {
    state.socket = ws
    state.handshake = String(req.url ?? '')
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg.type === 'ask') {
          state.asks.push(msg.ask)
          state.timeline.push(`${Date.now() - t0}ms 收到 ask ${msg.ask.kind}`)
        }
        if (msg.type === 'message' || msg.type === 'state') state.timeline.push(`${Date.now() - t0}ms ${msg.type}`)
      } catch {
        /* 坏帧忽略 */
      }
    })
  })
  return {
    state,
    answer(requestId, value) {
      state.socket.send(JSON.stringify({ type: 'answer', requestId, value }))
      state.answered += 1
    },
    close() {
      for (const ws of wss.clients) ws.close()
      wss.close()
    }
  }
}

function readLog(out) {
  if (!existsSync(out)) return []
  return readFileSync(out, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** 跑一个场景,返回 { asks, log, terminalReplies } */
async function scenario(name, { answerOnPhone, mode, expectKind = 'confirm' }) {
  const dir = mkdtempSync(join(tmpdir(), 'bow-ask-'))
  const probePath = join(dir, 'probe.ts')
  const outPath = join(dir, 'probe.log')
  writeFileSync(probePath, PROBE_SOURCE)
  const bow = await startFakeBow()

  const child = spawn(
    'pi',
    ['--mode', 'rpc', '--no-session', '--extension', EXTENSION, '--extension', probePath],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BOW_TERMINAL: '1',
        BOW_SESSION_ID: SESSION_ID,
        BOW_REMOTE_URL: `ws://127.0.0.1:${bow.state.port}/ws`,
        BOW_CONTROL_TOKEN: TOKEN,
        PROBE_OUT: outPath,
        ...(mode ? { PROBE_MODE: mode } : {}),
        // ⚠️ 必须隔离 agent 目录:否则 pi 还会加载 `~/.pi/agent/extensions/` 里**已装的那一份**,
        // 同一个会话就有两个对话桥(两次包装 → 一次提问出现两条 extension_ui_request,结果随机)。
        // 这个冒烟不需要模型,用空目录正好。
        PI_CODING_AGENT_DIR: dir
      }
    }
  )

  const terminalRequests = []
  let stdoutBuffer = ''
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += String(chunk)
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      // 终端那一路:pi 自己的 extension_ui_request。手机不答时由这里回。
      if (record.type === 'extension_ui_request') {
        terminalRequests.push(record)
        terminalRequests.push(record)
        if (!answerOnPhone) {
          child.stdin.write(
            JSON.stringify({ type: 'extension_ui_response', id: record.id, confirmed: false }) + '\n'
          )
        }
      }
    }
  })

  try {
    // 等「手机上出现提问」
    const deadline = Date.now() + 45_000
    while (bow.state.asks.length === 0 && Date.now() < deadline) await sleep(100)
    const ask = bow.state.asks[0]
    if (ask && answerOnPhone) bow.answer(ask.requestId, expectKind === 'select' ? '乙' : true)

    // 等探针记下结论
    let result = null
    const until = Date.now() + 30_000
    while (!result && Date.now() < until) {
      const hit = readLog(outPath).find((r) => ['confirm', 'confirm-error', 'custom', 'select'].includes(r.t) && r.t !== 'custom')
      if (hit) result = hit
      else await sleep(100)
    }
    return { name, ask, result, terminalRequests, handshake: bow.state.handshake, timeline: bow.state.timeline }
  } finally {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已经退了 */
    }
    bow.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  // ---------- A:手机答 ----------
  const a = await scenario('A', { answerOnPhone: true })
  check(a.handshake.includes('role=pi'), 'A:扩展仍按约定连上 bow', a.handshake)
  check(a.ask?.kind === 'confirm', 'A:别的扩展发起的 confirm 被拦到手机上了', a.ask)
  check(a.ask?.title === TITLE, 'A:题面标题正确', a.ask?.title)
  check(a.ask?.message === MESSAGE, 'A:题面正文正确', a.ask?.message)
  check(a.terminalRequests.length > 0, 'A:终端那一路的原始对话框仍被请求过(终端没被切断)', a.terminalRequests.length)
  if (a.result?.answer !== true) {
    console.log('  时间线:', a.timeline)
    console.log('  终端的 extension_ui_request:', a.terminalRequests.map((r) => ({ id: r.id, method: r.method, title: r.title })))
  }
  check(a.result?.answer === true, 'A:confirm 的返回值来自手机(true)', a.result)

  // ---------- C:custom → 回退到 select(ask_user_question 那条路) ----------
  const c = await scenario('C', { answerOnPhone: true, mode: 'custom-then-select', expectKind: 'select' })
  check(c.ask?.kind === 'select', 'C:custom 返回 undefined 后,回退的 select 到了手机', c.ask?.kind)
  check(c.ask?.options?.length === 2, 'C:选项一起过去了', c.ask?.options)
  check(c.result?.answer === '乙', 'C:手机选的选项成了 select 的返回值', c.result)

  // ---------- B:手机不答,终端答 ----------
  const b = await scenario('B', { answerOnPhone: false })
  check(b.ask?.kind === 'confirm', 'B:提问同样到了手机(只是没人答)', b.ask)
  check(b.result?.answer === false, 'B:没人答手机时,终端回的值生效(false)', b.result)
}

main()
  .catch((e) => check(false, '冒烟跑完', e instanceof Error ? e.message : String(e)))
  .finally(() => {
    const failed = checks.filter((c) => !c.ok)
    console.log(failed.length ? `\n失败 ${failed.length} 项` : `\n全部通过(${checks.length} 项)`)
    process.exit(failed.length ? 1 : 0)
  })
