/**
 * 页内查找(Ctrl+F)的主进程会话。
 *
 * 设计要点:
 * - 查找条复用 Overlay 的 `page-top-right` placement(浮层同一时刻只能有一份)——
 *   `pushState()` 用 `overlay.currentId === 'find'` 兜底,保证异步的 `found-in-page` 结果
 *   **不会**把地址栏建议 / 分屏面板 / 下载面板顶掉。
 * - 查询结果走独立的 `find:state` 通道下行,而不是重发整套 `overlay:show`:
 *   后者会在每敲一个字时重排浮层、并 `webContents.focus()` 把焦点从页面抢回查找条。
 * - 高亮与计数用 Electron 原生 `findInPage`;`stopFindInPage('clearSelection')` 负责关掉时清高亮。
 * - 状态每窗口一份(`WeakMap<WindowContext, …>`),不改 `WindowContext` 结构。
 *
 * 标签生命周期(v1 刻意简化):**导航 / 切到别的标签 / 关标签都收起查找条**
 * (Chrome 是每标签记忆查询与高亮;要贴 Chrome 需要把状态从「每窗口一份」扩成「每标签一份」)。
 */

import type { FoundInPageResult, WebContents } from 'electron'
import type { FindPayload, FindStateMessage, OverlayContent, OverlayEvent } from '@shared/types'
import type { WindowContext } from './windows'
import { log } from './logger'

interface FindState {
  tabId: number
  wc: WebContents
  query: string
  matchCase: boolean
  /** 最近一次 `findInPage` 返回的请求 id:迟到的旧结果按它丢弃 */
  requestId: number
  onFound: (event: unknown, result: FoundInPageResult) => void
}

const states = new WeakMap<WindowContext, FindState>()

function stateOf(ctx: WindowContext): FindState | undefined {
  return states.get(ctx)
}

/** 打开/重新聚焦查找条;`tabIdHint` = 按键来源的那个窗格(与 Ctrl+W 同口径),拿不到才退回活动标签 */
export function openFind(ctx: WindowContext, tabIdHint: number | null): void {
  if (ctx.overlay.isFullOpen) return
  const target = tabIdHint ?? ctx.tabs.getActiveTabInfo()?.id ?? null
  if (target == null) return

  const existing = stateOf(ctx)
  if (existing && existing.tabId === target) {
    // 已在这个标签上查找:沿用查询,只重新聚焦 + 全选(由渲染层按 refocus 处理)
    showBar(ctx, existing.query, existing.matchCase)
    ctx.overlay.send('find:state', { refocus: true } satisfies FindStateMessage)
    return
  }
  if (existing) closeFind(ctx)

  const wc = ctx.tabs.getView(target)?.view.webContents ?? null
  if (!wc || wc.isDestroyed()) return

  const state: FindState = {
    tabId: target,
    wc,
    query: '',
    matchCase: false,
    requestId: 0,
    onFound: (_event, result) => {
      const now = stateOf(ctx)
      if (!now || now !== state) return
      if (result.requestId !== state.requestId) return // 旧请求的结果,丢弃
      pushState(ctx, result)
    }
  }
  states.set(ctx, state)
  wc.on('found-in-page', state.onFound)
  showBar(ctx, '', false)
  log('页内查找:打开', target)
}

/** overlay → 主进程的查找事件(由 `ipc.ts` 的 `ui:overlay-event` 路由进来) */
export function handleFindEvent(ctx: WindowContext, ev: OverlayEvent): void {
  if (ev.id !== 'find') return
  const state = stateOf(ctx)
  switch (ev.event) {
    case 'query': {
      if (!state) return
      const args = (ev.args ?? {}) as { text?: unknown; matchCase?: unknown }
      state.query = typeof args.text === 'string' ? args.text : ''
      state.matchCase = !!args.matchCase
      if (state.query === '') {
        stopSearching(state)
        pushState(ctx, { requestId: state.requestId, matches: 0, activeMatchOrdinal: 0, finalUpdate: true })
        return
      }
      run(ctx, state, { findNext: false, forward: true })
      return
    }
    case 'next': {
      if (!state || state.query === '') return
      const args = (ev.args ?? {}) as { forward?: unknown }
      run(ctx, state, { findNext: true, forward: args.forward !== false })
      return
    }
    case 'close':
      closeFind(ctx)
      return
    default:
      return
  }
}

/** 收起查找条并清掉当前标签的高亮(幂等) */
export function closeFind(ctx: WindowContext): void {
  const state = stateOf(ctx)
  if (state) {
    removeListener(state)
    stopSearching(state)
    states.delete(ctx)
    log('页内查找:关闭', state.tabId)
  }
  // 只有查找条正开着才关浮层 —— 否则会把别的浮层(建议 / 分屏面板 / 下载面板)误关掉
  if (ctx.overlay.currentId === 'find') ctx.overlay.show(null)
}

/** 目标标签完成一次主框架导航:高亮已随文档销毁,收起 */
export function onTabNavigated(ctx: WindowContext, tabId: number): void {
  if (stateOf(ctx)?.tabId === tabId) closeFind(ctx)
}

/** 目标标签被关闭 */
export function onTabClosed(ctx: WindowContext, tabId: number): void {
  if (stateOf(ctx)?.tabId === tabId) closeFind(ctx)
}

/** 焦点切到了别的标签 */
export function onTabActivated(ctx: WindowContext, tabId: number): void {
  const state = stateOf(ctx)
  if (state && state.tabId !== tabId) closeFind(ctx)
}

// ---------- 内部 ----------

function showBar(ctx: WindowContext, query: string, matchCase: boolean): void {
  const payload: FindPayload = { query, matchCase }
  const content: OverlayContent<'find'> = { id: 'find', placement: 'page-top-right', payload }
  ctx.overlay.show(content)
}

function run(
  ctx: WindowContext,
  state: FindState,
  opts: { findNext: boolean; forward: boolean }
): void {
  if (state.wc.isDestroyed()) {
    closeFind(ctx)
    return
  }
  try {
    state.requestId = state.wc.findInPage(state.query, {
      forward: opts.forward,
      findNext: opts.findNext,
      matchCase: state.matchCase
    })
  } catch (e) {
    // 页面正在销毁 / 崩溃时 findInPage 会抛:不能让它冒泡回 before-input-event
    log('页内查找失败', state.tabId, e instanceof Error ? e.message : String(e))
    closeFind(ctx)
  }
}

function pushState(ctx: WindowContext, result: FoundInPageResult | FindStateMessage): void {
  // 查找条已被别的浮层替换:结果只留在主进程状态里,绝不把它顶出来
  if (ctx.overlay.currentId !== 'find') return
  const msg: FindStateMessage = {
    requestId: result.requestId,
    matches: result.matches,
    activeMatchOrdinal: result.activeMatchOrdinal,
    finalUpdate: result.finalUpdate
  }
  ctx.overlay.send('find:state', msg)
}

function stopSearching(state: FindState): void {
  if (state.wc.isDestroyed()) return
  try {
    state.wc.stopFindInPage('clearSelection')
  } catch {
    // 页面已销毁:忽略
  }
}

function removeListener(state: FindState): void {
  if (state.wc.isDestroyed()) return
  state.wc.removeListener('found-in-page', state.onFound)
}
