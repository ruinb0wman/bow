/**
 * 夸克网盘插件:纯逻辑(三端安全,**不 import electron / node:fs**)。
 *
 * 分工:
 * - 本文件:URL 判定、接口请求头与 body、响应解析、错误码、分批、文件名与 aria2 请求构造、设置归一 —— 全部可单测;
 * - `scripts.ts`:注入页面的脚本字符串(读文件列表);
 * - `main.ts`:唯一接触 electron 的地方(`net.fetch` / `session.cookies` / `ctx.pages.execute`);
 * - `ui/*.vue`:只调 IPC 与渲染。
 *
 * 出口只有一个:**把直链推送到 aria2 RPC**。请求头(UA / Referer / 白名单 Cookie)必须显式交给 aria2 ——
 * 下载是 aria2 发的,浏览器 cookie 域罐帮不上忙。
 *
 * 背景(为什么是这套接口):LinkSwift 1.1.3 的夸克实现是唯一可逐行核对的公开依据 ——
 * 用**官方 PC 客户端的 UA** 调 `/file/download`,响应里的 `download_url` 必须配同一 UA 才能下载。
 * 详见 `.pi/plans/2026-09-24-quark-plugin/plan.md` §1.3。
 */

import { hostMatches } from '@shared/pluginMatch'
import { formatBytes } from '@plugins/downloads/shared'

/** 个人网盘页的宿主(分享页 `/s/...` 明确不在本次范围,见 `isQuarkHomeUrl`) */
export const QUARK_HOME_HOSTS = ['pan.quark.cn', 'drive.quark.cn'] as const

/** 取直链接口(LinkSwift 1.1.3 的 `$quark.api.getLink`,逐字照抄) */
export const QUARK_API_URL = 'https://drive-pc.quark.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=ucpro'

/**
 * 伪装 UA(官方 PC 客户端)。**这是整套方案唯一的命门**:接口按 UA 决定返回的是不是可直连的直链,
 * CDN 也按 UA 校验。所以它做成设置项 —— 夸克一升级客户端,用户改个字符串即可,不用等发版。
 */
export const QUARK_UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch'

export const QUARK_REFERER = 'https://pan.quark.cn/'

/**
 * ⚠️ 故意**不发** `Origin`。
 *
 * 实测(Electron 44):`net.fetch` 只要带上 `Origin` 就必定 `net::ERR_FAILED`
 * (它是 fetch 规范的 forbidden header,Chromium 直接拒发,而不是静默丢弃),
 * 而 `Referer` / `Cookie` / 自定义头都正常。
 * LinkSwift 能发 `Origin` 是因为它走 GM_xmlhttpRequest(特权 XHR,不受 fetch 限制)。
 * 顺带也更像官方 PC 客户端 —— 桌面应用不会发 `Origin`。
 */

/** 允许注入 Cookie 的域名白名单(默认拒绝:空白名单 = 不注入) */
export const QUARK_COOKIE_HOSTS_DEFAULT = ['quark.cn', 'uc.cn']

/** 接口返回码 */
export const QUARK_CODE = {
  ok: 0,
  /** 未登录 */
  notLoggedIn: 31001,
  /** 超出游客可获取大小限制(message 里含 `[fid]`) */
  guestSizeLimit: 23018
} as const

/** 每批取多少个 fid 的直链(LinkSwift 用 15) */
export const QUARK_BATCH_SIZE = 15
/** 批间隔(节流,降低风控概率) */
export const QUARK_BATCH_DELAY_MS = 1000

export interface QuarkFile {
  fid: string
  name: string
  size: number
  /** false = 文件夹(文件夹不能直接取直链,面板里禁用勾选) */
  isFile: boolean
  updatedAt?: number
}

/** 一次取直链的结果;`url` 为空串表示该文件没拿到链接(响应里缺 `download_url`) */
export interface QuarkLink {
  fid: string
  name: string
  size: number
  url: string
  /** `new URL(url).host`,空 url 时为空串。面板用它显示诊断信息 */
  host: string
}

/** 页面脚本读回来的快照(见 `scripts.ts` 的 `EXTRACT_JS`) */
export interface QuarkPageSnapshot {
  url: string
  folderName: string
  files: QuarkFile[]
  /** 页面上已勾选的 fid(面板据此预勾选) */
  selected: string[]
  /** 页面结构诊断(列不出来时靠它定位:命中的选择器 / fiber 键前缀 / 顶层 props 键名) */
  diagnostics: QuarkDiagnostics
}

export interface QuarkDiagnostics {
  selector: string
  classList: string
  fiberKeyPrefix: string
  listLength: number
  /** 找到文件列表 props 的那个节点的 props 键名(排查结构漂移用) */
  propKeys: string[]
  /** 脚本走到哪一步失败的 */
  stage: string
}

