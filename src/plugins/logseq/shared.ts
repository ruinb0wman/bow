/**
 * 笔记插件纯逻辑(同构:无 electron / DOM / node 依赖,可单测)。
 *
 * 分工:
 * - `format.ts`:Logseq 文件格式的行模型 / 解析 / 序列化 / 行内 tokenizer;
 * - 本文件:日期 ↔ 文件名词干、页面名 ↔ 文件名、`logseq/config.edn` 键值提取、日志模板变量、块编辑命令;
 * - `graph.ts`:索引与反链(文件访问以接口注入);
 * - `main.ts`:真实文件系统 + `fs.watch` + 目录选择框 + IPC(唯一碰磁盘的地方);
 * - `ui/*.vue`:块视图与设置分区。
 *
 * ⚠️ 编辑命令的实现方式是「深拷贝 → 改 → reindex」:`format.ts` 的 `cloneFile()` 保证未触及的
 * `SourceLine` 对象**原样复用**,所以序列化出来的文件里那些行逐字节不变 ——
 * 这是「与 Logseq 共用同一个图」的安全底线,`tests/logseqFormat.test.ts` 有断言。
 */

import {
  blockLinesForDisplay,
  blockText,
  cloneFile,
  detectIndentUnit,
  indentText,
  reindex,
  type BlockNode,
  type ParsedFile,
  type SourceLine
} from './format'

export * from './format'

// ---------- 插件设置 ----------

export const SETTINGS_VERSION = 1
/** 记住的最近图数量上限 */
export const MAX_RECENT_GRAPHS = 5
/** 每个图最多收藏多少页(收藏按图分开记,见 `favorites`) */
export const MAX_FAVORITES_PER_GRAPH = 30
/** 笔记正文字号的可选范围(px) */
export const LOGSEQ_FONT_SIZE_RANGE = { min: 12, max: 24 } as const
/** 默认字号与全局 `body`(13px)一致:什么都没配时观感不变 */
export const DEFAULT_LOGSEQ_FONT_SIZE = 13

/** 笔记插件广播的事件名(主进程与页面共用一处,避免字符串漂移) */
export const LOGSEQ_EVENT = {
  graphChanged: 'graph-changed',
  settingsChanged: 'settings-changed',
  favoritesChanged: 'favorites-changed'
} as const

export interface LogseqSettings {
  version: number
  /** 当前图目录(空串 = 还没选) */
  graphPath: string
  /** 最近打开的图目录(最近优先) */
  recentGraphs: string[]
  /** 笔记正文字号(px) */
  fontSize: number
  /** 图目录(规范化后的绝对路径)→ 该图的收藏(最近收藏在前) */
  favorites: Record<string, LogseqView[]>
}

/**
 * 渲染页面需要的偏好(IPC 面)。
 * 收藏只给**当前图**的那一份:图是页面里的上下文,页面不该看到别的图收藏了什么。
 */
export interface LogseqClientSettings {
  fontSize: number
  favorites: LogseqView[]
}

