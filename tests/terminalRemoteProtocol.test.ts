/**
 * 远程 WS 协议(S7):上行消息校验 + 真 WS 往返。
 *
 * 后者是这一层唯一能证伪「协议接对了」的东西 —— 所以用一个真的 `ws` 客户端连真的服务:
 * 未登录握手被拒 → 登录拿 cookie → hello 带台账 → attach 拿回放 → input 的字节经 pty
 * 回调回来 → create/close 的回执与事件顺序。
 *
 * 会话本体用假实现(不碰 pty):这里验的是**传输与协议**,pty 那半由 terminalSessions 覆盖。
 */

import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { parseClientMessage, MAX_INPUT_CHARS } from '../src/plugins/terminal/remote/protocol'
import type { RemoteSessionApi, ServerMessage } from '../src/plugins/terminal/remote/protocol'
import { SessionHub } from '../src/plugins/terminal/remote/hub'
import { RemoteAuth } from '../src/plugins/terminal/remote/auth'
import { REMOTE_WS_PATH, startRemoteServer } from '../src/plugins/terminal/remote/server'
import type { SessionInfo } from '../src/plugins/terminal/shared'
import { localRequest } from './localHttp'

const PASSWORD = 'test-password-123'

const session = (id: number): SessionInfo => ({
  id,
  title: `t${id}`,
  profileId: 'bash',
  cwd: '/tmp',
  pid: 1,
  cols: 80,
  rows: 24,
  createdAt: 0,
  lastOutputAt: null,
  agent: null
})

/**
 * 假会话 API:记录调用、按需回放;create 返回固定 id。
 *
 * `close` 成功后把 `closed` 事件发到 hub —— 真插件就是这么做的(`killSession` 里 publish),
 * 所以服务端**不**自己再发一份(否则客户端会收到两条)。
 */
function fakeSessions(hub?: SessionHub) {
  const calls: string[] = []
  const live = new Map<number, SessionInfo>()
  const api: RemoteSessionApi = {
    list: () => [...live.values()],
    attach: (id, cols, rows) => {
      calls.push(`attach:${id}:${cols}x${rows}`)
      if (!live.has(id)) return { ok: false, error: '会话不存在(可能已被关闭)' }
      return { ok: true, replay: `REPLAY-${id}`, cols, rows, title: `t${id}` }
    },
    input: (id, data) => {
      calls.push(`input:${id}:${data}`)
      return live.has(id)
    },
    resize: (id, cols, rows) => {
      calls.push(`resize:${id}:${cols}x${rows}`)
      return live.has(id)
    },
    readTail: (id, chars) => {
      calls.push(`read:${id}:${chars ?? '-'}`)
      return live.has(id) ? { ok: true, text: `TAIL-${id}` } : { ok: false, error: '会话不存在' }
    },
    create: (input) => {
      calls.push(`create:${input.command}`)
      const id = 900 + live.size
      live.set(id, session(id))
      return { ok: true, id, state: 'starting' }
    },
    close: (id) => {
      calls.push(`close:${id}`)
      const existed = live.delete(id)
      if (existed) hub?.publish({ t: 'closed', id, reason: 'closed-by-request' })
      return existed
    },
    controlToken: (id) => (live.has(id) ? `token-${id}` : null)
  }
  return { api, calls, live }
}

