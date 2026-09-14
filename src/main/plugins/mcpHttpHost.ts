/**
 * MCP HTTP 服务宿主(纯逻辑,可单测)。
 *
 * 为什么需要它:HTTP MCP 服务要拿 `{ tabs, kernel }` 才能建服务器,而插件 activate 发生在
 * 窗口/标签创建之前(index.ts 里 registerAll → activateEnabled 早于 new TabManager),
 * 插件根本拿不到 TabManager。所以内核持有这个宿主:
 *   - index.ts 在标签就绪后 attach(deps) 并唤醒等待中的插件;
 *   - 插件只做「启停决策」,不接触 Electron 权限。
 *
 * 两条启动路径共用同一个宿主,靠幂等 + 串行化避免端口冲突:
 *   1. `MCP_HTTP=1` 环境变量(强制模式,归运维/脚本用)——记 owner='env'
 *   2. 插件开关(默认开启的常规路径)——记 owner='plugin'
 * 环境变量强制开启的服务不受插件开关支配:插件停用时不会把它关掉。
 */

import type { MCPDeps } from '../mcp'
import type { McpHttpHandle, McpHttpOptions } from '../mcpHttp'
import { startMcpHttpServer } from '../mcpHttp'
import { log, logError } from '../logger'

/** 内核运行时依赖就绪事件:插件据此启动依赖标签页的服务 */
export const MCP_HTTP_READY_EVENT = 'mcp-http:ready'

export type McpHttpOwner = 'env' | 'plugin'

export interface McpHttpStatus {
  /** 内核运行时依赖(标签页/内核)是否已注入 */
  ready: boolean
  running: boolean
  port?: number
  url?: string
  /** 是否启用了 Bearer 令牌(不回显令牌本身) */
  token?: boolean
  /** 由 MCP_HTTP 环境变量强制开启:插件开关不能关掉它 */
  forced?: boolean
  /** 最近一次启动失败的原因(成功启动后清空) */
  error?: string
}

export interface McpHttpStartOptions {
  port: number
  token?: string
  source?: McpHttpOwner
}

export class McpHttpHost {
  private deps: MCPDeps | null = null
  private handle: McpHttpHandle | null = null
  private bound: McpHttpOptions | null = null
  private owner: McpHttpOwner = 'plugin'
  private error: string | null = null
  /** 串行化并发 start:插件(收到 ready 事件)与 index.ts(环境变量路径)可能同时触发 */
  private starting: Promise<McpHttpStatus> | null = null

  attach(deps: MCPDeps): void {
    this.deps = deps
  }

  status(): McpHttpStatus {
    const base: McpHttpStatus = { ready: this.deps != null, running: this.handle != null }
    if (this.handle) {
      base.port = this.handle.port
      base.url = this.handle.url
    }
    if (this.bound) base.token = !!this.bound.token
    if (this.owner === 'env') base.forced = true
    if (this.error) base.error = this.error
    return base
  }

  /** 幂等启动:已在运行(无论哪条路径先起)直接返回当前状态,不重复监听 */
  async start(opts: McpHttpStartOptions): Promise<McpHttpStatus> {
    if (this.handle) return this.status()
    if (this.starting) return this.starting
    this.starting = this.doStart(opts).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async doStart(opts: McpHttpStartOptions): Promise<McpHttpStatus> {
    if (!this.deps) {
      this.error = '内核运行时依赖尚未就绪(标签页未创建)'
      return this.status()
    }
    try {
      const handle = await startMcpHttpServer(this.deps, { port: opts.port, token: opts.token })
      this.handle = handle
      this.bound = { port: opts.port, token: opts.token }
      this.owner = opts.source ?? 'plugin'
      this.error = null
      log('MCP HTTP 服务已启动', handle.url, this.owner === 'env' ? '(环境变量强制)' : '(插件开启)')
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      this.handle = null
      this.bound = null
      logError('MCP HTTP 启动失败', this.error)
    }
    return this.status()
  }

  /** 停止服务。插件路径不动手关掉环境变量强制开启的实例 */
  async stop(opts: { source?: McpHttpOwner } = {}): Promise<McpHttpStatus> {
    if (this.owner === 'env' && (opts.source ?? 'plugin') === 'plugin') return this.status()
    const handle = this.handle
    this.handle = null
    this.bound = null
    this.error = null
    if (handle) {
      try {
        await handle.close()
        log('MCP HTTP 服务已停止')
      } catch (e) {
        logError('MCP HTTP 停止失败', e instanceof Error ? e.message : e)
      }
    }
    return this.status()
  }

  /** 重启(改端口/令牌后调用):先停再起 */
  async restart(opts: McpHttpStartOptions): Promise<McpHttpStatus> {
    await this.stop({ source: opts.source })
    return this.start(opts)
  }
}
