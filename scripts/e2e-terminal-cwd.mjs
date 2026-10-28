#!/usr/bin/env node
/**
 * 终端「工作目录」链路的**真机 E2E**(不需要显示环境,不需要 MCP)。
 *
 * 一条目录要走过四段才到脸上,单测只覆盖得了第 ①:
 * ① shell 的 OSC 7(oh-my-zsh 的 `omz_termsupport_cwd`)→ 主进程 `OscSignalParser` 剥出来;
 * ② 台账 `SessionInfo.cwd`(Linux 上还有 `/proc/<pid>/cwd` 兜底)→ `sessions-changed` 广播;
 * ③ 终端页把 cwd 写进 `document.title`;
 * ④ 标题经 `page-title-updated` 变成 `TabInfo.title`,长按 Shift 的徽标读的也是它。
 *
 * 所以这里真起一个 zsh、真往里敲 `cd`,再从 chrome 侧读三处:
 * `getActiveTab().title` / `plugins.invoke('terminal','listSessions')` / 长按 Shift 的徽标文案。
 *
 * 用法(需要已构建的 `out/`:`npm run build`):`node scripts/e2e-terminal-cwd.mjs`
 */

import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = process.env.BOW_E2E_DIR ?? join(tmpdir(), 'bow-e2e')
const run = process.pid
const userdata = join(dir, `termcwd-userdata-${run}`)
mkdirSync(userdata, { recursive: true })
const debugPort = 9900 + (run % 100)
const electron = createRequire(import.meta.url)('electron')

