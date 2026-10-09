/**
 * 文件管理插件主进程侧的接线用例:**真的在一个临时目录里读写**。
 *
 * 这一组刻意用真实文件系统(不是假 IO):要钉住的正是「碰盘」这件事本身 ——
 * 白名单外的路径真被拒、写文件真不覆盖、原子写不留 `.tmp-*`、回收站删除真的走 `shell.trashItem`
 * 而不是 `rm`。纯路径策略另有 `tests/fileRoots.test.ts`,纯逻辑另有 `tests/filesShared.test.ts`。
 *
 * 注意白名单的**唯一来源是磁盘上的 `files-settings.json`**(核心的 `fileRoots.ts` 每次现读),
 * 所以这里的假 storage 也必须写盘 —— 否则测出来的是假象。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpToolResult, PluginContext } from '../src/main/plugins/types'

const env = vi.hoisted(() => ({
  userData: '',
  downloads: '',
  trashed: [] as string[],
  opened: [] as string[],
  revealed: [] as string[],
  pickResult: { canceled: true, filePaths: [] as string[] }
}))

vi.mock('electron', () => ({
  app: { getPath: (key: string) => (key === 'userData' ? env.userData : env.downloads) },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => env.pickResult },
  shell: {
    trashItem: async (path: string) => {
      env.trashed.push(path)
    },
    openPath: async (path: string) => {
      env.opened.push(path)
      return ''
    },
    showItemInFolder: (path: string) => {
      env.revealed.push(path)
    }
  }
}))

const { default: files } = await import('../src/plugins/files/main')
const { FILES_EVENT } = await import('../src/plugins/files/shared')

interface Harness {
  handlers: Map<string, (...args: any[]) => unknown>
  tools: Array<{ name: string; handler: (args: Record<string, unknown>) => Promise<McpToolResult> }>
  pluginEvents: Array<{ event: string; args: unknown }>
}

function harness(): Harness {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const state: Harness = { handlers, tools: [], pluginEvents: [] }
  const storage = <T,>(opts: { file: string; defaults: T }) => {
    const file = join(env.userData, opts.file)
    let value: T = opts.defaults
    try {
      // 与真 JsonStore 一致的「浅合并默认值」
      value = { ...opts.defaults, ...(JSON.parse(readFileSync(file, 'utf-8')) as T) }
    } catch {
      // 文件不存在 / 坏 JSON:用默认值
    }
    const persist = (next: T): T => {
      value = next
      writeFileSync(file, JSON.stringify(next), 'utf-8')
      return next
    }
    return {
      get: () => value,
      set: (patch: Partial<T>) => persist({ ...value, ...patch }),
      setRaw: (next: T) => persist(next)
    }
  }
  const ctx = {
    id: 'files',
    log: () => {},
    logError: () => {},
    storage,
    ipc: {
      handle: (method: string, fn: (...args: any[]) => unknown) => handlers.set(method, fn),
      emit: (event: string, args?: unknown) => state.pluginEvents.push({ event, args })
    },
    events: { on: () => {}, emit: () => {} },
    suggest: { register: () => {} },
    mcp: {
      tool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<McpToolResult>) => {
        state.tools.push({ name, handler })
      }
    },
    net: { onBeforeRequest: () => {}, onBeforeSendHeaders: () => {}, onHeadersReceived: () => {} },
    content: { inject: () => {}, refresh: () => {} },
    pages: { activeTabId: () => null, focus: () => {}, execute: async () => ({}), openDevToolsTab: () => 0 },
    tabs: { list: () => [], getActive: () => null },
    shortcuts: { register: () => {} }
  }
  return Object.assign(state, ctx) as unknown as Harness
}

let h: Harness
let base = ''
let root = ''
let outside = ''

const at = (...parts: string[]): string => join(root, ...parts)

/** 调一个 MCP 工具,并把 `{ok:...}` 返回体解析出来 */
async function run(
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ data: Record<string, any>; isError: boolean }> {
  const tool = h.tools.find((t) => t.name === name)
  if (!tool) throw new Error(`没有工具:${name}`)
  const res = await tool.handler(args)
  const first = res.content[0] as { type: 'text'; text: string }
  return { data: JSON.parse(first.text) as Record<string, any>, isError: res.isError === true }
}

