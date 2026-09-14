/** MCP 模式下 stdout 被协议占用,主进程日志只允许写文件与 stderr */

import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const IS_MCP_STDIO = process.env.MCP === 'stdio'

/** HTTP 模式:MCP_HTTP=1 时在 127.0.0.1 上提供无状态 MCP 服务(供多客户端共享常驻浏览器) */
export const IS_MCP_HTTP = !!process.env.MCP_HTTP && process.env.MCP_HTTP !== '0'
export const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT) || 8765
/** 可选 Bearer 令牌:设置后 HTTP 请求必须带 Authorization: Bearer <token> */
export const MCP_HTTP_TOKEN = process.env.MCP_HTTP_TOKEN || undefined

/** 任一 MCP 模式:日志一律写文件,不占用终端 */
export const IS_MCP = IS_MCP_STDIO || IS_MCP_HTTP

let logFile: string | null = null

function ensureLogFile(): string {
  if (!logFile) {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'browser.log')
  }
  return logFile
}

export function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`
  if (IS_MCP) {
    try {
      appendFileSync(ensureLogFile(), line + '\n')
    } catch {
      // 日志失败不致命
    }
  } else {
    console.log(line)
  }
}

export function logError(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`
  if (IS_MCP) {
    try {
      appendFileSync(ensureLogFile(), '[ERR] ' + line + '\n')
    } catch {
      /* ignore */
    }
  } else {
    console.error(line)
  }
}