export function defaultSettings(): LogseqSettings {
  return {
    version: SETTINGS_VERSION,
    graphPath: '',
    recentGraphs: [],
    fontSize: DEFAULT_LOGSEQ_FONT_SIZE,
    favorites: {}
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 字号夹紧:非有限数落回兜底,越界夹到边界 */
function clampFontSize(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(LOGSEQ_FONT_SIZE_RANGE.max, Math.max(LOGSEQ_FONT_SIZE_RANGE.min, Math.round(value)))
}

function normalizeFavorites(input: unknown): Record<string, LogseqView[]> {
  const out: Record<string, LogseqView[]> = {}
  if (!input || typeof input !== 'object') return out
  for (const [graph, list] of Object.entries(input as Record<string, unknown>)) {
    const key = graph.trim()
    if (!key || !Array.isArray(list)) continue
    const seen = new Set<string>()
    const views: LogseqView[] = []
    for (const item of list) {
      const view = parseView(item)
      if (!view) continue
      const id = viewKey(view)
      if (seen.has(id)) continue
      seen.add(id)
      views.push(view)
      if (views.length >= MAX_FAVORITES_PER_GRAPH) break
    }
    if (views.length > 0) out[key] = views
  }
  return out
}

export function normalizeSettings(input: unknown, fallback: LogseqSettings = defaultSettings()): LogseqSettings {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const graphPath = str(raw.graphPath).trim()
  const recent: string[] = []
  if (Array.isArray(raw.recentGraphs)) {
    for (const item of raw.recentGraphs) {
      const path = str(item).trim()
      if (!path || path === graphPath || recent.includes(path)) continue
      recent.push(path)
      if (recent.length >= MAX_RECENT_GRAPHS) break
    }
  }
  return {
    version: SETTINGS_VERSION,
    graphPath,
    recentGraphs: recent,
    fontSize: clampFontSize(raw.fontSize, fallback.fontSize),
    favorites: normalizeFavorites(raw.favorites)
  }
}

/**
 * 切换图目录:把旧图推进最近列表并去重。
 * ⚠️ 必须 `...settings` 展开:字号与收藏都要原样带过去(早先只挑两个字段的写法会让切图清空它们)。
 */
export function withGraph(settings: LogseqSettings, graphPath: string): LogseqSettings {
  const path = graphPath.trim()
  if (!path) return settings
  const recent = [settings.graphPath, ...settings.recentGraphs].filter((p): p is string => Boolean(p) && p !== path)
  return normalizeSettings({ ...settings, graphPath: path, recentGraphs: recent })
}

/** 某个图的收藏列表(没配过 = 空数组) */
export function favoritesFor(settings: LogseqSettings, graphPath: string): LogseqView[] {
  return settings.favorites[graphPath.trim()] ?? []
}

/** 编辑器标签的视图状态(按 tabId 记在主进程,标签刷新后回到同一页) */
export type LogseqView = { kind: 'journal'; day: string } | { kind: 'page'; name: string }

export function viewKey(view: LogseqView): string {
  return view.kind === 'journal' ? `journal:${view.day}` : `page:${view.name}`
}

/** 把任意输入解析成合法视图;不合法返回 null(与「回落到兜底」的 `normalizeView` 分开) */
export function parseView(input: unknown): LogseqView | null {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const kind = str(raw.kind)
  if (kind === 'journal') {
    const day = str(raw.day).trim()
    return isJournalDay(day) ? { kind: 'journal', day } : null
  }
  if (kind === 'page') {
    const name = str(raw.name).trim()
    return name ? { kind: 'page', name } : null
  }
  return null
}

export function normalizeView(input: unknown, fallback: LogseqView): LogseqView {
  return parseView(input) ?? fallback
}

// ---------- IPC 面(主进程 ↔ `bow://logseq` 页面)的载荷类型 ----------
//
// 页面只能经 `plugins.invoke` 拿数据,所以这些形状是两侧的契约 —— 定义在 shared 里,
// 主进程与渲染层引同一份,避免各自写一个「差不多」的接口然后漂移。

export interface IndexSummary {
  files: number
  blocks: number
  refs: number
  days: number
  tooLarge: boolean
}

export interface GraphState {
  graphPath: string
  recentGraphs: string[]
  config: GraphConfig
  /** 图可用(目录还在、不是 DB 图) */
  ok: boolean
  error?: string
  index?: IndexSummary
  template: { configured: string; available: string[] }
  dateFormat: { format: string; ok: boolean; unsupported: string | null }
  today: string
}

/** 读一个日志/页面的结果。`exists:false` = 文件还不存在(第一次编辑才落盘) */
export interface FileRead {
  view: LogseqView
  path: string
  rel: string
  exists: boolean
  raw: string
  mtimeMs: number | null
  /** 内容来自日志模板(还没落盘) */
  fromTemplate?: string
  /** 首次保存时要写进文件头部的 `title::`(文件名表达不了标题时) */
  titleProp?: string
  title: string
}

/** 保存结果:`conflict` 时带磁盘上的内容,由界面决定重载还是强行覆盖 */
export interface SaveResult {
  ok: boolean
  mtimeMs?: number
  conflict?: boolean
  diskRaw?: string
  error?: string
}

/** 选图 / 切图的结果(永远回一份最新状态,界面不必再问一次) */
export interface GraphSwitchResult {
  ok: boolean
  error?: string
  state: GraphState
}

// ---------- 日期 ↔ 文件名词干 ----------

export const DEFAULT_JOURNAL_FILE_FORMAT = 'yyyy_MM_dd'
const DATE_TOKENS = ['yyyy', 'yy', 'MM', 'M', 'dd', 'd'] as const
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export interface DateFormatSpec {
  /** 能否按这个格式读写(不认识的 token 会让它变成 false) */
  ok: boolean
  /** 实际使用的格式串(ok=false 时是回落值) */
  format: string
  /** 不认识的 token(给设置页提示用);null = 没遇到 */
  unsupported: string | null
  /** 格式串里的 token,顺序与 `match` 的捕获组一致 */
  tokens: string[]
  /** 匹配词干用的完整正则 */
  match: RegExp
}

interface RawSpec {
  tokens: string[]
  pattern: string
  unsupported: string | null
}

function scanFormat(format: string): RawSpec {
  const tokens: string[] = []
  const seen = new Set<string>()
  let pattern = ''
  let unsupported: string | null = null
  let i = 0
  while (i < format.length) {
    if (!/[A-Za-z]/.test(format[i])) {
      pattern += escapeRegExp(format[i])
      i++
      continue
    }
    // 先取整段连续字母,再试把它完整切成 token:切不动或出现重复类别(如 `MMM` = MM + M)
    // 就整段当成不认识的标记 —— 宁可回落到默认格式,也不要读写错位的日期
    let j = i
    while (j < format.length && /[A-Za-z]/.test(format[j])) j++
    const run = format.slice(i, j)
    const parsed = tokenizeRun(run, seen)
    if (!parsed) {
      unsupported = unsupported ?? run
      pattern += escapeRegExp(run)
    } else {
      tokens.push(...parsed.tokens)
      pattern += parsed.pattern
      for (const category of parsed.categories) seen.add(category)
    }
    i = j
  }
  return { tokens, pattern, unsupported }
}

function categoryOf(token: string): 'year' | 'month' | 'day' {
  if (token === 'yyyy' || token === 'yy') return 'year'
  if (token === 'MM' || token === 'M') return 'month'
  return 'day'
}

/** 把一段连续字母切成日期 token;切不干净或同类 token 重复则返回 null */
function tokenizeRun(run: string, seen: Set<string>): { tokens: string[]; pattern: string; categories: string[] } | null {
  const tokens: string[] = []
  const categories: string[] = []
  let pattern = ''
  let i = 0
  while (i < run.length) {
    const token = DATE_TOKENS.find((t) => run.startsWith(t, i))
    if (!token) return null
    const category = categoryOf(token)
    if (seen.has(category) || categories.includes(category)) return null
    tokens.push(token)
    categories.push(category)
    pattern += tokenPattern(token)
    i += token.length
  }
  return { tokens, pattern, categories }
}

function specOf(raw: RawSpec, format: string, ok: boolean, unsupported: string | null): DateFormatSpec {
  return { ok, format, unsupported, tokens: raw.tokens, match: new RegExp(`^${raw.pattern}$`) }
}

/**
 * 把日期格式串编成「一个正则 + 一组 token」,`formatJournalStem` 与 `parseJournalStem` 共用它 ——
 * 读写只有一个来源,不会各自漂移。
 *
 * 支持 `yyyy yy MM M dd d` 与其它字面字符;遇到不认识的字母 token(moment 语法的 `EEE`、`do`、`MMM` 等)
 * 时**整条规则回落到默认格式**(`ok:false` + `unsupported` 给设置页提示) ——
 * 读现有文件还有 `parseLooseDay` 兜底,所以不会在同一天多出一个文件。
 */
export function compileDateFormat(format: string): DateFormatSpec {
  const requested = format.trim()
  if (requested) {
    const raw = scanFormat(requested)
    if (raw.unsupported === null) return specOf(raw, requested, true, null)
    const fallback = scanFormat(DEFAULT_JOURNAL_FILE_FORMAT)
    return specOf(fallback, DEFAULT_JOURNAL_FILE_FORMAT, false, raw.unsupported)
  }
  return specOf(scanFormat(DEFAULT_JOURNAL_FILE_FORMAT), DEFAULT_JOURNAL_FILE_FORMAT, true, null)
}

function tokenPattern(token: string): string {
  switch (token) {
    case 'yyyy':
      return '(\\d{4})'
    case 'yy':
      return '(\\d{2})'
    case 'MM':
      return '(\\d{2})'
    case 'M':
      return '(\\d{1,2})'
    case 'dd':
      return '(\\d{2})'
    case 'd':
      return '(\\d{1,2})'
    default:
      return '(\\d+)'
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `YYYY-MM-DD` → 文件名词干(按格式串;`compileDateFormat` 会保证用的是**实际生效**的格式) */
export function formatJournalStem(day: string, format: string = DEFAULT_JOURNAL_FILE_FORMAT): string {
  const parts = dayParts(day)
  if (!parts) return day
  const spec = compileDateFormat(format)
  // 用与 `spec.match` 同一套 token 顺序重放一遍格式串:不能只 replace 字符串,
  // 否则 `MM` / `M` 与字面字母的边界会飘(而且这里必须与 tokenizeRun 的切法完全一致)
  let out = ''
  let i = 0
  while (i < spec.format.length) {
    if (!/[A-Za-z]/.test(spec.format[i])) {
      out += spec.format[i]
      i++
      continue
    }
    let j = i
    while (j < spec.format.length && /[A-Za-z]/.test(spec.format[j])) j++
    const run = spec.format.slice(i, j)
    let k = 0
    while (k < run.length) {
      const token = DATE_TOKENS.find((t) => run.startsWith(t, k))
      if (!token) break
      out += valueOfToken(token, parts)
      k += token.length
    }
    i = j
  }
  return out
}

function valueOfToken(token: string, parts: { year: number; month: number; day: number }): string {
  switch (token) {
    case 'yyyy':
      return pad(parts.year, 4)
    case 'yy':
      return pad(parts.year % 100, 2)
    case 'MM':
      return pad(parts.month, 2)
    case 'M':
      return String(parts.month)
    case 'dd':
      return pad(parts.day, 2)
    case 'd':
      return String(parts.day)
    default:
      return token
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function isoOf(parts: { year: number; month: number; day: number }): string {
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`
}

/** 文件名词干 → `YYYY-MM-DD`;不匹配或日期非法返回 null */
export function parseJournalStem(stem: string, spec: DateFormatSpec | string): string | null {
  const compiled = typeof spec === 'string' ? compileDateFormat(spec) : spec
  const m = compiled.match.exec(stem)
  if (!m) return null
  let year = 0
  let month = 1
  let day = 1
  compiled.tokens.forEach((token, index) => {
    const value = Number(m[index + 1])
    if (!Number.isFinite(value)) return
    if (token === 'yyyy') year = value
    else if (token === 'yy') year = 2000 + value
    else if (token === 'MM' || token === 'M') month = value
    else day = value
  })
  const parts = dayParts(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`)
  return parts ? isoOf(parts) : null
}

/**
 * 宽松解析:`2026_09_20` / `2026-09-20` / `2026.9.20` / `2026-09-20 周日` 都能认出来。
 * 只用于**读**现有文件 —— 用户把图从别的配置迁过来时文件名可能不合当前格式串,
 * 认出来就不会在同一天新建第二个文件。写永远走 `formatJournalStem`。
 */
export function parseLooseDay(stem: string): string | null {
  const m = /^(\d{4})[^0-9](\d{1,2})[^0-9](\d{1,2})(?:[^0-9].*)?$/.exec(stem.trim())
  if (!m) return null
  const parts = dayParts(`${m[1]}-${pad(Number(m[2]), 2)}-${pad(Number(m[3]), 2)}`)
  return parts ? isoOf(parts) : null
}

export function isJournalDay(day: string): boolean {
  return dayParts(day) !== null
}

/** 解析 `YYYY-MM-DD` 并校验真实存在(`2026-02-30` 不算) */
function dayParts(day: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const dayOfMonth = Number(m[3])
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null
  const check = new Date(Date.UTC(year, month - 1, dayOfMonth))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== dayOfMonth) return null
  return { year, month, day: dayOfMonth }
}

/** 本地当天(刻意用本地时区:日志是「人的一天」,不是 UTC 的一天) */
export function todayDay(now: Date = new Date()): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`
}

/** 日期加减天数(跨月跨年交给 Date) */
export function shiftDay(day: string, delta: number): string {
  const parts = dayParts(day)
  if (!parts) return day
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  d.setUTCDate(d.getUTCDate() + delta)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`
}

/** 界面上显示的日志标题(`2026-09-20 周日`);磁盘上的文件名与它无关,只影响显示 */
export function formatDayTitle(day: string): string {
  const parts = dayParts(day)
  if (!parts) return day
  const weekday = WEEKDAYS[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()] ?? ''
  return `${day} ${weekday}`
}

// ---------- 页面名 ↔ 文件名 ----------

/** 文件名词干上限(Logseq 的 `markdown_mirror` 用同一个数) */
export const MAX_FILE_STEM = 160
/** 非法文件名字符(与 Logseq 的 `invalid-file-name-chars-re` 一致) */
const INVALID_FILE_CHARS = /[<>:"|?*\\]/g

/**
 * 页面名 → 文件名词干(Logseq 的默认 `:file/name-format :triple-lowbar`):
 * `/` → `___`;其余保留字符百分号编码;NFC 归一;去掉结尾的空格与点;截断 160。
 *
 * ⚠️ 已知歧义(与 Logseq 相同):标题里**字面**出现 `___` 时无法与命名空间分隔符区分,
 * 解码时会被当成 `/`。这是 Logseq 默认格式本身的取舍,镜像它的行为比自作聪明更安全。
 */
export function encodePageName(title: string): string {
  const normalized = typeof title.normalize === 'function' ? title.normalize('NFC') : title
  const encoded = normalized
    .replace(/\//g, '___')
    .replace(INVALID_FILE_CHARS, percentEncode)
    .replace(/[\x00-\x1f]/g, percentEncode)
  const trimmed = encoded.replace(/[ .]+$/, '').trim()
  const stem = trimmed || 'untitled'
  return stem.length > MAX_FILE_STEM ? stem.slice(0, MAX_FILE_STEM) : stem
}

/** `encodeURIComponent` 不转义 `!'()*~`,其中 `*` 在 Windows 文件名里非法,所以再补一遍 */
function percentEncode(ch: string): string {
  return encodeURIComponent(ch).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** 文件名词干 → 页面名(与 `encodePageName` 互逆);`%` 序列坏掉时原样返回 */
export function decodePageName(stem: string): string {
  try {
    return decodeURIComponent(stem.replace(/___/g, '/'))
  } catch {
    return stem.replace(/___/g, '/')
  }
}

/** 页面名的比较键(Logseq 的页面 identity 是小写) */
export function pageKey(name: string): string {
  return name.trim().toLowerCase()
}

// ---------- `logseq/config.edn` 键值提取 ----------

export interface GraphConfig {
  journalsDir: string
  pagesDir: string
  /** `:journal/file-name-format` 的原始字符串 */
  fileFormat: string
  /** `:default-templates {:journals "…"}`;空串 = 没配 */
  defaultJournalTemplate: string
  /** `:hidden ["/archived" …]`,索引时跳过 */
  hidden: string[]
  /** `:block-hidden-properties`,渲染时隐藏(文件里照旧保留) */
  hiddenProperties: string[]
}

export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  journalsDir: 'journals',
  pagesDir: 'pages',
  fileFormat: DEFAULT_JOURNAL_FILE_FORMAT,
  defaultJournalTemplate: '',
  hidden: [],
  hiddenProperties: []
}

function readQuoted(text: string, key: string): string | null {
  const m = new RegExp(`${escapeRegExp(key)}\\s+"([^"\\n]*)"`).exec(text)
  return m ? m[1] : null
}

function readVector(text: string, key: string): string[] {
  const m = new RegExp(`${escapeRegExp(key)}\\s*\\[([^\\]]*)\\]`).exec(text)
  if (!m) return []
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1])
}

function readSet(text: string, key: string): string[] {
  const m = new RegExp(`${escapeRegExp(key)}\\s*#\\{([^}]*)\\}`).exec(text)
  if (!m) return []
  return [...m[1].matchAll(/:([A-Za-z][A-Za-z0-9_./-]*)/g)].map((x) => x[1])
}

/**
 * 从 `config.edn` 正文里取我们关心的几个键。
 *
 * **刻意不写一个真的 EDN 解析器**:只需要 6 个值,读不到就用默认值,而且**永不写回**这个文件 ——
 * 失败模式因此是「回落到默认行为」,不是「改坏用户的配置」。
 */
export function parseConfigEdn(text: string): GraphConfig {
  const block = /:default-templates\s*\{([\s\S]*?)\}/.exec(text)
  const journalTemplate = block ? readQuoted(block[1], ':journals') : null
  return {
    journalsDir: stripSlashes(readQuoted(text, ':journals-directory')) || DEFAULT_GRAPH_CONFIG.journalsDir,
    pagesDir: stripSlashes(readQuoted(text, ':pages-directory')) || DEFAULT_GRAPH_CONFIG.pagesDir,
    fileFormat: readQuoted(text, ':journal/file-name-format') || DEFAULT_GRAPH_CONFIG.fileFormat,
    defaultJournalTemplate: journalTemplate ?? '',
    hidden: readVector(text, ':hidden'),
    hiddenProperties: readSet(text, ':block-hidden-properties')
  }
}

function stripSlashes(value: string | null): string {
  return (value ?? '').replace(/^\/+|\/+$/g, '')
}

// ---------- 日志模板 ----------

export interface TemplateContext {
  /** 日志日期(YYYY-MM-DD);页面模板可以省略 */
  day?: string
  /** 当前页面名(用于 `<%current page%>`) */
  page?: string
  now?: Date
}

/**
 * 展开 Logseq 模板里的动态变量。
 *
 * 与 Logseq 的**已知偏差**(README 里有):`<%date%>` 用 ISO(`2026-09-20`)而不是
 * `:journal/page-title-format`(moment 语法)的结果 —— 我们不实现 moment 格式器。
 * 认不出来的 `<%…%>`(如 `<%input: 提示%>`)一律**原样留下**,让用户自己填。
 */
export function expandTemplate(text: string, ctx: TemplateContext = {}): string {
  const now = ctx.now ?? new Date()
  const base = ctx.day ?? todayDay(now)
  const replacements: Array<[RegExp, string]> = [
    [/<%\s*date\s*%>/gi, base],
    [/<%\s*time\s*%>/gi, `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}`],
    [/<%\s*current page\s*%>/gi, ctx.page ?? ''],
    [/<%\s*yesterday\s*%>/gi, shiftDay(base, -1)],
    [/<%\s*tomorrow\s*%>/gi, shiftDay(base, 1)]
  ]
  let out = text
  for (const [re, value] of replacements) out = out.replace(re, () => value)
  return out
}

// ---------- 编辑命令 ----------

export interface EditResult {
  file: ParsedFile
  /** 编辑后应当聚焦的块(渲染层据此移光标);null = 不变 */
  focusKey: string | null
}

/** 块区的顶层块数组(视图;元素与 `entries` 里是同一份对象) */
export function topBlocks(file: ParsedFile): BlockNode[] {
  const out: BlockNode[] = []
  for (const entry of file.entries) if (entry.kind === 'block') out.push(entry.block)
  return out
}

interface Located {
  list: BlockNode[]
  index: number
  parent: BlockNode | null
  block: BlockNode
}

function locate(file: ParsedFile, key: string): Located | null {
  const search = (list: BlockNode[], parent: BlockNode | null): Located | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].key === key) return { list, index: i, parent, block: list[i] }
      const hit = search(list[i].children, list[i])
      if (hit) return hit
    }
    return null
  }
  return search(topBlocks(file), null)
}

