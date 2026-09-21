/**
 * Logseq 文件格式的解析 / 序列化 / 行内 tokenizer 用例。
 *
 * 最要紧的一组是**字节保真**:`serialize(parse(raw)) === raw` 对任意 raw 成立 ——
 * 它是「与 Logseq 共用同一个图」的安全底线(解析器理解错了也不会改写用户的文件)。
 * 第二组是**渲染零丢字**:所有 token 的 `raw` 拼接 === 原文。
 */

import { describe, expect, it } from 'vitest'
import {
  allBlocks,
  analyzeBlockLines,
  blockLinesForDisplay,
  blockText,
  DEFAULT_HIDDEN_PROPERTIES,
  detectIndentUnit,
  findBlock,
  groupBlockLines,
  indentText,
  matchBlockLine,
  matchLineMark,
  matchTableDelimiter,
  parseLogseqFile,
  propertyOf,
  refsOfTokens,
  serializeLogseqFile,
  splitLines,
  splitTableRow,
  tableCellsFor,
  tokenizeInline,
  tokensToRaw,
  visibleProperties,
  type Token
} from '../src/plugins/logseq/format'

/** 覆盖「容易写坏」的形态:空文件、无尾换行、CRLF、tab 缩进、多行内容、页面属性、未识别语法 */
const IDENTITY_CASES = [
  '',
  '\n',
  'a',
  '- a',
  '- a\n',
  '- a\n- b\n',
  '- a\r\n  - b\r\n',
  '- a\n\t- b\n',
  'title:: Test\ntags:: [[x]]\n\n- a\n  id:: 11111111-1111-4111-8111-111111111111\n  - b\n    ```js\n    const x = 1\n    ```\n- c\n',
  '- 两个空格后的文本\n  - 子块\n',
  '#+BEGIN_QUOTE\n引用\n#+END_QUOTE\n- a\n',
  '---\ntitle: front matter\n---\n- a\n',
  '- a\n\n- b\n',
  '   \n- 前导空行\n',
  '- 中文与 emoji 🎉\n',
  '- a\n  continuation line\n  key:: value\n'
]

describe('字节保真', () => {
  it('serialize(parse(raw)) === raw', () => {
    for (const raw of IDENTITY_CASES) {
      expect(serializeLogseqFile(parseLogseqFile(raw)), JSON.stringify(raw)).toBe(raw)
    }
  })

  it('splitLines 保留混合行尾与无尾换行', () => {
    expect(splitLines('a\r\nb\nc')).toEqual([
      { text: 'a', eol: '\r\n' },
      { text: 'b', eol: '\n' },
      { text: 'c', eol: '' }
    ])
    expect(splitLines('')).toEqual([])
  })
})

