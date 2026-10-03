/**
 * 终端插件:把 pty 输出里的代理状态信号剥出来、报给主进程。
 *
 * 这里用**假 pty** 走真代码路径(`createTerminalPlugin({ loadPty })` 这个注入缝就是为它留的):
 * 断言三件事 —— ①包含 OSC 的输出不会原样进 xterm(回放缓冲与 `data` 事件都必须是剥干净的);
 * ②状态按变化上报(重复喊不重复报);③会话结束 / 标签关闭会把状态清成 `idle`。
 * 另外覆盖「装了桥接扩展就用桥接信号、没装才用 pi 内建 `9;4` 降级」这条优先级。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => ({
  app: { on: () => {}, removeListener: () => {}, getPath: () => '/tmp', getVersion: () => '0.0.0' }
}))

const { createTerminalPlugin } = await import('../src/plugins/terminal/main')
const { defaultSettings } = await import('../src/plugins/terminal/shared')
const { BOW_OSC_PREFIX } = await import('../src/shared/agentState')
type PluginContext = import('../src/main/plugins/types').PluginContext
type AgentSignal = import('../src/shared/agentState').AgentSignal

const BEL = '\x07'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakePty {
  pid = 4242
  killed = false
  written = ''
  readonly resizes: Array<[number, number]> = []
  private readonly dataCbs: Array<(d: string) => void> = []
  private readonly exitCbs: Array<(e: { exitCode: number }) => void> = []

  onData(cb: (d: string) => void): void {
    this.dataCbs.push(cb)
  }

  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.push(cb)
  }

  write(data: string): void {
    this.written += data
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  kill(): void {
    this.killed = true
  }

  /** 测试驱动:模拟 shell / 终端里的程序产出 */
  emit(data: string): void {
    for (const cb of this.dataCbs) cb(data)
  }

  exit(code = 0): void {
    for (const cb of this.exitCbs) cb({ exitCode: code })
  }
}

interface Harness {
  pty: FakePty
  reports: Array<AgentSignal & { tabId: number }>
  emitted: Array<{ event: string; payload: unknown }>
  attach: (input: { tabId: number }) => Promise<{ ok: boolean; replay?: string }>
  closeTab: (tabId: number) => Promise<void>
  deactivate: () => Promise<void> | void
}

async function harness(): Promise<Harness> {
  const pty = new FakePty()
  const reports: Harness['reports'] = []
  const emitted: Harness['emitted'] = []
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const tabClosed: Array<(payload: unknown) => void> = []
  let settings = defaultSettings('linux', '/bin/bash')

  const ctx = {
    id: 'terminal',
    log: () => {},
    logError: () => {},
    storage: () => ({
      get: () => settings,
      set: (patch: Partial<typeof settings>) => (settings = { ...settings, ...patch }),
      setRaw: (value: typeof settings) => (settings = value)
    }),
    ipc: {
      handle: (method: string, fn: (...args: never[]) => unknown) => handlers.set(method, fn),
      emit: (event: string, payload?: unknown) => emitted.push({ event, payload })
    },
    events: {
      on: (name: string, cb: (payload: unknown) => void) => {
        if (name === 'tab:closed') tabClosed.push(cb)
      },
      emit: () => {}
    },
    service: { agent: { report: (report: AgentSignal & { tabId: number }) => reports.push(report) } }
  } as unknown as PluginContext

  const plugin = createTerminalPlugin({
    loadPty: async () =>
      ({
        spawn: () => pty
      }) as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createTerminalPlugin>[0]>['loadPty']>>
  })
  await plugin.activate(ctx)

  return {
    pty,
    reports,
    emitted,
    attach: (input) => (handlers.get('attach') as (i: unknown) => Promise<{ ok: boolean; replay?: string }>)(input),
    closeTab: async (tabId) => {
      for (const cb of tabClosed) cb({ id: tabId })
    },
    deactivate: () => plugin.deactivate?.(ctx)
  }
}

function bridgeSignal(payload: Record<string, unknown>): string {
  return `${BOW_OSC_PREFIX}${JSON.stringify(payload)}${BEL}`
}

