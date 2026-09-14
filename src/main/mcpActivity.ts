/**
 * MCP 调用活动跟踪(纯逻辑,可单测)。
 *
 * 为什么需要:chrome 地址栏要显示「MCP 正在被调用」,但调用发生在主进程的工具处理器
 * 与 HTTP 请求里,渲染层看不见。这里维护一个在途计数 —— mcp.ts 包住工具处理器、
 * mcpHttp.ts 包住每个 HTTP 请求,插件再经 `service.activity` 订阅快照并广播给渲染层。
 *
 * 只用进程级单例:内核与插件共享同一份活动状态,不需要把 tracker 穿过 MCPDeps。
 */

export interface McpActivitySnapshot {
  /** 在途活动数(工具调用 + HTTP 请求);> 0 即「调用中」 */
  inFlight: number
  /** 累计完成的工具调用数(不含 initialize / tools/list 这类握手请求) */
  calls: number
  /** 最近一次调用的工具名;只有握手请求时为 null */
  lastTool: string | null
  /** 最近一次活动结束的时间戳(ms);null 表示从未有活动 */
  lastAt: number | null
}

export type McpActivityListener = (snapshot: McpActivitySnapshot) => void

export class McpActivityTracker {
  private inFlight = 0
  private calls = 0
  private lastTool: string | null = null
  private lastAt: number | null = null
  private listeners = new Set<McpActivityListener>()

  snapshot(): McpActivitySnapshot {
    return { inFlight: this.inFlight, calls: this.calls, lastTool: this.lastTool, lastAt: this.lastAt }
  }

  /** 订阅快照变化(活动进入/离开时各触发一次);返回取消订阅函数 */
  onChange(cb: McpActivityListener): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** 通用活动进入:返回幂等的离开函数(成对调用;用 try/finally 兜底) */
  begin(): () => void {
    return this.enter()
  }

  /** 工具调用:除在途计数外,额外累计次数并记下工具名 */
  beginTool(name: string): () => void {
    this.calls += 1
    this.lastTool = name
    return this.enter()
  }

  /**
   * 包住一个工具处理器:进入即计数,无论返回/抛错/异步都保证离开,
   * 避免异常路径让计数永久卡在「调用中」。处理器同步开始执行(不引入额外微任务延迟)。
   */
  wrapTool<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const leave = this.beginTool(name)
    try {
      return Promise.resolve(fn()).finally(leave)
    } catch (e) {
      leave()
      return Promise.reject(e)
    }
  }

  private enter(): () => void {
    this.inFlight += 1
    this.emit()
    let left = false
    return () => {
      if (left) return
      left = true
      this.inFlight = Math.max(0, this.inFlight - 1)
      this.lastAt = Date.now()
      this.emit()
    }
  }

  private emit(): void {
    const snap = this.snapshot()
    for (const cb of [...this.listeners]) {
      try {
        cb(snap)
      } catch {
        // 订阅者异常不影响被跟踪的调用(与内核事件总线同姿态)
      }
    }
  }
}

/** 进程级单例:内核、mcp 服务器与插件共享同一份活动状态 */
export const mcpActivity = new McpActivityTracker()