const call = <T,>(method: string, ...args: unknown[]): Promise<T> => {
  const fn = h.handlers.get(method)
  if (!fn) throw new Error(`没有注册的方法:${method}`)
  return Promise.resolve(fn(...args) as T)
}

function writeSettings(roots: string[], extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(env.userData, 'files-settings.json'),
    JSON.stringify({ version: 1, roots, allowPermanentDelete: false, listLimit: 200, ...extra }),
    'utf-8'
  )
}

/** 留在目录里的 `.tmp-*`(原子写不许留下它) */
function tmpLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.tmp-'))
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'bow-files-')))
  env.userData = join(base, 'userdata')
  env.downloads = join(base, 'downloads')
  root = join(base, 'work')
  outside = join(base, 'outside')
  for (const dir of [env.userData, env.downloads, root, outside]) mkdirSync(dir, { recursive: true })
  env.trashed.length = 0
  env.opened.length = 0
  env.revealed.length = 0
  env.pickResult = { canceled: true, filePaths: [] }
  writeSettings([root])
  h = harness()
  files.activate(h as unknown as PluginContext)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('插件契约', () => {
  it('id / capabilities / 工具集合', () => {
    expect(files.manifest.id).toBe('files')
    expect(files.capabilities).toEqual(['ui', 'mcp'])
    expect(h.tools.map((t) => t.name).sort()).toEqual(
      [
        'browser_fs_copy',
        'browser_fs_delete',
        'browser_fs_info',
        'browser_fs_list',
        'browser_fs_mkdir',
        'browser_fs_move',
        'browser_fs_read',
        'browser_fs_roots',
        'browser_fs_write'
      ].sort()
    )
  })
})

describe('browser_fs_roots', () => {
  it('列出生效的工作目录:你配的 + **永远带着的下载目录**', async () => {
    const { data } = await run('browser_fs_roots')
    expect(data.ok).toBe(true)
    expect(data.roots).toEqual([
      { path: root, isDefault: false, exists: true },
      { path: env.downloads, isDefault: true, exists: true }
    ])
    expect(data.downloadsDir).toBe(env.downloads)
    expect(data.allowPermanentDelete).toBe(false)
  })

  it('没配工作目录时只剩下载目录那一条', async () => {
    writeSettings([])
    h = harness()
    files.activate(h as unknown as PluginContext)
    const { data } = await run('browser_fs_roots')
    expect(data.roots).toEqual([{ path: env.downloads, isDefault: true, exists: true }])
  })

  it('报的是**守卫真正放行的**那份:磁盘上的设置被外部改过也如实反映', async () => {
    // 内存里的 store 还是老值(harness 不会再读一次盘),guard 却读盘
    writeSettings([outside])
    const { data } = await run('browser_fs_roots')
    expect(data.roots).toEqual([
      { path: outside, isDefault: false, exists: true },
      { path: env.downloads, isDefault: true, exists: true }
    ])
    expect((await run('browser_fs_write', { path: join(outside, 'live.txt'), content: 'x' })).data.ok).toBe(true)
  })
})

