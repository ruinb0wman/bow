/**
 * 终端插件:会话台账(S1/S2)—— `listSessions` / `sessions-changed` / 五个会话操作。
 *
 * 用**假 pty** 走真代码路径(`createTerminalPlugin({ loadPty })`),与 `terminalRun.test.ts` 同一个套路。
 * 看住四类事:
 * ① 投影内容:一个刚 attach 的会话该有什么(cwd/pid/尺寸/createdAt,`lastOutputAt` 与 `agent` 初始为 null);
 * ② 节流与去重:输出很密时**不能**每个 chunk 都广播 —— 合并窗口 + 指纹分桶两层都要生效;
 * ③ 代理状态:OSC 信号 → 台账里的结构化 `agent` + 报给内核(角标/通知那条路);
 * ⑤ 面板要用的展示函数:注意力排序(等用户的排最前)、「多久前」、路径缩略。
 *
 * 用假时钟(`vi.setSystemTime` 钉死起点)是为了让分桶边界确定 —— 否则「桶内不广播」这条断言会随机翻车。
 */

import { homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => ({
  app: { on: () => {}, removeListener: () => {}, getPath: () => '/tmp', getVersion: () => '0.0.0' }
}))

const { createTerminalPlugin } = await import('../src/plugins/terminal/main')
const {
  SESSION_ACTIVITY_BUCKET_MS,
  SESSIONS_THROTTLE_MS,
  TERMINAL_EVENTS,
  attentionRank,
  defaultSettings,
  formatAgo,
  sessionSignature,
  shortPath,
  sortSessionsByAttention,
  withWindowsExeSuffix
} = await import('../src/plugins/terminal/shared')
const { TERMINAL_RUN_EVENT } = await import('../src/shared/terminalRun')
type PluginContext = import('../src/main/plugins/types').PluginContext
type PluginMain = import('../src/main/plugins/types').PluginMain
type SessionInfo = import('../src/plugins/terminal/shared').SessionInfo

/** 假时钟起点:能被 SESSION_ACTIVITY_BUCKET_MS 整除,于是分桶边界落在整 5 秒上 */
const T0 = 1_700_000_000_000

class FakePty {
  pid = 4242
  onDataCb: ((data: string) => void) | null = null
  onExitCb: ((e: { exitCode: number }) => void) | null = null
  written: string[] = []
  resizes: Array<[number, number]> = []
  killed = false
  onData(cb: (data: string) => void): void {
    this.onDataCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.onExitCb = cb
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }
  kill(): void {
    this.killed = true
  }
}

interface Harness {
  plugin: PluginMain
  /** 让下一次 spawn 抛错(模拟「命令不存在」:node-pty 抛 File not found) */
  failNextSpawn: () => void
  ctx: PluginContext
  ptys: FakePty[]
  opened: string[]
  activated: number[]
  runRequests: Array<Record<string, unknown>>
  agentReports: Array<{ tabId: number; state: string }>
  /** 注册过的 MCP 工具名 → 处理器(直接调,不经 MCP 传输层) */
  tools: Map<string, (args: Record<string, unknown>) => unknown>
  toolNames: string[]
  /** 某个 ipc 事件被广播过的全部负载 */
  emitted: (event: string) => unknown[]
  invoke: <T = unknown>(method: string, ...args: unknown[]) => Promise<T>
  attach: (tabId: number, cols?: number, rows?: number) => Promise<{ ok: boolean; error?: string; reused?: boolean }>
}

