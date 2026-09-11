import { describe, expect, it } from 'vitest'
import { parseInput, isHttpUrl, searchUrl, resolveNavigation } from '../src/shared/url'

describe('parseInput 地址栏输入解析', () => {
  it('空输入返回 null', () => {
    expect(parseInput('')).toBeNull()
    expect(parseInput('   ')).toBeNull()
  })

  it('带协议前缀识别为 URL', () => {
    expect(parseInput('https://example.com/x')).toEqual({ kind: 'url', url: 'https://example.com/x' })
    expect(parseInput('http://localhost:3000/hello')).toEqual({ kind: 'url', url: 'http://localhost:3000/hello' })
    expect(parseInput('ftp://files.example.com')).toEqual({ kind: 'url', url: 'ftp://files.example.com' })
  })

  it('域名形式补 https://', () => {
    expect(parseInput('example.com')).toEqual({ kind: 'url', url: 'https://example.com' })
    expect(parseInput('www.baidu.com/s?wd=x')).toEqual({
      kind: 'url',
      url: 'https://www.baidu.com/s?wd=x'
    })
    expect(parseInput('sub.domain.io:8080/path#frag')).toEqual({
      kind: 'url',
      url: 'https://sub.domain.io:8080/path#frag'
    })
  })

  it('本地地址补 http://', () => {
    expect(parseInput('localhost:3000')).toEqual({ kind: 'url', url: 'http://localhost:3000' })
    expect(parseInput('127.0.0.1:5173/app')).toEqual({ kind: 'url', url: 'http://127.0.0.1:5173/app' })
  })

  it('含空格视为搜索', () => {
    expect(parseInput('hello world')).toEqual({ kind: 'search', query: 'hello world' })
  })

  it('无点号单词视为搜索', () => {
    expect(parseInput('vuejs')).toEqual({ kind: 'search', query: 'vuejs' })
    expect(parseInput('electron mcp')).toEqual({ kind: 'search', query: 'electron mcp' })
  })
})

describe('isHttpUrl', () => {
  it('仅接受 http/https', () => {
    expect(isHttpUrl('https://a.b')).toBe(true)
    expect(isHttpUrl('http://a.b')).toBe(true)
    expect(isHttpUrl('ftp://a.b')).toBe(false)
    expect(isHttpUrl('about:blank')).toBe(false)
    expect(isHttpUrl('file:///x')).toBe(false)
  })
})

describe('searchUrl', () => {
  it('各引擎模板正确编码查询词', () => {
    expect(searchUrl('google', 'hello world')).toBe('https://www.google.com/search?q=hello%20world')
    expect(searchUrl('baidu', '你好')).toBe('https://www.baidu.com/s?wd=%E4%BD%A0%E5%A5%BD')
    expect(searchUrl('bing', 'a&b')).toBe('https://www.bing.com/search?q=a%26b')
    expect(searchUrl('duckduckgo', 'x')).toBe('https://duckduckgo.com/?q=x')
  })
})

describe('resolveNavigation 地址栏输入 → 导航 URL', () => {
  it('空输入返回 null', () => {
    expect(resolveNavigation('', 'google')).toBeNull()
    expect(resolveNavigation('   ', 'google')).toBeNull()
  })

  it('URL 输入原样返回(不触发搜索)', () => {
    expect(resolveNavigation('https://example.com/x', 'google')).toEqual({
      parsed: 'url',
      url: 'https://example.com/x'
    })
    expect(resolveNavigation('example.com', 'google')).toEqual({
      parsed: 'url',
      url: 'https://example.com'
    })
    expect(resolveNavigation('localhost:3000', 'google')).toEqual({
      parsed: 'url',
      url: 'http://localhost:3000'
    })
  })

  it('搜索词按指定引擎拼 URL 并带回显 query', () => {
    expect(resolveNavigation('hello world', 'google')).toEqual({
      parsed: 'search',
      query: 'hello world',
      url: 'https://www.google.com/search?q=hello%20world'
    })
    expect(resolveNavigation('你好', 'baidu')).toEqual({
      parsed: 'search',
      query: '你好',
      url: 'https://www.baidu.com/s?wd=%E4%BD%A0%E5%A5%BD'
    })
    expect(resolveNavigation('electron mcp', 'bing')).toEqual({
      parsed: 'search',
      query: 'electron mcp',
      url: 'https://www.bing.com/search?q=electron%20mcp'
    })
    expect(resolveNavigation('x', 'duckduckgo')).toEqual({
      parsed: 'search',
      query: 'x',
      url: 'https://duckduckgo.com/?q=x'
    })
  })
})