#!/usr/bin/env node
/**
 * 局域网远程控制的端到端验证(真 Electron + 真 pty + 真 WS 客户端)。
 *
 * 覆盖的链路:设置开关 → 监听 → `/login` 拿 cookie → WS 握手鉴权 → hello/attach/input/read/
 * resize/create/close → hub 把 pty 输出转回客户端 → 关闭会话时标签一起收 →
 * 手机页(对话视图,不再是 xterm)。
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
/**
 * 调试端口必须**真的空着**:固定公式(9200 + pid%200)会撞上一轮没退干净的 Electron,
 * 那时 `targets()` 连到的是**旧实例** —— 表现是「create 之后等不到 created」这种莫名超时。
 */
const debugPort = await freePort()
/** 跨平台:从 WSL 用 Windows 的 node 跑时,ELECTRON_BIN 指向 electron.exe;headless 只在 Linux 有 */
const isWin = process.platform === 'win32' || /\.exe$/i.test(process.env.ELECTRON_BIN ?? '')
const electron =
  process.env.ELECTRON_BIN || (isWin
    ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : createRequire(import.meta.url)('electron'))
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
  ['.', '--no-sandbox', ...(isWin ? [] : ['--ozone-platform=headless']), `--user-data-dir=${userdata}`, `--remote-debugging-port=${debugPort}`],
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

/** 发一条任意 CDP 命令(Runtime.evaluate 之外的域,例如 Input.dispatchMouseEvent) */
async function cdpCall(wsUrl, method, params = {}) {
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
        else resolve(message.result)
      }
      ws.send(JSON.stringify({ id: 1, method, params }))
      setTimeout(() => reject(new Error(`${method} 超时`)), 8000)
    })
  } finally {
    ws.close()
  }
}

