#!/usr/bin/env node
/**
 * 编辑器插件的端到端验证:**真 Electron + 真终端(node-pty)+ 真 nvim**。
 *
 * 验的是那条把「一个本地文件」变成「终端里的 nvim」的链路:
 *   `bow --edit a.txt` → 编辑器插件认领 → `ctx.tabs.openInternal('terminal')`
 *   → 内核事件 `terminal:run` → 终端插件用指定命令 spawn → nvim 真的把文件渲染出来了。
 *
 * 两次启动,分别验路由的两半:
 * - A 带 `--edit`:白名单外的扩展名也要进编辑器(右键「用 bow 编辑」走的就是它);
 * - B 不带:`--edit` 之外只看扩展名白名单 —— `.txt` 进编辑器、`.html` 照旧开浏览器标签。
 *
 * 断言全部走 CDP:
 * - chrome 页面(`browserAPI.listTabs()`):标签的 URL 与标题 —— 权威数据;
 * - 终端页面(`window.__bowTerminal`):会话状态与 xterm buffer 里的文本(文件内容就在那儿);
 * - 插件 IPC(`browserAPI.plugins.invoke('editor', …)`):设置与状态面。
 *
 * 前置:本机 PATH 上要有 `nvim`(Linux 默认配置就是 `nvim {file}`)。Windows 上跑这条脚本需要
 * WSL 里装了 nvim(用默认的 `wsl.exe -e nvim {file}`),并且脚本要能在 Windows 上启动 bow.exe。
 *
 * 用法(先 `npm run build`):
 * ```bash
 * npm run test:e2e:editor
 * BOW_E2E_BIN=dist/linux-unpacked/bow npm run test:e2e:editor   # 验打包版
 * ```
 * 造物在 `$TMPDIR/bow-e2e`,每次用独立的 userData 与调试端口,不会碰你正在跑的 bow。
 */

import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = process.env.BOW_E2E_DIR ?? join(tmpdir(), 'bow-e2e')
const run = process.pid
const electron = createRequire(import.meta.url)('electron')
const packagedBin = process.env.BOW_E2E_BIN?.trim() || null

const FILE_CONTENT = `bow-editor-e2e-${run}`
const TXT_NAME = `editor-target-${run}.txt`
const HTML_NAME = `editor-other-${run}.html`
const txtPath = join(dir, TXT_NAME)
const htmlPath = join(dir, HTML_NAME)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
let child = null
let userdata = ''

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

if (!packagedBin && !existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('✗ 没找到 out/main/index.js —— 先跑 `npm run build`')
  process.exit(1)
}
if (packagedBin && !existsSync(packagedBin)) {
  console.error(`✗ BOW_E2E_BIN 指向的文件不存在:${packagedBin}`)
  process.exit(1)
}

mkdirSync(dir, { recursive: true })
writeFileSync(txtPath, `${FILE_CONTENT}\n`)
writeFileSync(htmlPath, '<!doctype html><title>not-for-editor</title>\n')

// ---------------------------------------------------------------- 启动 / 收尾

let debugPort = 0

function launch(extraArgs) {
  debugPort = 9900 + ((run + (extraArgs.length > 1 ? 7 : 0)) % 90)
  child = spawn(
    packagedBin ?? electron,
    [
      ...(packagedBin ? [] : ['.']),
      '--no-sandbox',
      '--ozone-platform=headless',
      `--user-data-dir=${userdata}`,
      `--remote-debugging-port=${debugPort}`,
      ...extraArgs
    ],
    { cwd: root, env: { ...process.env }, stdio: 'ignore' }
  )
}

async function stop() {
  if (!child) return
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
    await sleep(700)
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
  child = null
  await sleep(400)
}

// ---------------------------------------------------------------- CDP 小工具

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
      setTimeout(() => reject(new Error('evaluate 超时')), 20000)
    })
  } finally {
    ws.close()
  }
}

const findTarget = async (needle) => {
  for (const candidate of await targets()) {
    if (!candidate.webSocketDebuggerUrl) continue
    if (String(candidate.url).includes(needle)) return candidate
  }
  return null
}

/** 连上 chrome 页面拿 `browserAPI`(标签数据的权威来源) */
async function connectChrome() {
  const target = await waitFor(async () => {
    for (const candidate of await targets()) {
      if (!candidate.webSocketDebuggerUrl || String(candidate.url).startsWith('devtools://')) continue
      try {
        if ((await evalOn(candidate.webSocketDebuggerUrl, 'typeof window.browserAPI?.listTabs')) === 'function') {
          return candidate
        }
      } catch {
        /* 不是 chrome 页面 */
      }
    }
    return null
  })
  if (!target) return null
  const evaluate = (expr) => evalOn(target.webSocketDebuggerUrl, expr)
  return {
    evaluate,
    tabs: async () => (await evaluate('window.browserAPI.listTabs()')) ?? []
  }
}

// ---------------------------------------------------------------- 两次启动的断言

