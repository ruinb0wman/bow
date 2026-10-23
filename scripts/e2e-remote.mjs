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

  // ---------- ⑤ 远程页本身(真浏览器上下文,无 preload) ----------
  // 这一段才是「手机上真的能用」的证据:bundle 在普通页面里跑得起来、登录表单能提交、
  // WS 连上、会话行点进去 xterm 能渲染、按键条在。
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

  // 点进去:xterm 在普通浏览器里渲染出来,按键条也在
  await evalOn(pageWs, `document.querySelector('.row').click()`)
  const termReady = await waitFor(
    async () => (await evalOn(pageWs, `!!document.querySelector('.xterm-screen') && !!document.querySelector('.keybar')`)) === true,
    15000
  )
  check(termReady === true, '点会话进入终端视图(xterm + 按键条渲染在普通浏览器里)')

  // 按键条的铁律:点它**不能**让终端失焦(否则手机软键盘立刻收起,后面敲的字也进不去)
  await evalOn(pageWs, `(() => { document.querySelector('.xterm-helper-textarea').focus(); return true })()`)
  const focusedBefore = await evalOn(
    pageWs,
    `document.activeElement?.className ?? ''`
  )
  check(String(focusedBefore).includes('xterm-helper-textarea'), '终端可以先拿到焦点')
  await realClick(pageWs, '.keybar .key.mod')
  const focusedAfter = await evalOn(pageWs, `document.activeElement?.className ?? ''`)
  check(
    String(focusedAfter).includes('xterm-helper-textarea'),
    '真点一下 Ctrl 按钮后焦点仍在终端(软键盘不会收起)',
    focusedAfter
  )
  const ctrlOn = await evalOn(pageWs, `document.querySelector('.keybar .key.mod')?.classList.contains('on') ?? null`)
  check(ctrlOn === true, 'Ctrl 确实点亮了(动作没被 preventDefault 吞掉)')

  // 符号键:手机输入法把 / 埋在第二页,必须有一键
  const hasSlash = await evalOn(
    pageWs,
    `[...document.querySelectorAll('.keybar .key')].some((el) => el.textContent.trim() === '/')`
  )
  check(hasSlash === true, '按键条上有 / 键')

  // 历史回看:这一段**不依赖 shell**(Windows 默认是 PowerShell,`seq` 不存在)。
  // 回看要验的是 UI(xterm 缓冲区 + 按钮),直接往终端里写 300 行更确定。
  await evalOn(
    pageWs,
    `(() => { const t = window.__bowRemoteTerm; for (let i = 0; i < 300; i++) t.write('line ' + i + '\\r\\n'); return true })()`
  )
  const hasHistory = await waitFor(
    async () =>
      (await evalOn(pageWs, `((window.__bowRemoteTerm?.buffer.active.baseY ?? 0) > 0 ? true : null)`)) === true,
    10000
  )
  check(hasHistory === true, '缓冲区里已有历史(可回看)')

  await evalOn(pageWs, `window.__bowRemoteTerm.scrollToBottom()`)
  const atBottom = await evalOn(
    pageWs,
    `(() => { const b = window.__bowRemoteTerm.buffer.active; return b.viewportY === b.baseY })()`
  )
  check(atBottom === true, '视口停在底部')

  await evalOn(pageWs, `document.querySelector('.scroll-pad .sc').click()`)
  const inHistory = await waitFor(
    async () =>
      (await evalOn(
        pageWs,
        `(() => { const b = window.__bowRemoteTerm.buffer.active; return b.viewportY < b.baseY ? true : null })()`
      )) === true,
    5000
  )
  check(inHistory === true, '点 ▲ 能向上翻看历史(本地回看,不发按键给 shell)')

  // 翻着历史时又来了输出:视口**不动**,但出现「新输出」提示。
  // 这里必须走**真路径**(pty → WS → App 的 write 包装),不能直接调 xterm.write ——
  // 直写会绕过「翻着历史时打标记」那段逻辑,断言就变成了偶然通过(`echo` 在 PowerShell 里也有)。
  await evalOn(
    chromeWs,
    `window.browserAPI.plugins.invoke('terminal','sendText',${JSON.stringify(pageSessionId)},${JSON.stringify('echo LATE_OUTPUT\r')})`
  )
  const stayedPut = await waitFor(
    async () =>
      (await evalOn(
        pageWs,
        `(() => {
           const b = window.__bowRemoteTerm.buffer.active
           const badge = document.querySelector('.sc-bottom')?.textContent?.trim() ?? ''
           return b.viewportY < b.baseY && badge === '新输出' ? true : null
         })()`
      )) === true,
    8000
  )
  check(stayedPut === true, '翻着历史时新输出不拽走视口,只提示「新输出」')

  const backToBottom = await evalOn(
    pageWs,
    `(() => {
       document.querySelector('.sc-bottom').click()
       const b = window.__bowRemoteTerm.buffer.active
       return b.viewportY === b.baseY ? 'bottom' : 'not-bottom'
     })()`
  )
  check(backToBottom === 'bottom', '「最新」能回到最新输出', backToBottom)

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
