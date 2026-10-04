/**
 * 代理状态(终端里的 pi)的**系统通知**落地端:把 `AgentNotice` 变成一条 OS 级通知。
 *
 * 这是 `main/agentNotify.ts` 唯一的「出网口」—— 那一侧只做归约与定时(**不 import electron**,
 * 所以能纯单测),Electron 的 `Notification` 全部关在这里,与番茄钟插件的写法一致
 * (见 `plugins/pomo/main.ts` 的 `notifyPhaseEnd`:同样 `silent: true` + click 回调)。
 *
 * 两个刻意的设计:
 * 1. **绝不上抛**:通知失败(平台不支持 / 构造抛错)只记日志,因为调用方在插件上报链路上。
 * 2. **`BOW_NOTIFY_LOG` 测试缝**:设了这个环境变量时,每次 show/close 追加一行 JSONL,并挂上
 *    `globalThis.__bowNotifyClick`。为什么需要它:E2E 跑在 headless(没有 notification daemon,
 *    `isSupported()` 可能为假),而且**操作系统级的点击无法从 CDP 合成** —— 只能靠这个全局驱动
 *    同一条 click 回调(与终端页给 E2E 用的 `window.__bowTerminal` 同类,且只在环境变量设置时存在)。
 */

import { Notification } from 'electron'
import { appendFileSync } from 'node:fs'
import { log, logError } from './logger'

/** 一条要发出去的系统通知 */
export interface AgentNotice {
  kind: 'blocked' | 'done'
  /** 通知标题(如「pi 需要确认」) */
  title: string
  /** 通知正文(对话框标题 · 会话标签 / 会话标签);可能没有 */
  body?: string
  /** 点击时要进入的标签(权威身份,与信号来源同一个 tabId) */
  tabId: number
}

/** 已发出通知的句柄:只用来撤回(best-effort,部分 Linux daemon 会忽略) */
export interface NoticeHandle {
  close(): void
}

export interface SystemNotifyPort {
  show(notice: AgentNotice): NoticeHandle
}

export interface SystemNotifyDeps {
  /** 点通知:进入对应标签(实现是 `main/agentActivate.ts` 的 `activateAgentTab`) */
  activate: (tabId: number) => void
  /** 测试缝:`BOW_NOTIFY_LOG` 指向的文件路径(不设 = 正常生产路径,什么都不多做) */
  logPath?: string
}

function isSupported(): boolean {
  try {
    return Notification.isSupported()
  } catch {
    return false
  }
}

export function createSystemNotifier(deps: SystemNotifyDeps): SystemNotifyPort {
  const logPath = deps.logPath?.trim() || null
  if (logPath) {
    // E2E 只能从主进程侧驱动「点通知」:OS 级点击合成不了。见文件头注释。
    ;(globalThis as unknown as Record<string, unknown>).__bowNotifyClick = (tabId: unknown) =>
      deps.activate(Number(tabId))
  }

  /** 测试缝:JSONL 追加(失败即吞 —— 诊断信息不该影响通知本身) */
  function trace(record: Record<string, unknown>): void {
    if (!logPath) return
    try {
      appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...record }) + '\n')
    } catch {
      /* 测试缝写不进去不影响功能 */
    }
  }

  return {
    show(notice: AgentNotice): NoticeHandle {
      const supported = isSupported()
      trace({ event: 'show', supported, ...notice })
      /** 真正建出来的那条通知;平台不支持或构造失败时为 null(handle 仍然是可 close 的) */
      let notification: Notification | null = null
      if (!supported) {
        log('系统通知不可用(平台不支持),丢弃', notice.kind, notice.title)
      } else {
        try {
          notification = new Notification({ title: notice.title, body: notice.body, silent: true })
          notification.on('click', () => deps.activate(notice.tabId))
          notification.show()
        } catch (e) {
          logError('系统通知发送失败', notice.kind, notice.title, e)
        }
      }
      return {
        close: () => {
          // 不管有没有真的发出去都记一笔:测试缝据此断言「agent 继续/关标签时撤回了」
          trace({ event: 'close', ...notice })
          if (!notification) return
          try {
            notification.close()
          } catch (e) {
            logError('撤回系统通知失败', e)
          }
        }
      }
    }
  }
}