export interface QuarkAria2Settings {
  domain: string
  port: string
  path: string
  token: string
  dir: string
}

export interface QuarkSettings {
  userAgent: string
  cookieHosts: string[]
  aria2: QuarkAria2Settings
}

export const DEFAULT_QUARK_SETTINGS: QuarkSettings = {
  userAgent: QUARK_UA_DEFAULT,
  cookieHosts: [...QUARK_COOKIE_HOSTS_DEFAULT],
  aria2: { domain: 'http://localhost', port: '16800', path: '/jsonrpc', token: '', dir: '' }
}

// ---------- URL 判定 ----------

/**
 * 是否夸克**个人网盘页**(分享页不算)。
 *
 * 分享页(`/s/<id>`、`/share/...`)需要额外的 `pwd_id` / `share_fid_token` / `stoken`,
 * 本次不做;明确排除掉比「误判后报错」更清楚。
 */
export function isQuarkHomeUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (!QUARK_HOME_HOSTS.some((h) => hostMatches(url.host, h))) return false
  const path = url.pathname.toLowerCase()
  if (path.startsWith('/s/') || path.startsWith('/share/') || path.startsWith('/embed/')) return false
  return true
}

/** 直链域名是否落在 Cookie 白名单里(决定要不要做兜底注入) */
export function isCookieHostAllowed(host: string, hosts: string[]): boolean {
  return hosts.some((p) => !!p && hostMatches(host, p))
}

// ---------- 请求构造 ----------

/** 把 cookie 列表拼成 `k=v; k2=v2`(空列表 → 空串) */
export function cookieHeaderFrom(cookies: Array<{ name?: unknown; value?: unknown }> | null | undefined): string {
  if (!Array.isArray(cookies)) return ''
  const parts: string[] = []
  for (const c of cookies) {
    const name = typeof c?.name === 'string' ? c.name.trim() : ''
    if (!name) continue
    parts.push(`${name}=${typeof c?.value === 'string' ? c.value : ''}`)
  }
  return parts.join('; ')
}

/**
 * 取直链接口的请求头。
 *
 * `Referer` 是照着 LinkSwift 补的(它的 `standHeaders` 会自动加);桌面客户端其实也不发它,
 * 如果哪天接口开始拒绝,第一件该试的事就是把它去掉(面板诊断区会显示原始响应体)。
 * **不发 `Origin`** —— 原因见 `QUARK_REFERER` 上方的注释。
 */
export function buildApiHeaders(input: { ua: string; cookie?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': input.ua,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/json',
    Referer: QUARK_REFERER
  }
  if (input.cookie) headers.Cookie = input.cookie
  return headers
}

/**
 * 交给 **aria2** 的下载请求头。
 *
 * - `User-Agent` 是必须的(CDN 按它校验,与取直链接口用的是同一个伪装 UA);
 * - `Referer` 是保险(夸克 CDN 有时会看它);
 * - **不放 Cookie**:Cookie 由调用方按域名白名单决定要不要补(见 `isCookieHostAllowed`)——
 *   aria2 是独立进程,拿不到浏览器 cookie 域罐,所以这里必须显式传,也就更需要白名单把关。
 */
export function buildAria2Headers(input: { ua: string }): Record<string, string> {
  return { 'User-Agent': input.ua, Referer: QUARK_REFERER }
}

/** 取直链的 POST body(个人网盘页只需要 fids) */
export function buildDownloadBody(fids: string[]): { fids: string[] } {
  return { fids: fids.map((f) => String(f)) }
}

// ---------- 响应解析 ----------

export type QuarkErrorReason = 'not-logged-in' | 'guest-size-limit' | 'api-error' | 'malformed'

export type QuarkParseResult =
  | { ok: true; links: QuarkLink[] }
  | { ok: false; reason: QuarkErrorReason; code?: number; message: string; fid?: string }

/** 响应里单个条目的形状(只取用得到的字段) */
function toLink(raw: unknown): QuarkLink {
  const v = (raw ?? {}) as Record<string, unknown>
  const url = typeof v.download_url === 'string' ? v.download_url : ''
  let host = ''
  if (url) {
    try {
      host = new URL(url).host
    } catch {
      host = ''
    }
  }
  return {
    fid: typeof v.fid === 'string' ? v.fid : '',
    name: typeof v.file_name === 'string' ? v.file_name : '',
    size: typeof v.size === 'number' && Number.isFinite(v.size) ? v.size : 0,
    url,
    host
  }
}

/** 从 23018 的 message 里抠出是哪个文件超限(LinkSwift 的做法:message 里带 `[32位hex]`) */
export function extractFidFromMessage(message: string): string | undefined {
  return /\[([a-f0-9]{32})\]/i.exec(message)?.[1]
}

/**
 * 中文提示为主,服务端原文附在后面。
 * 不要把服务端的 `require login` 直接当文案 —— 面板上没人看得懂,而且丢了「去登录」这个动作指引。
 */
