/** 主进程日志:文件里永远有一份,终端里按需一份 */

import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const IS_MCP_STDIO = process.env.MCP === 'stdio'

/** HTTP 模式:MCP_HTTP=1 时在 127.0.0.1 上提供无状态 MCP 服务(供多客户端共享常驻浏览器) */
export const IS_MCP_HTTP = !!process.env.MCP_HTTP && process.env.MCP_HTTP !== '0'
export const MCP_HTTP_PORT = Number(process.env.MCP_HTTP_PORT) || 8765
/** 可选 Bearer 令牌:设置后 HTTP 请求必须带 Authorization: Bearer <token> */
export const MCP_HTTP_TOKEN = process.env.MCP_HTTP_TOKEN || undefined

/** 任一 MCP 模式:stdout 被协议/端点占用,只写文件不占终端 */
export const IS_MCP = IS_MCP_STDIO || IS_MCP_HTTP

/** 单个日志文件上限;超了就把旧的挪成 browser.log.1(只留一份历史) */
const MAX_LOG_BYTES = 4 * 1024 * 1024

let logFile: string | null = null
let rotated = false

function ensureLogFile(): string {
  if (!logFile) {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'browser.log')
  }
  if (!rotated) {
    rotated = true
    try {
      if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`)
    } catch {
      // 文件不存在 / 挪不动都不影响写入
    }
  }
  return logFile
}

/**
 * 写一行到日志文件。**任何模式下都写** —— 双击启动的 bow 没有终端,崩溃后唯一能查的就是这个文件
 * (实测:Windows 上装某个扩展后整个窗口消失,stdout 里那些行谁也看不到)。
 */
function toFile(line: string): void {
  try {
    appendFileSync(ensureLogFile(), line + '\n')
  } catch {
    // 日志失败不致命
  }
}

export function log(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`
  toFile(line)
  if (!IS_MCP) console.log(line)
}

export function logError(...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`
  toFile('[ERR] ' + line)
  if (!IS_MCP) console.error(line)
}
