/**
 * MCP HTTP 插件跨端契约(main 与 renderer 共用;同构,无 electron / DOM 依赖)。
 *
 * 主进程侧的权威定义在 `src/main/plugins/mcpHttpHost.ts`(McpHttpStatus)与
 * `src/main/mcpActivity.ts`(McpActivitySnapshot),那两个文件带 electron 依赖、渲染层拿不到,
 * 所以这里用结构完全一致的类型作为通信契约 —— 两端靠结构化类型对齐,不需要运行时耦合。
 */

/** MCP 调用活动快照(结构对齐 src/main/mcpActivity.ts) */
export interface McpActivitySnapshot {
  /** 在途活动数(工具调用 + HTTP 请求);> 0 即「调用中」 */
  inFlight: number
  /** 累计完成的工具调用数 */
  calls: number
  /** 最近一次调用的工具名 */
  lastTool: string | null
  /** 最近一次活动结束的时间戳(ms) */
  lastAt: number | null
}

/** MCP HTTP 服务运行状态(结构对齐 src/main/plugins/mcpHttpHost.ts) */
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

export interface McpHttpSettings {
  port: number
  token: string
}

/** 插件经 `changed` 事件与 `getState` IPC 下发/广播的完整状态 */
export interface McpHttpState {
  settings: McpHttpSettings
  status: McpHttpStatus
  defaultPort: number
  activity: McpActivitySnapshot
}