/** 把块插到顶层块数组的第 `blockIndex` 位(entries 里对应位置之后,从而排在后续 raw 段之前) */
function insertTopBlock(file: ParsedFile, blockIndex: number, block: BlockNode): void {
  if (blockIndex <= 0) {
    file.entries.unshift({ kind: 'block', block })
    return
  }
  let seen = -1
  for (let i = 0; i < file.entries.length; i++) {
    if (file.entries[i].kind !== 'block') continue
    seen++
    if (seen === blockIndex - 1) {
      file.entries.splice(i + 1, 0, { kind: 'block', block })
      return
    }
  }
  file.entries.push({ kind: 'block', block })
}

function removeTopBlock(file: ParsedFile, blockIndex: number): void {
  let seen = -1
  for (let i = 0; i < file.entries.length; i++) {
    if (file.entries[i].kind !== 'block') continue
    seen++
    if (seen === blockIndex) {
      file.entries.splice(i, 1)
      return
    }
  }
}

/**
 * 在块之后插入兄弟块。
 *
 * ⚠️ 顶层块**不能**直接 `loc.list.splice()`:`topBlocks()` 返回的是一份**派生的新数组**
 * (元素与 `entries` 里同一份),改它对文件没有影响。所有结构改动都必须走下面两个
 * 感知 entries 的助手 —— 这是本项目里最容易写错的一处。
 */
