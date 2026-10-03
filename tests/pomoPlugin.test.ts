/**
 * 番茄钟插件主进程侧用例。
 *
 * 重点不是「能不能跑」,而是几条容易静默失效的契约:
 * - 计时以主进程时钟为准(假定时器推进 25 分钟必须真的切阶段 + 计数 + 通知);
 * - 跳过不计数;四连专注后进长休,长休后计数归零;
 * - 应用被杀期间走完的计时在下次 activate 时推进一个阶段并**暂停**;
 * - MCP 工具的返回体形状与 IPC 方法名集合。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  shown: [] as Array<{ title: string; body: string; silent?: boolean }>
}))

vi.mock('electron', () => {
  class MockNotification {
    private opts: { title: string; body: string; silent?: boolean }
    constructor(opts: { title: string; body: string; silent?: boolean }) {
      this.opts = opts
    }
    static isSupported(): boolean {
      return true
    }
    on(): this {
      return this
    }
    show(): void {
      h.shown.push(this.opts)
    }
  }
  return {
    Notification: MockNotification,
    BrowserWindow: { getAllWindows: () => [] }
  }
})

const { createPomoPluginInstance } = await import('../src/plugins/pomo/main')
const { DEFAULT_SETTINGS } = await import('../src/plugins/pomo/shared')
type PluginMain = import('../src/main/plugins/types').PluginMain
type PluginContext = import('../src/main/plugins/types').PluginContext
type PluginStorage = import('../src/main/plugins/types').PluginStorage
type PomoSnapshot = import('../src/plugins/pomo/shared').PomoSnapshot

interface Recorded {
  routes: string[]
  emits: Array<{ event: string; payload?: unknown }>
  tools: Array<{ name: string; handler: (args: Record<string, unknown>) => unknown }>
  shortcuts: number
  handlers: Map<string, (...args: unknown[]) => unknown>
}

const noop = (): void => {}

function memStore<T>(seed: T): PluginStorage<T> {
  let data = JSON.parse(JSON.stringify(seed)) as T
  return {
    get: () => data,
    set: (patch: Partial<T>) => {
      data = { ...data, ...patch } as T
      return data
    },
    setRaw: (value: T) => {
      data = value
      return data
    }
  }
}

function fakeCtx(rec: Recorded, seed?: { settings?: unknown; state?: unknown }): PluginContext {
  const store = memStore({
    settings: seed?.settings ?? { ...DEFAULT_SETTINGS },
    state: seed?.state ?? {}
  })
  const ctx = {
    id: 'pomo',
    log: noop,
    logError: noop,
    storage: <T>(): PluginStorage<T> => store as unknown as PluginStorage<T>,
    ipc: {
      handle: (method: string, fn: (...args: unknown[]) => unknown): void => {
        rec.routes.push(method)
        rec.handlers.set(method, fn)
      },
      emit: (event: string, payload?: unknown): void => {
        rec.emits.push({ event, payload })
      }
    },
    events: { on: noop, emit: noop },
    suggest: { register: noop },
    mcp: {
      tool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => unknown): void => {
        rec.tools.push({ name, handler })
      }
    },
    net: { onBeforeRequest: noop, onBeforeSendHeaders: noop, onHeadersReceived: noop },
    content: { inject: noop, refresh: noop },
    pages: { activeTabId: () => null, focus: noop, execute: async () => ({ ok: true }) },
    tabs: { list: () => [], getActive: () => null },
    shortcuts: {
      register: (): void => {
        rec.shortcuts += 1
      }
    }
  }
  return ctx as unknown as PluginContext
}

function record(): Recorded {
  return { routes: [], emits: [], tools: [], shortcuts: 0, handlers: new Map() }
}

function call<T = unknown>(rec: Recorded, method: string, ...args: unknown[]): T {
  const fn = rec.handlers.get(method)
  if (!fn) throw new Error('未注册的插件方法:' + method)
  return fn(...args) as T
}

function tool(rec: Recorded, name: string) {
  const hit = rec.tools.find((t) => t.name === name)
  if (!hit) throw new Error('未注册的 MCP 工具:' + name)
  return hit
}

/** MCP 返回体里的 JSON 负载 */
function toolJson<T = Record<string, unknown>>(res: unknown): T {
  const content = (res as { content: Array<{ type: string; text: string }> }).content
  return JSON.parse(content[0]!.text) as T
}

const T0 = Date.UTC(2026, 9, 3, 9, 0, 0)
const FOCUS_MS = DEFAULT_SETTINGS.focusMinutes * 60_000

