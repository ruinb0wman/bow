#!/usr/bin/env node
/**
 * 局域网远程控制的端到端验证(真 Electron + 真 pty + 真 WS 客户端)。
 *
 * 覆盖的链路:设置开关 → 监听 → `/login` 拿 cookie → WS 握手鉴权 → hello/attach/input/read/
 * resize/create/close → hub 把 pty 输出转回客户端 → 关闭会话时标签一起收。
 *
 * 为什么必须真跑(unittest 盖不到):
 * - 握手阶段的鉴权(路径 / cookie / Origin)只有真握手才走得到,`upgrade` 里出错的表现是「连不上」;
 * - cookie 是浏览器**自动**带的,curl/ws 客户端要手动带 —— 两种都得对;
 * - 「远程输入 → pty → 回显 → hub → 客户端」这条环要真的 shell 才能验。
 *
 * 用法(需先 `npm run build`):
 * ```bash
 * npm run test:e2e:remote
 * ```
 * 造物在 `$TMPDIR/bow-e2e`,独立 userData / 调试端口 / 临时口令,不会碰你正在跑的 bow。
 */

import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = process.env.BOW_E2E_DIR ?? join(tmpdir(), 'bow-e2e')
const run = process.pid
const userdata = join(dir, `remote-userdata-${run}`)
const debugPort = 9200 + (run % 200)
const electron = createRequire(import.meta.url)('electron')
const PASSWORD = `e2e-remote-${run}-pass`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

