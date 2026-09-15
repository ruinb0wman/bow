/**
 * 广告/追踪拦截规则模型(同构纯逻辑,无 electron / DOM 依赖,可单测)。
 *
 * 两类规则:
 * - 网络规则 NetworkRule:block / allow,模式支持 host、*.host、URL 通配、||host^,
 *   并按 AdGuard/uBO 子集解析 `$` 选项(third-party / 资源类型 / domain= / important / badfilter);
 * - 元素规则 CosmeticRule:hide / unhide,按域(domain 为 * 表示全站)隐藏 CSS 选择器,
 *   支持 `~domain` 排除域与 `@@||host^$generichide` 这类元素例外标记。
 *
 * 解析原则(不变式):**不认识的语法只能"跳过",绝不能降级成更强的规则** ——
 * 比如 `||x^$removeparam=` 绝不能被当成 `||x^`(整域拦截)落地。
 */

import { hostMatches, hostOf, matchUrlPattern } from './pluginMatch'

export type NetworkRuleType = 'block' | 'allow'
export type CosmeticRuleType = 'hide' | 'unhide'
export type RuleSource = 'builtin' | 'user' | 'picker' | 'subscription'

/** 网络规则的 `$` 选项(仅保留我们真正实现了语义的部分) */
export interface NetworkRuleOptions {
  /** true = 仅第三方请求;false = 仅第一方(`$~third-party`);undefined = 不限 */
  thirdParty?: boolean
  /** 正向资源类型(已规范化为 ABP 名,如 script / xmlhttprequest);空 = 不限 */
  resourceTypes?: string[]
  /** 负向资源类型(`$~image`),命中的请求不适用 */
  excludeResourceTypes?: string[]
  /** `$domain=a.com|~b.a.com`,按「发起请求的页面 host」匹配 */
  domains?: { include: string[]; exclude: string[] }
  /** `$important`:无视 `@@` 例外 */
  important?: boolean
}

export interface NetworkRule {
  id: string
  type: NetworkRuleType
  /** host | *.host | URL 通配 | ||host^ | ||host/path */
  pattern: string
  enabled: boolean
  source: RuleSource
  createdAt: number
  note?: string
  options?: NetworkRuleOptions
  /** 来自哪条订阅(订阅刷新时据此替换) */
  subscriptionId?: string
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
  /** `a.com,~sub.a.com##x` 里的排除域 */
  excludeDomains?: string[]
  subscriptionId?: string
}

/**
 * 元素例外标记(来自 `@@||host^$generichide` / `$elemhide` / `$specifichide`)。
 * 它不是网络放行规则 —— 早期版本把它当 allow 落地,导致整站被放行。
 */
export interface CosmeticFlagRule {
  id: string
  host: string
  /** true = 关闭该 host 上的泛化(无域)元素规则 */
  generic?: boolean
  /** true = 关闭该 host 上的专属元素规则 */
  specific?: boolean
  enabled: boolean
  source: RuleSource
  createdAt: number
  /** 来自哪条订阅(订阅刷新时据此替换) */
  subscriptionId?: string
}

export interface Subscription {
  id: string
  url: string
  title?: string
  enabled: boolean
  /** 上次成功更新时间(0 表示未更新过) */
  updatedAt: number
  error?: string
  /** 上次解析出的规则条数 */
  ruleCount?: number
}

