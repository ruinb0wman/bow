import { describe, expect, it } from 'vitest'
import {
  ALL_DATA_FILES,
  BUNDLE_VERSION,
  buildEnvelope,
  parseEnvelope,
  sanitizeOnRestore
} from '../src/shared/backup'

function envelopeOf(files: Record<string, string>): string {
  return JSON.stringify(buildEnvelope(files, { appVersion: '0.1.0', createdAt: 1 }))
}

const KNOWN = 'history.json'

describe('备份包信封', () => {
  it('正常往返:文件原文逐字保留', () => {
    const text = '[\n  { "id": "a" }\n]'
    const parsed = parseEnvelope(envelopeOf({ [KNOWN]: text, 'pomo.json': '{}' }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('应解析成功')
    expect(parsed.envelope.version).toBe(BUNDLE_VERSION)
    expect(parsed.envelope.files[KNOWN]).toBe(text)
    expect(Object.keys(parsed.envelope.files).sort()).toEqual(['history.json', 'pomo.json'])
  })

  it('保留不认识的（更新的 bow 写出的）文件', () => {
    const parsed = parseEnvelope(envelopeOf({ [KNOWN]: '[]', 'future.json': '{}' }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('应解析成功')
    expect(parsed.envelope.files['future.json']).toBe('{}')
  })

  it('非 JSON 文本被拒', () => {
    const r = parseEnvelope('not json')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('应失败')
    expect(r.error).toContain('合法 JSON')
  })

  it('版本不对被拒,且文案带出版本号', () => {
    const r = parseEnvelope(JSON.stringify({ version: 99, appVersion: '1', createdAt: 0, files: { [KNOWN]: '[]' } }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('应失败')
    expect(r.error).toContain('99')
  })

  it('缺 files 被拒', () => {
    const r = parseEnvelope(JSON.stringify({ version: BUNDLE_VERSION }))
    expect(r.ok).toBe(false)
  })

  it('值不是文本被拒,并点名文件', () => {
    const r = parseEnvelope(JSON.stringify({ version: BUNDLE_VERSION, files: { [KNOWN]: [] } }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('应失败')
    expect(r.error).toContain(KNOWN)
  })

  it('值不是合法 JSON 被拒,并点名文件', () => {
    const r = parseEnvelope(JSON.stringify({ version: BUNDLE_VERSION, files: { [KNOWN]: '{oops' } }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('应失败')
    expect(r.error).toContain(KNOWN)
  })

  it('空 files 被拒', () => {
    const r = parseEnvelope(JSON.stringify({ version: BUNDLE_VERSION, files: {} }))
    expect(r.ok).toBe(false)
  })

  it('没有任何已知数据文件 → 「不像是 bow 备份」', () => {
    const r = parseEnvelope(envelopeOf({ 'whatever.json': '{}' }))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('应失败')
    expect(r.error).toContain('不像是 bow 备份')
  })

  // 备份包是外来文件,还原会按里面的键往 userData 写盘 ⇒ 名字必须先卡死
  it('路径穿越的文件名被拒', () => {
    for (const name of ['../../evil.json', 'sub/dir.json', '..']) {
      const r = parseEnvelope(JSON.stringify({ version: BUNDLE_VERSION, files: { [KNOWN]: '[]', [name]: '{}' } }))
      expect(r.ok, name).toBe(false)
    }
  })

  it('清单自身没有重复项', () => {
    expect(new Set(ALL_DATA_FILES).size).toBe(ALL_DATA_FILES.length)
  })
})

describe('还原时的字段裁剪', () => {
  it('device-inspect 的 forwards 被清空,其余字段保留', () => {
    const text = JSON.stringify({ version: 2, adbCommand: 'adb', strategy: 'auto', forwards: [{ port: 9222 }] })
    const out = JSON.parse(sanitizeOnRestore('device-inspect.json', text)) as Record<string, unknown>
    expect(out.forwards).toEqual([])
    expect(out.adbCommand).toBe('adb')
    expect(out.version).toBe(2)
  })

  it('其它文件原样返回', () => {
    const text = '[\n  1,\n  2\n]'
    expect(sanitizeOnRestore(KNOWN, text)).toBe(text)
  })

  it('内容不合法时原样返回(校验已在 parseEnvelope 里做过)', () => {
    expect(sanitizeOnRestore('device-inspect.json', '[]')).toBe('[]')
  })
})
