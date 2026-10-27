/**
 * 对话桥(S13):pi 的结构化对话 → 手机,手机的话 → pi。
 *
 * 两层:
 * ① `PiChatHub` —— 纯逻辑:校验 / 缓存 / 合并工具行 / 慢消费者跳过 / 路由;
 * ② 真 ws 往返 —— pi 端用**会话控制令牌**连(不吃 cookie)、手机端用 cookie 连,
 *    验的是「握手两条闸」与「谁收到什么」。
 */

import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  CHAT_MAX_BUFFERED,
  MAX_CHAT_COMMANDS,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_TEXT,
  PiChatHub,
  sanitizeChatMessage,
  sanitizeCommands,
  sanitizeStatus
} from '../src/plugins/terminal/remote/piChat'
import type { AskRequest, ChatMessage, ChatSink } from '../src/plugins/terminal/remote/piChat'
import { SessionHub } from '../src/plugins/terminal/remote/hub'
import { RemoteAuth } from '../src/plugins/terminal/remote/auth'
import { startRemoteServer } from '../src/plugins/terminal/remote/server'
import { parseClientMessage } from '../src/plugins/terminal/remote/protocol'
import type { RemoteSessionApi } from '../src/plugins/terminal/remote/protocol'
import type { SessionInfo } from '../src/plugins/terminal/shared'
import { KEYBOARD_OPEN_MIN_PX, keyboardInsetOf, keyboardInsetToDeduct } from '../src/renderer/remote/keyboardInset'
import { localRequest } from './localHttp'

const PASSWORD = 'test-password-123'
const TOKEN = 'token-for-session-1'

function fakeSink(buffered = 0) {
  const messages: unknown[] = []
  const drops: string[] = []
  const sink: ChatSink = {
    send: (m) => messages.push(m),
    buffered: () => buffered,
    drop: (reason) => drops.push(reason)
  }
  return { sink, messages, drops, types: () => messages.map((m) => (m as { t?: string }).t) }
}

const msg = (id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  ...extra
})

describe('sanitizeChatMessage', () => {
  it('只认四种角色,id 必须有', () => {
    expect(sanitizeChatMessage({ id: 'a', role: 'user', text: 'hi' })).toEqual({ id: 'a', role: 'user', text: 'hi' })
    expect(sanitizeChatMessage({ id: 'a', role: 'system', text: 'x' })).toBeNull()
    expect(sanitizeChatMessage({ role: 'user', text: 'x' })).toBeNull()
    expect(sanitizeChatMessage(null)).toBeNull()
    expect(sanitizeChatMessage('x')).toBeNull()
  })

  it('超长正文截断,空值不落字段', () => {
    const long = sanitizeChatMessage({ id: 'a', role: 'assistant', text: 'x'.repeat(MAX_CHAT_TEXT + 50) })
    expect(long?.text?.length).toBe(MAX_CHAT_TEXT + 1) // 截断 + 省略号
    expect(long?.text?.endsWith('…')).toBe(true)
    expect(sanitizeChatMessage({ id: 'a', role: 'user', text: '' })).toEqual({ id: 'a', role: 'user' })
    expect(sanitizeChatMessage({ id: 'a', role: 'tool', toolError: 'yes' })).toEqual({ id: 'a', role: 'tool' })
  })
})

