/**
 * 「编码代理状态」的落地端(进程级单例,归 index.ts 持有):终端插件上报一条信号,
 * 这里把它变成**标签角标**与**系统通知**,并管好角标那一颗定时器。
 *
 * 为什么单例而不是每窗口一份:信号的权威身份是 tabId(全局唯一),而一个信号只影响
 * 「它所属的那个窗口」—— 由 `resolve(tabId)` 决定。单例 + 一次查表就够了,
 * 也让「关标签撤掉通知」这种跨窗口清理只有一个实现。
 *
 * 三层分工(改这个文件前先看):
 * - `shared/agentState.ts`:协议解析 + 角标映射 + 通知文案;**没有时钟、没有 electron**;
 * - 本文件:状态持有 + 定时器 + **通知时机**(本类不 import electron,所以能纯单测);
 * - `main/systemNotify.ts`:Electron `Notification` 的薄壳(click 回调也接在那里)。
 *
 * 两个刻意的设计:
 * 1. **`done` 角标会过期,`blocked` 不会** —— 等用户的那种必须留在那儿;
 * 2. **`blocked` 系统通知在「代理继续 / 标签关闭」时撤回**(`close()`,best-effort)——
 *    它是旧窗内「blocked 卡片常驻到被处理」的等价物;`done` 通知不追踪,交给系统通知中心。
 */

import { AGENT_DONE_BADGE_MS, badgeOfSignal, notificationCopy } from '@shared/agentState'
import type { AgentBadge, AgentSignal } from '@shared/agentState'
import type { NoticeHandle, SystemNotifyPort } from './systemNotify'
import { log } from './logger'

/** 信号 + 权威身份(终端插件按 pty 会话补上的 tabId) */
export type AgentReport = AgentSignal & { tabId: number }

/** 一个标签的落地目标;`null` = 标签已不存在(窗口关了 / 标签已关) */
export interface AgentTarget {
  setBadge(badge: AgentBadge | null): void
}

export interface AgentNotifyDeps {
  /** tabId → 落地目标(由 index.ts 用 WindowRegistry + TabManager 实现) */
  resolve: (tabId: number) => AgentTarget | null
  /** 系统通知出口(实现见 main/systemNotify.ts) */
  notify: SystemNotifyPort
  /** 定时器注入(单测用假时钟);返回取消函数 */
  schedule?: (fn: () => void, ms: number) => () => void
}

export class AgentNotify {
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly badges = new Map<number, AgentBadge | null>()
  /** tabId → 该标签当前那条 `blocked` 系统通知(状态推进 / 关标签时撤回它) */
  private readonly blocked = new Map<number, NoticeHandle>()
  /** 定时器:`<tabId>:badge`,便于按标签整批取消 */
  private readonly timers = new Map<string, () => void>()

  constructor(private readonly deps: AgentNotifyDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })
  }

  /** 终端插件上报一条状态;标签不存在时静默忽略(信号总是晚于标签关闭到) */
  report(report: AgentReport): void {
    const { tabId } = report
    const target = this.deps.resolve(tabId)
    if (!target) {
      log('代理状态信号落到不存在的标签,忽略', tabId, report.state)
      return
    }

    this.applyBadge(tabId, badgeOfSignal(report), target)

    if (report.state === 'blocked') {
      // 同一个标签只留一条「等你确认」:新弹框替换旧弹框(旧的那条已经不适用了)
      this.closeBlocked(tabId)
      const copy = notificationCopy('blocked', report)
      this.blocked.set(tabId, this.deps.notify.show({ kind: 'blocked', title: copy.title, body: copy.text, tabId }))
      return
    }
    if (report.state === 'idle' && report.done) {
      const copy = notificationCopy('done', report)
      this.deps.notify.show({ kind: 'done', title: copy.title, body: copy.text, tabId })
      return
    }
    // working / idle(非 done):代理继续了(用户已经答完那个弹框)→ 撤掉「等你确认」
    this.closeBlocked(tabId)
  }

  /** 标签关闭 / 窗口关闭:撤掉角标定时器与那条 `blocked` 通知 */
  tabClosed(tabId: number): void {
    this.cancelTab(tabId)
    this.badges.delete(tabId)
    this.closeBlocked(tabId)
  }

  // ---------- 内部:通知撤回 ----------

  private closeBlocked(tabId: number): void {
    const handle = this.blocked.get(tabId)
    if (!handle) return
    this.blocked.delete(tabId)
    handle.close()
  }

  // ---------- 内部:角标 ----------

  private applyBadge(tabId: number, badge: AgentBadge | null, target: AgentTarget): void {
    this.cancel(`${tabId}:badge`)
    const prev = this.badges.get(tabId) ?? null
    if (prev !== badge) {
      this.badges.set(tabId, badge)
      target.setBadge(badge)
    }
    if (badge === 'done') {
      // `done` 只是「刚刚跑完」的提示:到点自己消失,不要留一颗钉子
      this.later(`${tabId}:badge`, AGENT_DONE_BADGE_MS, () => {
        this.badges.set(tabId, null)
        this.deps.resolve(tabId)?.setBadge(null)
      })
    }
  }

  // ---------- 内部:定时器 ----------

  private later(key: string, ms: number, fn: () => void): void {
    this.cancel(key)
    this.timers.set(
      key,
      this.schedule(() => {
        this.timers.delete(key)
        fn()
      }, ms)
    )
  }

  private cancel(key: string): void {
    const cancel = this.timers.get(key)
    if (!cancel) return
    this.timers.delete(key)
    cancel()
  }

  private cancelTab(tabId: number): void {
    for (const key of [...this.timers.keys()]) {
      if (key.startsWith(`${tabId}:`)) this.cancel(key)
    }
  }
}
