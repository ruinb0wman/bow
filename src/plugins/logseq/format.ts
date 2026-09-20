/**
 * Logseq「文件图」格式的保守解析 / 序列化 / 行内 tokenizer —— 纯逻辑(无 electron / DOM / node 依赖),
 * 主进程与渲染层共用(渲染层要用同一份解析器把块渲染出来,并把点击位置映射回原文偏移)。
 *
 * 四个设计原则(改代码前先读,它们决定「为什么不能用现成的 markdown 库」):
 *
 * 1. **字节保真**:整个文件在内存里就是 `SourceLine[]`(`{text, eol}`),解析出来的树只做**分组与引用**。
 *    序列化因此天然是「原样拼回」(`serialize(parse(raw)) === raw` 对任意输入成立,包括 CRLF、混合行尾、
 *    无尾换行、空文件),解析器理解错了也**不会**改写用户文件的一个字节。
 * 2. **不认识的一律当「原样行段」**(`raw` 条目):空行、`#+BEGIN_QUOTE`、`---` front-matter、缩进异常的段落……
 *    全部按原顺序原样保留;编辑命令只碰块,绝不重排它们。
 * 3. **缩进按「前导空白字符个数」比较**(tab 记 1),重排子树时用文件里检测出来的缩进单元
 *    (`detectIndentUnit`):Logseq 的图里既可能是 2 空格也可能是 tab,照着文件本身来。
 * 4. **行内 token 带源码区间**(`srcStart/srcEnd`):「点一下就地编辑」要把点击位置映射回原始 markdown 偏移,
 *    而渲染后的文本与源码不等长(`[[cardinality]]` 显示成 `cardinality`)。同时所有 token 的 `raw` 拼接
 *    必须恒等于原文 —— 「渲染零丢字」是这条的可测形式(`tests/logseqFormat.test.ts`)。
 */

// ---------- 行与文件 ----------

/** 一行:`text` 不含行尾,`eol` 是 '\n' / '\r\n' / ''(文件最后一行无尾换行) */
export interface SourceLine {
  text: string
  eol: string
}

/** 一个块 = `- …` 那一行 + 紧随其后的附件行(属性行 / 多行内容)+ 子块 */
export interface BlockNode {
  /** 会话内稳定的树内路径键(`'0'`、`'0.1'`);结构改动后由 `reindex()` 重算 */
  key: string
  /** `- …` 那一行(原样保留;只有改块文本时才重建它的 `text`) */
  head: SourceLine
  /**
   * 紧随其后的、缩进大于本块的行,**保序原样**:
   * - `kind:'prop'`  = `key:: value`(Logseq 的块属性,如 `id::` / `collapsed::` / `tags::`);
   * - `kind:'content'` = 多行内容的续行(放进代码围栏、软换行等)。
   */
  extra: Array<{ line: SourceLine; kind: 'prop' | 'content' }>
  children: BlockNode[]
}

/** 顶层条目:块,或一段原样行(页面属性 / 空行 / 任何没被识别成块的东西) */
export type FileEntry = { kind: 'block'; block: BlockNode } | { kind: 'raw'; lines: SourceLine[] }

export interface ParsedFile {
  entries: FileEntry[]
}

/** `- x` / `-` / `-  x` 都算块行(第二个分支的捕获组保留 `- ` 之后的所有字符,含多余空格) */
const BLOCK_LINE_RE = /^([ \t]*)-(?:[ \t]([\s\S]*))?$/
/** 属性行:`key:: value`(键只认字母数字与 `_-./`,与 Logseq 一致) */
const PROPERTY_LINE_RE = /^[ \t]*([A-Za-z][A-Za-z0-9_./-]*)::[ \t]?([\s\S]*)$/

/** 渲染时直接隐藏的系统属性(文件里照旧保留);`:block-hidden-properties` 由调用方追加 */
export const DEFAULT_HIDDEN_PROPERTIES = [
  'id',
  'collapsed',
  'created-at',
  'updated-at',
  'last-modified-at',
  'background-color',
  'icon'
] as const

export function splitLines(raw: string): SourceLine[] {
  const out: SourceLine[] = []
  let i = 0
  while (i < raw.length) {
    const j = raw.indexOf('\n', i)
    if (j === -1) {
      out.push({ text: raw.slice(i), eol: '' })
      break
    }
    const cr = j > i && raw[j - 1] === '\r'
    out.push({ text: raw.slice(i, cr ? j - 1 : j), eol: cr ? '\r\n' : '\n' })
    i = j + 1
  }
  return out
}

