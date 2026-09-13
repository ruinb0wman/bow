import { describe, expect, it } from 'vitest'
import {
  buildCosmeticCss,
  createDefaultConfig,
  createCosmeticRule,
  createNetworkRule,
  dedupeCosmeticRules,
  dedupeNetworkRules,
  domainMatches,
  isNetworkBlocked,
  migrateConfig,
  networkPatternMatches,
  normalizeRuleDomain,
  parseRuleText,
  serializeRuleText
} from '../src/shared/adblock'
import type { CosmeticRule, NetworkRule } from '../src/shared/adblock'

function net(type: NetworkRule['type'], pattern: string, enabled = true): NetworkRule {
  return { id: `n-${pattern}`, type, pattern, enabled, source: 'user', createdAt: 0 }
}

function cos(
  type: CosmeticRule['type'],
  domain: string,
  selector: string,
  enabled = true
): CosmeticRule {
  return { id: `c-${domain}-${selector}`, type, domain, selector, enabled, source: 'user', createdAt: 0 }
}

describe('广告规则匹配', () => {
  it('apex 与子域均命中', () => {
    expect(networkPatternMatches('doubleclick.net', 'https://ad.doubleclick.net/x.js')).toBe(true)
    expect(networkPatternMatches('doubleclick.net', 'https://doubleclick.net/x.js')).toBe(true)
    expect(networkPatternMatches('doubleclick.net', 'https://www.google-analytics.com/a')).toBe(false)
  })

  it('大小写不敏感', () => {
    expect(networkPatternMatches('DoubleClick.NET', 'https://AD.doubleclick.net/x.js')).toBe(true)
  })

  it('相似后缀不误伤', () => {
    expect(networkPatternMatches('doubleclick.net', 'https://doubleclick.net.evil.com/x')).toBe(false)
    expect(networkPatternMatches('doubleclick.net', 'https://example.com/x')).toBe(false)
  })

  it('带端口仍命中(规则不带端口)', () => {
    expect(networkPatternMatches('doubleclick.net', 'https://doubleclick.net:8080/x.js')).toBe(true)
  })

  it('||host^ 主机锚点', () => {
    expect(networkPatternMatches('||ads.example.com^', 'https://ads.example.com/banner.png')).toBe(true)
    expect(networkPatternMatches('||ads.example.com^', 'https://example.com/ads')).toBe(false)
  })

  it('裸主机锚点 host^', () => {
    expect(networkPatternMatches('ads.example.com^', 'https://ads.example.com/x')).toBe(true)
    expect(networkPatternMatches('ads.example.com^', 'https://example.com/x')).toBe(false)
  })

  it('*.host 只命中子域', () => {
    expect(networkPatternMatches('*.example.com', 'https://a.example.com/x')).toBe(true)
    expect(networkPatternMatches('*.example.com', 'https://example.com/x')).toBe(false)
  })

  it('URL 通配匹配完整地址', () => {
    expect(networkPatternMatches('*/ads/*', 'https://site.com/a/ads/b.js')).toBe(true)
    expect(networkPatternMatches('https://cdn.example.com/*.gif', 'https://cdn.example.com/x.gif')).toBe(true)
    expect(networkPatternMatches('https://cdn.example.com/*.gif', 'https://cdn.example.com/x.png')).toBe(false)
  })

  it('allow 优先于 block', () => {
    const rules = [net('block', 'example.com'), net('allow', 'good.example.com')]
    expect(isNetworkBlocked('https://good.example.com/x.js', rules)).toBe(false)
    expect(isNetworkBlocked('https://bad.example.com/x.js', rules)).toBe(true)
  })

  it('空规则清单不拦截', () => {
    expect(isNetworkBlocked('https://ad.doubleclick.net/x.js', [])).toBe(false)
  })

  it('停用的规则不生效', () => {
    expect(isNetworkBlocked('https://ad.doubleclick.net/x.js', [net('block', 'doubleclick.net', false)])).toBe(false)
  })
})

describe('元素规则', () => {
  it('域匹配覆盖子域与全站', () => {
    expect(domainMatches('example.com', 'news.example.com')).toBe(true)
    expect(domainMatches('example.com', 'example.com')).toBe(true)
    expect(domainMatches('*', 'anything.test')).toBe(true)
    expect(domainMatches('example.com', 'example.com.evil.test')).toBe(false)
  })

  it('生成逐选择器规则并可扣除 unhide', () => {
    const rules = [cos('hide', 'example.com', '.ad'), cos('hide', '*', '.banner'), cos('unhide', 'example.com', '.ad')]
    const css = buildCosmeticCss('news.example.com', rules)
    expect(css).toContain('.banner{display:none!important}')
    expect(css).not.toContain('.ad{display:none!important}')
  })

  it('不匹配的域、停用规则不产出', () => {
    const css = buildCosmeticCss('other.test', [
      cos('hide', 'example.com', '.ad'),
      cos('hide', '*', '.off', false)
    ])
    expect(css).toBe('')
  })

  it('每个选择器独立成规则', () => {
    const css = buildCosmeticCss('a.test', [cos('hide', '*', '.x'), cos('hide', '*', '.y')])
    expect(css.split('\n')).toHaveLength(2)
  })
})

