/** MCP 模式下 stdout 被协议占用,主进程日志只允许写文件与 stderr */

import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const IS_MCP = process.env.MCP === 'stdio'

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