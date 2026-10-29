/**
 * 代理配置（纯逻辑，三端共享）。
 *
 * 为什么需要这个设置：Electron 主进程里 Node 的 `fetch` 不读系统代理也不读 `HTTP(S)_PROXY`，
 * Chromium 只认系统代理（Linux 上常见的是压根没配）。所以给用户一个显式的「代理地址」，
 * 落到 Chromium 的 session 上，网页与 `net.fetch` 都走它。
 *
 * 优先级（用户选定）：设置 > 环境变量 > 系统。
 * 三个模式也可以从界面点出来：手动 / 直连 / 跟随系统。
 */

export type ProxyMode = 'system' | 'direct' | 'manual'

/** settings.json 里的两个字段（`proxyMode` 缺省 = 自动：环境变量 → 系统） */
export interface ProxySettings {
  proxyMode?: ProxyMode
  proxyServer?: string
}

export type ProxySource = 'settings' | 'env'

export type ProxyDecision =
  | { kind: 'manual'; server: string; source: ProxySource }
  | { kind: 'direct' }
  | { kind: 'system' }

const SCHEMES = new Set(['http:', 'https:', 'socks4:', 'socks5:'])

/**
 * 规范化用户输入：`127.0.0.1:7890` → `http://127.0.0.1:7890`；非法或空 → null。
 *
 * 只保留 `协议//host:port`：路径、查询、账号密码一律丢掉（Chromium 的 `proxyRules` 里
 * 账号密码既不生效也会进日志）。协议只认 http(s)/socks4/socks5。
 */
export function normalizeProxyServer(input: string | undefined): string | null {
  const text = (input ?? '').trim()
  if (!text) return null
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(text) ? text : `http://${text}`
  try {
    const url = new URL(withScheme)
    if (!SCHEMES.has(url.protocol) || !url.hostname) return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/**
 * 决定这次该给 Chromium 什么代理配置。
 *
 * `manual` 但地址不可解析时**退回跟随**（而不是直连）：宁可走系统代理，也不要因为一个手滑的
 * 地址把整个网络掐死。
 */
export function resolveProxy(settings: ProxySettings, envRaw: string | undefined): ProxyDecision {
  const mode = settings.proxyMode
  if (mode === 'direct') return { kind: 'direct' }
  if (mode === 'system') return { kind: 'system' }

  const own = normalizeProxyServer(settings.proxyServer)
  if (mode === 'manual' && own) return { kind: 'manual', server: own, source: 'settings' }

  const env = normalizeProxyServer(envRaw)
  if (env) return { kind: 'manual', server: env, source: 'env' }

  return { kind: 'system' }
}