function check(cond, label, detail) {
  if (cond) console.log(`✓ ${label}`)
  else {
    failures += 1
    console.error(`✗ ${label}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
  }
}

async function waitFor(predicate, timeoutMs = 20000, stepMs = 150) {
  const started = Date.now()
  for (;;) {
    let value
    try {
      value = await predicate()
    } catch {
      value = null
    }
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(stepMs)
  }
}

/** 拿一个「现在大概没人用」的端口(设置里不接受 0) */
async function freePort() {
  const srv = createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = srv.address().port
  await new Promise((r) => srv.close(() => r()))
  return port
}

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('✗ 没找到 out/main/index.js —— 先跑 `npm run build`')
  process.exit(1)
}

mkdirSync(dir, { recursive: true })
rmSync(userdata, { recursive: true, force: true })
mkdirSync(userdata, { recursive: true })

const child = spawn(
  electron,
  ['.', '--no-sandbox', '--ozone-platform=headless', `--user-data-dir=${userdata}`, `--remote-debugging-port=${debugPort}`],
  { cwd: root, stdio: 'ignore' }
)

async function cleanup() {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      /* 已经没了 */
    }
  } else {
    try {
      process.kill(child.pid, 'SIGTERM')
    } catch {
      /* 已经没了 */
    }
    await sleep(800)
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
  await sleep(400)
  rmSync(userdata, { recursive: true, force: true })
}

const targets = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
  } catch {
    return []
  }
}

/** 在 chrome 页面里跑表达式(插件 IPC 与标签列表都在那边) */
async function evalOn(wsUrl, expression) {
  const ws = new WebSocket(wsUrl)
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', () => reject(new Error('连不上 target')))
      setTimeout(() => reject(new Error('连 target 超时')), 5000)
    })
    return await new Promise((resolve, reject) => {
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data))
        if (message.id !== 1) return
        if (message.error) reject(new Error(message.error.message))
        else if (message.result?.exceptionDetails) {
          reject(new Error(message.result.exceptionDetails.exception?.description ?? '页面里抛了异常'))
        } else resolve(message.result?.result?.value)
      }
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
      setTimeout(() => reject(new Error('evaluate 超时')), 15000)
    })
  } finally {
    ws.close()
  }
}

/** 连远程 WS,收集消息(与 tests/terminalRemoteProtocol.test.ts 同一个套路,但走真网络) */
async function connectWs(url, headers = {}) {
  const ws = new WebSocket(url, { headers })
  const queue = []
  const waiters = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    const i = waiters.findIndex((w) => w.match(msg))
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg)
    else queue.push(msg)
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    setTimeout(() => reject(new Error('WS 连接超时')), 8000)
  })
  return {
    ws,
    next(match, timeoutMs = 15000) {
      const i = queue.findIndex(match)
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等 WS 消息超时')), timeoutMs)
        waiters.push({
          match,
          resolve: (m) => {
            clearTimeout(timer)
            resolve(m)
          }
        })
      })
    },
    /** 收集直到出现 needle 为止(用于 pty 回显) */
    async collectUntil(needle, timeoutMs = 20000) {
      let text = ''
      const started = Date.now()
      for (;;) {
        if (text.includes(needle)) return text
        if (Date.now() - started > timeoutMs) return text
        try {
          const msg = await this.next((m) => m.t === 'data', 1000)
          text += msg.chunk
        } catch {
          /* 这一秒没数据,继续等 */
        }
      }
    },
    close: () => ws.close()
  }
}

async function http(url, opts = {}) {
  const res = await fetch(url, opts)
  const text = await res.text()
  return { status: res.status, headers: res.headers, text }
}

try {
  const chromeWs = await waitFor(async () => {
    const t = (await targets()).find((t) => /\/renderer\/index\.html/.test(t.url ?? ''))
    return t?.webSocketDebuggerUrl ?? null
  }, 30000)
  if (!chromeWs) throw new Error('等不到 chrome 页面')
  const ready = await waitFor(
    async () => (await evalOn(chromeWs, `typeof window.browserAPI?.plugins?.invoke === 'function'`)) === true,
    30000
  )
  if (!ready) throw new Error('chrome 页面里没有 window.browserAPI')

  // ---------- ① 打开远程服务(走设置 + applyRemote,和将来的设置页同一条路) ----------
  const port = await freePort()
  const status = await evalOn(
    chromeWs,
    `(async () => {
       await window.browserAPI.plugins.invoke('terminal','setSettings',{ remote: {
         enabled: true, bind: 'loopback', port: ${port}, password: ${JSON.stringify(PASSWORD)}
       }})
       return await window.browserAPI.plugins.invoke('terminal','applyRemote')
     })()`
  )
  check(status?.running === true, '远程服务已在回环上启动', status)
  check(status?.port === port, `监听的是设置里的端口 ${port}`, status?.port)
  const base = status.url
  const wsUrl = `ws://127.0.0.1:${port}/ws`

  // ---------- ② 探活与鉴权 ----------
  const health = await http(`${base}/healthz`)
  check(health.status === 200, '/healthz 公开可读', health.status)

  const noAuth = await http(`${base}/api/sessions`)
  check(noAuth.status === 401, '未登录读台账 → 401', noAuth.status)

  const badLogin = await http(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'nope-nope-nope' })
  })
  check(badLogin.status === 401, '错误口令 → 401', badLogin.status)

  const login = await http(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD })
  })
  check(login.status === 204, '正确口令 → 204', login.status)
  const setCookie = login.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]
  check(cookie.startsWith('bow_remote='), '拿到登录 cookie', cookie.slice(0, 24))
  check(!/Secure/i.test(setCookie), 'cookie 不带 Secure(局域网是 http)')

  const authed = await http(`${base}/api/sessions`, { headers: { cookie } })
  check(authed.status === 200, '带 cookie 读台账 → 200', authed.status)

  // ---------- ③ WS 握手:没 cookie / 跨站 Origin 都拒 ----------
  let rejected = false
  try {
    await connectWs(wsUrl)
  } catch {
    rejected = true
  }
  check(rejected, '没 cookie 的 WS 握手被拒')

  rejected = false
  try {
    await connectWs(wsUrl, { cookie, origin: 'http://evil.example' })
  } catch {
    rejected = true
  }
  check(rejected, '跨站 Origin 的 WS 握手被拒')

  // ---------- ④ 正常会话:hello → create → attach → input → read → resize → close ----------
  const client = await connectWs(wsUrl, { cookie })
  const hello = await client.next((m) => m.t === 'hello')
  check(hello.service === 'bow-terminal-remote', 'hello 带上服务名', hello.service)
  check(Array.isArray(hello.sessions) && hello.sessions.length === 0, 'hello 带当前台账(空)', hello.sessions)

  const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash'
  client.ws.send(JSON.stringify({ t: 'create', command: shell, name: 'e2e-remote' }))
  const created = await client.next((m) => m.t === 'created')
  check(Number.isInteger(created.id), 'create 回 created + id', created)
  const id = created.id

  const listed = await client.next((m) => m.t === 'sessions' && m.sessions.some((s) => s.id === id))
  check(listed.sessions.length === 1, '台账推送里出现新会话', listed.sessions.map((s) => s.id))

  client.ws.send(JSON.stringify({ t: 'attach', id, cols: 100, rows: 30 }))
  const attached = await client.next((m) => m.t === 'attached')
  check(attached.id === id && attached.cols === 100 && attached.rows === 30, 'attach 回来回放与尺寸', {
    cols: attached.cols,
    rows: attached.rows,
    replayLen: attached.replay.length
  })

  client.ws.send(JSON.stringify({ t: 'input', id, data: 'echo REMOTE_OK\r' }))
  const echoed = await client.collectUntil('REMOTE_OK')
  check(echoed.includes('REMOTE_OK'), '远程输入的字节经 pty 回显回来')

  client.ws.send(JSON.stringify({ t: 'read', id, chars: 4000 }))
  const read = await client.next((m) => m.t === 'read')
  check((read.text ?? '').includes('REMOTE_OK'), 'read 拿到尾部文本')

  client.ws.send(JSON.stringify({ t: 'resize', id, cols: 120, rows: 40 }))
  const resized = await client.next(
    (m) => m.t === 'sessions' && m.sessions.some((s) => s.id === id && s.cols === 120 && s.rows === 40)
  )
  check(resized.sessions[0].cols === 120, 'resize 落到台账(最后一个 resize 者胜)')

  // 关会话:closed 事件 + 标签一起消失(客户端的心智:一个标签就是一个会话)
  client.ws.send(JSON.stringify({ t: 'close', id }))
  const closed = await client.next((m) => m.t === 'closed')
  check(closed.id === id, 'close 回 closed 事件', closed)

  const tabGone = await waitFor(async () => {
    const tabs = await evalOn(chromeWs, `window.browserAPI.listTabs()`)
    return tabs.some((t) => t.id === id) === false
  })
  check(tabGone === true, '被关会话的终端标签也关掉了')

  const empty = await waitFor(async () => {
    const res = await http(`${base}/healthz`)
    return JSON.parse(res.text).sessions === 0
  })
  check(empty === true, '会话清零(/healthz 的数量跟着变)')

  client.close()

  // ---------- ⑤ 关掉远程服务后端口真的放开 ----------
  const off = await evalOn(
    chromeWs,
    `(async () => {
       await window.browserAPI.plugins.invoke('terminal','setSettings',{ remote: { enabled: false } })
       return await window.browserAPI.plugins.invoke('terminal','applyRemote')
     })()`
  )
  check(off?.running === false, '关掉开关后服务停止', off)
  // 用裸 TCP 判「端口放开了没」:fetch 可能被本机代理接住(拿到 502 而不是拒绝)
  const refused = await waitFor(
    async () =>
      new Promise((resolve) => {
        const socket = connect({ port, host: '127.0.0.1' })
        socket.once('connect', () => {
          socket.destroy()
          resolve(null)
        })
        socket.once('error', () => resolve(true))
      }),
    5000
  )
  check(refused === true, '端口不再接受连接')
} catch (e) {
  failures += 1
  console.error(`✗ e2e 中断:${e instanceof Error ? e.message : String(e)}`)
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 处失败`)
process.exit(failures === 0 ? 0 : 1)
