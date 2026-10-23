/**
 * 远程订阅的扇出(进程内,纯逻辑,可单测)。
 *
 * 为什么需要它:pty 输出现在只走 `ctx.ipc.emit`(渲染层 IPC),浏览器那头收不到;
 * 而远程页 / 将来的 TUI 都要同一份流。所以 `flush()` 多喂一口给 hub。
 *
 * **慢消费者的策略是断开,不是丢字节**:终端输出是一段连续字节流,丢掉中间某个 chunk
 * 会让画面**永久错位**(光标位置、转义序列都跟不上了),比断线难受得多。断开之后它重连
 * 时 `attach` 会先发回放(`replayText`),画面能重建 —— 所以「跟不上就踢掉」是这里唯一自洽的选择。
 */

import type { SessionInfo } from '../shared'

/** 从会话核心推给远程客户端的事件(S6/S7 只加不改:客户端按 `t` 分派) */
export type HubEvent =
  | { t: 'data'; id: number; chunk: string }
  | { t: 'sessions'; sessions: SessionInfo[] }
  | { t: 'exit'; id: number; code: number }
  | { t: 'closed'; id: number; reason: string }

export interface HubSink {
  /** 已排队但还没发出去的字节(WS 的 `bufferedAmount`);用来判断这个客户端跟不上了 */
  buffered(): number
  send(event: HubEvent): void
  /** 被判定为慢消费者时调用,实现负责真的断开它 */
  drop(reason: string): void
}

/** 单个客户端最多允许积压这么多字节(约等于几十秒的满速输出) */
export const HUB_MAX_BUFFERED_BYTES = 4 * 1024 * 1024

export class SessionHub {
  private readonly sinks = new Set<HubSink>()

  constructor(private readonly maxBuffered = HUB_MAX_BUFFERED_BYTES) {}

  get size(): number {
    return this.sinks.size
  }

  /** 订阅;返回取消订阅函数(重复调用无害) */
  subscribe(sink: HubSink): () => void {
    this.sinks.add(sink)
    return () => {
      this.sinks.delete(sink)
    }
  }

  /**
   * 广播一条事件。遍历的是快照,所以 send/drop 里再订阅/退订都不会打乱这次遍历。
   * 单个 sink 出错只踢掉它自己 —— 一个坏客户端不能连累其它人。
   */
  publish(event: HubEvent): void {
    for (const sink of [...this.sinks]) {
      try {
        if (sink.buffered() > this.maxBuffered) {
          this.sinks.delete(sink)
          sink.drop(`积压超过 ${this.maxBuffered} 字节`)
          continue
        }
        sink.send(event)
      } catch {
        this.sinks.delete(sink)
        try {
          sink.drop('发送失败')
        } catch {
          /* 已经断了 */
        }
      }
    }
  }

  /** 插件停用 / 服务停机:断开所有订阅者 */
  clear(reason = '服务已停止'): void {
    for (const sink of [...this.sinks]) {
      this.sinks.delete(sink)
      try {
        sink.drop(reason)
      } catch {
        /* 已经断了 */
      }
    }
  }
}