export interface AdblockConfig {
  version: 3
  enabled: boolean
  blockedCount: number
  networkRules: NetworkRule[]
  cosmeticRules: CosmeticRule[]
  cosmeticFlags: CosmeticFlagRule[]
  subscriptions: Subscription[]
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

function cleanOptions(options?: NetworkRuleOptions): NetworkRuleOptions | undefined {
  if (!options) return undefined
  const out: NetworkRuleOptions = {}
  if (options.thirdParty !== undefined) out.thirdParty = options.thirdParty
  if (options.resourceTypes?.length) out.resourceTypes = [...new Set(options.resourceTypes)]
  if (options.excludeResourceTypes?.length) out.excludeResourceTypes = [...new Set(options.excludeResourceTypes)]
  if (options.domains && (options.domains.include.length || options.domains.exclude.length)) {
    out.domains = { include: [...new Set(options.domains.include)], exclude: [...new Set(options.domains.exclude)] }
  }
  if (options.important) out.important = true
  return Object.keys(out).length > 0 ? out : undefined
}

type NetworkRulePatch = Partial<Pick<NetworkRule, 'enabled' | 'source' | 'note' | 'options' | 'subscriptionId'>>
type CosmeticRulePatch = Partial<
  Pick<CosmeticRule, 'enabled' | 'source' | 'note' | 'excludeDomains' | 'subscriptionId'>
>

export function createNetworkRule(type: NetworkRuleType, pattern: string, patch: NetworkRulePatch = {}): NetworkRule {
  return {
    id: newRuleId('n'),
    type,
    pattern: pattern.trim(),
    enabled: patch.enabled ?? true,
    source: patch.source ?? 'user',
    createdAt: Date.now(),
    note: patch.note,
    options: cleanOptions(patch.options),
    subscriptionId: patch.subscriptionId
  }
}

export function createCosmeticRule(
  type: CosmeticRuleType,
  domain: string,
  selector: string,
  patch: CosmeticRulePatch = {}
): CosmeticRule {
  const excludeDomains = (patch.excludeDomains ?? [])
    .map((d) => normalizeRuleDomain(d))
    .filter((d) => d && d !== '*')
  return {
    id: newRuleId('c'),
    type,
    domain: normalizeRuleDomain(domain) || '*',
    selector: selector.trim(),
    enabled: patch.enabled ?? true,
    source: patch.source ?? 'user',
    createdAt: Date.now(),
    note: patch.note,
    excludeDomains: excludeDomains.length ? [...new Set(excludeDomains)] : undefined,
    subscriptionId: patch.subscriptionId
  }
}

export function createCosmeticFlagRule(
  host: string,
  kind: 'generic' | 'specific' | 'both',
  patch: Partial<Pick<CosmeticFlagRule, 'enabled' | 'source' | 'subscriptionId'>> = {}
): CosmeticFlagRule {
  return {
    id: newRuleId('f'),
    host: normalizeRuleDomain(host) || '*',
    generic: kind !== 'specific' ? true : undefined,
    specific: kind !== 'generic' ? true : undefined,
    enabled: patch.enabled ?? true,
    source: patch.source ?? 'user',
    createdAt: Date.now()
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
    version: 3,
    enabled: true,
    blockedCount: 0,
    networkRules: createDefaultNetworkRules(),
    cosmeticRules: createDefaultCosmeticRules(),
    cosmeticFlags: [],
    subscriptions: []
  }
}

// ---------- 域与模式匹配 ----------

/** 规范化规则域:去 `~` 前缀 / 协议 / 路径 / 前导点与 www.;空串或 * 表示全站 */
export function normalizeRuleDomain(input: string): string {
  let d = (input || '').trim().toLowerCase()
  if (!d) return ''
  d = d.replace(/^~+/, '')
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

/** URL 的主机名(不含端口) */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function escapeRegexChar(ch: string): string {
  return /[.+^${}()|[\]\\*?]/.test(ch) ? '\\' + ch : ch
}

/** ABP `^` 分隔符:非字母数字/下划线/-/./% 的任意字符,或字符串结尾 */
const SEPARATOR_SRC = '(?:[^A-Za-z0-9_\\-.%]|$)'

/** `||` 之后的尾部(路径 / ^ / 通配)按前缀匹配 URL 的主机之后部分 */
function tailMatches(tail: string, text: string): boolean {
  let t = tail
  let anchored = false
  if (t.endsWith('|')) {
    anchored = true
    t = t.slice(0, -1)
  }
  let src = ''
  for (const ch of t) {
    if (ch === '*') src += '.*'
    else if (ch === '?') src += '.'
    else if (ch === '^') src += SEPARATOR_SRC
    else src += escapeRegexChar(ch)
  }
  try {
    return new RegExp('^' + src + (anchored ? '$' : ''), 'i').test(text)
  } catch {
    return false
  }
}

/** 主机部分里带通配的极少数写法(`||*.example.com^`):退化为逐段通配 */
function globHostMatches(hostname: string, pattern: string): boolean {
  let src = ''
  for (const ch of pattern) {
    if (ch === '*') src += '[^.]*'
    else if (ch === '?') src += '[^.]'
    else src += escapeRegexChar(ch)
  }
  try {
    return new RegExp('^' + src + '$', 'i').test(hostname)
  } catch {
    return false
  }
}

/**
 * 网络规则模式匹配(只看 pattern,不看 `$` 选项):
 * - `||host^` / `||host/path` → 主机锚点 + 尾部前缀匹配;
 * - 含 `*` / `?` / `://` / `/` → URL 通配(未显式锚定时按 *pattern* 包裹);
 * - 其余按 host / *.host。
 * 含未解析 `$` 残留的模式一律不匹配(避免旧配置降级成整域拦截)。
 */
export function networkPatternMatches(pattern: string, url: string): boolean {
  const p = (pattern || '').trim()
  if (!p || p.includes('$')) return false
  const host = hostOf(url)
  const hostname = hostnameOf(url)
  if (!host || !hostname) return false

  if (p.startsWith('||')) {
    const rest = p.slice(2)
    const cut = rest.search(/[\^/]/)
    const hostPart = cut >= 0 ? rest.slice(0, cut) : rest
    const tail = cut >= 0 ? rest.slice(cut) : ''
    if (!hostPart) return false
    const wildcardHost = /[*?]/.test(hostPart)
    if (wildcardHost) {
      if (!globHostMatches(hostname, hostPart)) return false
    } else if (!hostMatches(host, hostPart)) {
      return false
    }
    if (!tail) return true
    const at = url.toLowerCase().indexOf(host.toLowerCase())
    if (at < 0) return false
    return tailMatches(tail, url.slice(at + host.length))
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

// ---------- `$` 选项解析 ----------

/** Electron resourceType → ABP 资源类型名 */
const ELECTRON_RESOURCE_TYPES: Record<string, string> = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'other',
  media: 'media',
  webSocket: 'websocket',
  other: 'other'
}

export function normalizeResourceType(electronType: string): string {
  if (!electronType) return ''
  return ELECTRON_RESOURCE_TYPES[electronType] ?? 'other'
}

/** ABP/uBO 资源类型别名 → 规范化名 */
const OPTION_TYPE_ALIASES: Record<string, string> = {
  script: 'script',
  js: 'script',
  image: 'image',
  img: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  object_subrequest: 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'subdocument',
  frame: 'subdocument',
  font: 'font',
  media: 'media',
  websocket: 'websocket',
  ping: 'ping',
  beacon: 'ping',
  other: 'other'
}

/** 泛化/专属元素隐藏开关(只在 `@@` 规则上有意义) */
const GENERIC_HIDE_OPTIONS: Record<string, 'generic' | 'specific' | 'both'> = {
  generichide: 'generic',
  ghide: 'generic',
  elemhide: 'both',
  ehide: 'both',
  specifichide: 'specific',
  shide: 'specific'
}

/** 明确知道但本轮不实现的选项:整行跳过(绝不能降级) */
const UNSUPPORTED_OPTIONS = new Set([
  'document',
  'doc',
  'popup',
  'csp',
  'rewrite',
  'redirect',
  'redirect-rule',
  'removeparam',
  'replace',
  'permissions',
  'header',
  'cookie',
  'inline-script',
  'inline-font',
  'genericblock',
  'denyallow',
  'method',
  'to',
  'from',
  'ipaddress',
  'webrtc',
  'match-case',
  'empty',
  'mp4',
  'noop',
  'strict1p',
  'strict3p'
])

/**
 * 切分 `pattern$opt1,opt2`。判定刻意保守:右侧含空白 / `$` / `/` 就不当作选项,
 * 此时整行会因「pattern 里残留 `$`」被调用方跳过(而不是当成整域拦截)。
 */
export function splitOptions(line: string): { pattern: string; options: string[] } {
  const raw = (line || '').trim()
  const idx = raw.lastIndexOf('$')
  if (idx <= 0) return { pattern: raw, options: [] }
  const after = raw.slice(idx + 1).trim()
  if (!after || /[\s$/]/.test(after)) return { pattern: raw, options: [] }
  const options = after
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (options.length === 0) return { pattern: raw, options: [] }
  return { pattern: raw.slice(0, idx), options }
}

export interface ParsedOptions {
  options: NetworkRuleOptions
  cosmeticFlag?: 'generic' | 'specific' | 'both'
  badfilter?: boolean
}

export type ParseOptionsResult = { ok: true; value: ParsedOptions } | { ok: false; reason: 'options' }

/**
 * 解析 `$` 选项。任一项未实现 → 整行不可用(返回 ok:false),由调用方计入 skipped。
 */
export function parseOptions(tokens: string[], type: NetworkRuleType): ParseOptionsResult {
  const options: NetworkRuleOptions = {}
  const positives: string[] = []
  const negatives: string[] = []
  let cosmeticFlag: ParsedOptions['cosmeticFlag']
  let badfilter = false

  for (const raw of tokens) {
    const tok = (raw || '').trim()
    if (!tok) continue
    const negated = tok.startsWith('~')
    const name = (negated ? tok.slice(1) : tok).toLowerCase()

    if (name === 'badfilter') {
      badfilter = true
      continue
    }
    if (name === 'important') {
      options.important = true
      continue
    }
    if (name === 'third-party' || name === '3p') {
      options.thirdParty = !negated
      continue
    }
    if (name === 'first-party' || name === '1p') {
      options.thirdParty = negated
      continue
    }
    // `$all`:不额外限制类型(主文档本来就不拦,语义等价)
    if (name === 'all') continue

    const resourceType = OPTION_TYPE_ALIASES[name]
    if (resourceType) {
      if (negated) negatives.push(resourceType)
      else positives.push(resourceType)
      continue
    }

    if (name.startsWith('domain=') || name.startsWith('from=')) {
      // 只实现经典 `$domain=`;`$from=` 是较新的同义语法,未验证 → 跳过
      if (name.startsWith('from=')) return { ok: false, reason: 'options' }
      const include: string[] = []
      const exclude: string[] = []
      for (const seg of name.slice('domain='.length).split('|')) {
        const s = seg.trim()
        if (!s) continue
        if (s.startsWith('~')) {
          const d = normalizeRuleDomain(s.slice(1))
          if (d) exclude.push(d)
        } else {
          const d = normalizeRuleDomain(s)
          if (d) include.push(d)
        }
      }
      if (include.length || exclude.length) options.domains = { include, exclude }
      continue
    }

    const flag = GENERIC_HIDE_OPTIONS[name]
    if (flag) {
      if (type !== 'allow') return { ok: false, reason: 'options' }
      cosmeticFlag = cosmeticFlag === undefined || cosmeticFlag === flag ? flag : 'both'
      continue
    }

    if (UNSUPPORTED_OPTIONS.has(name)) return { ok: false, reason: 'options' }
    // 完全未知的选项同样跳过
    return { ok: false, reason: 'options' }
  }

  if (positives.length) options.resourceTypes = [...new Set(positives)]
  if (negatives.length) options.excludeResourceTypes = [...new Set(negatives)]
  return { ok: true, value: { options: cleanOptions(options) ?? {}, cosmeticFlag, badfilter } }
}

/** 把选项还原成 `$...` 文本(导出 / 往返用) */
export function formatNetworkOptions(options?: NetworkRuleOptions): string {
  if (!options) return ''
  const parts: string[] = []
  if (options.thirdParty === true) parts.push('third-party')
  else if (options.thirdParty === false) parts.push('~third-party')
  if (options.resourceTypes?.length) parts.push(...options.resourceTypes)
  if (options.excludeResourceTypes?.length) parts.push(...options.excludeResourceTypes.map((t) => '~' + t))
  if (options.domains && (options.domains.include.length || options.domains.exclude.length)) {
    const segs = [...options.domains.include, ...options.domains.exclude.map((d) => '~' + d)]
    parts.push('domain=' + segs.join('|'))
  }
  if (options.important) parts.push('important')
  return parts.length ? '$' + parts.join(',') : ''
}

const REGISTRABLE_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/** 近似注册域:IP 原样,其余取最后两段(co.uk 之类会偏松,属已知偏差) */
function siteKey(hostname: string): string {
  const h = (hostname || '').toLowerCase()
  if (!h || REGISTRABLE_IPV4.test(h) || h.includes(':')) return h
  const parts = h.split('.')
  return parts.length <= 2 ? h : parts.slice(-2).join('.')
}

/** 第三方判定:页面 host 与请求 host 的近似注册域不同 */
export function isThirdPartyHost(pageHost: string, requestHost: string): boolean {
  const a = siteKey(pageHost)
  const b = siteKey(requestHost)
  if (!a || !b) return false
  return a !== b
}

/** 规则匹配所需的请求上下文 */
export interface NetworkMatchContext {
  /** Electron resourceType(如 mainFrame / script / xhr) */
  resourceType?: string
  /** 发起请求的页面 URL(onBeforeRequest 阶段由内核补上) */
  pageUrl?: string
}

function domainsMatchPage(domains: NonNullable<NetworkRuleOptions['domains']>, pageHost: string): boolean {
  if (domains.exclude.some((d) => hostMatches(pageHost, d))) return false
  if (domains.include.length === 0) return true
  return domains.include.some((d) => hostMatches(pageHost, d))
}

/** 规则(模式 + 选项)是否命中该请求 */
export function networkRuleMatches(rule: NetworkRule, url: string, ctx: NetworkMatchContext = {}): boolean {
  if (!rule.enabled || !rule.pattern) return false
  if (!networkPatternMatches(rule.pattern, url)) return false
  const o = rule.options
  if (!o) return true

  const type = normalizeResourceType(ctx.resourceType ?? '')
  if (o.resourceTypes?.length && !o.resourceTypes.includes(type)) return false
  if (o.excludeResourceTypes?.includes(type)) return false

  const pageHost = ctx.pageUrl ? hostnameOf(ctx.pageUrl) : ''
  if (o.domains) {
    // 拿不到页面地址时无法确认适用 → 不拦(宁可不拦,也不误拦)
    if (!pageHost) return false
    if (!domainsMatchPage(o.domains, pageHost)) return false
  }

  if (o.thirdParty !== undefined) {
    if (!pageHost) return false
    if (isThirdPartyHost(pageHost, hostnameOf(url)) !== o.thirdParty) return false
  }

  return true
}

// ---------- 规则索引与判定 ----------

export interface NetworkIndex {
  /** 主机锚点类规则(键为域名,支持子域查找) */
  byHost: Map<string, NetworkRule[]>
  /** 通配 / URL 类规则 */
  other: NetworkRule[]
  size: number
}

/** 规则模式能否归到某个主机键(否则进 other 走线性匹配) */
function hostKeyOf(pattern: string): string | null {
  const p = (pattern || '').trim()
  if (!p || p.includes('$')) return null
  if (p.startsWith('||')) {
    let inner = p.slice(2)
    const cut = inner.search(/[\^/]/)
    if (cut >= 0) inner = inner.slice(0, cut)
    if (!inner || /[*?]/.test(inner)) return null
    return inner.toLowerCase()
  }
  if (p.endsWith('^') && !/[*?/]/.test(p)) {
    const inner = p.slice(0, -1)
    if (!inner) return null
    return inner.toLowerCase()
  }
  if (!/[*?/]/.test(p) && !p.includes('://')) return p.toLowerCase()
  return null
}

/** 按主机键分桶,避免每次请求线性扫全表 */
export function buildNetworkIndex(rules: NetworkRule[]): NetworkIndex {
  const byHost = new Map<string, NetworkRule[]>()
  const other: NetworkRule[] = []
  for (const rule of rules) {
    const key = hostKeyOf(rule.pattern)
    if (key) {
      const arr = byHost.get(key)
      if (arr) arr.push(rule)
      else byHost.set(key, [rule])
    } else {
      other.push(rule)
    }
  }
  return { byHost, other, size: rules.length }
}

/** 取与该 URL 可能相关的候选规则(主机后缀桶 + 通配桶) */
export function candidateRules(index: NetworkIndex, url: string): NetworkRule[] {
  const host = hostOf(url)
  const hostname = hostnameOf(url)
  if (!hostname) return index.other
  const keys = new Set<string>()
  if (host) keys.add(host.toLowerCase())
  const labels = hostname.toLowerCase().split('.')
  for (let i = 0; i < labels.length; i++) keys.add(labels.slice(i).join('.'))
  const out: NetworkRule[] = []
  for (const key of keys) {
    const arr = index.byHost.get(key)
    if (arr) out.push(...arr)
  }
  if (index.other.length) out.push(...index.other)
  return out
}

/**
 * allow 优先于 block,`$important` 的 block 无视 allow;支持直接传规则数组(内部建索引)。
 */
export function isNetworkBlocked(
  url: string,
  rules: NetworkRule[] | NetworkIndex,
  ctx: NetworkMatchContext = {}
): boolean {
  const list = Array.isArray(rules) ? rules : candidateRules(rules, url)
  let blocked = false
  let allowed = false
  let importantBlock = false
  let importantAllow = false
  for (const rule of list) {
    if (!networkRuleMatches(rule, url, ctx)) continue
    if (rule.type === 'allow') {
      if (rule.options?.important) importantAllow = true
      else allowed = true
    } else if (rule.options?.important) {
      importantBlock = true
    } else {
      blocked = true
    }
  }
  if (importantAllow) return false
  if (importantBlock) return true
  return blocked && !allowed
}

/** 应用 `$badfilter`:删掉与之等价的规则(内置规则也能被关掉) */
export function removeBadfiltered(rules: NetworkRule[], badfilters: NetworkRule[]): NetworkRule[] {
  if (badfilters.length === 0) return rules
  const keys = new Set(badfilters.map((r) => networkRuleKey(r.type, r.pattern, r.options)))
  return rules.filter((r) => !keys.has(networkRuleKey(r.type, r.pattern, r.options)))
}

// ---------- 元素隐藏 ----------

/**
 * 按页面 host 生成元素隐藏 CSS;每个选择器一条独立规则,坏选择器不影响其他规则。
 * flags 来自 `$generichide` / `$elemhide` / `$specifichide`。
 */
export function buildCosmeticCss(host: string, rules: CosmeticRule[], flags: CosmeticFlagRule[] = []): string {
  if (!host) return ''
  let genericDisabled = false
  let specificDisabled = false
  for (const f of flags) {
    if (!f.enabled || !hostMatches(host, f.host)) continue
    if (f.generic) genericDisabled = true
    if (f.specific) specificDisabled = true
  }

  const hidden = new Set<string>()
  const unhidden = new Set<string>()
  for (const r of rules) {
    if (!r.enabled || !r.selector) continue
    const generic = !r.domain || r.domain === '*'
    if (generic ? genericDisabled : specificDisabled) continue
    if (!domainMatches(r.domain, host)) continue
    if (r.excludeDomains?.some((d) => hostMatches(host, d))) continue
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

function optionsKey(options?: NetworkRuleOptions): string {
  const parts: string[] = []
  if (options?.thirdParty !== undefined) parts.push('tp=' + String(options.thirdParty))
  if (options?.resourceTypes?.length) parts.push('rt=' + [...options.resourceTypes].sort().join('+'))
  if (options?.excludeResourceTypes?.length) parts.push('nrt=' + [...options.excludeResourceTypes].sort().join('+'))
  if (options?.domains) parts.push('dom=' + options.domains.include.join('+') + '|' + options.domains.exclude.join('+'))
  if (options?.important) parts.push('imp')
  return parts.join(';')
}

function networkRuleKey(type: NetworkRuleType, pattern: string, options?: NetworkRuleOptions): string {
  return type + '|' + pattern.trim().toLowerCase() + '|' + optionsKey(options)
}

export function sameNetworkRule(a: NetworkRule, b: Pick<NetworkRule, 'type' | 'pattern'> & { options?: NetworkRuleOptions }): boolean {
  return networkRuleKey(a.type, a.pattern, a.options) === networkRuleKey(b.type, b.pattern, cleanOptions(b.options))
}

function cosmeticRuleKey(r: Pick<CosmeticRule, 'type' | 'domain' | 'selector'> & { excludeDomains?: string[] }): string {
  const excludes = [...(r.excludeDomains ?? [])].map((d) => normalizeRuleDomain(d) || '*').sort()
  return r.type + '|' + (normalizeRuleDomain(r.domain) || '*') + '|' + r.selector.trim() + '|' + excludes.join('+')
}

export function sameCosmeticRule(
  a: CosmeticRule,
  b: Pick<CosmeticRule, 'type' | 'domain' | 'selector'> & { excludeDomains?: string[] }
): boolean {
  return cosmeticRuleKey(a) === cosmeticRuleKey(b)
}

export function dedupeNetworkRules(rules: NetworkRule[]): NetworkRule[] {
  const seen = new Set<string>()
  const out: NetworkRule[] = []
  for (const r of rules) {
    const key = networkRuleKey(r.type, r.pattern, r.options)
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
    const key = cosmeticRuleKey(r)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

export function dedupeCosmeticFlags(flags: CosmeticFlagRule[]): CosmeticFlagRule[] {
  const seen = new Set<string>()
  const out: CosmeticFlagRule[] = []
  for (const f of flags) {
    const key = (normalizeRuleDomain(f.host) || '*') + '|' + (f.generic ? 'g' : '') + (f.specific ? 's' : '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
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

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []
}

function normalizeOptions(raw: unknown): NetworkRuleOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const domainsRaw = o.domains as Record<string, unknown> | undefined
  return cleanOptions({
    thirdParty: typeof o.thirdParty === 'boolean' ? o.thirdParty : undefined,
    resourceTypes: asStringArray(o.resourceTypes),
    excludeResourceTypes: asStringArray(o.excludeResourceTypes),
    domains: domainsRaw
      ? {
          include: asStringArray(domainsRaw.include).map((d) => normalizeRuleDomain(d)),
          exclude: asStringArray(domainsRaw.exclude).map((d) => normalizeRuleDomain(d))
        }
      : undefined,
    important: o.important === true
  })
}

function normalizeSource(o: Record<string, unknown>): RuleSource {
  if (o.source === 'builtin') return 'builtin'
  if (o.source === 'picker') return 'picker'
  if (o.source === 'subscription') return 'subscription'
  return 'user'
}

function normalizeNetworkRule(raw: unknown): NetworkRule | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  let pattern = asText(o.pattern).trim()
  if (!pattern) return null
  const type: NetworkRuleType = o.type === 'allow' ? 'allow' : 'block'
  let options = normalizeOptions(o.options)

  // v2 遗留:早先把不认识的 `$选项` 塞进了 pattern —— 重解析,解析不了的停用而不是继续整域拦截
  if (pattern.includes('$')) {
    const split = splitOptions(pattern)
    const parsed = split.pattern && !split.pattern.includes('$') ? parseOptions(split.options, type) : null
    if (parsed && parsed.ok && !parsed.value.cosmeticFlag && !parsed.value.badfilter) {
      pattern = split.pattern
      options = cleanOptions({ ...parsed.value.options, ...options })
    } else {
      return {
        id: asText(o.id) || newRuleId('n'),
        type,
        pattern,
        enabled: false,
        source: normalizeSource(o),
        createdAt: asNumber(o.createdAt, Date.now()),
        note: '含未支持选项,已自动停用',
        options
      }
    }
  }

  return {
    id: asText(o.id) || newRuleId('n'),
    type,
    pattern,
    enabled: asBool(o.enabled, true),
    source: normalizeSource(o),
    createdAt: asNumber(o.createdAt, Date.now()),
    note: asText(o.note) || undefined,
    options,
    subscriptionId: asText(o.subscriptionId) || undefined
  }
}

function normalizeCosmeticRule(raw: unknown): CosmeticRule | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const selector = asText(o.selector).trim()
  if (!selector) return null
  const excludeDomains = asStringArray(o.excludeDomains).map((d) => normalizeRuleDomain(d)).filter(Boolean)
  return {
    id: asText(o.id) || newRuleId('c'),
    type: o.type === 'unhide' ? 'unhide' : 'hide',
    domain: normalizeRuleDomain(asText(o.domain)) || '*',
    selector,
    enabled: asBool(o.enabled, true),
    source: normalizeSource(o),
    createdAt: asNumber(o.createdAt, Date.now()),
    note: asText(o.note) || undefined,
    excludeDomains: excludeDomains.length ? excludeDomains : undefined,
    subscriptionId: asText(o.subscriptionId) || undefined
  }
}

function normalizeCosmeticFlagRule(raw: unknown): CosmeticFlagRule | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const host = normalizeRuleDomain(asText(o.host))
  if (!host) return null
  const generic = o.generic === true
  const specific = o.specific === true
  if (!generic && !specific) return null
  return {
    id: asText(o.id) || newRuleId('f'),
    host,
    generic: generic || undefined,
    specific: specific || undefined,
    enabled: asBool(o.enabled, true),
    source: normalizeSource(o),
    createdAt: asNumber(o.createdAt, Date.now())
  }
}

function normalizeSubscription(raw: unknown): Subscription | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const url = asText(o.url).trim()
  if (!/^https?:\/\//i.test(url)) return null
  return {
    id: asText(o.id) || newRuleId('s'),
    url,
    title: asText(o.title) || undefined,
    enabled: asBool(o.enabled, true),
    updatedAt: asNumber(o.updatedAt, 0),
    error: asText(o.error) || undefined,
    ruleCount: typeof o.ruleCount === 'number' && Number.isFinite(o.ruleCount) ? o.ruleCount : undefined
  }
}

/** v1 `{rules:string[]}` / v2(无选项/标记) / v3 一律迁到 v3;空值 → 默认配置 */
export function migrateConfig(raw: unknown): AdblockConfig {
  if (!raw || typeof raw !== 'object') return createDefaultConfig()
  const o = raw as Record<string, unknown>

  // v1 优先:历史文件没有 networkRules,但有 rules(存储层浅合并会保留该字段)
  if (Array.isArray(o.rules) && !Array.isArray(o.networkRules)) {
    const networkRules = (o.rules as unknown[])
      .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
      .map((pattern) => {
        const rule = normalizeNetworkRule({ pattern, type: 'block' })
        return rule ?? createNetworkRule('block', pattern)
      })
    return {
      version: 3,
      enabled: asBool(o.enabled, true),
      blockedCount: asNumber(o.blockedCount, 0),
      networkRules: dedupeNetworkRules(networkRules),
      cosmeticRules: createDefaultCosmeticRules(),
      cosmeticFlags: [],
      subscriptions: []
    }
  }

  if (
    o.version === 2 ||
    o.version === 3 ||
    Array.isArray(o.networkRules) ||
    Array.isArray(o.cosmeticRules) ||
    Array.isArray(o.cosmeticFlags) ||
    Array.isArray(o.subscriptions)
  ) {
    const networkRules = (Array.isArray(o.networkRules) ? o.networkRules : [])
      .map(normalizeNetworkRule)
      .filter((r): r is NetworkRule => r != null)
    const cosmeticRules = (Array.isArray(o.cosmeticRules) ? o.cosmeticRules : [])
      .map(normalizeCosmeticRule)
      .filter((r): r is CosmeticRule => r != null)
    const cosmeticFlags = (Array.isArray(o.cosmeticFlags) ? o.cosmeticFlags : [])
      .map(normalizeCosmeticFlagRule)
      .filter((f): f is CosmeticFlagRule => f != null)
    const subscriptions = (Array.isArray(o.subscriptions) ? o.subscriptions : [])
      .map(normalizeSubscription)
      .filter((s): s is Subscription => s != null)
    return {
      version: 3,
      enabled: asBool(o.enabled, true),
      blockedCount: asNumber(o.blockedCount, 0),
      networkRules: dedupeNetworkRules(networkRules),
      cosmeticRules: dedupeCosmeticRules(cosmeticRules),
      cosmeticFlags: dedupeCosmeticFlags(cosmeticFlags),
      subscriptions
    }
  }

  return createDefaultConfig()
}

// ---------- 文本规则解析 / 序列化(AdGuard / EasyList 子集) ----------

export type SkipReason = 'options' | 'scriptlet' | 'foreign' | 'other'

export interface ParseSummary {
  /** 网络 + 元素 + 元素例外标记 */
  imported: number
  network: number
  cosmetic: number
  cosmeticFlags: number
  badfilters: number
  skipped: {
    count: number
    samples: string[]
    reasons: Record<SkipReason, number>
    /** 识别出的非 ABP 格式(hosts / dnsmasq / clash …) */
    foreignFormats: string[]
  }
}

export interface ParsedRules {
  networkRules: NetworkRule[]
  cosmeticRules: CosmeticRule[]
  cosmeticFlags: CosmeticFlagRule[]
  /** `$badfilter` 指向的规则(由调用方从合并后的清单里删除) */
  badfilters: NetworkRule[]
  summary: ParseSummary
}

const SKIP_SAMPLE_LIMIT = 5

/** 行首 `#` 既可能是 hosts 注释,也可能是泛化元素规则(`##sel` / `#@#sel`)或 scriptlet 行 */
function isCosmeticOrScriptletLine(line: string): boolean {
  return (
    line.startsWith('##') ||
    line.startsWith('#@#') ||
    line.startsWith('#?#') ||
    line.startsWith('#@?#') ||
    line.startsWith('#$#') ||
    line.startsWith('#@$#') ||
    line.startsWith('#%#') ||
    line.startsWith('#@%#')
  )
}

/** scriptlet / 扩展选择器 / 过程式过滤:本轮不支持,整行跳过 */
const SCRIPTLET_MARKERS = ['#$#', '#@$#', '#%#', '#@%#', '#?#', '#@?#']
const PROCEDURAL_RE = /\+js\(|:has-text\(|:matches-|:style\(|:remove\(|:upward\(|:xpath\(|:watch-attr\(|-abp-/i

/** 非 ABP 格式识别:hosts / dnsmasq / unbound / Clash / Surge */
function detectForeignFormat(line: string): string | null {
  const l = line.trim()
  if (/^(0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+\S+/i.test(l)) return 'hosts'
  if (/^(0\.0\.0\.0|127\.0\.0\.1)\s*$/i.test(l)) return 'hosts'
  if (/^(address|server|local-zone)=/i.test(l)) return 'dnsmasq'
  if (
    /^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|DOMAIN-SET|DOMAIN-WILDCARD|HOST|HOST-SUFFIX|HOST-KEYWORD|IP-CIDR6?|GEOIP|RULE-SET|PROCESS-NAME|URL-REGEX|USER-AGENT),/i.test(
      l
    )
  ) {
    return 'clash'
  }
  if (/\S+\s+\d{1,3}(\.\d{1,3}){3}\s*$/.test(l) && !l.includes('://')) return 'hosts'
  return null
}

function cosmeticFromLine(
  line: string,
  separator: string,
  type: CosmeticRuleType,
  skip: (line: string, reason: SkipReason) => void
): CosmeticRule[] {
  const idx = line.indexOf(separator)
  const domainsPart = line.slice(0, idx)
  const selector = line.slice(idx + separator.length).trim()
  if (!selector || selector.includes('$')) {
    skip(line, 'options')
    return []
  }
  if (PROCEDURAL_RE.test(selector)) {
    skip(line, 'scriptlet')
    return []
  }
  const include: string[] = []
  const exclude: string[] = []
  for (const seg of domainsPart.split(',')) {
    const s = seg.trim()
    if (!s) continue
    if (s.startsWith('~')) {
      const d = normalizeRuleDomain(s.slice(1))
      if (d) exclude.push(d)
    } else {
      const d = normalizeRuleDomain(s)
      if (d) include.push(d)
    }
  }
  const excludeDomains = exclude.length ? [...new Set(exclude)] : undefined
  if (include.length === 0) return [createCosmeticRule(type, '*', selector, { excludeDomains })]
  return include.map((d) => createCosmeticRule(type, d, selector, { excludeDomains }))
}

/** 解析 AdGuard/EasyList 常用语法子集;不支持的语法整行跳过并计入 summary.skipped */
export function parseRuleText(text: string): ParsedRules {
  const networkRules: NetworkRule[] = []
  const cosmeticRules: CosmeticRule[] = []
  const cosmeticFlags: CosmeticFlagRule[] = []
  const badfilters: NetworkRule[] = []
  const reasons: Record<SkipReason, number> = { options: 0, scriptlet: 0, foreign: 0, other: 0 }
  const foreignFormats = new Set<string>()
  let skippedCount = 0
  const samples: string[] = []

  const skip = (line: string, reason: SkipReason = 'other'): void => {
    skippedCount += 1
    reasons[reason] += 1
    if (samples.length < SKIP_SAMPLE_LIMIT) samples.push(line)
  }

  const addNetwork = (line: string, type: NetworkRuleType, body: string): void => {
    const split = splitOptions(body)
    const pattern = split.pattern.trim()
    if (!pattern || pattern.includes('$') || /\s/.test(pattern) || pattern.startsWith('#')) {
      skip(line, pattern.includes('$') ? 'options' : 'other')
      return
    }
    const parsed = parseOptions(split.options, type)
    if (!parsed.ok) {
      skip(line, 'options')
      return
    }
    if (parsed.value.cosmeticFlag) {
      const host = hostKeyOf(pattern)
      if (!host) {
        skip(line, 'options')
        return
      }
      cosmeticFlags.push(createCosmeticFlagRule(host, parsed.value.cosmeticFlag))
      return
    }
    const rule = createNetworkRule(type, pattern, { options: parsed.value.options })
    if (parsed.value.badfilter) badfilters.push(rule)
    else networkRules.push(rule)
  }

  for (const rawLine of (text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // 注释 / 清单头(hosts 文件也常用 # 注释;但 `##sel` 这类泛化元素规则不是注释)
    if (line.startsWith('!') || line.startsWith('[')) continue
    if (line.startsWith('#') && !isCosmeticOrScriptletLine(line)) continue

    const foreign = detectForeignFormat(line)
    if (foreign) {
      foreignFormats.add(foreign)
      skip(line, 'foreign')
      continue
    }

    if (SCRIPTLET_MARKERS.some((m) => line.includes(m))) {
      skip(line, 'scriptlet')
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
      addNetwork(line, 'allow', line.slice(2))
      continue
    }
    addNetwork(line, 'block', line)
  }

  const net = dedupeNetworkRules(networkRules)
  const cos = dedupeCosmeticRules(cosmeticRules)
  const flags = dedupeCosmeticFlags(cosmeticFlags)
  const bads = dedupeNetworkRules(badfilters)
  return {
    networkRules: net,
    cosmeticRules: cos,
    cosmeticFlags: flags,
    badfilters: bads,
    summary: {
      imported: net.length + cos.length + flags.length,
      network: net.length,
      cosmetic: cos.length,
      cosmeticFlags: flags.length,
      badfilters: bads.length,
      skipped: {
        count: skippedCount,
        samples,
        reasons,
        foreignFormats: [...foreignFormats]
      }
    }
  }
}

/** 一条网络规则 → 文本行(含 `@@` 与 `$选项`) */
export function serializeNetworkRule(rule: NetworkRule): string {
  return (rule.type === 'allow' ? '@@' : '') + rule.pattern + formatNetworkOptions(rule.options)
}

/** 一条元素规则 → 文本行(含 `~` 排除域) */
export function serializeCosmeticRule(rule: CosmeticRule): string {
  const sep = rule.type === 'unhide' ? '#@#' : '##'
  const domains = [
    ...(rule.domain && rule.domain !== '*' ? [rule.domain] : []),
    ...(rule.excludeDomains ?? []).map((d) => '~' + d)
  ]
  return domains.join(',') + sep + rule.selector
}

export function serializeRuleText(
  networkRules: NetworkRule[],
  cosmeticRules: CosmeticRule[],
  opts: { includeBuiltin?: boolean; cosmeticFlags?: CosmeticFlagRule[] } = {}
): string {
  const includeBuiltin = opts.includeBuiltin ?? true
  const lines: string[] = ['! bow adblock rules']
  for (const r of networkRules) {
    if (!includeBuiltin && r.source === 'builtin') continue
    lines.push(serializeNetworkRule(r))
  }
  for (const r of cosmeticRules) {
    if (!includeBuiltin && r.source === 'builtin') continue
    lines.push(serializeCosmeticRule(r))
  }
  for (const f of opts.cosmeticFlags ?? []) {
    if (!includeBuiltin && f.source === 'builtin') continue
    const opt = f.generic && f.specific ? 'elemhide' : f.generic ? 'generichide' : 'specifichide'
    lines.push('@@||' + f.host + '^$' + opt)
  }
  return lines.join('\n') + '\n'
}

// ---------- 手工输入校验 ----------

/** 设置页 / MCP 手动新增网络规则时的守门:不接受会被静默弱化的写法 */
export function patternInputError(pattern: string): string | null {
  const p = (pattern || '').trim()
  if (!p) return '规则模式不能为空'
  if (/\s/.test(p)) return '规则模式不能包含空白字符'
  if (p.includes('$')) return '暂不支持 $ 选项(如需 third-party / domain= 等,请用文本规则导入,不支持的写法会被跳过)'
  if (p.startsWith('#') || p.includes('##') || p.includes('#@#')) return '元素规则请切换到「元素规则」页签添加'
  if (p === '@@' || p === '||') return '规则模式不完整'
  return null
}

/** 深拷贝(供 IPC / MCP 返回快照,避免渲染层改到内存里的原对象) */
export function cloneNetworkRules(rules: NetworkRule[]): NetworkRule[] {
  return rules.map((r) => ({
    ...r,
    options: r.options
      ? {
          ...r.options,
          resourceTypes: r.options.resourceTypes ? [...r.options.resourceTypes] : undefined,
          excludeResourceTypes: r.options.excludeResourceTypes ? [...r.options.excludeResourceTypes] : undefined,
          domains: r.options.domains
            ? { include: [...r.options.domains.include], exclude: [...r.options.domains.exclude] }
            : undefined
        }
      : undefined
  }))
}

export function cloneCosmeticRules(rules: CosmeticRule[]): CosmeticRule[] {
  return rules.map((r) => ({ ...r, excludeDomains: r.excludeDomains ? [...r.excludeDomains] : undefined }))
}