/** A:`--edit` 让白名单外的文件也进编辑器(右键「用 bow 编辑」的语义) */
async function phaseEditFlag() {
  console.log('\n[A] bow --edit editor-target.txt')
  launch(['--edit', txtPath])

  const chrome = await waitFor(connectChrome)
  check(!!chrome, '找到 chrome target(可读 browserAPI.listTabs)')
  if (!chrome) return

  const termTab = await waitFor(async () => (await chrome.tabs()).find((t) => String(t.url).includes('terminal')))
  check(!!termTab, '--edit 的 .txt 开成了终端(编辑器)标签', termTab)
  const titled = await waitFor(async () =>
    (await chrome.tabs()).find((t) => String(t.title ?? '').includes(TXT_NAME))
  )
  check(!!titled, '标签标题带上文件名(终端插件拿命令名当标题)', (await chrome.tabs()).map((t) => t.title))
  check(
    !(await chrome.tabs()).some((t) => String(t.url).startsWith('file://')),
    '没有多开一个 file:// 标签(认领了就别再开浏览器标签)',
    (await chrome.tabs()).map((t) => t.url)
  )

  // ---------- nvim 真的起来了,而且打开的是那个文件 ----------
  const termTarget = await waitFor(() => findTarget('terminal'), 15000)
  check(!!termTarget, '找到终端页面 target', termTarget?.url)
  if (!termTarget) return
  const termEval = (expr) => evalOn(termTarget.webSocketDebuggerUrl, expr)
  const ready = await waitFor(async () => (await termEval('window.__bowTerminal?.status')) === 'ready', 15000)
  check(ready === true, '终端会话就绪(node-pty spawn 成功)', await termEval('window.__bowTerminal?.status'))

  const buffer = await waitFor(async () => {
    const text = (await termEval('window.__bowTerminal.bufferText()')) ?? ''
    return text.includes(FILE_CONTENT) ? text : null
  }, 20000)
  check(!!buffer, 'xterm buffer 里出现文件内容(nvim 真的把它打开了)', buffer?.slice(0, 160))

  // ---------- 插件面 ----------
  const settings = await chrome.evaluate("window.browserAPI.plugins.invoke('editor','getSettings')")
  check(!!settings?.extensions?.includes('.txt'), '设置面可读,白名单里有 .txt', settings?.extensions?.length)
  check(settings?.args?.some((a) => a.includes('{file}')), '命令模板里有 {file} 占位符', settings?.args)

  const statusInfo = await chrome.evaluate("window.browserAPI.plugins.invoke('editor','status')")
  check(statusInfo?.registered === false, '非 Windows 上 registered=false(没有注册表可写)')
  check(
    (statusInfo?.notes ?? []).some((n) => String(n).includes('当前不是 Windows')),
    '状态里说明「当前不是 Windows」',
    statusInfo?.notes
  )
  check(
    Array.isArray(statusInfo?.targets) && statusInfo.targets.some((t) => t.ext === '.txt'),
    '状态里列出了逐扩展名的当前归属',
    statusInfo?.targets?.length
  )
}

/** B:不带 `--edit` → 只看扩展名白名单;白名单外的 `.html` 必须回落成浏览器标签 */
async function phaseExtensionRouting() {
  console.log('\n[B] bow editor-target.txt editor-other.html(不带 --edit)')
  launch([txtPath, htmlPath])

  const chrome = await waitFor(connectChrome)
  check(!!chrome, '找到 chrome target')
  if (!chrome) return

  const htmlTab = await waitFor(async () =>
    (await chrome.tabs()).find((t) => String(t.url).includes(HTML_NAME))
  )
  check(!!htmlTab, '.html 不在白名单里 → 照旧开 file:// 浏览器标签', (await chrome.tabs()).map((t) => t.url))
  check(String(htmlTab?.url ?? '').startsWith('file://'), '.html 那个标签的 URL 是 file://', htmlTab?.url)

  const termTabs = (await chrome.tabs()).filter((t) => String(t.url).includes('terminal'))
  check(termTabs.length === 1, '.txt 仍然进编辑器(白名单命中),且只有一个终端标签', termTabs.map((t) => t.title))
}

// ---------------------------------------------------------------- 主流程

async function main() {
  userdata = join(dir, `editor-userdata-${run}`)
  rmSync(userdata, { recursive: true, force: true })
  mkdirSync(userdata, { recursive: true })

  await phaseEditFlag()
  await stop()
  rmSync(userdata, { recursive: true, force: true })
  mkdirSync(userdata, { recursive: true })
  await phaseExtensionRouting()
}

main()
  .catch((e) => {
    failures += 1
    console.error('✗ 脚本异常', e)
  })
  .finally(async () => {
    await stop()
    rmSync(userdata, { recursive: true, force: true })
    rmSync(txtPath, { force: true })
    rmSync(htmlPath, { force: true })
    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项未通过`)
    process.exit(failures === 0 ? 0 : 1)
  })