/** 敲进去的目录:刻意选一个绝大多数机器上都存在、且与家目录无关的绝对路径 */
const TARGET_DIR = '/tmp'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(cond, label, detail) {
  if (cond) console.log(`✓ ${label}`)
  else {
    failures += 1
    console.error(`✗ ${label}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
  }
}
async function waitFor(fn, timeoutMs = 20000, stepMs = 250) {
  const started = Date.now()
  for (;;) {
    let v = null
    try {
      v = await fn()
    } catch {
      v = null
    }
    if (v) return v
    if (Date.now() - started > timeoutMs) return null
    await sleep(stepMs)
  }
}

const child = spawn(
  electron,
  ['.', '--no-sandbox', '--ozone-platform=headless', `--user-data-dir=${userdata}`, `--remote-debugging-port=${debugPort}`],
  { cwd: root, env: { ...process.env }, stdio: 'ignore' }
)

const targets = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
  } catch {
    return []
  }
}

async function cdp(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl)
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error('连不上 target'))
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
const evalOn = async (wsUrl, expression) =>
  (await cdp(wsUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value

async function cleanup() {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      /* 已经没了 */
    }
  } else {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
  await sleep(400)
  rmSync(userdata, { recursive: true, force: true })
}

async function main() {
  // chrome target:必须**正面**匹配 `/renderer/index.html` —— 普通标签页也是 `type: 'page'`,
  // 内部页面(终端页等)也挂 `window.browserAPI`,黑名单式过滤会选错(见 `e2e-herd.mjs` 的注)
  const chromeTarget = await waitFor(async () => {
    for (const t of await targets()) {
      if (!t.webSocketDebuggerUrl || !String(t.url).includes('/renderer/index.html')) continue
      try {
        if ((await evalOn(t.webSocketDebuggerUrl, 'typeof window.browserAPI?.listTabs')) === 'function') return t
      } catch {
        /* 还没准备好 */
      }
    }
    return null
  }, 25000)
  check(!!chromeTarget, '找到 chrome target')
  if (!chromeTarget) return
  const chromeWs = chromeTarget.webSocketDebuggerUrl
  const chromeEval = (expr) => evalOn(chromeWs, expr)

  // ---------- 开终端 ----------
  const tab = await chromeEval(`window.browserAPI.createTab('bow://terminal')`)
  check(!!tab?.id, '新建 bow://terminal 标签', tab)
  if (!tab?.id) return

  const termTarget = await waitFor(async () => {
    for (const t of await targets()) {
      if (t.webSocketDebuggerUrl && String(t.url).includes('terminal.html')) return t
    }
    return null
  }, 20000)
  check(!!termTarget, '找到终端页 target')
  if (!termTarget) return
  const termWs = termTarget.webSocketDebuggerUrl

  // 等 shell 有结论:`ready`(pty 起来了)或 `error`(带原因,比单纯超时有用得多)
  const settled = await waitFor(async () => {
    const out = await evalOn(termWs, '({ status: window.__bowTerminal?.status, message: window.__bowTerminal?.message })')
    return out?.status === 'ready' || out?.status === 'error' ? out : null
  }, 30000)
  check(settled?.status === 'ready', 'shell 起来了(status=ready)', settled)
  if (settled?.status !== 'ready') return

  // ---------- 启动目录:标题 / 台账 / 徽标三处一致 ----------
  const title0 = await waitFor(async () => {
    const t = await chromeEval('window.browserAPI.getActiveTab()')
    return t?.title?.startsWith('终端 — /') ? t.title : null
  }, 15000)
  check(!!title0, '标题带上启动目录(终端 — /…)', title0)

  const cwd0 = await chromeEval(
    `window.browserAPI.plugins.invoke('terminal','listSessions').then(l => l.find(s => s.id === ${tab.id})?.cwd ?? null)`
  )
  check(typeof cwd0 === 'string' && cwd0.startsWith('/'), '台账里有绝对 cwd', cwd0)
  check(cwd0 === title0?.replace('终端 — ', ''), '标题里的目录 = 台账里的目录', { title0, cwd0 })

  // ---------- 敲 `cd` → OSC 7 / /proc 让三处跟着变 ----------
  await evalOn(termWs, `window.__bowTerminal.send(${JSON.stringify(`cd ${TARGET_DIR}\r`)})`)
  const cwd1 = await waitFor(async () => {
    const v = await chromeEval(
      `window.browserAPI.plugins.invoke('terminal','listSessions').then(l => l.find(s => s.id === ${tab.id})?.cwd ?? null)`
    )
    return v === TARGET_DIR ? v : null
  }, 15000)
  check(cwd1 === TARGET_DIR, `cd 后台账 cwd = ${TARGET_DIR}`, cwd1)

  const title1 = await waitFor(async () => {
    const t = await chromeEval('window.browserAPI.getActiveTab()')
    return t?.title === `终端 — ${TARGET_DIR}` ? t.title : null
  }, 8000)
  check(title1 === `终端 — ${TARGET_DIR}`, `cd 后标题跟着变(终端 — ${TARGET_DIR})`, title1)

  // ---------- 长按 Shift:终端窗格的徽标多一行目录 ----------
  // 键盘焦点在终端页上:Shift 发给它(与用户按住 Shift 时的焦点一致)
  await cdp(termWs, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    modifiers: 8,
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16,
    nativeVirtualKeyCode: 16
  })
  const overlayTarget = await waitFor(async () => {
    for (const t of await targets()) {
      if (t.webSocketDebuggerUrl && String(t.url).includes('overlay.html')) return t
    }
    return null
  }, 8000)
  check(!!overlayTarget, '长按 Shift 后 overlay 出现', overlayTarget?.url)
  if (overlayTarget) {
    const badge = await waitFor(async () => {
      const list = await evalOn(
        overlayTarget.webSocketDebuggerUrl,
        `Array.from(document.querySelectorAll('.tab-id-badge')).map(e => e.textContent.replace(/\\s+/g,' ').trim())`
      )
      return list?.[0] ?? null
    }, 8000)
    check(!!badge?.includes(`tabId ${tab.id}`), '徽标仍然带 tabId', badge)
    check(!!badge?.includes(`终端 — ${TARGET_DIR}`), '徽标第二行是终端的工作目录', badge)
  }
  await cdp(termWs, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 0,
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16,
    nativeVirtualKeyCode: 16
  })
}

try {
  await main()
} catch (error) {
  failures += 1
  console.error(`异常:${error?.stack ?? error}`)
} finally {
  await cleanup()
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
