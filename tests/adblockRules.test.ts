import { describe, expect, it } from 'vitest'
import { DEFAULT_BLOCKLIST, isBlockedUrl, matchBlockedHost } from '../src/plugins/adblock/rules'

describe('广告/追踪规则匹配', () => {
  it('apex 与子域均命中', () => {
    expect(matchBlockedHost('doubleclick.net', DEFAULT_BLOCKLIST)).toBe(true)
    expect(matchBlockedHost('ad.doubleclick.net', DEFAULT_BLOCKLIST)).toBe(true)
    expect(matchBlockedHost('www.google-analytics.com', DEFAULT_BLOCKLIST)).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(matchBlockedHost('AD.DoubleClick.NET', DEFAULT_BLOCKLIST)).toBe(true)
  })

  it('相似后缀不误伤', () => {
    expect(matchBlockedHost('doubleclick.net.evil.com', DEFAULT_BLOCKLIST)).toBe(false)
    expect(matchBlockedHost('example.com', DEFAULT_BLOCKLIST)).toBe(false)
  })

  it('带端口仍命中(规则不带端口)', () => {
    expect(matchBlockedHost('doubleclick.net:8080', DEFAULT_BLOCKLIST)).toBe(true)
  })

  it('isBlockedUrl 解析 URL 后匹配', () => {
    expect(isBlockedUrl('https://ad.doubleclick.net/x.js', DEFAULT_BLOCKLIST)).toBe(true)
    expect(isBlockedUrl('http://criteo.com/px', DEFAULT_BLOCKLIST)).toBe(true)
    expect(isBlockedUrl('https://example.com/x.js', DEFAULT_BLOCKLIST)).toBe(false)
    expect(isBlockedUrl('not a url', DEFAULT_BLOCKLIST)).toBe(false)
  })

  it('空规则清单不拦截', () => {
    expect(matchBlockedHost('doubleclick.net', [])).toBe(false)
    expect(isBlockedUrl('https://ad.doubleclick.net/x.js', [])).toBe(false)
  })
})
