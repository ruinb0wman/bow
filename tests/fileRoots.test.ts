/**
 * 路径策略(**护栏本体**)。
 *
 * 这一组钉的是「LLM 能不能跑出白名单」这件事,所以每条用例都对应一个真实的逃逸手法:
 * 前缀陷阱(`/a/bc` vs `/a/b`)、`..` 穿越、符号链接逃逸、bow 自己的数据目录、`\\?\` 前缀。
 *
 * 单测用**注入的假 IO**(`exists` / `realpath` 查表),不碰真磁盘 —— 这样才能构造出
 * 「工作目录里有个指向 /etc 的符号链接」这种场景。真读真写那一半在 `tests/filesPlugin.test.ts`。
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ userData: '', downloads: '' }))

vi.mock('electron', () => ({
  app: { getPath: (key: string) => (key === 'userData' ? env.userData : env.downloads) }
}))

const {
  checkPath,
  checkFilePath,
  fileRootsDenyList,
  isInside,
  isSamePath,
  readFilesSettingsRaw,
  realpathDeepest,
  resolveFileRoots,
  sanitizeRoots
} = await import('../src/main/plugins/fileRoots')
type GuardIo = import('../src/main/plugins/fileRoots').GuardIo

/** 假文件系统:路径 → 它的真实路径(符号链接在这一层就解析掉) */
function fakeIo(files: Record<string, string>): GuardIo {
  return {
    exists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    realpath: (path) => files[path] ?? path
  }
}

const io = fakeIo({
  '/': '/',
  '/root': '/root',
  '/root/a.txt': '/root/a.txt',
  '/root/sub': '/root/sub',
  '/root/sub/deep.txt': '/root/sub/deep.txt',
  '/root/bowdata': '/root/bowdata',
  // 工作目录里一个指向外部的符号链接:这是 resolve-only 校验会漏掉的那条路
  '/root/link': '/outside',
  '/root/linkdir': '/outside',
  '/outside': '/outside',
  '/outside/secret.txt': '/outside/secret.txt',
  '/etc': '/etc',
  '/etc/passwd': '/etc/passwd'
})

describe('isInside(包含判定)', () => {
  it('不能用 startsWith:`/a/bc` 不在 `/a/b` 里', () => {
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/root/a.txt', '/root/a.txt.bak')).toBe(false)
  })

  it('相等算在内(「不许删 root 本身」由调用方单独判)', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/root', '/root')).toBe(true)
  })

  it('真子路径在内,祖先不在内', () => {
    expect(isInside('/root', '/root/sub/deep.txt')).toBe(true)
    expect(isInside('/root/sub', '/root')).toBe(false)
  })
})

describe('isSamePath', () => {
  it('末尾斜杠不影响', () => {
    expect(isSamePath('/a/b', '/a/b/')).toBe(true)
    expect(isSamePath('/a/b', '/a/c')).toBe(false)
  })
})

describe('realpathDeepest(对最深的已存在祖先做 realpath)', () => {
  it('目标不存在时:向上找到存在的祖先再拼回去', () => {
    expect(realpathDeepest('/root/new.txt', io)).toBe('/root/new.txt')
    expect(realpathDeepest('/root/sub/none/here.txt', io)).toBe('/root/sub/none/here.txt')
  })

  it('路径上只要有符号链接就按真实路径返回', () => {
    expect(realpathDeepest('/root/link', io)).toBe('/outside')
    expect(realpathDeepest('/root/linkdir/new.txt', io)).toBe('/outside/new.txt')
  })

  it('一路都不存在时原样返回(不做无意义的解析)', () => {
    expect(realpathDeepest('/nope/deep', fakeIo({ '/': '/' }))).toBe('/nope/deep')
  })
})

describe('checkPath', () => {
  it('白名单内的文件与还不存在的新文件都放行,返回 realpath 之后的结果', () => {
    expect(checkPath('/root/a.txt', ['/root'], io)).toEqual({ ok: true, abs: '/root/a.txt' })
    expect(checkPath('/root/new.txt', ['/root'], io)).toEqual({ ok: true, abs: '/root/new.txt' })
    expect(checkPath('  /root/a.txt  ', ['/root'], io)).toEqual({ ok: true, abs: '/root/a.txt' })
  })

  it('白名单外一律拒绝(含前缀陷阱与 .. 穿越)', () => {
    expect(checkPath('/etc/passwd', ['/root'], io).ok).toBe(false)
    expect(checkPath('/root/../etc/passwd', ['/root'], io).ok).toBe(false)
    expect(checkPath('/root/sub/../../etc/passwd', ['/root'], io).ok).toBe(false)
  })

  it('符号链接逃逸被拦:目标本身是链接、链接指向的是深路径、链接在中间层', () => {
    expect(checkPath('/root/link', ['/root'], io).ok).toBe(false)
    expect(checkPath('/root/link/secret.txt', ['/root'], io).ok).toBe(false)
    expect(checkPath('/root/linkdir/new.txt', ['/root'], io).ok).toBe(false)
  })

  it('链接指向白名单内则放行(不是「见链接就拒」)', () => {
    const inner = fakeIo({ '/': '/', '/root': '/root', '/root/sub': '/root/sub', '/root/alias': '/root/sub' })
    expect(checkPath('/root/alias/x.txt', ['/root'], inner)).toEqual({ ok: true, abs: '/root/sub/x.txt' })
  })

  it('多个白名单:命中任意一个即可', () => {
    expect(checkPath('/etc/passwd', ['/root', '/etc'], io).ok).toBe(true)
  })

  it('deny 名单优先于白名单(哪怕 deny 目录在 root 里面)', () => {
    const denied = checkPath('/root/bowdata/x.json', ['/root'], io, ['/root/bowdata'])
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error).toContain('数据目录')
    // 同目录下别的地方不受影响
    expect(checkPath('/root/a.txt', ['/root'], io, ['/root/bowdata']).ok).toBe(true)
  })

  it('空 / 非字符串 / 含 NUL / \\\\?\\ 前缀一律拒', () => {
    for (const bad of ['', '   ', 42, null, undefined, {}, '/root/with\u0000nul', '\\\\?\\C:\\root\\a.txt']) {
      expect(checkPath(bad, ['/root'], io).ok, `应拒绝:${String(bad)}`).toBe(false)
    }
  })

  it('没有配置任何白名单时拒绝一切', () => {
    const out = checkPath('/root/a.txt', [], io)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('工作目录')
  })
})