export function joinLines(lines: readonly SourceLine[]): string {
  let out = ''
  for (const l of lines) out += l.text + l.eol
  return out
}

/** 前导空白(空格与 tab) */
export function indentText(text: string): string {
  const m = /^[ \t]*/.exec(text)
  return m ? m[0] : ''
}

export function indentWidth(text: string): number {
  return indentText(text).length
}

export function matchBlockLine(text: string): { indent: string; text: string } | null {
  const m = BLOCK_LINE_RE.exec(text)
  if (!m) return null
  return { indent: m[1], text: m[2] ?? '' }
}

export function propertyOf(text: string): { key: string; value: string } | null {
  const m = PROPERTY_LINE_RE.exec(text)
  if (!m) return null
  return { key: m[1], value: m[2] }
}

// ---------- 解析 / 序列化 ----------

export function parseLogseqFile(raw: string): ParsedFile {
  return reindex({ entries: parseEntries(splitLines(raw)) })
}

function parseEntries(lines: readonly SourceLine[]): FileEntry[] {
  const entries: FileEntry[] = []
  let i = 0
  while (i < lines.length) {
    if (matchBlockLine(lines[i].text)) {
      const parsed = parseBlock(lines, i)
      entries.push({ kind: 'block', block: parsed.block })
      i = parsed.next
      continue
    }
    const start = i
    while (i < lines.length && !matchBlockLine(lines[i].text)) i++
    entries.push({ kind: 'raw', lines: lines.slice(start, i) })
  }
  return entries
}

/**
 * 吃一棵子树。终止条件:遇到缩进 **不大于** 本块的非空行。
 *
 * ⚠️ 判据是「缩进 > 本块缩进」,所以块内**空行**会提前结束这棵子树(Logseq 自己不会写出这种文件;
 * 真遇到时字节仍然完整保留 —— 只是那一段会变成 `raw` 条目,块内代码围栏可能被拆成两截)。
 */
function parseBlock(lines: readonly SourceLine[], start: number): { block: BlockNode; next: number } {
  const head = lines[start]
  const indent = indentWidth(head.text)
  const block: BlockNode = { key: '', head, extra: [], children: [] }
  let i = start + 1
  while (i < lines.length) {
    const line = lines[i]
    if (indentWidth(line.text) <= indent) break
    if (matchBlockLine(line.text)) {
      const child = parseBlock(lines, i)
      block.children.push(child.block)
      i = child.next
      continue
    }
    block.extra.push({ line, kind: propertyOf(line.text) ? 'prop' : 'content' })
    i++
  }
  return { block, next: i }
}

export function serializeLogseqFile(file: ParsedFile): string {
  const out: string[] = []
  for (const entry of file.entries) {
    if (entry.kind === 'raw') {
      for (const l of entry.lines) out.push(l.text + l.eol)
    } else {
      writeBlock(entry.block, out)
    }
  }
  return out.join('')
}

function writeBlock(block: BlockNode, out: string[]): void {
  out.push(block.head.text + block.head.eol)
  for (const item of block.extra) out.push(item.line.text + item.line.eol)
  for (const child of block.children) writeBlock(child, out)
}

/** 文件里所有块(深度优先,含子树) */
export function allBlocks(file: ParsedFile): BlockNode[] {
  const out: BlockNode[] = []
  const visit = (b: BlockNode): void => {
    out.push(b)
    for (const c of b.children) visit(c)
  }
  for (const entry of file.entries) if (entry.kind === 'block') visit(entry.block)
  return out
}

/** 文件里有没有块(没有则界面要提供一个空块:空日志/空页面也得有地方输入) */
export function hasBlocks(file: ParsedFile): boolean {
  return file.entries.some((entry) => entry.kind === 'block')
}

/** 重算 key(structure 改动后必须调;否则 `findBlock` 会指错块) */
export function reindex(file: ParsedFile): ParsedFile {
  const walk = (blocks: BlockNode[], prefix: string): void => {
    blocks.forEach((b, i) => {
      b.key = prefix ? `${prefix}.${i}` : String(i)
      walk(b.children, b.key)
    })
  }
  const top: BlockNode[] = []
  for (const entry of file.entries) if (entry.kind === 'block') top.push(entry.block)
  walk(top, '')
  return file
}

