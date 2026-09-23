/**
 * 图索引与反向链接的用例(用内存 IO,不碰真实磁盘)。
 *
 * 重点钉住三件事:
 * ① 索引把「日志/页面、title::、文件名解码、标签、多行内容」都收全;
 * ② 增量扫描只重读 mtime 变过的文件(否则每次保存都全量重读,大图会很卡);
 * ③ 反链排序与「不把自己列成自己的反链」。
 */

import { describe, expect, it } from 'vitest'
import {
  backlinksOf,
  buildIndex,
  indexStats,
  isHidden,
  journalDays,
  MAX_INDEX_FILES,
  parseIndexedFile,
  refsOfText,
  resolvePage,
  scanGraph,
  searchPages,
  type GraphIo,
  type GraphIndex
} from '../src/plugins/logseq/graph'
import { DEFAULT_GRAPH_CONFIG, compileDateFormat, type GraphConfig } from '../src/plugins/logseq/shared'

/** 内存文件系统:`listDir` 返回直接子项(目录以 '/' 结尾),mtime 由写入顺序决定 */
function memIo(files: Record<string, { content: string; mtimeMs: number }>): GraphIo & {
  reads: string[]
  touch(path: string, content: string): void
} {
  const reads: string[] = []
  return {
    reads,
    async listDir(path: string): Promise<string[] | null> {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const names = new Set<string>()
      let found = false
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) {
          found = true
          names.add(key.slice(prefix.length))
        }
      }
      return found ? [...names] : null
    },
    async readText(path: string): Promise<string> {
      const hit = files[path]
      if (!hit) throw new Error(`ENOENT ${path}`)
      reads.push(path)
      return hit.content
    },
    async mtimeMs(path: string): Promise<number | null> {
      return files[path]?.mtimeMs ?? null
    },
    join(...parts: string[]): string {
      return parts.join('/')
    },
    touch(path: string, content: string): void {
      files[path] = { content, mtimeMs: (files[path]?.mtimeMs ?? 0) + 1 }
    }
  }
}

const ROOT = '/graph'

function graphFiles(): Record<string, { content: string; mtimeMs: number }> {
  return {
    '/graph/logseq/config.edn': { content: '{:meta/version 1}', mtimeMs: 1 },
    '/graph/journals/2026_09_20.md': {
      content: '- 今天读了 [[cardinality]] 的笔记\n  - 关联到 #数据库\n',
      mtimeMs: 10
    },
    '/graph/journals/2026_09_19.md': { content: '- 昨天 [[cardinality]] 又 [[数据库]]\n', mtimeMs: 11 },
    '/graph/pages/cardinality.md': {
      content: 'title:: Cardinality\nalias:: 基数\n- Cardinality 估行数\n  - 见 [[数据库]]\n',
      mtimeMs: 12
    },
    '/graph/pages/数据库.md': { content: '- 用 [[Cardinality]] 估行数\n', mtimeMs: 13 },
    '/graph/pages/忽略.md': { content: '- 不该被索引\n', mtimeMs: 14 },
    '/graph/pages/笔记.txt': { content: '不是 markdown\n', mtimeMs: 15 }
  }
}

async function build(graphConfig: GraphConfig = DEFAULT_GRAPH_CONFIG): Promise<{ index: GraphIndex; io: ReturnType<typeof memIo> }> {
  const io = memIo(graphFiles())
  const index = await scanGraph(io, ROOT, graphConfig, null)
  return { index, io }
}

