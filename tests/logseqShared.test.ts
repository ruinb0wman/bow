/**
 * 笔记插件纯逻辑用例:日期 ↔ 文件名词干、页面名 ↔ 文件名、`config.edn` 键值、模板变量、块编辑命令。
 *
 * 编辑命令这一组刻意断言**整份文件的最终文本**(而不是只断言树形状):这样「没被碰过的行
 * 逐字节不变」是被真正钉住的 —— 与 Logseq 共用一个图时,这是我们唯一的护身符。
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_STEM,
  detectIndentUnit,
  MAX_RECENT_GRAPHS,
  allBlocks,
  blockLinesForDisplay,
  blockText,
  compileDateFormat,
  decodePageName,
  defaultSettings,
  deleteBlock,
  encodePageName,
  expandTemplate,
  formatDayTitle,
  formatJournalStem,
  indentBlock,
  insertFirstBlock,
  insertSiblingAfter,
  isJournalDay,
  mergeWithPrevious,
  normalizeSettings,
  normalizeView,
  outdentBlock,
  parseConfigEdn,
  parseLogseqFile,
  parseJournalStem,
  parseLooseDay,
  serializeLogseqFile,
  setBlockContentLines,
  setBlockText,
  shiftDay,
  splitBlock,
  todayDay,
  topBlocks,
  withGraph
} from '../src/plugins/logseq/shared'

const FIXTURE = [
  'title:: Test',
  '',
  '- alpha',
  '  id:: 11111111-1111-4111-8111-111111111111',
  '  - alpha child',
  '- beta',
  '  collapsed:: true',
  '- gamma',
  ''
].join('\n')

function edit(fn: (file: ReturnType<typeof parseLogseqFile>) => { file: ReturnType<typeof parseLogseqFile> }): string {
  const file = parseLogseqFile(FIXTURE)
  return serializeLogseqFile(fn(file).file)
}

describe('日期格式', () => {
  it('默认与常见格式都能读写', () => {
    expect(compileDateFormat('yyyy_MM_dd').ok).toBe(true)
    expect(formatJournalStem('2026-09-20')).toBe('2026_09_20')
    expect(formatJournalStem('2026-09-20', 'yyyy-MM-dd')).toBe('2026-09-20')
    expect(formatJournalStem('2026-09-20', 'yyyyMMdd')).toBe('20260920')
    expect(formatJournalStem('2026-09-20', 'd.M.yyyy')).toBe('20.9.2026')
  })

  it('解析是格式化之逆', () => {
    for (const format of ['yyyy_MM_dd', 'yyyy-MM-dd', 'yyyyMMdd', 'd.M.yyyy', 'yy/M/d']) {
      const stem = formatJournalStem('2026-09-20', format)
      expect(parseJournalStem(stem, format), `${format} → ${stem}`).toBe('2026-09-20')
    }
  })

  it('moment 方言整条回落到默认格式,并记下不认识的 token', () => {
    const spec = compileDateFormat('EEE, MMM do yyyy')
    expect(spec.ok).toBe(false)
    expect(spec.unsupported).toBe('EEE')
    expect(spec.format).toBe('yyyy_MM_dd')
    // 回落后正则与格式串必须一致,否则读出来的日期会错位
    expect(parseJournalStem('2026_09_20', spec)).toBe('2026-09-20')
  })

  it('宽松解析只服务读路径(不同分隔符的历史文件)', () => {
    expect(parseLooseDay('2026_09_20')).toBe('2026-09-20')
    expect(parseLooseDay('2026-9-5')).toBe('2026-09-05')
    expect(parseLooseDay('2026.09.20')).toBe('2026-09-20')
    expect(parseLooseDay('2026-09-20 周日')).toBe('2026-09-20')
    expect(parseLooseDay('2026_13_01')).toBe(null)
    expect(parseLooseDay('2026_02_30')).toBe(null)
    expect(parseLooseDay('随手写的文件')).toBe(null)
  })

  it('日期合法性与加减', () => {
    expect(isJournalDay('2026-09-20')).toBe(true)
    expect(isJournalDay('2026-9-20')).toBe(false)
    expect(isJournalDay('2026-02-29')).toBe(false)
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDay('2026-09-20', 0)).toBe('2026-09-20')
    // 经过夏令时/hours 变化也不该错一天(实现走 UTC 运算)
    expect(shiftDay('2026-04-05', 1)).toBe('2026-04-06')
  })

  it('今天用本地时区,标题带星期', () => {
    expect(todayDay(new Date(2026, 8, 20, 23, 30))).toBe('2026-09-20')
    expect(formatDayTitle('2026-09-20')).toBe('2026-09-20 周日')
    expect(formatDayTitle('不是日期')).toBe('不是日期')
  })
})

describe('页面名 ↔ 文件名', () => {
  it('照 Logseq 的 :triple-lowbar 规则', () => {
    expect(encodePageName('cardinality')).toBe('cardinality')
    expect(encodePageName('a/b')).toBe('a___b')
    expect(encodePageName('a?b')).toBe('a%3Fb')
    expect(encodePageName('a*b')).toBe('a%2Ab')
    expect(encodePageName('a:b')).toBe('a%3Ab')
    expect(encodePageName('结尾有点. ')).toBe('结尾有点')
    expect(decodePageName('a___b')).toBe('a/b')
    expect(decodePageName('a%3Fb')).toBe('a?b')
  })

  it('普通标题往返一致', () => {
    for (const name of ['cardinality', '数据库 设计', 'a/b/c', 'emoji 🎉', 'C++ & C#']) {
      expect(decodePageName(encodePageName(name))).toBe(name)
    }
  })

  it('超长标题截断到 160,空的兜底成 untitled', () => {
    expect(encodePageName('x'.repeat(200))).toHaveLength(MAX_FILE_STEM)
    expect(encodePageName('   ')).toBe('untitled')
    expect(encodePageName('')).toBe('untitled')
  })

  it('百分号序列坏掉时原样返回,不抛异常', () => {
    expect(decodePageName('a%')).toBe('a%')
    expect(decodePageName('a%zz')).toBe('a%zz')
  })
})

describe('config.edn 键值提取', () => {
  const config = [
    '{:meta/version 1',
    ' :preferred-workflow :now',
    ' :hidden ["/archived" "/test.md"]',
    ' :default-templates',
    ' {:journals "Daily"}',
    ' :journal/file-name-format "yyyy-MM-dd"',
    ' :journals-directory "journal"',
    ' :pages-directory "/notes/"',
    ' :block-hidden-properties #{:public :icon}}'
  ].join('\n')

  it('取到我们关心的六个值', () => {
    const parsed = parseConfigEdn(config)
    expect(parsed).toEqual({
      journalsDir: 'journal',
      pagesDir: 'notes',
      fileFormat: 'yyyy-MM-dd',
      defaultJournalTemplate: 'Daily',
      hidden: ['/archived', '/test.md'],
      hiddenProperties: ['public', 'icon']
    })
  })

  it('读不到就用默认值(绝不写回这个文件)', () => {
    expect(parseConfigEdn('')).toEqual({
      journalsDir: 'journals',
      pagesDir: 'pages',
      fileFormat: 'yyyy_MM_dd',
      defaultJournalTemplate: '',
      hidden: [],
      hiddenProperties: []
    })
    const weird = parseConfigEdn('{完全不是 EDN')
    expect(weird.journalsDir).toBe('journals')
  })
})

describe('模板变量', () => {
  it('展开已知变量,未知的原样留下', () => {
    const now = new Date(2026, 8, 20, 7, 5, 9)
    const out = expandTemplate('- <%date%> <%time%> [[<%current page%>]]\n  <%yesterday%> → <%tomorrow%>\n  <%input: 今天做了啥%>', {
      day: '2026-09-20',
      page: '日记模板',
      now
    })
    expect(out).toBe('- 2026-09-20 07:05:09 [[日记模板]]\n  2026-09-19 → 2026-09-21\n  <%input: 今天做了啥%>')
  })

  it('没有 day 时用今天', () => {
    const out = expandTemplate('<%date%>', { now: new Date(2026, 0, 2, 3, 4, 5) })
    expect(out).toBe('2026-01-02')
  })
})

describe('插件设置', () => {
  it('规范化会去重、裁掉当前图、限长', () => {
    const settings = normalizeSettings({
      graphPath: ' /graph ',
      recentGraphs: ['/a', '/b', '/a', '', '   ', '/c', '/d', '/e', '/f']
    })
    expect(settings.graphPath).toBe('/graph')
    expect(settings.recentGraphs).toEqual(['/a', '/b', '/c', '/d', '/e'])
    expect(settings.recentGraphs.length).toBeLessThanOrEqual(MAX_RECENT_GRAPHS)
    expect(normalizeSettings(null)).toEqual(defaultSettings())
  })

  it('切图把旧图推进最近列表', () => {
    const settings = normalizeSettings({ graphPath: '/g', recentGraphs: ['/a'] })
    expect(withGraph(settings, '/h')).toEqual({
      version: 1,
      graphPath: '/h',
      recentGraphs: ['/g', '/a']
    })
    // 切到已在最近列表里的图:不重复,顺序重排
    expect(withGraph(normalizeSettings({ graphPath: '/g', recentGraphs: ['/a', '/h'] }), '/h').recentGraphs).toEqual([
      '/g',
      '/a'
    ])
    expect(withGraph(settings, '')).toBe(settings)
  })

  it('视图状态按 kind 规范化(坏的输入回落到兜底)', () => {
    const fallback = { kind: 'journal', day: '2026-09-20' } as const
    expect(normalizeView({ kind: 'journal', day: '2026-01-02' }, fallback)).toEqual({ kind: 'journal', day: '2026-01-02' })
    expect(normalizeView({ kind: 'journal', day: '2026-1-2' }, fallback)).toEqual(fallback)
    expect(normalizeView({ kind: 'page', name: ' x ' }, fallback)).toEqual({ kind: 'page', name: 'x' })
    expect(normalizeView({ kind: 'page', name: '' }, fallback)).toEqual(fallback)
    expect(normalizeView(null, fallback)).toEqual(fallback)
  })
})

describe('块编辑命令', () => {
  it('块尾回车:插入同级新块', () => {
    const out = edit((file) => insertSiblingAfter(file, '1', 'new'))
    expect(out).toBe(
      ['title:: Test', '', '- alpha', '  id:: 11111111-1111-4111-8111-111111111111', '  - alpha child', '- beta', '  collapsed:: true', '- new', '- gamma', ''].join('\n')
    )
  })

  it('中间回车:劈成两块,子块留在前半', () => {
    const out = edit((file) => splitBlock(file, '1', 2))
    expect(out).toBe(
      ['title:: Test', '', '- alpha', '  id:: 11111111-1111-4111-8111-111111111111', '  - alpha child', '- be', '  collapsed:: true', '- ta', '- gamma', ''].join('\n')
    )
  })

  it('Tab:成为上一个兄弟的最后一个子块(缩进整棵子树)', () => {
    const out = edit((file) => indentBlock(file, '1'))
    expect(out).toBe(
      ['title:: Test', '', '- alpha', '  id:: 11111111-1111-4111-8111-111111111111', '  - alpha child', '  - beta', '    collapsed:: true', '- gamma', ''].join('\n')
    )
  })

  it('Shift+Tab:反缩进到父块之后', () => {
    const out = edit((file) => outdentBlock(file, '0.0'))
    expect(out).toBe(
      ['title:: Test', '', '- alpha', '  id:: 11111111-1111-4111-8111-111111111111', '- alpha child', '- beta', '  collapsed:: true', '- gamma', ''].join('\n')
    )
  })

  it('Backspace 合并:上一块没子块时并入上一块', () => {
    const file = parseLogseqFile('- a\n- b\n  id:: x\n  - b child\n')
    const merged = mergeWithPrevious(file, '1')
    expect(serializeLogseqFile(merged.file)).toBe('- ab\n  id:: x\n  - b child\n')
    expect(merged.focusKey).toBe('0')
  })

  it('Backspace:自己没有上一个兄弟时改为反缩进(子块场景)', () => {
    const file = parseLogseqFile('- a\n  - b\n')
    expect(serializeLogseqFile(mergeWithPrevious(file, '0.0').file)).toBe('- a\n- b\n')
  })

  it('Backspace:顶层块 + 上一块有子块 → 仍然合并(否则是死键)', () => {
    const out = edit((file) => mergeWithPrevious(file, '1'))
    expect(out).toBe(
      ['title:: Test', '', '- alphabeta', '  id:: 11111111-1111-4111-8111-111111111111', '  collapsed:: true', '  - alpha child', '- gamma', ''].join('\n')
    )
  })

  it('改文本只动块头那一行', () => {
    const out = serializeLogseqFile(setBlockText(parseLogseqFile(FIXTURE), '1', 'BETA'))
    expect(out).toContain('- BETA\n  collapsed:: true\n')
    expect(out).toContain('  id:: 11111111-1111-4111-8111-111111111111\n')
  })

  it('重写块的全部正文:属性行原样留在原位,内容行接在其后', () => {
    const out = serializeLogseqFile(setBlockContentLines(parseLogseqFile(FIXTURE), '1', ['beta', 'line2', 'line3']))
    expect(out).toContain('- beta\n  collapsed:: true\n  line2\n  line3\n')
  })

  it('display → set 是恒等:什么也没改地进去又出来,文件一个字节都不动', () => {
    for (const raw of [
      FIXTURE,
      '- a\n  ```js\n  const x = 1\n  ```\n',
      '- 单行\n',
      'title:: T\n- a\n  id:: u\n   深缩进内容\n- b\n'
    ]) {
      const file = parseLogseqFile(raw)
      const unit = detectIndentUnit(file)
      let next = file
      for (const block of allBlocks(file)) {
        if (block.children.length > 0) continue
        next = setBlockContentLines(next, block.key, blockLinesForDisplay(block, unit))
      }
      expect(serializeLogseqFile(next), raw).toBe(raw)
    }
  })

  it('删除块与它的子树,焦点落到下一个兄弟', () => {
    const file = parseLogseqFile(FIXTURE)
    const removed = deleteBlock(file, '0')
    expect(serializeLogseqFile(removed.file)).toBe(['title:: Test', '', '- beta', '  collapsed:: true', '- gamma', ''].join('\n'))
    expect(removed.focusKey).toBe('0')
  })

  it('顶层第一块无法缩进 / 无法再反缩进(原样返回)', () => {
    const file = parseLogseqFile(FIXTURE)
    expect(indentBlock(file, '0').file).toBe(file)
    expect(outdentBlock(file, '1').file).toBe(file)
    expect(mergeWithPrevious(file, '0').file).toBe(file)
  })

  it('空文件插入第一个块;无尾换行的文件补上行尾', () => {
    const empty = insertFirstBlock(parseLogseqFile(''), 'hi')
    expect(serializeLogseqFile(empty.file)).toBe('- hi\n')
    expect(empty.focusKey).toBe('0')

    const withProps = insertFirstBlock(parseLogseqFile('title:: T'), 'hi')
    expect(serializeLogseqFile(withProps.file)).toBe('title:: T\n- hi\n')

    const noTrailing = insertSiblingAfter(parseLogseqFile('- a'), '0', 'b')
    expect(serializeLogseqFile(noTrailing.file)).toBe('- a\n- b\n')

    const withValue = insertFirstBlock(
      parseLogseqFile('title:: T\n- first\n'),
      'hi'
    )
    expect(serializeLogseqFile(withValue.file)).toBe('title:: T\n- first\n- hi\n')
  })

  it('编辑命令是纯函数:不改动输入文件,也不影响无关行', () => {
    const file = parseLogseqFile(FIXTURE)
    const before = serializeLogseqFile(file)
    const edited = insertSiblingAfter(file, '2', 'x')
    expect(serializeLogseqFile(file)).toBe(before)
    expect(edited.file).not.toBe(file)
    // 未触及的行:原样复用同一份 SourceLine 对象(正是「逐字节不变」的实现方式)
    const originalAlpha = topBlocks(file)[0]
    const nextAlpha = topBlocks(edited.file)[0]
    expect(nextAlpha.head).toBe(originalAlpha.head)
    expect(nextAlpha.extra[0].line).toBe(originalAlpha.extra[0].line)
  })

  it('CRLF 文件里插入的块沿用 CRLF', () => {
    const file = parseLogseqFile('- a\r\n- b\r\n')
    expect(serializeLogseqFile(insertSiblingAfter(file, '0', 'mid').file)).toBe('- a\r\n- mid\r\n- b\r\n')
  })

  it('tab 缩进的文件里,Tab 用的也是 tab', () => {
    const file = parseLogseqFile('- a\n\t- b\n- c\n')
    const out = indentBlock(file, '1')
    expect(serializeLogseqFile(out.file)).toBe('- a\n\t- b\n\t- c\n')
  })

  it('块文本访问器对 `- ` / `-` / `-  多余空格` 都成立', () => {
    expect(topBlocks(parseLogseqFile('- x\n')).map(blockText)).toEqual(['x'])
    expect(topBlocks(parseLogseqFile('-\n')).map(blockText)).toEqual([''])
    expect(topBlocks(parseLogseqFile('-   y\n')).map(blockText)).toEqual(['  y'])
  })
})