describe('PiChatHub', () => {
  it('快照缓存:没有 pi 端也能回空快照并标 live=false', () => {
    const hub = new PiChatHub()
    expect(hub.snapshot(7)).toEqual({ id: 7, live: false, messages: [], busy: false, pending: 0, asks: [], commands: [] })
  })

  it('pi 连上/断开改 live,并广播 chat-state', () => {
    const hub = new PiChatHub()
    const viewer = fakeSink()
    hub.attachViewer(viewer.sink)

    const detach = hub.attachPi(1, fakeSink().sink)
    expect(hub.snapshot(1).live).toBe(true)
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'chat-state', id: 1, live: true })

    detach()
    expect(hub.snapshot(1).live).toBe(false)
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'chat-state', id: 1, live: false })
  })

  it('snapshot 替换历史,message 追加,state 更新忙/排队', () => {
    const hub = new PiChatHub()
    const viewer = fakeSink()
    hub.attachViewer(viewer.sink)
    hub.attachPi(1, fakeSink().sink)

    hub.fromPi(1, { type: 'snapshot', messages: [msg('u1', 'user', { text: '早' })], busy: true, pending: 1 })
    const chat = viewer.messages.at(-1) as { t: string; messages: ChatMessage[]; busy: boolean }
    expect(chat.t).toBe('chat')
    expect(chat.messages).toHaveLength(1)
    expect(chat.busy).toBe(true)

    hub.fromPi(1, { type: 'message', message: msg('a1', 'assistant', { text: '在' }) })
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'chat-message', message: { id: 'a1' } })

    hub.fromPi(1, { type: 'state', busy: false, pending: 0 })
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'chat-state', id: 1, busy: false, pending: 0 })
  })

  it('工具调用与它的结果合并成一行(同一个 toolCallId)', () => {
    const hub = new PiChatHub()
    const viewer = fakeSink()
    hub.attachViewer(viewer.sink)
    hub.attachPi(1, fakeSink().sink)

    hub.fromPi(1, { type: 'message', message: msg('call-1', 'tool', { toolName: 'bash', toolArgs: '{"cmd":"ls"}' }) })
    hub.fromPi(1, {
      type: 'message',
      message: msg('call-1', 'tool', { toolName: 'bash', toolResult: 'a.ts b.ts' })
    })

    const messages = hub.snapshot(1).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({ id: 'call-1', role: 'tool', toolName: 'bash', toolArgs: '{"cmd":"ls"}', toolResult: 'a.ts b.ts' })
  })

  it('历史上限:只留最近 MAX_CHAT_MESSAGES 条', () => {
    const hub = new PiChatHub()
    hub.attachPi(1, fakeSink().sink)
    for (let i = 0; i < MAX_CHAT_MESSAGES + 10; i += 1) {
      hub.fromPi(1, { type: 'message', message: msg(`m${i}`, 'user', { text: String(i) }) })
    }
    const messages = hub.snapshot(1).messages
    expect(messages).toHaveLength(MAX_CHAT_MESSAGES)
    expect(messages.at(-1)?.id).toBe(`m${MAX_CHAT_MESSAGES + 9}`)
  })

  it('没登记的 pi 连接不能往缓存里写', () => {
    const hub = new PiChatHub()
    hub.fromPi(9, { type: 'message', message: msg('x', 'user', { text: '偷偷写' }) })
    expect(hub.snapshot(9).messages).toHaveLength(0)
  })

  it('慢消费者跳过这一条(不断开),消息内容不变', () => {
    const hub = new PiChatHub()
    const fast = fakeSink()
    const slow = fakeSink(CHAT_MAX_BUFFERED + 1)
    hub.attachViewer(fast.sink)
    hub.attachViewer(slow.sink)
    hub.attachPi(1, fakeSink().sink)

    hub.fromPi(1, { type: 'message', message: msg('a', 'user', { text: 'x' }) })
    expect(fast.messages.some((m) => (m as { t: string }).t === 'chat-message')).toBe(true)
    expect(slow.messages.some((m) => (m as { t: string }).t === 'chat-message')).toBe(false)
    expect(slow.drops).toHaveLength(0)
  })

  it('prompt / abort 路由到对应会话;没有控制通道时如实报错', () => {
    const hub = new PiChatHub()
    const pi = fakeSink()
    hub.attachPi(1, pi.sink)

    expect(hub.prompt(1, '跑测试', 'followUp')).toEqual({ ok: true })
    expect(pi.messages.at(-1)).toEqual({ type: 'prompt', text: '跑测试', deliverAs: 'followUp' })

    expect(hub.prompt(2, '谁在吗')).toMatchObject({ ok: false })
    expect(hub.abort(1)).toBe(true)
    expect(pi.messages.at(-1)).toEqual({ type: 'abort' })
    expect(hub.abort(2)).toBe(false)
  })

  it('clear 断开所有连接但保留缓存(重新启用后还能看到上次对话)', () => {
    const hub = new PiChatHub()
    const viewer = fakeSink()
    hub.attachViewer(viewer.sink)
    const pi = fakeSink()
    hub.attachPi(1, pi.sink)
    hub.fromPi(1, { type: 'message', message: msg('a', 'user', { text: '留下' }) })

    hub.clear()
    expect(hub.viewerCount).toBe(0)
    expect(pi.drops).toHaveLength(1)
    expect(hub.snapshot(1).messages).toHaveLength(1)
  })
})

