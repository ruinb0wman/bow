#!/usr/bin/env node
/**
 * 夸克网盘插件的**离线端到端**验证 —— 不需要夸克账号、不需要真的 aria2。
 *
 * 做法:把两个夸克域名(pan / drive-pc)用 Chromium 的 `--host-resolver-rules`
 * 指到本机一个 HTTPS 假服务器上,再起一个假的 aria2 JSON-RPC 服务器,
 * 于是整条链路都能在真实 bow 里跑一遍:
 *
 *   假夸克页(React fiber) → quark 插件的 listFiles → 假 /file/download 接口
 *     → 插件用 JSON-RPC aria2.addUri 推给假 aria2 → 断言**服务端真正收到了什么**
 *
 * 驱动方式:页面用 MCP 的核心工具(`browser_navigate`)打开;插件 IPC 没法从 MCP 调
 * (夸克插件不再贡献 MCP 工具),所以用 bow 自己的 `--remote-debugging-port`,
 * 在 chrome 页面的 target 上 `Runtime.evaluate` 调 `window.browserAPI.plugins.invoke(...)`
 * —— 与 `e2e-device-inspect.mjs` 读 `getGroups()` 是同一手法。
 *
 * 为什么值得单独写一个脚本(而不是只留单测):这里钉的是**真 Electron 行为** ——
 * 真 cookie 域罐、真 `net.fetch`(注意它不能带 `Origin`)、真 HTTPS 与自签证书。
 * 详见 `.pi/plans/2026-09-24-quark-plugin/plan.md`。
 *
 * 用法:node scripts/e2e-quark-headers.mjs        # 需要 openssl(生成自签证书)与已构建的 out/
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'bow-quark-e2e-'))
const userDataDir = join(work, 'ud')
mkdirSync(userDataDir, { recursive: true })

const FID_A = 'e2e0000000000000000000000000000a'
const FID_B = 'e2e0000000000000000000000000000b'
const FOLDER_FID = 'e2e0000000000000000000000000000c'
const NAME_A = 'e2e-quark.bin'
const NAME_B = 'e2e-other.bin'
/** 白名单内(quark.cn)→ 应把 Cookie 交给 aria2 */
const URL_A = 'https://cdn-1.quark.cn/f/e2e-quark.bin?sig=x'
/** 白名单外 → 绝不把 Cookie 交给 aria2 */
const URL_B = 'https://bucket.aliyuncs.com/f/e2e-other.bin'
const UA_PREFIX = 'quark-cloud-drive/'

let failures = 0
function check(ok, label, extra = '') {
  if (ok) {
    console.log(`✓ ${label}`)
  } else {
    failures += 1
    console.log(`✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}
function assert(ok, label, extra = '') {
  check(ok, label, extra)
  if (!ok) throw new Error(label)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 15000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(stepMs)
  }
  return null
}

// ---------- 1. 自签证书 ----------
function makeCert() {
  const r = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem'),
      '-days', '2', '-nodes', '-subj', '/CN=quark-e2e',
      '-addext', 'subjectAltName=DNS:pan.quark.cn,DNS:drive-pc.quark.cn,IP:127.0.0.1'
    ],
    { stdio: 'ignore' }
  )
  if (r.status !== 0 || !existsSync(join(work, 'cert.pem'))) {
    console.error('✗ 生成自签证书失败:需要 openssl(这个脚本依赖它做 HTTPS 假服务器)')
    process.exit(2)
  }
  return { key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')) }
}

// ---------- 2. 假夸克服务器 ----------
const seen = []
function record(tag, req) {
  seen.push({ tag, method: req.method, url: req.url, host: req.headers.host, headers: { ...req.headers } })
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>夸克网盘(E2E)</title></head>
<body>
<div id="app"></div>
<script>
  // 伪造 React fiber 链:夸克插件就是沿 __reactFiber$ 向上找带 list 数组的 props
  var props = {
    list: [
      { fid: ${JSON.stringify(FID_A)}, file_name: ${JSON.stringify(NAME_A)}, size: 11, file: true },
      { fid: ${JSON.stringify(FID_B)}, file_name: ${JSON.stringify(NAME_B)}, size: 22, file: true },
      { fid: ${JSON.stringify(FOLDER_FID)}, file_name: 'a-folder', size: 0, file: false }
    ],
    selectedRowKeys: [],
    stoken: 'e2e-stoken'
  };
  var container = document.createElement('div');
  container.className = 'file-list';
  document.getElementById('app').appendChild(container);
  container['__reactFiber$e2e'] = { return: null, stateNode: { props: props } };
  // 往 .quark.cn 写一个 cookie:验证「插件从 cookie 域罐里取登录态」这条
  document.cookie = 'e2e=1; path=/; domain=.quark.cn';
</script>
</body></html>`
}

function startQuarkServer(cert) {
  const server = https.createServer(cert, (req, res) => {
    const url = req.url || '/'
    if (req.method === 'POST' && url.startsWith('/1/clouddrive/file/download')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        record('api', req)
        seen.push({ tag: 'api-body', body })
        let fids = []
        try {
          fids = JSON.parse(body).fids ?? []
        } catch {
          /* 坏 body 就当没请求 */
        }
        const data = fids.map((fid) =>
          fid === FID_B
            ? { fid, file_name: NAME_B, size: 22, download_url: URL_B }
            : { fid, file_name: NAME_A, size: 11, download_url: URL_A }
        )
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data }))
      })
      return
    }
    if (url === '/' || url.startsWith('/list') || url.startsWith('/s/')) {
      record('page', req)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(pageHtml())
      return
    }
    record('other', req)
    res.writeHead(404)
    res.end('nope')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// ---------- 3. 假 aria2 JSON-RPC 服务器 ----------
