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
      { v: 1, state: 'idle', agent: 'pi', text: 'π - 会话名 - bow', cwd: process.cwd() },
      { v: 1, state: 'working', agent: 'pi', text: 'π - 会话名 - bow', cwd: process.cwd() },
      { v: 1, state: 'idle', agent: 'pi', done: true, text: 'π - 会话名 - bow', cwd: process.cwd() }
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

/**
 * 手机上的「新会话 / 重载」两条命令。
 *
 * 要验的只有两件事:**名字没顶 pi 的内置命令**、**忙的时候拒而不是硬调** ——
 * `newSession()` 自己不做忙闲检查(内置 `/new` 直接调),`reload()` 拒的时候只在终端打 warning,
 * 手机端什么都收不到。真跑一遍 newSession 属于 `scripts/pi-chat-smoke.mjs` 的活。
 */
class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 1
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(): void {
    this.readyState = 3
  }
}

interface CommandOptions {
  description?: string
  handler: (args: string, ctx: unknown) => Promise<void>
}

async function bootBridge(): Promise<Map<string, CommandOptions>> {
  vi.resetModules()
  process.env.BOW_TERMINAL = '1'
  process.env.BOW_SESSION_ID = '7'
  process.env.BOW_REMOTE_URL = 'ws://127.0.0.1:1/ws'
  process.env.BOW_CONTROL_TOKEN = 'tk'
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  FakeSocket.instances = []
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeSocket, configurable: true, writable: true })

  const commands = new Map<string, CommandOptions>()
  const api = {
    on: () => () => {},
    getSessionName: () => undefined,
    getCommands: () => [],
    registerCommand: (name: string, options: CommandOptions) => {
      commands.set(name, options)
    }
  }
  const mod = (await import('../extensions/bow-agent-state')) as { default: (pi: unknown) => void }
  mod.default(api)

  afterEachRestore.push(() => {
    if (previous) Object.defineProperty(globalThis, 'WebSocket', previous)
    else Reflect.deleteProperty(globalThis, 'WebSocket')
  })
  return commands
}

/** FakeSocket 的全局还原(每条用例独立 push,afterEach 里依次执行) */
const afterEachRestore: Array<() => void> = []

afterEach(() => {
  while (afterEachRestore.length > 0) afterEachRestore.pop()?.()
  delete process.env.BOW_SESSION_ID
  delete process.env.BOW_REMOTE_URL
  delete process.env.BOW_CONTROL_TOKEN
})

interface FakeCommandCtx {
  isIdle: () => boolean
  newSession: () => Promise<{ cancelled: boolean }>
  reload: () => Promise<void>
}

/** `newSession` 调用那一刻已经发出去的帧数(用来钉「先 notice 再动手」) */
function makeCommandCtx(idle: boolean) {
  const calls: Array<{ call: string; framesBefore: number }> = []
  const frames = (): number => FakeSocket.instances.at(-1)?.sent.length ?? 0
  const ctx: FakeCommandCtx = {
    isIdle: () => idle,
    newSession: async () => {
      calls.push({ call: 'newSession', framesBefore: frames() })
      return { cancelled: false }
    },
    reload: async () => {
      calls.push({ call: 'reload', framesBefore: frames() })
    }
  }
  return { ctx, calls }
}

function notices(): string[] {
  return (FakeSocket.instances.at(-1)?.sent ?? [])
    .filter((frame) => frame.type === 'message')
    .map((frame) => String((frame.message as { text?: string }).text ?? ''))
}

describe('手机上的 /bow-new 与 /bow-reload', () => {
  it('两条命令都注册了,而且没顶 pi 的内置名', async () => {
    const commands = await bootBridge()
    expect([...commands.keys()]).toEqual(['bow-new', 'bow-reload'])
    // 顶了内置名 pi 会报冲突 warning,且终端/手机两条路的优先级相反
    expect(commands.has('new')).toBe(false)
    expect(commands.has('reload')).toBe(false)
  })

  it('/bow-new:先给一条提示,再 newSession', async () => {
    const commands = await bootBridge()
    const { ctx, calls } = makeCommandCtx(true)
    await commands.get('bow-new')!.handler('', ctx)
    expect(calls).toEqual([{ call: 'newSession', framesBefore: 1 }])
    expect(notices().at(-1)).toContain('正在新建会话')
  })

  it('/bow-new:忙的时候拒,而且把理由说到手机上', async () => {
    const commands = await bootBridge()
    const { ctx, calls } = makeCommandCtx(false)
    await commands.get('bow-new')!.handler('', ctx)
    expect(calls).toEqual([])
    expect(notices().at(-1)).toContain('等这一轮结束')
  })

  it('/bow-reload:闲时重载,忙时拒(理由也要到手机上)', async () => {
    const commands = await bootBridge()
    const idle = makeCommandCtx(true)
    await commands.get('bow-reload')!.handler('', idle.ctx)
    expect(idle.calls).toEqual([{ call: 'reload', framesBefore: 1 }])
    expect(notices().at(-1)).toContain('正在重载')

    const busy = makeCommandCtx(false)
    await commands.get('bow-reload')!.handler('', busy.ctx)
    expect(busy.calls).toEqual([])
    expect(notices().at(-1)).toContain('等结束再重载')
  })
})
