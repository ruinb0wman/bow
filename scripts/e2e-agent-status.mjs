#!/usr/bin/env node
/**
 * 「终端里的 AI 代理状态 → 标签角标 + 系统通知」的端到端验证:
 * **真 Electron + 真终端(node-pty)+ 真 OSC 路径,只有 pi 是假的**。
 *
 * 链路:假 pi 往 pty 写 `ESC]1337;bow;{…}BEL` → 终端插件剥序列 + 上报 → 主进程归约
 *      → ① `TabInfo.agent`(标签栏角标)② OS 级系统通知 → 点击进入对应标签。
 *
 * 为什么用假 pi 而不是真 pi:真 pi 要 API key、要联网、每次输出还不一样;而这里要验证的
 * 是**bow 侧**的整条链路(协议 → 角标 → 通知 → 点击),假 pi 只打印那一条序列,覆盖的是真代码路径。
 * pi 扩展自己(事件 → 序列)的映射由 pi 那边的事件契约保证,不在本脚本范围内。
 *
 * 断言全部走 CDP:
 * - chrome 页面(`window.browserAPI.listTabs()` / 标签栏 DOM)—— 这是角标的权威数据与渲染;
 * - 终端页面(`window.__bowTerminal`)—— 往里敲命令、读回 buffer;
 * - 系统通知 —— 桌面通知无法从 CDP 观察(headless 下甚至可能没有 notification daemon),
 *   所以 bow 侧带 `BOW_NOTIFY_LOG` 测试缝:每次 show/close 追加一行 JSONL,本脚本读它;
 *   「点通知」也合成不了(那是 OS 层的事件),改用同一条回调的全局入口 `__bowNotifyClick`
 *   (同样只在设置了这个环境变量时存在)。
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
 * 主进程的 Node inspector 端口(`--inspect`)。系统通知从渲染层观测不到,两条路都走它:
 * 驱动 `globalThis.__bowNotifyClick`(OS 级点击合成不了),以及读 `BOW_NOTIFY_LOG` 的 JSONL。
 */
