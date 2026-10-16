#!/usr/bin/env node
/**
 * 「牧群」面板(toolbar 按钮 + full 浮层)的端到端验证:
 * **真 Electron + 真终端(node-pty)+ 真台账**,只有「代理」是假的(用 printf 往 pty 里打一条 OSC)。
 *
 * 链路:sessions-changed 推送 → 工具栏按钮计数/高亮 → 浮层里的行(排序:等用户的排最前)
 *      → 点一行 = 跳到那个标签并关掉面板 → 关掉一个会话后列表跟着少一项。
 *
 * 为什么这些必须真跑一遍(unittest 覆盖不到):
 * - 浮层的 id 必须与渲染层注册表、内核的事件路由两处都对上(`plugin:terminal:herd`),写错的表现是「点了没反应」;
 * - `ctx.ipc.emit` 的广播只到 chrome / overlay / 内部页,按钮与面板拿到的是同一条推送;
 * - 「点一行跳过去」走 `ctx.pages.activate`(切标签 + 提窗口),不是 `focus`;
 * - 行排序依赖真实时间戳,假时钟测不出「等用户的排最前」在 UI 里是不是真的。
 *
 * 用法(需要先构建过一次:`npm run build`):
 * ```bash
 * npm run test:e2e:herd
 * ```
 * 造物在 `$TMPDIR/bow-e2e`,每次用独立的 userData 与调试端口,不会碰你正在跑的 bow。
 */