/** 在页面里用**真鼠标事件**点一个元素(合成 click 不会触发焦点变化,验不出抢焦点) */
async function realClick(wsUrl, selector) {
  const box = await evalOn(
    wsUrl,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)})
       if (!el) return null
       const r = el.getBoundingClientRect()
       return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
     })()`
  )
  if (!box) throw new Error(`找不到元素:${selector}`)
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 }
  await cdpCall(wsUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await cdpCall(wsUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

/** 连远程 WS,收集消息(与 tests/terminalRemoteProtocol.test.ts 同一个套路,但走真网络) */
async function connectWs(url, headers = {}) {
  const ws = new WebSocket(url, { headers })
  const queue = []
  const waiters = []
  let lastSessions = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.t === 'sessions' || msg.t === 'hello') lastSessions = msg.sessions ?? []
    const i = waiters.findIndex((w) => w.match(msg))
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg)
    else queue.push(msg)
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    setTimeout(() => reject(new Error('WS 连接超时')), 8000)
  })
  // 握手成功但一条消息都没来,说明服务那头刚重启过(applyRemote 会断开在线的连接)。
  // 推一下 `list` 让连接重新有动静;还不行就明确报错,而不是让后面的断言各自超时。
  let heard = false
  ws.on('message', () => {
    heard = true
  })
  for (const delay of [1500, 3000]) {
    await new Promise((r) => setTimeout(r, delay))
    if (heard) break
    try {
      ws.send(JSON.stringify({ t: 'list' }))
    } catch {
      /* 已经关了 */
    }
  }
  if (!heard) throw new Error('WS 连上了但服务端一条消息都没发(服务刚重启?)')
  return {
    ws,
    get lastSessions() {
      return lastSessions
    },
    next(match, timeoutMs = 15000) {
      const i = queue.findIndex(match)
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise((resolve, reject) => {
        // ⚠️ 超时必须把这个 waiter **从数组里摘掉**:否则它留着继续拦截后续消息,
        // 把匹配到的帧直接吞掉(已拒绝的 promise 再 resolve 是空操作)—— 实测就是
        // 「明明收到了 sessions,却一直等不到」这部份莫名超时的真凶。
        const waiter = {
          match,
          resolve: (m) => {
            clearTimeout(timer)
            resolve(m)
          }
        }
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter)
          if (at >= 0) waiters.splice(at, 1)
          const seen = queue.slice(-6).map((m) => m.t ?? m.type ?? '?')
          reject(
            new Error(
              `等 WS 消息超时(已收到:${seen.join(',') || '无'})` +
                (queue.some((m) => m.t === 'error')
                  ? ` · error=${queue.filter((m) => m.t === 'error').pop().message}`
                  : '')
            )
          )
        }, timeoutMs)
        waiters.push(waiter)
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

  // 用**拉**的方式等,而不是只等那次广播:`notifySessions` 有 250ms 合批,
  // 偶尔会和「刚 open 的连接」错开(表现为「等 sessions 超时」)。
  let listed = null
  for (let i = 0; i < 40 && !listed; i++) {
    client.ws.send(JSON.stringify({ t: 'list' }))
    try {
      const hit = await client.next((m) => m.t === 'sessions' && m.sessions.some((s) => s.id === id), 1000)
      listed = hit
    } catch {
      /* 这一秒没有,继续拉 */
    }
  }
  if (listed === null) {
    const seen = await http(`${base}/api/sessions`, { headers: { cookie } })
    console.log('  诊断:created.id =', id, '| 最后一次 sessions =', JSON.stringify(client.lastSessions.map((s) => s.id)), '| /api/sessions =', seen.text.slice(0, 200))
  }
  check(listed !== null, '台账里出现新会话(pty 起来了)', listed?.sessions.map((s) => s.id))

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

  // 电脑端终端页挂载时会 fit 一次(84×28),可能**晚于**这次远程 resize 到达 ——
  // 「最后一个 resize 者胜」会把它盖回去。这是约定好的行为,所以这里允许重试。
  let resized = null
  for (let attempt = 0; attempt < 3 && !resized; attempt += 1) {
    client.ws.send(JSON.stringify({ t: 'resize', id, cols: 120, rows: 40 }))
    try {
      resized = await client.next(
        (m) => m.t === 'sessions' && m.sessions.some((s) => s.id === id && s.cols === 120 && s.rows === 40),
        2500
      )
    } catch {
      /* 可能被电脑端的 fit 盖回去了,再来一次 */
    }
  }
  check(resized !== null, 'resize 落到台账(最后一个 resize 者胜)', client.lastSessions.map((s) => `${s.id}:${s.cols}x${s.rows}`))

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

  // ---------- ⑤ 远程页本身(真浏览器上下文,无 preload) ----------
  // 这一段才是「手机上真的能用」的证据:bundle 在普通页面里跑得起来、登录表单能提交、
  // WS 连上、会话行点进去是**对话页**(不再渲染 xterm)。
  const pageUrl = `${base}/`
  const pageTab = await evalOn(chromeWs, `window.browserAPI.createTab(${JSON.stringify(pageUrl)}, true)`)
  const pageWs = await waitFor(async () => {
    const t = (await targets()).find((t) => (t.url ?? '').startsWith(pageUrl))
    return t?.webSocketDebuggerUrl ?? null
  }, 15000)
  check(pageWs !== null, '远程页能在普通浏览器上下文里加载(无 preload)')

  const hasLogin = await waitFor(
    async () => (await evalOn(pageWs, `!!document.querySelector('input[type=password]')`)) === true,
    15000
  )
  check(hasLogin === true, '远程页显示登录表单')

  // 在页面里真登录:Vue 的 v-model 要 native setter + input 事件才会更新
  await evalOn(
    pageWs,
    `(() => {
       const el = document.querySelector('input[type=password]')
       const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
       setValue.call(el, ${JSON.stringify(PASSWORD)})
       el.dispatchEvent(new Event('input', { bubbles: true }))
       document.querySelector('form').requestSubmit()
       return true
     })()`
  )
  const loggedIn = await waitFor(
    async () => (await evalOn(pageWs, `document.body.innerText.includes('已连接')`)) === true,
    20000
  )
  check(loggedIn === true, '页面登录成功并连上 WS')

  // 电脑上开一个终端 → 页面列表该出现一行
  const pageCreated = await evalOn(chromeWs, `window.browserAPI.plugins.invoke('terminal','createSession',{})`)
  const pageSessionId = pageCreated?.tabId
  const rowShown = await waitFor(
    async () => (await evalOn(pageWs, `document.querySelectorAll('.row').length`)) === 1,
    20000
  )
  check(rowShown === true, '应用里新建的终端出现在手机页列表里')

  // 点进去:手机页是**对话**,不是 xterm。这里验的是「不再渲染终端」与「没有控制通道时如实提示」。
  // 真 pi 端的往返(令牌握手 / 消息 / 发话 / 停止)由 vitest 的 terminalRemoteChat 覆盖 ——
  // e2e 这边开的终端跑的是普通 shell,不会连对话桥。
  await evalOn(pageWs, `document.querySelector('.row').click()`)
  const chatReady = await waitFor(
    async () => (await evalOn(pageWs, `!!document.querySelector('.chat') && !!document.querySelector('.composer textarea')`)) === true,
    15000
  )
  check(chatReady === true, '点会话进入对话视图(输入框在,不是终端)')

  const noXterm = await evalOn(
    pageWs,
    `(() => (document.querySelector('.xterm-screen') || document.querySelector('.keybar')) ? false : true)()`
  )
  check(noXterm === true, '对话页里没有 xterm / 按键条(移动端不再渲染终端)')

  const deadHint = await waitFor(
    async () => (await evalOn(pageWs, `document.querySelector('[data-chat-hint]')?.innerText ?? ''`)).length > 0,
    10000
  )
  const hintText = await evalOn(pageWs, `document.querySelector('[data-chat-hint]')?.innerText ?? ''`)
  check(deadHint === true, '没有控制通道时给出可读提示(而且分开说原因)', hintText)
  check(
    String(hintText).includes('没检测到 pi') || String(hintText).includes('控制通道'),
    '提示里说清了是「没 pi」还是「通道没连上」',
    hintText
  )

  const composerDisabled = await evalOn(
    pageWs,
    `document.querySelector('.composer textarea')?.disabled === true`
  )
  check(composerDisabled === true, '没有控制通道时输入框是禁用的(不假装能发)')

  // ---------- 顶栏:返回 / 项目名称 / 状态 / 停止(只有一行;cwd 与状态条都在抽屉里) ----------
  const head = await evalOn(
    pageWs,
    `(() => {
       const head = document.querySelector('.head')
       return {
         hasCwd: !!head.querySelector('.cwd'),
         stats: !!document.querySelector('[data-chat-stats]'),
         name: head.querySelector('[data-chat-name]')?.innerText ?? '',
         status: head.querySelector('[data-chat-status]')?.innerText ?? ''
       }
     })()`
  )
  check(head.hasCwd === false && head.stats === false, '顶栏只留四项:cwd 与状态条都不在了', head)
  check(head.name.length > 0, '顶栏里有项目名称', head.name)
  check(head.status === '没通道', '没有控制通道时状态 chip 说「没通道」', head.status)

  // 三态 + 排队合成一个 chip(原来「有排队」是另一个 badge)
  const chip = async (patches) => {
    await evalOn(
      pageWs,
      `(() => { window.__bowRemote.handle(${JSON.stringify({
        t: 'chat',
        id: pageSessionId,
        live: true,
        messages: [],
        asks: [],
        ...patches
      })}) ; return true })()`
    )
    return await evalOn(pageWs, `document.querySelector('[data-chat-status]')?.innerText ?? ''`)
  }
  const chipBusy = await chip({ busy: true, pending: 2 })
  check(chipBusy === '在跑 · 排队2', '忙 + 排队时 chip 合成一句「在跑 · 排队2」', chipBusy)
  const chipIdle = await chip({ busy: false, pending: 0 })
  check(chipIdle === '空闲', '不忙时 chip 说「空闲」', chipIdle)

  // ---------- 提问卡片(pi 的弹框 → 手机上的按钮) ----------
  // 真 pi 那半由 `npm run test:pi:ask` 覆盖(扩展 + 令牌 + 谁先答)。
  // 这里验的是**页面**:服务端消息进来能不能画出卡片、点下去发出去的帧对不对。
  await evalOn(
    pageWs,
    `(() => { window.__bowRemote.handle(${JSON.stringify({
      t: 'chat',
      id: pageSessionId,
      live: true,
      messages: [],
      busy: true,
      pending: 0,
      asks: [
        {
          requestId: 'e2e-q1',
          kind: 'confirm',
          title: '允许执行 npm test 吗?',
          message: '这会跑完整测试'
        }
      ]
    })}) ; return true })()`
  )
  const askShown = await waitFor(
    async () => (await evalOn(pageWs, `!!document.querySelector('[data-ask]')`)) === true,
    10000
  )
  check(askShown === true, '提问卡片出现在输入框上方')
  const askTitle = await evalOn(pageWs, `document.querySelector('[data-ask-title]')?.innerText ?? ''`)
  check(String(askTitle).includes('npm test'), '卡片上带着题面标题', askTitle)

  await evalOn(pageWs, `document.querySelector('[data-ask-answer=yes]').click()`)
  const answered = await waitFor(async () => {
    const sent = await evalOn(pageWs, `JSON.stringify(window.__bowRemote.sent.filter((f) => f.t === 'answer'))`)
    return String(sent).includes('e2e-q1') ? sent : null
  }, 5000)
  check(answered !== null, '点「允许」发出 answer 帧(值来自手机)', answered)
  const askGone = await waitFor(
    async () => (await evalOn(pageWs, `document.querySelector('[data-ask]') === null`)) === true,
    5000
  )
  check(askGone === true, '答完卡片消失')

  // ---------- 抽屉:pi 的信息(全在这里)+ 功能入口 ----------
  const sessionCwd =
    (
      await evalOn(chromeWs, `window.browserAPI.plugins.invoke('terminal','listSessions')`)
    )?.find((s) => s.id === pageSessionId)?.cwd ?? ''
  const openDrawer = `(() => { document.querySelector('[data-chat-more]').click(); return true })()`
  const closeDrawer = `(() => { document.querySelector('[data-chat-backdrop]')?.click(); return true })()`

  // 旧版扩展没有 status:抽屉里该有一句说明,而不是空着
  await evalOn(
    pageWs,
    `(() => { window.__bowRemote.handle(${JSON.stringify({
      t: 'chat',
      id: pageSessionId,
      live: true,
      messages: [],
      busy: false,
      pending: 0,
      asks: [],
      commands: [
        { name: 'bow', description: 'bow 集成:MCP 注册状态 / on / off / reload', source: 'extension' },
        { name: 'skill:ponytail', description: '懒但完整的实现风格', source: 'skill' }
      ]
    })}) ; return true })()`
  )
  await evalOn(pageWs, openDrawer)
  const drawerOpened = await waitFor(
    async () => (await evalOn(pageWs, `!!document.querySelector('[data-chat-drawer]')`)) === true,
    5000
  )
  check(drawerOpened === true, '点输入框右边的 ⌃ 展开抽屉')
  const noStatus = await evalOn(pageWs, `document.querySelector('[data-chat-drawer]')?.innerText ?? ''`)
  check(String(noStatus).includes('没上报状态'), '旧版扩展没有 status → 抽屉里说明一句(不空着)', noStatus)
  await evalOn(pageWs, closeDrawer)
  const drawerClosed = await waitFor(
    async () => (await evalOn(pageWs, `!!document.querySelector('[data-chat-drawer]')`)) === false,
    5000
  )
  check(drawerClosed === true, '点空白处收起抽屉')

  await evalOn(
    pageWs,
    `(() => { window.__bowRemote.handle(${JSON.stringify({
      t: 'chat-status',
      id: pageSessionId,
      status: {
        model: 'claude-sonnet-4',
        provider: 'anthropic',
        thinking: 'high',
        input: 12000,
        output: 3400,
        cacheRead: 0,
        cacheWrite: 0,
        contextTokens: 76400,
        contextWindow: 200000
      }
    })}) ; return true })()`
  )
  await evalOn(pageWs, openDrawer)
  const drawerShown = await waitFor(
    async () => (await evalOn(pageWs, `document.querySelector('[data-chat-model]')?.innerText ?? ''`)).length > 0,
    5000
  )
  const drawerText = await evalOn(pageWs, `document.querySelector('[data-chat-drawer]')?.innerText ?? ''`)
  check(drawerShown === true, '抽屉里显示模型 / token / 上下文', drawerText)
  check(String(drawerText).includes('claude-sonnet-4'), '抽屉里有模型名', drawerText)
  check(String(drawerText).includes('12k') && String(drawerText).includes('3.4k'), '输入输出按 k 缩写', drawerText)
  const ctxText = await evalOn(pageWs, `document.querySelector('[data-chat-ctx]')?.innerText ?? ''`)
  check(String(ctxText).includes('38.2%') && String(ctxText).includes('200k'), '上下文显示「百分比/窗口」', ctxText)
  const drawerCwd = await evalOn(pageWs, `document.querySelector('[data-chat-cwd]')?.innerText ?? ''`)
  check(
    sessionCwd !== '' && String(drawerCwd).includes(sessionCwd),
    '抽屉里「目录」是完整路径(单独一行,不缩写)',
    drawerCwd
  )

  // 快到顶(95%)→ 变红;未知 token(compact 刚做完)→ 显示「?」而不是 0%
  await evalOn(
    pageWs,
    `(() => { window.__bowRemote.handle(${JSON.stringify({
      t: 'chat-status',
      id: pageSessionId,
      status: { model: 'gpt-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 190000, contextWindow: 200000 }
    })}) ; return true })()`
  )
  const ctxHot = await waitFor(
    async () =>
      (await evalOn(pageWs, `document.querySelector('[data-chat-ctx]')?.className ?? ''`)) === 'stat error',
    5000
  )
  check(ctxHot === true, '上下文 >90% 变红(提醒该 compact 了)')

  await evalOn(
    pageWs,
    `(() => { window.__bowRemote.handle(${JSON.stringify({
      t: 'chat-status',
      id: pageSessionId,
      status: { model: 'gpt-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: null, contextWindow: 200000 }
    })}) ; return true })()`
  )
  const ctxUnknown = await waitFor(
    async () => (await evalOn(pageWs, `document.querySelector('[data-chat-ctx]')?.innerText ?? ''`)) === '?/200k',
    5000
  )
  check(ctxUnknown === true, 'compact 后 token 未知 → 显示 ?/窗口(不是 0%)')

  // ---------- 命令补全:抽屉里的 / → 模糊搜索 → 点选只补全(不发送) ----------
  await evalOn(pageWs, `(() => { document.querySelector('[data-chat-cmd-open]').click(); return true })()`)
  const cmdsOpen = await waitFor(
    async () => (await evalOn(pageWs, `!!document.querySelector('[data-chat-cmds]')`)) === true,
    5000
  )
  check(cmdsOpen === true, '点「/ 命令」弹出补全面板')
  const searchFocused = await evalOn(pageWs, `document.activeElement?.matches('[data-chat-cmd-search]') === true`)
  check(searchFocused === true, '搜索框自动聚焦(不用再点一下)')
  const allCmds = await evalOn(pageWs, `document.querySelectorAll('[data-chat-cmd]').length`)
  check(allCmds === 2, '没输关键词时列出全部命令', allCmds)

  // 模糊匹配:子序列 bw 命中 bow(与地址栏 suggestion 同一套 fuzzyScore)
  await evalOn(
    pageWs,
    `(() => {
       const el = document.querySelector('[data-chat-cmd-search]')
       const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
       setValue.call(el, 'bw')
       el.dispatchEvent(new Event('input', { bubbles: true }))
       return true
     })()`
  )
  const fuzzy = await waitFor(async () => {
    const n = await evalOn(pageWs, `document.querySelectorAll('[data-chat-cmd]').length`)
    return n === 1 ? n : null
  }, 5000)
  const hitName = await evalOn(pageWs, `document.querySelector('[data-chat-cmd]')?.innerText ?? ''`)
  check(fuzzy === 1 && String(hitName).includes('/bow'), '模糊匹配:子序列 bw → /bow', hitName)

  await evalOn(pageWs, `(() => { document.querySelector('[data-chat-cmd]').click(); return true })()`)
  const inserted = await waitFor(async () => {
    const value = await evalOn(pageWs, `document.querySelector('.composer textarea')?.value ?? ''`)
    return value === '/bow ' ? value : null
  }, 5000)
  check(inserted === '/bow ', '点选只把命令填进输入框(光标在末尾,可接着写参数)', inserted)
  const stillOpen = await evalOn(pageWs, `!!document.querySelector('[data-chat-cmds]')`)
  check(stillOpen === false, '选完面板自动收起')
  const noPrompt = await evalOn(
    pageWs,
    `window.__bowRemote.sent.some((f) => f.t === 'prompt') === false`
  )
  check(noPrompt === true, '点选**没有**发送(还等用户按发送)', noPrompt)


  const backToList = await evalOn(
    pageWs,
    `(() => { document.querySelector('.head .back').click(); return true })()`
  )
  const listBack = await waitFor(
    async () => (await evalOn(pageWs, `document.querySelectorAll('.row').length >= 1`)) === true,
    10000
  )
  check(backToList === true && listBack === true, '「←」能回到会话列表')

  // ---------- ⑥ 「谁刚碰过,尺寸归谁」:手机抢走宽度 → 电脑上点一下抢回来 ----------
  // 用户的原始抱怨:手机点进会话后,电脑那个终端一直是手机宽度,只能拖窗口才恢复。
  const sizes = async () => await evalOn(chromeWs, `window.browserAPI.plugins.invoke('terminal','listSessions')`)
  const pcSize = (await sizes()).find((s) => s.id === pageSessionId)
  check(pcSize?.cols > 0, '电脑端终端的尺寸已知', pcSize && { cols: pcSize.cols, rows: pcSize.rows })

  const taker = await connectWs(wsUrl, { cookie })
  await taker.next((m) => m.t === 'hello')
  taker.ws.send(JSON.stringify({ t: 'attach', id: pageSessionId, cols: 40, rows: 20 }))
  await taker.next((m) => m.t === 'attached')
  const takenOver = await waitFor(async () => {
    const hit = (await sizes()).find((s) => s.id === pageSessionId)
    return hit?.cols === 40 ? hit : null
  }, 10000)
  check(takenOver !== null, '手机 attach 会把 pty 缩到手机宽度(现状)', takenOver && { cols: takenOver.cols })

  // 电脑上的终端页被点一下(真鼠标事件)→ 重新 fit → 把宽度抢回来
  const terminalWs = await waitFor(async () => {
    const t = (await targets()).find((t) => /\/renderer\/terminal\.html/.test(t.url ?? ''))
    return t?.webSocketDebuggerUrl ?? null
  }, 10000)
  check(terminalWs !== null, '找得到电脑端终端页的 target')
  await realClick(terminalWs, '.xterm')
  const reclaimed = await waitFor(async () => {
    const hit = (await sizes()).find((s) => s.id === pageSessionId)
    return hit && hit.cols !== 40 ? hit : null
  }, 10000)
  check(
    reclaimed !== null && reclaimed.cols === pcSize.cols,
    '在电脑上点一下终端,宽度自动恢复成电脑的(不必拖窗口)',
    reclaimed && { cols: reclaimed.cols, want: pcSize.cols }
  )
  taker.close()

  // 收尾:关掉这个页标签
  await evalOn(chromeWs, `window.browserAPI.closeTab(${JSON.stringify(pageTab?.id ?? 0)})`).catch(() => {})

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