/** 块在文件里的挂载位置:`list` 是它所在的数组(顶层块集合,或父块的 `children`) */
export interface BlockLocation {
  list: BlockNode[]
  index: number
  parent: BlockNode | null
  block: BlockNode
}

export function findBlock(file: ParsedFile, key: string): BlockLocation | null {
  const top: BlockNode[] = []
  for (const entry of file.entries) if (entry.kind === 'block') top.push(entry.block)
  const search = (list: BlockNode[], parent: BlockNode | null): BlockLocation | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].key === key) return { list, index: i, parent, block: list[i] }
      const hit = search(list[i].children, list[i])
      if (hit) return hit
    }
    return null
  }
  return search(top, null)
}

/**
 * 深拷贝**树结构**,但 `SourceLine` 对象是**共享**的(它们被当作不可变值:改文本的地方一律
 * 换成新对象,见 `shared.ts` 的 `setHeadText` / `shiftIndentLines`)。
 *
 * 这样「编辑命令没碰过的行」不只是内容相同,而是**同一个对象** —— 序列化出来的字节不可能变,
 * 而且批量编辑不必复制整份文件。改这里之前请先看 `tests/logseqShared.test.ts` 的纯函数用例。
 */
export function cloneFile(file: ParsedFile): ParsedFile {
  const cloneBlock = (b: BlockNode): BlockNode => ({
    key: b.key,
    head: b.head,
    extra: b.extra.map((x) => ({ line: x.line, kind: x.kind })),
    children: b.children.map(cloneBlock)
  })
  return {
    entries: file.entries.map((e) =>
      e.kind === 'raw' ? { kind: 'raw', lines: [...e.lines] } : { kind: 'block', block: cloneBlock(e.block) }
    )
  }
}

// ---------- 缩进 ----------

/** 文件自身的缩进单元(优先 tab;否则取嵌套块里最小的正缩进宽度,兜底两个空格) */
export function detectIndentUnit(file: ParsedFile): string {
  const widths: number[] = []
  let sawTab = false
  const visit = (blocks: BlockNode[]): void => {
    for (const b of blocks) {
      const indent = indentText(b.head.text)
      if (indent.includes('\t')) sawTab = true
      else if (indent.length > 0) widths.push(indent.length)
      visit(b.children)
    }
  }
  for (const entry of file.entries) if (entry.kind === 'block') visit([entry.block])
  if (sawTab) return '\t'
  if (widths.length > 0) return ' '.repeat(Math.min(...widths))
  return '  '
}

// ---------- 块访问器 ----------

/** 块的正文(`- ` 之后的第一个 `- ` 行内容;空块为 '') */
export function blockText(block: BlockNode): string {
  return matchBlockLine(block.head.text)?.text ?? ''
}

export function setBlockText(block: BlockNode, text: string, indentOverride?: string): void {
  const indent = indentOverride ?? indentText(block.head.text)
  block.head.text = `${indent}- ${text}`
}

/** 该块的多行内容行(不含属性行) */
export function blockContentLines(block: BlockNode): SourceLine[] {
  return block.extra.filter((x) => x.kind === 'content').map((x) => x.line)
}

/**
 * 渲染用的正文行:第一行 + 多行内容(界面上的 textarea 与只读渲染都用它)。
 * 多行内容行去掉「父缩进 + 一个缩进单元」的前导空白(去掉的字符数按字符算,tab 记 1),
 * 于是代码围栏内部的相对缩进仍然保留。
 */
export function blockLinesForDisplay(block: BlockNode, unit: string): string[] {
  const parent = indentText(block.head.text)
  const cut = parent.length + unit.length
  return [
    blockText(block),
    ...blockContentLines(block).map((line) => {
      const lead = indentText(line.text)
      return line.text.slice(Math.min(lead.length, cut))
    })
  ]
}

/** 展示给用户的属性行(系统属性默认隐藏;文件里照旧保留) */
export function visibleProperties(block: BlockNode, hidden: readonly string[] = DEFAULT_HIDDEN_PROPERTIES): Array<{ key: string; value: string }> {
  const hide = new Set(hidden.map((h) => h.toLowerCase()))
  const out: Array<{ key: string; value: string }> = []
  for (const item of block.extra) {
    if (item.kind !== 'prop') continue
    const prop = propertyOf(item.line.text)
    if (!prop) continue
    if (hide.has(prop.key.toLowerCase())) continue
    out.push(prop)
  }
  return out
}

// ---------- 行内 tokenizer ----------

export interface TokenBase {
  /** 源码里的精确切片(所有 token 的 raw 拼接 === 原文) */
  raw: string
  srcStart: number
  srcEnd: number
}