describe('browser_fs_write', () => {
  it('写新文件:真的落盘,且不留 .tmp-*', async () => {
    const { data } = await run('browser_fs_write', { path: at('a.txt'), content: 'hello' })
    expect(data).toMatchObject({ ok: true, path: at('a.txt'), overwrote: false })
    expect(readFileSync(at('a.txt'), 'utf-8')).toBe('hello')
    expect(tmpLeftovers(root)).toEqual([])
  })

  it('目标已存在且没传 overwrite → 拒绝,且**原内容不变**', async () => {
    writeFileSync(at('a.txt'), '旧内容', 'utf-8')
    const { data, isError } = await run('browser_fs_write', { path: at('a.txt'), content: '新内容' })
    expect(isError).toBe(true)
    expect(data.ok).toBe(false)
    expect(data.error).toContain('拒绝覆盖')
    expect(readFileSync(at('a.txt'), 'utf-8')).toBe('旧内容')
    expect(tmpLeftovers(root)).toEqual([])
  })

  it('overwrite:true 才覆盖,并回报 overwrote', async () => {
    writeFileSync(at('a.txt'), '旧内容', 'utf-8')
    const { data } = await run('browser_fs_write', { path: at('a.txt'), content: '新内容', overwrite: true })
    expect(data).toMatchObject({ ok: true, overwrote: true })
    expect(readFileSync(at('a.txt'), 'utf-8')).toBe('新内容')
  })

  it('content 不是字符串 → 拒绝(插件工具 schema 不做 strict 校验,这里必须自己判)', async () => {
    const { data } = await run('browser_fs_write', { path: at('a.txt'), content: 42 })
    expect(data.ok).toBe(false)
    expect(data.error).toContain('content')
    expect(existsSync(at('a.txt'))).toBe(false)
  })

  it('父目录默认自动创建;createDirs:false 时明确报错', async () => {
    const missing = at('deep', 'x.txt')
    const denied = await run('browser_fs_write', { path: missing, content: 'x', createDirs: false })
    expect(denied.data.ok).toBe(false)
    expect(denied.data.error).toContain('父目录不存在')

    const created = await run('browser_fs_write', { path: missing, content: 'x' })
    expect(created.data.ok).toBe(true)
    expect(readFileSync(missing, 'utf-8')).toBe('x')
  })

  it('白名单外、bow 数据目录、目标是非空目录 → 全拒', async () => {
    const outsideRes = await run('browser_fs_write', { path: join(outside, 'x.txt'), content: 'x' })
    expect(outsideRes.data.ok).toBe(false)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)

    const denyd = await run('browser_fs_write', { path: join(env.userData, 'files-settings.json'), content: '{}' })
    expect(denyd.data.ok).toBe(false)
    expect(denyd.data.error).toContain('数据目录')

    mkdirSync(at('adir'))
    const dirRes = await run('browser_fs_write', { path: at('adir'), content: 'x' })
    expect(dirRes.data.ok).toBe(false)
    expect(dirRes.data.error).toContain('目录')
  })
})

describe('browser_fs_read', () => {
  it('读回文本;超长按 maxBytes 截断并标记 truncated', async () => {
    writeFileSync(at('a.txt'), '一二三四五', 'utf-8')
    const full = await run('browser_fs_read', { path: at('a.txt') })
    expect(full.data).toMatchObject({ ok: true, text: '一二三四五', truncated: false, size: 15 })

    const cut = await run('browser_fs_read', { path: at('a.txt'), maxBytes: 4 })
    expect(cut.data.truncated).toBe(true)
    // 4 字节切在「一」之后,不能切出半个字
    expect(cut.data.text).toBe('一')
  })

  it('含 NUL 的二进制文件被拒(不给一堆乱码)', async () => {
    writeFileSync(at('bin.dat'), Buffer.from([1, 0, 2, 3]))
    const { data } = await run('browser_fs_read', { path: at('bin.dat') })
    expect(data.ok).toBe(false)
    expect(data.error).toContain('二进制')
  })

  it('目录、白名单外一律拒', async () => {
    mkdirSync(at('adir'))
    expect((await run('browser_fs_read', { path: at('adir') })).data.ok).toBe(false)
    writeFileSync(join(outside, 'x.txt'), 'x', 'utf-8')
    expect((await run('browser_fs_read', { path: join(outside, 'x.txt') })).data.ok).toBe(false)
  })
})