function insertAfter(file: ParsedFile, loc: Located, block: BlockNode): void {
  if (loc.parent) loc.parent.children.splice(loc.index + 1, 0, block)
  else insertTopBlock(file, loc.index + 1, block)
}

function removeAt(file: ParsedFile, loc: Located): void {
  if (loc.parent) loc.parent.children.splice(loc.index, 1)
  else removeTopBlock(file, loc.index)
}

function blockLinesDeep(block: BlockNode): SourceLine[] {
  const out: SourceLine[] = [block.head]
  for (const item of block.extra) out.push(item.line)
  for (const child of block.children) out.push(...blockLinesDeep(child))
  return out
}

/** 文件自己的行尾风格(第一个带行尾的行说了算;没有则 '\n') */
export function fileEol(file: ParsedFile): string {
  for (const entry of file.entries) {
    const lines = entry.kind === 'raw' ? entry.lines : blockLinesDeep(entry.block)
    for (const line of lines) if (line.eol) return line.eol
  }
  return '\n'
}

function newBlock(text: string, indent: string, eol: string): BlockNode {
  return { key: '', head: { text: `${indent}- ${text}`, eol }, extra: [], children: [] }
}

/**
 * 改块头文本。`SourceLine` 被当成不可变值(`cloneFile` 是共享式拷贝),所以**必须换新对象**,
 * 否则会反向改坏调用方传进来的文件 —— 这是本文件里最容易写错的一处。
 */
