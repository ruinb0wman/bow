/** 主进程侧插件契约(仅类型,无运行时代码) */

import type {
  ContentScriptSpec,
  NetHook,
  PluginCapability,
  PluginManifest,
  PluginTabApi,
  SuggestProvider
} from '@shared/plugins'
import type { HotkeySpec } from '@shared/shortcuts'
import type { McpHttpStatus } from './mcpHttpHost'
import type { McpActivitySnapshot } from '../mcpActivity'

export interface PluginStorage<T> {
  get(): T
  set(patch: Partial<T>): T
  setRaw(value: T): T
}

export interface McpToolConfig {
  title?: string
  description?: string
  /** zod raw shape(由 @modelcontextprotocol/sdk 消费) */
  inputSchema?: Record<string, unknown>
}

export type McpToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface McpToolResult {
  content: McpToolContent[]
  isError?: boolean
  /** 与 MCP SDK 的 CallToolResult 兼容(其带 string 索引签名) */
  [key: string]: unknown
}

export type McpToolHandler = (args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>

/**
 * 插件可用的页面执行 API:在指定标签页主世界执行 JS,供需要交互式脚本的插件使用
 * (如广告插件的元素框选)。由内核注入,插件无需接触 electron。
 */
export interface PluginPageApi {
  activeTabId(): number | null
  focus(tabId: number): void
  execute(tabId: number, code: string, opts?: { timeoutMs?: number }): Promise<unknown>
}

/**
 * MCP HTTP 服务面:内核持有真正的监听与 Electron 权限,插件只做启停决策。
 * 单独拎出来是因为插件 activate 早于窗口/标签创建 —— 那时服务还拿不到运行时依赖,
 * 只能等 onMcpHttpReady 回调(与 setTabProvider / setPageApi 同一个时序假设)。
 */
export interface PluginServiceApi {
  /** 内核运行时依赖就绪后回调;插件被启用即代表“应当运行”,在此处启动服务 */
  onMcpHttpReady(cb: () => void): void
  mcpHttp: {
    status(): McpHttpStatus
    start(opts: { port: number; token?: string }): Promise<McpHttpStatus>
    stop(): Promise<McpHttpStatus>
    restart(opts: { port: number; token?: string }): Promise<McpHttpStatus>
  }
  /** MCP 调用活动(工具调用/HTTP 请求在途情况),供 UI 显示「正在被调用」 */
  activity: {
    snapshot(): McpActivitySnapshot
    onChange(cb: (snapshot: McpActivitySnapshot) => void): () => void
  }
}

/**
 * 插件运行时上下文:内核为每个插件在激活时创建一份,停用时统一回收。
 * 通过它注册的一切(IPC / 建议源 / MCP 工具 / 网络与内容钩子 / 事件订阅)都会自动登记,
 * 插件自身无需手写清理逻辑(deactivate 里只处理自有的非内核资源)。
 */
export interface PluginContext {
  readonly id: string
  log(...args: unknown[]): void
  logError(...args: unknown[]): void
  /** 插件私有 JSON 存储(userData 下),同 filename 复用同一实例;compact=true 写单行 JSON */
  storage<T>(opts: { file: string; defaults: T; compact?: boolean }): PluginStorage<T>
  ipc: {
    /** 注册渲染层可经 plugins.invoke(id, method, ...args) 调用的方法 */
    handle(method: string, fn: (...args: any[]) => unknown | Promise<unknown>): void
    /** 向 chrome + overlay 两个页面广播插件事件 */
    emit(event: string, payload?: unknown): void
  }
  events: {
    on(name: string, cb: (payload: any) => void): void
    emit(name: string, payload?: unknown): void
  }
  suggest: { register(provider: SuggestProvider): void }
  mcp: { tool(name: string, config: McpToolConfig, handler: McpToolHandler): void }
  net: {
    onBeforeRequest(hook: NetHook): void
    onBeforeSendHeaders(hook: NetHook): void
    onHeadersReceived(hook: NetHook): void
  }
  content: {
    inject(spec: ContentScriptSpec): void
    /** 重新按当前 URL 应用内容注入(只重跑 CSS);省略 tabId 表示全部已登记标签页 */
    refresh(tabId?: number): void
  }
  /** 页面执行(主世界 JS),用于元素框选等交互式脚本 */
  pages: PluginPageApi
  /** 只读标签信息 */
  tabs: PluginTabApi
  /** 后台服务(如 MCP HTTP 端点):内核持有资源,插件只做启停决策 */
  service: PluginServiceApi
  /** 注册主进程全局热键(任意焦点下生效,含页面内);停用时自动回收 */
  shortcuts: { register(spec: HotkeySpec, handler: () => void): void }
}

export interface PluginMain {
  manifest: PluginManifest
  capabilities: PluginCapability[]
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(ctx: PluginContext): void | Promise<void>
}
