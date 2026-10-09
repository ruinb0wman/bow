/**
 * 文件管理插件的纯逻辑:设置归一、条数夹紧、展示格式化、排序、glob。
 *
 * 这些是「不碰磁盘也不碰 Electron」的那一半(另一半在 `tests/fileRoots.test.ts` 的路径策略与
 * `tests/filesPlugin.test.ts` 的真实读写)。不 import electron 就能直接跑。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILES_SETTINGS,
  DEFAULT_LIST_LIMIT,
  LIST_LIMIT_MAX,
  LIST_LIMIT_MIN,
  MAX_ROOTS,
  clampListLimit,
  formatSize,
  globToRegExp,
  isHiddenName,
  matchGlob,
  normalizeFilesSettings,
  sortEntries,
  type FsEntry
} from '../src/plugins/files/shared'

function entry(name: string, type: FsEntry['type'] = 'file'): FsEntry {
  return { name, path: `/x/${name}`, type, size: 0, mtimeMs: 0 }
}

describe('normalizeFilesSettings', () => {
  it('坏输入(undefined / 数组 / 字符串)退化为默认设置', () => {
    expect(normalizeFilesSettings(undefined)).toEqual(DEFAULT_FILES_SETTINGS)
    expect(normalizeFilesSettings([])).toEqual(DEFAULT_FILES_SETTINGS)
    expect(normalizeFilesSettings('nope')).toEqual(DEFAULT_FILES_SETTINGS)
    expect(normalizeFilesSettings({ roots: 'nope' })).toEqual(DEFAULT_FILES_SETTINGS)
  })

  it('roots:去空、去首尾空格、去重、丢掉非字符串', () => {
    const out = normalizeFilesSettings({ roots: ['/a', ' /a ', '', '   ', 42, null, '/b', '/a'] })
    expect(out.roots).toEqual(['/a', '/b'])
  })

  it('roots:超过上限就截断(不让设置文件无限膨胀)', () => {
    const many = Array.from({ length: MAX_ROOTS + 10 }, (_, i) => `/d${i}`)
    expect(normalizeFilesSettings({ roots: many }).roots).toHaveLength(MAX_ROOTS)
  })

  it('allowPermanentDelete 只认字面 true(「任意真值」会把字符串当成开启)', () => {
    expect(normalizeFilesSettings({ allowPermanentDelete: true }).allowPermanentDelete).toBe(true)
    expect(normalizeFilesSettings({ allowPermanentDelete: 'true' }).allowPermanentDelete).toBe(false)
    expect(normalizeFilesSettings({ allowPermanentDelete: 1 }).allowPermanentDelete).toBe(false)
  })

  it('listLimit 被夹紧', () => {
    expect(normalizeFilesSettings({ listLimit: 0 }).listLimit).toBe(LIST_LIMIT_MIN)
    expect(normalizeFilesSettings({ listLimit: 1e9 }).listLimit).toBe(LIST_LIMIT_MAX)
    expect(normalizeFilesSettings({ listLimit: 'x' }).listLimit).toBe(DEFAULT_LIST_LIMIT)
  })
})

describe('clampListLimit', () => {
  it('非数字 → 默认值', () => {
    expect(clampListLimit(undefined)).toBe(DEFAULT_LIST_LIMIT)
    expect(clampListLimit(Number.NaN)).toBe(DEFAULT_LIST_LIMIT)
    expect(clampListLimit({})).toBe(DEFAULT_LIST_LIMIT)
  })

  it('夹紧并向下取整', () => {
    expect(clampListLimit(-5)).toBe(LIST_LIMIT_MIN)
    expect(clampListLimit(99999)).toBe(LIST_LIMIT_MAX)
    expect(clampListLimit(12.7)).toBe(12)
  })
})

describe('isHiddenName', () => {
  it('点号开头即隐藏,`.` 与 `..` 也算(列目录时它们本来就不出现)', () => {
    expect(isHiddenName('.git')).toBe(true)
    expect(isHiddenName('.env')).toBe(true)
    expect(isHiddenName('git')).toBe(false)
  })
})

describe('formatSize', () => {
  it('按 1024 进位;大值不再保留小数', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatSize(200 * 1024 * 1024)).toBe('200 MB')
  })

  it('非法值给占位符,不给 NaN', () => {
    expect(formatSize(Number.NaN)).toBe('—')
    expect(formatSize(-1)).toBe('—')
  })
})

describe('sortEntries', () => {
  it('目录在前,名字按数值比且大小写不敏感', () => {
    const list = [entry('b.txt'), entry('a10.txt'), entry('A2.txt'), entry('src', 'dir'), entry('z', 'dir')]
    expect(sortEntries(list).map((e) => e.name)).toEqual(['src', 'z', 'A2.txt', 'a10.txt', 'b.txt'])
  })

  it('不改原数组', () => {
    const list = [entry('b'), entry('a')]
    sortEntries(list)
    expect(list.map((e) => e.name)).toEqual(['b', 'a'])
  })
})

describe('matchGlob', () => {
  it('空模式全匹配', () => {
    expect(matchGlob('', 'anything/at/all.md')).toBe(true)
    expect(matchGlob('   ', 'x')).toBe(true)
  })

  it('* 不跨段', () => {
    expect(matchGlob('*.md', 'a.md')).toBe(true)
    expect(matchGlob('*.md', 'src/a.md')).toBe(false)
  })

  it('** 跨段,且 `**/` 也命中当前层', () => {
    expect(matchGlob('**/*.md', 'a.md')).toBe(true)
    expect(matchGlob('**/*.md', 'src/deep/a.md')).toBe(true)
    expect(matchGlob('src/**/*.ts', 'src/a/b/c.ts')).toBe(true)
    expect(matchGlob('src/**/*.ts', 'lib/a.ts')).toBe(false)
  })

  it('? 一个字符,不跨段', () => {
    expect(matchGlob('a?.md', 'ab.md')).toBe(true)
    expect(matchGlob('a?.md', 'a/.md')).toBe(false)
  })

  it('不区分大小写,且正则元字符被转义', () => {
    expect(matchGlob('*.MD', 'readme.md')).toBe(true)
    expect(matchGlob('a+b.txt', 'a+b.txt')).toBe(true)
    expect(matchGlob('a+b.txt', 'aab.txt')).toBe(false)
    expect(matchGlob('a.b', 'axb')).toBe(false)
  })

  it('Windows 分隔符由调用方归一(matchGlob 自己把 \\ 当分隔符处理)', () => {
    expect(matchGlob('**/*.md', 'src\\deep\\a.md')).toBe(true)
  })
})

describe('globToRegExp', () => {
  it('暴露正则本身(UI 与调试用)', () => {
    expect(globToRegExp('*.md').test('a.md')).toBe(true)
    expect(globToRegExp('*.md').flags).toContain('i')
  })
})
