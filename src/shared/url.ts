import { CORS_DEFAULT_LIST } from './cors'
import type { SearchEngineId } from './types'

export const SEARCH_ENGINES: Record<SearchEngineId, { label: string; template: string }> = {
  google: { label: 'Google', template: 'https://www.google.com/search?q={q}' },
  duckduckgo: { label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={q}' },
  bing: { label: 'Bing', template: 'https://www.bing.com/search?q={q}' },
  baidu: { label: '百度', template: 'https://www.baidu.com/s?wd={q}' }
}

export const DEFAULT_SETTINGS = {
  searchEngine: 'google' as SearchEngineId,
  homepage: 'https://www.google.com',
  corsBypassEnabled: true,
  corsWhitelist: CORS_DEFAULT_LIST
}

/** 完整 scheme:// 前缀 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
/** 本地地址 */
const LOCAL_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i
/** 看起来像域名:xxx.yyy 形式,可带端口/路径/查询(不含空格) */
const DOMAIN_RE =
  /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:\d+)?(\/[^\s]*)?(\?[^\s]*)?(#[^\s]*)?$/

export type ParseResult = { kind: 'url'; url: string } | { kind: 'search'; query: string } | null

/**
 * 地址栏/搜索框输入解析:
 * - 空输入 → null
 * - 带协议前缀 → 直接视为 URL
 * - 含空格 → 视为搜索词
 * - 形如域名(xx.yy、localhost、IP) → URL(补 https://)
 * - 其余 → 搜索词
 */
export function parseInput(input: string): ParseResult {
  const raw = input.trim()
  if (!raw) return null
  if (SCHEME_RE.test(raw)) return { kind: 'url', url: raw }
  if (LOCAL_RE.test(raw)) return { kind: 'url', url: 'http://' + raw }
  if (DOMAIN_RE.test(raw)) return { kind: 'url', url: 'https://' + raw }
  if (/\s/.test(raw) || raw.includes('。')) return { kind: 'search', query: raw }
  return { kind: 'search', query: raw }
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

export function searchUrl(engine: SearchEngineId, query: string): string {
  const tpl = SEARCH_ENGINES[engine]?.template ?? SEARCH_ENGINES.google.template
  return tpl.replace('{q}', encodeURIComponent(query))
}

export type ResolveNavigationResult =
  | { parsed: 'url'; url: string; query?: undefined }
  | { parsed: 'search'; url: string; query: string }
  | null

/**
 * 地址栏输入 → 最终导航 URL:
 * - 空输入 → null
 * - URL → 原样返回
 * - 搜索词 → 按指定引擎拼出搜索 URL
 */
export function resolveNavigation(input: string, engine: SearchEngineId): ResolveNavigationResult {
  const parsed = parseInput(input)
  if (!parsed) return null
  if (parsed.kind === 'url') return { parsed: 'url', url: parsed.url }
  return { parsed: 'search', url: searchUrl(engine, parsed.query), query: parsed.query }
}

export function displayUrl(url: string): string {
  if (!url || url === 'about:blank') return ''
  return url
}