function setHeadText(block: BlockNode, text: string): void {
  block.head = { text, eol: block.head.eol }
}

/** 在某个块之后插入新行前,保证它子树最后一行有行尾(否则两行会被拼成一行) */
function ensureEolOnBlockTail(block: BlockNode, eol: string): void {
  const lastChild = block.children[block.children.length - 1]
  if (lastChild) {
    ensureEolOnBlockTail(lastChild, eol)
    return
  }
  const lastItem = block.extra[block.extra.length - 1]
  if (lastItem) {
    if (lastItem.line.eol === '') lastItem.line = { ...lastItem.line, eol }
    return
  }
  if (block.head.eol === '') block.head = { ...block.head, eol }
}

function ensureEolOnFileTail(file: ParsedFile, eol: string): void {
  for (let i = file.entries.length - 1; i >= 0; i--) {
    const entry = file.entries[i]
    if (entry.kind === 'raw') {
      const last = entry.lines.length - 1
      if (last >= 0) {
        const line = entry.lines[last]
        if (line.eol === '') entry.lines[last] = { ...line, eol }
        return
      }
      continue
    }
    ensureEolOnBlockTail(entry.block, eol)
    return
  }
}

/** 递归改缩进(整棵子树);同样遵守「换对象」规则 */
function shiftIndentLines(block: BlockNode, unit: string, add: boolean): void {
  const shift = (text: string): string => (add ? unit + text : stripOneIndent(text, unit))
  setHeadText(block, shift(block.head.text))
  for (const item of block.extra) item.line = { text: shift(item.line.text), eol: item.line.eol }
  for (const child of block.children) shiftIndentLines(child, unit, add)
}

