/**
 * 「异地访问(Tailscale)」自检:设置页 → 终端 → 远程 那张卡片的数据全部来自这里。
 *
 * 为什么是**探测**而不是集成:tailscale 是系统级常驻服务(装在哪台机器、谁登录、serve 指向哪),
 * bow 不是它的管理者。这里只读三件事 —— 有没有装、节点在不在线、serve 有没有指向本端口 ——
 * 然后把手该敲的那条命令交给用户复制。**绝不替用户改系统状态**(登录、up、serve 都不做)。
 *
 * 三条刻意的设计:
 * 1. **命令执行注入**(`TailscaleRunner`):测试里用假 runner 就能覆盖「没装 / 没登录 / 没配 serve」,
 *    不需要真装 tailscale;
 * 2. **失败只降级不抛**:CLI 缺失、非 0、超时、输出不是 JSON(版本改名)一律落到 `state`/`error`,
 *    页面显示一句话,不炸主进程;
 * 3. **只在被问的时候跑**:进设置页一次 + 「重新检查」按钮。不轮询、不订阅 —— 它不是会自己变的量。
 *
 * ⚠️ 这些信息**只走本地 IPC**,绝不可进远程 HTTP 面(`/healthz` 只回 ok/service/bind/sessions):
 * 那个页面是给还没登录的人看的。
 */

import type { TerminalTailscaleStatus } from '../shared'

/** 执行一条 CLI:成功返回 stdout;找不到 / 超时 / 非 0 一律 null(不抛) */
export type TailscaleRunner = (bin: string, args: string[]) => Promise<string | null>

/**
 * 依次尝试的二进制。第一条吃 PATH(三种系统装完都有);
 * 后两条是「PATH 里没有但基本确定装了」的兜底 —— Windows 默认安装位置,
 * 以及 bow 若跑在 WSL2 里时的 /mnt/c 互操作路径(interop 开着但 exe 不进 PATH)。
 */
export const TAILSCALE_BIN_CANDIDATES = [
  'tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  '/mnt/c/Program Files/Tailscale/tailscale.exe'
] as const

/** `tailscale status --json` 里我们要的那几个字段(其余一概不管) */
export interface TailscaleSnapshot {
  /** `Running` / `NeedsLogin` / `Stopped` / `Unknown` */
  backendState: string
  /** MagicDNS 名字,已去掉尾点:`albedo.tail36b860.ts.net` */
  host: string | null
  /** IPv4(100.64/10),没有就是 null */
  ip4: string | null
  /** 其它设备数 */
  peers: number
  /** 其中手机(android / ios)有几台 —— 「手机到底在网里吗」的唯一可靠答案 */
  phones: number
}

const BACKEND_STATES: Record<string, TerminalTailscaleStatus['state']> = {
  Running: 'running',
  NeedsLogin: 'needs-login',
  Stopped: 'stopped',
  NoState: 'stopped'
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text))
  } catch {
    return null
  }
}

/** `tailscale status --json` → 快照。字段全 optional:版本改了名就返回 null,由调用方降级 */
export function parseTailscaleStatus(text: string): TailscaleSnapshot | null {
  const data = parseObject(text)
  if (!data) return null
  const self = asObject(data['Self'])
  const dnsName = typeof self?.['DNSName'] === 'string' ? self['DNSName'] : ''
  const ips = Array.isArray(self?.['TailscaleIPs']) ? self['TailscaleIPs'] : []
  const ip4 = ips.find((ip): ip is string => typeof ip === 'string' && !ip.includes(':')) ?? null
  const peers = Object.values(asObject(data['Peer']) ?? {}).map(asObject)
  return {
    backendState: typeof data['BackendState'] === 'string' ? data['BackendState'] : 'Unknown',
    host: dnsName.replace(/\.$/, '') || null,
    ip4,
    peers: peers.filter((p) => p !== null).length,
    phones: peers.filter((p) => p?.['OS'] === 'android' || p?.['OS'] === 'ios').length
  }
}

/** `http://127.0.0.1:8770` → 8770;不是本机回环就 null(serve 指到别的机器不算) */
function proxyPort(proxy: string): number | null {
  try {
    const url = new URL(proxy)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return null
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80)) || null
  } catch {
    return null
  }
}

/**
 * `tailscale serve status --json` → 指向 **port** 的那条公网地址。
 * 真实形状:`{"TCP":{"443":{"HTTPS":true}},"Web":{"<host>:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8770"}}}}}`;
 * 没配 serve 时是 `{}`。指向别的端口 → 返回 null(页面会提示「serve 没指向本端口」)。
 */
export function parseServeStatus(text: string, port: number): { url: string; port: number } | null {
  const data = parseObject(text)
  const web = asObject(data?.['Web'])
  if (!web) return null
  const tcp = asObject(data?.['TCP'])
  for (const [key, value] of Object.entries(web)) {
    const proxy = asObject(asObject(asObject(value)?.['Handlers'])?.['/'])?.['Proxy']
    if (typeof proxy !== 'string' || proxyPort(proxy) !== port) continue
    const schemePort = key.slice(key.lastIndexOf(':') + 1)
    const secure = asObject(tcp?.[schemePort])?.['HTTPS'] === true
    return { url: `${secure ? 'https' : 'http'}://${key.slice(0, key.lastIndexOf(':'))}`, port }
  }
  return null
}

/** PATH 优先;都没有就返回 null。用 `version` 而不是 `status` 试:它不需要登录也不碰守护进程 */
async function findBin(run: TailscaleRunner): Promise<string | null> {
  for (const bin of TAILSCALE_BIN_CANDIDATES) {
    if ((await run(bin, ['version'])) !== null) return bin
  }
  return null
}

/** 自检。永不抛;`checkedAt` 由注入的时钟给(测试可固定) */
export async function probeTailscale(
  run: TailscaleRunner,
  port: number,
  now: () => number = Date.now
): Promise<TerminalTailscaleStatus> {
  const status: TerminalTailscaleStatus = {
    found: false,
    bin: null,
    state: 'missing',
    host: null,
    ip4: null,
    peers: 0,
    phones: 0,
    serve: null,
    error: null,
    checkedAt: now()
  }
  const bin = await findBin(run)
  if (!bin) return { ...status, error: '没找到 tailscale(试过 PATH 与 Windows 默认安装路径)' }

  const text = await run(bin, ['status', '--json'])
  if (text === null) {
    return { ...status, found: true, bin, state: 'unknown', error: '`tailscale status --json` 执行失败' }
  }
  const snapshot = parseTailscaleStatus(text)
  if (!snapshot) {
    return { ...status, found: true, bin, state: 'unknown', error: 'status 的 JSON 读不懂(客户端版本改名了?)' }
  }

  const state = BACKEND_STATES[snapshot.backendState] ?? 'unknown'
  const next: TerminalTailscaleStatus = {
    ...status,
    found: true,
    bin,
    state,
    host: snapshot.host,
    ip4: snapshot.ip4,
    peers: snapshot.peers,
    phones: snapshot.phones
  }
  // 没在跑就不问 serve:少起一个进程,也免得把「没登录」误报成「没配 serve」
  if (state !== 'running') return next

  const serveText = await run(bin, ['serve', '--json'])
  return serveText === null ? next : { ...next, serve: parseServeStatus(serveText, port) }
}