const aria2Calls = []
function startAria2Server() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let json = null
      try {
        json = JSON.parse(body)
      } catch {
        /* 忽略 */
      }
      aria2Calls.push({ url: req.url, headers: { ...req.headers }, body: json })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (json?.method === 'aria2.addUri') {
        res.end(JSON.stringify({ id: json.id, jsonrpc: '2.0', result: `gid-${aria2Calls.length}` }))
      } else if (json?.method === 'aria2.getVersion') {
        res.end(JSON.stringify({ id: json.id, jsonrpc: '2.0', result: { version: '1.37.0-e2e' } }))
      } else {
        res.end(JSON.stringify({ id: json?.id ?? 0, jsonrpc: '2.0', error: { code: -32601, message: 'nope' } }))
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// ---------- 4. 工具 ----------
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

function electronBin() {
  const p = join(root, 'node_modules', 'electron', 'dist', 'electron')
  if (existsSync(p)) return p
  const shim = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
  if (existsSync(shim)) return shim
  console.error('✗ 找不到 electron 可执行文件')
  process.exit(2)
}

async function waitForEndpoint(url, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      })
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  return false
}

/** 在任意 target 上跑一段表达式(Runtime.evaluate + returnByValue + awaitPromise) */
function evalOn(wsUrl, expression, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('evaluate 超时'))
    }, timeoutMs)
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('连不上 target'))
    }
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      )
    }
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (message.error) reject(new Error(message.error.message))
      else if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text ?? 'evaluate 抛错'))
      } else resolve(message.result?.result?.value)
    }
  })
}

