import { describe, expect, it } from 'vitest'
import {
  compileUrlPattern,
  hostMatches,
  hostOf,
  matchAnyUrl,
  matchUrl,
  matchUrlPattern
} from '../src/shared/pluginMatch'

describe('URL 通配匹配', () => {
  it('* 匹配任意字符且整串锚定', () => {
    expect(matchUrlPattern('*://*.example.com/*', 'https://a.example.com/x')).toBe(true)
    expect(matchUrlPattern('*://*.example.com/*', 'https://example.com/x')).toBe(false)
    expect(matchUrlPattern('https://example.com/', 'https://example.com/')).toBe(true)
    expect(matchUrlPattern('https://example.com/', 'https://example.com/x')).toBe(false)
  })

  it('<all_urls> 等价于通配全部 URL', () => {
    expect(matchUrlPattern('<all_urls>', 'https://anything.test/a')).toBe(true)
    expect(matchUrlPattern('<all_urls>', 'http://localhost:3000')).toBe(true)
  })

  it('? 匹配单字符', () => {
    expect(matchUrlPattern('https://e?a.com/', 'https://exa.com/')).toBe(true)
    expect(matchUrlPattern('https://e?a.com/', 'https://exxa.com/')).toBe(false)
  })

  it('特殊字符(星号/问号之外)按字面量处理', () => {
    expect(matchUrlPattern('https://a.com/a.b', 'https://a.com/a.b')).toBe(true)
    expect(matchUrlPattern('https://a.com/a.b', 'https://a.com/axb')).toBe(false)
    expect(matchUrlPattern('https://a.com/a+b', 'https://a.com/a+b')).toBe(true)
  })

  it('matchUrl 应用 excludeMatches,空 matches 恒为 false', () => {
    expect(matchUrl('https://a.com/x', ['*://*/*'])).toBe(true)
    expect(matchUrl('https://a.com/x', ['*://*/*'], ['*://a.com/*'])).toBe(false)
    expect(matchUrl('https://a.com/x', [])).toBe(false)
  })

  it('matchAnyUrl 命中任一即真', () => {
    expect(matchAnyUrl(['https://a.com/', 'https://b.com/'], 'https://b.com/')).toBe(true)
    expect(matchAnyUrl([], 'https://b.com/')).toBe(false)
  })

  it('compileUrlPattern 结果被缓存且大小写不敏感', () => {
    expect(compileUrlPattern('https://A.com/')).toBe(compileUrlPattern('https://A.com/'))
    expect(matchUrlPattern('https://a.com/', 'https://A.COM/')).toBe(true)
  })
})

describe('主机名匹配 hostMatches', () => {
  it('apex 命中自身与任意子域', () => {
    expect(hostMatches('doubleclick.net', 'doubleclick.net')).toBe(true)
    expect(hostMatches('ad.doubleclick.net', 'doubleclick.net')).toBe(true)
  })

  it('*. 只命中子域,不命中 apex', () => {
    expect(hostMatches('ad.doubleclick.net', '*.doubleclick.net')).toBe(true)
    expect(hostMatches('doubleclick.net', '*.doubleclick.net')).toBe(false)
  })

  it('不误伤相似后缀', () => {
    expect(hostMatches('doubleclick.net.evil.com', 'doubleclick.net')).toBe(false)
  })

  it('模式带端口时端口必须一致,模式不带端口则忽略端口', () => {
    expect(hostMatches('example.com:8080', 'example.com:8080')).toBe(true)
    expect(hostMatches('example.com:9090', 'example.com:8080')).toBe(false)
    expect(hostMatches('example.com:8080', 'example.com')).toBe(true)
  })

  it('大小写与空模式', () => {
    expect(hostMatches('Example.COM', 'example.com')).toBe(true)
    expect(hostMatches('example.com', '')).toBe(false)
  })

  it('hostOf 解析主机名(含端口),失败返回空串', () => {
    expect(hostOf('https://a.example.com:8443/x')).toBe('a.example.com:8443')
    expect(hostOf('not a url')).toBe('')
  })
})