describe('browser_fs_list', () => {
  beforeEach(() => {
    mkdirSync(at('sub', 'deep'), { recursive: true })
    writeFileSync(at('a.md'), 'a', 'utf-8')
    writeFileSync(at('b.txt'), 'b', 'utf-8')
    writeFileSync(at('.hidden'), 'h', 'utf-8')
    writeFileSync(at('sub', 'c.md'), 'c', 'utf-8')
    writeFileSync(at('sub', 'deep', 'd.md'), 'd', 'utf-8')
  })

  it('目录在前、隐藏项默认不列', async () => {
    const { data } = await run('browser_fs_list', { path: root })
    expect(data.count).toBe(3)
    expect(data.entries.map((e: any) => e.name)).toEqual(['sub', 'a.md', 'b.txt'])
    expect(data.entries[0]).toMatchObject({ type: 'dir', path: at('sub') })
  })

  it('showHidden:true 才列点号项', async () => {
    const { data } = await run('browser_fs_list', { path: root, showHidden: true })
    expect(data.entries.map((e: any) => e.name)).toContain('.hidden')
  })

  it('glob 是对相对路径过滤;recursive 才递归(深度上限 8)', async () => {
    const flat = await run('browser_fs_list', { path: root, glob: '**/*.md' })
    expect(flat.data.entries.map((e: any) => e.name)).toEqual(['a.md'])

    const deep = await run('browser_fs_list', { path: root, glob: '**/*.md', recursive: true })
    expect(deep.data.entries.map((e: any) => e.name).sort()).toEqual(['a.md', 'c.md', 'd.md'])
  })

  it('命中上限会截断并标记 truncated', async () => {
    const { data } = await run('browser_fs_list', { path: root, recursive: true, limit: 2 })
    expect(data.truncated).toBe(true)
    expect(data.entries).toHaveLength(2)
  })

  it('省略 path 用第一个工作目录;指文件 / 白名单外都报错', async () => {
    const { data } = await run('browser_fs_list')
    expect(data.path).toBe(root)
    expect((await run('browser_fs_list', { path: at('a.md') })).data.ok).toBe(false)
    expect((await run('browser_fs_list', { path: outside })).data.ok).toBe(false)
  })

  it('不跟随符号链接(不会借着链接递归出去)', async () => {
    const { symlinkSync } = await import('node:fs')
    try {
      symlinkSync(outside, at('escape'), 'dir')
    } catch {
      return // 平台不允许建链接:跳过
    }
    const { data } = await run('browser_fs_list', { path: root, recursive: true })
    const escape = data.entries.find((e: any) => e.name === 'escape')
    expect(escape.type).toBe('symlink')
    expect(data.entries.some((e: any) => e.path.startsWith(outside))).toBe(false)
  })
})

describe('browser_fs_info', () => {
  it('存在的文件 / 不存在的路径 / 白名单外', async () => {
    writeFileSync(at('a.txt'), 'hello', 'utf-8')
    const any = await run('browser_fs_info', { path: at('a.txt') })
    expect(any.data).toMatchObject({ ok: true, exists: true, type: 'file', size: 5, isRoot: false })

    const missing = await run('browser_fs_info', { path: at('nope.txt') })
    expect(missing.data).toMatchObject({ ok: true, exists: false })
    expect(missing.isError).toBe(false)

    expect((await run('browser_fs_info', { path: join(outside, 'x') })).data.ok).toBe(false)
  })

  it('指向工作目录本身时 isRoot 为 true(呼应用户/LLM 看到护栏)', async () => {
    const { data } = await run('browser_fs_info', { path: root })
    expect(data).toMatchObject({ ok: true, type: 'dir', isRoot: true })
  })
})

describe('browser_fs_mkdir', () => {
  it('递归创建;已存在算成功但 created:false', async () => {
    const first = await run('browser_fs_mkdir', { path: at('x', 'y') })
    expect(first.data).toMatchObject({ ok: true, created: true })
    const again = await run('browser_fs_mkdir', { path: at('x', 'y') })
    expect(again.data).toMatchObject({ ok: true, created: false })

    writeFileSync(at('f.txt'), 'f', 'utf-8')
    const clash = await run('browser_fs_mkdir', { path: at('f.txt') })
    expect(clash.data.ok).toBe(false)
  })
})