describe('图扫描', () => {
  it('索引日志与页面,跳过非 .md 与被 :hidden 排除的路径', async () => {
    const { index } = await build({ ...DEFAULT_GRAPH_CONFIG, hidden: ['/pages/忽略.md'] })
    expect(index.files.map((f) => f.rel).sort()).toEqual([
      'journals/2026_09_19.md',
      'journals/2026_09_20.md',
      'pages/cardinality.md',
      'pages/数据库.md'
    ])
    expect(index.tooLarge).toBe(false)
  })

  it('日志用日期当标题,页面用 title:: 优先、否则解码文件名', async () => {
    const { index } = await build()
    const byRel = new Map(index.files.map((f) => [f.rel, f]))
    expect(byRel.get('journals/2026_09_20.md')?.title).toBe('2026-09-20')
    expect(byRel.get('journals/2026_09_20.md')?.day).toBe('2026-09-20')
    expect(byRel.get('pages/cardinality.md')?.title).toBe('Cardinality')
    expect(byRel.get('pages/cardinality.md')?.day).toBe(null)
    expect(byRel.get('pages/数据库.md')?.title).toBe('数据库')
  })

  it('日志文件名与当前格式串不一致时用宽松解析兜住', async () => {
    const io = memIo({ '/graph/journals/2026-09-20.md': { content: '- x\n', mtimeMs: 1 } })
    const index = await scanGraph(io, ROOT, DEFAULT_GRAPH_CONFIG, null)
    expect(index.files[0].day).toBe('2026-09-20')
    expect(index.byDay.has('2026-09-20')).toBe(true)
  })

  it('引用收全:标题、多行内容、标签、页面属性行的别名', async () => {
    const { index } = await build()
    const cardinality = index.byPath.get('pages/cardinality.md')
    expect(cardinality?.refs.sort()).toEqual(['数据库'])
    const journal = index.byPath.get('journals/2026_09_20.md')
    expect(journal?.refs.sort()).toEqual(['cardinality', '数据库'])
    // `alias:: 基数` 里的引用(没有 [[]] 就不是引用)与 title:: 都不该混进来
    expect(journal?.refs).not.toContain('基数')
  })

  it('块级上下文带行号(head + 多行内容 + 子块都计数)', async () => {
    const { index } = await build()
    const journal = index.byPath.get('journals/2026_09_20.md')
    expect(journal?.blocks.map((b) => b.line)).toEqual([1, 2])
    expect(journal?.blocks[1].refs).toEqual(['数据库'])
  })

  it('增量扫描:只有 mtime 变过的文件被重读', async () => {
    const io = memIo(graphFiles())
    const first = await scanGraph(io, ROOT, DEFAULT_GRAPH_CONFIG, null)
    expect(io.reads.length).toBe(5)

    io.reads.length = 0
    const second = await scanGraph(io, ROOT, DEFAULT_GRAPH_CONFIG, first)
    expect(io.reads).toEqual([])
    // 未变的文件复用同一份对象(不是「内容相同的新对象」)
    expect(second.byPath.get('pages/数据库.md')).toBe(first.byPath.get('pages/数据库.md'))

    io.touch('/graph/journals/2026_09_20.md', '- 改了 [[图]]\n')
    io.reads.length = 0
    const third = await scanGraph(io, ROOT, DEFAULT_GRAPH_CONFIG, second)
    expect(io.reads).toEqual(['/graph/journals/2026_09_20.md'])
    expect(third.byPath.get('journals/2026_09_20.md')?.refs).toEqual(['图'])
    expect(third.byPath.get('pages/数据库.md')).toBe(first.byPath.get('pages/数据库.md'))
  })

  it('文件数超上限时给出 tooLarge,调用方据此退化', async () => {
    const io = memIo(
      Object.fromEntries(
        Array.from({ length: MAX_INDEX_FILES + 10 }, (_, i) => [`/graph/pages/p${i}.md`, { content: '- x\n', mtimeMs: 1 }])
      )
    )
    const index = await scanGraph(io, ROOT, DEFAULT_GRAPH_CONFIG, null)
    expect(index.tooLarge).toBe(true)
  })

  it('`:hidden` 按「相对图根」的三种写法命中', () => {
    expect(isHidden('archived/x.md', ['/archived'])).toBe(true) // 目录:带不带斜杠都行
    expect(isHidden('archived/x.md', ['archived'])).toBe(true)
    expect(isHidden('pages/test.md', ['/pages/test.md'])).toBe(true) // 完整相对路径
    expect(isHidden('test.md', ['test.md'])).toBe(true) // 不带斜杠的条目按基名
    expect(isHidden('pages/keep.md', ['/archived', '/pages/test.md'])).toBe(false)
    // 相对图根语义:`/archived` 不该把任意叫 archived 的子目录也藏掉
    expect(isHidden('pages/archived/x.md', ['/archived'])).toBe(false)
    expect(isHidden('pages/test.md', [])).toBe(false)
  })

  it('目录不存在时是空索引,不抛异常', async () => {
    const io = memIo({})
    const index = await scanGraph(io, ROOT, DEFAULT_GRAPH_CONFIG, null)
    expect(index.files).toEqual([])
    expect(journalDays(index)).toEqual([])
    expect(refsOfText('见 [[A]] 与 #b')).toEqual(['a', 'b'])
  })
})

