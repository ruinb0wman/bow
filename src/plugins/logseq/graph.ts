/**
 * 图索引与反向链接(纯逻辑:文件访问以 `GraphIo` 注入,单测用内存 IO,主进程用真实 fs)。
 *
 * 索引的对象是 `<graph>/journals/*.md` 与 `<graph>/pages/*.md`(目录名来自 `logseq/config.edn`)。
 * 每个文件解析一次并把 `mtimeMs` 一起缓存:下次扫描只重解析**变过的**文件,其余直接复用上一次的条目对象。
 *
 * ⚠️ 与 Logseq 的页面 identity 一致:**比较一律走小写**(`pageKey()`),显示保留原样。
 */

import {
  compileDateFormat,
  decodePageName,
  isJournalDay,
  pageKey,
  parseJournalStem,
  parseLooseDay,
  type DateFormatSpec,
  type GraphConfig
} from './shared'
import {
  blockText,
  parseLogseqFile,
  propertyOf,
  refsOfTokens,
  tokenizeInline,
  type BlockNode,
  type Token
} from './format'

/** 索引规模上限:超过就不建全量索引(退化成「只按需扫描当前页」),避免打开大图时卡住 */
export const MAX_INDEX_FILES = 5000

/** 单条反向链接的上下文块 */
export interface BacklinkBlock {
  /** 块在文件里的行号(1 起;反链面板与将来「跳转到块」用) */
  line: number
  text: string
}

export interface IndexedFile {
  /** 绝对路径 */
  path: string
  /** 相对图根、正斜杠(`journals/2026_09_20.md`)—— 索引的 key */
  rel: string
  /** 显示名:日志是 `YYYY-MM-DD`,页面是 `title::` 或文件名解码结果 */
  title: string
  /**
   * 文件名词干(`.md` 去掉、`%XX` 已解码)—— 页面名的**别名**。
   *
   * `title::` 与文件名不同时,两个名字指向的是**同一个文件**;只认 `title` 会把「用文件名打开」当成一个
   * 不存在的新页,而那个新页的路径正是这个已存在的文件 —— 第一次保存就把它覆盖掉(见 `GraphIndex.byStem`)。
   */
  stem: string
  /** 日志才是 `YYYY-MM-DD`,页面是 null */
  day: string | null
  mtimeMs: number
  /** 这个文件引用到的所有页面名(小写去重) */
  refs: string[]
  blocks: Array<BacklinkBlock & { refs: string[] }>
}

export interface GraphIndex {
  root: string
  config: GraphConfig
  format: DateFormatSpec
  files: IndexedFile[]
  byPath: Map<string, IndexedFile>
  byDay: Map<string, IndexedFile>
  /** pageKey(title) → 文件(日志也有条目,于是 `[[2026-09-20]]` 能解析到日志) */
  byTitle: Map<string, IndexedFile>
  /**
   * pageKey(文件名词干) → 文件,且**只收页面**(日志按日期认,`byDay` 那条路)。
   *
   * 这是「`title::` 与文件名不同」时的别名入口:只按 `byTitle` 认页的话,`resolvePage()` 对文件名返回
   * null,调用方(如 `readPage`)就会把它当成新页并以空内容打开**同一个路径** —— 一保存就覆盖用户的笔记。
   */
  byStem: Map<string, IndexedFile>
  /** 文件数超过 `MAX_INDEX_FILES`:此时不保证 `files` 完整,调用方应改用即时扫描 */
  tooLarge: boolean
  scannedAt: number
}

/** 索引需要的全部文件系统操作(注入:主进程给真实 fs,单测给内存实现) */
export interface GraphIo {
  /** 目录不存在时返回 null(不是空数组 —— 两者语义不同) */
  listDir(path: string): Promise<string[] | null>
  readText(path: string): Promise<string>
  mtimeMs(path: string): Promise<number | null>
  join(...parts: string[]): string
}

const MD_RE = /\.md$/i

/**
 * `:hidden` 命中判定。
 *
 * 语义按 Logseq 的 `config.edn` 文档:**路径相对图根**,前面的 `/` 可写可不写 ——
 * `:hidden ["/archived" "/test.md" "../assets/archived"]`。所以 `/archived` 指的是
 * `<graph>/archived`,**不是**任何一个叫 archived 的子目录;不带 `/` 的条目(如 `test.md`)额外
 * 按基名匹配(否则用户只能写完整路径才能藏一个散在子目录里的文件)。
 */
