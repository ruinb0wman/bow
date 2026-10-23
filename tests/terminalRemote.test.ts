/**
 * 远程服务骨架(S5):hub 的扇出策略、设置规范化、HTTP 监听与关闭。
 *
 * 三块分开看:
 * ① hub —— 纯逻辑,重点是**慢消费者被断开而不是丢字节**(丢一段输出 = 画面永久错位);
 * ② normalizeRemote —— 磁盘上的老设置没有这个字段,坏值不能把服务带崩;
 * ③ server —— 真起一个监听(端口 0 让系统分配),验 `/healthz` 与关闭后端口真的释放。
 */

import { describe, expect, it } from 'vitest'
import { HUB_MAX_BUFFERED_BYTES, SessionHub } from '../src/plugins/terminal/remote/hub'
import type { HubEvent, HubSink } from '../src/plugins/terminal/remote/hub'
import { REMOTE_DEFAULT_PORT, defaultRemoteSettings, normalizeRemote } from '../src/plugins/terminal/shared'
import type { SessionInfo } from '../src/plugins/terminal/shared'
import { listLanAddresses, startRemoteServer } from '../src/plugins/terminal/remote/server'
import { connect } from 'node:net'

/** 假 sink:记录收到的事件、可模拟积压与抛错 */
function fakeSink(opts: { buffered?: number; throwOnSend?: boolean } = {}) {
  const events: HubEvent[] = []
  const drops: string[] = []
  const state = { buffered: opts.buffered ?? 0 }
  const sink: HubSink = {
    buffered: () => state.buffered,
    send: (event) => {
      if (opts.throwOnSend) throw new Error('socket 已经关了')
      events.push(event)
    },
    drop: (reason) => drops.push(reason)
  }
  return { sink, events, drops, state }
}

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

describe('SessionHub', () => {
  it('广播给所有订阅者,取消订阅后不再收到', () => {
    const hub = new SessionHub()
    const a = fakeSink()
    const b = fakeSink()
    const offA = hub.subscribe(a.sink)
    hub.subscribe(b.sink)
    expect(hub.size).toBe(2)

    hub.publish({ t: 'data', id: 1, chunk: 'hi' })
    expect(a.events).toHaveLength(1)
    expect(b.events).toEqual([{ t: 'data', id: 1, chunk: 'hi' }])

    offA()
    offA() // 重复调用无害
    hub.publish({ t: 'closed', id: 1, reason: 'tab-closed' })
    expect(a.events).toHaveLength(1)
    expect(b.events).toHaveLength(2)
  })

  it('慢消费者被**断开**而不是丢事件(丢一段输出会让画面永久错位)', () => {
    const hub = new SessionHub(1024)
    const slow = fakeSink()
    const fast = fakeSink()
    hub.subscribe(slow.sink)
    hub.subscribe(fast.sink)

    slow.state.buffered = 2048 // 超过上限
    hub.publish({ t: 'data', id: 1, chunk: 'x' })

    expect(slow.events).toHaveLength(0) // 一个字节都没给它(给了就是脏数据)
    expect(slow.drops).toHaveLength(1)
    expect(slow.drops[0]).toContain('积压')
    expect(fast.events).toHaveLength(1) // 不连累别人
    expect(hub.size).toBe(1)

    // 踢掉之后不会再找它
    hub.publish({ t: 'data', id: 1, chunk: 'y' })
    expect(slow.events).toHaveLength(0)
    expect(slow.drops).toHaveLength(1)
  })

  it('上限就是构造参数(默认 4MB)', () => {
    const hub = new SessionHub()
    const sink = fakeSink()
    hub.subscribe(sink.sink)
    sink.state.buffered = HUB_MAX_BUFFERED_BYTES + 1
    hub.publish({ t: 'data', id: 1, chunk: 'x' })
    expect(sink.drops).toHaveLength(1)
  })

  it('单个 sink 发送抛错只踢掉它自己', () => {
    const hub = new SessionHub()
    const bad = fakeSink({ throwOnSend: true })
    const good = fakeSink()
    hub.subscribe(bad.sink)
    hub.subscribe(good.sink)

    expect(() => hub.publish({ t: 'data', id: 1, chunk: 'x' })).not.toThrow()
    expect(bad.drops).toHaveLength(1)
    expect(good.events).toHaveLength(1)
    expect(hub.size).toBe(1)
  })

  it('clear(停服)会通知所有订阅者原因', () => {
    const hub = new SessionHub()
    const a = fakeSink()
    hub.subscribe(a.sink)
    hub.clear('插件已停用')
    expect(a.drops).toEqual(['插件已停用'])
    expect(hub.size).toBe(0)
  })
})