import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = process.env.BOW_E2E_DIR ?? join(tmpdir(), 'bow-e2e')
const run = process.pid
const userdata = join(dir, `herd-userdata-${run}`)
const debugPort = 9300 + (run % 200)
const electron = createRequire(import.meta.url)('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

function check(cond, label, detail) {
  if (cond) console.log(`✓ ${label}`)
  else {
    failures += 1
    console.error(`✗ ${label}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
  }
}

async function waitFor(predicate, timeoutMs = 20000, stepMs = 200) {
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
    // 关闭确认浮层会拦下窗口 close,所以 SIGTERM 之后补一记 SIGKILL(实测会留下整棵进程树)
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

/** 在任意 target 上跑一段表达式(Runtime.evaluate + returnByValue + awaitPromise) */
async function evalOn(wsUrl, expression) {
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

/**
 * chrome 页面(`renderer/index.html`)的 ws 地址 —— 工具栏按钮与 api 都在这里。
 *
 * ⚠️ 必须**正面**认它(结尾是 `renderer/index.html`):标签页也是 `type: 'page'`,
 * 用「不是 overlay/terminal…」这种黑名单会把普通网页选中,那边的 `window.browserAPI` 是 undefined。
 */
async function chromeWs() {
  const t = (await targets()).find((t) => t.type === 'page' && /\/renderer\/index\.html/.test(t.url ?? ''))
  return t?.webSocketDebuggerUrl ?? null
}

/** 浮层页面(`overlay.html`)的 ws 地址 */
async function overlayWs() {
  const t = (await targets()).find((t) => t.url?.includes('overlay.html'))
  return t?.webSocketDebuggerUrl ?? null
}

const listSessions = (ws) => evalOn(ws, `window.browserAPI.plugins.invoke('terminal','listSessions')`)

try {
  const ws = await waitFor(chromeWs, 30000)
  if (!ws) throw new Error('等不到 chrome 页面')
  // 等 preload 与插件内核就绪(在此之前 window.browserAPI / plugins.invoke 都还不存在)
  const ready = await waitFor(
    async () => (await evalOn(ws, `typeof window.browserAPI?.plugins?.invoke === 'function'`)) === true,
    30000
  )
  if (!ready) throw new Error('chrome 页面里没有 window.browserAPI(不是主窗口?)')

  // ---------- ① 建三个终端 ----------
  const ids = []
  for (let i = 0; i < 3; i++) {
    const res = await evalOn(ws, `window.browserAPI.plugins.invoke('terminal','createSession',{})`)
    if (res?.ok) ids.push(res.tabId)
    await sleep(150)
  }
  check(ids.length === 3, 'createSession 开出三个终端标签', ids)
  const three = await waitFor(async () => {
    const list = await listSessions(ws)
    return list?.length === 3 ? list : null
  })
  check(three !== null, '台账里出现三个会话', three?.map((s) => s.id))

  // ---------- ② 工具栏按钮:数量 + 没有代理时的安静状态 ----------
  const countText = () => evalOn(ws, `document.querySelector('.herd-btn .herd-count')?.textContent ?? null`)
  const badge = await waitFor(async () => (await countText()) === '3' && '3')
  check(badge === '3', '按钮显示会话总数 3', await countText())
  check(
    (await evalOn(ws, `document.querySelectorAll('.herd-btn.blocked').length`)) === 0,
    '没有代理在等用户时按钮不高亮'
  )

  // ---------- ③ 让第一个会话报一条 blocked(往 pty 里打 OSC,与假 pi 同一条协议) ----------
  const blockedId = ids[0]
  const osc = `printf '\\033]1337;bow;{"v":1,"state":"blocked","title":"要确认","text":"π - bow"}\\007'`
  await evalOn(ws, `window.browserAPI.plugins.invoke('terminal','sendText',${blockedId},${JSON.stringify(osc + '\n')})`)
  const blocked = await waitFor(async () => {
    const list = await listSessions(ws)
    return list?.find((s) => s.id === blockedId && s.agent?.state === 'blocked') ?? null
  })
  check(blocked !== null, 'OSC 信号进入台账(blocked + 标题)', blocked?.agent)

  const highlighted = await waitFor(
    async () => (await evalOn(ws, `document.querySelector('.herd-btn.blocked .herd-count')?.textContent ?? null`)) === '1'
  )
  check(highlighted === true, '有代理等用户时按钮高亮并显示待办数 1')

  // ---------- ④ 面板:三行,等用户的那行排最前 ----------
  await evalOn(ws, `window.browserAPI.showOverlay({ id: 'plugin:terminal:herd', placement: 'full', payload: undefined })`)
  const ows = await waitFor(overlayWs, 15000)
  check(ows !== null, '浮层页面存在')
  const rows = await waitFor(async () => {
    const n = await evalOn(ows, `document.querySelectorAll('.herd-row').length`)
    return n === 3 ? n : null
  })
  check(rows === 3, '面板列出三行', await evalOn(ows, `document.querySelectorAll('.herd-row').length`))
  check(
    (await evalOn(ows, `document.querySelector('.herd-row')?.classList.contains('waiting')`)) === true,
    '第一行是「在等你」的那个(注意力排序)'
  )
  check(
    (await evalOn(ows, `document.querySelector('.herd-row .herd-ask')?.textContent`)) === '要确认',
    '等用户的标题直接显示在行里'
  )

  // ---------- ⑤ 点一行 = 跳到那个标签并关掉面板 ----------
  await evalOn(ows, `document.querySelector('.herd-row').click()`)
  const activated = await waitFor(async () => {
    const list = await evalOn(ws, `window.browserAPI.listTabs()`)
    return list?.find((t) => t.id === blockedId)?.active === true
  })
  check(activated === true, `点一行跳到标签 ${blockedId}(active)`)
  const overlayClosed = await waitFor(
    async () => (await evalOn(ows, `document.querySelector('.modal-mask') === null`)) === true
  )
  check(overlayClosed === true, '跳转后面板自动关闭')

  // ---------- ⑥ 关掉一个会话,列表跟着少一项 ----------
  await evalOn(ws, `window.browserAPI.plugins.invoke('terminal','closeSession',${ids[1]})`)
  const two = await waitFor(async () => {
    const list = await listSessions(ws)
    return list?.length === 2 ? list : null
  })
  check(two !== null, '关闭会话后台账剩两个', two?.map((s) => s.id))
  // 按钮上那个数字的含义是:有代理等用户时显示**待办数**(红底,行动导向);否则显示总数(暗色)。
  // 总数在 tooltip 里一直有 —— 所以这里两个都断言,顺便看住这个约定。
  const buttonTitle = () => evalOn(ws, `document.querySelector('.herd-btn')?.getAttribute('title') ?? null`)
  check(
    (await waitFor(async () => (await buttonTitle())?.includes('共 2 个终端') && true)) === true,
    '按钮 tooltip 里的总数跟着变成 2',
    await buttonTitle()
  )
  check(
    (await evalOn(ws, `document.querySelector('.herd-btn.blocked .herd-count')?.textContent ?? null`)) === '1',
    '红色数字仍是待办数 1(不是总数)'
  )
} catch (e) {
  failures += 1
  console.error(`✗ e2e 中断:${e instanceof Error ? e.message : String(e)}`)
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 处失败`)
process.exit(failures === 0 ? 0 : 1)
