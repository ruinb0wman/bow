#!/usr/bin/env node
/**
 * `terminal_*` MCP 工具的端到端冒烟:一个**真的 MCP 客户端**(stdio)去调那五个工具。
 *
 * 为什么单独一个脚本而不是塞进 mcp-smoke:这里的断言会**真的起 shell 进程**,而且需要
 * 独立的 userData(不能碰你正在跑的 bow,也不能往真实 profile 写东西)。mcp-smoke 面向
 * 「页面类工具」,两者失败时的排查方向完全不同。
 *
 * 覆盖的链路:stdio MCP → 内核 McpHost → 插件工具处理器 → 台账/pty → 遥回来。
 * 这条链上唯一没被单元测试碰到的是「SDK 真的把 zod 原始形状注册上了」与「工具名对得上」。
 *
 * 用法(需先 `npm run build`):
 * ```bash
 * npm run test:mcp:terminal
 * ```
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 可指向**另一个平台**的 electron/bow 可执行文件(`ELECTRON_BIN`),例如从 WSL 跑 Windows 的那份。
 * 这种用法要自己给三样东西(跨平台没有合理的默认值):
 * - `SMOKE_USER_DATA`:目标平台看得懂的路径(Windows 下 `/tmp/...` 不行)
 * - `SMOKE_SHELL`:要 spawn 的交互式 shell(默认 posix 用 bash,Windows 用 cmd.exe)
 * - 不加 `--ozone-platform=headless`(那是 Linux 的开关)
 */
const bin =
  process.env.ELECTRON_BIN ||
  (process.platform === 'win32'
    ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(root, 'node_modules', '.bin', 'electron'))
const isWin = process.platform === 'win32' || /[\\/](electron|bow)\.exe$/i.test(bin)
const userData = process.env.SMOKE_USER_DATA || join(tmpdir(), `bow-mcp-terminal-${process.pid}`)
const shell = process.env.SMOKE_SHELL || (isWin ? 'cmd.exe' : 'bash')
/** 指向另一个平台的可执行文件时,cwd 也要给目标平台能用的(否则 app 根目录会找不到) */
const appCwd = process.env.SMOKE_CWD || root
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0

function check(cond, label, detail) {
  if (cond) console.log(`✓ ${label}`)
  else {
    failures += 1
    console.error(`✗ ${label}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
  }
}

async function waitFor(predicate, timeoutMs = 20000, stepMs = 250) {
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

rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const client = new Client({ name: 'bow-terminal-smoke', version: '0.1.0' })
const transport = new StdioClientTransport({
  command: bin,
  args: [
    '.',
    '--no-sandbox',
    ...(isWin ? [] : ['--ozone-platform=headless']),
    `--user-data-dir=${userData}`,
    ...(process.env.SMOKE_ELECTRON_ARGS?.split(' ').filter(Boolean) ?? [])
  ],
  cwd: appCwd,
  env: { ...process.env, MCP: 'stdio' },
  // 跨平台调试时 bow 自己的日志全在 stderr:不打出来就只能看到一个超时
  stderr: process.env.SMOKE_CHILD_STDERR === '1' ? 'inherit' : 'pipe'
})

/** 工具返回体:content[0].text 里是 JSON */
const body = (res) => {
  try {
    return JSON.parse(res.content?.[0]?.text ?? '{}')
  } catch {
    return {}
  }
}

try {
  await client.connect(transport)

  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  const expected = ['terminal_list_sessions', 'terminal_read', 'terminal_send', 'terminal_run', 'terminal_close']
  check(
    expected.every((n) => names.includes(n)),
    `五个 terminal_* 工具都注册上了(共 ${names.length} 个工具)`,
    names.filter((n) => n.startsWith('terminal_'))
  )

  // ---------- ① 空台账 ----------
  const empty = body(await client.callTool({ name: 'terminal_list_sessions', arguments: {} }))
  check(empty.ok === true && Array.isArray(empty.sessions) && empty.sessions.length === 0, '初始台账为空', empty)

  // ---------- ② 开一个会话(pty 异步起) ----------
  const ran = body(await client.callTool({ name: 'terminal_run', arguments: { command: shell, name: 'smoke' } }))
  check(ran.ok === true && Number.isInteger(ran.id), 'terminal_run 立刻返回 id', ran)
  const id = ran.id

  const listed = await waitFor(async () => {
    const res = body(await client.callTool({ name: 'terminal_list_sessions', arguments: {} }))
    return res.sessions?.find((s) => s.id === id) ?? null
  })
  check(listed !== null, 'pty 起来后台账里出现该会话', listed)
  check(listed?.title === 'smoke', '标题取 name', listed?.title)

  // ---------- ③ 键盘注入 + 读尾部 ----------
  await client.callTool({ name: 'terminal_send', arguments: { id, text: 'echo BOW_SMOKE_OK\r' } })
  const echoed = await waitFor(async () => {
    const res = body(await client.callTool({ name: 'terminal_read', arguments: { id, chars: 4000 } }))
    return typeof res.text === 'string' && res.text.includes('BOW_SMOKE_OK') ? res.text : null
  })
  check(echoed !== null, 'terminal_send 的输入真的进了 shell,terminal_read 读回回显')

  const tail = body(await client.callTool({ name: 'terminal_read', arguments: { id, chars: 8 } }))
  check(typeof tail.text === 'string' && tail.text.length <= 8, 'terminal_read 的 chars 截尾生效', tail)

  // ---------- ④ 错误路径:isError ----------
  const missing = await client.callTool({ name: 'terminal_read', arguments: { id: 999999 } })
  check(missing.isError === true, '未知会话的 terminal_read 标记 isError')
  const badSend = await client.callTool({ name: 'terminal_send', arguments: { id: 999999, text: 'x' } })
  check(badSend.isError === true, '未知会话的 terminal_send 标记 isError')

  // ---------- ⑤ 关会话 ----------
  const closed = body(await client.callTool({ name: 'terminal_close', arguments: { id } }))
  check(closed.ok === true, 'terminal_close 成功', closed)
  const gone = await waitFor(async () => {
    const res = body(await client.callTool({ name: 'terminal_list_sessions', arguments: {} }))
    return res.sessions?.length === 0
  })
  check(gone === true, '会话从台账消失')
} catch (e) {
  failures += 1
  console.error(`✗ 冒烟中断:${e instanceof Error ? e.message : String(e)}`)
} finally {
  try {
    await client.close()
  } catch {
    /* 已经断了 */
  }
  await sleep(800)
  // Windows 上子进程可能还没放开 userData 目录里的锁文件:重试几次,失败也不影响结论
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    /* 清不掉就留着,不是断言 */
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 处失败`)
process.exit(failures === 0 ? 0 : 1)
