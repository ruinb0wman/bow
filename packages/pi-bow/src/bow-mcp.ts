/**
 * bow MCP 服务器的「注册进 pi」这段逻辑(配置 + 可达性探测 + 注册/注销 + 状态报告)。
 *
 * 为什么要有它:bow 的 MCP 端点是个**本机常驻服务**,不是每次都能连上 —— 所以先探端口,
 * 探不到就**不注册**(否则每个 pi 会话都会刷一条连接错误)。探测只连端口不发 HTTP 请求:
 * `/mcp` 是 streamable HTTP,`HEAD` 不一定被接受(拿 405 当"不活"是错的)。
 *
 * 与 bow 仓库里的 `scripts/install-pi-mcp.mjs` 的关系:那个脚本写 `~/.pi/agent/mcp.json`,
 * 给**不用 pi 插件**的人(以及其它 MCP 客户端)用;装了本包就不需要它 —— 注册是每会话的、
 * 不落盘、不用重启。两者同名时 **mcp.json 优先**(pi 的规则),`/bow` 会把这件事说出来。
 *
 * 常量(服务器名 / 描述 / 6 个 direct 工具)必须与 `scripts/install-pi-mcp.mjs` 写进 mcp.json 的那条一致 ——
 * 用户从脚本换到本包时行为不该变。`tests/bow-mcp.test.ts` 钉住这份一致。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI, McpServerConfig } from '@earendil-works/pi-coding-agent'

/** pi 里的服务器名:MCP 工具就成了 `mcp__browser__<工具>`(与 mcp.json 那条同名) */
export const BOW_MCP_SERVER = 'browser'
export const BOW_MCP_DEFAULT_URL = 'http://127.0.0.1:8765/mcp'
/** 进系统提示的一句话(与脚本里 `SERVER_DESCRIPTION` 逐字一致) */
export const BOW_MCP_DESCRIPTION = '本地 bow 浏览器(Electron 多标签)的 MCP 服务器;操作对用户实时可见'
/** 核心 6 个工具提升为原生工具(其余走 codemode;与脚本里 `CORE_TOOLS` 一致) */
export const BOW_MCP_CORE_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_read',
  'browser_wait',
  'browser_click',
  'browser_eval'
] as const

export interface BowMcpConfig {
  /** `BOW_MCP=0` 时整包不注册(等价 `/bow off`) */
  enabled: boolean
  url: string
  token: string
}

/** 环境变量覆盖;默认值 = `scripts/install-pi-mcp.mjs` 写进 mcp.json 的那条 */
export function readBowMcpConfig(env: Record<string, string | undefined> = process.env): BowMcpConfig {
  return {
    enabled: env.BOW_MCP?.trim() !== '0',
    url: env.BOW_MCP_URL?.trim() || BOW_MCP_DEFAULT_URL,
    token: env.BOW_MCP_TOKEN?.trim() ?? ''
  }
}

/** 注册给 pi 的那份配置(形态同 mcp.json 的条目) */
export function bowMcpServerConfig(cfg: BowMcpConfig): McpServerConfig {
  return {
    url: cfg.url,
    ...(cfg.token ? { headers: { Authorization: `Bearer ${cfg.token}` } } : {}),
    description: BOW_MCP_DESCRIPTION,
    toolExposure: Object.fromEntries(BOW_MCP_CORE_TOOLS.map((t) => [t, 'direct' as const]))
  }
}

/**
 * 探一下 bow 的 MCP 端点是不是活着。
 *
 * 为什么不是「连一下端口」:TCP 连上不等于有服务 —— 本机装了 TUN/透明代理时,连任意空闲端口
 * 都会「成功」(实测:df 一个刚释放的端口,`connect` 照样触发,HTTP 请求却挂到超时)。所以这里发一次真
 * 的 HTTP 请求,并且**故意只接受 `application/json`**:MCP 的 streamable HTTP 端点对 GET 会立刻拒
 * (不回 SSE 长流),于是拿到 4xx 而不是挂在那儿。
 *
 * 活着 = 有条 HTTP 响应且它像个 JSON-RPC 端点(`200`,或「能说话但不接 GET」的 400/405/406/415)。
 */
export async function isReachable(url: string, timeoutMs = 400): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (res.ok) {
      const type = res.headers.get('content-type') ?? ''
      // 200 也要像 JSON-RPC 端点:挡掉本机代理/别的东西回的 HTML 200
      return type.includes('json') || type.includes('event-stream')
    }
    return [400, 405, 406, 415].includes(res.status)
  } catch {
    return false
  }
}

