#!/usr/bin/env node
/**
 * 「长按 Shift 显示 tabId 徽标 → 点徽标复制」的**真机 E2E**(不需要显示环境,不需要 MCP)。
 *
 * 为什么必须有一个真 Electron 的验证(仅单测不够):
 * 1. **裸 Shift 到底会不会触发主进程的 `before-input-event`** —— 整个特性的地基。Electron 的类型只声明
 *    `Input.type = keyUp | keyDown`,修饰键的行为得实测;这个脚本用 CDP 在**页面 target** 上发
 *    `Input.dispatchKeyEvent`(`rawKeyDown` + `modifiers: 8`),能过就说明那条链路是通的。
 * 2. **浮层 bounds 必须紧包徽标** —— `WebContentsView` 没有点击穿透,bounds 算错 = 页面上一大片点不动,
 *    而 DOM 断言看不出来。这里用「浮层视图的 `innerWidth/innerHeight`」反查 bounds,并用徽标 DOM 的
 *    几何反查它确实落在窗格中心。
 * 3. **剪贴板** —— 徽标点击后 `browserAPI.readClipboardText()` 必须拿到纯数字 id。
 *
 * 驱动方式:与 `e2e-device-inspect.mjs` / `e2e-agent-status.mjs` 同一套 —— bow 自己开
 * `--remote-debugging-port`,脚本从 `/json` 里先找 chrome target(`browserAPI.listTabs` 可用),
 * 再按 URL 找页面 target(`about:blank`)与 overlay target(`overlay.html`)。
 *
 * 用法:`node scripts/e2e-tab-id-reveal.mjs`(需要已构建的 `out/`,即先 `npm run build`)。
 * 临时文件在 `$TMPDIR/bow-e2e`(`BOW_E2E_DIR` 可改);每次运行用独立 userData 与调试端口。
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
const userdata = join(dir, `tabid-userdata-${run}`)
mkdirSync(userdata, { recursive: true })
const debugPort = 9800 + (run % 100)
const electron = createRequire(import.meta.url)('electron')
/** 设了就改验打包版(`dist/<平台>-unpacked/bow`):那种可执行文件自带 app 路径,不再传 `.` */
const packagedBin = process.env.BOW_E2E_BIN?.trim() || null

/**
 * 与 `@shared/tabIdBadge` 的常量保持一致(这里刻意**独立写死**:真机 E2E 的断言不该跟实现共用一份数)。
 * `{width: 96, height: 34}` 徽标盒 + 四周各 6px padding。
 */
