#!/usr/bin/env node
/**
 * 跨平台启动 bow(Electron)。
 *
 * 为什么需要它:package.json 里原先写的是 `MCP_HTTP=1 electron .` 这种 POSIX 内联赋值,
 * Windows 的 cmd / PowerShell 不认,会把 MCP_HTTP 当成命令名直接报错
 * ('MCP_HTTP' is not recognized as an internal or external command)。
 * 把环境变量组装搬到 node 里再 spawn,就能在 PowerShell / cmd / Git Bash 下一致工作。
 *
 * 用法:
 *   node scripts/open-bow.mjs stdio      # 等价于 MCP=stdio electron .
 *   node scripts/open-bow.mjs http       # 等价于 MCP_HTTP=1 electron .(常驻 HTTP MCP 服务)
 *   node scripts/open-bow.mjs            # 普通启动(不开启 MCP)
 *   node scripts/open-bow.mjs http --dry-run   # 只打印将要设置的环境变量与命令
 *
 * 环境变量:
 *   MCP_HTTP_PORT      HTTP 模式端口,默认 8765
 *   MCP_HTTP_TOKEN     HTTP 模式 Bearer 令牌,不设则端点无令牌
 *   BOW_ELECTRON       覆盖 electron 可执行文件路径
 *   BOW_ELECTRON_ARGS  追加给 electron 的参数(空格分隔)
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const mode = (argv.find((a) => !a.startsWith('--')) ?? '').toLowerCase()

if (mode && mode !== 'stdio' && mode !== 'http') {
  console.error(`✗ 未知模式 "${mode}";可用:stdio / http /(留空表示普通启动)`)
  process.exit(1)
}

/** 解析 electron 可执行文件:优先 BOW_ELECTRON,其次 electron 包导出的真实路径,最后 .bin 垫片 */
async function resolveElectron() {
  if (process.env.BOW_ELECTRON) return process.env.BOW_ELECTRON
  try {
    // electron 包的入口导出的是二进制绝对路径(由 postinstall 写入 path.txt)
    const mod = await import('electron')
    if (typeof mod.default === 'string' && existsSync(mod.default)) return mod.default
  } catch {
    /* 落回 .bin 垫片 */
  }
  const shim = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
  if (existsSync(shim)) return shim
  console.error('✗ 找不到 electron。先运行 npm install(会触发 scripts/ensure-electron.mjs),或用 BOW_ELECTRON 指定路径。')
  process.exit(1)
}

const env = { ...process.env }
/** 本次注入的关键变量,用于日志与 dry-run */
const injected = {}

if (mode === 'stdio') {
  env.MCP = 'stdio'
  injected.MCP = 'stdio'
} else if (mode === 'http') {
  env.MCP_HTTP = '1'
  env.MCP_HTTP_PORT = env.MCP_HTTP_PORT || '8765'
  injected.MCP_HTTP = '1'
  injected.MCP_HTTP_PORT = env.MCP_HTTP_PORT
  if (env.MCP_HTTP_TOKEN) injected.MCP_HTTP_TOKEN = '(已设置,值不回显)'
}

const args = ['.', ...(process.env.BOW_ELECTRON_ARGS?.split(' ').filter(Boolean) ?? [])]
const bin = await resolveElectron()

if (dryRun) {
  console.log('模式:    ' + (mode || '(普通启动)'))
  console.log('可执行:  ' + bin)
  console.log('参数:    ' + JSON.stringify(args))
  console.log('cwd:     ' + root)
  console.log('注入环境:' + JSON.stringify(injected, null, 2))
  if (mode === 'http') {
    console.log('端点:    http://127.0.0.1:' + env.MCP_HTTP_PORT + '/mcp' + (env.MCP_HTTP_TOKEN ? '(需要 Bearer 令牌)' : '(无令牌)'))
  }
  process.exit(0)
}

if (mode === 'http') {
  console.log(`bow 以 HTTP MCP 模式启动 → http://127.0.0.1:${env.MCP_HTTP_PORT}/mcp${env.MCP_HTTP_TOKEN ? '(需要 Bearer 令牌)' : '(无令牌,仅回环)'}`)
}

// Windows 上 electron.cmd 需要 shell 才能执行;走 electron 包的真实 .exe 时不需要
const needShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
const child = spawn(bin, args, { cwd: root, env, stdio: 'inherit', shell: needShell })
child.on('error', (e) => {
  console.error('✗ 启动 electron 失败:' + e.message)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))