export type Token =
  | (TokenBase & { kind: 'text' })
  | (TokenBase & { kind: 'strong' | 'em' | 'code' | 'strike' | 'highlight'; children: Token[] })
  | (TokenBase & { kind: 'page'; target: string; label: string })
  | (TokenBase & { kind: 'tag'; target: string })
  | (TokenBase & { kind: 'url'; href: string; label: string })

/**
 * 行内规则表(**顺序即优先级**)。每条都是 sticky 正则,从当前位置匹配:
 * 代码段 → 双链(`[[…]]` / `#[[…]]` / `#tag`)→ 链接与裸 URL。
 * 强调类(`**` `__` `~~` `==` `*` `_`)在 `matchEmphasis` 里先试(见 `tokenizeInline`)。
 * 未支持的语法(如 `((uuid))`、`{{query}}`)自然落进普通文本,原样显示。
 */
interface InlineRule {
  re: RegExp
  build(m: RegExpExecArray, base: number): Token
}

const RULES: InlineRule[] = [
  {
    // 代码段:反引号数量必须成对且相同(` ``a`` ` 合法)
    re: /(?<ticks>`+)(?<body>[\s\S]*?)\k<ticks>/y,
    build: (m, base) => ({
      kind: 'code',
      raw: m[0],
      srcStart: base + m.index,
      srcEnd: base + m.index + m[0].length,
      children: [
        {
          kind: 'text',
          raw: m.groups?.body ?? '',
          srcStart: base + m.index + (m.groups?.ticks?.length ?? 0),
          srcEnd: base + m.index + m[0].length - (m.groups?.ticks?.length ?? 0)
        }
      ]
    })
  },
  {
    re: /\[\[(?<target>[^\[\]]+?)(?:\|(?<label>[^\[\]]*))?\]\]/y,
    build: (m, base) => {
      const target = m.groups?.target ?? ''
      const label = m.groups?.label
      return {
        kind: 'page',
        raw: m[0],
        srcStart: base + m.index,
        srcEnd: base + m.index + m[0].length,
        target,
        label: label && label.length > 0 ? label : target
      }
    }
  },
  {
    re: /#\[\[(?<target>[^\[\]]+?)\]\]/y,
    build: (m, base) => ({
      kind: 'tag',
      raw: m[0],
      srcStart: base + m.index,
      srcEnd: base + m.index + m[0].length,
      target: m.groups?.target ?? ''
    })
  },
  {
    re: /#(?<target>[^\s#[\]()`,，。；;]+)/y,
    build: (m, base) => ({
      kind: 'tag',
      raw: m[0],
      srcStart: base + m.index,
      srcEnd: base + m.index + m[0].length,
      target: m.groups?.target ?? ''
    })
  },
  {
    re: /\[(?<label>[^\]\n]*?)\]\((?<href>[^)\s]+)\)/y,
    build: (m, base) => ({
      kind: 'url',
      raw: m[0],
      srcStart: base + m.index,
      srcEnd: base + m.index + m[0].length,
      href: m.groups?.href ?? '',
      label: m.groups?.label ?? ''
    })
  },
  {
    re: /(?<href>https?:\/\/[^\s<>()[\]`]+)/y,
    build: (m, base) => {
      const href = m.groups?.href ?? ''
      return {
        kind: 'url',
        raw: m[0],
        srcStart: base + m.index,
        srcEnd: base + m.index + m[0].length,
        href,
        label: href
      }
    }
  }
]

/** 成对强调类:标记 → 子 token 的解析入口 */
const EMPHASIS: Array<{ kind: 'strong' | 'em' | 'strike' | 'highlight'; open: string; close: string }> = [
  { kind: 'strong', open: '**', close: '**' },
  { kind: 'strong', open: '__', close: '__' },
  { kind: 'strike', open: '~~', close: '~~' },
  { kind: 'highlight', open: '==', close: '==' },
  { kind: 'em', open: '*', close: '*' },
  { kind: 'em', open: '_', close: '_' }
]

export function tokenizeInline(text: string, base = 0): Token[] {
  const tokens: Token[] = []
  let i = 0
  let plainStart = 0

  const flushPlain = (end: number): void => {
    if (end <= plainStart) return
    tokens.push({
      kind: 'text',
      raw: text.slice(plainStart, end),
      srcStart: base + plainStart,
      srcEnd: base + end
    })
  }

  while (i < text.length) {
    const rest = text.slice(i)

    const emphasis = matchEmphasis(rest, i > 0 ? text[i - 1] : '')
    if (emphasis) {
      flushPlain(i)
      const innerStart = i + emphasis.open.length
      const innerEnd = i + emphasis.raw.length - emphasis.close.length
      tokens.push({
        kind: emphasis.kind,
        raw: emphasis.raw,
        srcStart: base + i,
        srcEnd: base + i + emphasis.raw.length,
        children: tokenizeInline(text.slice(innerStart, innerEnd), base + innerStart)
      })
      i += emphasis.raw.length
      plainStart = i
      continue
    }

    let hit = false
    for (const rule of RULES) {
      rule.re.lastIndex = i
      const m = rule.re.exec(text)
      if (!m || m.index !== i) continue
      flushPlain(i)
      tokens.push(rule.build(m, base))
      i += m[0].length
      plainStart = i
      hit = true
      break
    }
    if (hit) continue
    i++
  }
  flushPlain(text.length)
  return tokens
}

/**
 * 在 `i` 处匹配一对强调标记(不跳行;中间不能是空白,并且单字符标记不能被自己前面那个同样的字符抢走 ——
 * 否则 `**x*` 会被拆成「字面 * + 斜体 x」)。
 */
function matchEmphasis(
  rest: string,
  prev: string
): { kind: 'strong' | 'em' | 'strike' | 'highlight'; open: string; close: string; raw: string } | null {
  for (const spec of EMPHASIS) {
    if (!rest.startsWith(spec.open)) continue
    if ((spec.open === '*' || spec.open === '_') && (rest.startsWith(spec.open + spec.open) || prev === spec.open)) continue
    const bodyStart = spec.open.length
    const end = rest.indexOf(spec.close, bodyStart)
    if (end <= bodyStart) continue
    const body = rest.slice(bodyStart, end)
    if (!body.trim() || body.includes('\n')) continue
    if (/\s$/.test(body)) continue
    const raw = rest.slice(0, end + spec.close.length)
    return { kind: spec.kind, open: spec.open, close: spec.close, raw }
  }
  return null
}

// ---------- 行级标记(标题 / 复选框 / 引用 / 列表 / 水平线 / 围栏) ----------

/**
 * 一行开头的「标记」—— 渲染时这些字符**不显示原文**,而是变成结构(标题样式、勾选框、引用条、圆点)。
 * 与行内 token 一样带 `raw`(被吃掉的原文切片),所以「标记原文 + 剩余文本的 token 拼接 === 整行原文」
 * 这条零丢字不变式在行级也成立(见 `tests/logseqFormat.test.ts`)。
 */
export type LineMarkKind = 'plain' | 'heading' | 'task' | 'quote' | 'bullet' | 'ordered' | 'hr' | 'fence'

export interface LineMark {
  kind: LineMarkKind
  /** 行首被标记吃掉的原文(`plain` / 围栏内容行为 `''`) */
  raw: string
  /** heading 级别 1..6 */
  level?: number
  /** task 是否勾选(`[x]` / `[X]`) */
  checked?: boolean
  /** quote 嵌套层数(`>>` = 2) */
  depth?: number
  /** bullet 的 `*`/`+`/`-`,或 ordered 的 `1.` */
  marker?: string
  /** 围栏字符(``` / ~~~),由 `analyzeBlockLines` 填 */
  fence?: string
  role?: 'open' | 'content' | 'close'
}

/** ATX 标题:要求 `#` 后有空白(或行尾)⇒ 与 `#标签`(无空格)天然互斥 */
const HEADING_RE = /^(#{1,6})(?:[ \t]+|$)/
/** 水平线:整行只有 3 个以上的 `-` / `*` / `_` */
const HR_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/
/** 复选框:可选前置 bullet(`* [ ]` / `- [ ]`),也支持块首裸 `[ ]`(`- ` 已被块语法吃掉) */
const TASK_RE = /^([-*+][ \t]+)?\[([ xX])\](?:[ \t]+|$)/
/** 引用:一个或多个 `>`,后面可跟一个空格 */
const QUOTE_RE = /^(>+)[ \t]?/
/** 无序列表 */
const BULLET_RE = /^([-*+])[ \t]+/
/** 有序列表(`1.` / `1)`) */
const ORDERED_RE = /^(\d+[.)])[ \t]+/
/** 围栏代码块的开/闭行 */
const FENCE_LINE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/

/**
 * 只看**行首前缀**判断行级标记(不处理围栏的跨行状态,那是 `analyzeBlockLines` 的事)。
 * 顺序即优先级:task 必须在 bullet 之前,否则 `* [ ]` 会被当成列表项。
 */
export function matchLineMark(text: string): LineMark {
  const heading = HEADING_RE.exec(text)
  if (heading) return { kind: 'heading', raw: heading[0], level: heading[1].length }

  if (HR_RE.test(text)) return { kind: 'hr', raw: text }

  const task = TASK_RE.exec(text)
  if (task) return { kind: 'task', raw: task[0], checked: (task[2] ?? '').toLowerCase() === 'x' }

  const quote = QUOTE_RE.exec(text)
  if (quote) return { kind: 'quote', raw: quote[0], depth: quote[1].length }

  const bullet = BULLET_RE.exec(text)
  if (bullet) return { kind: 'bullet', raw: bullet[0], marker: bullet[1] }

  const ordered = ORDERED_RE.exec(text)
  if (ordered) return { kind: 'ordered', raw: ordered[0], marker: ordered[1] }

  return { kind: 'plain', raw: '' }
}

/** 一行渲染所需的一切:结构标记 + 标记之后剩余文本的 token(带全局源码偏移) */
export interface RenderedLine {
  /** 显示行号(0 = 块头,>0 = 第 N 条内容行),也是 textarea 里 `\n` 分隔的行号 */
  index: number
  text: string
  /** 本行在 `displayLines.join('\n')`(也就是 textarea 全文)里的起始偏移 */
  base: number
  mark: LineMark
  tokens: Token[]
}

function isFenceClose(text: string, fence: { char: string; len: number }): boolean {
  const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(text)
  if (!m) return false
  return m[1][0] === fence.char && m[1].length >= fence.len
}

/**
 * 把 `blockLinesForDisplay()` 出来的多行文本变成「可直接渲染的行」——
 * 跨行维护围栏状态,并给每行算出**全局 base 偏移**(textarea 里回车劈块、点哪落哪都靠它)。
 *
 * 围栏内容**不 token 化**(代码里的 `[[x]]` / `#tag` 不该变成可点链接),只作为纯文本 token;
 * 于是「`mark.raw` + token 原文拼接 === 整行原文」对每一行都成立。
 */
export function analyzeBlockLines(lines: readonly string[]): RenderedLine[] {
  const out: RenderedLine[] = []
  let base = 0
  let open: { char: string; len: number } | null = null

  lines.forEach((text, index) => {
    const line = (mark: LineMark, tokens: Token[]): void => {
      out.push({ index, text, base, mark, tokens })
      base += text.length + 1
    }

    if (open) {
      if (isFenceClose(text, open)) {
        line({ kind: 'fence', raw: text, fence: open.char.repeat(open.len), role: 'close' }, [])
        open = null
      } else {
        line({ kind: 'fence', raw: '', role: 'content' }, [
          { kind: 'text', raw: text, srcStart: base, srcEnd: base + text.length }
        ])
      }
      return
    }

    const fence = FENCE_LINE_RE.exec(text)
    if (fence) {
      open = { char: fence[1][0], len: fence[1].length }
      line({ kind: 'fence', raw: text, fence: fence[1], role: 'open' }, [])
      return
    }

    const mark = matchLineMark(text)
    const tokens = mark.kind === 'hr' ? [] : tokenizeInline(text.slice(mark.raw.length), base + mark.raw.length)
    line(mark, tokens)
  })

  return out
}

/** token 里的页面引用([[页]] 与 #标签 都算 Logseq 的页面引用) */
export function refsOfTokens(tokens: readonly Token[]): { pages: string[]; tags: string[] } {
  const pages = new Set<string>()
  const tags = new Set<string>()
  const visit = (list: readonly Token[]): void => {
    for (const t of list) {
      if (t.kind === 'page') pages.add(t.target)
      else if (t.kind === 'tag') tags.add(t.target)
      else if (t.kind === 'strong' || t.kind === 'em' || t.kind === 'code' || t.kind === 'strike' || t.kind === 'highlight') {
        visit(t.children)
      }
    }
  }
  visit(tokens)
  return { pages: [...pages], tags: [...tags] }
}

/** 拼回原文(token 拼接 === 原文,「渲染零丢字」的判据就是它) */
export function tokensToRaw(tokens: readonly Token[]): string {
  return tokens.map((t) => t.raw).join('')
}
