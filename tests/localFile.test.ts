import { describe, expect, it } from 'vitest'
import { expandHome, isFileUrl, looksLikeLocalPath } from '../src/shared/localFile'

describe('looksLikeLocalPath', () => {
  it('认出各种本地路径形态', () => {
    for (const input of [
      '/tmp/a.html',
      '~/a.html',
      '~',
      './a.html',
      '../a.html',
      '..',
      'file:///tmp/a.html',
      'FILE:///tmp/a.html',
      'C:\\docs\\a.html',
      'c:/docs/a.html',
      '\\\\server\\share\\a.html'
    ]) {
      expect(looksLikeLocalPath(input), input).toBe(true)
    }
  })

  it('不把域名/搜索词误判成本地路径', () => {
    for (const input of [
      '',
      '   ',
      'file.html',
      'example.com',
      'git status',
      '~user/a.html',
      'bow://settings',
      'https://example.com/a.html'
    ]) {
      expect(looksLikeLocalPath(input), JSON.stringify(input)).toBe(false)
    }
  })

  it('前后空白不影响判定', () => {
    expect(looksLikeLocalPath('  /tmp/a.html  ')).toBe(true)
  })
})

describe('isFileUrl', () => {
  it('只认 file:// 前缀', () => {
    expect(isFileUrl('file:///tmp/a.html')).toBe(true)
    expect(isFileUrl('file:/tmp/a.html')).toBe(false)
    expect(isFileUrl('/tmp/a.html')).toBe(false)
  })
})

describe('expandHome', () => {
  it('展开 ~ 与 ~/', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u')
    expect(expandHome('~/a.html', '/home/u')).toBe('/home/u/a.html')
    expect(expandHome('~/', '/home/u/')).toBe('/home/u/')
  })

  it('其它输入原样返回(含 ~user 与相对路径)', () => {
    expect(expandHome('/tmp/a.html', '/home/u')).toBe('/tmp/a.html')
    expect(expandHome('./a.html', '/home/u')).toBe('./a.html')
    expect(expandHome('~user/a.html', '/home/u')).toBe('~user/a.html')
  })
})