beforeEach(() => {
  h.shown.length = 0
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

function setup(seed?: { settings?: unknown; state?: unknown }): { rec: Recorded; plugin: PluginMain } {
  const rec = record()
  const plugin = createPomoPluginInstance()
  plugin.activate(fakeCtx(rec, seed))
  return { rec, plugin }
}

describe('番茄钟插件:注册面', () => {
  it('manifest 与能力声明正确', () => {
    const plugin = createPomoPluginInstance()
    expect(plugin.manifest.id).toBe('pomo')
    expect(plugin.capabilities).toEqual(['ui', 'mcp', 'shortcut'])
  })

  it('激活时注册 IPC / MCP / 快捷键', () => {
    const { rec } = setup()
    expect([...rec.routes].sort()).toEqual(
      ['getSettings', 'getState', 'pause', 'reset', 'setSettings', 'skip', 'start', 'toggle'].sort()
    )
    expect(rec.tools.map((t) => t.name).sort()).toEqual(
      ['browser_pomo_pause', 'browser_pomo_skip', 'browser_pomo_start', 'browser_pomo_status'].sort()
    )
    expect(rec.shortcuts).toBe(1)
  })

  it('初始 getState 是「专注 / 暂停 / 满时长」', () => {
    const { rec } = setup()
    const snap = call<PomoSnapshot>(rec, 'getState')
    expect(snap.state.phase).toBe('focus')
    expect(snap.state.running).toBe(false)
    expect(snap.state.remainingMs).toBe(FOCUS_MS)
    expect(snap.settings).toEqual(DEFAULT_SETTINGS)
  })
})

describe('番茄钟插件:计时与阶段转移', () => {
  it('start → 跑起来;pause → 剩余量被固化', () => {
    const { rec } = setup()
    const started = call<PomoSnapshot>(rec, 'start')
    expect(started.state.running).toBe(true)
    expect(started.state.endsAt).toBe(T0 + FOCUS_MS)

    vi.setSystemTime(T0 + 60_000)
    const paused = call<PomoSnapshot>(rec, 'pause')
    expect(paused.state.running).toBe(false)
    expect(paused.state.remainingMs).toBe(FOCUS_MS - 60_000)
  })

  it('跑满 25 分钟自动切短休并计数 + 发通知', () => {
    const { rec } = setup()
    call(rec, 'start')
    vi.advanceTimersByTime(FOCUS_MS + 1000)

    const snap = call<PomoSnapshot>(rec, 'getState')
    expect(snap.state.phase).toBe('short-break')
    expect(snap.state.running).toBe(false)
    expect(snap.state.completedToday).toBe(1)
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0]!.title).toBe('专注结束')
    expect(rec.emits.some((e) => e.event === 'phase-end')).toBe(true)
  })

  it('skip 不计数但仍切阶段', () => {
    const { rec } = setup()
    const snap = call<PomoSnapshot>(rec, 'skip')
    expect(snap.state.phase).toBe('short-break')
    expect(snap.state.completedToday).toBe(0)
  })

  it('四个专注后进长休,长休结束 cycleIndex 归零', () => {
    const { rec } = setup()
    // 逐个跑完专注与短休(用假时钟推进,走真实 interval 路径)
    for (let i = 1; i <= 3; i++) {
      call(rec, 'start')
      vi.advanceTimersByTime(FOCUS_MS + 1000)
      const afterFocus = call<PomoSnapshot>(rec, 'getState')
      expect(afterFocus.state.phase).toBe('short-break')
      expect(afterFocus.state.cycleIndex).toBe(i)

      call(rec, 'start')
      vi.advanceTimersByTime(DEFAULT_SETTINGS.shortBreakMinutes * 60_000 + 1000)
      expect(call<PomoSnapshot>(rec, 'getState').state.phase).toBe('focus')
    }

    call(rec, 'start')
    vi.advanceTimersByTime(FOCUS_MS + 1000)
    const long = call<PomoSnapshot>(rec, 'getState')
    expect(long.state.phase).toBe('long-break')
    expect(long.state.cycleIndex).toBe(4)
    expect(long.state.completedToday).toBe(4)

    call(rec, 'start')
    vi.advanceTimersByTime(DEFAULT_SETTINGS.longBreakMinutes * 60_000 + 1000)
    const back = call<PomoSnapshot>(rec, 'getState')
    expect(back.state.phase).toBe('focus')
    expect(back.state.cycleIndex).toBe(0)
  })

  it('autoStartNext 打开后自动接着跑', () => {
    const { rec } = setup({ settings: { ...DEFAULT_SETTINGS, autoStartNext: true } })
    call(rec, 'start')
    vi.advanceTimersByTime(FOCUS_MS + 1000)
    const snap = call<PomoSnapshot>(rec, 'getState')
    expect(snap.state.phase).toBe('short-break')
    expect(snap.state.running).toBe(true)
  })
})

describe('番茄钟插件:重启恢复', () => {
  it('应用被杀期间走完的计时:推进一个阶段并暂停(不补通知)', () => {
    // 上次退出时是一个「还剩 1 秒」的专注,现在已过点 3 分钟
    const endsAt = T0 - 3 * 60_000
    const { rec } = setup({
      state: {
        phase: 'focus',
        running: true,
        endsAt,
        remainingMs: 1000,
        cycleIndex: 0,
        completedToday: 2,
        completedDate: '2026-10-03'
      }
    })
    const snap = call<PomoSnapshot>(rec, 'getState')
    expect(snap.state.phase).toBe('short-break')
    expect(snap.state.running).toBe(false)
    expect(snap.state.completedToday).toBe(3)
    expect(h.shown).toHaveLength(0)
  })
})

describe('番茄钟插件:设置与 MCP', () => {
  it('setSettings 夹紧后回填,并广播 state', () => {
    const { rec } = setup()
    const next = call<{ focusMinutes: number }>(rec, 'setSettings', { focusMinutes: 999, shortBreakMinutes: 0 })
    expect(next.focusMinutes).toBe(180)
    const snap = call<PomoSnapshot>(rec, 'getState')
    expect(snap.settings.shortBreakMinutes).toBe(1)
  })

  it('browser_pomo_status 返回状态;start / pause / skip 能改变它', () => {
    const { rec } = setup()
    const status = toolJson(tool(rec, 'browser_pomo_status').handler({}))
    expect(status.ok).toBe(true)
    expect(status.phase).toBe('focus')
    expect(status.running).toBe(false)
    expect(status.roundsBeforeLongBreak).toBe(4)

    expect(toolJson(tool(rec, 'browser_pomo_start').handler({})).running).toBe(true)
    expect(toolJson(tool(rec, 'browser_pomo_pause').handler({})).running).toBe(false)
    expect(toolJson(tool(rec, 'browser_pomo_skip').handler({})).phase).toBe('short-break')
  })
})
