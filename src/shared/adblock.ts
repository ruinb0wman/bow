/**
 * 广告/追踪拦截规则模型(同构纯逻辑,无 electron / DOM 依赖,可单测)。
 *
 * 两类规则:
 * - 网络规则 NetworkRule:block / allow,模式支持 host、*.host、URL 通配、||host^;
 * - 元素规则 CosmeticRule:hide / unhide,按域(domain 为 * 表示全站)隐藏 CSS 选择器。
 *
 * 同时提供 EasyList / AdGuard 常用语法子集的解析、序列化与 v1 → v2 迁移。
 */

import { hostMatches, hostOf, matchUrlPattern } from './pluginMatch'

export type NetworkRuleType = 'block' | 'allow'
export type CosmeticRuleType = 'hide' | 'unhide'
export type RuleSource = 'builtin' | 'user' | 'picker'

export interface NetworkRule {
  id: string
  type: NetworkRuleType
  /** host | *.host | URL 通配 | ||host^ */
  pattern: string
  enabled: boolean
  source: RuleSource
  createdAt: number
  note?: string
}

export interface CosmeticRule {
  id: string
  type: CosmeticRuleType
  /** '*' = 全站;否则匹配该域及其子域 */
  domain: string
  selector: string
  enabled: boolean
  source: RuleSource
  createdAt: number
  note?: string
}

export interface AdblockConfig {
  version: 2
  enabled: boolean
  blockedCount: number
  networkRules: NetworkRule[]
  cosmeticRules: CosmeticRule[]
}

// ---------- 默认规则(沿用参考插件原有清单) ----------

/** 小型静态清单(演示用,非 EasyList):apex 域名同时覆盖其子域 */
export const DEFAULT_BLOCKLIST: string[] = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagservices.com',
  'googleadservices.com',
  'adservice.google.com',
  'scorecardresearch.com',
  'adnxs.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
  '2mdn.net',
  'moatads.com',
  'adsafeprotected.com'
]

/** 默认元素隐藏选择器(原 HIDE_ADS_CSS 拆成独立规则) */
export const DEFAULT_HIDE_SELECTORS: string[] = [
  '.adsbygoogle',
  'ins.adsbygoogle',
  '[id^="google_ads_"]',
  '[id^="div-gpt-ad"]',
  '[class*="sponsored-ad"]',
  'iframe[src*="doubleclick.net"]'
]

let idCounter = 0