describe('块树', () => {
  const raw = [
    'title:: Test',
    '',
    '- alpha',
    '  id:: 11111111-1111-4111-8111-111111111111',
    '  - alpha child',
    '    - deep',
    '- beta',
    '  collapsed:: true',
    '  continuation',
    '- gamma',
    ''
  ].join('\n')

  it('嵌套、属性行与多行内容各归各位', () => {
    const file = parseLogseqFile(raw)
    const top = allBlocks(file)
    expect(top.map(blockText)).toEqual(['alpha', 'alpha child', 'deep', 'beta', 'gamma'])
    expect(top[0].key).toBe('0')
    expect(top[1].key).toBe('0.0')
    expect(top[2].key).toBe('0.0.0')
    expect(top[3].key).toBe('1')
    expect(top[0].extra.map((x) => x.kind)).toEqual(['prop'])
    expect(top[3].extra.map((x) => x.kind)).toEqual(['prop', 'content'])
  })

  it('findBlock 按 key 定位(含顶层与嵌套)', () => {
    const file = parseLogseqFile(raw)
    expect(findBlock(file, '1')?.block.key).toBe('1')
    expect(findBlock(file, '0.0.0')?.parent?.key).toBe('0.0')
    expect(findBlock(file, '9')).toBe(null)
  })

  it('页面属性行与空行进 raw 段,顺序不变', () => {
    const file = parseLogseqFile(raw)
    expect(file.entries.map((e) => e.kind)).toEqual(['raw', 'block', 'block', 'block'])
  })

  it('空白-only 的行算块内内容,真空行结束子树', () => {
    const withBlank = parseLogseqFile('- a\n  \n  x\n')
    expect(allBlocks(withBlank).length).toBe(1)
    const withEmpty = parseLogseqFile('- a\n\n- b\n')
    expect(allBlocks(withEmpty).map(blockText)).toEqual(['a', 'b'])
    expect(withEmpty.entries.map((e) => e.kind)).toEqual(['block', 'raw', 'block'])
  })

  it('缩进单元照文件本身检测(tab 优先,否则取最小正缩进)', () => {
    expect(detectIndentUnit(parseLogseqFile('- a\n\t- b\n'))).toBe('\t')
    expect(detectIndentUnit(parseLogseqFile('- a\n    - b\n'))).toBe('    ')
    expect(detectIndentUnit(parseLogseqFile('- a\n- b\n'))).toBe('  ')
  })

  it('显示用的多行内容去掉父缩进 + 一个缩进单元', () => {
    const file = parseLogseqFile('- a\n  ```js\n  const x = 1\n  ```\n')
    const block = allBlocks(file)[0]
    expect(blockLinesForDisplay(block, '  ')).toEqual(['a', '```js', 'const x = 1', '```'])
  })

  it('系统属性默认隐藏,自定义属性照常展示', () => {
    const file = parseLogseqFile('- a\n  id:: u\n  collapsed:: true\n  rating:: 8\n')
    const block = allBlocks(file)[0]
    expect(visibleProperties(block).map((p) => p.key)).toEqual(['rating'])
    expect(visibleProperties(block, []).map((p) => p.key)).toEqual(['id', 'collapsed', 'rating'])
    expect(DEFAULT_HIDDEN_PROPERTIES).toContain('id')
  })

  it('块行与属性行的识别', () => {
    expect(matchBlockLine('- x')).toEqual({ indent: '', text: 'x' })
    expect(matchBlockLine('  - ')).toEqual({ indent: '  ', text: '' })
    expect(matchBlockLine('-')).toEqual({ indent: '', text: '' })
    expect(matchBlockLine('x')).toBe(null)
    expect(indentText('\t  - x')).toBe('\t  ')
    expect(propertyOf('  id:: abc')).toEqual({ key: 'id', value: 'abc' })
    expect(propertyOf('  not a prop')).toBe(null)
  })
})

describe('行内 tokenizer', () => {
  const cases: Array<{ text: string; kinds: string[] }> = [
    { text: '普通文本', kinds: ['text'] },
    { text: '**粗**', kinds: ['strong'] },
    { text: '__粗__', kinds: ['strong'] },
    { text: '*斜*', kinds: ['em'] },
    { text: '_斜_', kinds: ['em'] },
    { text: '~~删~~', kinds: ['strike'] },
    { text: '==高==', kinds: ['highlight'] },
    { text: '`code`', kinds: ['code'] },
    { text: '[[页面]]', kinds: ['page'] },
    { text: '[[页面|别名]]', kinds: ['page'] },
    { text: '#标签', kinds: ['tag'] },
    { text: '#[[多字 标签]]', kinds: ['tag'] },
    { text: '[label](https://x.test)', kinds: ['url'] },
    { text: '看 https://x.test 这个', kinds: ['text', 'url', 'text'] },
    { text: '((11111111-1111-4111-8111-111111111111))', kinds: ['text'] },
    { text: '{{query 页面}}', kinds: ['text'] },
    { text: '**粗** 里有 [[页]]', kinds: ['strong', 'text', 'page'] }
  ]

  it('识别与顺序', () => {
    for (const item of cases) {
      expect(tokenizeInline(item.text).map((t) => t.kind), item.text).toEqual(item.kinds)
    }
  })

  it('渲染零丢字:raw 拼接 === 原文,且源码区间对得上', () => {
    const samples = [
      ...cases.map((c) => c.text),
      '`a` **b** *c* ~~d~~ ==e== [[f|g]] #h [i](j) https://k.test 剩余文本',
      '**x* 不完整',
      'a * b * c',
      '[[a|b]] 与 [[c]] 相邻[[d]]',
      ''
    ]
    for (const text of samples) {
      const tokens: Token[] = tokenizeInline(text)
      expect(tokensToRaw(tokens), text).toBe(text)
      for (const token of tokens) {
        expect(text.slice(token.srcStart, token.srcEnd), `${text} / ${token.raw}`).toBe(token.raw)
      }
    }
  })

  it('嵌套 token 也保留区间(强调里的双链)', () => {
    const [strong] = tokenizeInline('**[[页]]**')
    expect(strong.kind).toBe('strong')
    if (strong.kind !== 'strong') throw new Error('unreachable')
    expect(strong.children.map((c) => c.kind)).toEqual(['page'])
    expect(strong.children[0].raw).toBe('[[页]]')
    expect(strong.children[0].srcStart).toBe(2)
  })

  it('单字符标记不会被自己前面同字符抢走(`**x*` 原样显示)', () => {
    expect(tokenizeInline('**x*').map((t) => t.kind)).toEqual(['text'])
  })

  it('页面别名:target 是页面,label 是显示文本', () => {
    const [token] = tokenizeInline('[[cardinality|笔记]]')
    expect(token).toMatchObject({ kind: 'page', target: 'cardinality', label: '笔记' })
  })

  it('refsOfTokens 同时收页面与标签(含嵌套里的)', () => {
    const refs = refsOfTokens(tokenizeInline('见 **[[A]]** 与 #b 和 #[[C D]] 与 [[A]]'))
    expect(refs.pages).toEqual(['A'])
    expect(refs.tags).toEqual(['b', 'C D'])
  })
})

