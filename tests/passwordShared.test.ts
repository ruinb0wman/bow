/**
 * 密码插件同构纯逻辑用例:站点匹配、条目归一化、设置夹紧、密码生成。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GENERATE_OPTIONS,
  DEFAULT_PASSWORD_SETTINGS,
  entryMatchesOrigin,
  generatePassword,
  hostOf,
  matchEntries,
  normalizeEntries,
  normalizeSettings,
  originOf,
  sortEntries,
  toMeta,
  type PasswordEntry,
  type RandomBytes
} from '../src/plugins/passwords/shared'

function entry(over: Partial<PasswordEntry> = {}): PasswordEntry {
  return {
    id: 'e1',
    title: '示例',
    origin: 'https://example.com',
    username: 'alice',
    password: 's3cret',
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

/** 确定性随机源:按给定字节循环 */
function seqRandom(bytes: number[]): RandomBytes {
  let i = 0
  return (n: number) => {
    const out = new Uint8Array(n)
    for (let k = 0; k < n; k++) {
      out[k] = bytes[i % bytes.length]
      i++
    }
    return out
  }
}

describe('origin / 站点匹配', () => {
  it('originOf 只接受 http/https', () => {
    expect(originOf('https://example.com/a?b=1#c')).toBe('https://example.com')
    expect(originOf('http://example.com:8080/x')).toBe('http://example.com:8080')
    expect(originOf('file:///tmp/x.html')).toBeNull()
    expect(originOf('bow://settings')).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })

  it('hostOf 解析失败返回空串', () => {
    expect(hostOf('https://sub.example.com/x')).toBe('sub.example.com')
    expect(hostOf('nope')).toBe('')
  })

  it('精确命中', () => {
    expect(entryMatchesOrigin('https://example.com', 'https://example.com', false)).toBe(true)
    expect(entryMatchesOrigin('https://example.com', 'https://other.com', false)).toBe(false)
  })

  it('子域命中只在开关打开时生效,方向是「页面属于条目」', () => {
    expect(entryMatchesOrigin('https://google.com', 'https://accounts.google.com', true)).toBe(true)
    expect(entryMatchesOrigin('https://google.com', 'https://accounts.google.com', false)).toBe(false)
    // 反向不成立:页面是父域,条目是子域
    expect(entryMatchesOrigin('https://accounts.google.com', 'https://google.com', true)).toBe(false)
    // 假后缀不算
    expect(entryMatchesOrigin('https://google.com', 'https://notgoogle.com', true)).toBe(false)
  })

  it('协议 / 端口不同一律不匹配(即便 host 是后缀关系)', () => {
    expect(entryMatchesOrigin('https://example.com', 'http://a.example.com', true)).toBe(false)
    expect(entryMatchesOrigin('https://example.com:8443', 'https://a.example.com', true)).toBe(false)
  })

  it('单段 host 不做后缀匹配(避免 com.cn 之类匹配一大片)', () => {
    expect(entryMatchesOrigin('https://localhost', 'https://a.localhost', true)).toBe(false)
  })

  it('matchEntries 过滤 + 按最近使用排序', () => {
    const list = [
      entry({ id: 'a', origin: 'https://example.com', usedAt: 10 }),
      entry({ id: 'b', origin: 'https://example.com', usedAt: 30 }),
      entry({ id: 'c', origin: 'https://other.com', usedAt: 99 })
    ]
    expect(matchEntries(list, 'https://example.com', false).map((e) => e.id)).toEqual(['b', 'a'])
  })
})

describe('条目归一化', () => {
  it('非法 origin 丢弃,id 缺失补一个,标题兜底为主机名', () => {
    const out = normalizeEntries([
      { origin: 'https://example.com', username: 'u' },
      { origin: 'nope' },
      null,
      'x'
    ])
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('example.com')
    expect(out[0].id).toBeTruthy()
  })

  it('id 重复只保留第一条', () => {
    const out = normalizeEntries([
      { id: 'dup', origin: 'https://a.com' },
      { id: 'dup', origin: 'https://b.com' }
    ])
    expect(out.map((e) => e.origin)).toEqual(['https://a.com'])
  })

  it('toMeta 不含密码', () => {
    const meta = toMeta(entry())
    expect(Object.hasOwn(meta, 'password')).toBe(false)
    expect(meta.username).toBe('alice')
  })

  it('sortEntries 不修改原数组', () => {
    const list = [entry({ id: 'a', usedAt: 1 }), entry({ id: 'b', usedAt: 2 })]
    const sorted = sortEntries(list)
    expect(sorted.map((e) => e.id)).toEqual(['b', 'a'])
    expect(list.map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('设置归一化', () => {
  it('只接受下拉里的合法值,其余回退默认', () => {
    expect(normalizeSettings({ autoLockMinutes: 15, clipboardClearSeconds: 60, matchSubdomains: false })).toEqual({
      autoLockMinutes: 15,
      clipboardClearSeconds: 60,
      matchSubdomains: false
    })
    expect(normalizeSettings({ autoLockMinutes: 7, clipboardClearSeconds: 9999 })).toEqual(DEFAULT_PASSWORD_SETTINGS)
    expect(normalizeSettings(null)).toEqual(DEFAULT_PASSWORD_SETTINGS)
    expect(normalizeSettings('x')).toEqual(DEFAULT_PASSWORD_SETTINGS)
  })
})

describe('密码生成', () => {
  it('长度与字符集符合选项', () => {
    const pw = generatePassword({ length: 32, symbols: false })
    expect(pw).toHaveLength(32)
    expect(pw).toMatch(/^[A-Za-z0-9]+$/)
  })

  it('avoidAmbiguous 生效', () => {
    const pw = generatePassword({ length: 128, avoidAmbiguous: true })
    expect(pw).toHaveLength(128)
    expect(/[0O1lI|`'"]/.test(pw)).toBe(false)
  })

  it('全部关掉时兜底为小写字母', () => {
    const pw = generatePassword({ length: 16, upper: false, lower: false, digits: false, symbols: false })
    expect(pw).toMatch(/^[a-z]+$/)
  })

  it('注入确定性随机源时结果确定', () => {
    const rnd = () => seqRandom([1, 2, 3, 4, 5])
    expect(generatePassword({ length: 12 }, rnd())).toBe(generatePassword({ length: 12 }, rnd()))
  })

  it('每个字符都落在字符集内(默认选项)', () => {
    const pw = generatePassword({ length: 64 }, seqRandom([0, 7, 31, 63, 127, 200]))
    expect(pw).toHaveLength(64)
    expect(pw).toMatch(/^[A-Za-z0-9!@#$%^&*()\-_=+[\]{};:,.?]+$/)
  })

  it('长度被夹在 4..128', () => {
    expect(generatePassword({ length: 1 })).toHaveLength(4)
    expect(generatePassword({ length: 9999 })).toHaveLength(128)
    expect(DEFAULT_GENERATE_OPTIONS.length).toBe(20)
  })
})