export function isHidden(rel: string, hidden: readonly string[]): boolean {
  const normalized = toPosix(rel).replace(/^\.\//, '')
  const base = normalized.split('/').pop() ?? normalized
  return hidden.some((entry) => {
    const needle = toPosix(entry).replace(/^\.\//, '').replace(/^\/+/, '')
    if (!needle) return false
    if (normalized === needle) return true
    if (normalized.startsWith(`${needle}/`)) return true
    return !needle.includes('/') && base === needle
  })
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * 扫描(或增量刷新)图索引。
 *
 * `previous` 提供上一次的索引时:同名文件 mtime 未变就直接复用旧条目(不读盘) ——
 * 这是「每次保存都刷新反链」不卡的前提。
 */
export async function scanGraph(
  io: GraphIo,
  root: string,
  config: GraphConfig,
  previous?: GraphIndex | null
): Promise<GraphIndex> {
  const format = compileDateFormat(config.fileFormat)
  const files: IndexedFile[] = []

  const collect = async (dirName: string, sub: string): Promise<void> => {
    const dir = io.join(root, dirName)
    const names = await io.listDir(dir)
    if (!names) return
    for (const name of names.sort()) {
      if (!MD_RE.test(name)) continue
      const rel = `${sub}/${name}`
      if (isHidden(rel, config.hidden)) continue
      if (files.length >= MAX_INDEX_FILES) return
      const path = io.join(dir, name)
      const mtimeMs = await io.mtimeMs(path)
      if (mtimeMs === null) continue
      const cached = previous?.byPath.get(rel)
      if (cached && cached.mtimeMs === mtimeMs) {
        files.push(cached)
        continue
      }
      let raw: string
      try {
        raw = await io.readText(path)
      } catch {
        continue
      }
      files.push(parseIndexedFile({ path, rel, mtimeMs, raw, format, isJournal: sub === 'journals' }))
    }
  }

  await collect(config.journalsDir, 'journals')
  await collect(config.pagesDir, 'pages')

  return buildIndex({ root, config, format, files, tooLarge: files.length >= MAX_INDEX_FILES })
}

/** 由已解析的文件拼出索引(测试与增量刷新共用) */
export function buildIndex(input: {
  root: string
  config: GraphConfig
  format: DateFormatSpec
  files: IndexedFile[]
  tooLarge?: boolean
  scannedAt?: number
}): GraphIndex {
  const byPath = new Map<string, IndexedFile>()
  const byDay = new Map<string, IndexedFile>()
  const byTitle = new Map<string, IndexedFile>()
  const byStem = new Map<string, IndexedFile>()
  for (const file of input.files) {
    byPath.set(file.rel, file)
    if (file.day) byDay.set(file.day, file)
    else byStem.set(pageKey(file.stem), file)
    byTitle.set(pageKey(file.title), file)
  }
  return {
    root: input.root,
    config: input.config,
    format: input.format,
    files: input.files,
    byPath,
    byDay,
    byTitle,
    byStem,
    tooLarge: input.tooLarge ?? false,
    scannedAt: input.scannedAt ?? Date.now()
  }
}

/**
 * 解析一个文件为索引条目。
 *
 * `title` 的优先级:`title::` 属性 → 文件名解码(日志则用日期,并由 `parseLooseDay` 兜住
 * 与当前格式串不一致的历史文件名)。
 */
export function parseIndexedFile(input: {
  path: string
  rel: string
  mtimeMs: number
  raw: string
  format: DateFormatSpec
  isJournal: boolean
}): IndexedFile {
  const parsed = parseLogseqFile(input.raw)
  const fileStem = (toPosix(input.rel).split('/').pop() ?? '').replace(MD_RE, '')
  const refs = new Set<string>()
  const blocks: Array<BacklinkBlock & { refs: string[] }> = []
  let line = 1
  let titleProp: string | null = null

  const absorb = (tokens: Token[], own: string[] | null): void => {
    const { pages, tags } = refsOfTokens(tokens)
    for (const name of [...pages, ...tags]) {
      const key = pageKey(name)
      if (!key) continue
      refs.add(key)
      if (own) own.push(key)
    }
  }

  const walk = (block: BlockNode): void => {
    const own: string[] = []
    const head = blockText(block)
    absorb(tokenizeInline(head), own)
    blocks.push({ line, text: head, refs: own })
    line++
    for (const item of block.extra) {
      absorb(tokenizeInline(item.line.text), own)
      line++
    }
    for (const child of block.children) walk(child)
  }

  for (const entry of parsed.entries) {
    if (entry.kind === 'raw') {
      for (const l of entry.lines) {
        const prop = propertyOf(l.text)
        if (prop && prop.key.toLowerCase() === 'title' && prop.value.trim()) titleProp = prop.value.trim()
        absorb(tokenizeInline(l.text), null)
        line++
      }
      continue
    }
    walk(entry.block)
  }

  const day = input.isJournal ? (parseJournalStem(fileStem, input.format) ?? parseLooseDay(fileStem)) : null
  const title = titleProp ?? (input.isJournal ? (day ?? decodePageName(fileStem)) : decodePageName(fileStem))
  return {
    path: input.path,
    rel: toPosix(input.rel),
    title,
    stem: decodePageName(fileStem),
    day,
    mtimeMs: input.mtimeMs,
    refs: [...refs],
    blocks
  }
}

/** 单条反向链接(某个文件里引用目标页面的块) */
export interface BacklinkGroup {
  rel: string
  path: string
  title: string
  day: string | null
  blocks: BacklinkBlock[]
}

export interface Backlinks {
  total: number
  groups: BacklinkGroup[]
}

/**
 * 反向链接:哪些文件里的哪些块引用了 `name`。
 *
 * 规则:
 * - **跳过文件自己**(否则每个页面都会把自己列成第一条反链;Logseq 把它单列成 self-reference,我们直接不显示);
 * - 日志按日期倒序排在前面,页面按标题顺序排在后面;
 * - `limit` 限制返回的块总数(默认 300),`total` 仍是完整计数 —— 面板据此显示「还有 N 条」。
 */
export function backlinksOf(index: GraphIndex, name: string, limit = 300): Backlinks {
  const key = pageKey(name)
  if (!key) return { total: 0, groups: [] }
  const groups: BacklinkGroup[] = []
  let total = 0
  let emitted = 0
  for (const file of index.files) {
    if (pageKey(file.title) === key) continue
    const hits = file.blocks.filter((b) => b.refs.includes(key))
    if (hits.length === 0) continue
    total += hits.length
    if (emitted >= limit) continue
    groups.push({
      rel: file.rel,
      path: file.path,
      title: file.title,
      day: file.day,
      blocks: hits.map((b) => ({ line: b.line, text: b.text }))
    })
    emitted += hits.length
  }
  groups.sort((a, b) => {
    if (a.day && b.day) return a.day < b.day ? 1 : a.day > b.day ? -1 : 0
    if (a.day) return -1
    if (b.day) return 1
    return a.title.localeCompare(b.title)
  })
  return { total, groups }
}

export interface PageHit {
  name: string
  rel: string
  path: string
  day: string | null
}

/**
 * 页面搜索(`[[` 补全与搜索框共用):前缀命中优先,其次是包含;日志按日期倒序。
 *
 * 匹配**显示名或文件名词干**(两者互为别名,见 `IndexedFile.stem`)—— 用户敲文件名时也得能在补全
 * 列表里看到这一页,否则他会以为「这页不存在」而新建一个同路径的空页(那就是覆盖原文件)。
 */
export function searchPages(index: GraphIndex, query: string, limit = 20): PageHit[] {
  const q = pageKey(query)
  const scored: Array<{ hit: PageHit; prefix: boolean }> = []
  for (const file of index.files) {
    const key = pageKey(file.title)
    const alias = pageKey(file.stem)
    if (q && !key.includes(q) && !alias.includes(q)) continue
    scored.push({
      hit: { name: file.title, rel: file.rel, path: file.path, day: file.day },
      prefix: Boolean(q) && (key.startsWith(q) || alias.startsWith(q))
    })
  }
  scored.sort((a, b) => {
    if (a.prefix !== b.prefix) return a.prefix ? -1 : 1
    const x = a.hit
    const y = b.hit
    if (x.day && y.day) return x.day < y.day ? 1 : -1
    if (x.day !== y.day) return x.day ? -1 : 1
    return x.name.localeCompare(y.name)
  })
  return scored.slice(0, limit).map((entry) => entry.hit)
}

/** 图里已有的日志日期(倒序)—— 日历/前后跳转只在这里面找得到「有内容的日期」 */
export function journalDays(index: GraphIndex): string[] {
  return index.files
    .map((f) => f.day)
    .filter((d): d is string => Boolean(d))
    .sort((a, b) => (a < b ? 1 : -1))
}

/**
 * `[[X]]` 解析:先按标题,再按日期(日志),最后按**文件名词干**(`title::` 与文件名不同时的别名),
 * 都没有返回 null。
 *
 * 别名那一条是**数据安全**要求,不只是方便:返回 null 时调用方会把它当成新页,而新页的路径正是
 * 那个已存在的文件(`encodePageName(文件名) === 文件名`)—— 一保存就覆盖掉用户的笔记。
 */
export function resolvePage(index: GraphIndex, name: string): IndexedFile | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (isJournalDay(trimmed)) return index.byDay.get(trimmed) ?? null
  const key = pageKey(trimmed)
  return index.byTitle.get(key) ?? index.byStem.get(key) ?? null
}

/** 索引统计(设置页显示) */
export function indexStats(index: GraphIndex): { files: number; blocks: number; refs: number; days: number } {
  let blocks = 0
  const refs = new Set<string>()
  for (const file of index.files) {
    blocks += file.blocks.length
    for (const r of file.refs) refs.add(r)
  }
  return { files: index.files.length, blocks, refs: refs.size, days: journalDays(index).length }
}

/** 供索引之外的地方复用:一行文本里的引用(小写去重) */
export function refsOfText(text: string): string[] {
  const { pages, tags } = refsOfTokens(tokenizeInline(text))
  return [...new Set([...pages, ...tags].map(pageKey).filter(Boolean))]
}
