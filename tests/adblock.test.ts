import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildCosmeticCss,
  buildCosmeticCssFromIndex,
  buildCosmeticIndex,
  buildNetworkIndex,
  createDefaultConfig,
  createCosmeticFlagRule,
  createCosmeticRule,
  createNetworkRule,
  dedupeCosmeticRules,
  dedupeNetworkRules,
  domainMatches,
  formatNetworkOptions,
  isNetworkBlocked,
  isThirdPartyHost,
  MAX_COSMETIC_SELECTORS,
  migrateConfig,
  networkPatternMatches,
  networkRuleMatches,
  normalizeRuleDomain,
  parseOptions,
  parseRuleText,
  patternInputError,
  removeBadfiltered,
  serializeRuleText,
  splitOptions
} from '../src/shared/adblock'
import type { CosmeticRule, NetworkMatchContext, NetworkRule } from '../src/shared/adblock'

function net(
  type: NetworkRule['type'],
  pattern: string,
  enabled = true,
  options?: NetworkRule['options']
): NetworkRule {
  return { id: `n-${pattern}`, type, pattern, enabled, source: 'user', createdAt: 0, options }
}

function cos(
  type: CosmeticRule['type'],
  domain: string,
  selector: string,
  enabled = true,
  excludeDomains?: string[]
): CosmeticRule {
  return { id: `c-${domain}-${selector}`, type, domain, selector, enabled, source: 'user', createdAt: 0, excludeDomains }
}

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/easylist-sample.txt', import.meta.url)), 'utf-8')

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

  it('||host/path 只在路径前缀一致时命中(不再退化成整域)', () => {
    expect(networkPatternMatches('||cdn.example.com/ads/pixel.gif', 'https://cdn.example.com/ads/pixel.gif')).toBe(true)
    expect(networkPatternMatches('||cdn.example.com/ads/pixel.gif', 'https://sub.cdn.example.com/ads/pixel.gif')).toBe(
      true
    )
    expect(networkPatternMatches('||cdn.example.com/ads/pixel.gif', 'https://cdn.example.com/content/x.gif')).toBe(false)
  })

  it('pattern 里残留未解析的 $ 时不匹配(旧配置不降级成整域拦截)', () => {
    expect(networkPatternMatches('||x.example.com^$removeparam=utm_source', 'https://x.example.com/a.js')).toBe(false)
    expect(networkPatternMatches('tracker.example.com^$third-party', 'https://tracker.example.com/a.js')).toBe(false)
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

describe('$ 选项:解析', () => {
  it('splitOptions 保守切分(含空白 / / 的不当选项)', () => {
    expect(splitOptions('||x.com^$third-party')).toEqual({ pattern: '||x.com^', options: ['third-party'] })
    expect(splitOptions('||x.com^$removeparam=utm_source').options).toEqual(['removeparam=utm_source'])
    expect(splitOptions("||x.com^$csp=script-src 'self'").options).toEqual([])
    expect(splitOptions('||x.com/path')).toEqual({ pattern: '||x.com/path', options: [] })
    expect(splitOptions('example.com')).toEqual({ pattern: 'example.com', options: [] })
  })

  it('支持 third-party / ~third-party / 1p / 3p', () => {
    expect(parseOptions(['third-party'], 'block')).toMatchObject({ ok: true, value: { options: { thirdParty: true } } })
    expect(parseOptions(['3p'], 'block')).toMatchObject({ ok: true, value: { options: { thirdParty: true } } })
    expect(parseOptions(['~third-party'], 'block')).toMatchObject({
      ok: true,
      value: { options: { thirdParty: false } }
    })
    expect(parseOptions(['1p'], 'block')).toMatchObject({ ok: true, value: { options: { thirdParty: false } } })
    expect(parseOptions(['~1p'], 'block')).toMatchObject({ ok: true, value: { options: { thirdParty: true } } })
  })

  it('支持资源类型(含别名与取反)', () => {
    expect(parseOptions(['script', 'image'], 'block')).toMatchObject({
      ok: true,
      value: { options: { resourceTypes: ['script', 'image'] } }
    })
    expect(parseOptions(['js', '~img'], 'block')).toMatchObject({
      ok: true,
      value: { options: { resourceTypes: ['script'], excludeResourceTypes: ['image'] } }
    })
    expect(parseOptions(['xhr'], 'block')).toMatchObject({
      ok: true,
      value: { options: { resourceTypes: ['xmlhttprequest'] } }
    })
    expect(parseOptions(['all'], 'block')).toMatchObject({ ok: true, value: { options: {} } })
  })

  it('支持 domain= (含 ~ 排除)', () => {
    const res = parseOptions(['domain=news.example.com|~beta.news.example.com'], 'block')
    expect(res).toMatchObject({
      ok: true,
      value: { options: { domains: { include: ['news.example.com'], exclude: ['beta.news.example.com'] } } }
    })
  })

  it('generic / specifichide 只在 @@ 上成立,且不产出网络规则', () => {
    expect(parseOptions(['generichide'], 'allow')).toMatchObject({
      ok: true,
      value: { cosmeticFlag: 'generic' }
    })
    expect(parseOptions(['elemhide'], 'allow')).toMatchObject({ ok: true, value: { cosmeticFlag: 'both' } })
    expect(parseOptions(['specifichide'], 'allow')).toMatchObject({ ok: true, value: { cosmeticFlag: 'specific' } })
    expect(parseOptions(['generichide'], 'block')).toMatchObject({ ok: false })
  })

  it('未实现的选项一律不可用(绝不能降级)', () => {
    for (const opt of [
      'document',
      'popup',
      'csp',
      'removeparam=utm_source',
      'redirect=noop.js',
      'removeheader=set-cookie',
      'badfilter-ish-unknown',
      'from=news.example.com',
      'match-case',
      'inline-script'
    ]) {
      expect(parseOptions([opt], 'block'), opt).toMatchObject({ ok: false })
    }
  })

  it('$badfilter / $important 被识别', () => {
    expect(parseOptions(['badfilter'], 'block')).toMatchObject({ ok: true, value: { badfilter: true } })
    expect(parseOptions(['important'], 'block')).toMatchObject({ ok: true, value: { options: { important: true } } })
  })

  it('formatNetworkOptions 与解析互逆', () => {
    for (const tokens of [
      ['third-party', 'script'],
      ['~third-party', 'image', '~stylesheet'],
      ['domain=a.com|~b.a.com', 'important']
    ]) {
      const parsed = parseOptions(tokens, 'block')
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      const round = parseOptions(formatNetworkOptions(parsed.value.options).slice(1).split(','), 'block')
      expect(round).toMatchObject({ ok: true, value: { options: parsed.value.options } })
    }
  })
})

describe('$ 选项:匹配语义', () => {
  const thirdPartyRule = net('block', '||tracker.example.net^', true, { thirdParty: true })
  const firstPartyRule = net('block', '||tracker.example.net^', true, { thirdParty: false })

  it('$third-party 只看页面与请求是否同站', () => {
    expect(
      networkRuleMatches(thirdPartyRule, 'https://tracker.example.net/p.gif', {
        pageUrl: 'https://news.example.com/a'
      })
    ).toBe(true)
    expect(
      networkRuleMatches(thirdPartyRule, 'https://tracker.example.net/p.gif', {
        pageUrl: 'https://shop.tracker.example.net/a'
      })
    ).toBe(false)
    expect(
      networkRuleMatches(firstPartyRule, 'https://tracker.example.net/p.gif', {
        pageUrl: 'https://www.tracker.example.net/a'
      })
    ).toBe(true)
  })

  it('拿不到页面地址时不做判断(宁可不拦也不误拦)', () => {
    expect(networkRuleMatches(thirdPartyRule, 'https://tracker.example.net/p.gif', {})).toBe(false)
    expect(
      networkRuleMatches(thirdPartyRule, 'https://tracker.example.net/p.gif', {
        pageUrl: 'https://news.example.com/a'
      })
    ).toBe(true)
  })

  it('$domain= 按页面 host 生效,~ 排除优先', () => {
    const rule = net('block', '||api.example.com^', true, {
      domains: { include: ['news.example.com'], exclude: ['beta.news.example.com'] }
    })
    const ctx = (pageUrl: string): NetworkMatchContext => ({ pageUrl })
    expect(networkRuleMatches(rule, 'https://api.example.com/v1', ctx('https://news.example.com/a'))).toBe(true)
    expect(networkRuleMatches(rule, 'https://api.example.com/v1', ctx('https://beta.news.example.com/a'))).toBe(false)
    expect(networkRuleMatches(rule, 'https://api.example.com/v1', ctx('https://other.example.com/a'))).toBe(false)
  })

  it('资源类型按 Electron resourceType 映射', () => {
    const rule = net('block', '||m.example.com^', true, { resourceTypes: ['script'] })
    expect(networkRuleMatches(rule, 'https://m.example.com/a.js', { resourceType: 'script' })).toBe(true)
    expect(networkRuleMatches(rule, 'https://m.example.com/a.png', { resourceType: 'image' })).toBe(false)
    const xhrRule = net('block', '||m.example.com^', true, { resourceTypes: ['xmlhttprequest'] })
    expect(networkRuleMatches(xhrRule, 'https://m.example.com/v1', { resourceType: 'xhr' })).toBe(true)
    const subDoc = net('block', '||m.example.com^', true, { resourceTypes: ['subdocument'] })
    expect(networkRuleMatches(subDoc, 'https://m.example.com/f', { resourceType: 'subFrame' })).toBe(true)
  })

  it('$important 的 block 无视 allow 例外', () => {
    const rules = [
      net('allow', 'example.com'),
      net('block', '||ads.example.com^', true, { important: true }),
      net('block', '||tracker.example.com^')
    ]
    expect(isNetworkBlocked('https://ads.example.com/a.js', rules)).toBe(true)
    expect(isNetworkBlocked('https://tracker.example.com/a.js', rules)).toBe(false)
  })

  it('索引与全量列表结果一致', () => {
    const rules = [
      net('block', 'doubleclick.net'),
      net('block', '||ads.example.com^'),
      net('block', '||cdn.example.com/ads/*'),
      net('block', '*/banner/*.gif'),
      net('block', '*.tracker.example.org'),
      net('allow', 'good.doubleclick.net'),
      net('block', '||m.example.com^', true, { resourceTypes: ['script'] }),
      net('block', '||p.example.com^', true, { thirdParty: true })
    ]
    const index = buildNetworkIndex(rules)
    const urls = [
      'https://ad.doubleclick.net/x.js',
      'https://good.doubleclick.net/x.js',
      'https://ads.example.com/a.png',
      'https://cdn.example.com/ads/pixel.gif',
      'https://cdn.example.com/other/pixel.gif',
      'https://site.com/a/banner/x.gif',
      'https://a.tracker.example.org/x',
      'https://m.example.com/a.js',
      'https://p.example.com/a',
      'https://unrelated.test/x'
    ]
    const ctx: NetworkMatchContext = { resourceType: 'script', pageUrl: 'https://news.test.com/a' }
    for (const url of urls) {
      expect(isNetworkBlocked(url, index, ctx), url).toBe(isNetworkBlocked(url, rules, ctx))
    }
    // 抽样确认索引没有恒为 false
    expect(isNetworkBlocked('https://ad.doubleclick.net/x.js', index, ctx)).toBe(true)
    expect(isNetworkBlocked('https://good.doubleclick.net/x.js', index, ctx)).toBe(false)
    expect(isNetworkBlocked('https://m.example.com/a.js', index, ctx)).toBe(true)
  })

  it('removeBadfiltered 删掉等价规则', () => {
    const rules = [net('block', 'doubleclick.net'), net('block', '||ads.example.com^', true, { thirdParty: true })]
    const bad = [net('block', '||ads.example.com^', true, { thirdParty: true })]
    expect(removeBadfiltered(rules, bad).map((r) => r.pattern)).toEqual(['doubleclick.net'])
    // 选项不同则不算等价
    expect(removeBadfiltered(rules, [net('block', '||ads.example.com^')])).toHaveLength(2)
  })

  it('isThirdPartyHost 用近似注册域', () => {
    expect(isThirdPartyHost('news.example.com', 'tracker.example.net')).toBe(true)
    expect(isThirdPartyHost('news.example.com', 'cdn.example.com')).toBe(false)
    expect(isThirdPartyHost('127.0.0.1', '127.0.0.1')).toBe(false)
    expect(isThirdPartyHost('127.0.0.1', '10.0.0.1')).toBe(true)
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

  it('~ 排除域:该子域不隐藏', () => {
    const rules = [cos('hide', 'example.com', '.promo', true, ['beta.example.com'])]
    expect(buildCosmeticCss('www.example.com', rules)).toContain('.promo')
    expect(buildCosmeticCss('beta.example.com', rules)).toBe('')
  })

  it('索引版与直接版结果一致(且能过滤停用/无选择器规则)', () => {
    const rules = [
      cos('hide', '*', '.g1'),
      cos('hide', 'example.com', '.s1'),
      cos('hide', 'news.example.com', '.s2'),
      cos('unhide', 'example.com', '.s1'),
      cos('hide', 'other.test', '.x'),
      cos('hide', 'example.com', '.off', false),
      cos('hide', 'example.com', '')
    ]
    const index = buildCosmeticIndex(rules)
    const sortedLines = (css: string): string[] => css.split('\n').filter(Boolean).sort()
    for (const host of ['example.com', 'news.example.com', 'deep.news.example.com', 'other.test', 'nope.test']) {
      // 只比集合:索引版会把专属规则排在前(配额优先给专属规则)
      expect(sortedLines(buildCosmeticCssFromIndex(index, host)), host).toEqual(
        sortedLines(buildCosmeticCss(host, rules))
      )
    }
    // news.example.com 上:.g1(泛化) + .s2(专属),.s1 被 unhide 掉
    const css = buildCosmeticCssFromIndex(index, 'news.example.com')
    expect(css).toContain('.g1{display:none!important}')
    expect(css).toContain('.s2{display:none!important}')
    expect(css).not.toContain('.s1{display:none!important}')
  })

  it('索引版也支持带端口 host 与元素例外标记', () => {
    const rules = [cos('hide', 'example.com', '.specific'), cos('hide', '*', '.generic')]
    const index = buildCosmeticIndex(rules)
    const flags = [createCosmeticFlagRule('example.com', 'generic')]
    expect(buildCosmeticCssFromIndex(index, 'example.com:8080', flags)).toBe('.specific{display:none!important}')
    expect(buildCosmeticCssFromIndex(index, 'example.com:8080', flags)).toBe(
      buildCosmeticCss('example.com:8080', rules, flags)
    )
  })

  it('单页选择器数量有上限(订阅级清单不会把巨型 stylesheet 塞进页面)', () => {
    const rules = Array.from({ length: MAX_COSMETIC_SELECTORS + 50 }, (_, i) => cos('hide', '*', `.ad-${i}`))
    const css = buildCosmeticCss('any.test', rules)
    expect(css.split('\n')).toHaveLength(MAX_COSMETIC_SELECTORS)
    // 上限可覆盖,且去掉候选时不受影响
    const small = buildCosmeticCss('any.test', rules, [], { maxSelectors: 10 })
    expect(small.split('\n')).toHaveLength(10)
    const index = buildCosmeticIndex(rules)
    expect(buildCosmeticCssFromIndex(index, 'any.test').split('\n')).toHaveLength(MAX_COSMETIC_SELECTORS)
  })

  it('超出上限时 unhide 仍然生效', () => {
    const hides = Array.from({ length: 30 }, (_, i) => cos('hide', '*', `.ad-${i}`))
    const rules = [...hides, cos('unhide', '*', '.ad-0')]
    const css = buildCosmeticCss('any.test', rules, [], { maxSelectors: 5 })
    expect(css.split('\n')).toHaveLength(5)
    expect(css).not.toContain('.ad-0{display:none!important}')
  })

  it('$generichide 只关泛化规则,$elemhide 两者都关,$specifichide 只关专属规则', () => {
    const rules = [cos('hide', '*', '.generic'), cos('hide', 'example.com', '.specific')]
    const genericHide = [createCosmeticFlagRule('example.com', 'generic')]
    expect(buildCosmeticCss('news.example.com', rules, genericHide)).toBe('.specific{display:none!important}')
    const elemHide = [createCosmeticFlagRule('example.com', 'both')]
    expect(buildCosmeticCss('news.example.com', rules, elemHide)).toBe('')
    const specificHide = [createCosmeticFlagRule('example.com', 'specific')]
    expect(buildCosmeticCss('news.example.com', rules, specificHide)).toBe('.generic{display:none!important}')
    // 其它站不受影响(专属规则本来就不适用)
    expect(buildCosmeticCss('other.test', rules, elemHide)).toBe('.generic{display:none!important}')
  })
})

describe('规范化 / 去重', () => {
  it('normalizeRuleDomain 去协议、路径、www. 与 ~', () => {
    expect(normalizeRuleDomain('https://www.Example.com/path?a=1')).toBe('example.com')
    expect(normalizeRuleDomain('.example.com')).toBe('example.com')
    expect(normalizeRuleDomain('~beta.example.com')).toBe('beta.example.com')
    expect(normalizeRuleDomain('*')).toBe('*')
  })

  it('网络规则按 type+pattern+选项去重', () => {
    const out = dedupeNetworkRules([
      net('block', 'a.com'),
      net('block', 'A.COM'),
      net('allow', 'a.com'),
      net('block', 'a.com', true, { thirdParty: true })
    ])
    expect(out).toHaveLength(3)
  })

  it('元素规则按 type+domain+selector+排除域去重', () => {
    const out = dedupeCosmeticRules([
      cos('hide', 'example.com', '.ad'),
      cos('hide', 'www.example.com', '.ad'),
      cos('hide', 'example.com', '.ad', true, ['beta.example.com']),
      cos('unhide', 'example.com', '.ad')
    ])
    expect(out).toHaveLength(3)
  })
})

describe('配置迁移', () => {
  it('v1 规则清单迁移为网络规则并保留计数', () => {
    const cfg = migrateConfig({ enabled: true, blockedCount: 7, rules: ['a.com', 'b.com'] })
    expect(cfg.version).toBe(3)
    expect(cfg.blockedCount).toBe(7)
    expect(cfg.networkRules).toHaveLength(2)
    expect(cfg.networkRules.every((r) => r.type === 'block')).toBe(true)
    // v1 未持久化元素规则,迁移时补默认
    expect(cfg.cosmeticRules.length).toBeGreaterThan(0)
    expect(cfg.cosmeticFlags).toEqual([])
    expect(cfg.subscriptions).toEqual([])
  })

  it('占位默认(version 0)产出完整默认配置', () => {
    const cfg = migrateConfig({ version: 0 })
    expect(cfg.version).toBe(3)
    expect(cfg.networkRules.length).toBeGreaterThan(0)
    expect(cfg.cosmeticRules.length).toBeGreaterThan(0)
  })

  it('v2 幂等', () => {
    const d = createDefaultConfig()
    const cfg = migrateConfig(d)
    expect(cfg.networkRules).toHaveLength(d.networkRules.length)
    expect(cfg.cosmeticRules).toHaveLength(d.cosmeticRules.length)
  })

  it('v2 遗留 pattern 里的 $ 选项被重解析', () => {
    const cfg = migrateConfig({
      version: 2,
      networkRules: [{ type: 'block', pattern: '||x.com^$third-party', enabled: true }]
    })
    expect(cfg.networkRules[0].pattern).toBe('||x.com^')
    expect(cfg.networkRules[0].options).toEqual({ thirdParty: true })
    expect(cfg.networkRules[0].enabled).toBe(true)
  })

  it('v2 遗留的不支持选项被停用而不是继续整域拦截', () => {
    const cfg = migrateConfig({
      version: 2,
      networkRules: [{ type: 'block', pattern: '||x.com^$removeparam=utm_source', enabled: true }]
    })
    expect(cfg.networkRules[0].enabled).toBe(false)
    expect(cfg.networkRules[0].note).toContain('停用')
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
    // $third-party 不再被丢弃 —— 而是真正生效的选项
    expect(parsed.networkRules.find((r) => r.pattern === 'tracker.example.com^')?.options).toEqual({
      thirdParty: true
    })
    const cosmetic = parsed.cosmeticRules.map((r) => r.type + ':' + r.domain + ':' + r.selector)
    expect(cosmetic).toContain('hide:example.com:.ad-banner')
    expect(cosmetic).toContain('unhide:example.com:.ad-ok')
    expect(cosmetic).toContain('hide:*:.global-ad')
    // #?# 与 $document 两行被跳过
    expect(parsed.summary.skipped.count).toBe(2)
    expect(parsed.summary.skipped.reasons.scriptlet).toBe(1)
    expect(parsed.summary.skipped.reasons.options).toBe(1)
  })

  it('序列化后可再次解析(往返一致,含选项与元素标记)', () => {
    const parsed = parseRuleText(text)
    const out = serializeRuleText(parsed.networkRules, parsed.cosmeticRules, {
      includeBuiltin: true,
      cosmeticFlags: parsed.cosmeticFlags
    })
    const again = parseRuleText(out)
    const key = (r: NetworkRule): string => r.type + ':' + r.pattern + formatNetworkOptions(r.options)
    expect(again.networkRules.map(key).sort()).toEqual(parsed.networkRules.map(key).sort())
    expect(again.cosmeticRules.map((r) => r.type + ':' + r.domain + ':' + r.selector).sort()).toEqual(
      parsed.cosmeticRules.map((r) => r.type + ':' + r.domain + ':' + r.selector).sort()
    )
  })

  it('includeBuiltin=false 时过滤内置规则', () => {
    const cfg = createDefaultConfig()
    const out = serializeRuleText(
      [...cfg.networkRules, net('block', 'user.com')],
      [...cfg.cosmeticRules, cos('hide', 'user.com', '.own')],
      { includeBuiltin: false }
    )
    expect(out).toContain('user.com')
    expect(out).not.toContain('doubleclick.net')
  })
})

describe('真实清单片段(EasyList / AdGuard / hosts 混排)', () => {
  const parsed = parseRuleText(fixture)

  it('不产生任何「整行降级」的网络规则', () => {
    const bad = ['redirect.example.com', 'clean.example.com', 'csp.example.com', 'page.example.com']
    for (const r of parsed.networkRules) {
      expect(r.pattern).not.toContain('$')
      expect(/\s/.test(r.pattern), r.pattern).toBe(false)
      expect(bad.some((b) => r.pattern.includes(b)), r.pattern).toBe(false)
    }
    for (const r of parsed.cosmeticRules) expect(r.selector).not.toContain('$')
  })

  it('净清单里的每一项都被归到「导入」或「跳过」,没有静默丢弃', () => {
    const dataLines = fixture
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('!') && !l.startsWith('['))
    const counted = parsed.summary.imported + parsed.summary.badfilters + parsed.summary.skipped.count
    expect(counted).toBe(dataLines.length)
  })

  it('选项子集按语义落地', () => {
    const byPattern = new Map(parsed.networkRules.map((r) => [r.pattern, r]))
    expect(byPattern.get('||tracker.example.net^')?.options).toEqual({ thirdParty: true })
    expect(byPattern.get('||metrics.example.com^')?.options).toEqual({ thirdParty: true, resourceTypes: ['script'] })
    expect(byPattern.get('||pixel.example.com^')?.options).toEqual({
      thirdParty: false,
      resourceTypes: ['image']
    })
    expect(byPattern.get('||api.example.com^')?.options).toEqual({
      domains: { include: ['news.example.com'], exclude: ['beta.news.example.com'] }
    })
    expect(byPattern.get('||must-block.example.com^')?.options).toEqual({ important: true })
    expect(byPattern.get('||cdn.example.com/ads/pixel.gif')).toBeTruthy()
  })

  it('$badfilter 单独收集,不进规则表', () => {
    expect(parsed.summary.badfilters).toBe(1)
    expect(parsed.summary.network).toBe(11)
    expect(parsed.networkRules.some((r) => r.pattern.includes('doubleclick'))).toBe(false)
  })

  it('元素规则/标记:排除域与 generichide/elemhide 不被当成网络放行', () => {
    const promo = parsed.cosmeticRules.find((r) => r.selector === '.promo')
    expect(promo?.domain).toBe('example.com')
    expect(promo?.excludeDomains).toEqual(['beta.example.com'])
    expect(parsed.cosmeticRules.filter((r) => r.selector === '.sponsored').map((r) => r.domain).sort()).toEqual([
      'example.com',
      'news.example.com'
    ])
    const flags = parsed.cosmeticFlags.map((f) => `${f.host}|${f.generic ? 'g' : ''}${f.specific ? 's' : ''}`)
    expect(flags.sort()).toEqual(['beta.example.com|gs', 'news.example.com|g'])
    // 关键回归:这些行绝不能变成 allow 网络规则(否则整站放行)
    expect(parsed.networkRules.some((r) => r.type === 'allow' && r.pattern.includes('news.example.com'))).toBe(false)
    // 而且 buildCosmeticCss 真的按标记生效
    const css = buildCosmeticCss('news.example.com', parsed.cosmeticRules, parsed.cosmeticFlags)
    expect(css).toContain('.sponsored{display:none!important}')
    expect(css).not.toContain('.global-ad-slot')
  })

  it('scriptlet / 过程式过滤与异构格式被识别并汇总', () => {
    expect(parsed.summary.skipped.reasons.scriptlet).toBe(5)
    expect(parsed.summary.skipped.reasons.options).toBe(7)
    expect(parsed.summary.skipped.reasons.foreign).toBe(7)
    expect(parsed.summary.skipped.foreignFormats.sort()).toEqual(['clash', 'dnsmasq', 'hosts'])
  })
})

describe('手工输入校验', () => {
  it('拒绝会被静默弱化的写法', () => {
    expect(patternInputError('')).toMatch(/不能为空/)
    expect(patternInputError('||x.com^$third-party')).toMatch(/不支持 \$ 选项/)
    expect(patternInputError('||x.com^$removeparam=utm')).toMatch(/不支持 \$ 选项/)
    expect(patternInputError('a.com b.com')).toMatch(/空白/)
    expect(patternInputError('example.com##.ad')).toMatch(/元素规则/)
    expect(patternInputError('||')).toMatch(/不完整/)
  })

  it('接受常规模式', () => {
    for (const p of ['example.com', '*.example.com', '||ads.example.com^', '*/ads/*', 'https://cdn.x.com/*.gif']) {
      expect(patternInputError(p), p).toBeNull()
    }
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

  it('空选项不落成空对象', () => {
    expect(createNetworkRule('block', 'a.com', { options: {} }).options).toBeUndefined()
    expect(createNetworkRule('block', 'a.com', { options: { important: true } }).options).toEqual({ important: true })
  })
})
