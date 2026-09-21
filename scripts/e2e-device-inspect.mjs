#!/usr/bin/env node
/**
 * 设备检查插件「操作 + 观测」工具的端到端验证:**真 Electron + 真 MCP + 真 TCP/WS,只有手机是假的**。
 *
 * 链路:MCP(stdio)→ bow 主进程 → device-inspect 插件 → adb(`scripts/fixtures/fake-phone-adb.mjs`)
 *      → adb forward(假设备端口)→ 剥 Origin 中继(relay.ts)→ CDP(真 WebSocket)→ 假设备上的 canned 页面。
 *
 * 覆盖:
 * - 11 个 device_* 工具在册;发现链路(设备 / 套接字 / App 包名 / targetKey)来自假 adb + 假 `/json`;
 * - `device_snapshot` 注入的是**核心** SNAPSHOT_FN(与 browser_snapshot 同一份脚本);
 * - `device_tap` 的 touchStart/touchEnd 与坐标、`mode:'mouse'` 的 mousePressed/mouseReleased、
 *   以及「touch 一次成功就不白开 `Emulation.setTouchEmulationEnabled`」;
 * - `device_type` 的「聚焦 + 全选 → Input.insertText → 读回」;`device_press_key` 的 keyDown/rawKeyDown;
 * - `device_console` 三类事件(console / 未捕获异常 / Log)的归一化;
 * - **手机 DevTools 前端窗格里分屏**:`device_inspect` 开出真前端标签 → 往那个 target 发
 *   `Ctrl+Shift+ArrowRight` → 断言该标签所在组从 1 个窗格变成 2 个(组的权威数据来自 chrome 页面的
 *   `window.browserAPI.getGroups()`,因为 MCP 的 browser_list_tabs 不返回 groupId)。
 *
 * 为什么要这套假设备:手机 + adb + 目标 App 开 WebView 调试这三件事在 CI 上不可能齐备,
 * 而上面每一条都是真代码路径(只有设备端字节是 canned 的)。用法:
 *
 * ```bash
 * npm run test:e2e:device            # 需要能跑 headless Electron(Linux/Windows/macOS 均可)
 * ```
 *
 * 造物与临时文件都在 `$TMPDIR/bow-e2e`(可用 `BOW_E2E_DIR` 覆盖);每次运行用**独立的
 * userData 与 remote-debugging 端口**,避免上一次运行泄漏的实例污染断言。
 * ⚠️ 不会碰你正在跑的 bow:它带 `--user-data-dir`,单实例锁因此隔离(见 `ua.hasExplicitUserData`)。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixtures = join(root, 'scripts', 'fixtures')
const dir = process.env.BOW_E2E_DIR ?? join(tmpdir(), 'bow-e2e')

// 每次运行独立的 userData / 调试端口:残留实例会占住端口,`/json` 与 getGroups 就会读到上一个实例的状态
const run = process.pid
const userdata = join(dir, `userdata-${run}`)
const cdpLog = join(dir, 'cdp-log.jsonl')
const forwardsFile = join(dir, 'forwards.json')
const debugPort = 9300 + (run % 400)
const fakeAdb = `node ${join(fixtures, 'fake-phone-adb.mjs')}`
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

mkdirSync(dir, { recursive: true })
rmSync(cdpLog, { force: true })
rmSync(forwardsFile, { force: true })
rmSync(userdata, { recursive: true, force: true })
mkdirSync(userdata, { recursive: true })
// 把插件的 adb 命令指向假 adb(复合命令:`node <fixture>`)
writeFileSync(
  join(userdata, 'device-inspect.json'),
  JSON.stringify({ version: 2, adbCommand: fakeAdb, strategy: 'electron-bundled', forwards: [] }, null, 2)
)

const transport = new StdioClientTransport({
  command: electron,
  args: [
    '.',
    '--no-sandbox',
    '--ozone-platform=headless',
    `--user-data-dir=${userdata}`,
    `--remote-debugging-port=${debugPort}`
  ],
  cwd: root,
  env: { ...process.env, MCP: 'stdio', BOW_E2E_DIR: dir },
  stderr: 'ignore'
})
const client = new Client({ name: 'bow-device-e2e', version: '0.0.0' }, { capabilities: {} })

/** 收掉本次实例(含它拉起的假设备进程)—— 不依赖 SDK 的 close 是否真的等到了进程退出 */
async function cleanup() {
  const pid = transport.pid
  if (pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
      else process.kill(pid, 'SIGTERM')
    } catch {
      /* 已经没了 */
    }
  }
  try {
    if (existsSync(forwardsFile)) {
      for (const record of JSON.parse(readFileSync(forwardsFile, 'utf8'))) {
        if (!record?.pid) continue
        try {
          if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(record.pid), '/f'], { stdio: 'ignore' })
          else process.kill(record.pid, 'SIGKILL')
        } catch {
          /* 已经没了 */
        }
      }
    }
  } catch {
    /* 文件坏了也无所谓,假设备进程随端口释放后自然没有意义 */
  }
  // 等进程真的退出再删 userData:Electron 在优雅退出的尾巴上还会写 browser.log,
  // 删早了会被它重建出一个空壳目录(实测)
  await sleep(1000)
  rmSync(userdata, { recursive: true, force: true })
}

