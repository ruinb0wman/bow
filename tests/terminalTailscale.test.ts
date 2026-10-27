/**
 * 「异地访问(Tailscale)」自检单测。
 *
 * 这一层只读 CLI 输出,所以全部用假 runner 覆盖四种页面形态(没装 / 没登录 / 在线没配 serve /
 * 在线且 serve 指向本端口),外加「版本改名」「非 JSON」「serve 指到别的端口」这些降级路径。
 * JSON 夹具是 1.104 的真实输出(见下方 STATUS_JSON),不是编的。
 */

import { describe, expect, it } from 'vitest'
import {
  TAILSCALE_BIN_CANDIDATES,
  parseServeStatus,
  parseTailscaleStatus,
  probeTailscale
} from '../src/plugins/terminal/remote/tailscale'

const PORT = 8770

const STATUS_JSON = JSON.stringify({
  Version: '1.104.2-tc3430f0d2-g598b63867',
  BackendState: 'Running',
  Self: {
    HostName: 'Albedo',
    DNSName: 'albedo.tail36b860.ts.net.',
    OS: 'windows',
    TailscaleIPs: ['100.104.201.34', 'fd7a:115c:a1e0::d401:c9d5']
  },
  Peer: {
    node1: { HostName: 'V2536A', OS: 'android', Online: true, TailscaleIPs: ['100.120.108.95'] },
    node2: { HostName: 'mac', OS: 'macOS', Online: false, TailscaleIPs: ['100.99.0.1'] }
  }
})

const SERVE_JSON = JSON.stringify({
  TCP: { '443': { HTTPS: true } },
  Web: {
    'albedo.tail36b860.ts.net:443': {
      Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}` } }
    }
  }
})

/** 按 (bin, 子命令) 查表;表里没有 = 命令失败 → null */
function runner(table: Record<string, string | null>) {
  return async (bin: string, args: string[]): Promise<string | null> => {
    const key = `${bin} ${args.join(' ')}`
    return key in table ? (table[key] ?? null) : null
  }
}

const OK = { 'tailscale version': '1.104.2', 'tailscale status --json': STATUS_JSON }

describe('解析 status --json', () => {
  it('拿主机名(去尾点)/ IPv4 / 设备数与手机数', () => {
    const snap = parseTailscaleStatus(STATUS_JSON)
    expect(snap).toEqual({
      backendState: 'Running',
      host: 'albedo.tail36b860.ts.net',
      ip4: '100.104.201.34',
      peers: 2,
      phones: 1
    })
  })

  it('字段缺失只要有 BackendState 就还能读(其余留空)', () => {
    expect(parseTailscaleStatus('{"BackendState":"NeedsLogin"}')).toEqual({
      backendState: 'NeedsLogin',
      host: null,
      ip4: null,
      peers: 0,
      phones: 0
    })
  })

  it('不是 JSON / 是数组 → null,由调用方降级', () => {
    expect(parseTailscaleStatus('not json')).toBeNull()
    expect(parseTailscaleStatus('[]')).toBeNull()
  })
})

describe('解析 serve status --json', () => {
  it('指向本端口 → 给出 https 地址', () => {
    expect(parseServeStatus(SERVE_JSON, PORT)).toEqual({ url: 'https://albedo.tail36b860.ts.net', port: PORT })
  })

  it('指向别的端口 → null(页面会提示 serve 没指过来)', () => {
    expect(parseServeStatus(SERVE_JSON, 8771)).toBeNull()
  })

  it('没配 serve 的空对象 → null', () => {
    expect(parseServeStatus('{}', PORT)).toBeNull()
  })

  it('没有 HTTPS 标记 → http://;Proxy 指到别的机器 → null', () => {
    const plain = JSON.stringify({
      Web: { 'bow.example.ts.net:80': { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}` } } } }
    })
    expect(parseServeStatus(plain, PORT)).toEqual({ url: 'http://bow.example.ts.net', port: PORT })

    const remote = JSON.stringify({
      TCP: { '443': { HTTPS: true } },
      Web: { 'bow.example.ts.net:443': { Handlers: { '/': { Proxy: `http://10.0.0.5:${PORT}` } } } }
    })
    expect(parseServeStatus(remote, PORT)).toBeNull()
  })
})

describe('自检', () => {
  it('没装:found=false + 明说试过哪些位置', async () => {
    const status = await probeTailscale(runner({}), PORT, () => 7)
    expect(status.state).toBe('missing')
    expect(status.found).toBe(false)
    expect(status.error).toContain('没找到 tailscale')
    expect(status.checkedAt).toBe(7)
  })

  it('PATH 里没有时退回 Windows 默认安装路径', async () => {
    const win = TAILSCALE_BIN_CANDIDATES[1]
    const status = await probeTailscale(
      runner({ [`${win} version`]: '1.104.2', [`${win} status --json`]: STATUS_JSON, [`${win} serve --json`]: SERVE_JSON }),
      PORT
    )
    expect(status.bin).toBe(win)
    expect(status.state).toBe('running')
  })

  it('在线且 serve 指向本端口 → 直接给出手机该开的地址', async () => {
    const status = await probeTailscale(
      runner({ ...OK, 'tailscale serve --json': SERVE_JSON }),
      PORT
    )
    expect(status).toMatchObject({
      found: true,
      state: 'running',
      host: 'albedo.tail36b860.ts.net',
      ip4: '100.104.201.34',
      peers: 2,
      phones: 1,
      serve: { url: 'https://albedo.tail36b860.ts.net', port: PORT },
      error: null
    })
  })

  it('在线但没配 serve → serve 为 null 且不算错误', async () => {
    const status = await probeTailscale(runner({ ...OK, 'tailscale serve --json': '{}' }), PORT)
    expect(status.state).toBe('running')
    expect(status.serve).toBeNull()
    expect(status.error).toBeNull()
  })

  it('没登录:只在 state 上说清楚,不去问 serve', async () => {
    let serveAsked = false
    const status = await probeTailscale(async (bin, args) => {
      const key = `${bin} ${args.join(' ')}`
      if (key.endsWith('serve --json')) serveAsked = true
      return runner({ 'tailscale version': '1.104.2', 'tailscale status --json': '{"BackendState":"NeedsLogin"}' })(bin, args)
    }, PORT)
    expect(status.state).toBe('needs-login')
    expect(status.serve).toBeNull()
    expect(serveAsked).toBe(false)
  })

  it('status 执行失败 / 输出读不懂 → unknown,但记住二进制是找到了的', async () => {
    const failed = await probeTailscale(runner({ 'tailscale version': '1.104.2' }), PORT)
    expect(failed).toMatchObject({ found: true, state: 'unknown' })
    expect(failed.error).toContain('执行失败')

    const garbage = await probeTailscale(
      runner({ 'tailscale version': '1.104.2', 'tailscale status --json': '<<<>>>' }),
      PORT
    )
    expect(garbage.state).toBe('unknown')
    expect(garbage.error).toContain('JSON')
  })
})
