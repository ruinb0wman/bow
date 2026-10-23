/**
 * 远程鉴权单测:口令 / cookie 签名 / 同源 / 退避。
 *
 * 这一层是「远程 shell」唯一的门,所以每条拒绝路径都单独看住 —— 伪造、过期、换口令、
 * 跨站 Origin、暴力重试。全部用注入的时钟,不碰真实时间。
 */

import { describe, expect, it } from 'vitest'
import {
  LoginThrottle,
  REMOTE_COOKIE_NAME,
  REMOTE_COOKIE_TTL_MS,
  RemoteAuth,
  constantTimeEqual,
  createAuthKey,
  isSameOrigin,
  parseCookie
} from '../src/plugins/terminal/remote/auth'

const KEY = Buffer.from(createAuthKey(), 'hex')
const T0 = 1_700_000_000_000

function auth(password = 'correct horse battery', now = () => T0) {
  return new RemoteAuth({ password, key: KEY, now })
}

describe('口令', () => {
  it('对的通过,错的/非字符串一律拒', () => {
    const a = auth()
    expect(a.checkPassword('correct horse battery')).toBe(true)
    expect(a.checkPassword('correct horse batterY')).toBe(false)
    expect(a.checkPassword('')).toBe(false)
    expect(a.checkPassword(undefined)).toBe(false)
    expect(a.checkPassword(123 as unknown as string)).toBe(false)
  })

  it('isUsablePassword 拒绝空串与过短口令(不允许无口令开远程)', () => {
    expect(RemoteAuth.isUsablePassword('')).toBe(false)
    expect(RemoteAuth.isUsablePassword('   ')).toBe(false)
    expect(RemoteAuth.isUsablePassword('1234567')).toBe(false)
    expect(RemoteAuth.isUsablePassword('12345678')).toBe(true)
  })

  it('constantTimeEqual 比对内容而不是引用', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('cookie 登录态', () => {
  it('签发 → 校验往返通过', () => {
    const a = auth()
    expect(a.verifyCookie(a.issue())).toBe(true)
  })

  it('篡改签名/过期时间/口令指纹都失败', () => {
    const a = auth()
    const value = a.issue()
    const [v, exp, tag, sig] = value.split('.')

    expect(a.verifyCookie(`${v}.${exp}.${tag}.${sig.slice(0, -1)}0`)).toBe(false) // 改签名
    expect(a.verifyCookie(`${v}.${Number(exp) + 1}.${tag}.${sig}`)).toBe(false) // 改过期时间
    expect(a.verifyCookie(`${v}.${exp}.${'0'.repeat(16)}.${sig}`)).toBe(false) // 改口令指纹
    expect(a.verifyCookie(`${v}.${exp}.${tag}`)).toBe(false) // 少一段
    expect(a.verifyCookie('')).toBe(false)
    expect(a.verifyCookie(undefined)).toBe(false)
  })

  it('过期后拒;TTL 内一直有效', () => {
    let now = T0
    const a = auth('correct horse battery', () => now)
    const value = a.issue()

    now = T0 + REMOTE_COOKIE_TTL_MS - 1000
    expect(a.verifyCookie(value)).toBe(true)

    now = T0 + REMOTE_COOKIE_TTL_MS + 1
    expect(a.verifyCookie(value)).toBe(false)
  })

  it('换口令后旧 cookie 失效(不必轮换密钥)', () => {
    const before = auth('old-password-123').issue()
    expect(auth('new-password-123').verifyCookie(before)).toBe(false)
  })

  it('换密钥后旧 cookie 失效', () => {
    const a = auth()
    const value = a.issue()
    const other = new RemoteAuth({ password: 'correct horse battery', key: Buffer.from(createAuthKey(), 'hex'), now: () => T0 })
    expect(other.verifyCookie(value)).toBe(false)
  })
})

describe('parseCookie', () => {
  it('取名字大小写不敏感,取不到返回 undefined', () => {
    expect(parseCookie(`a=1; ${REMOTE_COOKIE_NAME}=xyz; b=2`, REMOTE_COOKIE_NAME)).toBe('xyz')
    expect(parseCookie(`BOW_REMOTE=xyz`, REMOTE_COOKIE_NAME)).toBe('xyz')
    expect(parseCookie('a=1', REMOTE_COOKIE_NAME)).toBeUndefined()
    expect(parseCookie(undefined, REMOTE_COOKIE_NAME)).toBeUndefined()
  })
})

describe('同源判定', () => {
  it('没有 Origin(脚本/curl/TUI)不适用同源规则', () => {
    expect(isSameOrigin({ host: '192.168.1.9:8770' })).toBe(true)
  })

  it('Origin 与 Host 同源才通过', () => {
    expect(isSameOrigin({ origin: 'http://192.168.1.9:8770', host: '192.168.1.9:8770' })).toBe(true)
    expect(isSameOrigin({ origin: 'http://192.168.1.9:8770', host: '192.168.1.9:9999' })).toBe(false)
    expect(isSameOrigin({ origin: 'http://evil.example', host: '192.168.1.9:8770' })).toBe(false)
  })

  it('非 http(s) 的 Origin 一律拒(devtools:// 之类不是我们的客户端)', () => {
    expect(isSameOrigin({ origin: 'devtools://devtools', host: '192.168.1.9:8770' })).toBe(false)
    expect(isSameOrigin({ origin: 'file://', host: '192.168.1.9:8770' })).toBe(false)
  })

  it('有 Origin 但缺 Host:拒', () => {
    expect(isSameOrigin({ origin: 'http://192.168.1.9:8770' })).toBe(false)
  })
})

describe('verifyRequest(一次请求的完整结论)', () => {
  it('cookie 通过', () => {
    const a = auth()
    expect(
      a.verifyRequest({ cookie: `${REMOTE_COOKIE_NAME}=${a.issue()}`, host: 'h:1', origin: 'http://h:1' })
    ).toBe(true)
  })

  it('Bearer 口令通过(脚本 / 将来的 TUI)', () => {
    const a = auth()
    expect(a.verifyRequest({ authorization: 'Bearer correct horse battery' })).toBe(true)
    expect(a.verifyRequest({ authorization: 'bearer   correct horse battery  ' })).toBe(true)
    expect(a.verifyRequest({ authorization: 'Bearer wrong' })).toBe(false)
    expect(a.verifyRequest({ authorization: 'Basic abc' })).toBe(false)
  })

  it('跨站 Origin 即使带合法 cookie 也拒(CSRF / 跨站 WS 劫持)', () => {
    const a = auth()
    const cookie = `${REMOTE_COOKIE_NAME}=${a.issue()}`
    expect(a.verifyRequest({ cookie, origin: 'http://evil.example', host: '192.168.1.9:8770' })).toBe(false)
  })

  it('什么都没有:拒', () => {
    expect(auth().verifyRequest({})).toBe(false)
  })
})

describe('LoginThrottle', () => {
  it('前 5 次失败不封,第 6 次开始翻倍退避,封顶 5 分钟', () => {
    let now = T0
    const throttle = new LoginThrottle(() => now)
    const key = '192.168.1.20'

    for (let i = 0; i < 5; i++) expect(throttle.fail(key)).toBe(0)
    expect(throttle.check(key).allowed).toBe(true)

    expect(throttle.fail(key)).toBe(30_000) // 1× base
    expect(throttle.check(key)).toMatchObject({ allowed: false, retryAfterMs: 30_000 })

    now += 30_000
    expect(throttle.check(key).allowed).toBe(true)
    expect(throttle.fail(key)).toBe(60_000) // 2×
    now += 60_000
    expect(throttle.fail(key)).toBe(120_000)
    now += 120_000
    expect(throttle.fail(key)).toBe(240_000)
    now += 240_000
    expect(throttle.fail(key)).toBe(300_000) // 封顶
    now += 300_000
    expect(throttle.fail(key)).toBe(300_000)
  })

  it('不同来源各算各的;成功一次清零', () => {
    let now = T0
    const throttle = new LoginThrottle(() => now)
    for (let i = 0; i < 6; i++) throttle.fail('a')
    expect(throttle.check('a').allowed).toBe(false)
    expect(throttle.check('b').allowed).toBe(true)

    throttle.success('a')
    expect(throttle.check('a').allowed).toBe(true)
  })

  it('reset 可以清单个或全部(设置页「解除封禁」)', () => {
    const throttle = new LoginThrottle()
    for (let i = 0; i < 6; i++) throttle.fail('a')
    throttle.fail('b')
    throttle.reset('a')
    expect(throttle.check('a').allowed).toBe(true)
    expect(throttle.check('b').allowed).toBe(true)
    throttle.reset()
    expect(throttle.check('b').allowed).toBe(true)
  })
})
