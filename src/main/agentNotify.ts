/**
 * 「编码代理状态」的落地端(进程级单例,归 index.ts 持有):终端插件上报一条信号,
 * 这里把它变成 **标签角标** 与 **底部居中通知**,并管好三种定时器。
 *
 * 为什么单例而不是每窗口一份:信号的权威身份是 tabId(全局唯一),而一个信号只影响
 * 「它所属的那个窗口」—— 由 `resolve(tabId)` 决定。单例 + 一次查表就够了,
 * 也让「关标签清通知」这种跨窗口清理只有一个实现。
 *
 * 三层分工(改这个文件前先看):
 * - `shared/agentState.ts`:纯归约(角标映射、通知栈);**没有时钟、没有随机数**;
 * - 本文件:状态持有 + 定时器 + 查表路由(依赖以端口注入,可单测);
 * - `main/toasts.ts`:每窗口的视图宿主(精确 bounds 的 WebContentsView),只负责画。
 *
 * 两个刻意的设计:
 * 1. **`done` 角标与 `done` 通知都会过期**,`blocked` 不会 —— 等用户的那种必须留在那儿;
 * 2. **标签关闭后仍要能清通知**:`TabManager.close()` 先 `unregisterTab()` 再发 `tab-closed`,
 *    那时 `byTabId()` 已经查不到这个标签了,所以这里把「宿主引用」按 tabId 缓存下来,
 *    `tabClosed()` 用缓存把通知摘掉(见 `toasts` 这个 Map)。
 */

import {
  AGENT_DONE_BADGE_MS,
  AGENT_DONE_TOAST_MS,
  badgeOfSignal,
  reduceToasts,
  toastsWouldChange
} from '@shared/agentState'
import type { AgentBadge, AgentSignal, AgentToastItem, ToastAction, ToastContext } from '@shared/agentState'
import { log } from './logger'

/** 信号 + 权威身份(终端插件按 pty 会话补上的 tabId) */
export type AgentReport = AgentSignal & { tabId: number }

/** 通知宿主的最小面:`main/toasts.ts` 的 ToastManager 结构上满足它 */
export interface AgentToastPort {
  items(): readonly AgentToastItem[]
  set(items: readonly AgentToastItem[]): void
}

/** 一个标签的落地目标;`null` = 标签已不存在(窗口关了 / 标签已关) */
export interface AgentTarget {
  setBadge(badge: AgentBadge | null): void
  toasts: AgentToastPort
}

export interface AgentNotifyDeps {
  /** tabId → 落地目标(由 index.ts 用 WindowRegistry + TabManager 实现) */
  resolve: (tabId: number) => AgentTarget | null
  /** 定时器注入(单测用假时钟);返回取消函数 */
  schedule?: (fn: () => void, ms: number) => () => void
  now?: () => number
  nextId?: () => string
}

export class AgentNotify {
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly now: () => number
  private readonly nextId: () => string
  /** 全局通知栈(权威);每次变化后按宿主切片下发 */
  private items: AgentToastItem[] = []
  /** tabId → 通知宿主:标签关闭后 record 没了,但宿主还在,清通知要靠它 */
  private readonly ports = new Map<number, AgentToastPort>()
  private readonly badges = new Map<number, AgentBadge | null>()
  /** 定时器:`<tabId>:badge` 与 `<tabId>:toast:<id>`,便于按标签整批取消 */
  private readonly timers = new Map<string, () => void>()

  constructor(private readonly deps: AgentNotifyDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })
    this.now = deps.now ?? (() => Date.now())
    this.nextId = deps.nextId ?? (() => `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  }

  /** 当前通知栈(只读快照;E2E / 测试用) */
  list(): AgentToastItem[] {
    return [...this.items]
  }

  get(id: string): AgentToastItem | null {
    return this.items.find((t) => t.id === id) ?? null
  }

  /** 终端插件上报一条状态;标签不存在时静默忽略(信号总是晚于标签关闭到) */
  report(report: AgentReport): void {
    const { tabId } = report
    const target = this.deps.resolve(tabId)
    if (!target) {
      log('代理状态信号落到不存在的标签,忽略', tabId, report.state)
      return
    }
    this.ports.set(tabId, target.toasts)

    this.applyBadge(tabId, badgeOfSignal(report), target)

    const action: ToastAction = { type: 'signal', tabId, signal: report, id: this.nextId(), at: this.now() }
    if (!toastsWouldChange(this.items, action)) return
    this.apply(reduceToasts(this.items, action, this.toastContext()))
    // 新入栈的 `done` 通知各自排一个自动关闭(blocked 不排:它就是要等人)
    for (const item of this.items) {
      if (item.kind !== 'done') continue
      const key = this.toastKey(item.tabId, item.id)
      if (this.timers.has(key)) continue
      this.later(key, AGENT_DONE_TOAST_MS, () => this.dismiss(item.id))
    }
  }

  /** 用户在通知里点了「×」或点进了标签 */
  dismiss(id: string): void {
    const item = this.get(id)
    if (item) this.cancel(this.toastKey(item.tabId, id))
    if (!toastsWouldChange(this.items, { type: 'dismiss', id })) return
    this.apply(reduceToasts(this.items, { type: 'dismiss', id }, this.toastContext()))
  }

  /** 标签关闭:撤掉它的通知与角标(必须靠缓存的宿主,见文件头注释) */
  tabClosed(tabId: number): void {
    this.cancelTab(tabId)
    this.badges.delete(tabId)
    // 宿主引用必须先取出来再删映射:下面 apply() 要靠它把该窗口的通知切片重算一遍
    const port = this.ports.get(tabId) ?? null
    this.ports.delete(tabId)
    if (!toastsWouldChange(this.items, { type: 'tab-closed', tabId })) return
    this.apply(reduceToasts(this.items, { type: 'tab-closed', tabId }, this.toastContext()), port ? [port] : [])
  }

  // ---------- 内部:角标 ----------

  private applyBadge(tabId: number, badge: AgentBadge | null, target?: AgentTarget): void {
    this.cancel(`${tabId}:badge`)
    const prev = this.badges.get(tabId) ?? null
    if (prev !== badge) {
      this.badges.set(tabId, badge)
      const hit = target ?? this.deps.resolve(tabId)
      hit?.setBadge(badge)
    }
    if (badge === 'done') {
      // `done` 只是「刚刚跑完」的提示:到点自己消失,不要留一颗钉子
      this.later(`${tabId}:badge`, AGENT_DONE_BADGE_MS, () => {
        this.badges.set(tabId, null)
        this.deps.resolve(tabId)?.setBadge(null)
      })
    }
  }

  // ---------- 内部:通知栈 ----------

  private toastContext(): ToastContext {
    return { id: this.nextId, now: this.now }
  }

  /**
   * 把全局栈按「宿主」切片下发(没有通知的宿主也会收到空数组,由它自己隐藏视图)。
   * `extraPorts` 用于「宿主映射已经被摘掉」的场合(关标签):那时从 items 反查不到它,
   * 但恰恰最需要把空切片推给那个窗口。
   */
  private apply(next: AgentToastItem[], extraPorts: AgentToastPort[] = []): void {
    const before = this.items
    this.items = next
    const touched = new Set<AgentToastPort>(extraPorts)
    for (const item of [...before, ...next]) {
      const port = this.ports.get(item.tabId)
      if (port) touched.add(port)
    }
    for (const port of touched) {
      port.set(next.filter((item) => this.ports.get(item.tabId) === port))
    }
  }

  // ---------- 内部:定时器 ----------

  private toastKey(tabId: number, id: string): string {
    return `${tabId}:toast:${id}`
  }

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
