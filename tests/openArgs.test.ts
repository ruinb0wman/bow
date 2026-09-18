import { describe, expect, it } from 'vitest'
import { classifyArg, collectOpenTargets, type OpenTargetDeps } from '../src/main/openArgs'

const FILES = ['/tmp/a.html', '/tmp/b.html', '/home/u/dir']
const DIRS = ['/home/u/dir']

const deps = (over: Partial<OpenTargetDeps> = {}): OpenTargetDeps => ({
  existsSync: (p) => FILES.includes(p) || DIRS.includes(p),
  isDirectory: (p) => DIRS.includes(p),
  home: '/home/u',
  cwd: '/home/u/repo',
  ...over
})

/** dev 形态:`electron . <args>` */
const dev = (args: string[], over?: Partial<OpenTargetDeps>) => collectOpenTargets(['electron', '.', ...args], 2, deps(over))

/**
 * Windows 用例的依赖:测试跑在 Linux 上,盘符/UNC 路径无法按真实语义解析,
 * 所以这里只关心**分类与被接受/被拒的原因**,用 endsWith 做存在性判定。
 */
const winDeps = (exists: (p: string) => boolean): OpenTargetDeps => ({
  existsSync: exists,
  isDirectory: () => false,
  home: 'C:\\Users\\u',
  cwd: 'C:\\repo'
})

describe('collectOpenTargets', () => {
  it('dev 形态跳过 electron 与 app path,取到裸路径', () => {
    expect(dev(['/tmp/a.html'])).toEqual(['file:///tmp/a.html'])
  })

  it('打包形态 skip=1', () => {
    expect(collectOpenTargets(['/opt/bow/bow', '/tmp/a.html'], 1, deps())).toEqual(['file:///tmp/a.html'])
  })

  it('http(s) / file:// URL 直传,顺序保持', () => {
    expect(dev(['https://example.com', 'file:///tmp/a.html'])).toEqual(['https://example.com', 'file:///tmp/a.html'])
  })

  it('~ 与相对路径解析成绝对路径', () => {
    expect(dev(['/tmp/a.html', './b.html'], { existsSync: (p) => ['/tmp/a.html', '/home/u/repo/b.html'].includes(p) })).toEqual([
      'file:///tmp/a.html',
      'file:///home/u/repo/b.html'
    ])
  })

  it('去重', () => {
    expect(dev(['/tmp/a.html', '/tmp/a.html', 'file:///tmp/a.html'])).toEqual(['file:///tmp/a.html'])
  })

  it('开关 / 不存在的路径 / 目录 / 其它协议 / 认不出的参数都被忽略并报原因', () => {
    const skipped: Array<[string, string]> = []
    const out = collectOpenTargets(
      ['electron', '.', '--ozone-platform=headless', '/tmp/missing.html', '/home/u/dir', 'mailto:a@b.c', 'just-a-word'],
      2,
      deps(),
      { onSkip: (arg, reason) => skipped.push([arg, reason]) }
    )
    expect(out).toEqual([])
    expect(skipped).toEqual([
      ['--ozone-platform=headless', '命令行开关'],
      ['/tmp/missing.html', '文件不存在'],
      ['/home/u/dir', '目录'],
      ['mailto:a@b.c', '不支持的协议'],
      ['just-a-word', '既不是 URL 也不是本地路径']
    ])
  })

  it('`--` 分隔符被跳过', () => {
    expect(dev(['--', '/tmp/a.html'])).toEqual(['file:///tmp/a.html'])
  })

  it('空 argv / skip 越界不炸', () => {
    expect(collectOpenTargets([], 2, deps())).toEqual([])
    expect(collectOpenTargets(['electron'], 2, deps())).toEqual([])
    expect(collectOpenTargets(['', '/tmp/a.html'], 0, deps())).toEqual(['file:///tmp/a.html'])
  })
})

describe('classifyArg:判定顺序(Windows 盘符路径的回归防线)', () => {
  it('C:\… 与 UNC 算本地路径,绝不能落到 scheme 分支', () => {
    expect(classifyArg('C:\\Users\\u\\a.html')).toBe('local-path')
    expect(classifyArg('c:/Users/u/a.html')).toBe('local-path')
    expect(classifyArg('\\\\server\\share\\a.html')).toBe('local-path')
    expect(classifyArg('C:\\a.html')).toBe('local-path')
    expect(classifyArg('/tmp/a.html')).toBe('local-path')
    expect(classifyArg('~/a.html')).toBe('local-path')
    expect(classifyArg('./a.html')).toBe('local-path')
  })

  it('http(s) / file: / 其它协议 / 普通词各归各位', () => {
    expect(classifyArg('https://example.com')).toBe('http')
    expect(classifyArg('http://127.0.0.1:3000/x')).toBe('http')
    expect(classifyArg('file:///tmp/a.html')).toBe('file-url')
    expect(classifyArg('file:///C:/a.html')).toBe('file-url')
    expect(classifyArg('mailto:a@b.c')).toBe('scheme')
    expect(classifyArg('bow://settings')).toBe('scheme')
    expect(classifyArg('just-a-word')).toBe('other')
  })
})

describe('collectOpenTargets:Windows 形态的启动参数', () => {
  it('盘符路径 + UNC 都被接受(旧实现会全判成「不支持的协议」)', () => {
    const skipped: string[] = []
    const out = collectOpenTargets(
      ['C:\\Users\\u\\a.html', '\\\\server\\share\\b.html'],
      0,
      winDeps((p) => /\.html$/.test(p)),
      { onSkip: (_a, reason) => skipped.push(reason) }
    )
    expect(skipped).toEqual([])
    expect(out).toHaveLength(2)
    expect(out.every((t) => t.startsWith('file://'))).toBe(true)
  })

  it('不存在的盘符路径报「文件不存在」而不是「不支持的协议」', () => {
    const skipped: Array<[string, string]> = []
    const out = collectOpenTargets(['C:\\nope\\a.html'], 0, winDeps(() => false), {
      onSkip: (arg, reason) => skipped.push([arg, reason])
    })
    expect(out).toEqual([])
    expect(skipped).toEqual([['C:\\nope\\a.html', '文件不存在']])
  })

  it('打包形态 `bow.exe <文件>`(skip=1) 取得到目标', () => {
    const out = collectOpenTargets(
      ['C:\\Program Files\\bow\\bow.exe', 'C:\\docs\\a.html'],
      1,
      winDeps((p) => p.endsWith('a.html'))
    )
    expect(out).toHaveLength(1)
    expect(out[0].startsWith('file://')).toBe(true)
  })

  it('file:///C:/… 形态也认(Chromium / 启动器可能这么传)', () => {
    const skipped: string[] = []
    const out = collectOpenTargets(['file:///C:/docs/a.html'], 0, winDeps((p) => p.endsWith('a.html')), {
      onSkip: (_a, reason) => skipped.push(reason)
    })
    expect(skipped).toEqual([])
    expect(out[0].startsWith('file://')).toBe(true)
  })
})