/** 把子树的缩进**对齐到**目标宽度(插入到另一棵树里时不能盲目加/减一层) */
function alignIndent(block: BlockNode, unit: string, targetWidth: number): void {
  let guard = 0
  while (indentText(block.head.text).length < targetWidth && guard++ < 64) shiftIndentLines(block, unit, true)
  while (indentText(block.head.text).length > targetWidth && guard++ < 64) shiftIndentLines(block, unit, false)
}

function stripOneIndent(text: string, unit: string): string {
  if (text.startsWith(unit)) return text.slice(unit.length)
  return /^[ \t]/.test(text) ? text.slice(1) : text
}

/** 在 `key` 块之后插入一个同级新块(块尾回车) */
export function insertSiblingAfter(file: ParsedFile, key: string, text = ''): EditResult {
  const next = cloneFile(file)
  const target = locate(next, key)
  if (!target) return { file, focusKey: null }
  const eol = fileEol(next)
  ensureEolOnBlockTail(target.block, eol)
  const block = newBlock(text, indentText(target.block.head.text), eol)
  insertAfter(next, target, block)
  reindex(next)
  return { file: next, focusKey: block.key }
}

/** 空文件(或只有页面属性的文件)里插入第一个块 */
export function insertFirstBlock(file: ParsedFile, text = ''): EditResult {
  const next = cloneFile(file)
  const eol = fileEol(next)
  ensureEolOnFileTail(next, eol)
  const block = newBlock(text, '', eol)
  next.entries.push({ kind: 'block', block })
  reindex(next)
  return { file: next, focusKey: block.key }
}

