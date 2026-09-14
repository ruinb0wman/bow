/**
 * MCP 工具宿主(纯逻辑,可单测):缓冲插件的工具声明,待 MCP 服务器就绪后统一注册,
 * 并持有 RegisteredTool 句柄以支持插件停用时动态移除。
 *
 * 核心 browser_* 工具由 mcp.ts 直接注册,名字通过 reserve() 预留给内核做重名校验。
 */

import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpToolConfig, McpToolHandler } from './types'

export interface McpToolSpec {
  pluginId: string
  name: string
  config: McpToolConfig
  handler: McpToolHandler
}

export type McpRegisterFn = (spec: McpToolSpec) => RegisteredTool

export class McpHost {
  private specs = new Map<string, McpToolSpec>()
  private reserved = new Set<string>()
  private handles = new Map<string, RegisteredTool>()
  private registerFn: McpRegisterFn | null = null

  /** 预留核心工具名:插件声明的工具与核心重名时激活即抛错 */
  reserve(names: string[]): void {
    for (const n of names) this.reserved.add(n)
  }

  registerTool(spec: McpToolSpec): void {
    if (this.reserved.has(spec.name)) throw new Error(`MCP 工具名与核心冲突:${spec.name}`)
    if (this.specs.has(spec.name)) throw new Error(`MCP 工具名重复:${spec.name}`)
    this.specs.set(spec.name, spec)
    if (this.registerFn) this.handles.set(spec.name, this.registerFn(spec))
  }

  /** MCP 服务器就绪:补注册全部已缓冲的工具,并接管后续 registerTool */
  attach(registerFn: McpRegisterFn): void {
    this.registerFn = registerFn
    for (const spec of this.specs.values()) {
      if (!this.handles.has(spec.name)) this.handles.set(spec.name, registerFn(spec))
    }
  }

  names(): string[] {
    return [...this.specs.keys()]
  }

  /**
   * 已声明的全部工具(含尚未 attach 的)。
   * 无状态 HTTP 模式每个请求都会新建服务器实例,需要据此重新注册。
   */
  listSpecs(): McpToolSpec[] {
    return [...this.specs.values()]
  }

  /** 插件停用:移除其全部已注册工具 */
  removeByPlugin(pluginId: string): void {
    for (const [name, spec] of [...this.specs]) {
      if (spec.pluginId !== pluginId) continue
      const handle = this.handles.get(name)
      try {
        handle?.remove()
      } catch {
        // 已移除/服务器未连接:忽略
      }
      this.handles.delete(name)
      this.specs.delete(name)
    }
  }
}