const inspectPort = 9400 + (run % 200)
/** 系统通知日志(测试缝):每行一条 show/close,见 src/main/systemNotify.ts */
const notifyLog = join(dir, `notify-${run}.jsonl`)
const electron = createRequire(import.meta.url)('electron')
/**
 * 默认用仓库里的 electron 跑 `out/`(开发产物)。设 `BOW_E2E_BIN` 指向打包后的可执行文件时,
 * 同一个脚本就能验**打包版** —— 唯一区别是 `app.getAppPath()` 变成 asar,而「一键接入」的源
 * 必须仍能从 asar 里读到(`package.json` 的 `build.files` 里那个 packages/pi-bow/extensions 就是为它加的)。
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

/** 读系统通知日志(测试缝);文件不存在/半行时返回已解析出来的部分 */
async function readNotices() {
  try {
    return readFileSync(notifyLog, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/** 等一条满足条件的通知日志(show / close) */
async function waitForNotice(predicate, timeoutMs = 12000) {
  return waitFor(async () => (await readNotices()).find(predicate) ?? null, timeoutMs)
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
rmSync(notifyLog, { force: true })

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
  {
    cwd: root,
    // BOW_NOTIFY_LOG 打开系统通知的测试缝(JSONL + __bowNotifyClick),见 src/main/systemNotify.ts
    env: { ...process.env, BOW_E2E_DIR: dir, PI_CODING_AGENT_DIR: piAgentDir, BOW_NOTIFY_LOG: notifyLog },
    stdio: 'ignore'
  }
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

  // ---------- 需要确认 → 系统通知(blocked) ----------
  await fakePiSend({ state: 'blocked', title: '切换到 build？', text: 'π - e2e' })
  const blockedTab = await waitFor(async () => {
    const tab = await tabById(tabId)
    return tab?.agent === 'blocked' ? tab : null
  }, 10000)
  check(!!blockedTab, 'blocked:角标变成等待确认', blockedTab?.agent)

  const blockedNotice = await waitForNotice((n) => n.event === 'show' && n.kind === 'blocked')
  check(!!blockedNotice, '发出「等待确认」系统通知', blockedNotice)
  check(blockedNotice?.title === 'pi 需要确认', '通知标题是「pi 需要确认」', blockedNotice?.title)
  check(String(blockedNotice?.body ?? '').includes('切换到 build？'), '通知正文带上对话框标题', blockedNotice?.body)
  check(String(blockedNotice?.body ?? '').includes('π - e2e'), '通知正文带上会话标签', blockedNotice?.body)

  // 窗内通知视图一整套已经删掉:不该再有任何 toast.html 页面
  check((await findTarget('toast.html')) === null, '不再有窗内通知视图(toast.html)')

  // ---------- 点通知 → 进入对应标签 ----------
  // 「点桌面通知」是 OS 层事件,CDP 合成不了 —— 走 bow 侧暴露的同一条 click 回调
  // (`__bowNotifyClick` 只在 BOW_NOTIFY_LOG 设置时存在,见 src/main/systemNotify.ts)。
  const mainTarget = async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json()
      return list.find((t) => t.webSocketDebuggerUrl) ?? null
    } catch {
      return null
    }
  }
  const clickHookReady = await waitFor(async () => {
    const t = await mainTarget()
    if (!t) return null
    const kind = await evalOn(t.webSocketDebuggerUrl, 'typeof globalThis.__bowNotifyClick')
    return kind === 'function' ? kind : null
  }, 10000)
  check(clickHookReady === 'function', '主进程暴露了 __bowNotifyClick(测试缝)')

  // 先把活动标签切走,这样「点通知切回来」才是一个可观测的变化
  const other = await chromeEval("window.browserAPI.createTab('about:blank')")
  await sleep(300)
  const activeBefore = (await tabs()).find((t) => t.active)?.id
  check(activeBefore === other?.id, '点击前焦点在另一个标签上', { activeBefore, other: other?.id })

  const mainWs = (await mainTarget())?.webSocketDebuggerUrl
  check(!!mainWs, '拿到主进程 inspector target', mainWs)
  if (mainWs) await evalOn(mainWs, `globalThis.__bowNotifyClick(${tabId})`)
  const activated = await waitFor(async () => {
    const active = (await tabs()).find((t) => t.active)
    return active?.id === tabId ? active : null
  }, 10000)
  check(!!activated, '点通知后进入对应标签', (await tabs()).find((t) => t.active)?.id)

  // 关键语义:**点通知只 = 「去看一眼」**,不等于用户在终端里回答了弹框 ——
  // 角标必须仍是 blocked(状态只有 pi 自己报出来才算数)。
  check((await tabById(tabId))?.agent === 'blocked', '角标仍停在等待确认(点通知 ≠ 回答弹框)', (await tabById(tabId))?.agent)

  // 真的回答了(pi 报 working)→ 角标回到 working,且那条等待通知被撤回(close)
  await fakePiSend({ state: 'working' })
  const resumed = await waitFor(async () => {
    const badge = (await tabById(tabId))?.agent
    const closed = (await readNotices()).some((n) => n.event === 'close' && n.kind === 'blocked' && n.tabId === tabId)
    return badge === 'working' && closed ? { badge, closed } : null
  }, 10000)
  check(!!resumed, '回答后角标回到 working 且等待通知被撤回', resumed ?? (await tabById(tabId))?.agent)

  // ---------- 任务完成 → 通知 + 角标 ----------
  await fakePiSend({ state: 'idle', done: true, text: 'π - e2e' })
  const doneTab = await waitFor(async () => {
    const tab = await tabById(tabId)
    return tab?.agent === 'done' ? tab : null
  }, 10000)
  check(!!doneTab, '完成:角标变成已完成(随后由主进程过期)', doneTab?.agent)

  const doneNotice = await waitForNotice((n) => n.event === 'show' && n.kind === 'done')
  check(!!doneNotice, '发出「已完成」系统通知', doneNotice)
  check(doneNotice?.title === 'pi 已完成', '完成通知标题是「pi 已完成」', doneNotice?.title)
  check(String(doneNotice?.body ?? '').includes('π - e2e'), '完成通知带上会话标签', doneNotice?.body)

  // ---------- 关标签 → 角标与在途的等待通知一起清掉 ----------
  await fakePiSend({ state: 'blocked', title: '再确认一次' })
  await waitForNotice((n) => n.event === 'show' && n.kind === 'blocked' && n.body === '再确认一次', 10000)
  await chromeEval(`window.browserAPI.closeTab(${tabId})`)
  const cleaned = await waitFor(async () => {
    const badge = await chromeEval("document.querySelectorAll('.tab-agent').length")
    const closed = (await readNotices()).some(
      (n) => n.event === 'close' && n.kind === 'blocked' && n.body === '再确认一次'
    )
    return badge === 0 && closed
  }, 10000)
  check(cleaned === true, '关标签后角标与在途的等待通知都清掉了')

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
  // 打包版专用判据:源必须能**从 asar 里**读到(也就是 build.files 里那个 packages/pi-bow/extensions 真的生效了)
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