describe('browser_fs_move / browser_fs_copy', () => {
  it('move 就是重命名;目标已存在要 overwrite', async () => {
    writeFileSync(at('a.txt'), 'a', 'utf-8')
    const moved = await run('browser_fs_move', { from: at('a.txt'), to: at('b.txt') })
    expect(moved.data).toMatchObject({ ok: true, path: at('b.txt') })
    expect(existsSync(at('a.txt'))).toBe(false)
    expect(existsSync(at('b.txt'))).toBe(true)

    writeFileSync(at('c.txt'), 'c', 'utf-8')
    const clash = await run('browser_fs_move', { from: at('c.txt'), to: at('b.txt') })
    expect(clash.data.ok).toBe(false)
    expect(clash.data.error).toContain('拒绝覆盖')
    expect(readFileSync(at('b.txt'), 'utf-8')).toBe('a')
  })

  it('to 是已存在的目录 → 放进去,返回最终落点', async () => {
    mkdirSync(at('dest'))
    writeFileSync(at('a.txt'), 'a', 'utf-8')
    const moved = await run('browser_fs_move', { from: at('a.txt'), to: at('dest') })
    expect(moved.data).toMatchObject({ ok: true, path: at('dest', 'a.txt'), intoDir: true })
    expect(existsSync(at('dest', 'a.txt'))).toBe(true)
  })

  it('工作目录本身不能被移走;源与目标相同要拒', async () => {
    const rootMove = await run('browser_fs_move', { from: root, to: at('sub') })
    expect(rootMove.data.ok).toBe(false)
    expect(rootMove.data.error).toContain('工作目录本身')

    writeFileSync(at('a.txt'), 'a', 'utf-8')
    const same = await run('browser_fs_move', { from: at('a.txt'), to: at('a.txt') })
    expect(same.data.ok).toBe(false)
  })

  it('白名单外(源或目标)一律拒', async () => {
    writeFileSync(join(outside, 'x.txt'), 'x', 'utf-8')
    expect((await run('browser_fs_move', { from: join(outside, 'x.txt'), to: at('x.txt') })).data.ok).toBe(false)
    writeFileSync(at('a.txt'), 'a', 'utf-8')
    expect((await run('browser_fs_move', { from: at('a.txt'), to: join(outside, 'a.txt') })).data.ok).toBe(false)
    expect((await run('browser_fs_move', { from: at('a.txt'), to: join(env.userData, 'a.txt') })).data.ok).toBe(false)
  })

  it('目录不许搬进自己里面', async () => {
    mkdirSync(at('sub'), { recursive: true })
    const res = await run('browser_fs_move', { from: at('sub'), to: at('sub', 'inner') })
    expect(res.data.ok).toBe(false)
  })

  it('copy:目录要 recursive:true,文件不用', async () => {
    mkdirSync(at('sub', 'deep'), { recursive: true })
    writeFileSync(at('sub', 'a.txt'), 'a', 'utf-8')

    const noRec = await run('browser_fs_copy', { from: at('sub'), to: at('sub2') })
    expect(noRec.data.ok).toBe(false)
    expect(noRec.data.error).toContain('recursive')

    const rec = await run('browser_fs_copy', { from: at('sub'), to: at('sub2'), recursive: true })
    expect(rec.data.ok).toBe(true)
    expect(readFileSync(at('sub2', 'a.txt'), 'utf-8')).toBe('a')
    expect(existsSync(at('sub2', 'deep'))).toBe(true)

    const file = await run('browser_fs_copy', { from: at('sub', 'a.txt'), to: at('copy.txt') })
    expect(file.data.ok).toBe(true)
    expect(existsSync(at('sub', 'a.txt'))).toBe(true)
  })
})

describe('browser_fs_delete', () => {
  it('默认走系统回收站(不是 rm),文件还在磁盘上', async () => {
    writeFileSync(at('a.txt'), 'a', 'utf-8')
    const { data } = await run('browser_fs_delete', { path: at('a.txt') })
    expect(data).toMatchObject({ ok: true, permanent: false, trashed: true })
    expect(env.trashed).toEqual([at('a.txt')])
    expect(existsSync(at('a.txt'))).toBe(true)
  })

  it('删目录要 recursive:true', async () => {
    mkdirSync(at('sub'))
    const noRec = await run('browser_fs_delete', { path: at('sub') })
    expect(noRec.data.ok).toBe(false)
    expect(noRec.data.error).toContain('recursive')
    expect(env.trashed).toEqual([])

    const rec = await run('browser_fs_delete', { path: at('sub'), recursive: true })
    expect(rec.data.ok).toBe(true)
    expect(env.trashed).toEqual([at('sub')])
  })

  it('permanent:true 在开关关着时被拒(且没有真的删)', async () => {
    writeFileSync(at('a.txt'), 'a', 'utf-8')
    const { data } = await run('browser_fs_delete', { path: at('a.txt'), permanent: true })
    expect(data.ok).toBe(false)
    expect(data.error).toContain('永久删除')
    expect(existsSync(at('a.txt'))).toBe(true)
    expect(env.trashed).toEqual([])
  })

  it('开关打开后 permanent:true 真的删掉', async () => {
    writeSettings([root], { allowPermanentDelete: true })
    h = harness()
    files.activate(h as unknown as PluginContext)
    writeFileSync(at('a.txt'), 'a', 'utf-8')
    const { data } = await run('browser_fs_delete', { path: at('a.txt'), permanent: true })
    expect(data).toMatchObject({ ok: true, permanent: true })
    expect(existsSync(at('a.txt'))).toBe(false)
    expect(env.trashed).toEqual([])
  })

  it('工作目录本身不许删;白名单外不许删;import bow 数据目录不许删', async () => {
    expect((await run('browser_fs_delete', { path: root, recursive: true })).data.ok).toBe(false)
    expect((await run('browser_fs_delete', { path: outside, recursive: true })).data.ok).toBe(false)
    expect((await run('browser_fs_delete', { path: join(env.userData, 'x.json') })).data.error).toContain('数据目录')
    expect(env.trashed).toEqual([])
  })
})

