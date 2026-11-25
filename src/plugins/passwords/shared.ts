/**
 * 密码插件的**同构纯逻辑**(无 electron / node: 内置模块 / DOM 依赖)。
 *
 * 为什么单独一个文件:`tsconfig.web.json` 也收录 `src/plugins/*\/shared.ts`(渲染层组件要引它),
 * 所以这里**绝不能**出现 `node:crypto` 之类的 Node 专有依赖 —— 加解密在 `vault.ts`(只被 main.ts 引入)。
 * 这里负责:条目模型与归一化、站点匹配、设置夹紧、密码生成(随机源可注入,便于单测)。
 */

export interface PasswordEntry {
  id: string
  /** 展示名(默认取 origin 的主机名) */
  title: string
  /** 匹配键:`new URL(url).origin`,只存 http/https */
  origin: string
  username: string
  password: string
  notes?: string
  createdAt: number
  updatedAt: number
  /** 最近一次填充 / 复制的时间(列表排序用) */
  usedAt?: number
}

/** 列表用的投影:不含密码 */
export type EntryMeta = Omit<PasswordEntry, 'password'>

export interface PasswordSettings {
  /** 自动锁定分钟数;0 = 不自动锁定 */
  autoLockMinutes: number
  /** 复制密码后多少秒清除剪贴板;0 = 不清除 */
  clipboardClearSeconds: number
  /** 是否让「条目 host 的后缀」命中页面(accounts.google.com ← google.com) */
  matchSubdomains: boolean
}

export const DEFAULT_PASSWORD_SETTINGS: PasswordSettings = {
  autoLockMinutes: 5,
  clipboardClearSeconds: 30,
  matchSubdomains: true
}

/** 设置页下拉的合法值(归一化时按这个集合判定,不是简单夹紧) */
export const AUTO_LOCK_OPTIONS = [0, 1, 5, 15, 30, 60] as const
export const CLIPBOARD_CLEAR_OPTIONS = [0, 15, 30, 60, 120] as const

export interface GenerateOptions {
  length: number
  upper: boolean
  lower: boolean
  digits: boolean
  symbols: boolean
  /** 去掉形近字符 0 O 1 l I | ` ' " */
  avoidAmbiguous: boolean
}

export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: true
}

// ---------- IPC 返回形状(渲染层与主进程共用,避免两边各写一份) ----------

export interface PasswordStatus {
  ok: boolean
  initialized: boolean
  locked: boolean
  count: number
  settings: PasswordSettings
}

export interface OkResult {
  ok: boolean
  error?: string
}

export interface EntryListResult extends OkResult {
  entries?: EntryMeta[]
}

export interface SingleEntryResult extends OkResult {
  entry?: PasswordEntry
}

/** 「从当前页面保存」读回的字段(密码值只在这条通路上跨到渲染层) */
export interface ReadPageFieldsResult extends OkResult {
  tabId?: number
  url?: string
  title?: string
  origin?: string
  hasPassword?: boolean
  username?: string
  password?: string
}

/** 按钮 / 快捷键主流程的结局 */
export type BeginFillMode =
  | 'filled'
  | 'picked'
  | 'cancelled'
  | 'no-form'
  | 'no-match'
  | 'locked'
  | 'setup'
  | 'busy'
  | 'no-tab'
  | 'unsupported'
  | 'error'

export interface BeginFillResult extends OkResult {
  mode?: BeginFillMode
}

/** 面板编辑器的草稿(origin 可以是完整 URL,保存时由主进程归一化) */
export interface EntryDraft {
  id?: string
  title: string
  origin: string
  username: string
  password: string
  notes: string
}

export function emptyDraft(): EntryDraft {
  return { title: '', origin: '', username: '', password: '', notes: '' }
}

export function draftFromEntry(entry: PasswordEntry): EntryDraft {
  return {
    id: entry.id,
    title: entry.title,
    origin: entry.origin,
    username: entry.username,
    password: entry.password,
    notes: entry.notes ?? ''
  }
}

export function draftFromFields(fields: {
  origin?: string
  title?: string
  username?: string
  password?: string
}): EntryDraft {
  return {
    title: fields.title ?? '',
    origin: fields.origin ?? '',
    username: fields.username ?? '',
    password: fields.password ?? '',
    notes: ''
  }
}

const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?'
const AMBIGUOUS = new Set(['0', 'O', '1', 'l', 'I', '|', '`', "'", '"'])

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function cryptoGlobal(): {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
} | null {
  const c = (globalThis as { crypto?: unknown }).crypto
  return c && typeof c === 'object' ? (c as never) : null
}