describe('状态条(模型 / 上下文 / 输入输出)', () => {
  it('坏输入被拒;数字夹到非负整数,文本截断', () => {
    expect(sanitizeStatus(null)).toBeNull()
    expect(sanitizeStatus('x')).toBeNull()
    expect(
      sanitizeStatus({ model: 'm'.repeat(80), input: -5, output: 12.6, contextTokens: null, contextWindow: 200000 })
    ).toEqual({
      model: `${'m'.repeat(60)}…`,
      input: 0,
      output: 13,
      cacheRead: 0,
      cacheWrite: 0,
      contextTokens: null,
      contextWindow: 200000
    })
    // 没有 contextWindow 也留着:手机只显示 token 数,不显示百分比
    expect(sanitizeStatus({ input: 7 })).toMatchObject({ input: 7, contextWindow: 0, contextTokens: null })
  })

  it('status 广播给手机,并进快照(手机重连后立刻有数)', () => {
    const hub = new PiChatHub()
    const viewer = fakeSink()
    hub.attachViewer(viewer.sink)
    hub.attachPi(1, fakeSink().sink)

    const status = {
      model: 'claude-sonnet-4',
      input: 12000,
      output: 3400,
      cacheRead: 0,
      cacheWrite: 0,
      contextTokens: 76400,
      contextWindow: 200000
    }
    hub.fromPi(1, { type: 'status', status })
    expect(viewer.messages.at(-1)).toEqual({ t: 'chat-status', id: 1, status })
    expect(hub.snapshot(1).status).toEqual(status)

    // 坏帧不发,也不覆盖上一份好数据
    hub.fromPi(1, { type: 'status', status: 'nope' })
    expect(viewer.messages.at(-1)).toEqual({ t: 'chat-status', id: 1, status })
    expect(hub.snapshot(1).status).toEqual(status)
  })

  it('snapshot 帧里的 status 一起落进缓存(连同消息)', () => {
    const hub = new PiChatHub()
    hub.attachPi(1, fakeSink().sink)
    hub.fromPi(1, {
      type: 'snapshot',
      messages: [msg('a', 'user', { text: 'hi' })],
      status: { model: 'gpt-5', input: 1, output: 2, contextTokens: null, contextWindow: 100000 }
    })
    expect(hub.snapshot(1)).toMatchObject({
      messages: [{ id: 'a', role: 'user', text: 'hi' }],
      status: { model: 'gpt-5', contextWindow: 100000, contextTokens: null }
    })
  })
})

describe('命令补全(pi 的 getCommands → 手机)', () => {
  it('坏输入被拒;名字去重、超长截断、条数封顶', () => {
    expect(sanitizeCommands(null)).toEqual([])
    expect(sanitizeCommands([{ name: '' }, { nope: 1 }, 'x', null])).toEqual([])
    expect(
      sanitizeCommands([
        { name: 'bow', description: 'd'.repeat(200), source: 'extension' },
        { name: 'bow', description: '重复的应该被丢掉' },
        { name: ' skill:x ', description: '  ' }
      ])
    ).toEqual([
      { name: 'bow', description: `${'d'.repeat(120)}…`, source: 'extension' },
      { name: 'skill:x' }
    ])
    const many = Array.from({ length: MAX_CHAT_COMMANDS + 5 }, (_, i) => ({ name: `c${i}` }))
    expect(sanitizeCommands(many)).toHaveLength(MAX_CHAT_COMMANDS)
  })

  it('命令表跟着快照走,state 事件不清它(手机切回来还在)', () => {
    const hub = new PiChatHub()
    const viewer = fakeSink()
    hub.attachViewer(viewer.sink)
    hub.attachPi(1, fakeSink().sink)

    const commands = [{ name: 'bow', description: '状态', source: 'extension' }]
    hub.fromPi(1, { type: 'snapshot', messages: [], commands })
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'chat', commands })
    expect(hub.snapshot(1).commands).toEqual(commands)

    hub.fromPi(1, { type: 'state', busy: true, pending: 1 })
    expect(hub.snapshot(1).commands).toEqual(commands)
  })

  it('旧版扩展不发命令表 → 空数组(手机就不显示 / 入口)', () => {
    const hub = new PiChatHub()
    hub.attachPi(1, fakeSink().sink)
    hub.fromPi(1, { type: 'snapshot', messages: [] })
    expect(hub.snapshot(1).commands).toEqual([])
    // 坏形状也不炸
    hub.fromPi(1, { type: 'snapshot', messages: [], commands: 'nope' })
    expect(hub.snapshot(1).commands).toEqual([])
  })
})

