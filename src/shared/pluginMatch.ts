/**
 * 插件匹配纯逻辑(可单测):URL 通配模式 + 主机名/子域匹配。
 * 同时服务内容注入(matches / excludeMatches)与广告插件的域名清单。
 */

const patternCache = new Map<string, RegExp>()

function escapeRe(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? '\\' + ch : ch
}

/** 通配模式 → 锚定正则:星号匹配任意字符,问号匹配单字符,<all_urls> 匹配任意 URL */
export function compileUrlPattern(pattern: string): RegExp {
  const cached = patternCache.get(pattern)
  if (cached) return cached
  const trimmed = pattern.trim()
  if (trimmed === '<all_urls>') {
    const all = /^[a-z][a-z0-9+.-]*:\/\/.*$/i
    patternCache.set(pattern, all)
    return all
  }
  let out = ''
  for (const ch of trimmed) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += escapeRe(ch)
  }
  const re = new RegExp('^' + out + '$', 'i')
  patternCache.set(pattern, re)
  return re
}

export function matchUrlPattern(pattern: string, url: string): boolean {
  try {
    return compileUrlPattern(pattern).test(url)
  } catch {
    return false
  }
}

export function matchAnyUrl(patterns: string[], url: string): boolean {
  return patterns.some((p) => matchUrlPattern(p, url))
}

/** 内容注入匹配:任一 matches 命中,且没有任何 excludeMatches 命中 */
export function matchUrl(url: string, matches: string[], excludeMatches: string[] = []): boolean {
  if (matches.length === 0) return false
  if (excludeMatches.length > 0 && matchAnyUrl(excludeMatches, url)) return false
  return matchAnyUrl(matches, url)
}

function splitHostPort(value: string): { host: string; port?: string } {
  const v = value.trim().toLowerCase()
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    if (end >= 0) {
      const rest = v.slice(end + 1)
      return { host: v.slice(0, end + 1), port: rest.startsWith(':') ? rest.slice(1) : undefined }
    }
  }
  const i = v.lastIndexOf(':')
  if (i > 0 && v.indexOf(':') === i) return { host: v.slice(0, i), port: v.slice(i + 1) }
  return { host: v }
}

/**
 * 主机名匹配(pattern 为域名 / *.子域 / host:port;host 可带端口):
 * - `*.example.com` → 命中子域 `a.example.com`,不命中 apex `example.com`;
 * - `example.com`   → 命中 apex 与任意子域;
 * - 带端口时端口必须一致。
 */
export function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.trim()
  if (!p) return false
  const subdomainOnly = p.startsWith('*.')
  const pParts = splitHostPort(subdomainOnly ? p.slice(2) : p)
  const hParts = splitHostPort(host)
  if (!pParts.host) return false
  if (pParts.port && pParts.port !== hParts.port) return false
  if (subdomainOnly) return hParts.host.endsWith('.' + pParts.host)
  return hParts.host === pParts.host || hParts.host.endsWith('.' + pParts.host)
}

/** 取 URL 的主机名(含端口);解析失败返回空串 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
