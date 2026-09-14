/**
 * MCP HTTP 服务插件:让常驻的 bow 暴露 HTTP MCP 端点,AI 工具(pi / Claude Code / 脚本)直接连过来。
 *
 * 默认开启 —— 插件启用状态存在 plugins.json 的 disabled 列表里,不在列表里即启用。
 * 真正的监听由内核的 McpHttpHost 持有(插件 activate 早于窗口创建,拿不到 TabManager),
 * 本插件只负责四件事:端口/令牌的持久化、依赖就绪后的启动决策、把运行状态经 IPC 交给设置页,
 * 以及为地址栏状态灯提供「当前是否正在被调用」(订阅内核的 MCP 活动计数)。
 *
 * 与 `MCP_HTTP=1` 环境变量的关系:环境变量是强制模式,先起者赢(宿主内部幂等);
 * 且环境变量启动的实例不受本插件开关支配 —— 关掉插件不会把运维强制开的端点关掉。
 */

import type { McpHttpState, McpHttpSettings } from './shared'
import type { PluginContext, PluginMain } from '../../main/plugins/types'

const DEFAULT_PORT = 8765

/** 端口归一:非法/越界值回落到默认端口,避免把 NaN 写进存储后再也起不来 */
function normalizePort(input: unknown): number {
  const n = typeof input === 'number' ? input : Number.parseInt(String(input ?? ''), 10)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT
}

const plugin: PluginMain = {
  manifest: {
    id: 'mcp-http',
    name: 'MCP HTTP 服务',
    description: '常驻提供 HTTP MCP 端点,AI 工具可直接连上这个浏览器',
    version: '1.0.0',
    core: true
  },
  capabilities: ['ui', 'service'],

  activate(ctx: PluginContext): void {
    const store = ctx.storage<McpHttpSettings>({
      file: 'mcp-http.json',
      defaults: { port: DEFAULT_PORT, token: '' }
    })

    const state = (): McpHttpState => ({
      settings: store.get(),
      status: ctx.service.mcpHttp.status(),
      defaultPort: DEFAULT_PORT,
      activity: ctx.service.activity.snapshot()
    })
    const announce = (): McpHttpState => {
      const s = state()
      ctx.ipc.emit('changed', s)
      return s
    }
    /** 启动失败(端口被占用等)只落到状态与日志里,不让异常影响插件激活与设置页 */
    const start = async (): Promise<McpHttpState> => {
      const { port, token } = store.get()
      const status = await ctx.service.mcpHttp.start({ port, token: token || undefined })
      if (status.error) ctx.logError('MCP HTTP 未能启动', status.error)
      else ctx.log('MCP HTTP 监听中', status.url)
      return announce()
    }

    // 插件被启用 + 内核依赖就绪 = 应当运行。这是「默认开启」的落地点。
    ctx.service.onMcpHttpReady(() => {
      void start()
    })
    // 重新启用时(如设置页先停用再开)内核依赖早已就绪,ready 事件不会再来一次,
    // 所以这里补一次即时启动;两条路径都幂等,不会重复监听。
    if (ctx.service.mcpHttp.status().ready) void start()

    // MCP 调用活动变化 → 重播完整状态,地址栏状态灯据此在「就绪/调用中」间切换
    ctx.service.activity.onChange(() => {
      announce()
    })

    ctx.ipc.handle('getState', (): McpHttpState => state())

    ctx.ipc.handle('setSettings', async (patch: Partial<McpHttpSettings>): Promise<McpHttpState> => {
      const before = store.get()
      const next = store.set({
        ...(patch.port !== undefined ? { port: normalizePort(patch.port) } : {}),
        ...(patch.token !== undefined ? { token: String(patch.token) } : {})
      })
      // 只有监听参数真的变了才重启,避免每次保存都打断已连接的客户端
      if (next.port !== before.port || next.token !== before.token) {
        const status = await ctx.service.mcpHttp.restart({
          port: next.port,
          token: next.token || undefined
        })
        if (status.error) ctx.logError('MCP HTTP 重启失败', status.error)
      }
      return announce()
    })

    ctx.ipc.handle('restart', async (): Promise<McpHttpState> => {
      const { port, token } = store.get()
      const status = await ctx.service.mcpHttp.restart({ port, token: token || undefined })
      if (status.error) ctx.logError('MCP HTTP 重启失败', status.error)
      return announce()
    })

    /**
     * 地址栏状态灯点击:在「停用 / 启用」端点之间切换。
     * 只动 HTTP 端点,插件的启用状态不变(设置页分区与已声明的 MCP 工具都保留)。
     * 环境变量强制开启的实例停不掉 —— stop() 会原样返回 running 状态,这里如实回播。
     */
    ctx.ipc.handle('toggle', async (): Promise<McpHttpState> => {
      const before = ctx.service.mcpHttp.status()
      if (before.running) {
        const next = await ctx.service.mcpHttp.stop()
        if (next.running) ctx.log('MCP HTTP 由环境变量强制开启,插件停不掉')
        else ctx.log('MCP HTTP 端点已由状态灯停用')
        return announce()
      }
      if (!before.ready) return announce() // 依赖未就绪,无从启动
      const { port, token } = store.get()
      const next = await ctx.service.mcpHttp.start({ port, token: token || undefined })
      if (next.error) ctx.logError('MCP HTTP 启动失败', next.error)
      else ctx.log('MCP HTTP 端点已由状态灯启用', next.url)
      return announce()
    })
  },

  async deactivate(ctx: PluginContext): Promise<void> {
    await ctx.service.mcpHttp.stop()
  }
}

export default plugin