export type BowMcpOutcome = 'registered' | 'disabled' | 'unsupported' | 'unreachable' | 'failed'

export interface BowMcpResult {
  outcome: BowMcpOutcome
  message: string
}

/** 探测 + 注册。老 pi 没有 `registerMcpServer` → `unsupported`(静默降级,只留状态桥) */
export async function registerBowMcp(pi: ExtensionAPI, env: Record<string, string | undefined> = process.env): Promise<BowMcpResult> {
  const cfg = readBowMcpConfig(env)
  if (!cfg.enabled) return { outcome: 'disabled', message: 'BOW_MCP=0,本次会话不注册' }
  if (typeof pi.registerMcpServer !== 'function') {
    return { outcome: 'unsupported', message: '当前 pi 版本没有 registerMcpServer(需要 pi ≥ 1.1)' }
  }
  if (!(await isReachable(cfg.url))) {
    return { outcome: 'unreachable', message: `连不上 bow:${cfg.url}(先启动 bow,或设 BOW_MCP_URL)` }
  }
  try {
    pi.registerMcpServer(BOW_MCP_SERVER, bowMcpServerConfig(cfg))
  } catch (e) {
    return { outcome: 'failed', message: `注册失败:${e instanceof Error ? e.message : String(e)}` }
  }
  return { outcome: 'registered', message: `已注册 ${BOW_MCP_SERVER} → ${cfg.url}` }
}

/** 注销本包注册的那个(没注册过时 pi 会抛 → 吞掉,`/bow off` 不该因此报错) */
export function unregisterBowMcp(pi: ExtensionAPI): void {
  try {
    pi.unregisterMcpServer?.(BOW_MCP_SERVER)
  } catch {
    /* 本来就没注册 */
  }
}

/** 本包注册过的服务器集合(pi 只在支持时给) */
export function registeredBowMcp(pi: ExtensionAPI): boolean {
  try {
    return (pi.getMcpServers?.() ?? []).some((s) => s.name === BOW_MCP_SERVER)
  } catch {
    return false
  }
}

/**
 * `mcp.json`(用户级 + 当前项目级)里有没有同名条目 —— 有的话它**优先于**本包的注册。
 * 迁移期最常见的疑惑就是「我装了包,`/mcp` 里怎么还是旧那条」,所以这条要能看见。
 */
export function bowInMcpJson(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string[] {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
  const files = [join(agentDir, 'mcp.json'), join(cwd, '.pi', 'mcp.json')]
  const hits: string[] = []
  for (const file of files) {
    try {
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { mcpServers?: Record<string, unknown> }
      if (parsed?.mcpServers && BOW_MCP_SERVER in parsed.mcpServers) hits.push(file)
    } catch {
      /* 读不动/不是 JSON:不是这个命令要解决的问题 */
    }
  }
  return hits
}

/** 本包版本(给 `/bow` 显示;读不到就说 unknown,不抛) */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export interface BowMcpReport {
  version: string
  url: string
  enabled: boolean
  reachable: boolean
  registered: boolean
  /** `mcp.json` 里存在同名条目(它会覆盖本包) */
  overriddenBy: string[]
}

/** `/bow status` 的纯文本渲染(纯函数:假数据就能测) */
export function formatBowMcpReport(r: BowMcpReport): string {
  const lines = [`pi-bow ${r.version}`, `MCP 端点:${r.url}`]
  if (!r.enabled) lines.push('状态:BOW_MCP=0,本次会话未注册')
  else if (!r.reachable) lines.push('状态:端点连不上 —— 先启动 bow,或用 BOW_MCP_URL 指对端口,然后 /bow reload')
  else if (r.registered) lines.push('状态:已注册(工具:mcp__browser__*)')
  else lines.push('状态:端点可达但未注册 —— /bow on 试一次')
  if (r.overriddenBy.length > 0) {
    lines.push(`注意:${r.overriddenBy.join('、')} 里有同名条目,它优先于本包(迁移时删掉它或改由本包负责)`)
  }
  return lines.join('\n')
}

/** 采集一份当前状态(`/bow` 用;探测有 ~400ms 上限) */
export async function collectBowMcpReport(pi: ExtensionAPI, env: Record<string, string | undefined> = process.env): Promise<BowMcpReport> {
  const cfg = readBowMcpConfig(env)
  return {
    version: packageVersion(),
    url: cfg.url,
    enabled: cfg.enabled,
    reachable: cfg.enabled ? await isReachable(cfg.url) : false,
    registered: registeredBowMcp(pi),
    overriddenBy: bowInMcpJson(env)
  }
}