describe('行级标记', () => {
  it('matchLineMark:顺序与优先级(task 先于 bullet,标题先于标签)', () => {
    const cases: Array<{ text: string; expect: Record<string, unknown> }> = [
      { text: '# 标题', expect: { kind: 'heading', raw: '# ', level: 1 } },
      { text: '###### 六级', expect: { kind: 'heading', raw: '###### ', level: 6 } },
      { text: '####### 七级不是标题', expect: { kind: 'plain', raw: '' } },
      { text: '#标签', expect: { kind: 'plain', raw: '' } },
      { text: '##', expect: { kind: 'heading', raw: '##', level: 2 } },
      { text: '---', expect: { kind: 'hr', raw: '---' } },
      { text: '   ***', expect: { kind: 'hr', raw: '   ***' } },
      { text: '[ ] 块首任务', expect: { kind: 'task', raw: '[ ] ', checked: false } },
      { text: '[x] 已完成', expect: { kind: 'task', raw: '[x] ', checked: true } },
      { text: '[X] 大写也算勾选', expect: { kind: 'task', raw: '[X] ', checked: true } },
      { text: '* [ ] 块内清单', expect: { kind: 'task', raw: '* [ ] ', checked: false } },
      { text: '- [x] 子块首', expect: { kind: 'task', raw: '- [x] ', checked: true } },
      { text: '* 只是列表项', expect: { kind: 'bullet', raw: '* ', marker: '*' } },
      { text: '+ 也是列表项', expect: { kind: 'bullet', raw: '+ ', marker: '+' } },
      { text: '1. 有序', expect: { kind: 'ordered', raw: '1. ', marker: '1.' } },
      { text: '2) 有序', expect: { kind: 'ordered', raw: '2) ', marker: '2)' } },
      { text: '> 引用', expect: { kind: 'quote', raw: '> ', depth: 1 } },
      { text: '>> 嵌套引用', expect: { kind: 'quote', raw: '>> ', depth: 2 } },
      { text: '>无空格也认', expect: { kind: 'quote', raw: '>', depth: 1 } },
      { text: '普通文本', expect: { kind: 'plain', raw: '' } },
      { text: '**粗体**开头', expect: { kind: 'plain', raw: '' } },
      { text: '[ ]', expect: { kind: 'task', raw: '[ ]', checked: false } }
    ]
    for (const item of cases) {
      expect(matchLineMark(item.text), item.text).toMatchObject(item.expect)
    }
  })

  it('analyzeBlockLines:每行 base 累积正确', () => {
    const lines = ['# 标题', '正文', '> 引用']
    const out = analyzeBlockLines(lines)
    expect(out.map((l) => l.base)).toEqual([0, 5, 8])
    expect(out.map((l) => l.index)).toEqual([0, 1, 2])
    expect(out.map((l) => l.mark.kind)).toEqual(['heading', 'plain', 'quote'])
  })

  it('零丢字:标记原文 + token 拼接 === 整行原文(srcStart 也是全局偏移)', () => {
    const lines = [
      '# 标题里有 [[页]]',
      '## 二级 **粗**',
      '#标签不是标题',
      '---',
      '* [ ] 清单 [[甲]]',
      '[x] 块首 #tag',
      '> 引用 `code`',
      '>> 嵌套 #[[多字 标签]]',
      '1. 有序项',
      '普通 https://x.test 文本',
      '` ``` ` 反引号里的围栏不算',
      '```js',
      'const x = [[不是链接]]',
      '```'
    ]
    const joined = lines.join('\n')
    const out = analyzeBlockLines(lines)
    expect(out).toHaveLength(lines.length)
    for (const line of out) {
      expect(line.mark.raw + tokensToRaw(line.tokens), line.text).toBe(line.text)
      for (const token of line.tokens) {
        expect(joined.slice(token.srcStart, token.srcEnd), `${line.text} / ${token.raw}`).toBe(token.raw)
        expect(token.srcStart).toBeGreaterThanOrEqual(line.base)
      }
    }
  })

  it('围栏分组:开 / 内容 / 闭合,代码里的双链不 token 化', () => {
    const out = analyzeBlockLines(['```js', 'const [[x]] = 1', '```', '之后'])
    expect(out.map((l) => l.mark.role)).toEqual(['open', 'content', 'close', undefined])
    expect(out.map((l) => l.mark.kind)).toEqual(['fence', 'fence', 'fence', 'plain'])
    expect(out[1].tokens.map((t) => t.kind)).toEqual(['text'])
    expect(out[3].mark.raw).toBe('')
  })

  it('未闭合围栏:后面的行全当代码内容(CommonMark 行为)', () => {
    const out = analyzeBlockLines(['```', 'a', '# 不是标题'])
    expect(out.map((l) => l.mark.kind)).toEqual(['fence', 'fence', 'fence'])
    expect(out.map((l) => l.mark.role)).toEqual(['open', 'content', 'content'])
  })

  it('~~~ 围栏只在同字符且不短于开启时闭合', () => {
    const backtickInside = analyzeBlockLines(['~~~', '```', '~~~'])
    expect(backtickInside.map((l) => l.mark.role)).toEqual(['open', 'content', 'close'])
    const shorter = analyzeBlockLines(['`````', '```', '`````'])
    expect(shorter.map((l) => l.mark.role)).toEqual(['open', 'content', 'close'])
  })
})