describe('终端插件:代理状态信号', () => {
  it('剥掉控制序列:回放缓冲与广播出去的 data 都只有干净文本', async () => {
    const h = await harness()
    const result = await h.attach({ tabId: 7 })
    expect(result.ok).toBe(true)

    h.pty.emit(`before${bridgeSignal({ v: 1, state: 'blocked', title: '确认执行 bash' })}after`)
    await sleep(30)

    const chunks = h.emitted
      .filter((e) => e.event === 'data')
      .map((e) => (e.payload as { chunk: string }).chunk)
    expect(chunks.join('')).toBe('beforeafter')
    // 页面刷新会重放回放缓冲:它里面也不能留信号(否则刷新一次就重弹一次通知)
    const replay = await h.attach({ tabId: 7 })
    expect(replay.replay).toBe('beforeafter')
  })

  it('按变化上报:同一状态重复喊只报一次', async () => {
    const h = await harness()
    await h.attach({ tabId: 7 })
    const blocked = bridgeSignal({ v: 1, state: 'blocked', title: 'q' })
    h.pty.emit(blocked + blocked + blocked)
    h.pty.emit(blocked)
    expect(h.reports).toEqual([{ v: 1, state: 'blocked', title: 'q', tabId: 7 }])

    h.pty.emit(bridgeSignal({ v: 1, state: 'working' }))
    h.pty.emit(bridgeSignal({ v: 1, state: 'idle', done: true }))
    expect(h.reports.map((r) => r.state)).toEqual(['blocked', 'working', 'idle'])
    expect(h.reports[2]?.done).toBe(true)
  })

  it('信号被切成两个 chunk 也能还原(pty 一读一段)', async () => {
    const h = await harness()
    await h.attach({ tabId: 7 })
    const raw = `x${bridgeSignal({ v: 1, state: 'working' })}y`
    h.pty.emit(raw.slice(0, 10))
    h.pty.emit(raw.slice(10))
    await sleep(30)
    expect(h.reports).toEqual([{ v: 1, state: 'working', tabId: 7 }])
    const chunks = h.emitted.filter((e) => e.event === 'data').map((e) => (e.payload as { chunk: string }).chunk)
    expect(chunks.join('')).toBe('xy')
  })

  it('会话结束 / 标签关闭会把角标清成 idle', async () => {
    const h = await harness()
    await h.attach({ tabId: 7 })
    h.pty.emit(bridgeSignal({ v: 1, state: 'working' }))
    h.pty.exit(0)
    expect(h.reports.at(-1)).toEqual({ v: 1, state: 'idle', tabId: 7 })

    const h2 = await harness()
    await h2.attach({ tabId: 9 })
    h2.pty.emit(bridgeSignal({ v: 1, state: 'blocked' }))
    await h2.closeTab(9)
    expect(h2.pty.killed).toBe(true)
    expect(h2.reports.at(-1)).toEqual({ v: 1, state: 'idle', tabId: 9 })
  })

  it('没装桥接扩展时用 pi 内建的 9;4 兜底;装了之后 9;4 不再采信', async () => {
    const fallback = await harness()
    await fallback.attach({ tabId: 7 })
    fallback.pty.emit('\x1b]9;4;3\x07')
    fallback.pty.emit('\x1b]9;4;0\x07')
    expect(fallback.reports.map((r) => r.state)).toEqual(['working', 'idle'])
    // 降级路径**不报 done**(压缩结束也会发一次 clear,报完成会变成假通知)
    expect(fallback.reports.some((r) => r.done)).toBe(false)

    const bridged = await harness()
    await bridged.attach({ tabId: 7 })
    bridged.pty.emit(bridgeSignal({ v: 1, state: 'blocked', title: 'q' }))
    bridged.pty.emit('\x1b]9;4;3\x07')
    bridged.pty.emit('\x1b]9;4;0\x07')
    expect(bridged.reports.map((r) => r.state)).toEqual(['blocked'])
  })

  it('桥接扩展与降级信号都来自 pty,非本协议的 OSC(标题 / 超链接)原样进 xterm', async () => {
    const h = await harness()
    await h.attach({ tabId: 7 })
    const title = '\x1b]0;pi - bow\x07'
    h.pty.emit(title)
    await sleep(30)
    const chunks = h.emitted.filter((e) => e.event === 'data').map((e) => (e.payload as { chunk: string }).chunk)
    expect(chunks.join('')).toBe(title)
    expect(h.reports).toEqual([])
  })
})
