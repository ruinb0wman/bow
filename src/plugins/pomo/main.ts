/**
 * 番茄钟插件(主进程侧):**权威时钟在这里**。
 *
 * 三条必须记住的设计(改代码前先看):
 * 1. **不在渲染层计时**:渲染层可能被隐藏/节流,窗口也可能换。计时状态只存 `phase / running / endsAt / remainingMs`,
 *    主进程用一个 1s 的 `setInterval` 检查 `now >= endsAt` —— 不做长 `setTimeout`(跨休眠会漂移,见 shared.ts 头注释)。
 * 2. **只在状态转换时写盘**:`pomo.json` 不会每秒被写一次;倒计时由渲染层拿 `endsAt` 本地插值。
 * 3. **主进程不能开/关浮层**:面板的开关全在渲染层(工具栏按钮 `showOverlay`,关闭走 `close-request`)。
 *    主进程只负责把状态经 `ctx.ipc.emit` 广播出去。
 */

import { BrowserWindow, Notification } from 'electron'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import { textContent } from '../../main/plugins/mcpResult'
import {
  DEFAULT_SETTINGS,
  PHASE_LABELS,
  POMO_EVENT,
  completePhase,
  formatClock,
  initialState,
  normalizeSettings,
  normalizeState,
  pausePhase,
  remainingMsOf,
  resetPhase,
  rolloverDay,
  roundLabel,
  startPhase,
  type Phase,
  type PomoSettings,
  type PomoSnapshot,
  type PomoState
} from './shared'

/** `pomo.json` 的落盘形状 */
interface PomoStore {
  settings: PomoSettings
  state: PomoState
}

/** 阶段完成的提示文案 */
function phaseEndCopy(finished: Phase, next: Phase): { title: string; body: string } {
  if (finished === 'focus') {
    return next === 'long-break'
      ? { title: '专注结束', body: '完成一轮,去长休息一下' }
      : { title: '专注结束', body: '该短休息了' }
  }
  return { title: '休息结束', body: '回来继续专注吧' }
}