/** 生成规则 id(主进程 / 渲染层 / 测试均可用,无需 crypto) */
export function newRuleId(prefix: string): string {
  idCounter += 1
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${rand}`
}

// ---------- 规则构造 ----------

export function createNetworkRule(
  type: NetworkRuleType,
  pattern: string,
  patch: Partial<Pick<NetworkRule, 'enabled' | 'source' | 'note'>> = {}
): NetworkRule {
  return {
    id: newRuleId('n'),
    type,
    pattern: pattern.trim(),
    enabled: patch.enabled ?? true,
    source: patch.source ?? 'user',
    createdAt: Date.now(),
    note: patch.note
  }
}

export function createCosmeticRule(
  type: CosmeticRuleType,
  domain: string,
  selector: string,
  patch: Partial<Pick<CosmeticRule, 'enabled' | 'source' | 'note'>> = {}
): CosmeticRule {
  return {
    id: newRuleId('c'),
    type,
    domain: normalizeRuleDomain(domain) || '*',
    selector: selector.trim(),
    enabled: patch.enabled ?? true,
    source: patch.source ?? 'user',
    createdAt: Date.now(),
    note: patch.note
  }
}

export function createDefaultNetworkRules(): NetworkRule[] {
  return DEFAULT_BLOCKLIST.map((pattern) => createNetworkRule('block', pattern, { source: 'builtin' }))
}

export function createDefaultCosmeticRules(): CosmeticRule[] {
  return DEFAULT_HIDE_SELECTORS.map((selector) => createCosmeticRule('hide', '*', selector, { source: 'builtin' }))
}

export function createDefaultConfig(): AdblockConfig {
  return {
    version: 2,
    enabled: true,
    blockedCount: 0,
    networkRules: createDefaultNetworkRules(),
    cosmeticRules: createDefaultCosmeticRules()
  }
}

// ---------- 域与模式匹配 ----------

/** 规范化规则域:去协议 / 路径 / 前导点与 www.;空串或 * 表示全站 */
export function normalizeRuleDomain(input: string): string {
  let d = (input || '').trim().toLowerCase()
  if (!d) return ''
  if (d === '*') return '*'
  if (d.includes('://')) {
    try {
      d = new URL(d).host
    } catch {
      // 保留原值继续清理
    }
  }
  d = d.split('/')[0].split('?')[0]
  d = d.replace(/^\.+/, '').replace(/^www\./, '')
  return d
}

/** domain 为 * 或命中 host 及其子域 */
export function domainMatches(domain: string, host: string): boolean {
  const d = (domain || '').trim().toLowerCase()
  if (!d || d === '*') return true
  return hostMatches(host, d)
}

/**
 * 网络规则模式匹配:
 * - `||host^` → 取主机锚点走 hostMatches;
 * - 含 `*` / `?` / `://` / `/` → URL 通配(未显式锚定时按 *pattern* 包裹);
 * - 其余按 host / *.host。
 */
export function networkPatternMatches(pattern: string, url: string): boolean {
  let p = (pattern || '').trim()
  if (!p) return false
  // 容错:若模式后面带了 $options,剥离后再匹配
  const dollar = p.lastIndexOf('$')
  if (dollar > 0 && /^[a-z~][a-z0-9~=_,-]*$/i.test(p.slice(dollar + 1))) p = p.slice(0, dollar)
  if (!p) return false
  const host = hostOf(url)
  if (!host) return false

  if (p.startsWith('||')) {
    let inner = p.slice(2)
    const cut = inner.search(/[\^/]/)
    if (cut >= 0) inner = inner.slice(0, cut)
    return inner ? hostMatches(host, inner) : false
  }

  // 裸主机锚点 `example.com^`(无通配/路径)按主机匹配
  if (p.endsWith('^') && !/[*?/]/.test(p)) {
    return hostMatches(host, p.slice(0, -1))
  }

  if (/[*?]/.test(p) || p.includes('://') || p.includes('/')) {
    let glob = p
    let anchoredStart = false
    let anchoredEnd = false
    if (glob.startsWith('|')) {
      anchoredStart = true
      glob = glob.slice(1)
    }
    if (glob.endsWith('|')) {
      anchoredEnd = true
      glob = glob.slice(0, -1)
    }
    if (!anchoredStart && !glob.startsWith('*')) glob = '*' + glob
    if (!anchoredEnd && !glob.endsWith('*')) glob = glob + '*'
    return matchUrlPattern(glob, url)
  }

  return hostMatches(host, p)
}

/** allow 规则优先:任一启用的 allow 命中即放行;否则任一启用的 block 命中即拦截 */
export function isNetworkBlocked(url: string, rules: NetworkRule[]): boolean {
  let allowed = false
  let blocked = false
  for (const r of rules) {
    if (!r.enabled || !r.pattern) continue
    if (!networkPatternMatches(r.pattern, url)) continue
    if (r.type === 'allow') allowed = true
    else blocked = true
  }
  return blocked && !allowed
}

/** 按页面 host 生成元素隐藏 CSS;每个选择器一条独立规则,坏选择器不影响其他规则 */
export function buildCosmeticCss(host: string, rules: CosmeticRule[]): string {
  if (!host) return ''
  const hidden = new Set<string>()
  const unhidden = new Set<string>()
  for (const r of rules) {
    if (!r.enabled || !r.selector) continue
    if (!domainMatches(r.domain, host)) continue
    if (r.type === 'hide') hidden.add(r.selector)
    else unhidden.add(r.selector)
  }
  const out: string[] = []
  for (const sel of hidden) {
    if (unhidden.has(sel)) continue
    out.push(`${sel}{display:none!important}`)
  }
  return out.join('\n')
}

// ---------- 去重与等价判断 ----------

export function sameNetworkRule(a: NetworkRule, b: Pick<NetworkRule, 'type' | 'pattern'>): boolean {
  return a.type === b.type && a.pattern.trim().toLowerCase() === b.pattern.trim().toLowerCase()
}

export function sameCosmeticRule(a: CosmeticRule, b: Pick<CosmeticRule, 'type' | 'domain' | 'selector'>): boolean {
  return (
    a.type === b.type &&
    (normalizeRuleDomain(a.domain) || '*') === (normalizeRuleDomain(b.domain) || '*') &&
    a.selector.trim() === b.selector.trim()
  )
}

export function dedupeNetworkRules(rules: NetworkRule[]): NetworkRule[] {
  const seen = new Set<string>()
  const out: NetworkRule[] = []
  for (const r of rules) {
    const key = r.type + '|' + r.pattern.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

export function dedupeCosmeticRules(rules: CosmeticRule[]): CosmeticRule[] {
  const seen = new Set<string>()
  const out: CosmeticRule[] = []
  for (const r of rules) {
    const key = r.type + '|' + (normalizeRuleDomain(r.domain) || '*') + '|' + r.selector.trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

// ---------- 迁移 ----------

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function normalizeNetworkRule(raw: unknown): NetworkRule | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const pattern = asText(o.pattern).trim()
  if (!pattern) return null
  const source = o.source === 'builtin' ? 'builtin' : 'user'
  return {
    id: asText(o.id) || newRuleId('n'),
    type: o.type === 'allow' ? 'allow' : 'block',
    pattern,
    enabled: asBool(o.enabled, true),
    source,
    createdAt: asNumber(o.createdAt, Date.now()),
    note: asText(o.note) || undefined
  }
}

function normalizeCosmeticRule(raw: unknown): CosmeticRule | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const selector = asText(o.selector).trim()
  if (!selector) return null
  const source: RuleSource = o.source === 'builtin' ? 'builtin' : o.source === 'picker' ? 'picker' : 'user'
  return {
    id: asText(o.id) || newRuleId('c'),
    type: o.type === 'unhide' ? 'unhide' : 'hide',
    domain: normalizeRuleDomain(asText(o.domain)) || '*',
    selector,
    enabled: asBool(o.enabled, true),
    source,
    createdAt: asNumber(o.createdAt, Date.now()),
    note: asText(o.note) || undefined
  }
}

/** v1 `{ enabled, blockedCount, rules: string[] }` → v2;v2 幂等;空值/占位默认 → 默认 */
export function migrateConfig(raw: unknown): AdblockConfig {
  if (!raw || typeof raw !== 'object') return createDefaultConfig()
  const o = raw as Record<string, unknown>

  // v1 优先:历史文件没有 networkRules,但有 rules(存储层浅合并会保留该字段)
  if (Array.isArray(o.rules) && !Array.isArray(o.networkRules)) {
    const networkRules = (o.rules as unknown[])
      .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
      .map((pattern) => createNetworkRule('block', pattern))
    return {
      version: 2,
      enabled: asBool(o.enabled, true),
      blockedCount: asNumber(o.blockedCount, 0),
      networkRules: dedupeNetworkRules(networkRules),
      cosmeticRules: createDefaultCosmeticRules()
    }
  }

  if (o.version === 2 || Array.isArray(o.networkRules) || Array.isArray(o.cosmeticRules)) {
    const networkRules = (Array.isArray(o.networkRules) ? o.networkRules : [])
      .map(normalizeNetworkRule)
      .filter((r): r is NetworkRule => r != null)
    const cosmeticRules = (Array.isArray(o.cosmeticRules) ? o.cosmeticRules : [])
      .map(normalizeCosmeticRule)
      .filter((r): r is CosmeticRule => r != null)
    return {
      version: 2,
      enabled: asBool(o.enabled, true),
      blockedCount: asNumber(o.blockedCount, 0),
      networkRules: dedupeNetworkRules(networkRules),
      cosmeticRules: dedupeCosmeticRules(cosmeticRules)
    }
  }

  return createDefaultConfig()
}

// ---------- 文本规则解析 / 序列化(AdGuard 语法子集) ----------

export interface ParseSummary {
  imported: number
  network: number
  cosmetic: number
  skipped: { count: number; samples: string[] }
}

export interface ParsedRules {
  networkRules: NetworkRule[]
  cosmeticRules: CosmeticRule[]
  summary: ParseSummary
}

const SKIP_SAMPLE_LIMIT = 5

function stripOptions(line: string): { pattern: string; options: string[] } {
  const idx = line.lastIndexOf('$')
  if (idx < 0) return { pattern: line, options: [] }
  const after = line.slice(idx + 1).trim()
  if (!/^[a-z~][a-z0-9~=_,-]*$/i.test(after)) return { pattern: line, options: [] }
  return { pattern: line.slice(0, idx), options: after.split(',').map((s) => s.trim()).filter(Boolean) }
}

function hasSkippableOption(options: string[]): boolean {
  return options.some((opt) => {
    if (opt.startsWith('~')) return false
    const name = opt.split('=')[0]
    return name === 'document' || name === 'main_frame' || name === 'csp' || name === 'rewrite'
  })
}

function cosmeticFromLine(
  line: string,
  separator: string,
  type: CosmeticRuleType,
  skip: (line: string) => void
): CosmeticRule[] {
  const idx = line.indexOf(separator)
  const domainsPart = line.slice(0, idx)
  const selector = line.slice(idx + separator.length).trim()
  if (!selector) {
    skip(line)
    return []
  }
  const domains = domainsPart
    .split(',')
    .map(normalizeRuleDomain)
    .filter(Boolean)
  if (domains.length === 0) return [createCosmeticRule(type, '*', selector)]
  return domains.map((d) => createCosmeticRule(type, d, selector))
}

/** 解析 AdGuard/EasyList 常用语法子集;不支持的行跳过并计入 summary.skipped */
export function parseRuleText(text: string): ParsedRules {
  const networkRules: NetworkRule[] = []
  const cosmeticRules: CosmeticRule[] = []
  let skippedCount = 0
  const samples: string[] = []
  const skip = (line: string): void => {
    skippedCount += 1
    if (samples.length < SKIP_SAMPLE_LIMIT) samples.push(line)
  }

  for (const rawLine of (text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('!') || line.startsWith('[')) continue
    // scriptlet / 扩展选择器:不支持,整行跳过
    if (line.includes('#$#') || line.includes('#@$#') || line.includes('#?#')) {
      skip(line)
      continue
    }
    if (line.includes('#@#')) {
      cosmeticRules.push(...cosmeticFromLine(line, '#@#', 'unhide', skip))
      continue
    }
    if (line.includes('##')) {
      cosmeticRules.push(...cosmeticFromLine(line, '##', 'hide', skip))
      continue
    }
    if (line.startsWith('@@')) {
      const { pattern, options } = stripOptions(line.slice(2))
      if (!pattern.trim() || hasSkippableOption(options)) {
        skip(line)
        continue
      }
      networkRules.push(createNetworkRule('allow', pattern))
      continue
    }
    const { pattern, options } = stripOptions(line)
    if (!pattern.trim() || hasSkippableOption(options)) {
      skip(line)
      continue
    }
    networkRules.push(createNetworkRule('block', pattern))
  }

  const net = dedupeNetworkRules(networkRules)
  const cos = dedupeCosmeticRules(cosmeticRules)
  return {
    networkRules: net,
    cosmeticRules: cos,
    summary: {
      imported: net.length + cos.length,
      network: net.length,
      cosmetic: cos.length,
      skipped: { count: skippedCount, samples }
    }
  }
}

export function serializeRuleText(
  networkRules: NetworkRule[],
  cosmeticRules: CosmeticRule[],
  opts: { includeBuiltin?: boolean } = {}
): string {
  const includeBuiltin = opts.includeBuiltin ?? true
  const lines: string[] = ['! bow adblock rules']
  for (const r of networkRules) {
    if (!includeBuiltin && r.source === 'builtin') continue
    lines.push((r.type === 'allow' ? '@@' : '') + r.pattern)
  }
  for (const r of cosmeticRules) {
    if (!includeBuiltin && r.source === 'builtin') continue
    const sep = r.type === 'unhide' ? '#@#' : '##'
    const domain = r.domain === '*' ? '' : r.domain
    lines.push(domain + sep + r.selector)
  }
  return lines.join('\n') + '\n'
}
