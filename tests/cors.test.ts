import { describe, expect, it } from 'vitest'
import {
  buildCorsResponseHeaders,
  CORS_DEFAULT_LIST,
  CORS_DEFAULT_METHODS,
  isCorsWhitelisted,
  isPreflightRequest,
  normalizeCorsEntry,
  shouldBypassCors
} from '../src/shared/cors'

describe('normalizeCorsEntry 条目规范化', () => {
  it('去除首尾空白并折叠大小写', () => {
    expect(normalizeCorsEntry('  Example.COM  ')).toBe('example.com')
  })

  it('剥离 scheme 与路径/查询/锚点', () => {
    expect(normalizeCorsEntry('https://Example.com:8080/api?a=1#h')).toBe('example.com:8080')
    expect(normalizeCorsEntry('http://127.0.0.1/x')).toBe('127.0.0.1')
  })

  it('支持子域通配、IP、IPv6、单标签主机', () => {
    expect(normalizeCorsEntry('*.a.cn')).toBe('*.a.cn')
    expect(normalizeCorsEntry('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeCorsEntry('[::1]')).toBe('[::1]')
    expect(normalizeCorsEntry('[::1]:8080')).toBe('[::1]:8080')
    expect(normalizeCorsEntry('localhost')).toBe('localhost')
  })

  it('非法条目返回 null', () => {
    expect(normalizeCorsEntry('')).toBeNull()
    expect(normalizeCorsEntry('   ')).toBeNull()
    expect(normalizeCorsEntry('a b')).toBeNull()
    expect(normalizeCorsEntry('exa mple.com')).toBeNull()
    expect(normalizeCorsEntry('example.com:0')).toBeNull()
    expect(normalizeCorsEntry('example.com:99999')).toBeNull()
    expect(normalizeCorsEntry('example.com:')).toBeNull()
    expect(normalizeCorsEntry('*.*.example.com')).toBeNull()
    expect(normalizeCorsEntry('*.')).toBeNull()
    expect(normalizeCorsEntry('*')).toBeNull()
    expect(normalizeCorsEntry('192.168.1.999')).toBeNull()
    expect(normalizeCorsEntry('[::1')).toBeNull()
  })
})

describe('isCorsWhitelisted 匹配规则', () => {
  it('裸主机条目命中任意端口', () => {
    expect(isCorsWhitelisted('http://example.com/a', ['example.com'])).toBe(true)
    expect(isCorsWhitelisted('https://example.com:8443/a', ['example.com'])).toBe(true)
  })

  it('host:port 条目只命中该端口(默认端口归一化)', () => {
    expect(isCorsWhitelisted('http://example.com:8080/a', ['example.com:8080'])).toBe(true)
    expect(isCorsWhitelisted('http://example.com:8081/a', ['example.com:8080'])).toBe(false)
    expect(isCorsWhitelisted('https://example.com/a', ['example.com:443'])).toBe(true)
    expect(isCorsWhitelisted('https://example.com/a', ['example.com:8080'])).toBe(false)
  })

  it('*.子域通配命中任意深度子域,不含 apex', () => {
    expect(isCorsWhitelisted('http://a.example.com/x', ['*.example.com'])).toBe(true)
    expect(isCorsWhitelisted('http://a.b.example.com/x', ['*.example.com'])).toBe(true)
    expect(isCorsWhitelisted('http://example.com/x', ['*.example.com'])).toBe(false)
    expect(isCorsWhitelisted('http://.com/x', ['*.example.com'])).toBe(false)
  })

  it('大小写不敏感', () => {
    expect(isCorsWhitelisted('http://EXAMPLE.COM:8080/a', ['example.com:8080'])).toBe(true)
    expect(isCorsWhitelisted('HTTP://Api.Example.Com/x', ['*.example.com'])).toBe(true)
  })

  it('未在名单的主机不命中(localhost ≠ 127.0.0.1,子域 ≠ 主域)', () => {
    expect(isCorsWhitelisted('http://other.com/x', ['example.com'])).toBe(false)
    expect(isCorsWhitelisted('http://api.example.com/x', ['example.com'])).toBe(false)
    expect(isCorsWhitelisted('http://127.0.0.1:5175/api', ['localhost'])).toBe(false)
  })

  it('IP 与 IPv6 条目', () => {
    expect(isCorsWhitelisted('http://127.0.0.1:5175/api', ['127.0.0.1'])).toBe(true)
    expect(isCorsWhitelisted('http://[::1]:3000/x', ['[::1]'])).toBe(true)
    expect(isCorsWhitelisted('http://[::1]:8080/x', ['[::1]:8080'])).toBe(true)
    expect(isCorsWhitelisted('http://[::1]:8081/x', ['[::1]:8080'])).toBe(false)
  })

  it('默认名单开箱即用,外网不受影响', () => {
    expect(isCorsWhitelisted('http://localhost:3000/', CORS_DEFAULT_LIST)).toBe(true)
    expect(isCorsWhitelisted('http://127.0.0.1:5175/api', CORS_DEFAULT_LIST)).toBe(true)
    expect(isCorsWhitelisted('http://[::1]:80/', CORS_DEFAULT_LIST)).toBe(true)
    expect(isCorsWhitelisted('https://www.google.com/', CORS_DEFAULT_LIST)).toBe(false)
  })

  it('非 http(s) 与非法 URL 不命中,垃圾条目被忽略', () => {
    expect(isCorsWhitelisted('file:///etc/hosts', ['localhost'])).toBe(false)
    expect(isCorsWhitelisted('data:text/plain,x', ['localhost'])).toBe(false)
    expect(isCorsWhitelisted('not a url', ['localhost'])).toBe(false)
    expect(isCorsWhitelisted('http://example.com/x', ['garbage entry'])).toBe(false)
    expect(isCorsWhitelisted('http://example.com/x', [42] as unknown as string[])).toBe(false)
  })
})

describe('shouldBypassCors 注入判定(目标侧 + 来源侧)', () => {
  it('目标在白名单即注入(响应侧)', () => {
    expect(shouldBypassCors('http://127.0.0.1:5175/api', undefined, CORS_DEFAULT_LIST)).toBe(true)
    expect(shouldBypassCors('https://example.com/x', 'https://other.com/', ['example.com'])).toBe(true)
  })

  it('发起页面在白名单即注入(来源侧:本地页请求任意目标)', () => {
    // 用户实际场景:localhost 开发页请求远程 API 主机
    expect(
      shouldBypassCors(
        'https://api.example.com/v1/chat/completions',
        'http://localhost:8517/page',
        CORS_DEFAULT_LIST
      )
    ).toBe(true)
    expect(shouldBypassCors('https://anywhere.com/x', 'http://127.0.0.1:3000/', CORS_DEFAULT_LIST)).toBe(true)
  })

  it('两侧都不在白名单则不注入', () => {
    expect(
      shouldBypassCors('https://api.example.com/x', 'https://www.google.com/', ['localhost'])
    ).toBe(false)
    expect(shouldBypassCors('https://api.example.com/x', undefined, ['localhost'])).toBe(false)
  })

  it('来源页为空或非法 URL 时回退到目标侧判断', () => {
    expect(shouldBypassCors('https://example.com/x', '', ['example.com'])).toBe(true)
    expect(shouldBypassCors('https://example.com/x', 'not a url', ['example.com'])).toBe(true)
    expect(shouldBypassCors('https://other.com/x', undefined, ['example.com'])).toBe(false)
  })
})

describe('buildCorsResponseHeaders 注入头生成', () => {
  it('预检声明了 method 时回显该方法(含 WebDAV 的 PROPFIND)', () => {
    const h = buildCorsResponseHeaders({ requestedMethod: 'PROPFIND' })
    expect(h['Access-Control-Allow-Methods']).toEqual(['PROPFIND'])
  })

  it('预检声明了 headers 时回显该请求头(带凭据时通配符不生效)', () => {
    const h = buildCorsResponseHeaders({
      requestedMethod: 'PROPFIND',
      requestedHeaders: 'Depth, Authorization, Content-Type'
    })
    expect(h['Access-Control-Allow-Headers']).toEqual(['Depth, Authorization, Content-Type'])
  })

  it('无预检信息时回退集仍包含 PROPFIND / MKCOL 等非标准方法', () => {
    const h = buildCorsResponseHeaders({})
    const methods = h['Access-Control-Allow-Methods'][0]
    expect(methods).toBe(CORS_DEFAULT_METHODS)
    for (const m of ['PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'REPORT']) {
      expect(methods).toContain(m)
    }
    expect(h['Access-Control-Allow-Headers']).toEqual(['*'])
  })

  it('始终暴露 ETag 等非安全列表响应头,并带预检缓存', () => {
    const h = buildCorsResponseHeaders({ requestedMethod: 'HEAD' })
    expect(h['Access-Control-Expose-Headers']).toEqual(['*'])
    expect(h['Access-Control-Max-Age']).toEqual(['600'])
  })

  it('Allow-Origin 保持通配符,不回显 Origin', () => {
    const h = buildCorsResponseHeaders({ requestedMethod: 'GET', origin: 'http://localhost:3000' })
    expect(h['Access-Control-Allow-Origin']).toEqual(['*'])
  })

  it('空白/空的请求方法按无信息处理,回退到默认集', () => {
    const h = buildCorsResponseHeaders({ requestedMethod: '   ', requestedHeaders: '' })
    expect(h['Access-Control-Allow-Methods'][0]).toBe(CORS_DEFAULT_METHODS)
    expect(h['Access-Control-Allow-Headers']).toEqual(['*'])
  })
})

describe('注入决策的边界(白名单外零干扰)', () => {
  it('白名单外目标不满足注入条件(不应调用 buildCorsResponseHeaders)', () => {
    expect(shouldBypassCors('https://www.google.com/', 'https://www.google.com/', CORS_DEFAULT_LIST)).toBe(
      false
    )
    expect(shouldBypassCors('https://www.google.com/', undefined, CORS_DEFAULT_LIST)).toBe(false)
  })
})

describe('isPreflightRequest 预检判定', () => {
  it('OPTIONS + Access-Control-Request-Method 判定为预检', () => {
    expect(
      isPreflightRequest('OPTIONS', { Origin: 'http://localhost:8517', 'Access-Control-Request-Method': 'POST' })
    ).toBe(true)
    expect(
      isPreflightRequest('OPTIONS', { origin: 'http://localhost:8517', 'access-control-request-method': 'POST' })
    ).toBe(true)
  })

  it('非 OPTIONS 或无预检头不判定为预检', () => {
    expect(isPreflightRequest('POST', { Origin: 'http://localhost:8517' })).toBe(false)
    expect(isPreflightRequest('OPTIONS', { Origin: 'http://localhost:8517' })).toBe(false)
    expect(isPreflightRequest('OPTIONS', undefined)).toBe(false)
    expect(isPreflightRequest(undefined, {})).toBe(false)
  })
})