describe('规范化 / 去重', () => {
  it('normalizeRuleDomain 去协议、路径与 www.', () => {
    expect(normalizeRuleDomain('https://www.Example.com/path?a=1')).toBe('example.com')
    expect(normalizeRuleDomain('.example.com')).toBe('example.com')
    expect(normalizeRuleDomain('*')).toBe('*')
  })

  it('网络规则按 type+pattern 去重', () => {
    const out = dedupeNetworkRules([net('block', 'a.com'), net('block', 'A.COM'), net('allow', 'a.com')])
    expect(out).toHaveLength(2)
  })

  it('元素规则按 type+domain+selector 去重', () => {
    const out = dedupeCosmeticRules([
      cos('hide', 'example.com', '.ad'),
      cos('hide', 'www.example.com', '.ad'),
      cos('unhide', 'example.com', '.ad')
    ])
    expect(out).toHaveLength(2)
  })
})

describe('配置迁移', () => {
  it('v1 规则清单迁移为网络规则并保留计数', () => {
    const cfg = migrateConfig({ enabled: true, blockedCount: 7, rules: ['a.com', 'b.com'] })
    expect(cfg.version).toBe(2)
    expect(cfg.blockedCount).toBe(7)
    expect(cfg.networkRules).toHaveLength(2)
    expect(cfg.networkRules.every((r) => r.type === 'block')).toBe(true)
    // v1 未持久化元素规则,迁移时补默认
    expect(cfg.cosmeticRules.length).toBeGreaterThan(0)
  })

  it('占位默认(version 0)产出完整默认配置', () => {
    const cfg = migrateConfig({ version: 0 })
    expect(cfg.version).toBe(2)
    expect(cfg.networkRules.length).toBeGreaterThan(0)
    expect(cfg.cosmeticRules.length).toBeGreaterThan(0)
  })

  it('v2 幂等', () => {
    const d = createDefaultConfig()
    const cfg = migrateConfig(d)
    expect(cfg.networkRules).toHaveLength(d.networkRules.length)
    expect(cfg.cosmeticRules).toHaveLength(d.cosmeticRules.length)
  })

  it('空值返回默认', () => {
    expect(migrateConfig(undefined).networkRules.length).toBeGreaterThan(0)
  })
})

describe('文本规则解析 / 序列化', () => {
  const text = [
    '! comment',
    '[Adblock Plus 2.0]',
    '||ads.example.com^',
    '@@||good.example.com^',
    'example.com##.ad-banner',
    'example.com#@#.ad-ok',
    '##.global-ad',
    'example.com#?#.ext',
    'tracker.example.com^$third-party',
    'bad.example.com^$document'
  ].join('\n')

  it('解析常用语法子集并统计跳过项', () => {
    const parsed = parseRuleText(text)
    const patterns = parsed.networkRules.map((r) => r.type + ':' + r.pattern)
    expect(patterns).toContain('block:||ads.example.com^')
    expect(patterns).toContain('allow:||good.example.com^')
    expect(patterns).toContain('block:tracker.example.com^')
    expect(patterns).not.toContain('block:bad.example.com^')
    const cosmetic = parsed.cosmeticRules.map((r) => r.type + ':' + r.domain + ':' + r.selector)
    expect(cosmetic).toContain('hide:example.com:.ad-banner')
    expect(cosmetic).toContain('unhide:example.com:.ad-ok')
    expect(cosmetic).toContain('hide:*:.global-ad')
    // #?# 与 $document 两行被跳过
    expect(parsed.summary.skipped.count).toBe(2)
  })

  it('序列化后可再次解析(往返一致)', () => {
    const parsed = parseRuleText(text)
    const out = serializeRuleText(parsed.networkRules, parsed.cosmeticRules, { includeBuiltin: true })
    const again = parseRuleText(out)
    expect(again.networkRules.map((r) => r.type + ':' + r.pattern).sort()).toEqual(
      parsed.networkRules.map((r) => r.type + ':' + r.pattern).sort()
    )
    expect(again.cosmeticRules.map((r) => r.type + ':' + r.domain + ':' + r.selector).sort()).toEqual(
      parsed.cosmeticRules.map((r) => r.type + ':' + r.domain + ':' + r.selector).sort()
    )
  })

  it('includeBuiltin=false 时过滤内置规则', () => {
    const cfg = createDefaultConfig()
    const out = serializeRuleText([...cfg.networkRules, net('block', 'user.com')], [
      ...cfg.cosmeticRules,
      cos('hide', 'user.com', '.own')
    ], { includeBuiltin: false })
    expect(out).toContain('user.com')
    expect(out).not.toContain('doubleclick.net')
  })
})

describe('默认配置构造', () => {
  it('createNetworkRule / createCosmeticRule 默认启用并规范化域', () => {
    const r = createCosmeticRule('hide', 'www.example.com', '  .ad  ')
    expect(r.domain).toBe('example.com')
    expect(r.selector).toBe('.ad')
    expect(r.enabled).toBe(true)
    expect(createNetworkRule('block', ' a.com ').pattern).toBe('a.com')
  })
})