describe('协议:对话消息', () => {
  it('chat/abort 只要有 id;prompt 要非空 text + 合法 deliverAs', () => {
    expect(parseClientMessage({ t: 'chat', id: 3 })).toEqual({ ok: true, message: { t: 'chat', id: 3 } })
    expect(parseClientMessage({ t: 'abort', id: 3 })).toEqual({ ok: true, message: { t: 'abort', id: 3 } })
    expect(parseClientMessage({ t: 'prompt', id: 3, text: 'hi' })).toEqual({
      ok: true,
      message: { t: 'prompt', id: 3, text: 'hi' }
    })
    expect(parseClientMessage({ t: 'prompt', id: 3, text: 'hi', deliverAs: 'steer' })).toMatchObject({
      ok: true,
      message: { deliverAs: 'steer' }
    })
    expect(parseClientMessage({ t: 'prompt', id: 3, text: '   ' }).ok).toBe(false)
    expect(parseClientMessage({ t: 'prompt', id: 3, text: 'hi', deliverAs: 'later' }).ok).toBe(false)
    expect(parseClientMessage({ t: 'prompt', text: 'hi' }).ok).toBe(false)
    expect(parseClientMessage({ t: 'chat', id: 0 }).ok).toBe(false)
  })
})

describe('WS 往返:pi 端(令牌)+ 手机端(cookie)', () => {
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

  function fakeSessions(): RemoteSessionApi {
    return {
      list: () => [session(1)],
      attach: () => ({ ok: false, error: '会话不存在' }),
      input: () => false,
      resize: () => false,
      readTail: () => ({ ok: false, error: '会话不存在' }),
      create: () => ({ ok: false, error: '会话不存在' }),
      close: () => false,
      controlToken: (id) => (id === 1 ? TOKEN : null)
    }
  }

  function collector(ws: WebSocket) {
    const queue: Array<Record<string, unknown>> = []
    const waiters: Array<{ match: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void }> = []
    ws.on('message', (raw) => {
      const parsed = JSON.parse(String(raw)) as Record<string, unknown>
      const i = waiters.findIndex((w) => w.match(parsed))
      if (i >= 0) waiters.splice(i, 1)[0].resolve(parsed)
      else queue.push(parsed)
    })
    return (match: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
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
    }
  }

  /** 必须在 `open` 之前挂监听:服务端在握手成功后**立刻**发 `history`,事后再挂会漏 */
  async function connect(
    url: string,
    headers: Record<string, string> = {}
  ): Promise<{ ws: WebSocket; next: (match: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>> }> {
    const ws = new WebSocket(url, { headers })
    const next = collector(ws)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    return { ws, next }
  }

  async function boot() {
    const hub = new SessionHub()
    const piChat = new PiChatHub()
    const auth = new RemoteAuth({ password: PASSWORD, key: Buffer.alloc(32, 5) })
    const server = await startRemoteServer({
      port: 0,
      bind: 'loopback',
      hub,
      auth,
      sessions: fakeSessions(),
      piChat,
      listAddresses: () => []
    })
    const login = await localRequest(`${server.url}/login`, {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD })
    })
    const cookie = String(login.headers['set-cookie'] ?? '')
    return { server, piChat, cookie, wsUrl: server.wsUrl }
  }

  it('pi 端:没有令牌 / 令牌不对 / 会话不存在 → 握手被拒', async () => {
    const { server, wsUrl } = await boot()
    try {
      await expect(connect(wsUrl)).rejects.toBeTruthy()
      await expect(connect(`${wsUrl}?role=pi&session=1`)).rejects.toBeTruthy()
      await expect(connect(`${wsUrl}?role=pi&session=1&token=nope`)).rejects.toBeTruthy()
      await expect(connect(`${wsUrl}?role=pi&session=99&token=${TOKEN}`)).rejects.toBeTruthy()
    } finally {
      await server.close()
    }
  })

  it('pi 端:令牌正确 → 连上首先收到 history 请求', async () => {
    const { server, wsUrl } = await boot()
    const { ws: pi, next } = await connect(`${wsUrl}?role=pi&session=1&token=${TOKEN}`)
    try {
      expect(await next((m) => m.type === 'history')).toEqual({ type: 'history' })
    } finally {
      pi.close()
      await server.close()
    }
  })

  it('手机只读镜像 + 发话 + 停止:三种消息都到对应的人', async () => {
    const { server, cookie, wsUrl } = await boot()
    const { ws: pi, next: piNext } = await connect(`${wsUrl}?role=pi&session=1&token=${TOKEN}`)
    const { ws: phone, next: phoneNext } = await connect(wsUrl, { cookie })
    try {
      await piNext((m) => m.type === 'history')

      // 手机拉快照:此时 pi 已连上 → live=true、还没有消息
      phone.send(JSON.stringify({ t: 'chat', id: 1 }))
      expect(await phoneNext((m) => m.t === 'chat')).toMatchObject({ id: 1, live: true, messages: [], busy: false })

      // pi 报一条新消息 → 手机收到
      pi.send(JSON.stringify({ type: 'message', message: { id: 'a1', role: 'assistant', text: '在跑了' } }))
      expect(await phoneNext((m) => m.t === 'chat-message')).toMatchObject({
        id: 1,
        message: { id: 'a1', role: 'assistant', text: '在跑了' }
      })

      // 手机发话(排队)→ pi 收到 followUp
      phone.send(JSON.stringify({ t: 'prompt', id: 1, text: '顺便跑下测试', deliverAs: 'followUp' }))
      expect(await piNext((m) => m.type === 'prompt')).toEqual({
        type: 'prompt',
        text: '顺便跑下测试',
        deliverAs: 'followUp'
      })

      // 手机停止 → pi 收到 abort
      phone.send(JSON.stringify({ t: 'abort', id: 1 }))
      expect(await piNext((m) => m.type === 'abort')).toEqual({ type: 'abort' })

      // 缓存留在服务端:另一台手机(或重连)直接拿快照,不用等 pi 再吐
      const { ws: phone2, next: phone2Next } = await connect(wsUrl, { cookie })
      phone2.send(JSON.stringify({ t: 'chat', id: 1 }))
      const snapshot = await phone2Next((m) => m.t === 'chat')
      expect((snapshot.messages as ChatMessage[]).map((m) => m.id)).toEqual(['a1'])
      phone2.close()
    } finally {
      phone.close()
      pi.close()
      await server.close()
    }
  })

  it('pi 没连上时手机发话 → 收到可读的 error(而不是静默失败)', async () => {
    const { server, cookie, wsUrl } = await boot()
    const { ws: phone, next: phoneNext } = await connect(wsUrl, { cookie })
    try {
      phone.send(JSON.stringify({ t: 'prompt', id: 1, text: '有人吗' }))
      const error = await phoneNext((m) => m.t === 'error')
      expect(String(error.message)).toContain('控制通道')
    } finally {
      phone.close()
      await server.close()
    }
  })
})