describe('反向链接', () => {
  it('按「谁引用了它」聚合,日志在前(日期倒序),跳过文件自己', async () => {
    const { index } = await build()
    const links = backlinksOf(index, 'Cardinality')
    expect(links.total).toBe(3)
    expect(links.groups.map((g) => g.title)).toEqual(['2026-09-20', '2026-09-19', '数据库'])
    expect(links.groups[0].blocks).toEqual([{ line: 1, text: '今天读了 [[cardinality]] 的笔记' }])
  })

  it('大小写与标签路径都能命中(页面 identity 是小写)', async () => {
    const { index } = await build()
    expect(backlinksOf(index, 'cardinality').total).toBe(3)
    expect(backlinksOf(index, '数据库').total).toBe(3)
    expect(backlinksOf(index, '不存在的页').total).toBe(0)
    expect(backlinksOf(index, '  ').total).toBe(0)
  })

  it('自己引用自己不算反链', async () => {
    const index = buildIndex({
      root: ROOT,
      config: DEFAULT_GRAPH_CONFIG,
      format: compileDateFormat(DEFAULT_GRAPH_CONFIG.fileFormat),
      files: [
        parseIndexedFile({
          path: '/graph/pages/a.md',
          rel: 'pages/a.md',
          mtimeMs: 1,
          raw: '- [[a]] 自引用\n- 别的\n',
          format: compileDateFormat(DEFAULT_GRAPH_CONFIG.fileFormat),
          isJournal: false
        })
      ]
    })
    expect(backlinksOf(index, 'a').total).toBe(0)
  })

  it('limit 只影响返回的块,total 仍是全量', async () => {
    const { index } = await build()
    const limited = backlinksOf(index, '数据库', 1)
    expect(limited.total).toBe(3)
    expect(limited.groups.flatMap((g) => g.blocks).length).toBe(1)
  })
})

describe('搜索与解析', () => {
  it('前缀优先、其次包含;日志会在页面之前', async () => {
    const { index } = await build()
    expect(searchPages(index, 'card').map((h) => h.name)).toEqual(['Cardinality'])
    expect(searchPages(index, '2026').map((h) => h.name)).toEqual(['2026-09-20', '2026-09-19'])
    expect(searchPages(index, '').length).toBe(5)
  })

  it('resolvePage:标题(大小写不敏感)与日期两条路', async () => {
    const { index } = await build()
    expect(resolvePage(index, 'cardinality')?.rel).toBe('pages/cardinality.md')
    expect(resolvePage(index, 'CARDINALITY')?.rel).toBe('pages/cardinality.md')
    expect(resolvePage(index, '2026-09-20')?.rel).toBe('journals/2026_09_20.md')
    expect(resolvePage(index, '')).toBe(null)
    expect(resolvePage(index, '没有这个页')).toBe(null)
  })

  it('页面名的别名:文件名与 title:: 不同时,两个名字都解析到同一个文件', async () => {
    const io = memIo({
      '/graph/pages/enter-top-props.md': { content: 'title:: EnterTopProps\n- 甲\n', mtimeMs: 2 }
    })
    const index = await scanGraph(io, ROOT, DEFAULT_GRAPH_CONFIG, null)
    expect(index.files[0].stem).toBe('enter-top-props')
    expect(index.files[0].title).toBe('EnterTopProps')
    expect(resolvePage(index, 'EnterTopProps')?.rel).toBe('pages/enter-top-props.md')
    // 旧行为:null ⇒ `readPage` 把它当成新页,而新页的路径正是这个已存在的文件 ⇒ 一保存就覆盖
    expect(resolvePage(index, 'enter-top-props')?.rel).toBe('pages/enter-top-props.md')
    // 搜索框敲文件名也得能看见这一页(否则用户以为它不存在,回车就新建)
    expect(searchPages(index, 'enter-top').map((h) => h.name)).toEqual(['EnterTopProps'])
    expect(resolvePage(index, 'enter-top-props-2')).toBe(null)
  })

  it('byStem 只收页面:日志按日期认,文件名别名不抢键', async () => {
    const { index } = await build()
    expect(index.byStem.has('cardinality')).toBe(true)
    expect(index.byStem.has('数据库')).toBe(true)
    expect(index.byStem.has('2026_09_20')).toBe(false)
  })

  it('stats 与日期列表', async () => {
    const { index } = await build()
    expect(journalDays(index)).toEqual(['2026-09-20', '2026-09-19'])
    const stats = indexStats(index)
    expect(stats.files).toBe(5)
    expect(stats.blocks).toBe(7)
    expect(stats.days).toBe(2)
  })
})
