/**
 * 测试用假 PluginKernel:复刻 McpHost 对 mcp.ts 暴露的两条路径。
 *
 * - stdio 模式走 `attach()`:服务器就绪时回交注册函数,内核保留句柄以支持插件热停用;
 * - HTTP 无状态模式走 `listSpecs()`:每个请求新建服务器实例,直接从声明快照注册。
 */

export interface FakePluginSpec {
  pluginId: string
  name: string
  config: Record<string, unknown>
  handler: (...args: never[]) => unknown
}

export type FakePluginRegisterFn = (spec: FakePluginSpec) => unknown

export class FakeKernel {
  readonly specs: FakePluginSpec[] = []
  readonly attachFns: FakePluginRegisterFn[] = []

  readonly mcp = {
    attach: (fn: FakePluginRegisterFn): void => {
      this.attachFns.push(fn)
    },
    listSpecs: (): FakePluginSpec[] => [...this.specs]
  }

  /** 模拟 McpHost.registerTool:缓冲声明;若服务器已 attach,同时立即注册到该实例 */
  declare(spec: FakePluginSpec): void {
    this.specs.push(spec)
    for (const fn of this.attachFns) fn(spec)
  }
}