describe('提问(手机回答 pi 的弹框)', () => {
  const ask = (requestId: string, kind: AskRequest['kind'], extra: Partial<AskRequest> = {}): AskRequest => ({
    requestId,
    kind,
    title: '要跑测试吗?',
    ...extra
  })

  it('ask 存进快照并广播;ask-done 删掉', () => {
    const hub = new PiChatHub()
    const viewer = fakeSink()
    hub.attachViewer(viewer.sink)
    hub.attachPi(1, fakeSink().sink)

    hub.fromPi(1, { type: 'ask', ask: ask('q1', 'confirm', { message: '这会执行 npm test' }) })
    expect(viewer.messages.at(-1)).toMatchObject({ t: 'ask', id: 1, ask: { requestId: 'q1', kind: 'confirm' } })
    expect(hub.snapshot(1).asks.map((a) => a.requestId)).toEqual(['q1'])

    hub.fromPi(1, { type: 'ask-done', requestId: 'q1' })
    expect(viewer.messages.at(-1)).toEqual({ t: 'ask-done', id: 1, requestId: 'q1' })
    expect(hub.snapshot(1).asks).toEqual([])
  })

  it('热重启(重连)后手机还能看到没答的题', () => {
    const hub = new PiChatHub()
    const first = fakeSink()
    const detach = hub.attachPi(1, first.sink)
    hub.fromPi(1, { type: 'ask', ask: ask('q1', 'select', { options: ['甲', '乙'] }) })
    detach()

    // 新的手机连上来:snapshot 里带着题面,不需要 pi 再发一遍
    expect(hub.snapshot(1).asks).toEqual([expect.objectContaining({ requestId: 'q1', options: ['甲', '乙'] })])
  })

  it('answer 转发给 pi、立刻把卡片拿掉、并广播 ask-done', () => {
    const hub = new PiChatHub()
    const pi = fakeSink()
    const viewer = fakeSink()
    hub.attachViewer(viewer.sink)
    hub.attachPi(1, pi.sink)
    hub.fromPi(1, { type: 'ask', ask: ask('q1', 'confirm') })

    expect(hub.answer(1, 'q1', true)).toEqual({ ok: true })
    expect(pi.messages.at(-1)).toEqual({ type: 'answer', requestId: 'q1', value: true })
    expect(hub.snapshot(1).asks).toEqual([])
    expect(viewer.messages.at(-1)).toEqual({ t: 'ask-done', id: 1, requestId: 'q1' })
  })

  it('类型不对 / 已经不在了 / 没有控制通道 → 如实报错(不静默)', () => {
    const hub = new PiChatHub()
    hub.attachPi(1, fakeSink().sink)
    hub.fromPi(1, { type: 'ask', ask: ask('q1', 'confirm') })
    hub.fromPi(1, { type: 'ask', ask: ask('q2', 'input') })

    expect(hub.answer(1, 'q1', 'yes')).toMatchObject({ ok: false }) // confirm 要 boolean
    expect(hub.answer(1, 'q2', true)).toMatchObject({ ok: false }) // 输入型要字符串
    expect(hub.answer(1, 'nope', true)).toMatchObject({ ok: false }) // 已经不在
    expect(hub.answer(9, 'q1', true)).toMatchObject({ ok: false }) // 没有控制通道
  })

  it('重复投递的同一条消息只占一行(同一个扩展被加载两次时)', () => {
    const hub = new PiChatHub()
    hub.attachPi(1, fakeSink().sink)
    const message = msg('a1', 'assistant', { text: '只说一次' })
    hub.fromPi(1, { type: 'message', message })
    hub.fromPi(1, { type: 'message', message })
    expect(hub.snapshot(1).messages).toHaveLength(1)
  })

  it('协议:answer 要 id + requestId + boolean/string', () => {
    expect(parseClientMessage({ t: 'answer', id: 1, requestId: 'q1', value: true })).toEqual({
      ok: true,
      message: { t: 'answer', id: 1, requestId: 'q1', value: true }
    })
    expect(parseClientMessage({ t: 'answer', id: 1, requestId: 'q1', value: '乙' })).toMatchObject({ ok: true })
    expect(parseClientMessage({ t: 'answer', id: 1, requestId: '', value: true }).ok).toBe(false)
    expect(parseClientMessage({ t: 'answer', id: 1, requestId: 'q1', value: 42 }).ok).toBe(false)
    expect(parseClientMessage({ t: 'answer', id: 0, requestId: 'q1', value: true }).ok).toBe(false)
  })
})