/** 假设备收到的 CDP 命令(按时间顺序,插件发的与前端发的都在里面) */
const cdpEntries = () =>
  existsSync(cdpLog)
    ? readFileSync(cdpLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

async function waitFor(predicate, timeoutMs = 15000, stepMs = 200) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(stepMs)
  }
}

try {
  await client.connect(transport)
  console.log('✓ 已连接 MCP(bow 主进程已起,userData 隔离)')

  async function call(name, args = {}) {
    const res = await client.callTool({ name, arguments: args })
    const text = res.content?.find((c) => c.type === 'text')?.text
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }
    return { isError: res.isError === true, data }
  }

  // ---------------------------------------------------------------- 工具在册
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  for (const tool of [
    'device_list_targets',
    'device_inspect',
    'device_snapshot',
    'device_tap',
    'device_type',
    'device_press_key',
    'device_scroll',
    'device_console',
    'device_eval',
    'device_screenshot',
    'device_connect'
  ]) {
    check(names.includes(tool), `工具在册:${tool}`)
  }

  // ---------------------------------------------------------------- 发现(假 adb → 假设备)
  const listed = await call('device_list_targets')
  const device = listed.data?.devices?.[0]
  const socket = device?.sockets?.[0]
  const target = socket?.targets?.[0]
  const targetKey = target?.targetKey
  check(listed.data?.ok === true, 'device_list_targets ok', listed.data)
  check(device?.serial === 'FAKE123', '假设备串号(adb devices -l)', device)
  check(socket?.package === 'com.example.fake', 'App 包名(/json/version 的 Android-Package)', socket)
  check(socket?.name === 'webview_devtools_remote_4242', '套接字名(/proc/net/unix)', socket)
  check(target?.url === 'https://example.test/h5', '目标 URL(经中继改写后的 /json)', target)
  check(typeof targetKey === 'string' && targetKey.includes('FAKE-TARGET-1'), 'targetKey 形态', targetKey)

  // ---------------------------------------------------------------- device_snapshot
  const snap = await call('device_snapshot', { targetKey, maxElements: 5 })
  check(snap.data?.ok === true, 'device_snapshot ok', snap.data)
  check(snap.data?.targetKey === targetKey, 'device_snapshot 回传实际 targetKey', snap.data)
  check(snap.data?.data?.title === '假设备上的 H5 页面', '快照标题来自手机页面', snap.data?.data)
  check(snap.data?.data?.elements?.length === 2, '快照元素数', snap.data?.data)
  check(snap.data?.data?.elements?.[0]?.selector === '#go', '快照 selector', snap.data?.data?.elements?.[0])
  const snapEval = cdpEntries().find(
    (e) => e.method === 'Runtime.evaluate' && String(e.params?.expression).includes('__mcpSnapshot__')
  )
  check(!!snapEval, '快照走的是核心 SNAPSHOT_FN(与 browser_snapshot 同一份脚本)')
  check(
    String(snapEval?.params?.expression).includes('(5)'),
    'maxElements 传到了脚本里',
    snapEval?.params?.expression
  )

  // ---------------------------------------------------------------- device_tap(触摸 + 鼠标 + 参数校验)
  const tap = await call('device_tap', { selector: '#go' })
  check(tap.data?.ok === true && tap.data?.mode === 'touch', 'device_tap 走触摸', tap.data)
  check(tap.data?.x === 120 && tap.data?.y === 240, '坐标 = 页面返回的元素中心', tap.data)
  const touches = cdpEntries()
    .filter((e) => e.method === 'Input.dispatchTouchEvent')
    .map((e) => e.params)
  check(
    cdpEntries().some(
      (e) => e.method === 'Runtime.evaluate' && String(e.params?.expression).includes('__bowDevicePoint__')
    ),
    '点定位先注入 POINT_FN 量坐标'
  )
  check(touches.length === 2, 'touchStart + touchEnd 两个事件', touches.length)
  check(touches[0]?.type === 'touchStart' && touches[1]?.type === 'touchEnd', '触摸事件类型', touches)
  check(
    touches[0]?.touchPoints?.[0]?.x === 120 && touches[0]?.touchPoints?.[0]?.y === 240,
    '触摸点坐标(CSS 像素,不乘 dpr)',
    touches[0]?.touchPoints
  )
  check(
    !cdpEntries().some((e) => e.method === 'Emulation.setTouchEmulationEnabled'),
    '触摸一次成功 → 不该白开触摸模拟'
  )

  const mouseTap = await call('device_tap', { x: 5, y: 6, mode: 'mouse' })
  check(mouseTap.data?.ok === true && mouseTap.data?.mode === 'mouse', 'mode=mouse 直接走鼠标', mouseTap.data)
  const mouseEvents = cdpEntries()
    .filter((e) => e.method === 'Input.dispatchMouseEvent')
    .map((e) => e.params.type)
  check(
    mouseEvents.join(',') === 'mousePressed,mouseReleased',
    '鼠标按下 + 抬起(Chromium 由它合成 click)',
    mouseEvents
  )
  const badTap = await call('device_tap', { selector: '#go', x: 1, y: 2 })
  check(
    badTap.data?.ok === false && String(badTap.data.error).includes('只能给一个'),
    'selector 与 x/y 同时给 → 明确报错',
    badTap.data
  )

  // ---------------------------------------------------------------- device_type
  const typed = await call('device_type', { selector: '#q', text: 'hello 世界' })
  check(typed.data?.ok === true && typed.data?.value === 'hello 世界', 'device_type 输入并读回', typed.data)
  const insert = cdpEntries().find((e) => e.method === 'Input.insertText')
  check(insert?.params?.text === 'hello 世界', 'insertText 的文本(IME 路径)', insert?.params)
  check(
    cdpEntries().some(
      (e) => e.method === 'Runtime.evaluate' && String(e.params?.expression).includes('__bowDeviceFocus__')
    ),
    '输入前先聚焦 + 全选'
  )

  // ---------------------------------------------------------------- device_press_key
  const enter = await call('device_press_key', { key: 'Enter' })
  check(enter.data?.ok === true && enter.data?.keyCode === 13, 'device_press_key Enter', enter.data)
  const keyDown = cdpEntries().find(
    (e) => e.method === 'Input.dispatchKeyEvent' && e.params?.type === 'keyDown'
  )
  check(
    keyDown?.params?.text === '\r' && keyDown?.params?.windowsVirtualKeyCode === 13,
    'Enter 的 keyDown 带 text \\r 与 keyCode 13',
    keyDown?.params
  )
  const badKey = await call('device_press_key', { key: 'F5' })
  check(badKey.data?.ok === false, '不支持的按键 → 失败(F5 不在表里)', badKey.data)

  // ---------------------------------------------------------------- device_scroll
  const scrolled = await call('device_scroll', { direction: 'down', amount: 100 })
  check(scrolled.data?.ok === true && scrolled.data?.top === 321, 'device_scroll 回传 top', scrolled.data)

  // ---------------------------------------------------------------- device_console
  const consoleOut = await call('device_console', { durationMs: 500 })
  const entries = consoleOut.data?.entries ?? []
  check(consoleOut.data?.ok === true, 'device_console ok', consoleOut.data)
  check(consoleOut.data?.total === 3, '窗口内收到 3 条(console + 异常 + 浏览器日志)', consoleOut.data)
  check(
    entries.some((e) => e.source === 'console' && e.level === 'error' && e.text.includes('来自假设备的日志')),
    'console 条目归一化(args 拼接 + level)',
    entries
  )
  check(
    entries.some((e) => e.source === 'exception' && e.text.includes('假异常') && e.line === 20),
    '未捕获异常(description + 行号 1 起算)',
    entries
  )
  check(
    entries.some((e) => e.source === 'log' && e.origin === 'network'),
    '浏览器日志(Log.entryAdded → origin)',
    entries
  )

  // ---------------------------------------------------------------- 手机 DevTools 前端窗格里分屏
  const chromeTargets = async () => {
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

  // MCP 的 browser_list_tabs **不返回 groupId**,所以「是不是同一个分屏组」只能问 chrome 页面:
  // 它带应用 preload,可以直接读 window.browserAPI.getGroups()(标签栏画的就是这份数据)
  const chromeTarget = await waitFor(async () => {
    for (const candidate of await chromeTargets()) {
      if (!candidate.webSocketDebuggerUrl || String(candidate.url).startsWith('devtools://')) continue
      try {
        const kind = await evalOn(candidate.webSocketDebuggerUrl, 'typeof window.browserAPI?.getGroups')
        if (kind === 'function') return candidate
      } catch {
        /* 不是 chrome 页面 */
      }
    }
    return null
  }, 20000)
  check(!!chromeTarget, '找到 bow 的 chrome 页面 target(可读 getGroups)', chromeTarget?.url)
  const groups = async () =>
    chromeTarget ? await evalOn(chromeTarget.webSocketDebuggerUrl, 'window.browserAPI.getGroups()') : null

  const opened = await call('device_inspect', { targetKey })
  check(opened.data?.ok === true, 'device_inspect 开出前端标签', opened.data)
  const inspectorTab = await waitFor(async () => {
    const list = await call('browser_list_tabs')
    return list.data?.tabs?.find((t) => t.inspector === true) ?? null
  })
  check(!!inspectorTab, '前端标签已在标签列表里(inspector: true)', inspectorTab)
  const inspectorId = inspectorTab?.id

  const groupOfInspector = async () =>
    ((await groups()) ?? []).find((g) => (g.tabIds ?? []).includes(inspectorId)) ?? null
  const before = await groupOfInspector()
  check(before?.tabIds?.length === 1, '分屏前:前端标签独占一个组', before)

  const devtoolsTarget = await waitFor(async () => {
    const list = await chromeTargets()
    return list.find((t) => String(t.url).startsWith('devtools://')) ?? null
  }, 20000)
  check(!!devtoolsTarget, 'bow 自己的 remote-debugging 端点能看到前端 target', devtoolsTarget?.url)

  if (devtoolsTarget) {
    const keyParams = {
      modifiers: 10, // ctrl(2) + shift(8)
      key: 'ArrowRight',
      code: 'ArrowRight',
      windowsVirtualKeyCode: 39,
      nativeVirtualKeyCode: 39
    }
    // CDP 的按键事件会进主进程 `before-input-event`(2026-09-19 实测),
    // 所以这条就是「焦点在手机 DevTools 窗格上按 Ctrl+Shift+→」的真实路径
    const sendChord = async (type) => {
      const ws = new WebSocket(devtoolsTarget.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = () => reject(new Error('连不上前端 target'))
        setTimeout(() => reject(new Error('连前端 target 超时')), 5000)
      })
      ws.send(JSON.stringify({ id: 1, method: 'Input.dispatchKeyEvent', params: { type, ...keyParams } }))
      ws.send(JSON.stringify({ id: 2, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...keyParams } }))
      await sleep(500)
      ws.close()
    }

    const splitHappened = () =>
      waitFor(async () => {
        const group = await groupOfInspector()
        return (group?.tabIds?.length ?? 0) > 1 ? group : null
      }, 4000, 250)

    // 先 rawKeyDown(已知它会进 before-input-event);万一平台差异导致没反应,再用 keyDown 复核一次
    await sendChord('rawKeyDown')
    let after = await splitHappened()
    if (!after) {
      await sendChord('keyDown')
      after = await splitHappened()
    }

    check(after?.tabIds?.length === 2, 'Ctrl+Shift+→ 在手机 DevTools 窗格里分屏成功(该组变成 2 个窗格)', after)
    check((after?.tabIds ?? []).includes(inspectorId), '前端标签仍留在这个组里(不是被挤走 / 新开组)', after)
    const tabList = await call('browser_list_tabs')
    const newPane = (tabList.data?.tabs ?? []).find(
      (t) => after?.tabIds?.includes(t.id) && t.id !== inspectorId
    )
    check(newPane?.url === 'about:blank', '新窗格是空白标签(可以接着开终端 / 笔记)', newPane)
  }
} catch (error) {
  failures += 1
  console.error('✗ 运行期异常:' + (error instanceof Error ? error.message : String(error)))
} finally {
  try {
    await client.close()
  } catch {
    /* 已经关了 */
  }
  await cleanup()
}

console.log(failures === 0 ? '\n✅ 设备工具 E2E 全部通过' : `\n❌ 失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