describe('设置 IPC', () => {
  it('getSettings 返回生效状态与 deny 名单', async () => {
    const state = await call<{ roots: Array<{ path: string; isDefault: boolean }>; denyList: string[] }>('getSettings')
    expect(state.roots).toEqual([
      { path: root, isDefault: false, exists: true },
      { path: env.downloads, isDefault: true, exists: true }
    ])
    expect(state.denyList).toEqual([env.userData])
  })

  it('下载目录不用配也能用(新增工作目录不会把它挤出去)', async () => {
    const written = await run('browser_fs_write', { path: join(env.downloads, 'dl.txt'), content: 'x' })
    expect(written.data.ok).toBe(true)
    expect(existsSync(join(env.downloads, 'dl.txt'))).toBe(true)
  })

  it('setSettings 改白名单立即生效(核心读的是磁盘那份),并广播 changed', async () => {
    const next = await call<{ settings: { roots: string[] } }>('setSettings', { roots: [root, outside] })
    expect(next.settings.roots).toEqual([root, outside])
    expect(h.pluginEvents.at(-1)?.event).toBe(FILES_EVENT.changed)
    expect((await run('browser_fs_write', { path: join(outside, 'ok.txt'), content: 'x' })).data.ok).toBe(true)
  })

  it('setSettings 里塞相对路径 / bow 数据目录会被丢掉', async () => {
    const next = await call<{ settings: { roots: string[] } }>('setSettings', {
      roots: ['relative/dir', env.userData, root]
    })
    expect(next.settings.roots).toEqual([root])
  })

  it('removeRoot 移除后只剩下载目录(那条标着默认)', async () => {
    const next = await call<{ roots: Array<{ path: string; isDefault: boolean }> }>('removeRoot', root)
    expect(next.roots).toEqual([{ path: env.downloads, isDefault: true, exists: true }])
    expect((await run('browser_fs_write', { path: at('x.txt'), content: 'x' })).data.ok).toBe(false)
  })

  it('pickRoots:用户取消啥也不改;选了 bow 数据目录会被拒并明确回报', async () => {
    const canceled = await call<{ canceled?: boolean; settings: { roots: string[] } }>('pickRoots')
    expect(canceled.canceled).toBe(true)
    expect(canceled.settings.roots).toEqual([root])

    env.pickResult = { canceled: false, filePaths: [env.userData, outside] }
    const picked = await call<{ rejected?: string[]; settings: { roots: string[] } }>('pickRoots')
    expect(picked.rejected).toEqual([env.userData])
    expect(picked.settings.roots).toEqual([root, outside])
  })

  it('openRoot 用 shell.openPath,白名单外拒绝', async () => {
    expect(await call<{ ok: boolean }>('openRoot', root)).toMatchObject({ ok: true })
    expect(env.opened).toEqual([root])
    const bad = await call<{ ok: boolean; error?: string }>('openRoot', outside)
    expect(bad.ok).toBe(false)
  })
})