describe('软键盘:高度差算得对', () => {
  it('键盘没开 → 0', () => {
    expect(keyboardInsetOf(762, 762, 0)).toBe(0)
  })
  it('Android(resizes-content):布局也缩了 → 差额是 0,不会双重位移', () => {
    expect(keyboardInsetOf(450, 450, 0)).toBe(0)
  })
  it('iOS(布局不动,只有可见区缩 + 上推)→ 把差额算出来', () => {
    expect(keyboardInsetOf(844, 508, 0)).toBe(336)
    expect(keyboardInsetOf(844, 508, 60)).toBe(276)
  })
  it('工具栏收起那几十像素不算键盘', () => {
    expect(keyboardInsetOf(844, 780, 0)).toBeLessThan(KEYBOARD_OPEN_MIN_PX)
  })
  it('怪异输入被夹到 0(可见区比布局还高)', () => {
    expect(keyboardInsetOf(500, 700, 0)).toBe(0)
  })
})

describe('软键盘:只有键盘真的开着才从页高里扣', () => {
  it('工具栏伸缩那几十像素 → 不扣(扣了就永久白留一截)', () => {
    expect(keyboardInsetToDeduct(keyboardInsetOf(844, 780, 0))).toBe(0)
    expect(keyboardInsetToDeduct(KEYBOARD_OPEN_MIN_PX)).toBe(0)
  })
  it('键盘真的开着 → 原样扣', () => {
    expect(keyboardInsetToDeduct(336)).toBe(336)
    expect(keyboardInsetToDeduct(KEYBOARD_OPEN_MIN_PX + 1)).toBe(KEYBOARD_OPEN_MIN_PX + 1)
  })
})