function withServerMessage(friendly: string, serverMessage: string): string {
  return serverMessage ? `${friendly}(服务器:${serverMessage})` : friendly
}

/** 解析 `/file/download` 的响应体。对任何输入都不抛 */
export function parseDownloadResponse(raw: unknown): QuarkParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'malformed', message: '响应不是对象(可能被风控页面/登录页替换)' }
  }
  const r = raw as Record<string, unknown>
  const code = typeof r.code === 'number' ? r.code : undefined
  const message = typeof r.message === 'string' ? r.message : ''

  if (code === undefined) {
    return { ok: false, reason: 'malformed', message: '响应里没有 code 字段' }
  }
  if (code === QUARK_CODE.notLoggedIn) {
    return {
      ok: false,
      reason: 'not-logged-in',
      code,
      message: withServerMessage('请先在 bow 里登录夸克网盘', message)
    }
  }
  if (code === QUARK_CODE.guestSizeLimit) {
    const fid = extractFidFromMessage(message)
    return {
      ok: false,
      reason: 'guest-size-limit',
      code,
      message: withServerMessage('超出游客可获取大小限制,请登录后重试', message),
      ...(fid ? { fid } : {})
    }
  }
  if (code !== QUARK_CODE.ok) {
    return { ok: false, reason: 'api-error', code, message: message || `接口返回 code=${code}` }
  }
  const data = r.data
  if (!Array.isArray(data)) {
    return { ok: false, reason: 'malformed', code, message: 'code=0 但 data 不是数组' }
  }
  return { ok: true, links: data.map(toLink) }
}

/** 按 size 切批(个人网盘页一批最多 15 个 fid) */
export function chunk<T>(list: T[], size: number): T[][] {
  if (!Array.isArray(list) || list.length === 0) return []
  const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : 1
  const out: T[][] = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}

// ---------- 页面快照归一 ----------

/**
 * 归一 `EXTRACT_JS` 的返回值。脚本跑在页面主世界,拿回来的东西**不可信**
 * (页面结构变了、被别的脚本改了、React 内部字段改名),所以这里逐字段校验。
 */
export function normalizePageSnapshot(
  raw: unknown
): { ok: true; snapshot: QuarkPageSnapshot } | { ok: false; error: string; diagnostics?: QuarkDiagnostics } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '页面脚本没有返回结果' }
  }
  const r = raw as Record<string, unknown>
  const diagnostics = normalizeDiagnostics(r.diagnostics)
  if (r.ok !== true) {
    return { ok: false, error: typeof r.error === 'string' ? r.error : '页面脚本执行失败', diagnostics }
  }
  const filesRaw = Array.isArray(r.files) ? r.files : []
  const files: QuarkFile[] = []
  for (const f of filesRaw) {
    const v = (f ?? {}) as Record<string, unknown>
    const fid = typeof v.fid === 'string' ? v.fid.trim() : ''
    if (!fid) continue
    files.push({
      fid,
      name: typeof v.name === 'string' && v.name ? v.name : fid,
      size: typeof v.size === 'number' && Number.isFinite(v.size) ? v.size : 0,
      isFile: v.isFile !== false,
      ...(typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt) ? { updatedAt: v.updatedAt } : {})
    })
  }
  if (files.length === 0) {
    return { ok: false, error: '当前目录里没有读到文件(可能需要先在页面里进入某个文件夹)', diagnostics }
  }
  const selected = Array.isArray(r.selected)
    ? r.selected.filter((s): s is string => typeof s === 'string')
    : []
  return {
    ok: true,
    snapshot: {
      url: typeof r.url === 'string' ? r.url : '',
      folderName: typeof r.folderName === 'string' ? r.folderName : '',
      files,
      selected,
      diagnostics
    }
  }
}

function normalizeDiagnostics(raw: unknown): QuarkDiagnostics {
  const d = (raw ?? {}) as Record<string, unknown>
  return {
    selector: typeof d.selector === 'string' ? d.selector : '',
    classList: typeof d.classList === 'string' ? d.classList : '',
    fiberKeyPrefix: typeof d.fiberKeyPrefix === 'string' ? d.fiberKeyPrefix : '',
    listLength: typeof d.listLength === 'number' ? d.listLength : 0,
    propKeys: Array.isArray(d.propKeys) ? d.propKeys.filter((k): k is string => typeof k === 'string') : [],
    stage: typeof d.stage === 'string' ? d.stage : ''
  }
}

/** 只留文件(文件夹不能取直链) */
export function pickFiles(files: QuarkFile[]): QuarkFile[] {
  return files.filter((f) => f.isFile)
}