/** 生成一个条目 id(优先 UUID,拿不到随机源时退化为时间戳 + 随机串) */
export function newId(): string {
  const c = cryptoGlobal()
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'pw-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** 仅 http/https 视为可匹配 / 可填充的页面 */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** URL → origin(非 http/https 或解析失败返回 null) */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

/** URL / origin → 主机名(解析失败返回空串) */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 条目 origin 是否命中页面 origin(可选后缀匹配) */
export function entryMatchesOrigin(
  entryOrigin: string,
  pageOrigin: string,
  matchSubdomains: boolean
): boolean {
  if (!entryOrigin || !pageOrigin) return false
  if (entryOrigin === pageOrigin) return true
  if (!matchSubdomains) return false
  let e: URL
  let p: URL
  try {
    e = new URL(entryOrigin)
    p = new URL(pageOrigin)
  } catch {
    return false
  }
  // 协议 / 端口必须一致;跨端口的后缀匹配是安全隐患,宁可匹配不上
  if (e.protocol !== p.protocol || e.port !== p.port) return false
  const eh = e.hostname.toLowerCase()
  const ph = p.hostname.toLowerCase()
  // 条目 host 至少两段,避免把 `com.cn` 这类存进来后匹配一大片
  if (eh.split('.').length < 2) return false
  return ph !== eh && ph.endsWith('.' + eh)
}

/** 命中某页面 origin 的全部条目,按「最近使用 → 标题」排序 */
export function matchEntries(
  entries: PasswordEntry[],
  pageOrigin: string,
  matchSubdomains: boolean
): PasswordEntry[] {
  return sortEntries(entries.filter((e) => entryMatchesOrigin(e.origin, pageOrigin, matchSubdomains)))
}

/** 列表排序:最近使用优先,其次按标题(中文按本地规则) */
export function sortEntries(list: PasswordEntry[]): PasswordEntry[] {
  return [...list].sort((a, b) => {
    const au = a.usedAt ?? 0
    const bu = b.usedAt ?? 0
    if (au !== bu) return bu - au
    return a.title.localeCompare(b.title, 'zh-Hans-CN')
  })
}

/** 列表投影(去掉密码) */
export function toMeta(entry: PasswordEntry): EntryMeta {
  const { password: _password, ...meta } = entry
  return meta
}

/** 归一化单条(origin 缺失 / 非法 → null;其余字段兜底) */
export function normalizeEntry(raw: unknown): PasswordEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const origin = str(o.origin)
  if (!originOf(origin)) return null
  const now = Date.now()
  const entry: PasswordEntry = {
    id: str(o.id) || newId(),
    title: str(o.title) || hostOf(origin) || origin,
    origin,
    username: str(o.username),
    password: str(o.password),
    createdAt: num(o.createdAt, now),
    updatedAt: num(o.updatedAt, now)
  }
  const notes = str(o.notes)
  if (notes) entry.notes = notes
  const usedAt = o.usedAt
  if (typeof usedAt === 'number' && Number.isFinite(usedAt)) entry.usedAt = usedAt
  return entry
}

/** 归一化整个数组:坏条目丢弃、id 去重(坏数据不该让面板炸掉) */
export function normalizeEntries(raw: unknown): PasswordEntry[] {
  if (!Array.isArray(raw)) return []
  const out: PasswordEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const entry = normalizeEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push(entry)
  }
  return out
}

/** 设置夹紧:只接受下拉里的合法值,其余回退默认 */
export function normalizeSettings(raw: unknown): PasswordSettings {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const auto = num(o.autoLockMinutes, DEFAULT_PASSWORD_SETTINGS.autoLockMinutes)
  const clear = num(o.clipboardClearSeconds, DEFAULT_PASSWORD_SETTINGS.clipboardClearSeconds)
  const inList = (list: readonly number[], v: number): boolean => list.includes(v)
  return {
    autoLockMinutes: inList(AUTO_LOCK_OPTIONS, auto) ? auto : DEFAULT_PASSWORD_SETTINGS.autoLockMinutes,
    clipboardClearSeconds: inList(CLIPBOARD_CLEAR_OPTIONS, clear)
      ? clear
      : DEFAULT_PASSWORD_SETTINGS.clipboardClearSeconds,
    matchSubdomains:
      typeof o.matchSubdomains === 'boolean'
        ? o.matchSubdomains
        : DEFAULT_PASSWORD_SETTINGS.matchSubdomains
  }
}

export type RandomBytes = (n: number) => Uint8Array

function defaultRandomBytes(n: number): Uint8Array {
  const c = cryptoGlobal()
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('当前环境缺少安全随机源')
  const buf = new Uint8Array(n)
  c.getRandomValues(buf)
  return buf
}

/**
 * 生成强密码。用**拒绝采样**(丢弃 >= 256 - 256 % len 的字节)消除取模偏差;
 * `randomBytes` 可注入,测试用确定性随机源。
 */
export function generatePassword(
  opts: Partial<GenerateOptions> = {},
  randomBytes: RandomBytes = defaultRandomBytes
): string {
  const o: GenerateOptions = { ...DEFAULT_GENERATE_OPTIONS, ...opts }
  const length = clamp(Math.round(o.length), 4, 128)
  let charset = ''
  if (o.lower) charset += 'abcdefghijklmnopqrstuvwxyz'
  if (o.upper) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  if (o.digits) charset += '0123456789'
  if (o.symbols) charset += SYMBOLS
  if (o.avoidAmbiguous) charset = [...charset].filter((c) => !AMBIGUOUS.has(c)).join('')
  if (!charset) charset = 'abcdefghijklmnopqrstuvwxyz'

  const limit = 256 - (256 % charset.length)
  let out = ''
  let guard = 0
  while (out.length < length && guard < 1000) {
    guard++
    const buf = randomBytes(Math.max(16, length - out.length + 8))
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const b = buf[i]
      if (b < limit) out += charset[b % charset.length]
    }
  }
  if (out.length < length) throw new Error('安全随机源不可用')
  return out
}
