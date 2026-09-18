import { describe, expect, it } from 'vitest'
import {
  resolveNavigationWithFiles,
  toAbsolutePath,
  type NavInputDeps
} from '../src/main/navInput'

const deps = (exists: string[], cwd = '/home/u/repo'): NavInputDeps => ({
  exists: (p) => exists.includes(p),
  home: '/home/u',
  cwd
})

describe('toAbsolutePath', () => {
  it('绝对路径原样规整', () => {
    expect(toAbsolutePath('/tmp//a.html', deps([]))).toBe('/tmp/a.html')
  })

  it('~ 与相对路径按 home / cwd 解析', () => {
    expect(toAbsolutePath('~/a.html', deps([]))).toBe('/home/u/a.html')
    expect(toAbsolutePath('./a.html', deps([]))).toBe('/home/u/repo/a.html')
    expect(toAbsolutePath('../a.html', deps([]))).toBe('/home/u/a.html')
  })
})

describe('resolveNavigationWithFiles', () => {
  it('存在的绝对路径 → file:// URL', () => {
    expect(resolveNavigationWithFiles('/tmp/a.html', 'google', deps(['/tmp/a.html']))).toEqual({
      parsed: 'url',
      url: 'file:///tmp/a.html'
    })
  })

  it('~ 与相对路径都能解析后命中', () => {
    expect(resolveNavigationWithFiles('~/a.html', 'google', deps(['/home/u/a.html']))).toMatchObject({
      url: 'file:///home/u/a.html'
    })
    expect(resolveNavigationWithFiles('./a.html', 'google', deps(['/home/u/repo/a.html']))).toMatchObject({
      url: 'file:///home/u/repo/a.html'
    })
  })

  it('路径带空格/特殊字符时按 URL 转义', () => {
    expect(resolveNavigationWithFiles('/tmp/a b.html', 'google', deps(['/tmp/a b.html']))).toMatchObject({
      url: 'file:///tmp/a%20b.html'
    })
  })

  it('路径不存在 → 回落成搜索(不是报错)', () => {
    expect(resolveNavigationWithFiles('/tmp/missing.html', 'google', deps([]))).toEqual({
      parsed: 'search',
      url: 'https://www.google.com/search?q=%2Ftmp%2Fmissing.html',
      query: '/tmp/missing.html'
    })
  })

  it('file:// 输入原样透传(不查存在性)', () => {
    expect(resolveNavigationWithFiles('file:///nope/x.html', 'google', deps([]))).toEqual({
      parsed: 'url',
      url: 'file:///nope/x.html'
    })
  })

  it('域名 / 搜索 / 内部页面的行为保持不变', () => {
    expect(resolveNavigationWithFiles('file.html', 'google', deps([]))).toMatchObject({
      url: 'https://file.html'
    })
    expect(resolveNavigationWithFiles('example.com', 'google', deps([]))).toMatchObject({
      url: 'https://example.com'
    })
    expect(resolveNavigationWithFiles('git status', 'google', deps([]))).toMatchObject({
      parsed: 'search',
      query: 'git status'
    })
    expect(resolveNavigationWithFiles('bow://settings', 'google', deps([]))).toMatchObject({
      url: 'bow://settings'
    })
  })

  it('空输入 → null', () => {
    expect(resolveNavigationWithFiles('   ', 'google', deps([]))).toBeNull()
  })
})
