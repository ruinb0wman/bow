/**
 * bow MCP 注册这段逻辑的测试:配置解析、端口探测、注册结果分派、`mcp.json` 覆盖检测、`/bow` 文案,
 * 以及**与 bow 仓库安装脚本的一致性**(服务器名 / 描述 / 6 个 direct 工具 —— 用户从脚本换到本包时行为不该变)。
 */

import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOW_MCP_CORE_TOOLS,
  BOW_MCP_DEFAULT_URL,
  BOW_MCP_DESCRIPTION,
  BOW_MCP_SERVER,
  bowInMcpJson,
  bowMcpServerConfig,
  formatBowMcpReport,
  isReachable,
  readBowMcpConfig,
  registerBowMcp,
  unregisterBowMcp
} from '../src/bow-mcp'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

/** 起一个假装是 bow MCP 端点的 HTTP 服务:对 GET 立刻 406(真 bow 就是这么回的) */
async function fakeBow(): Promise<{ url: string; port: number }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(406, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Not Acceptable' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}/mcp`, port }
}

/** 一个没人监听的服务端口:先占住拿到号,再放开 */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

interface FakePi {
  api: unknown
  calls: Array<{ name: string; config: unknown }>
  unregistered: string[]
}

function makePi(opts: { supportRegister?: boolean; throwOnRegister?: boolean; registered?: string[] } = {}): FakePi {
  const calls: FakePi['calls'] = []
  const unregistered: string[] = []
  const api: Record<string, unknown> = {
    getMcpServers: () => (opts.registered ?? []).map((name) => ({ name }))
  }
  if (opts.supportRegister !== false) {
    api.registerMcpServer = (name: string, config: unknown) => {
      if (opts.throwOnRegister) throw new Error('名字被别的扩展占了')
      calls.push({ name, config })
    }
    api.unregisterMcpServer = (name: string) => {
      unregistered.push(name)
    }
  }
  return { api, calls, unregistered }
}

describe('readBowMcpConfig', () => {
  it('默认:开、默认端点、无令牌', () => {
    expect(readBowMcpConfig({})).toEqual({ enabled: true, url: BOW_MCP_DEFAULT_URL, token: '' })
  })

  it('env 覆盖端口/令牌;BOW_MCP=0 整包关掉', () => {
    const cfg = readBowMcpConfig({ BOW_MCP_URL: ' http://10.0.0.2:9999/mcp ', BOW_MCP_TOKEN: 'tk' })
    expect(cfg).toMatchObject({ enabled: true, url: 'http://10.0.0.2:9999/mcp', token: 'tk' })
    expect(readBowMcpConfig({ BOW_MCP: '0' }).enabled).toBe(false)
    expect(readBowMcpConfig({ BOW_MCP: '1' }).enabled).toBe(true)
  })
})

describe('bowMcpServerConfig', () => {
  it('6 个核心工具 direct(其余走 codemode);无令牌时不带 headers', () => {
    const cfg = bowMcpServerConfig({ enabled: true, url: BOW_MCP_DEFAULT_URL, token: '' })
    expect(cfg.description).toBe(BOW_MCP_DESCRIPTION)
    expect(Object.keys(cfg.toolExposure ?? {})).toHaveLength(BOW_MCP_CORE_TOOLS.length)
    expect(cfg.toolExposure?.browser_read).toBe('direct')
    expect(cfg.headers).toBeUndefined()
  })

  it('有令牌时带 Bearer', () => {
    const cfg = bowMcpServerConfig({ enabled: true, url: BOW_MCP_DEFAULT_URL, token: 'tk' })
    expect(cfg.headers).toEqual({ Authorization: 'Bearer tk' })
  })
})

describe('isReachable', () => {
  it('端点像 JSON-RPC 说话 → true;空端口(连上也不回话)→ 超时 false;URL 都解析不了 → false', async () => {
    const { url } = await fakeBow()
    expect(await isReachable(url)).toBe(true)
    expect(await isReachable(`http://127.0.0.1:${await freePort()}/mcp`, 300)).toBe(false)
    expect(await isReachable('不是 URL')).toBe(false)
  })

  it('200 但不像 JSON-RPC(本机代理/别的东西回的 HTML)→ 不算活', async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>proxy</html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => server.close())
    const port = (server.address() as { port: number }).port
    expect(await isReachable(`http://127.0.0.1:${port}/mcp`)).toBe(false)
  })
})