/**
 * 按光标偏移把一个块劈成两个(中间回车)。子块留在前半 —— 与 Logseq 一致。
 *
 * `unit` 省略时只劈第一行(旧行为,多行内容原样留在左块);传入 `unit` 时 `offset` 是
 * `blockLinesForDisplay(block, unit).join('\n')`(= textarea 全文)里的偏移,任意一行都能劈,
 * 光标后的行归新块。UI 一律传 `unit`。
 */
export function splitBlock(file: ParsedFile, key: string, offset: number, unit?: string): EditResult {
  const next = cloneFile(file)
  const target = locate(next, key)
  if (!target) return { file, focusKey: null }
  const eol = fileEol(next)
  ensureEolOnBlockTail(target.block, eol)
  const indent = indentText(target.block.head.text)

  let before: string[]
  let after: string[]
  if (unit === undefined) {
    const text = blockText(target.block)
    const at = Math.max(0, Math.min(text.length, offset))
    before = [text.slice(0, at).replace(/\s+$/, '')]
    after = [text.slice(at)]
  } else {
    const lines = blockLinesForDisplay(target.block, unit)
    const text = lines.join('\n')
    const at = Math.max(0, Math.min(text.length, offset))
    const lineIndex = text.slice(0, at).split('\n').length - 1
    const lineStart = at === 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1
    const col = at - lineStart
    const cur = lines[lineIndex] ?? ''
    before = [...lines.slice(0, lineIndex), ...(col > 0 ? [cur.slice(0, col)] : [])]
    after = [...(col < cur.length ? [cur.slice(col)] : []), ...lines.slice(lineIndex + 1)]
    before[0] = (before[0] ?? '').replace(/\s+$/, '')
  }

  setHeadText(target.block, `${indent}- ${before[0] ?? ''}`)
  if (unit !== undefined) writeContentLines(target.block, before.slice(1), indent, unit, eol)
  const block = newBlock(after[0] ?? '', indent, eol)
  if (unit !== undefined) writeContentLines(block, after.slice(1), indent, unit, eol)
  insertAfter(next, target, block)
  reindex(next)
  return { file: next, focusKey: block.key }
}

/**
 * 就地改块文本(只碰 `- ` 那一行,属性行与多行内容原样)
 *
 * ⚠️ 界面上的编辑走 `setBlockContentLines()`(一个块在界面里是**多行**的);
 * 这个函数留给「只需要改第一行」的场景(测试与将来的单行编辑)。
 */
export function setBlockText(file: ParsedFile, key: string, text: string): ParsedFile {
  const next = cloneFile(file)
  const target = locate(next, key)
  if (!target) return file
  setHeadText(target.block, `${indentText(target.block.head.text)}- ${text}`)
  return next
}

/** 把「界面上的内容行」写回 `extra`(插在第一条原有内容行处,原有属性行保序留在原位) */
function writeContentLines(
  block: BlockNode,
  lines: readonly string[],
  indent: string,
  unit: string,
  eol: string
): void {
  const fresh = lines.map((line) => ({
    line: { text: `${indent}${unit}${line}`, eol },
    kind: 'content' as const
  }))
  const firstContent = block.extra.findIndex((x) => x.kind === 'content')
  if (firstContent === -1) {
    block.extra.push(...fresh)
  } else {
    block.extra = [
      ...block.extra.slice(0, firstContent),
      ...fresh,
      ...block.extra.slice(firstContent).filter((x) => x.kind === 'prop')
    ]
  }
}

/** 任务标记:`[ ]` / `[x]`,可选前置 bullet(`* [ ]` / `- [ ]`)与前导缩进(文件里的内容行带缩进) */
const TASK_MARK_RE = /^[ \t]*([-*+][ \t]+)?\[([ xX])\]/

/**
 * 翻转块内某一行的任务标记(`[ ]` ↔ `[x]`)。
 * `lineIndex` 0 = 块头(`- ` 之后,块首裸 `[ ]` 或 `* [ ]`);>0 = 第 N 条**内容行**。
 *
 * 找不到标记 / 行号越界 / 块不存在 → 返回**同一个 file**(调用方据此判 no-op,不推 undo)。
 * 改内容行时**必须换 `SourceLine` 新对象**(`cloneFile` 是共享式拷贝)。
 */
export function toggleTaskMarker(file: ParsedFile, key: string, lineIndex: number): ParsedFile {
  const next = cloneFile(file)
  const target = locate(next, key)
  if (!target) return file

  const flip = (text: string): string | null => {
    const m = TASK_MARK_RE.exec(text)
    if (!m) return null
    const at = m[0].indexOf('[') + 1
    const checked = (m[2] ?? '').toLowerCase() === 'x' ? ' ' : 'x'
    return `${text.slice(0, at)}${checked}${text.slice(at + 1)}`
  }

  if (lineIndex <= 0) {
    const flipped = flip(blockText(target.block))
    if (flipped === null) return file
    setHeadText(target.block, `${indentText(target.block.head.text)}- ${flipped}`)
    return next
  }

  let seen = 0
  for (const item of target.block.extra) {
    if (item.kind !== 'content') continue
    if (seen++ !== lineIndex - 1) continue
    const flipped = flip(item.line.text)
    if (flipped === null) return file
    item.line = { text: flipped, eol: item.line.eol }
    return next
  }
  return file
}

