/**
 * 笔记插件主进程侧的接线用例:真的在一个临时目录里建一个 Logseq 图,然后走 IPC 面读写。
 *
 * 这一组刻意**用真实文件系统**(不是假 IO):要钉住的正是「写盘」这件事本身 ——
 * 原子写不留 `.tmp`、越界路径被拒、只写 journals/ 与 pages/、mtime 冲突不覆盖、
 * 模板只在第一次编辑时才落盘。纯逻辑另有 `logseqFormat/logseqShared/logseqGraph` 三组。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext } from '../src/main/plugins/types'

const dialogMock = { showOpenDialog: vi.fn() }
vi.mock('electron', () => ({
  app: { on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: dialogMock
}))

const { default: logseq } = await import('../src/plugins/logseq/main')
type FileRead = import('../src/plugins/logseq/shared').FileRead
type GraphState = import('../src/plugins/logseq/shared').GraphState
type SaveResult = import('../src/plugins/logseq/shared').SaveResult

interface Harness {
  handlers: Map<string, (...args: any[]) => unknown>
  emitEvent(name: string, payload?: unknown): void
  settings: { value: Record<string, unknown> }
  /** 插件广播出去的事件(`context.ipc.emit`):用来钉「自己写的文件不能触发重载」 */
  pluginEvents: Array<{ event: string; args: unknown }>
}

function harness(): Harness {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const subscriptions = new Map<string, (payload: any) => void>()
  const state = {
    handlers,
    emitEvent: (name: string, payload?: unknown) => subscriptions.get(name)?.(payload),
    settings: { value: {} as Record<string, unknown> },
    pluginEvents: [] as Array<{ event: string; args: unknown }>,
    // 插件只把 storage 当 JsonStore 用;这里给一份内存实现(set/setRaw 的语义与真的一致)
    storage: () => ({
      get: () => state.settings.value,
      set: (patch: Record<string, unknown>) => {
        state.settings.value = { ...state.settings.value, ...patch }
        return state.settings.value
      },
      setRaw: (value: Record<string, unknown>) => {
        state.settings.value = value
        return value
      }
    })
  }
  const ctx = {
    ...state,
    id: 'logseq',
    log: () => {},
    logError: () => {},
    ipc: {
      handle: (method: string, fn: (...args: any[]) => unknown) => handlers.set(method, fn),
      emit: (event: string, payload?: unknown) => {
        state.pluginEvents.push({ event, args: payload })
      }
    },
    events: {
      on: (name: string, cb: (payload: any) => void) => subscriptions.set(name, cb),
      emit: () => {}
    },
    suggest: { register: () => {} },
    mcp: { tool: () => {} },
    net: { onBeforeRequest: () => {}, onBeforeSendHeaders: () => {}, onHeadersReceived: () => {} },
    content: { inject: () => {}, refresh: () => {} },
    pages: { activeTabId: () => null, focus: () => {}, execute: async () => ({}), openDevToolsTab: () => 0 },
    tabs: { list: () => [], getActive: () => null },
    shortcuts: { register: () => {} }
  }
  // 返回的对象同时充当 PluginContext 与测试把手(handlers / settings / emitEvent 都从 state 展开进来)
  return ctx as unknown as Harness
}

let h: Harness
let graph: string

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/** 建一个最小可用的 Logseq 图:config.edn + 日志 + 页面 + 模板 */
function makeGraph(config = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'bow-logseq-'))
  mkdirSync(join(root, 'logseq'), { recursive: true })
  mkdirSync(join(root, 'journals'), { recursive: true })
  mkdirSync(join(root, 'pages'), { recursive: true })
  if (config) write(join(root, 'logseq', 'config.edn'), config)
  return root
}

const call = <T>(method: string, ...args: unknown[]): Promise<T> => {
  const fn = h.handlers.get(method)
  if (!fn) throw new Error(`没有注册的方法:${method}`)
  return Promise.resolve(fn(...args) as T)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询等待条件成立(真的 fs.watch + 250ms 防抖,只能等) */
async function waitFor(pred: () => boolean, ms = 2000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() < t0 + ms) {
    if (pred()) return true
    await sleep(50)
  }
  return pred()
}