async function harness(platform = 'win32'): Promise<Harness> {
  const ptys: FakePty[] = []
  const opened: string[] = []
  const activated: number[] = []
  const runRequests: Array<Record<string, unknown>> = []
  const agentReports: Array<{ tabId: number; state: string }> = []
  const ipcEmits: Array<{ event: string; payload: unknown }> = []
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const eventSubs = new Map<string, Array<(payload: unknown) => void>>()
  const tools = new Map<string, (args: Record<string, unknown>) => unknown>()
  const settings = defaultSettings(platform, '/bin/bash')

  const ctx = {
    id: 'terminal',
    log: () => {},
    logError: () => {},
    storage: () => ({ get: () => settings, set: () => settings, setRaw: () => settings }),
    ipc: {
      handle: (m: string, fn: (...a: never[]) => unknown) => handlers.set(m, fn),
      emit: (event: string, payload: unknown) => ipcEmits.push({ event, payload })
    },
    events: {
      on: (name: string, cb: (payload: unknown) => void) => {
        eventSubs.set(name, [...(eventSubs.get(name) ?? []), cb])
      },
      // 真内核会把 emit 派发给所有订阅者(包括插件自己),这里照做 —— 不然 createSession 发出去的
      // terminal:run 就没人校验,测试反而弱了
      emit: (name: string, payload: unknown) => {
        if (name === TERMINAL_RUN_EVENT) runRequests.push(payload as Record<string, unknown>)
        for (const cb of eventSubs.get(name) ?? []) cb(payload)
      }
    },
    service: { agent: { report: (r: { tabId: number; state: string }) => agentReports.push(r) } },
    mcp: {
      tool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => unknown) =>
        tools.set(name, handler)
    },
    tabs: { openInternal: (page: string) => (opened.push(page), 101) },
    pages: { activate: (tabId: number) => (activated.push(tabId), true) }
  } as unknown as PluginContext

  let failOnce = false
  const plugin = createTerminalPlugin({
    // 单测里把等待缩短:默认 3000ms 会让「起不来的命令」那条用例白等
    runWaitMs: 300,
    loadPty: async () =>
      ({
        spawn: () => {
          if (failOnce) {
            failOnce = false
            throw new Error('File not found: node.exe')
          }
          const pty = new FakePty()
          ptys.push(pty)
          return pty
        }
      }) as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createTerminalPlugin>[0]>['loadPty']>>
  })
  await plugin.activate(ctx)

  return {
    plugin,
    ctx,
    failNextSpawn: () => {
      failOnce = true
    },
    ptys,
    opened,
    activated,
    runRequests,
    agentReports,
    tools,
    toolNames: [...tools.keys()],
    emitted: (event) => ipcEmits.filter((e) => e.event === event).map((e) => e.payload),
    invoke: async <T = unknown>(method: string, ...args: unknown[]): Promise<T> => {
      const fn = handlers.get(method) as ((...a: unknown[]) => T) | undefined
      if (!fn) throw new Error(`未注册的 IPC 方法:${method}`)
      return await fn(...args)
    },
    attach: (tabId, cols = 80, rows = 24) =>
      (handlers.get('attach') as (i: unknown) => Promise<{ ok: boolean; error?: string; reused?: boolean }>)({
        tabId,
        cols,
        rows
      })
  }
}