describe('表格', () => {
  it('splitTableRow:按竖线切,前导空白不计入,没有尾竖线也认', () => {
    expect(splitTableRow('| a | b |')?.map((c) => c.raw)).toEqual([' a ', ' b '])
    expect(splitTableRow('   |  甲|乙  |')?.map((c) => c.raw)).toEqual(['  甲', '乙  '])
    expect(splitTableRow('| a | b')?.map((c) => c.raw)).toEqual([' a ', ' b'])
    // 不是表格行:不以竖线开头(空行 / 正文 / 只有 `- ` 的行)
    expect(splitTableRow('a | b')).toBeNull()
    expect(splitTableRow('')).toBeNull()
    expect(splitTableRow('|')).toBeNull()
  })

  it('splitTableRow:`\|` 转义不切分', () => {
    const cells = splitTableRow('| a \\| b | c |')
    expect(cells?.map((c) => c.raw)).toEqual([' a \\| b ', ' c '])
  })

  it('matchTableDelimiter:三种对齐 + 不是分隔行返回 null', () => {
    expect(matchTableDelimiter('| --- | :--- | ---: | :---: |')).toEqual([null, 'left', 'right', 'center'])
    expect(matchTableDelimiter('|---|')).toEqual([null])
    expect(matchTableDelimiter('| -- |')).toEqual([null]) // 两个 `-` 也算(至少两个)
    expect(matchTableDelimiter('| - |')).toBeNull() // 一个 `-` 不算
    expect(matchTableDelimiter('| abc |')).toBeNull()
    expect(matchTableDelimiter('普通文本')).toBeNull()
    expect(matchTableDelimiter('| a | b |')).toBeNull()
  })

  it('tableCellsFor:去空白、偏移是全局的、单元格内 token 化', () => {
    const line = '  | 甲 | [[页]] |'
    const cells = tableCellsFor(line, 100, ['center', null])
    expect(cells.map((c) => c.text)).toEqual(['甲', '[[页]]'])
    expect(cells.map((c) => c.align)).toEqual(['center', null])
    for (const cell of cells) {
      expect(line.slice(cell.srcStart - 100, cell.srcEnd - 100)).toBe(cell.text)
      expect(tokensToRaw(cell.tokens)).toBe(cell.text)
    }
    expect(cells[1].tokens.map((t) => t.kind)).toEqual(['page'])
    expect(cells[1].tokens[0]).toMatchObject({ target: '页', label: '页' })
  })

  it('analyzeBlockLines:表头 + 分隔行 + 数据行,后续非表格行收尾', () => {
    const lines = ['| a | b |', '| --- | ---: |', '| 1 | 2 |', '普通文本', '| 孤行没有分隔 |']
    const out = analyzeBlockLines(lines)
    expect(out.map((l) => l.mark.kind)).toEqual(['table', 'table', 'table', 'plain', 'plain'])
    expect(out.map((l) => l.mark.role)).toEqual(['header', 'delim', 'row', undefined, undefined])
    expect(out[2].mark.cells?.map((c) => c.align)).toEqual([null, 'right'])
    expect(out[2].mark.cells?.map((c) => c.text)).toEqual(['1', '2'])
    // 表格行的零丢字:raw = 整行,tokens 为空(与 hr 同款)
    for (const line of out.slice(0, 3)) {
      expect(line.mark.raw + tokensToRaw(line.tokens), line.text).toBe(line.text)
    }
    // base 仍逐行累积
    expect(out.map((l) => l.base)).toEqual([0, 10, 25, 35, 40])
  })

  it('只有表头没有分隔行 / 只有分隔行:都不算表格', () => {
    expect(analyzeBlockLines(['| a | b |', '| 1 | 2 |']).map((l) => l.mark.kind)).toEqual(['plain', 'plain'])
    expect(analyzeBlockLines(['|---|', '| a |']).map((l) => l.mark.kind)).toEqual(['plain', 'plain'])
  })

  it('围栏里的 `|` 行仍是代码(围栏优先)', () => {
    const out = analyzeBlockLines(['```', '| a | b |', '| --- | --- |', '```'])
    expect(out.map((l) => l.mark.kind)).toEqual(['fence', 'fence', 'fence', 'fence'])
    expect(out[1].tokens.map((t) => t.kind)).toEqual(['text'])
  })

  it('列数不齐不抛异常:对齐按分隔行的列号,缺列 align 为 null', () => {
    const out = analyzeBlockLines(['| a | b | c |', '| --- | ---: |', '| 1 |'])
    expect(out[0].mark.cells).toHaveLength(3)
    expect(out[2].mark.cells).toHaveLength(1)
    expect(out[2].mark.cells?.[0].align).toBeNull()
  })

  it('groupBlockLines:连续表格行合成一组,其余各占一组', () => {
    const lines = ['开头', '| a |', '| --- |', '| 1 |', '结尾']
    const groups = groupBlockLines(analyzeBlockLines(lines))
    expect(groups.map((g) => g.kind)).toEqual(['line', 'table', 'line'])
    const table = groups[1]
    expect(table.kind === 'table' && table.rows.map((r) => r.text)).toEqual(['| a |', '| --- |', '| 1 |'])
  })

  it('整块的表格:display 行去掉块缩进后照样认(块头是第一行)', () => {
    const file = parseLogseqFile(['- | 表头 |', '  | --- |', '  | 值 |', ''].join('\n'))
    const block = allBlocks(file)[0]
    const display = blockLinesForDisplay(block, detectIndentUnit(file))
    const out = analyzeBlockLines(display)
    expect(out.map((l) => l.mark.role)).toEqual(['header', 'delim', 'row'])
    expect(out[2].mark.cells?.[0].text).toBe('值')
  })
})