/** `graph-changed` 广播里的路径(判回声只看它) */
function graphChangedPaths(): string[] {
  return h.pluginEvents
    .filter((e) => e.event === 'graph-changed')
    .flatMap((e) => ((e.args as { paths?: string[] } | undefined)?.paths ?? []).map((p) => p))
}

beforeEach(async () => {
  h = harness()
  graph = makeGraph(['{:meta/version 1',
    ' :default-templates {:journals "Daily"}',
    ' :journal/file-name-format "yyyy-MM-dd"}'].join('\n'))
  write(join(graph, 'templates', 'Daily.md'), '- <%date%> 的日记\n  - 今天要做的\n')
  write(join(graph, 'journals', '2026-09-19.md'), '- 昨天写了 [[cardinality]]\n')
  write(join(graph, 'pages', 'cardinality.md'), 'title:: Cardinality\n- 估行数\n')
  await logseq.activate(h as unknown as PluginContext)
  const opened = await call<{ ok: boolean }>('setGraph', graph)
  expect(opened.ok).toBe(true)
})

afterEach(() => {
  logseq.deactivate?.(h as unknown as PluginContext)
  rmSync(graph, { recursive: true, force: true })
  dialogMock.showOpenDialog.mockReset()
})

describe('图目录', () => {
  it('读 config.edn(目录名、文件名格式、默认模板)', async () => {
    const state = await call<GraphState>('getState')
    expect(state.ok).toBe(true)
    expect(state.graphPath).toBe(graph)
    expect(state.config.defaultJournalTemplate).toBe('Daily')
    expect(state.config.fileFormat).toBe('yyyy-MM-dd')
    expect(state.dateFormat).toEqual({ format: 'yyyy-MM-dd', ok: true, unsupported: null })
    expect(state.template.available).toEqual(['Daily'])
  })

  it('不是图目录时拒绝,并说清为什么', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'bow-plain-'))
    try {
      const res = await call<{ ok: boolean; error?: string }>('setGraph', plain)
      expect(res.ok).toBe(false)
      expect(res.error).toContain('不是 Logseq 图目录')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('DB 图(logseq/db.sqlite)明确拒绝', async () => {
    const dbGraph = makeGraph()
    write(join(dbGraph, 'logseq', 'db.sqlite'), 'not really sqlite')
    try {
      const res = await call<{ ok: boolean; error?: string }>('setGraph', dbGraph)
      expect(res.ok).toBe(false)
      expect(res.error).toContain('DB 图')
    } finally {
      rmSync(dbGraph, { recursive: true, force: true })
    }
  })

  it('最近图:切走的图进列表', async () => {
    const other = makeGraph()
    write(join(other, 'journals', '2026-09-20.md'), '- x\n')
    try {
      await call('setGraph', other)
      const state = await call<GraphState>('getState')
      expect(state.graphPath).toBe(other)
      expect(state.recentGraphs).toContain(graph)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('读', () => {
  it('日志文件名按 config.edn 的格式串走', async () => {
    const res = await call<FileRead>('readJournal', '2026-09-19')
    expect(res.exists).toBe(true)
    expect(res.rel).toBe('journals/2026-09-19.md')
    expect(res.raw).toBe('- 昨天写了 [[cardinality]]\n')
    expect(res.title).toBe('2026-09-19')
  })

  it('文件还不存在时用日志模板渲染,但**不落盘**', async () => {
    const res = await call<FileRead>('readJournal', '2026-09-20')
    expect(res.exists).toBe(false)
    expect(res.fromTemplate).toBe('Daily')
    expect(res.raw).toContain('2026-09-20 的日记')
    expect(readdirSync(join(graph, 'journals')).sort()).toEqual(['2026-09-19.md'])
  })

  it('没配模板的新日志是空内容,也不落盘', async () => {
    const noTemplate = makeGraph('{:meta/version 1}')
    try {
      await call('setGraph', noTemplate)
      const res = await call<FileRead>('readJournal', '2026-09-20')
      expect(res.exists).toBe(false)
      expect(res.raw).toBe('')
      expect(res.fromTemplate).toBeUndefined()
      expect(readdirSync(join(noTemplate, 'journals'))).toEqual([])
    } finally {
      rmSync(noTemplate, { recursive: true, force: true })
    }
  })

  it('页面:已有页面走索引,标题取 title::;不存在的页面给出待建路径', async () => {
    const existing = await call<FileRead>('readPage', 'cardinality')
    expect(existing.exists).toBe(true)
    expect(existing.title).toBe('Cardinality')
    expect(existing.rel).toBe('pages/cardinality.md')

    const fresh = await call<FileRead>('readPage', '数据库/设计')
    expect(fresh.exists).toBe(false)
    expect(fresh.rel).toBe('pages/数据库___设计.md')
    expect(fresh.raw).toBe('')
  })

  it('文件名表达不了标题时,新页面带 title:: 头部', async () => {
    const long = 'x'.repeat(200)
    const fresh = await call<FileRead>('readPage', long)
    expect(fresh.exists).toBe(false)
    expect(fresh.raw.startsWith(`title:: ${long}`)).toBe(true)
  })

  it('`[[2026-09-19]]` 这类链接指向日志', async () => {
    const res = await call<FileRead>('readPage', '2026-09-19')
    expect(res.view).toEqual({ kind: 'journal', day: '2026-09-19' })
    expect(res.exists).toBe(true)
  })
})

describe('写', () => {
  it('保存后文件真的变了,且不留下 .tmp', async () => {
    const before = await call<FileRead>('readJournal', '2026-09-19')
    const res = await call<SaveResult>('savePage', {
      path: before.path,
      raw: '- 改了 [[cardinality]]\n',
      baseMtimeMs: before.mtimeMs
    })
    expect(res.ok).toBe(true)
    expect(readFileSync(before.path, 'utf8')).toBe('- 改了 [[cardinality]]\n')
    expect(readdirSync(join(graph, 'journals')).filter((n) => n.includes('.tmp'))).toEqual([])

    const after = await call<FileRead>('readJournal', '2026-09-19')
    expect(after.raw).toBe('- 改了 [[cardinality]]\n')
    expect(after.mtimeMs).toBe(res.mtimeMs)
  })

  it('第一次编辑才创建新文件(模板内容写进去)', async () => {
    const fresh = await call<FileRead>('readJournal', '2026-09-20')
    const saved = await call<SaveResult>('savePage', { path: fresh.path, raw: fresh.raw, baseMtimeMs: null })
    expect(saved.ok).toBe(true)
    expect(readFileSync(join(graph, 'journals', '2026-09-20.md'), 'utf8')).toContain('2026-09-20 的日记')
  })

  it('mtime 变了就报冲突并回磁盘内容,**绝不覆盖**', async () => {
    const before = await call<FileRead>('readJournal', '2026-09-19')
    // 模拟 Logseq 在中间改了同一个文件。mtime 必须**显式拨老**到 base 之后:
    // tmpfs 这类粗粒度时间戳下,「读 → 立刻写」两次可能落在同一个 tick,而产品侧的冲突判据
    // 容忍 ±1ms 的文件系统舍入 ⇒ 靠时间自然流逝会偶发不成立(WSL 的 /tmp 上约 1/8 概率)。
    write(before.path, '- Logseq 写的内容 [[x]]\n')
    const changedAt = new Date((before.mtimeMs ?? Date.now()) + 2000)
    utimesSync(before.path, changedAt, changedAt)
    const res = await call<SaveResult>('savePage', {
      path: before.path,
      raw: '- 我在 bow 里写的内容\n',
      baseMtimeMs: before.mtimeMs
    })
    expect(res.ok).toBe(false)
    expect(res.conflict).toBe(true)
    expect(res.diskRaw).toBe('- Logseq 写的内容 [[x]]\n')
    expect(readFileSync(before.path, 'utf8')).toBe('- Logseq 写的内容 [[x]]\n')
  })

  it('强行覆盖(baseMtimeMs=null)可以写下去', async () => {
    const before = await call<FileRead>('readJournal', '2026-09-19')
    write(before.path, '- 别人写的\n')
    const res = await call<SaveResult>('savePage', { path: before.path, raw: '- 我覆盖的\n', baseMtimeMs: null })
    expect(res.ok).toBe(true)
    expect(readFileSync(before.path, 'utf8')).toBe('- 我覆盖的\n')
  })

  it('越界路径被拒绝(图外 / 只写 journals、pages / 只写 .md)', async () => {
    const cases: Array<{ path: string; match: string }> = [
      { path: join(graph, '..', 'evil.md'), match: '不在图目录内' },
      { path: join(graph, 'logseq', 'config.edn'), match: '只允许写' },
      { path: join(graph, 'journals', 'a.txt'), match: '只允许写 .md' }
    ]
    for (const item of cases) {
      const res = await call<SaveResult>('savePage', { path: item.path, raw: 'x', baseMtimeMs: null })
      expect(res.ok, item.path).toBe(false)
      expect(res.error, item.path).toContain(item.match)
    }
    expect(readFileSync(join(graph, 'logseq', 'config.edn'), 'utf8')).toContain('default-templates')
  })

  it('保存会顺手更新索引(反链立刻能看到)', async () => {
    await call<GraphState>('getState')
    const journal = await call<FileRead>('readJournal', '2026-09-19')
    await call<SaveResult>('savePage', {
      path: journal.path,
      raw: '- 今天推了 [[数据库]]\n',
      baseMtimeMs: journal.mtimeMs
    })
    const links = await call<{ total: number }>('backlinks', '数据库')
    expect(links.total).toBe(1)
  })
})

describe('fs.watch 回声(自己写的文件不能让页面重载)', () => {
  // 这一组钉的是 2026-09-20 那个「每次自动保存后编辑器退出、焦点丢」的根因:
  // 自家写入的 watcher 通知被当成「外部改动」广播出去 ⇒ 页面静默重载 ⇒ editingKey 被清。
  // 真的 fs.watch + 250ms 防抖,只能等(产品侧的 WATCH_DEBOUNCE_MS 就写死在 main.ts 里)。
  const ECHO_WAIT_MS = 900

  it('写已存在的日志:不广播 graph-changed', async () => {
    const before = await call<FileRead>('readJournal', '2026-09-19')
    h.pluginEvents.length = 0
    const res = await call<SaveResult>('savePage', {
      path: before.path,
      raw: '- 回声探针\n',
      baseMtimeMs: before.mtimeMs
    })
    expect(res.ok).toBe(true)
    await sleep(ECHO_WAIT_MS)
    expect(graphChangedPaths()).toEqual([])
  })

  it('第一次保存(新建文件,会经过 .tmp 兄弟路径):也不广播', async () => {
    const fresh = await call<FileRead>('readJournal', '2026-09-20')
    h.pluginEvents.length = 0
    const res = await call<SaveResult>('savePage', { path: fresh.path, raw: fresh.raw, baseMtimeMs: null })
    expect(res.ok).toBe(true)
    await sleep(ECHO_WAIT_MS)
    expect(graphChangedPaths()).toEqual([])
  })

  it('对照组:外部改同一文件仍然广播(自动重载通路没被误杀)', async () => {
    const before = await call<FileRead>('readJournal', '2026-09-19')
    h.pluginEvents.length = 0
    write(before.path, '- 外部脚本改的\n')
    expect(await waitFor(() => graphChangedPaths().includes('journals/2026-09-19.md'))).toBe(true)
  })

  it('对照组:外部改 pages/ 下的文件也要广播', async () => {
    const before = await call<FileRead>('readPage', 'cardinality')
    h.pluginEvents.length = 0
    write(before.path, 'title:: Cardinality\n- 外部改的\n')
    expect(await waitFor(() => graphChangedPaths().includes('pages/cardinality.md'), 2500)).toBe(true)
  })

  it('对照组:自己写完 4s 后外部写回**相同内容**,仍要广播(过期记录不能永久吞声)', async () => {
    const before = await call<FileRead>('readJournal', '2026-09-19')
    await call<SaveResult>('savePage', { path: before.path, raw: '- 我写的\n', baseMtimeMs: before.mtimeMs })
    h.pluginEvents.length = 0
    await sleep(4000)
    write(before.path, '- 我写的\n')
    expect(await waitFor(() => graphChangedPaths().includes('journals/2026-09-19.md'), 2500)).toBe(true)
  })

  it('对照组:自己写完 1s 后别人再改,仍要广播(不靠时间窗吞)', async () => {
    const before = await call<FileRead>('readJournal', '2026-09-19')
    await call<SaveResult>('savePage', { path: before.path, raw: '- 我写的\n', baseMtimeMs: before.mtimeMs })
    h.pluginEvents.length = 0
    await sleep(1000)
    write(before.path, '- 别人在我之后改的\n')
    expect(await waitFor(() => graphChangedPaths().includes('journals/2026-09-19.md'))).toBe(true)
  })
})

describe('索引查询与视图状态', () => {
  it('反链统计跨文件与标签', async () => {
    await call<GraphState>('getState')
    expect((await call<{ total: number }>('backlinks', 'cardinality')).total).toBe(1)
    expect((await call<{ total: number }>('backlinks', 'Cardinality')).total).toBe(1)
    expect((await call<{ total: number }>('backlinks', '没有的页')).total).toBe(0)
  })

  it('页面搜索与日志列表', async () => {
    await call<GraphState>('getState')
    expect((await call<Array<{ name: string }>>('listPages', 'card')).map((h) => h.name)).toEqual(['Cardinality'])
    const journals = await call<{ days: string[] }>('listJournals')
    expect(journals.days).toContain('2026-09-19')
  })

  it('索引统计进 getState', async () => {
    const state = await call<GraphState>('getState')
    expect(state.index?.files).toBe(2)
    expect(state.index?.days).toBe(1)
    expect(state.index?.tooLarge).toBe(false)
  })

  it('视图按 tabId 绑定,标签关了就回默认', async () => {
    const first = await call<{ view: unknown }>('attach', 7)
    expect(first.view).toEqual({ kind: 'journal', day: expect.any(String) })
    await call('setView', 7, { kind: 'page', name: 'cardinality' })
    expect((await call<{ view: unknown }>('attach', 7)).view).toEqual({ kind: 'page', name: 'cardinality' })
    // 刷新(同一个 tabId 再 attach)仍回到同一页
    expect((await call<{ view: unknown }>('attach', 7)).view).toEqual({ kind: 'page', name: 'cardinality' })
    h.emitEvent('tab:closed', { id: 7 })
    expect((await call<{ view: unknown }>('attach', 7)).view).toMatchObject({ kind: 'journal' })
  })

  it('openInNewPane:下一个新标签打开指定页', async () => {
    await call('openInNewPane', 'cardinality')
    expect((await call<{ view: unknown }>('attach', 8)).view).toEqual({ kind: 'page', name: 'cardinality' })
    // 用过一次就清掉,不会污染下一个标签
    expect((await call<{ view: unknown }>('attach', 9)).view).toMatchObject({ kind: 'journal' })
  })

  it('坏的视图状态回落到今天', async () => {
    await call('setView', 11, { kind: 'page', name: '   ' })
    expect((await call<{ view: unknown }>('attach', 11)).view).toMatchObject({ kind: 'journal' })
  })
})
