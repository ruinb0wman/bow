/**
 * MCP over HTTP(StreamableHTTP,无状态)。
 *
 * 与 stdio 模式的区别:浏览器不再作为 pi 的子进程被拉起,而是一个常驻服务,
 * 多个 MCP 客户端(pi / Claude Code / 脚本)可以同时连过来;代价是需要先手动启动浏览器。
 *
 * 安全姿态:
 * - 只监听回环地址(默认 127.0.0.1),绝不对外暴露 —— 这个服务能执行页面 JS、读任意页面内容;
 * - 开启 DNS rebinding 防护并限定 Host,防止网页里的脚本打到本机端口;
 * - 可选 Bearer 令牌(MCP_HTTP_TOKEN),设置后所有请求都必须带 Authorization 头。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { MCPDeps } from './mcp'
import { createStatelessServer } from './mcp'
import { log, logError } from './logger'

export const MCP_HTTP_PATH = '/mcp'

export interface McpHttpOptions {
  /** 0 表示由系统分配空闲端口(测试用) */
  port?: number
  host?: string
  /** 设置后所有请求必须带 `Authorization: Bearer <token>` */
  token?: string
}

export interface McpHttpHandle {
  port: number
  url: string
  close(): Promise<void>
}

export async function startMcpHttpServer(deps: MCPDeps, options: McpHttpOptions = {}): Promise<McpHttpHandle> {
  const host = options.host ?? '127.0.0.1'
  const token = options.token
  // allowedHosts 要在拿到真实端口后才能确定(port=0 时端口由系统分配)
  let allowedHosts: string[] = []

  const http = createServer((req, res) => {
    void handleRequest(deps, req, res, { token, allowedHosts })
  })
  http.on('clientError', (_e, socket) => socket.destroy())

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port ?? 0, host, () => {
      http.removeListener('error', reject)
      resolve()
    })
  })

  const address = http.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  const url = `http://${host}:${port}${MCP_HTTP_PATH}`
  log(`MCP HTTP 已监听 ${url}${token ? '(需要 Bearer 令牌)' : '(无令牌,仅回环地址)'}`)

  return {
    port,
    url,
    close: () => new Promise<void>((resolve) => http.close(() => resolve()))
  }
}

interface HandleContext {
  token?: string
  allowedHosts: string[]
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

async function handleRequest(
  deps: MCPDeps,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandleContext
): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  if (path !== MCP_HTTP_PATH) {
    sendJson(res, 404, { error: `未知路径 ${path},MCP 端点为 ${MCP_HTTP_PATH}` })
    return
  }
  const method = req.method ?? ''
  if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
    sendJson(res, 405, { error: '仅支持 POST / GET / DELETE' }, { allow: 'POST, GET, DELETE' })
    return
  }
  if (ctx.token && req.headers.authorization !== `Bearer ${ctx.token}`) {
    sendJson(res, 401, { error: '缺少或错误的 Authorization: Bearer <token>' })
    return
  }

  // 无状态:每个请求一个服务器实例与传输,响应结束即释放
  const server = createStatelessServer(deps)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: ctx.allowedHosts
  })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (e) {
    logError('MCP HTTP 请求处理失败', e instanceof Error ? e.message : e)
    if (!res.headersSent) sendJson(res, 500, { error: '内部错误' })
  }
}