function createPomoPlugin(): PluginMain {
  let context: PluginContext | null = null
  let store: PluginStorage<PomoStore> | null = null
  let settings: PomoSettings = { ...DEFAULT_SETTINGS }
  let state: PomoState = initialState(DEFAULT_SETTINGS, Date.now())
  let timer: NodeJS.Timeout | null = null

  // ---------- 内部工具 ----------

  function snapshot(now = Date.now()): PomoSnapshot {
    state = rolloverDay(state, now)
    return { settings: { ...settings }, state: { ...state }, serverNow: now }
  }

  function persist(): void {
    store?.set({ settings, state })
  }

  function broadcast(): void {
    context?.ipc.emit(POMO_EVENT.state, snapshot())
  }

  function focusSomeWindow(): void {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  function notifyPhaseEnd(completed: { phase: Phase; focus: boolean }): void {
    if (!settings.notify) return
    try {
      if (!Notification.isSupported()) return
      const copy = phaseEndCopy(completed.phase, state.phase)
      // silent: true —— 声音统一由渲染层 WebAudio 出,避免系统通知与提示音双响
      const notification = new Notification({ title: copy.title, body: copy.body, silent: true })
      notification.on('click', focusSomeWindow)
      notification.show()
    } catch (e) {
      context?.logError('系统通知发送失败', e)
    }
  }

  /**
   * 完成当前阶段。`autoStart` 省略时取设置里的 `autoStartNext`;
   * `count=false`(跳过)不计入今日完成数。
   */
  function finishPhase(count: boolean, autoStart?: boolean): void {
    const now = Date.now()
    const { next, completed } = completePhase(state, settings, now, {
      count,
      autoStart: autoStart ?? settings.autoStartNext
    })
    state = next
    persist()
    broadcast()
    notifyPhaseEnd(completed)
    context?.ipc.emit(POMO_EVENT.phaseEnd, {
      phase: completed.phase,
      focus: completed.focus,
      autoStarted: next.running
    })
  }

  function startTimer(): void {
    const now = Date.now()
    state = startPhase(rolloverDay(state, now), settings, now)
    persist()
    broadcast()
  }

  function pauseTimer(): void {
    const now = Date.now()
    if (!state.running) return
    state = pausePhase(state, now)
    persist()
    broadcast()
  }

  function resetTimer(): void {
    state = resetPhase(state, settings)
    persist()
    broadcast()
  }

  /** 跳过当前阶段:跑着就接着跑下一阶段,暂停则看 autoStartNext */
  function skipPhase(): void {
    finishPhase(false, state.running || settings.autoStartNext)
  }

  /** MCP 返回体 / 状态查询的统一形状(纯数据,可结构化克隆) */
  function statusPayload(): Record<string, unknown> {
    const now = Date.now()
    state = rolloverDay(state, now)
    const remaining = remainingMsOf(state, now)
    return {
      ok: true,
      phase: state.phase,
      phaseLabel: PHASE_LABELS[state.phase],
      running: state.running,
      remainingMs: remaining,
      remainingText: formatClock(remaining),
      round: roundLabel(state, settings),
      cycleIndex: state.cycleIndex,
      roundsBeforeLongBreak: settings.roundsBeforeLongBreak,
      completedToday: state.completedToday,
      endsAt: state.endsAt,
      settings: { ...settings }
    }
  }

  // ---------- 插件 ----------

  return {
    manifest: {
      id: 'pomo',
      name: '番茄钟',
      description: '专注 / 休息计时器:番茄工作法,阶段结束有通知与提示音',
      version: '1.0.0'
    },
    capabilities: ['ui', 'mcp', 'shortcut'],

    activate(ctx: PluginContext): void {
      context = ctx
      store = ctx.storage<PomoStore>({
        file: 'pomo.json',
        defaults: {
          settings: { ...DEFAULT_SETTINGS },
          state: initialState(DEFAULT_SETTINGS, Date.now())
        }
      })

      const raw = store.get()
      settings = normalizeSettings(raw.settings)
      const now = Date.now()
      state = normalizeState(raw.state, settings, now)
      // 应用被杀期间计时已走完:推进一个阶段并**暂停**(不补发通知,免得开屏弹一堆)
      if (state.running && state.endsAt != null && now >= state.endsAt) {
        state = completePhase(state, settings, now, { count: true, autoStart: false }).next
      }
      persist()

      // ---------- 渲染层 IPC ----------
      ctx.ipc.handle('getState', (): PomoSnapshot => snapshot())
      ctx.ipc.handle('getSettings', (): PomoSettings => ({ ...settings }))
      ctx.ipc.handle('setSettings', (patch: unknown): PomoSettings => {
        const obj = patch && typeof patch === 'object' ? patch : {}
        settings = normalizeSettings({ ...settings, ...obj })
        persist()
        broadcast()
        return { ...settings }
      })
      ctx.ipc.handle('start', (): PomoSnapshot => {
        startTimer()
        return snapshot()
      })
      ctx.ipc.handle('pause', (): PomoSnapshot => {
        pauseTimer()
        return snapshot()
      })
      ctx.ipc.handle('skip', (): PomoSnapshot => {
        skipPhase()
        return snapshot()
      })
      ctx.ipc.handle('reset', (): PomoSnapshot => {
        resetTimer()
        return snapshot()
      })
      ctx.ipc.handle('toggle', (): PomoSnapshot => {
        if (state.running) pauseTimer()
        else startTimer()
        return snapshot()
      })

      // ---------- MCP 工具 ----------
      const noArgs = {}
      ctx.mcp.tool(
        'browser_pomo_status',
        {
          description:
            '查看番茄钟状态:当前阶段(专注 / 短休息 / 长休息)、是否在跑、剩余时间、本轮第几个番茄、今日完成数',
          inputSchema: noArgs
        },
        () => textContent(statusPayload())
      )
      ctx.mcp.tool(
        'browser_pomo_start',
        {
          description: '开始或继续番茄钟的当前阶段;返回开始后的状态',
          inputSchema: noArgs
        },
        () => {
          startTimer()
          return textContent(statusPayload())
        }
      )
      ctx.mcp.tool(
        'browser_pomo_pause',
        {
          description: '暂停番茄钟;返回暂停后的状态',
          inputSchema: noArgs
        },
        () => {
          pauseTimer()
          return textContent(statusPayload())
        }
      )
      ctx.mcp.tool(
        'browser_pomo_skip',
        {
          description: '跳过当前阶段进入下一阶段(专注 → 休息 / 休息 → 专注;跳过不增加今日完成数)',
          inputSchema: noArgs
        },
        () => {
          skipPhase()
          return textContent(statusPayload())
        }
      )

      // ---------- 全局热键 ----------
      ctx.shortcuts.register({ key: 'o', code: 'KeyO', ctrl: true, shift: true }, () => {
        if (state.running) pauseTimer()
        else startTimer()
      })

      // ---------- 时钟 ----------
      timer = setInterval(() => {
        if (state.running && state.endsAt != null && Date.now() >= state.endsAt) finishPhase(true)
      }, 1000)
      if (typeof timer.unref === 'function') timer.unref()
    },

    deactivate(): void {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}

/** 便于测试:每次调用得到一份独立实例(模块级单例的记忆由内核管理) */
export function createPomoPluginInstance(): PluginMain {
  return createPomoPlugin()
}

const pomoPlugin = createPomoPlugin()
export default pomoPlugin