// ---------- 主流程 ----------
async function main() {
  if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
    console.error('✗ 没有 out/main/index.js —— 先跑 npm run build')
    process.exit(2)
  }

  const cert = makeCert()
  const quarkServer = await startQuarkServer(cert)
  const quarkPort = quarkServer.address().port
  const aria2Server = await startAria2Server()
  const aria2Port = aria2Server.address().port
  console.log(`· 假夸克服务器(HTTPS):127.0.0.1:${quarkPort} · 假 aria2 RPC:127.0.0.1:${aria2Port}`)

  // 插件设置:把 aria2 RPC 指向假服务器(隔离的 userData,不会碰用户的 quark.json)
  writeFileSync(
    join(userDataDir, 'quark.json'),
    JSON.stringify(
      { aria2: { domain: 'http://127.0.0.1', port: String(aria2Port), path: '/jsonrpc', token: '', dir: '' } },
      null,
      2
    )
  )

  const mcpPort = await freePort()
  const debugPort = await freePort()
  const httpUrl = `http://127.0.0.1:${mcpPort}/mcp`
  const resolver = [`MAP pan.quark.cn 127.0.0.1:${quarkPort}`, `MAP drive-pc.quark.cn 127.0.0.1:${quarkPort}`].join(',')

  const child = spawn(
    electronBin(),
    [
      '.',
      // 隔离 userData:**单实例锁**与用户的 bow 分开(只设 BOW_USER_DATA_DIR 不管用,见 MEMORY)
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--ignore-certificate-errors',
      `--remote-debugging-port=${debugPort}`,
      `--host-resolver-rules=${resolver}`
    ],
    { cwd: root, env: { ...process.env, MCP_HTTP: '1', MCP_HTTP_PORT: String(mcpPort) }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))
  const cleanup = async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve))
        child.kill('SIGKILL')
        // ⚠️ 必须等子进程真的退出再删:kill 是异步的,Electron 被杀时还在写 userData,
        // 删完会被它重建,留下一堆 /tmp/bow-quark-e2e-* 残体
        await Promise.race([exited, sleep(5000)])
      }
    } catch {
      /* 已经退出 */
    }
    quarkServer.close()
    aria2Server.close()
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    } catch (e) {
      console.warn(`⚠ 临时目录没删干净(不影响结论):${work} — ${e instanceof Error ? e.message : e}`)
    }
  }

  try {
    assert(await waitForEndpoint(httpUrl), 'bow 的 MCP HTTP 端点已就绪')

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const client = new Client({ name: 'quark-e2e', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(httpUrl)))

    const call = async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args })
      const text = res.content?.[0]?.text ?? ''
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        /* 非 JSON 返回 */
      }
      return { res, text, json }
    }

    // 0) 夸克插件**不再**贡献 MCP 工具(精简后只有界面 + IPC)
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    check(!names.some((n) => n.startsWith('quark_')), '夸克插件不贡献 MCP 工具(已移除)', names.filter((n) => n.startsWith('quark_')).join(','))

    // 1) 打开假夸克页
    const nav = await call('browser_navigate', { url: 'https://pan.quark.cn/', waitUntil: 'load' })
    check(!nav.res.isError, '导航到假夸克页', nav.text.slice(0, 200))
    await sleep(500)

    // 2) 找到 bow 的 chrome 页面 target(带应用 preload,能直接调插件 IPC)
    const targets = async () => {
      try {
        return await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
      } catch {
        return []
      }
    }
    const chromeTarget = await waitFor(async () => {
      for (const candidate of await targets()) {
        if (!candidate.webSocketDebuggerUrl || String(candidate.url).startsWith('devtools://')) continue
        try {
          const kind = await evalOn(candidate.webSocketDebuggerUrl, 'typeof window.browserAPI?.plugins?.invoke', 4000)
          if (kind === 'function') return candidate
        } catch {
          /* 不是 chrome 页面 */
        }
      }
      return null
    }, 20000)
    assert(!!chromeTarget, '找到 bow 的 chrome 页面 target(可调 plugins.invoke)', chromeTarget?.url)

    const invoke = async (method, ...args) =>
      evalOn(
        chromeTarget.webSocketDebuggerUrl,
        `window.browserAPI.plugins.invoke('quark', ${JSON.stringify(method)}, ...${JSON.stringify(args)})`
      )

    // 3) 读文件列表(走 EXTRACT_JS 的 fiber 遍历)
    const list = await invoke('listFiles')
    check(list?.ok === true, 'quark listFiles 成功', JSON.stringify(list)?.slice(0, 300))
    const files = list?.files ?? []
    check(
      files.length === 3 && files.filter((f) => f.isFile).length === 2,
      '读到 3 个条目(其中文件夹被标出)',
      JSON.stringify(files)
    )
    check(files.find((f) => f.fid === FID_A)?.name === NAME_A, 'fid 与文件名正确')

    // 4) 推送两个文件到 aria2:一个直链在白名单内、一个在名单外
    const pushed = await invoke('pushAria2', { fids: [FID_A, FID_B] })
    check(pushed?.ok === true && (pushed?.results ?? []).filter((r) => r.ok).length === 2, 'pushAria2 两条都成功', JSON.stringify(pushed)?.slice(0, 400))
    check(pushed?.hosts?.length === 2, '返回直链域名摘要(面板诊断区用)', JSON.stringify(pushed?.hosts))

    // 5) 假夸克接口真正收到了什么 —— 伪装 UA 与 cookie 域罐里的登录态
    const apiReq = seen.find((s) => s.tag === 'api')
    assert(!!apiReq, '假接口收到了取直链请求')
    check((apiReq.headers['user-agent'] || '').includes(UA_PREFIX), '取直链接口收到了伪装 PC 客户端 UA', apiReq.headers['user-agent'])
    check((apiReq.headers.cookie || '').includes('e2e=1'), '取直链接口带了 cookie 域罐里的登录态', apiReq.headers.cookie)
    check(!('origin' in apiReq.headers), '取直链接口**没有** Origin(带它 net.fetch 必 ERR_FAILED)')
    const apiBody = seen.find((s) => s.tag === 'api-body')
    check(apiBody?.body?.includes(FID_A) && apiBody?.body?.includes(FID_B), '取直链 body 里是勾选的 fid', apiBody?.body)

    // 6) 假 aria2 真正收到了什么 —— 参数形状 + header 白名单边界
    const addUri = aria2Calls.filter((c) => c.body?.method === 'aria2.addUri')
    assert(addUri.length === 2, `aria2 收到两次 addUri(实际 ${addUri.length})`)
    const byUrl = new Map(addUri.map((c) => [c.body.params?.[1]?.[0], c.body.params?.[2]]))
    check(byUrl.size === 2, '两次推送的是两个不同直链', [...byUrl.keys()].join(','))
    check(addUri.every((c) => c.body.params?.[0] === 'token:'), 'params[0] 是 token 前缀')

    const optsA = byUrl.get(URL_A)
    const optsB = byUrl.get(URL_B)
    assert(!!optsA && !!optsB, '两个直链都进了 aria2')
    check(optsA.out === NAME_A && optsB.out === NAME_B, 'out 是文件名(不依赖 CDN 的 Content-Disposition)', JSON.stringify([optsA.out, optsB.out]))
    check(
      optsA.header?.some((h) => h.startsWith('User-Agent:') && h.includes(UA_PREFIX)),
      'header 里带伪装 UA',
      JSON.stringify(optsA.header)
    )
    check(optsA.header?.includes('Referer:https://pan.quark.cn/'), 'header 里带 Referer', JSON.stringify(optsA.header))
    check(
      optsA.header?.some((h) => h.startsWith('Cookie:') && h.includes('e2e=1')),
      '白名单内的直链(quark.cn)带上了 Cookie',
      JSON.stringify(optsA.header)
    )
    check(
      !optsB.header?.some((h) => h.startsWith('Cookie:')),
      '白名单外的直链(aliyuncs.com)**没有** Cookie(会话不泄露给第三方 CDN)',
      JSON.stringify(optsB.header)
    )

    // 7) 「测试连接」能读到 aria2 版本
    const version = await invoke('testAria2')
    check(version?.ok === true && version?.version === '1.37.0-e2e', 'testAria2 读到假 aria2 版本', JSON.stringify(version))

    await client.close()
  } catch (e) {
    failures += 1
    console.error(`✗ 中断:${e instanceof Error ? e.message : String(e)}`)
  } finally {
    // 日志:HTTP 模式下主进程写 `<userData>/browser.log`(不是 stdout),失败时这段最有用
    const logFile = join(userDataDir, 'browser.log')
    const fromFile = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const lines = (fromFile || logs.join(''))
      .split('\n')
      .filter((l) => /quark|取到直链|aria2/i.test(l))
      .slice(-14)
    console.log(`\n—— 主进程日志片段(${lines.length} 行)——`)
    console.log(lines.join('\n') || '(没有命中的日志)')
    await cleanup()
  }

  console.log(failures === 0 ? '\n✅ 夸克插件离线 E2E 全部通过' : `\n❌ 夸克插件离线 E2E 失败 ${failures} 项`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