describe('parseClientMessage', () => {
  it('list / detach / close:id 必须是正整数', () => {
    expect(parseClientMessage({ t: 'list' })).toEqual({ ok: true, message: { t: 'list' } })
    expect(parseClientMessage({ t: 'close', id: 3 })).toEqual({ ok: true, message: { t: 'close', id: 3 } })
    expect(parseClientMessage({ t: 'close', id: -1 }).ok).toBe(false)
    expect(parseClientMessage({ t: 'close', id: 1.5 }).ok).toBe(false)
    expect(parseClientMessage({ t: 'close' }).ok).toBe(false)
  })

  it('attach / resize:尺寸夹进范围,缺字段直接拒', () => {
    expect(parseClientMessage({ t: 'attach', id: 1, cols: 120, rows: 40 })).toEqual({
      ok: true,
      message: { t: 'attach', id: 1, cols: 120, rows: 40 }
    })
    // 越界夹取(手机上报 0 或超大值不该打崩 pty)
    const clamped = parseClientMessage({ t: 'resize', id: 1, cols: 0, rows: 9999 })
    expect(clamped).toEqual({ ok: true, message: { t: 'resize', id: 1, cols: 2, rows: 300 } })
    expect(parseClientMessage({ t: 'attach', id: 1 }).ok).toBe(false)
  })

  it('input:必须是字符串且有上限', () => {
    expect(parseClientMessage({ t: 'input', id: 1, data: 'ls\r' })).toEqual({
      ok: true,
      message: { t: 'input', id: 1, data: 'ls\r' }
    })
    expect(parseClientMessage({ t: 'input', id: 1, data: 42 }).ok).toBe(false)
    expect(parseClientMessage({ t: 'input', id: 1, data: 'x'.repeat(MAX_INPUT_CHARS + 1) }).ok).toBe(false)
  })

  it('read:chars 可省、越界夹取', () => {
    expect(parseClientMessage({ t: 'read', id: 1 })).toEqual({ ok: true, message: { t: 'read', id: 1 } })
    expect(parseClientMessage({ t: 'read', id: 1, chars: 10 })).toEqual({
      ok: true,
      message: { t: 'read', id: 1, chars: 10 }
    })
    expect(parseClientMessage({ t: 'read', id: 1, chars: 999_999 })).toMatchObject({
      ok: true,
      message: { chars: 200_000 }
    })
    expect(parseClientMessage({ t: 'read', id: 1, chars: 'abc' }).ok).toBe(false)
  })

  it('create:command 可省(= 默认 shell),args 必须是字符串数组,cwd/name 去空', () => {
    // 手机在空列表时要能自己开一个默认 shell:不传 command 就是那个意思
    expect(parseClientMessage({ t: 'create' })).toEqual({ ok: true, message: { t: 'create', args: [] } })
    expect(parseClientMessage({ t: 'create', command: 'pi' })).toEqual({
      ok: true,
      message: { t: 'create', command: 'pi', args: [] }
    })
    expect(parseClientMessage({ t: 'create', command: ' pi ', args: ['--x'], cwd: ' ', name: 'n' })).toEqual({
      ok: true,
      message: { t: 'create', command: 'pi', args: ['--x'], name: 'n' }
    })
    expect(parseClientMessage({ t: 'create', command: '   ' }).ok).toBe(false) // 空串是错,省略才是默认
    expect(parseClientMessage({ t: 'create', command: 'pi', args: [1] }).ok).toBe(false)
    // 手机新建 pi 到某个目录:这是那条路径唯一的载体,cwd 必须原样过去(只去两端空白)
    expect(parseClientMessage({ t: 'create', command: 'pi', cwd: ' /home/u/proj ' })).toEqual({
      ok: true,
      message: { t: 'create', command: 'pi', args: [], cwd: '/home/u/proj' }
    })
  })

  it('非法输入一律 {ok:false} 且带原因(客户端据此回 error,不猜)', () => {
    for (const bad of [null, undefined, 42, 'x', [], { t: 'nope' }, { t: '' }]) {
      const result = parseClientMessage(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(typeof result.error).toBe('string')
    }
  })
})

describe('WS 往返(真 ws 客户端 → 真服务)', () => {
  /** 连一个 WS,收集消息;返回 {ws, next(predicate)} */
  async function connect(
    url: string,
    headers: Record<string, string> = {}
  ): Promise<{ ws: WebSocket; next: (match: (m: ServerMessage) => boolean) => Promise<ServerMessage>; close: () => void }> {
    const ws = new WebSocket(url, { headers })
    const queue: ServerMessage[] = []
    const waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage
      const i = waiters.findIndex((w) => w.match(msg))
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg)
      else queue.push(msg)
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return {
      ws,
      next: (match) => {
        const i = queue.findIndex(match)
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('等消息超时')), 5000)
          waiters.push({
            match,
            resolve: (m) => {
              clearTimeout(timer)
              resolve(m)
            }
          })
        })
      },
      close: () => ws.close()
    }
  }

  async function boot() {
    const hub = new SessionHub()
    const sessions = fakeSessions(hub)
    const auth = new RemoteAuth({ password: PASSWORD, key: Buffer.alloc(32, 3) })
    const server = await startRemoteServer({
      port: 0,
      bind: 'loopback',
      hub,
      auth,
      sessions: sessions.api,
      listAddresses: () => []
    })
    const login = await localRequest(`${server.url}/login`, {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD })
    })
    const cookie = String(login.headers['set-cookie'] ?? '')
    return { hub, server, sessions, cookie, url: server.url, wsUrl: server.wsUrl }
  }

  it('未登录 / 跨站 Origin 的握手被拒;带 cookie 能连上并收到 hello', async () => {
    const { server, cookie, wsUrl } = await boot()
    try {
      await expect(connect(wsUrl)).rejects.toBeTruthy() // 没 cookie
      await expect(connect(wsUrl, { cookie, origin: 'http://evil.example' })).rejects.toBeTruthy()

      const client = await connect(wsUrl, { cookie })
      const hello = await client.next((m) => m.t === 'hello')
      expect(hello).toMatchObject({ t: 'hello', service: 'bow-terminal-remote', sessions: [] })
      client.close()
    } finally {
      await server.close()
    }
  })

  it('attach 返回回放与尺寸;input/read/create/close 走到会话 API;hub 的 data 会转发', async () => {
    const { server, cookie, wsUrl, sessions, hub } = await boot()
    try {
      const client = await connect(wsUrl, { cookie })
      await client.next((m) => m.t === 'hello')

      // create → created(并把会话放进假台账)
      client.ws.send(JSON.stringify({ t: 'create', command: 'pi' }))
      const created = await client.next((m) => m.t === 'created')
      expect(created).toMatchObject({ t: 'created', state: 'starting' })
      const id = (created as { id: number }).id

      client.ws.send(JSON.stringify({ t: 'attach', id, cols: 100, rows: 30 }))
      expect(await client.next((m) => m.t === 'attached')).toMatchObject({
        t: 'attached',
        id,
        replay: `REPLAY-${id}`,
        cols: 100,
        rows: 30
      })

      client.ws.send(JSON.stringify({ t: 'input', id, data: 'echo hi\r' }))
      client.ws.send(JSON.stringify({ t: 'read', id, chars: 50 }))
      expect(await client.next((m) => m.t === 'read')).toMatchObject({ t: 'read', id, text: `TAIL-${id}` })

      // hub 的输出会原样转给客户端
      hub.publish({ t: 'data', id, chunk: 'hello' })
      expect(await client.next((m) => m.t === 'data')).toMatchObject({ t: 'data', id, chunk: 'hello' })

      // 台账变化也走同一条连接
      hub.publish({ t: 'sessions', sessions: [session(id)] })
      expect(await client.next((m) => m.t === 'sessions')).toMatchObject({ t: 'sessions' })

      client.ws.send(JSON.stringify({ t: 'close', id }))
      expect(await client.next((m) => m.t === 'closed')).toMatchObject({ t: 'closed', id, reason: 'closed-by-request' })

      expect(sessions.calls).toEqual([
        'create:pi',
        `attach:${id}:100x30`,
        `input:${id}:echo hi\r`,
        `read:${id}:50`,
        `close:${id}`
      ])
      client.close()
    } finally {
      await server.close()
    }
  })

  it('坏消息回 error,不掐连接;未知会话的 attach 也回 error', async () => {
    const { server, cookie, wsUrl } = await boot()
    try {
      const client = await connect(wsUrl, { cookie })
      await client.next((m) => m.t === 'hello')

      client.ws.send('不是 JSON')
      expect(await client.next((m) => m.t === 'error')).toMatchObject({ t: 'error' })

      client.ws.send(JSON.stringify({ t: 'attach', id: 1 }))
      expect((await client.next((m) => m.t === 'error'))).toMatchObject({ t: 'error' })

      client.ws.send(JSON.stringify({ t: 'attach', id: 4242, cols: 80, rows: 24 }))
      expect((await client.next((m) => m.t === 'error'))).toMatchObject({
        t: 'error',
        message: '会话不存在(可能已被关闭)'
      })

      // 连接还活着
      client.ws.send(JSON.stringify({ t: 'list' }))
      expect(await client.next((m) => m.t === 'sessions')).toMatchObject({ t: 'sessions', sessions: [] })
      client.close()
    } finally {
      await server.close()
    }
  })

  it('服务关闭时通知客户端(1001),客户端不再收到 hub 事件', async () => {
    const { server, cookie, wsUrl, hub } = await boot()
    const client = await connect(wsUrl, { cookie })
    await client.next((m) => m.t === 'hello')

    const closedWith = new Promise<number>((resolve) => client.ws.once('close', (code) => resolve(code)))
    await server.close()
    expect(await closedWith).toBe(1001)
    // hub 里也不该再留着这个订阅
    expect(hub.size).toBe(0)
  })

  it('WS 路径不对:握手阶段就拒(不会升级成 WS)', async () => {
    const { server, cookie } = await boot()
    try {
      const url = server.wsUrl.replace(REMOTE_WS_PATH, '/nope')
      await expect(connect(url, { cookie })).rejects.toBeTruthy()
    } finally {
      await server.close()
    }
  })
})
