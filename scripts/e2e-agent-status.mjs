#!/usr/bin/env node
/**
 * 「终端里的 AI 代理状态 → 标签角标 + 底部居中通知」的端到端验证:
 * **真 Electron + 真终端(node-pty)+ 真 OSC 路径,只有 pi 是假的**。
 *
 * 链路:假 pi 往 pty 写 `ESC]1337;bow;{…}BEL` → 终端插件剥序列 + 上报 → 主进程归约
 *      → ① `TabInfo.agent`(标签栏角标)② 底部居中通知视图 → 点击进入对应标签。
 *
 * 为什么用假 pi 而不是真 pi:真 pi 要 API key、要联网、每次输出还不一样;而这里要验证的
 * 是**bow 侧**的整条链路(协议 → 角标 → 通知 → 点击),假 pi 只打印那一条序列,覆盖的是真代码路径。
 * pi 扩展自己(事件 → 序列)的映射由 pi 那边的事件契约保证,不在本脚本范围内。
 *
 * 断言全部走 CDP:
 * - chrome 页面(`window.browserAPI.listTabs()` / 标签栏 DOM)—— 这是角标的权威数据与渲染;
 * - 终端页面(`window.__bowTerminal`)—— 往里敲命令、读回 buffer;
 * - 通知页面(toast.html)—— 卡片文本、高度、点击行为。
 *
 * 用法(需要先构建过一次:`npm run build`):
 * ```bash
 * npm run test:e2e:agent
 * BOW_E2E_BIN=dist/linux-unpacked/bow npm run test:e2e:agent   # 改验**打包版**(D-8:源码要能从 asar 里读到)
 * ```
 * 造物在 `$TMPDIR/bow-e2e`,每次用独立的 userData 与调试端口,不会碰你正在跑的 bow。
 */

import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = process.env.BOW_E2E_DIR ?? join(tmpdir(), 'bow-e2e')
const run = process.pid
const userdata = join(dir, `agent-userdata-${run}`)
const fakePi = join(dir, `fake-pi-${run}.mjs`)
/** 把 pi 的 agent 目录钉在临时目录里:一键接入那段**绝不能**碰用户真实的 ~/.pi */
const piAgentDir = join(dir, `pi-agent-${run}`)
const debugPort = 9700 + (run % 200)
/**
 * 主进程的 Node inspector 端口(`--inspect`)。**只为读真窗口/真子视图的 bounds** ——
 * 通知视图的屏幕位置在渲染层量不到:toast 页的 `window.screenX/Y` 在 `WebContentsView` 里
 * 返回的是**宿主窗口**的位置(不含子视图偏移,headless 下实测恒等于窗口的 screenX),
 * 所以只能从主进程 `BrowserWindow.contentView.children` 上读 `getBounds()`。
 */
const inspectPort = 9400 + (run % 200)
const electron = createRequire(import.meta.url)('electron')
/**
 * 默认用仓库里的 electron 跑 `out/`(开发产物)。设 `BOW_E2E_BIN` 指向打包后的可执行文件时,
 * 同一个脚本就能验**打包版** —— 唯一区别是 `app.getAppPath()` 变成 asar,而「一键接入」的源
 * 必须仍能从 asar 里读到(`package.json` 的 `build.files` 里那个 `integrations` 就是为它加的)。
 */
const packagedBin = process.env.BOW_E2E_BIN?.trim() || null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

