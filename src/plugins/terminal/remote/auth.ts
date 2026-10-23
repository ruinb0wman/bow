/**
 * 远程访问的鉴权(纯逻辑,时钟与密钥注入,可单测)。
 *
 * 威胁模型先说清楚:这个端口后面是一台机器的**交互式 shell**。局域网里任何设备都能试连,
 * 所以哪怕不出公网,口令也是**唯一**那道门 —— 没有「内网就可信」这回事。
 *
 * 三个刻意的选择:
 * 1. **浏览器走 HttpOnly cookie,脚本走 Bearer**:浏览器没法给 WebSocket 设自定义头,
 *    所以握手只能靠 cookie(同源时会自动带上);命令行/将来的 TUI 则用 Authorization。
 *    **不把口令放 query** —— 那会进访问日志、浏览器历史与代理日志。
 * 2. **cookie 里不装口令,装 `<过期时间>.<口令指纹>` 再签名**:换口令时旧 cookie 自然失效,
 *    不需要轮换密钥。
 * 3. **同一来源连续失败会退避**:局域网里跑个字典也就是几分钟的事,退避把窗口拉长到不可行。
 *    成功一次就清零。
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto'

export const REMOTE_COOKIE_NAME = 'bow_remote'
/** cookie 有效期:手机加到主屏后不想每天重新输口令;换口令可随时作废 */
export const REMOTE_COOKIE_TTL_MS = 7 * 24 * 3600 * 1000

/** 口令的短指纹(进 cookie 签名,不泄露口令本身) */
function passwordTag(password: string): string {
  return createHash('sha256').update(password).digest('hex').slice(0, 16)
}

/** 恒定时间比较(长度不同直接 false,不泄露长度以外的信息) */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** 从 `Cookie` 头里取一个值(名字大小写不敏感;取不到返回 undefined) */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim().toLowerCase() === name.toLowerCase()) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return undefined
}

/**
 * 同源判定:有 `Origin` 时必须与 `Host` 同源。
 *
 * 为什么必须有这条:cookie 是「浏览器自动带上」的,所以任意网页都能对你的端口发起
 * WebSocket/表单请求(CSRF / 跨站 WS 劫持)。攻击者页面上的 `Origin` 是它自己的域名,
 * 与 `Host` 不同 → 直接拒。没有 `Origin`(curl、脚本、TUI)不适用这条,靠 Bearer 鉴权。
 */
export function isSameOrigin(headers: { origin?: string; host?: string }): boolean {
  const origin = headers.origin?.trim()
  if (!origin) return true
  const host = headers.host?.trim().toLowerCase()
  if (!host) return false
  try {
    const url = new URL(origin)
    // 只接受 http(s)(devtools:// 这类不是我们的客户端)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.host.toLowerCase() === host
  } catch {
    return false
  }
}

export interface RemoteAuthOptions {
  password: string
  /** 进程级随机密钥(32 字节);存在插件自己的存储里,不进设置文件 */
  key: Buffer
  ttlMs?: number
  now?: () => number
}

/**
 * 登录态:签发 / 校验 cookie,以及口令本身。
 * 实例是不可变的 —— 换口令/换密钥就重建一个(插件在设置变更时重建整个服务)。
 */
export class RemoteAuth {
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly tag: string

  constructor(private readonly options: RemoteAuthOptions) {
    this.ttlMs = options.ttlMs ?? REMOTE_COOKIE_TTL_MS
    this.now = options.now ?? (() => Date.now())
    this.tag = passwordTag(options.password)
  }

  /** 口令是否足够强到允许启动远程(空串/太短一律拒绝) */
  static isUsablePassword(password: string, minLength = 8): boolean {
    return password.trim().length >= minLength
  }

  checkPassword(input: unknown): boolean {
    if (typeof input !== 'string' || !input) return false
    return constantTimeEqual(input, this.options.password)
  }

  /** 签一个 cookie 值(不含 cookie 名) */
  issue(): string {
    const exp = Math.round(this.now() + this.ttlMs)
    const payload = `v1.${exp}.${this.tag}`
    return `${payload}.${this.sign(payload)}`
  }

  /** 校验 cookie 值:格式、签名、过期、口令指纹(换口令后旧 cookie 失效) */
  verifyCookie(value: string | undefined): boolean {
    if (!value) return false
    const parts = value.split('.')
    if (parts.length !== 4 || parts[0] !== 'v1') return false
    const [version, expRaw, tag, signature] = parts
    const exp = Number(expRaw)
    if (!Number.isFinite(exp) || exp <= this.now()) return false
    if (!constantTimeEqual(tag, this.tag)) return false
    const expected = this.sign(`${version}.${expRaw}.${tag}`)
    return constantTimeEqual(signature, expected)
  }

  /** 一次请求的鉴权结论(`cookie` 或 `authorization` 二选一即可) */
  verifyRequest(headers: {
    cookie?: string
    authorization?: string
    origin?: string
    host?: string
  }): boolean {
    if (!isSameOrigin(headers)) return false
    if (this.verifyCookie(parseCookie(headers.cookie, REMOTE_COOKIE_NAME))) return true
    const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization?.trim() ?? '')
    return bearer ? this.checkPassword(bearer[1].trim()) : false
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.options.key).update(payload).digest('hex')
  }
}

/** 新装密钥:32 字节 hex */
export function createAuthKey(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 登录退避(纯状态机,时钟注入)。
 *
 * `freeAttempts` 次以内不惩罚(手抖输错很正常);超过之后每次失败把窗口翻倍,
 * 封顶 `maxMs`。判定与记录分开(`check` 只看,`fail`/`success` 才改状态),好测也好接。
 */
export class LoginThrottle {
  private readonly state = new Map<string, { failures: number; blockedUntil: number }>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly opts: { freeAttempts?: number; baseMs?: number; maxMs?: number } = {}
  ) {}

  private get free() {
    return this.opts.freeAttempts ?? 5
  }
  private get base() {
    return this.opts.baseMs ?? 30_000
  }
  private get cap() {
    return this.opts.maxMs ?? 5 * 60_000
  }

  /** 现在能不能试;不能则给出还要等多久 */
  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const entry = this.state.get(key)
    if (!entry) return { allowed: true, retryAfterMs: 0 }
    const wait = entry.blockedUntil - this.now()
    return wait > 0 ? { allowed: false, retryAfterMs: wait } : { allowed: true, retryAfterMs: 0 }
  }

  /** 记一次失败;返回本次要封多久(0 = 还在容错区间内) */
  fail(key: string): number {
    const entry = this.state.get(key) ?? { failures: 0, blockedUntil: 0 }
    entry.failures += 1
    let blocked = 0
    // 前 `free` 次不惩罚(手抖输错很正常);第 free+1 次起把窗口翻倍
    if (entry.failures > this.free) {
      const over = entry.failures - this.free - 1
      blocked = Math.min(this.base * 2 ** over, this.cap)
      entry.blockedUntil = this.now() + blocked
    }
    this.state.set(key, entry)
    return blocked
  }

  success(key: string): void {
    this.state.delete(key)
  }

  /** 供设置页「解除封禁」/测试清理 */
  reset(key?: string): void {
    if (key === undefined) this.state.clear()
    else this.state.delete(key)
  }
}