/**
 * 重写一个块的**全部正文**(第一行 + 多行内容),属性行原样保留。
 *
 * 这是界面上真正的编辑入口:`BlockRow` 的 textarea 里就是 `blockLinesForDisplay()` 的结果
 * (多行文本),回车/输入都换算成这个调用。逆运算成立(见 `tests/logseqShared.test.ts`
 * 的「display → set 是恒等」),所以「什么也没改地进去又出来」不会动文件一个字节。
 *
 * 新内容行的位置:插在**第一条原有内容行**的位置上;原来没有内容行就接在属性行之后
 * (也就是 Logseq 自己的形态:块头 → 属性行 → 多行内容)。
 */
export function setBlockContentLines(file: ParsedFile, key: string, lines: readonly string[]): ParsedFile {
  const next = cloneFile(file)
  const target = locate(next, key)
  if (!target) return file
  const eol = fileEol(next)
  const unit = detectIndentUnit(next)
  const indent = indentText(target.block.head.text)
  setHeadText(target.block, `${indent}- ${lines[0] ?? ''}`)
  writeContentLines(target.block, lines.slice(1), indent, unit, eol)
  return next
}

/** Tab:缩进一层(有上一个兄弟时成为它的最后一个子块 —— 与 Logseq 一致) */
export function indentBlock(file: ParsedFile, key: string): EditResult {
  const next = cloneFile(file)
  const target = locate(next, key)
  if (!target || target.index === 0) return { file, focusKey: null }
  const unit = detectIndentUnit(next)
  const prev = target.list[target.index - 1]
  removeAt(next, target)
  prev.children.push(target.block)
  alignIndent(target.block, unit, indentText(prev.head.text).length + unit.length)
  reindex(next)
  return { file: next, focusKey: target.block.key }
}

/** Shift+Tab:反缩进一层(回到父块的下一层);顶层块无效 */
export function outdentBlock(file: ParsedFile, key: string): EditResult {
  const next = cloneFile(file)
  const target = locate(next, key)
  if (!target || !target.parent) return { file, focusKey: null }
  const unit = detectIndentUnit(next)
  const parentLoc = locate(next, target.parent.key)
  if (!parentLoc) return { file, focusKey: null }
  removeAt(next, target)
  if (parentLoc.parent) parentLoc.parent.children.splice(parentLoc.index + 1, 0, target.block)
  else insertTopBlock(next, parentLoc.index + 1, target.block)
  // 反缩进后的目标缩进 = 父块所在层级的缩进 + 一个单元(避免盲目减一层后与父块同级却差一个字符)
  const grand = parentLoc.parent
  const targetWidth = grand ? indentText(grand.head.text).length + unit.length : 0
  alignIndent(target.block, unit, targetWidth)
  reindex(next)
  return { file: next, focusKey: target.block.key }
}

/**
 * 块首 Backspace:并入上一个兄弟;自己没有上一个兄弟、或上一块**有子块**(且自己还能反缩进)时
 * 改为反缩进 —— 与 Logseq 的规则一致。
 *
 * 理由:顶层块没地方可反缩进,如果上一块还有子块就只剩「什么都不做」这一种结果,
 * 那对用户是死键。所以两种情况的优先级写成「能反缩进就反缩进,否则合并」。
 */
export function mergeWithPrevious(file: ParsedFile, key: string): EditResult {
  const probe = locate(file, key)
  if (!probe) return { file, focusKey: null }
  const hasPrev = probe.index > 0
  const prevHasChildren = hasPrev && probe.list[probe.index - 1].children.length > 0
  if (!hasPrev || (prevHasChildren && probe.parent !== null)) return outdentBlock(file, key)

  const next = cloneFile(file)
  const target = locate(next, key)
  if (!target || target.index === 0) return { file, focusKey: null }
  const prev = target.list[target.index - 1]
  const unit = detectIndentUnit(next)
  setHeadText(prev, `${indentText(prev.head.text)}- ${blockText(prev)}${blockText(target.block)}`)
  for (const item of target.block.extra) prev.extra.push(item)
  const childWidth = indentText(prev.head.text).length + unit.length
  for (const child of target.block.children) {
    prev.children.push(child)
    alignIndent(child, unit, childWidth)
  }
  removeAt(next, target)
  reindex(next)
  return { file: next, focusKey: prev.key }
}

/** 删掉一个块与它的子树 */
export function deleteBlock(file: ParsedFile, key: string): EditResult {
  const next = cloneFile(file)
  const target = locate(next, key)
  if (!target) return { file, focusKey: null }
  const fallback =
    target.index > 0 ? target.list[target.index - 1] : (target.list[target.index + 1] ?? target.parent)
  removeAt(next, target)
  reindex(next)
  return { file: next, focusKey: fallback ? fallback.key : null }
}