const BADGE_BOX = { width: 96, height: 34, padding: 6 }
const BADGES = `Array.from(document.querySelectorAll('.tab-id-badge')).map(e=>e.textContent.trim())`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(cond, label, detail) {
  if (cond) console.log(`✓ ${label}`)
  else {
    failures += 1
    console.error(`✗ ${label}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
  }
}
async function waitFor(fn, timeoutMs = 15000, stepMs = 200) {
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
  packagedBin ?? electron,
  [
    ...(packagedBin ? [] : ['.']),
    '--no-sandbox',
    '--ozone-platform=headless',
    `--user-data-dir=${userdata}`,
    `--remote-debugging-port=${debugPort}`
  ],
  { cwd: root, env: { ...process.env }, stdio: 'ignore' }
)

const targets = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
  } catch {
    return []
  }
}

/** 通用 CDP 调用(`Runtime.evaluate` 与 `Input.dispatch*` 共用) */
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
  // ---------- chrome target(标签栏数据与 window.browserAPI 都在这里) ----------
  const chromeTarget = await waitFor(async () => {
    for (const t of await targets()) {
      if (!t.webSocketDebuggerUrl || String(t.url).startsWith('devtools://')) continue
      try {
        if ((await evalOn(t.webSocketDebuggerUrl, 'typeof window.browserAPI?.listTabs')) === 'function') return t
      } catch {
        /* 不是 chrome 页面 */
      }
    }
    return null
  }, 25000)
  check(!!chromeTarget, '找到 chrome target(可读 browserAPI.listTabs)')
  if (!chromeTarget) return
  const chromeEval = (expr) => evalOn(chromeTarget.webSocketDebuggerUrl, expr)

  // ---------- 一个普通页面标签(Shift 要发给它:那是通常的键盘焦点所在) ----------
  const tab = await chromeEval(`window.browserAPI.createTab('about:blank')`)
  check(!!tab?.id, '新建普通标签', tab)
  if (!tab?.id) return
  await sleep(800)
  const pageTarget = await waitFor(async () => {
    for (const t of await targets()) {
      if (t.webSocketDebuggerUrl && String(t.url) === 'about:blank') return t
    }
    return null
  }, 15000)
  check(!!pageTarget, '找到页面 target', pageTarget?.url)
  if (!pageTarget) return
  const pageWs = pageTarget.webSocketDebuggerUrl

  const holdShift = () =>
    cdp(pageWs, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: 8,
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 16
    })
  const releaseShift = () =>
    cdp(pageWs, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: 0,
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 16
    })
  const overlayTarget = () =>
    waitFor(async () => {
      for (const t of await targets()) {
        if (t.webSocketDebuggerUrl && String(t.url).includes('overlay.html')) return t
      }
      return null
    }, 8000)

  const panesOf = async () => ((await chromeEval('window.browserAPI.getGroups()')) ?? []).find((g) => g.panes.length > 0)?.panes ?? []

  const panes = await panesOf()
  check(panes.length === 1, '单窗格组:活动组只有一个窗格', panes.map((p) => p.tabId))
  if (panes.length !== 1) return
  const pane = panes[0]
  const center = { x: pane.rect.x + pane.rect.width / 2, y: pane.rect.y + pane.rect.height / 2 }
  const expW = BADGE_BOX.width + BADGE_BOX.padding * 2
  const expH = BADGE_BOX.height + BADGE_BOX.padding * 2

  // ---------- 短按 Shift(60ms)不能闪出徽标(在页面里打大写字母的日常) ----------
  await holdShift()
  await sleep(60)
  await releaseShift()
  await sleep(400)
  const shortTap = await overlayTarget()
  const shortTapBadges = shortTap ? await evalOn(shortTap.webSocketDebuggerUrl, BADGES) : []
  check((shortTapBadges ?? []).length === 0, '短按 Shift(60ms)不显示徽标', shortTapBadges)

  // ---------- 长按 Shift → 页面中央一个徽标 ----------
  await holdShift()
  await sleep(600)
  const overlay = await overlayTarget()
  check(!!overlay, '长按 Shift 后 overlay target 出现', overlay?.url)
  if (!overlay) return
  const overlayWs = overlay.webSocketDebuggerUrl
  const badges = await waitFor(async () => {
    const list = await evalOn(overlayWs, BADGES)
    return list?.length ? list : null
  }, 8000)
  check(badges?.length === 1, '活动组一个窗格 → 一个徽标', badges)
  check(badges?.[0] === `tabId ${tab.id}`, `徽标文案 = tabId ${tab.id}`, badges)

  // 浮层视图尺寸 = 紧包徽标的 bounds(不是铺满页面区;`WebContentsView` 没有点击穿透)
  const viewSize = await evalOn(overlayWs, '({ w: window.innerWidth, h: window.innerHeight })')
  check(viewSize?.w === expW && viewSize?.h === expH, `浮层视图紧包徽标(${expW}×${expH})`, viewSize)

  // 徽标圆心 = 窗格中心(本地坐标 = 窗口坐标 − bounds 原点)
  const origin = {
    x: Math.floor(center.x - BADGE_BOX.width / 2 - BADGE_BOX.padding),
    y: Math.floor(center.y - BADGE_BOX.height / 2 - BADGE_BOX.padding)
  }
  const box = await evalOn(
    overlayWs,
    `(() => { const r = document.querySelector('.tab-id-badge').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
  )
  check(
    box && Math.abs(box.x - (center.x - origin.x)) <= 1 && Math.abs(box.y - (center.y - origin.y)) <= 1,
    '徽标落在窗格正中央',
    box
  )
  check((await evalOn(pageWs, 'document.hasFocus()')) === true, '显示徽标期间不抢键盘焦点(页面仍持有焦点)')

  // ---------- 点徽标 → 复制纯数字 id ----------
  await cdp(overlayWs, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
    modifiers: 8
  })
  await cdp(overlayWs, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    clickCount: 1,
    modifiers: 8
  })
  await sleep(300)
  const clip = await evalOn(overlayWs, 'window.browserAPI.readClipboardText()')
  check(clip === String(tab.id), `点徽标复制纯数字 id(${tab.id})`, clip)
  check((await evalOn(overlayWs, BADGES))?.[0] === '已复制', '徽标短暂显示「已复制」')

  // ---------- 松开 Shift → 收起 ----------
  await releaseShift()
  await sleep(400)
  check(((await evalOn(overlayWs, BADGES)) ?? []).length === 0, '松开 Shift 后徽标消失')

  // ---------- 已开浮层时不抢(suggest / split-menu / 插件面板都走这一条判断) ----------
  await chromeEval(
    `window.browserAPI.showOverlay({ id: 'split-menu', placement: 'below-chrome', payload: { rect: { x: 0, y: 0, width: 0, height: 0 }, panes: [], focusedTabId: null, layouts: [] } })`
  )
  await sleep(300)
  await holdShift()
  await sleep(600)
  check(((await evalOn(overlayWs, BADGES)) ?? []).length === 0, '已有浮层打开时不显示徽标')
  await chromeEval('window.browserAPI.showOverlay(null)')
  await releaseShift()
  await sleep(300)

  // ---------- 分屏:每个窗格各一个徽标 ----------
  await chromeEval(`window.browserAPI.splitPane('right')`)
  await sleep(800)
  const splitPanes = await panesOf()
  check(splitPanes.length === 2, '分屏后活动组两个窗格', splitPanes.map((p) => p.tabId))
  await holdShift()
  await sleep(600)
  const splitBadges = await waitFor(async () => {
    const list = await evalOn(overlayWs, BADGES)
    return list?.length === 2 ? list : null
  }, 8000)
  check(
    JSON.stringify((splitBadges ?? []).map((s) => Number(s.replace('tabId ', ''))).sort()) ===
      JSON.stringify(splitPanes.map((p) => p.tabId).sort()),
    '两个徽标正好对应两个 tabId',
    splitBadges
  )

  // ---------- 揭示期间分屏变化 → 徽标跟随重算(refresh 路径) ----------
  await chromeEval(`window.browserAPI.splitPane('right')`)
  await sleep(900)
  const threeBadges = await waitFor(async () => {
    const list = await evalOn(overlayWs, BADGES)
    return list?.length === 3 ? list : null
  }, 8000)
  check(!!threeBadges, '按着 Shift 时分屏 → 徽标跟随重算(三个)', threeBadges ?? (await evalOn(overlayWs, BADGES)))
  await releaseShift()
  await sleep(300)
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
