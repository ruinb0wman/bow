/** CORS 放行白名单:主机(域名 / IP)规范化与匹配,main / renderer / tests 三端复用,无 electron 依赖 */

/** 默认预填:本机回环地址,开箱即用(用户可增删) */
export const CORS_DEFAULT_LIST: string[] = ['localhost', '127.0.0.1', '[::1]']

/** URL 前缀(scheme://) */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

/** 主机名:单标签(localhost)或多标签域名 */
const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

/** IPv4:严格四段 0-255 */
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** IPv6 字面量(含 :: 压缩) */
const IPV6_RE =
  /^(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?:(?::[0-9a-f]{1,4}){1,7}|:))$/

function isValidPort(p: string): boolean {
  if (!/^\d{1,5}$/.test(p)) return false
  const n = Number(p)
  return n >= 1 && n <= 65535
}

/**
 * 规范化白名单条目:
 * - 去空白、剥离 http(s):// 前缀与路径/查询/锚点
 * - 支持:host / host:port / *.host (子域通配) / IPv4 / [IPv6][:port],大小写折叠
 * - 非法输入返回 null(供 UI 校验与保存前清洗)
 */
export function normalizeCorsEntry(input: string): string | null {
  let s = input.trim()
  if (!s) return null
  const scheme = s.match(SCHEME_RE)
  if (scheme) s = s.slice(scheme[0].length)
  const cut = s.search(/[/?#]/)
  if (cut >= 0) s = s.slice(0, cut)
  s = s.trim().toLowerCase()
  if (!s || s.length > 253) return null

  // IPv6 字面量:[::1] 或 [::1]:8080
  const v6 = s.match(/^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/)
  if (v6) {
    if (!IPV6_RE.test(v6[1])) return null
    if (v6[2] && !isValidPort(v6[2])) return null
    return s
  }

  // 子域通配前缀,仅允许一层
  let host = s
  if (host.startsWith('*.')) host = host.slice(2)
  else if (host.startsWith('*')) return null

  // 可选 :port
  let port: string | null = null
  const colon = host.lastIndexOf(':')
  if (colon >= 0) {
    const maybePort = host.slice(colon + 1)
    if (isValidPort(maybePort)) {
      port = maybePort
      host = host.slice(0, colon)
    } else {
      return null
    }
  }
  if (!host) return null
  // 全数字加点(形如 IP)的条目按 IPv4 严格校验,拒绝 192.168.1.999 这类陷阱
  if (/^(?:[0-9]+\.)+[0-9]+$/.test(host)) {
    if (!IPV4_RE.test(host)) return null
  } else if (!HOSTNAME_RE.test(host)) {
    return null
  }
  return s
}

/** 从 URL 取规范化主机名(去掉 IPv6 方括号、折叠大小写) */
function hostnameOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

/**
 * 判定 URL 目标主机是否在白名单中:
 * - 裸主机:任意端口
 * - host:port:仅该端口(默认端口 80/443 归一化)
 * - *.host:任意深度子域,不含 apex,不认端口
 * - 仅 http(s);URL 解析失败或非字符串条目一律 false
 */
export function isCorsWhitelisted(url: string, list: string[]): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const hostname = hostnameOf(u)
  let port = u.port
  if (!port) port = u.protocol === 'https:' ? '443' : '80'

  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const entry = raw.trim().toLowerCase()
    if (!entry) continue

    // IPv6 条目(规范化后必带方括号)
    const v6 = entry.match(/^\[([0-9a-f:]+)\](?::(\d+))?$/)
    if (v6) {
      if (v6[1] !== hostname) continue
      if (v6[2] && v6[2] !== port) continue
      return true
    }

    // 可选 :port
    let hostPart = entry
    let entryPort: string | null = null
    const colon = hostPart.lastIndexOf(':')
    if (colon >= 0 && /^\d+$/.test(hostPart.slice(colon + 1))) {
      entryPort = hostPart.slice(colon + 1)
      hostPart = hostPart.slice(0, colon)
    }

    // 子域通配:*.example.com 命中任意深度子域,不命中 example.com
    if (hostPart.startsWith('*.')) {
      if (!hostname.endsWith('.' + hostPart.slice(2))) continue
      if (entryPort && entryPort !== port) continue
      return true
    }

    if (hostPart !== hostname) continue
    if (entryPort && entryPort !== port) continue
    return true
  }
  return false
}

/** 判定发起页面(来源)是否属于白名单主机(本地开发页等) */
export function isCorsWhitelistedPage(pageUrl: string | null | undefined, list: string[]): boolean {
  if (!pageUrl) return false
  return isCorsWhitelisted(pageUrl, list)
}

/**
 * 判定某请求是否应注入 CORS 放行头:
 * - 请求目标在白名单(响应侧放行),或
 * - 发起页面在白名单(来源侧放行:local 页面可自由请求任意目标)
 */
export function shouldBypassCors(
  targetUrl: string,
  pageUrl: string | null | undefined,
  list: string[]
): boolean {
  return isCorsWhitelisted(targetUrl, list) || isCorsWhitelistedPage(pageUrl, list)
}

/** 预检请求判定:OPTIONS + Access-Control-Request-Method 请求头 */
export function isPreflightRequest(
  method: string | undefined,
  requestHeaders: Record<string, string | string[]> | undefined
): boolean {
  if (method !== 'OPTIONS') return false
  if (!requestHeaders) return false
  for (const name of Object.keys(requestHeaders)) {
    if (name.toLowerCase() === 'access-control-request-method') return true
  }
  return false
}

/** opencode 托管 API 主机(zen / go 等入口均在其域名下) */
export function isOpenCodeHost(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  return h === 'opencode.ai' || h.endsWith('.opencode.ai')
}