describe('registerBowMcp', () => {
  it('BOW_MCP=0:不注册,outcome=disabled', async () => {
    const pi = makePi()
    const r = await registerBowMcp(pi.api as never, { BOW_MCP: '0' })
    expect(r.outcome).toBe('disabled')
    expect(pi.calls).toEqual([])
  })

  it('老 pi 没有 registerMcpServer:outcome=unsupported,不抛', async () => {
    const pi = makePi({ supportRegister: false })
    const r = await registerBowMcp(pi.api as never, {})
    expect(r.outcome).toBe('unsupported')
  })

  it('端点连不上:不注册(避免每个会话刷连接错误)', async () => {
    const pi = makePi()
    const r = await registerBowMcp(pi.api as never, { BOW_MCP_URL: `http://127.0.0.1:${await freePort()}/mcp` })
    expect(r.outcome).toBe('unreachable')
    expect(pi.calls).toEqual([])
  })

  it('端点可达:注册 browser,配置与 mcp.json 那条同形', async () => {
    const { url } = await fakeBow()
    const pi = makePi()
    const r = await registerBowMcp(pi.api as never, { BOW_MCP_URL: url })
    expect(r.outcome).toBe('registered')
    expect(pi.calls).toEqual([{ name: BOW_MCP_SERVER, config: bowMcpServerConfig({ enabled: true, url, token: '' }) }])
  })

  it('pi 抛错(名字被别的扩展占了):outcome=failed 并把原因说出来', async () => {
    const { url } = await fakeBow()
    const pi = makePi({ throwOnRegister: true })
    const r = await registerBowMcp(pi.api as never, { BOW_MCP_URL: url })
    expect(r.outcome).toBe('failed')
    expect(r.message).toContain('名字被别的扩展占了')
  })
})

describe('unregisterBowMcp', () => {
  it('注销本包那个;没注册过时 pi 抛错也吞掉(off 不该因此报错)', () => {
    const pi = makePi()
    unregisterBowMcp(pi.api as never)
    expect(pi.unregistered).toEqual([BOW_MCP_SERVER])

    const throwing = { unregisterMcpServer: () => { throw new Error('没注册过') } }
    expect(() => unregisterBowMcp(throwing as never)).not.toThrow()
  })
})

describe('bowInMcpJson', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pi-bow-mcpjson-'))
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }))

  it('用户级/项目级的同名条目都认出来(它会覆盖本包)', () => {
    const agentDir = join(tmp, 'agent')
    const cwd = join(tmp, 'proj')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { browser: { url: 'x' } } }))
    writeFileSync(join(cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { other: {} } }))
    expect(bowInMcpJson({ PI_CODING_AGENT_DIR: agentDir }, cwd)).toEqual([join(agentDir, 'mcp.json')])

    writeFileSync(join(cwd, '.pi', 'mcp.json'), '{ 这不是 JSON')
    expect(bowInMcpJson({ PI_CODING_AGENT_DIR: agentDir }, cwd)).toEqual([join(agentDir, 'mcp.json')])
    expect(bowInMcpJson({ PI_CODING_AGENT_DIR: join(tmp, '空') }, cwd)).toEqual([])
  })
})

describe('formatBowMcpReport', () => {
  const base = { version: '0.1.0', url: BOW_MCP_DEFAULT_URL, enabled: true, reachable: true, registered: true, overriddenBy: [] }

  it('四种状态各说各的,覆盖时额外提醒', () => {
    expect(formatBowMcpReport(base)).toContain('已注册')
    expect(formatBowMcpReport({ ...base, registered: false })).toContain('/bow on')
    expect(formatBowMcpReport({ ...base, reachable: false })).toContain('连不上')
    expect(formatBowMcpReport({ ...base, enabled: false })).toContain('BOW_MCP=0')
    expect(formatBowMcpReport({ ...base, overriddenBy: ['/home/u/.pi/agent/mcp.json'] })).toContain('优先于本包')
    expect(formatBowMcpReport(base)).toContain('pi-bow 0.1.0')
  })
})

describe('与 bow 仓库的安装脚本一致(用户从脚本换到本包时行为不变)', () => {
  const installer = readFileSync(new URL('../../../scripts/install-pi-mcp.mjs', import.meta.url), 'utf-8')

  it('服务器名 / 描述 / 核心工具清单逐字一致', () => {
    expect(installer).toContain(`const SERVER_NAME = '${BOW_MCP_SERVER}'`)
    expect(installer).toContain(`const SERVER_DESCRIPTION = '${BOW_MCP_DESCRIPTION}'`)
    for (const tool of BOW_MCP_CORE_TOOLS) expect(installer).toContain(`'${tool}'`)
    expect(installer).toContain('http://127.0.0.1:${port}/mcp')
  })
})