/** 走完一个合并窗口(顺带把 8ms 的输出合批也跑掉) */
function settle(): void {
  vi.advanceTimersByTime(SESSIONS_THROTTLE_MS + 20)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------- 纯函数:指纹 ----------

describe('sessionSignature', () => {
  const base: SessionInfo = {
    id: 1,
    title: 'bash',
    profileId: 'bash',
    cwd: '/home/u',
    pid: 10,
    cols: 80,
    rows: 24,
    createdAt: T0,
    lastOutputAt: null,
    agent: null
  }

  it('同一份台账给同一个签名,且不随时间流逝改变', () => {
    expect(sessionSignature([base])).toBe(sessionSignature([{ ...base }]))
    expect(sessionSignature([{ ...base, createdAt: base.createdAt }])).toBe(sessionSignature([{ ...base, createdAt: 0 }]))
  })

  it('lastOutputAt 按桶去重:桶内变化不算变,跨桶才算', () => {
    const sig = (delta: number) => sessionSignature([{ ...base, lastOutputAt: T0 + delta }])
    expect(sig(1)).toBe(sig(SESSION_ACTIVITY_BUCKET_MS - 1))
    expect(sig(0)).not.toBe(sig(SESSION_ACTIVITY_BUCKET_MS))
  })

  it('代理状态、尺寸、标题变化都要算变', () => {
    const blocked = sessionSignature([{ ...base, agent: { state: 'blocked', at: T0 } }])
    expect(blocked).not.toBe(sessionSignature([base]))
    expect(sessionSignature([{ ...base, agent: { state: 'working', at: T0 } }])).not.toBe(blocked)
    expect(sessionSignature([{ ...base, cols: 81 }])).not.toBe(sessionSignature([base]))
    expect(sessionSignature([{ ...base, title: 'zsh' }])).not.toBe(sessionSignature([base]))
  })

  it('多会话时不能把两个台账拼成同一个签名', () => {
    const other = { ...base, id: 2, title: 'bash' }
    expect(sessionSignature([base, other])).not.toBe(sessionSignature([{ ...base, title: 'bash2' }]))
  })
})

// ---------- 台账 ----------

describe('终端会话台账', () => {
  it('初始为空;attach 后能读到完整投影', async () => {
    const h = await harness()
    expect(await h.invoke<SessionInfo[]>('listSessions')).toEqual([])

    expect((await h.attach(7)).ok).toBe(true)
    const infos = await h.invoke<SessionInfo[]>('listSessions')
    expect(infos).toHaveLength(1)
    expect(infos[0]).toMatchObject({
      id: 7,
      title: 'Windows PowerShell',
      profileId: 'powershell',
      cwd: homedir(),
      pid: 4242,
      cols: 80,
      rows: 24,
      lastOutputAt: null,
      agent: null
    })
    expect(infos[0]!.createdAt).toBe(T0)
  })

  it('按 id 排序:关掉再开的会话不会让列表跳位', async () => {
    const h = await harness()
    await h.attach(7)
    await h.attach(3)
    expect((await h.invoke<SessionInfo[]>('listSessions')).map((s) => s.id)).toEqual([3, 7])
  })

  it('一次变化只广播一次(合并窗口),没变就不再发', async () => {
    const h = await harness()
    await h.attach(7)
    settle()
    const afterAttach = h.emitted(TERMINAL_EVENTS.sessionsChanged)
    expect(afterAttach).toHaveLength(1)
    expect(afterAttach[0]).toMatchObject([{ id: 7 }])

    settle()
    expect(h.emitted(TERMINAL_EVENTS.sessionsChanged)).toHaveLength(1)
  })

  it('持续输出时每个 5s 桶最多广播一次(否则节流形同虚设)', async () => {
    const h = await harness()
    await h.attach(7)
    settle()
    // 先热一次:`lastOutputAt` 从 null 变成数字是**真实的**变化,那一次应该发
    h.ptys[0]!.onDataCb?.('x')
    settle()
    const before = h.emitted(TERMINAL_EVENTS.sessionsChanged).length

    // 桶内:再敲 4 次,每次跨过合并窗口 —— 指纹不变,一次都不该发
    for (let i = 0; i < 4; i++) {
      h.ptys[0]!.onDataCb?.('x')
      settle()
    }
    expect(h.emitted(TERMINAL_EVENTS.sessionsChanged)).toHaveLength(before)

    // 跨桶:输出时间落到下一个桶 → 允许发一次
    vi.advanceTimersByTime(SESSION_ACTIVITY_BUCKET_MS)
    h.ptys[0]!.onDataCb?.('x')
    settle()
    expect(h.emitted(TERMINAL_EVENTS.sessionsChanged)).toHaveLength(before + 1)
  })

  it('输出照旧下发(台账的引入不能改变数据通路)', async () => {
    const h = await harness()
    await h.attach(7)
    h.ptys[0]!.onDataCb?.('hello')
    settle()
    expect(h.emitted(TERMINAL_EVENTS.data)).toEqual([{ tabId: 7, chunk: 'hello' }])
    expect((await h.invoke<SessionInfo[]>('listSessions'))[0]!.lastOutputAt).toBe(T0)
  })

  it('代理状态进台账,并报给内核(角标/通知那条路)', async () => {
    const h = await harness()
    await h.attach(7)
    const osc = `\x1b]1337;bow;${JSON.stringify({ v: 1, state: 'blocked', title: '要确认', text: 'π - bow' })}\x07`
    h.ptys[0]!.onDataCb?.(osc)
    settle()

    const info = (await h.invoke<SessionInfo[]>('listSessions'))[0]!
    expect(info.agent).toMatchObject({ state: 'blocked', title: '要确认', text: 'π - bow', at: T0 })
    expect(h.agentReports.at(-1)).toMatchObject({ tabId: 7, state: 'blocked' })
    // 私有序列不许漏进终端数据
    expect(h.emitted(TERMINAL_EVENTS.data)).toEqual([])
  })

  it('shell 退出后从台账里消失', async () => {
    const h = await harness()
    await h.attach(7)
    settle()
    const before = h.emitted(TERMINAL_EVENTS.sessionsChanged).length
    h.ptys[0]!.onExitCb?.({ exitCode: 0 })
    settle()
    expect(await h.invoke<SessionInfo[]>('listSessions')).toEqual([])
    // 空台账必须真的发出去:哨兵值不能跟「空台账的指纹」撞在一起(否则面板会留着幽灵条目)
    expect(h.emitted(TERMINAL_EVENTS.sessionsChanged)).toHaveLength(before + 1)
    expect(h.emitted(TERMINAL_EVENTS.sessionsChanged).at(-1)).toEqual([])
  })
})

// ---------- 会话操作 ----------

describe('会话操作(本地面板 / 远程 / MCP 共用的那一批)', () => {
  it('readTail 只给尾部,未知会话给错误而不是空串', async () => {
    const h = await harness()
    await h.attach(7)
    h.ptys[0]!.onDataCb?.('abcdefghij')

    expect(await h.invoke<{ ok: boolean; text?: string }>('readTail', 7, 4)).toEqual({ ok: true, text: 'ghij' })
    expect(await h.invoke<{ ok: boolean; text?: string }>('readTail', 7, 99)).toEqual({ ok: true, text: 'abcdefghij' })
    expect(await h.invoke<{ ok: boolean; error?: string }>('readTail', 999)).toMatchObject({ ok: false })
  })

  it('sendText 真的写进 pty;未知会话返回 false', async () => {
    const h = await harness()
    await h.attach(7)
    expect(await h.invoke<boolean>('sendText', 7, 'echo hi\r')).toBe(true)
    expect(h.ptys[0]!.written).toEqual(['echo hi\r'])
    expect(await h.invoke<boolean>('sendText', 999, 'x')).toBe(false)
    expect(await h.invoke<boolean>('sendText', 7, 42)).toBe(false)
  })

  it('focusSession 走内核 activate(后台标签/其它窗格也能跳过去),不是 focus', async () => {
    const h = await harness()
    await h.attach(7)
    expect(await h.invoke<boolean>('focusSession', 7)).toBe(true)
    expect(h.activated).toEqual([7])
    expect(await h.invoke<boolean>('focusSession', 999)).toBe(false)
    expect(h.activated).toEqual([7])
  })

  it('closeSession 杀掉进程并把它移出台账', async () => {
    const h = await harness()
    await h.attach(7)
    settle()
    const before = h.emitted(TERMINAL_EVENTS.sessionsChanged).length
    expect(await h.invoke<boolean>('closeSession', 7)).toBe(true)
    expect(h.ptys[0]!.killed).toBe(true)
    expect(await h.invoke<SessionInfo[]>('listSessions')).toEqual([])
    settle()
    expect(h.emitted(TERMINAL_EVENTS.sessionsChanged)).toHaveLength(before + 1)
    expect(h.emitted(TERMINAL_EVENTS.sessionsChanged).at(-1)).toEqual([])
    expect(await h.invoke<boolean>('closeSession', 7)).toBe(false)
  })

  it('createSession 不带命令:只开一个终端标签,不发 terminal:run', async () => {
    const h = await harness()
    expect(await h.invoke('createSession', {})).toEqual({ ok: true, tabId: 101 })
    expect(h.opened).toEqual(['terminal'])
    expect(h.runRequests).toEqual([])
    // 不带命令时 cwd 被忽略(v1 不扩展 TerminalRunRequest,见 createSession 的注释)
    expect(await h.invoke('createSession', { cwd: '/tmp/p' })).toEqual({ ok: true, tabId: 101 })
    expect(h.runRequests).toEqual([])
  })

  it('createSession 带命令:发 terminal:run,并带上 cwd / name', async () => {
    const h = await harness()
    await h.invoke('createSession', { command: 'pi', args: ['--print'], cwd: '/tmp/p', name: 'pi(print)' })
    expect(h.runRequests).toEqual([
      { tabId: 101, file: 'pi', args: ['--print'], cwd: '/tmp/p', name: 'pi(print)' }
    ])
  })

  it('createSession 的非法 args 被拒,且不产生 terminal:run', async () => {
    const h = await harness()
    expect(await h.invoke<{ ok: boolean }>('createSession', { command: 'pi', args: [1] })).toMatchObject({ ok: false })
    expect(await h.invoke<{ ok: boolean }>('createSession', { command: 'pi', args: 'x' })).toMatchObject({ ok: false })
    expect(h.runRequests).toEqual([])
  })

  it('deactivate 后不再广播(合并定时器要清干净)', async () => {
    const h = await harness()
    await h.attach(7)
    settle()
    const before = h.emitted(TERMINAL_EVENTS.sessionsChanged).length

    await h.plugin.deactivate?.(h.ctx)
    vi.advanceTimersByTime(SESSION_ACTIVITY_BUCKET_MS * 2)
    expect(h.emitted(TERMINAL_EVENTS.sessionsChanged)).toHaveLength(before)
  })
})

// ---------- MCP 工具 ----------

describe('MCP 工具(一个 pi 管它的同类)', () => {
  /** MCP 返回体:content[0].text 里是 JSON */
  const payloadOf = (result: unknown) => JSON.parse((result as { content: [{ text: string }] }).content[0].text)

  it('注册了五个工具,名字都带 terminal_ 前缀', async () => {
    const h = await harness()
    expect(h.toolNames.sort()).toEqual([
      'terminal_close',
      'terminal_list_sessions',
      'terminal_read',
      'terminal_run',
      'terminal_send'
    ])
  })

  it('terminal_list_sessions 给的与面板读的是同一份台账', async () => {
    const h = await harness()
    await h.attach(7)
    const body = payloadOf(await h.tools.get('terminal_list_sessions')!({}))
    expect(body.ok).toBe(true)
    expect(body.sessions).toHaveLength(1)
    expect((await h.invoke<SessionInfo[]>('listSessions'))[0]!.id).toBe(body.sessions[0].id)
  })

  it('terminal_read 读尾部;未知会话给 isError 而不是空文本', async () => {
    const h = await harness()
    await h.attach(7)
    h.ptys[0]!.onDataCb?.('hello world')
    expect(payloadOf(await h.tools.get('terminal_read')!({ id: 7, chars: 5 })).text).toBe('world')
    const missing = await h.tools.get('terminal_read')!({ id: 999 })
    expect((missing as { isError?: boolean }).isError).toBe(true)
  })

  it('terminal_send 原样写入(不自动补回车),未知会话报错', async () => {
    const h = await harness()
    await h.attach(7)
    h.tools.get('terminal_send')!({ id: 7, text: 'ls' })
    h.tools.get('terminal_send')!({ id: 7, text: '\r' })
    expect(h.ptys[0]!.written).toEqual(['ls', '\r'])
    expect((h.tools.get('terminal_send')!({ id: 999, text: 'x' }) as { isError?: boolean }).isError).toBe(true)
  })

  it('terminal_run 走 createSession(带 cwd/name 时发 terminal:run);没结论时回 starting,不谎报 running', async () => {
    vi.useRealTimers() // waitForRun 靠 setTimeout 推进,假时钟会把它冻死
    const h = await harness()
    const body = payloadOf(
      await h.tools.get('terminal_run')!({ command: 'pi', args: ['--print'], cwd: '/tmp/p', name: 'pi' })
    )
    expect(body).toMatchObject({ ok: true, id: 101, state: 'starting' })
    expect(h.runRequests).toEqual([{ tabId: 101, file: 'pi', args: ['--print'], cwd: '/tmp/p', name: 'pi' }])
    expect(String(body.note)).toContain('仍在启动')
  })

  it('terminal_run:pty 真的起来时回 state=running', async () => {
    vi.useRealTimers() // waitForRun 靠 setTimeout 推进,假时钟会把它冻死
    const h = await harness()
    // 工具的等待与 attach 并存:先让它开始等,再触发 attach(真实时序:终端页加载 → attach → spawn)
    const pending = h.tools.get('terminal_run')!({ command: 'node.exe', name: 'node' })
    await h.attach(101)
    expect(payloadOf(await pending)).toMatchObject({ ok: true, id: 101, state: 'running' })
  })

  it('terminal_run:spawn 失败时如实报 failed(不能拿「标签开好了」当成功)', async () => {
    vi.useRealTimers() // waitForRun 靠 setTimeout 推进,假时钟会把它冻死
    const h = await harness()
    h.failNextSpawn()
    const pending = h.tools.get('terminal_run')!({ command: 'node.exe', name: 'node' })
    await h.attach(101)
    const result = await pending
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(payloadOf(result)).toMatchObject({ ok: false })
    expect(String(payloadOf(result).error)).toContain('命令没起来')
  })

  it('terminal_close 真杀进程;未知会话报错', async () => {
    const h = await harness()
    await h.attach(7)
    expect(payloadOf(await h.tools.get('terminal_close')!({ id: 7 }))).toEqual({ ok: true, id: 7 })
    expect(h.ptys[0]!.killed).toBe(true)
    expect(
      ((await h.tools.get('terminal_close')!({ id: 7 })) as { isError?: boolean }).isError
    ).toBe(true)
  })
})

// ---------- Windows 裸命令补全 ----------

describe('withWindowsExeSuffix', () => {
  it('Windows:裸名补 .exe,带路径或已带扩展名的一律不动', () => {
    expect(withWindowsExeSuffix('node', 'win32')).toBe('node.exe')
    expect(withWindowsExeSuffix('cmd', 'win32')).toBe('cmd.exe')
    expect(withWindowsExeSuffix('  node  ', 'win32')).toBe('node.exe')
    expect(withWindowsExeSuffix('node.exe', 'win32')).toBe('node.exe')
    expect(withWindowsExeSuffix('wsl.exe', 'win32')).toBe('wsl.exe')
    expect(withWindowsExeSuffix('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(
      'C:\\Program Files\\nodejs\\node.exe'
    )
    expect(withWindowsExeSuffix('..\\bin\\pi', 'win32')).toBe('..\\bin\\pi')
    expect(withWindowsExeSuffix('/usr/bin/node', 'win32')).toBe('/usr/bin/node')
  })

  it('非 Windows 平台原样返回', () => {
    expect(withWindowsExeSuffix('node', 'linux')).toBe('node')
    expect(withWindowsExeSuffix('', 'win32')).toBe('')
  })
})

// ---------- 面板要用的展示函数 ----------

describe('面板展示(排序 / 时间 / 路径)', () => {
  const info = (over: Partial<SessionInfo> & { id: number }): SessionInfo => ({
    title: `t${over.id}`,
    profileId: 'bash',
    cwd: '/tmp',
    pid: 1,
    cols: 80,
    rows: 24,
    createdAt: T0,
    lastOutputAt: null,
    agent: null,
    ...over
  })

  it('排序:等用户的 → 在跑的 → 刚跑完的 → 空着的 → 没代理的', () => {
    const blocked = info({ id: 5, agent: { state: 'blocked', at: T0 } })
    const working = info({ id: 4, agent: { state: 'working', at: T0 } })
    const done = info({ id: 3, agent: { state: 'idle', done: true, at: T0 } })
    const idle = info({ id: 2, agent: { state: 'idle', at: T0 } })
    const plain = info({ id: 1 })
    expect([plain, idle, done, working, blocked].map(attentionRank)).toEqual([4, 3, 2, 1, 0])
    expect(sortSessionsByAttention([plain, idle, done, working, blocked]).map((s) => s.id)).toEqual([5, 4, 3, 2, 1])
  })

  it('同级按「最后活跃」新→旧;完全一样时按 id,保证排序稳定', () => {
    const older = info({ id: 9, lastOutputAt: T0 })
    const newer = info({ id: 8, lastOutputAt: T0 + 60_000 })
    expect(sortSessionsByAttention([older, newer]).map((s) => s.id)).toEqual([8, 9])
    expect(sortSessionsByAttention([info({ id: 21 }), info({ id: 20 })]).map((s) => s.id)).toEqual([20, 21])
    // 代理状态的时刻优先于 pty 输出(代理在跑但输出安静时不该假陈旧)
    const agentOlder = info({ id: 1, lastOutputAt: T0 + 999_999, agent: { state: 'working', at: T0 } })
    const agentNewer = info({ id: 2, lastOutputAt: T0, agent: { state: 'working', at: T0 + 1000 } })
    expect(sortSessionsByAttention([agentOlder, agentNewer]).map((s) => s.id)).toEqual([2, 1])
  })

  it('formatAgo:只到「天」粒度,负值与极短一律「刚刚」', () => {
    expect(formatAgo(-5000)).toBe('刚刚')
    expect(formatAgo(0)).toBe('刚刚')
    expect(formatAgo(4999)).toBe('刚刚')
    expect(formatAgo(5000)).toBe('5 秒前')
    expect(formatAgo(59_999)).toBe('59 秒前')
    expect(formatAgo(60_000)).toBe('1 分钟前')
    expect(formatAgo(3_599_999)).toBe('59 分钟前')
    expect(formatAgo(3_600_000)).toBe('1 小时前')
    expect(formatAgo(86_400_000 * 3 + 5)).toBe('3 天前')
  })

  it('shortPath:够短就不动,太长只留尾部且至少留一段;反斜杠路径不被改成正斜杠', () => {
    expect(shortPath('/home/u/p')).toBe('/home/u/p')
    expect(shortPath('  ')).toBe('')
    expect(shortPath('/home/u/very/deep/nested/project-abc', 20)).toBe('…/nested/project-abc')
    // 能装下的层数尽量装:20 字符刚好装下 `very\deep\project`(16),再加一层就超了
    expect(shortPath('C:\\Users\\ruinb\\very\\deep\\project', 20)).toBe('…\\very\\deep\\project')
    // 单个目录名就超长时不能缩成「…/」
    expect(shortPath(`C:\\${'x'.repeat(60)}`, 20)).toBe(`…\\${'x'.repeat(60)}`)
  })
})
