/**
 * 代理配置解析与优先级。
 *
 * 这里判错的后果都很重:判成直连 = 网页和商店都连不上;判成错地址 = 整个浏览器断网。
 * 所以纯逻辑单独测,包括「手工模式填了坏地址」的退回行为。
 */

import { describe, expect, it } from 'vitest'
import { normalizeProxyServer, resolveProxy } from '../src/shared/proxy'

describe('normalizeProxyServer', () => {
  it('裸 host:port 补成 http', () => {
    expect(normalizeProxyServer('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })

  it('保留显式协议(socks5 等)', () => {
    expect(normalizeProxyServer('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
    expect(normalizeProxyServer('https://proxy.local:8443')).toBe('https://proxy.local:8443')
  })

  it('丢掉路径、查询与账号密码(proxyRules 里它们不生效还会进日志)', () => {
    expect(normalizeProxyServer('http://user:pass@127.0.0.1:7890/some/path?x=1')).toBe('http://127.0.0.1:7890')
  })

  it('空与非 http(s)/socks 的一律 null', () => {
    for (const input of ['', '   ', undefined, 'ftp://127.0.0.1:21', 'not a url', 'http://']) {
      expect(normalizeProxyServer(input as string | undefined), String(input)).toBeNull()
    }
  })
})

describe('resolveProxy 优先级:设置 > 环境变量 > 系统', () => {
  const env = 'http://127.0.0.1:7890'

  it('未设置模式时先看环境变量', () => {
    expect(resolveProxy({}, env)).toEqual({ kind: 'manual', server: env, source: 'env' })
  })

  it('手动配置压过环境变量', () => {
    expect(resolveProxy({ proxyMode: 'manual', proxyServer: '127.0.0.1:1087' }, env)).toEqual({
      kind: 'manual',
      server: 'http://127.0.0.1:1087',
      source: 'settings'
    })
  })

  it('都没有时跟随系统(不猜地址)', () => {
    expect(resolveProxy({}, undefined)).toEqual({ kind: 'system' })
  })

  it('直连与跟随系统是显式选择,不受环境变量影响', () => {
    expect(resolveProxy({ proxyMode: 'direct' }, env)).toEqual({ kind: 'direct' })
    expect(resolveProxy({ proxyMode: 'system' }, env)).toEqual({ kind: 'system' })
  })

  it('手动模式但地址不可用时退回跟随系统(不能因为填错就断网)', () => {
    expect(resolveProxy({ proxyMode: 'manual', proxyServer: 'ftp://x' }, undefined)).toEqual({ kind: 'system' })
    // 环境变量这时仍然可用
    expect(resolveProxy({ proxyMode: 'manual', proxyServer: '' }, env)).toEqual({
      kind: 'manual',
      server: env,
      source: 'env'
    })
  })
})