function check(cond, label, detail) {
  if (cond) console.log(`✓ ${label}`)
  else {
    failures += 1
    console.error(`✗ ${label}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
  }
}

async function waitFor(predicate, timeoutMs = 12000, stepMs = 150) {
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

if (!packagedBin && !existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('✗ 没找到 out/main/index.js —— 先跑 `npm run build`')
  process.exit(1)
}
if (packagedBin && !existsSync(packagedBin)) {
  console.error(`✗ BOW_E2E_BIN 指向的文件不存在:${packagedBin}`)
  process.exit(1)
}

mkdirSync(dir, { recursive: true })
rmSync(userdata, { recursive: true, force: true })
mkdirSync(userdata, { recursive: true })

// 假 pi:把 JSON 原样包成一条 bow 信号打到 stdout(pty 里看到的就是这条序列)
writeFileSync(
  fakePi,
  [
    "const payload = JSON.parse(process.argv[2] ?? '{}')",
    "process.stdout.write('\\x1b]1337;bow;' + JSON.stringify({ v: 1, agent: 'pi', ...payload }) + '\\x07')"
  ].join('\n')
)

const child = spawn(
  packagedBin ?? electron,
  [
    // 打包后的可执行文件自带 app 路径,不需要再传 '.'
    ...(packagedBin ? [] : ['.']),
    '--no-sandbox',
    '--ozone-platform=headless',
    `--user-data-dir=${userdata}`,
    `--remote-debugging-port=${debugPort}`,
    `--inspect=${inspectPort}`
  ],
  { cwd: root, env: { ...process.env, BOW_E2E_DIR: dir, PI_CODING_AGENT_DIR: piAgentDir }, stdio: 'ignore' }
)

async function cleanup() {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      /* 已经没了 */
    }
  } else {
    // 先 SIGTERM 给一个优雅退出的机会;但 bow 的「关闭确认浮层」会拦下窗口 close,`app.quit()`
    // 因此可能被中止而吞掉 SIGTERM(实测会留下整棵进程树),所以补一記 SIGKILL。
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
  rmSync(piAgentDir, { recursive: true, force: true })
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
        else resolve(message.result?.result?.value)
      }
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
      setTimeout(() => reject(new Error('evaluate 超时')), 5000)
    })
  } finally {
    ws.close()
  }
}

/** 按 URL 关键词找一个 target(chrome / 终端页 / 通知页) */
const findTarget = async (needle) => {
  for (const candidate of await targets()) {
    if (!candidate.webSocketDebuggerUrl) continue
    if (String(candidate.url).includes(needle)) return candidate
  }
  return null
}

async function main() {
  // ---------- chrome(标签栏的权威数据与渲染都在这) ----------
  const chromeTarget = await waitFor(async () => {
    for (const candidate of await targets()) {
      if (!candidate.webSocketDebuggerUrl || String(candidate.url).startsWith('devtools://')) continue
      try {
        const kind = await evalOn(candidate.webSocketDebuggerUrl, 'typeof window.browserAPI?.listTabs')
        if (kind === 'function') return candidate
      } catch {
        /* 不是 chrome 页面 */
      }
    }
    return null
  }, 20000)
  check(!!chromeTarget, '找到 chrome target(可读 browserAPI.listTabs)', chromeTarget?.url)
  if (!chromeTarget) return
  const chromeEval = (expr) => evalOn(chromeTarget.webSocketDebuggerUrl, expr)
  const tabs = () => chromeEval('window.browserAPI.listTabs()')
  const tabById = async (id) => ((await tabs()) ?? []).find((t) => t.id === id) ?? null

  // ---------- 开一个终端标签 ----------
  const created = await chromeEval("window.browserAPI.createTab('bow://terminal')")
  check(!!created?.id, '开出终端标签(bow://terminal)', created)
  const tabId = created?.id

  const termTarget = await waitFor(() => findTarget('terminal.html'), 15000)
  check(!!termTarget, '找到终端页面 target', termTarget?.url)
  if (!termTarget) return
  const termEval = (expr) => evalOn(termTarget.webSocketDebuggerUrl, expr)
  const ready = await waitFor(async () => (await termEval('window.__bowTerminal?.status')) === 'ready', 15000)
  check(ready === true, '终端会话就绪(shell 起来了)', await termEval('window.__bowTerminal?.status'))

  const selfTab = await termEval('window.__bowTerminal.tabId')
  check(selfTab === tabId, '终端会话绑在同一个 tabId 上(信号才能落到这个标签)', { selfTab, tabId })

  // 往 pty 里敲一条命令(与真人一样走 xterm → node-pty)
  const send = (line) => termEval(`window.__bowTerminal.send(${JSON.stringify(line)})`)
  const buffer = () => termEval('window.__bowTerminal.bufferText()')
  /** 让假 pi 发一条状态 */
  const fakePiSend = (payload) => send(`node ${fakePi} '${JSON.stringify(payload)}'\r`)

  // ---------- 环境变量门禁:桥接扩展靠它判断「自己在 bow 里」 ----------
  await send('echo BOW=$BOW_TERMINAL\r')
  const envLine = await waitFor(async () => ((await buffer()) ?? '').includes('BOW=1'), 10000)
  check(envLine === true, 'pty 环境里有 BOW_TERMINAL=1(pi 桥接扩展的门禁)')

  // ---------- 正在执行 → 标签角标 ----------
  await fakePiSend({ state: 'working' })
  const working = await waitFor(async () => {
    const tab = await tabById(tabId)
    const dom = await chromeEval("!!document.querySelector('.tab-agent.agent-working')")
    return tab?.agent === 'working' && dom === true ? tab : null
  }, 10000)
  check(!!working, 'working:TabInfo.agent 与标签栏角标同时生效', { agent: (await tabById(tabId))?.agent })

  // ---------- 需要确认 → 底部居中通知 ----------
  await fakePiSend({ state: 'blocked', title: '切换到 build？', text: 'π - e2e' })
  const blockedTab = await waitFor(async () => {
    const tab = await tabById(tabId)
    return tab?.agent === 'blocked' ? tab : null
  }, 10000)
  check(!!blockedTab, 'blocked:角标变成等待确认', blockedTab?.agent)

  const toastTarget = await waitFor(() => findTarget('toast.html'), 10000)
  check(!!toastTarget, '底部居中通知视图已创建', toastTarget?.url)
  if (!toastTarget) return
  const toastEval = (expr) => evalOn(toastTarget.webSocketDebuggerUrl, expr)

  const card = await waitFor(async () => {
    const text = await toastEval("document.querySelector('.toast-card.blocked')?.innerText ?? ''")
    return text && text.includes('需要确认') ? text : null
  }, 10000)
  check(!!card, '通知卡片出现且标题是「需要确认」', card)
  check(String(card).includes('切换到 build？'), '通知卡片带上对话框标题', card)

  const height = await toastEval("Math.round(document.querySelector('.toast-stack')?.getBoundingClientRect().height ?? 0)")
  check(Number(height) > 0, '通知栈量出真实高度(视图 bounds 靠它,不能是 0)', height)

  // ---------- 视图位置:底部 + 水平居中 ----------
  // 从**主进程**读真 child view 的 bounds(为什么不在渲染层量:见顶部 `inspectPort` 的注释)。
  const mainTarget = async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
      return list.find((t) => t.webSocketDebuggerUrl) ?? null
    } catch {
      return null
    }
  }
  const probe = `(() => { const req = typeof require === 'function' ? require : process.mainModule.require; const e = req('electron'); const w = e.BrowserWindow.getAllWindows()[0]; const v = w.contentView.children.find((c) => (c.webContents?.getURL?.() ?? '').includes('toast.html')); if (!v) return ''; return JSON.stringify({ content: w.getContentSize(), bounds: v.getBounds() }) })()`
  const hostGeom = await waitFor(async () => {
    const t = await mainTarget()
    if (!t) return null
    const raw = await evalOn(t.webSocketDebuggerUrl, probe)
    return raw ? JSON.parse(raw) : null
  }, 10000)
  check(!!hostGeom, '从主进程读到通知视图的真 bounds', hostGeom)
  if (hostGeom) {
    const [w, h] = hostGeom.content
    const b = hostGeom.bounds
    check(b.width === 360, '通知视图宽 = TOAST_WIDTH(360)', b)
    check(
      Math.abs(b.x - Math.max(0, Math.round((w - b.width) / 2))) <= 1,
      '通知视图水平居中(不是旧的贴右下角)',
      { 期望x: Math.round((w - b.width) / 2), 实际: b, 窗宽: w }
    )
    check(b.y + b.height === h - 12, '通知视图贴底部(距底 12px)', { 实际: b, 窗高: h })
  }

  // ---------- 点通知 → 进入对应标签 ----------
  // 先把活动标签切走,这样「点通知切回来」才是一个可观测的变化
  const other = await chromeEval("window.browserAPI.createTab('about:blank')")
  await sleep(300)
  const activeBefore = (await tabs()).find((t) => t.active)?.id
  check(activeBefore === other?.id, '点击前焦点在另一个标签上', { activeBefore, other: other?.id })

  await toastEval("document.querySelector('.toast-card.blocked').click()")
  const activated = await waitFor(async () => {
    const active = (await tabs()).find((t) => t.active)
    return active?.id === tabId ? active : null
  }, 10000)
  check(!!activated, '点通知后进入对应标签', (await tabs()).find((t) => t.active)?.id)

  const cleared = await waitFor(async () => {
    const cards = await toastEval("document.querySelectorAll('.toast-card').length")
    return cards === 0 ? { cards } : null
  }, 10000)
  check(cleared?.cards === 0, '点过的等待通知已摘掉')
  // 关键语义:**点通知只 = 「去看一眼」**,不等于用户在终端里回答了弹框 ——
  // 角标必须仍是 blocked(状态只有 pi 自己报出来才算数)。
  check((await tabById(tabId))?.agent === 'blocked', '角标仍停在等待确认(点通知 ≠ 回答弹框)', (await tabById(tabId))?.agent)

  // 真的回答了(pi 报 working)→ 角标回到 working,且等待类通知不该复活
  await fakePiSend({ state: 'working' })
  const resumed = await waitFor(async () => {
    const badge = (await tabById(tabId))?.agent
    const cards = await toastEval("document.querySelectorAll('.toast-card').length")
    return badge === 'working' && cards === 0 ? { badge, cards } : null
  }, 10000)
  check(!!resumed, '回答后角标回到 working(等待通知不复活)', resumed ?? (await tabById(tabId))?.agent)

  // ---------- 任务完成 → 通知 + 角标 ----------
  await fakePiSend({ state: 'idle', done: true, text: 'π - e2e' })
  const doneTab = await waitFor(async () => {
    const tab = await tabById(tabId)
    return tab?.agent === 'done' ? tab : null
  }, 10000)
  check(!!doneTab, '完成:角标变成已完成(随后由主进程过期)', doneTab?.agent)

  const doneCard = await waitFor(async () => {
    const text = await toastEval("document.querySelector('.toast-card.done')?.innerText ?? ''")
    return text && text.includes('已完成') ? text : null
  }, 10000)
  check(!!doneCard, '完成通知出现', doneCard)
  check(String(doneCard).includes('π - e2e'), '完成通知带上会话标签', doneCard)

  // × 能关掉它(自动关闭由单测覆盖,这里只验手动路径)
  await toastEval("document.querySelector('.toast-card.done .toast-close').click()")
  const dismissed = await waitFor(async () => (await toastEval("document.querySelectorAll('.toast-card').length")) === 0, 10000)
  check(dismissed === true, '× 能关掉通知')

  // ---------- 关标签 → 通知与角标一起清掉 ----------
  await fakePiSend({ state: 'blocked', title: '再确认一次' })
  await waitFor(async () => ((await toastEval("document.querySelectorAll('.toast-card').length")) ?? 0) > 0, 10000)
  await chromeEval(`window.browserAPI.closeTab(${tabId})`)
  const cleaned = await waitFor(async () => {
    const badge = await chromeEval("document.querySelectorAll('.tab-agent').length")
    const cards = await toastEval("document.querySelectorAll('.toast-card').length")
    return badge === 0 && cards === 0
  }, 10000)
  check(cleaned === true, '关标签后角标与通知都清掉了')

  // ---------------------------------------------------------------- 设置页「Pi 状态联动」一键接入
  // 这一段跟 pi 无关:它验的是「点一下真的把文件写进 pi 的扩展目录」(PI_CODING_AGENT_DIR 指向临时目录)
  console.log('\n--- 设置页一键接入 ---')
  await chromeEval("window.browserAPI.createTab('bow://settings')")
  const settingsTarget = await waitFor(() => findTarget('settings.html'), 15000)
  check(!!settingsTarget, '找到设置页 target', settingsTarget?.url)
  if (!settingsTarget) return
  const settingsEval = (expr) => evalOn(settingsTarget.webSocketDebuggerUrl, expr)

  const navOk = await waitFor(async () => {
    const clicked = await settingsEval(`(() => {
      const item = [...document.querySelectorAll('.settings-nav-item')].find((el) => el.innerText.includes('终端'))
      if (!item) return false
      item.click()
      return true
    })()`)
    return clicked === true
  }, 15000)
  check(navOk === true, '侧栏点进「终端」分区')

  const bridgeState = () => settingsEval("document.querySelector('[data-bridge-state]')?.innerText ?? ''")
  const before = await waitFor(async () => {
    const text = await bridgeState()
    // 状态是异步拉的:先渲染「检查中…」,得等到真结果 —— 否则打包版会在这里误判(实测会 flake)
    return text && !/检查中/.test(text) ? text : null
  }, 10000)
  check(/未接入/.test(String(before)), '初始状态是「未接入」', before)

  const installedFile = join(piAgentDir, 'extensions', 'bow-agent-state.ts')
  // 打包版专用判据:源必须能**从 asar 里**读到(也就是 build.files 里那个 integrations 真的生效了)
  const sourceReadable = await settingsEval(
    "window.browserAPI.plugins.invoke('terminal','piBridgeStatus').then((s) => s.sourceAvailable && s.source)"
  )
  check(!!sourceReadable, 'bow 能读到自带的扩展源码(打包版 = 从 asar 里读)', sourceReadable)

  // 「WSL2 请执行这条命令」那段说明:只在 Windows(bow 与 pi 可能是两个系统)且用户配了 WSL 终端时才出现。
  // 这条 E2E 跑在 Linux 上,所以这里断言的是**不该出现**(免得给不存在 WSL 的人看一段误导的提示);
  // 「Windows 上会给、且命令里的 /mnt/<盘> 换算正确」由 tests/piBridge.test.ts 的纯函数用例覆盖。
  const wslField = await settingsEval(
    "window.browserAPI.plugins.invoke('terminal','piBridgeStatus').then((s) => Object.hasOwn(s, 'wsl'))"
  )
  check(wslField === false, '非 Windows 时状态里没有 wsl 字段(bow 与 pi 在同一个系统里)', String(wslField))
  const wslNote = await settingsEval("!!document.querySelector('[data-bridge-wsl]')")
  check(wslNote === false, '非 Windows 时不显示「装进 WSL2」的说明')

  await settingsEval("document.querySelector('[data-bridge-action=install]').click()")
  const after = await waitFor(async () => {
    const text = await bridgeState()
    return /最新/.test(text) ? text : null
  }, 10000)
  check(!!after, '点「安装」后状态变成已接入(最新)', after)
  check(existsSync(installedFile), '扩展文件真的写进了 pi 的扩展目录', installedFile)
  check(
    existsSync(installedFile) && readFileSync(installedFile, 'utf-8').includes('managed by bow'),
    '落盘的文件带 managed by bow 标记(这就是卸载时的归属判据)'
  )

  await settingsEval("document.querySelector('[data-bridge-action=uninstall]').click()")
  const removed = await waitFor(async () => {
    const text = await bridgeState()
    return /未接入/.test(text) ? text : null
  }, 10000)
  check(!!removed, '点「卸载」后回到未接入', removed)
  check(!existsSync(installedFile), '文件真的被删掉了')
}

try {
  await main()
} catch (e) {
  failures += 1
  console.error('✗ E2E 异常:', e instanceof Error ? e.message : e)
} finally {
  await cleanup()
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
// 显式退出:探测主进程要连 `--inspect` 的 WebSocket,那个连接会让事件循环留着一个句柄,
// 不 exit 的话脚本会在打印「全部通过」之后挂住(表现为 CI 卡死、管道不回 EOF)。
process.exit(0)