describe('sanitizeRoots', () => {
  it('丢掉相对路径(按 cwd 解析会让含义随启动方式漂移)', () => {
    expect(sanitizeRoots(['/root', 'relative/dir', './x', '', '  '], [])).toEqual(['/root'])
  })

  it('去重(含末尾斜杠与重复项)', () => {
    expect(sanitizeRoots(['/root', '/root/', '/root//', '/other'], [])).toEqual(['/root', '/other'])
  })

  it('丢掉 deny 名单本身与它的子目录', () => {
    expect(sanitizeRoots(['/root', '/root/bowdata', '/root/bowdata/x'], ['/root/bowdata'])).toEqual(['/root'])
  })

  it('deny 名单是「父级」时不影响同级目录', () => {
    expect(sanitizeRoots(['/data/ok'], ['/data/bow'])).toEqual(['/data/ok'])
  })
})

describe('设置文件(真磁盘)', () => {
  let base = ''
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'bow-fileroots-'))
    env.userData = join(base, 'userdata')
    env.downloads = join(base, 'downloads')
    mkdirSync(env.userData, { recursive: true })
    mkdirSync(env.downloads, { recursive: true })
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function writeSettings(value: unknown): void {
    writeFileSync(
      join(env.userData, 'files-settings.json'),
      typeof value === 'string' ? value : JSON.stringify(value),
      'utf-8'
    )
  }

  it('没配工作目录 → 回退到 bow 的下载目录(**不是**放开到全盘)', () => {
    expect(resolveFileRoots()).toEqual([env.downloads])
    writeSettings({ version: 1, roots: [] })
    expect(resolveFileRoots()).toEqual([env.downloads])
  })

  it('配了就用配的(并清洗掉非法项),**并且下载目录仍然在里面**', () => {
    writeSettings({ version: 1, roots: ['/a', 'rel', '/a'] })
    expect(resolveFileRoots()).toEqual(['/a', env.downloads])
  })

  it('配的那条就是下载目录时不会重复(按真实路径比)', () => {
    writeSettings({ version: 1, roots: [env.downloads] })
    expect(resolveFileRoots()).toEqual([env.downloads])
    writeSettings({ version: 1, roots: [`${env.downloads}/`] })
    expect(resolveFileRoots()).toEqual([env.downloads])
  })

  it('坏 JSON / 文件不存在 → 默认设置,不抛', () => {
    expect(readFilesSettingsRaw().roots).toEqual([])
    writeSettings('{ not json')
    const raw = readFilesSettingsRaw()
    expect(raw.roots).toEqual([])
    expect(raw.allowPermanentDelete).toBe(false)
    expect(resolveFileRoots()).toEqual([env.downloads])
  })

  it('downloads-settings.json 里的 downloadDir 会被当成默认白名单', () => {
    writeFileSync(
      join(env.userData, 'downloads-settings.json'),
      JSON.stringify({ askWhereToSave: false, downloadDir: join(base, 'mydl'), maxRecords: 500 }),
      'utf-8'
    )
    expect(resolveFileRoots()).toEqual([join(base, 'mydl')])
  })

  it('deny 名单 = userData 本身', () => {
    expect(fileRootsDenyList()).toEqual([env.userData])
  })

  it('checkFilePath 用真实设置 + 真实 fs:userData 与白名单外都被拒', () => {
    writeSettings({ version: 1, roots: [env.downloads] })
    expect(checkFilePath(join(env.downloads, 'a.txt')).ok).toBe(true)
    expect(checkFilePath(join(env.userData, 'files-settings.json')).ok).toBe(false)
    expect(checkFilePath(join(base, 'elsewhere.txt')).ok).toBe(false)
  })

  it('checkFilePath 能识破真磁盘上的符号链接逃逸', () => {
    writeSettings({ version: 1, roots: [env.downloads] })
    const outside = join(base, 'outside')
    mkdirSync(outside, { recursive: true })
    const link = join(env.downloads, 'escape')
    try {
      symlinkSync(outside, link, 'dir')
    } catch {
      return // 平台不支持建符号链接(Windows 无权限):跳过
    }
    expect(checkFilePath(join(link, 'secret.txt')).ok).toBe(false)
  })
})