/**
 * 按 fid 或文件名挑选目标文件。
 *
 * `fids` 优先(精确);否则按 `names` 先精确后包含匹配(AI 常常只说得出文件名);
 * 两者都空 = 全部文件。文件夹无论怎样都不会被选中。
 */
export function selectFiles(files: QuarkFile[], input: { fids?: unknown; names?: unknown }): QuarkFile[] {
  const filesOnly = pickFiles(files)
  const toList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter((x) => !!x) : []

  const fids = toList(input.fids)
  if (fids.length > 0) {
    const wanted = new Set(fids)
    return filesOnly.filter((f) => wanted.has(f.fid))
  }

  const names = toList(input.names)
  if (names.length === 0) return filesOnly

  const out: QuarkFile[] = []
  const push = (f: QuarkFile): void => {
    if (!out.includes(f)) out.push(f)
  }
  for (const raw of names) {
    const exact = filesOnly.find((f) => f.name === raw)
    if (exact) {
      push(exact)
      continue
    }
    const lower = raw.toLowerCase()
    for (const f of filesOnly) {
      if (f.name.toLowerCase().includes(lower)) push(f)
    }
  }
  return out
}

// ---------- 文件名 / 命令构造 ----------

/** 去掉文件系统非法字符与首尾空白/点(`<>:"/\|?*` + 控制字符) */
export function sanitizeFilename(name: string): string {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  return cleaned || 'download'
}

/** aria2 JSON-RPC `aria2.addUri` 的请求体(LinkSwift 的参数形状) */
export function buildAria2RpcBody(input: {
  url: string
  filename: string
  headers: Record<string, string>
  settings: QuarkAria2Settings
  id?: number
}): Record<string, unknown> {
  const header = Object.entries(input.headers).map(([name, value]) => `${name}:${value}`)
  const options: Record<string, unknown> = { out: sanitizeFilename(input.filename), header }
  const dir = input.settings.dir.trim()
  if (dir) options.dir = dir
  const token = input.settings.token.trim()
  return {
    id: input.id ?? Date.now(),
    jsonrpc: '2.0',
    method: 'aria2.addUri',
    params: [`token:${token}`, [input.url], options]
  }
}

/** aria2 RPC 的完整地址(域名已含协议) */
export function aria2RpcUrl(settings: QuarkAria2Settings): string {
  const domain = settings.domain.trim().replace(/\/+$/, '')
  const path = settings.path.trim() || '/jsonrpc'
  return `${domain}:${settings.port.trim()}${path.startsWith('/') ? path : `/${path}`}`
}

// ---------- 设置归一 ----------

export { formatBytes }

/** 端口字符串夹紧到 1..65535(非数字 → 用 fallback) */
export function normalizePort(value: unknown, fallback: string): string {
  const s = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
  if (!s) return fallback
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback
  return String(n)
}

/** 逗号/空格分隔的字符串或数组 → 去重去空的字符串数组 */
export function normalizeHostList(value: unknown, fallback: string[]): string[] {
  let items: string[]
  if (Array.isArray(value)) items = value.filter((v): v is string => typeof v === 'string')
  else if (typeof value === 'string') items = value.split(/[\s,;]+/)
  else return [...fallback]
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const h = raw.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
    if (!h || seen.has(h)) continue
    seen.add(h)
    out.push(h)
  }
  return out.length > 0 ? out : [...fallback]
}

/** 设置归一:坏字段回退 `prev`(与 downloads 的 `normalizeSettings` 同一策略) */
export function normalizeQuarkSettings(patch: unknown, prev: QuarkSettings): QuarkSettings {
  const raw = patch && typeof patch === 'object' && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {}
  const userAgent =
    typeof raw.userAgent === 'string' && raw.userAgent.trim() ? raw.userAgent.trim() : prev.userAgent
  const cookieHosts = raw.cookieHosts === undefined ? [...prev.cookieHosts] : normalizeHostList(raw.cookieHosts, prev.cookieHosts)
  const rawAria = raw.aria2 && typeof raw.aria2 === 'object' && !Array.isArray(raw.aria2) ? (raw.aria2 as Record<string, unknown>) : {}
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v.trim() : fallback)
  return {
    userAgent,
    cookieHosts,
    aria2: {
      domain: str(rawAria.domain, prev.aria2.domain) || prev.aria2.domain,
      port: normalizePort(rawAria.port, prev.aria2.port),
      path: str(rawAria.path, prev.aria2.path),
      token: str(rawAria.token, prev.aria2.token),
      dir: str(rawAria.dir, prev.aria2.dir)
    }
  }
}

/** 面板诊断区要展示的「直链域名」摘要 */
export function describeLinkHosts(links: QuarkLink[]): Array<{ host: string; count: number }> {
  const map = new Map<string, number>()
  for (const l of links) {
    const host = l.host || '(无链接)'
    map.set(host, (map.get(host) ?? 0) + 1)
  }
  return [...map.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count)
}