describe('normalizeRemote', () => {
  const fallback = defaultRemoteSettings()

  it('老设置文件没有 remote 字段时给默认值(默认关闭、只绑回环)', () => {
    expect(normalizeRemote(undefined, fallback)).toEqual({
      enabled: false,
      bind: 'loopback',
      port: REMOTE_DEFAULT_PORT
    })
    expect(normalizeRemote({}, fallback)).toEqual(fallback)
  })

  it('坏值回落到 fallback,不抛', () => {
    expect(normalizeRemote({ enabled: 'yes', bind: 'public', port: 'abc' }, fallback)).toEqual(fallback)
    expect(normalizeRemote({ port: 80 }, fallback).port).toBe(1024) // 夹进范围内
    expect(normalizeRemote({ port: 99999 }, fallback).port).toBe(65535)
  })

  it('合法值原样保留', () => {
    expect(normalizeRemote({ enabled: true, bind: 'lan', port: 9999 }, fallback)).toEqual({
      enabled: true,
      bind: 'lan',
      port: 9999
    })
  })
})

describe('远程 HTTP 骨架', () => {
  it('回环模式:监听 127.0.0.1,/healthz 可用,不给局域网地址', async () => {
    const hub = new SessionHub()
    const server = await startRemoteServer({ port: 0, bind: 'loopback', hub, listAddresses: () => ['192.168.1.9'] })
    try {
      expect(server.port).toBeGreaterThan(0) // 端口 0 → 系统分配
      expect(server.host).toBe('127.0.0.1')
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
      expect(server.lanUrls).toEqual([])

      const res = await fetch(`${server.url}/healthz`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; service: string; bind: string }
      expect(body).toMatchObject({ ok: true, service: 'bow-terminal-remote', bind: 'loopback' })
    } finally {
      await server.close()
    }
  })

  it('局域网模式:绑 0.0.0.0 并列出局域网地址', async () => {
    const hub = new SessionHub()
    const server = await startRemoteServer({
      port: 0,
      bind: 'lan',
      hub,
      listAddresses: () => ['192.168.1.9', '10.0.0.3']
    })
    try {
      expect(server.host).toBe('0.0.0.0')
      expect(server.lanUrls).toEqual([
        `http://192.168.1.9:${server.port}`,
        `http://10.0.0.3:${server.port}`
      ])
      // 绑 0.0.0.0 时仍能用回环访问(手机走 lanUrls,本机走 url)
      expect((await fetch(`${server.url}/healthz`)).status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('未知路径 404;healthz 可以带会话数但不带内容', async () => {
    const hub = new SessionHub()
    const server = await startRemoteServer({
      port: 0,
      bind: 'loopback',
      hub,
      sessions: () => [session(1), session(2)].length,
      listAddresses: () => []
    })
    try {
      const notFound = await fetch(`${server.url}/nope`)
      expect(notFound.status).toBe(404)

      const body = (await (await fetch(`${server.url}/healthz`)).json()) as { sessions: number }
      expect(body.sessions).toBe(2)
    } finally {
      await server.close()
    }
  })

  it('close() 之后端口真的释放(否则插件重新启用会 EADDRINUSE)', async () => {
    const hub = new SessionHub()
    const first = await startRemoteServer({ port: 0, bind: 'loopback', hub, listAddresses: () => [] })
    const port = first.port
    await first.close()

    // 能立刻在同一个端口上重新监听 = 真的释放了
    const second = await startRemoteServer({ port, bind: 'loopback', hub, listAddresses: () => [] })
    await second.close()

    // 关掉之后端口真的没人听:用裸 TCP 判,不用 fetch
    // (环境里若配了 HTTP 代理,fetch 到死端口会拿到 502 而不是拒绝 —— 那判不出「端口释放没」)
    await expect(
      new Promise((resolve, reject) => {
        const socket = connect({ port, host: '127.0.0.1' })
        socket.once('connect', () => {
          socket.destroy()
          resolve('connected')
        })
        socket.once('error', reject)
      })
    ).rejects.toBeTruthy()
  })

  it('端口被占用时抛错(调用方靠它把原因显示到设置页)', async () => {
    const hub = new SessionHub()
    const first = await startRemoteServer({ port: 0, bind: 'loopback', hub, listAddresses: () => [] })
    try {
      await expect(
        startRemoteServer({ port: first.port, bind: 'loopback', hub, listAddresses: () => [] })
      ).rejects.toMatchObject({ code: 'EADDRINUSE' })
    } finally {
      await first.close()
    }
  })

  it('listLanAddresses 只给非回环 IPv4(纯函数,不依赖真实网卡数量)', () => {
    const addrs = listLanAddresses()
    expect(Array.isArray(addrs)).toBe(true)
    for (const a of addrs) {
      expect(typeof a).toBe('string')
      expect(a).not.toBe('127.0.0.1')
    }
  })
})
