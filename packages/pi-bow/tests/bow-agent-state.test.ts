/**
 * 状态桥扩展的状态机行为(pi 侧)。
 *
 * 为什么要假 pi:`extensions/bow-agent-state.ts` 跑在 pi 进程里,而这台机器上跑 vitest 的进程没有 pi。
 * 但它对外只有两样东西 —— 注册的事件处理器 + 写到 `process.stdout` 的 OSC —— 所以一个假 `ExtensionAPI`
 * 加一个 stdout 间谍就足够把三态机与「done 只在真跑完时给」这两条最容易错的行为钉住。
 *
 * 它此前完全没有测试:bow 侧的 `tests/terminalAgentSignal.test.ts` 只覆盖「解析器收到 OSC 之后」。
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

type Handler = (event: unknown, ctx: unknown) => void

interface FakePi {
  api: unknown
  handlers: Map<string, Handler[]>
}

function makePi(): FakePi {
  const handlers = new Map<string, Handler[]>()
  const api = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn])
      return () => {}
    },
    getSessionName: () => '会话名'
  }
  return { api, handlers }
}

/** 门禁 `BOW_TERMINAL` 在**模块加载时**读,所以必须 resetModules + 动态 import */
async function loadFactory(inBow: boolean): Promise<(pi: unknown) => void> {
  vi.resetModules()
  if (inBow) process.env.BOW_TERMINAL = '1'
  else delete process.env.BOW_TERMINAL
  const mod = (await import('../extensions/bow-agent-state')) as { default: (pi: unknown) => void }
  return mod.default
}

const OSC_RE = /^\x1b\]1337;bow;(.*)\x07$/
const tuiCtx = (isIdle: () => boolean = () => true) => ({ mode: 'tui', isIdle })

let writes: string[] = []
let spy: MockInstance

beforeEach(() => {
  writes = []
  spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
})

afterEach(() => {
  spy.mockRestore()
  delete process.env.BOW_TERMINAL
})

function payloads(): Record<string, unknown>[] {
  return writes.map((w) => {
    const m = OSC_RE.exec(w)
    if (!m) throw new Error(`不是 bow 的 OSC:${JSON.stringify(w)}`)
    return JSON.parse(m[1]) as Record<string, unknown>
  })
}

async function boot(inBow = true) {
  const factory = await loadFactory(inBow)
  const { api, handlers } = makePi()
  factory(api)
  return {
    handlerNames: () => [...handlers.keys()],
    fire: (name: string, event: unknown = {}, ctx: unknown = {}) => {
      for (const fn of handlers.get(name) ?? []) fn(event, ctx)
    }
  }
}

describe('BOW_TERMINAL 门禁', () => {
  it('别的终端里一个事件都不注册(不乱发 OSC)', async () => {
    const s = await boot(false)
    expect(s.handlerNames()).toEqual([])
    expect(writes).toEqual([])
  })
})

describe('三态机', () => {
  it('tui 会话:start 报 working,settled 报 idle+done(会话标签带会话名与目录名)', async () => {
    const s = await boot()
    s.fire('session_start', {}, tuiCtx())
    s.fire('agent_start')
    s.fire('agent_settled', {}, tuiCtx(() => true))

    expect(payloads()).toEqual([
      { v: 1, state: 'idle', agent: 'pi', text: 'π - 会话名 - bow' },
      { v: 1, state: 'working', agent: 'pi', text: 'π - 会话名 - bow' },
      { v: 1, state: 'idle', agent: 'pi', done: true, text: 'π - 会话名 - bow' }
    ])
  })

  it('非 tui(print / rpc / json 模式)不报:没有终端标签可显示', async () => {
    const s = await boot()
    s.fire('session_start', {}, { mode: 'print' })
    s.fire('agent_start')
    expect(writes).toEqual([])
  })

  it('session_start 之前的事件不报(只有顶层会话上报)', async () => {
    const s = await boot()
    s.fire('agent_start')
    s.fire('ui_prompt_start', { title: 'x' })
    expect(writes).toEqual([])
  })

  it('agent_settled 时 isIdle() 仍为 false(重试/压缩/续跑中)不报完成', async () => {
    const s = await boot()
    s.fire('session_start', {}, tuiCtx())
    s.fire('agent_start')
    s.fire('agent_settled', {}, tuiCtx(() => false))
    expect(payloads().map((p) => [p.state, p.done])).toEqual([
      ['idle', undefined],
      ['working', undefined]
    ])
  })

  it('同一状态重复上报不重复喊(心跳式输出不惊动 bow)', async () => {
    const s = await boot()
    s.fire('session_start', {}, tuiCtx())
    s.fire('agent_start')
    s.fire('agent_start')
    s.fire('agent_start')
    expect(payloads()).toHaveLength(2)
  })

  it('确认弹框:blocked 带标题与嵌套深度,退出后回到 working', async () => {
    const s = await boot()
    s.fire('session_start', {}, tuiCtx())
    s.fire('agent_start')
    s.fire('ui_prompt_start', { title: '是否继续?' }) // select
    s.fire('ui_prompt_start', { title: '真的?' }) // 嵌套 confirm
    s.fire('ui_prompt_end')
    s.fire('ui_prompt_end')

    expect(payloads().map((p) => [p.state, p.title])).toEqual([
      ['idle', undefined],
      ['working', undefined],
      // 嵌套时标题取最新那个;深度没归零就不回 working
      ['blocked', '是否继续?'],
      ['blocked', '真的?'],
      // 退出一层后仍是「深度>0 且标题未变」→ 去重,不再发一条
      ['working', undefined]
    ])
  })

  it('session_shutdown 报 idle(不带 done)', async () => {
    const s = await boot()
    s.fire('session_start', {}, tuiCtx())
    s.fire('agent_start')
    s.fire('session_shutdown')
    expect(payloads().at(-1)).toMatchObject({ state: 'idle' })
    expect(payloads().at(-1)?.done).toBeUndefined()
  })
})