describe('浏览面板的 IPC 面(与 MCP 工具共用同一套语义)', () => {
  it('list:列目录;白名单外被拒', async () => {
    writeFileSync(at('a.txt'), 'a', 'utf-8')
    mkdirSync(at('sub'))
    const listed = await call<{ ok: boolean; path: string; entries: Array<{ name: string; type: string }> }>(
      'list',
      root,
      { limit: 50 }
    )
    expect(listed.ok).toBe(true)
    expect(listed.path).toBe(root)
    expect(listed.entries.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:sub', 'file:a.txt'])

    const outsideRes = await call<{ ok: boolean; error?: string }>('list', outside, {})
    expect(outsideRes.ok).toBe(false)
  })

  it('readText:读文本;二进制与目录被拒', async () => {
    writeFileSync(at('a.txt'), '内容', 'utf-8')
    const text = await call<{ ok: boolean; text?: string }>('readText', at('a.txt'))
    expect(text).toMatchObject({ ok: true, text: '内容' })

    writeFileSync(at('bin.dat'), Buffer.from([0, 1, 2]))
    expect((await call<{ ok: boolean }>('readText', at('bin.dat'))).ok).toBe(false)
    mkdirSync(at('sub'))
    expect((await call<{ ok: boolean }>('readText', at('sub'))).ok).toBe(false)
  })

  it('mkdir / rename:重命名撞名或名字带分隔符都被拒', async () => {
    const made = await call<{ ok: boolean; created?: boolean }>('mkdir', at('新目录'))
    expect(made).toMatchObject({ ok: true, created: true })

    writeFileSync(at('a.txt'), 'a', 'utf-8')
    const renamed = await call<{ ok: boolean; path?: string }>('rename', at('a.txt'), 'b.txt')
    expect(renamed).toMatchObject({ ok: true, path: at('b.txt') })
    expect(existsSync(at('b.txt'))).toBe(true)

    writeFileSync(at('c.txt'), 'c', 'utf-8')
    const clash = await call<{ ok: boolean; error?: string }>('rename', at('c.txt'), 'b.txt')
    expect(clash.ok).toBe(false)
    expect(clash.error).toContain('拒绝覆盖')

    for (const bad of ['../x', 'a/b', 'a\\b', '', '  ', '.', '..']) {
      const res = await call<{ ok: boolean }>('rename', at('c.txt'), bad)
      expect(res.ok, `应拒绝名字:${JSON.stringify(bad)}`).toBe(false)
    }
    expect(existsSync(at('c.txt'))).toBe(true)
  })

  it('move / copy:目标是已存在的目录时放进去', async () => {
    mkdirSync(at('dest'))
    writeFileSync(at('a.txt'), 'a', 'utf-8')
    const moved = await call<{ ok: boolean; path?: string; intoDir?: boolean }>('move', at('a.txt'), at('dest'))
    expect(moved).toMatchObject({ ok: true, path: at('dest', 'a.txt'), intoDir: true })

    const copied = await call<{ ok: boolean; path?: string }>('copy', at('dest', 'a.txt'), at('copy.txt'))
    expect(copied).toMatchObject({ ok: true, path: at('copy.txt') })
    expect(existsSync(at('dest', 'a.txt'))).toBe(true)
    expect((await call<{ ok: boolean }>('move', root, at('dest'))).ok).toBe(false)
  })

  it('remove:批量删,一条越界不影响其余(逐条报)', async () => {
    writeFileSync(at('a.txt'), 'a', 'utf-8')
    writeFileSync(at('b.txt'), 'b', 'utf-8')
    writeFileSync(join(outside, 'c.txt'), 'c', 'utf-8')
    const result = await call<{ ok: boolean; deleted: string[]; failed: Array<{ path: string; error: string }> }>(
      'remove',
      [at('a.txt'), join(outside, 'c.txt'), at('b.txt')]
    )
    expect(result.deleted).toEqual([at('a.txt'), at('b.txt')])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.path).toBe(join(outside, 'c.txt'))
    expect(result.ok).toBe(false)
    expect(env.trashed).toEqual([at('a.txt'), at('b.txt')])
    expect(existsSync(join(outside, 'c.txt'))).toBe(true)
  })

  it('pickDirectory:取消 vs 选中;openPath / showInFolder 都过 guard', async () => {
    expect(await call<{ canceled?: boolean }>('pickDirectory', root)).toMatchObject({ canceled: true })

    env.pickResult = { canceled: false, filePaths: [at('dest')] }
    expect(await call<{ path?: string }>('pickDirectory', root)).toMatchObject({ path: at('dest') })

    writeFileSync(at('a.txt'), 'a', 'utf-8')
    expect(await call<{ ok: boolean }>('openPath', at('a.txt'))).toMatchObject({ ok: true })
    expect(env.opened).toEqual([at('a.txt')])
    expect(await call<{ ok: boolean }>('showInFolder', at('a.txt'))).toMatchObject({ ok: true })
    expect(env.revealed).toEqual([at('a.txt')])

    expect((await call<{ ok: boolean }>('openPath', join(outside, 'x'))).ok).toBe(false)
    expect((await call<{ ok: boolean }>('showInFolder', env.userData)).ok).toBe(false)
    expect(env.opened).toHaveLength(1)
  })
})
