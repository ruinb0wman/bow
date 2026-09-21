/**
 * 下载插件纯逻辑用例:状态归一、动作可用性、裁剪排序、重名去重、格式化。
 * 这些是 UI 与 MCP 共用的判据,写错会直接表现为「按钮点不动 / 记录丢了 / 文件名被覆盖」。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  MAX_RECORDS_MAX,
  MAX_RECORDS_MIN,
  actionsFor,
  clampMaxRecords,
  etaSeconds,
  formatBytes,
  formatEta,
  formatProgressBytes,
  formatSpeed,
  isTerminal,
  normalizeSettings,
  percentOf,
  reconcileOnStart,
  sortRecords,
  trimRecords,
  uniqueFileName,
  type DownloadRecord,
  type DownloadState
} from '../src/plugins/downloads/shared'

function rec(patch: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 'd1',
    url: 'https://example.com/a.zip',
    urlChain: ['https://example.com/a.zip'],
    filename: 'a.zip',
    savePath: '/tmp/a.zip',
    mimeType: 'application/zip',
    totalBytes: 1000,
    receivedBytes: 0,
    state: 'progressing',
    startedAt: 1000,
    ...patch
  }
}

describe('clampMaxRecords', () => {
  it('夹在 1..5000', () => {
    expect(clampMaxRecords(0)).toBe(MAX_RECORDS_MIN)
    expect(clampMaxRecords(-5)).toBe(MAX_RECORDS_MIN)
    expect(clampMaxRecords(1e9)).toBe(MAX_RECORDS_MAX)
    expect(clampMaxRecords(12.7)).toBe(12)
  })

  it('坏输入回退 fallback', () => {
    expect(clampMaxRecords('abc', 42)).toBe(42)
    expect(clampMaxRecords(undefined, 42)).toBe(42)
    expect(clampMaxRecords(NaN, 42)).toBe(42)
    expect(clampMaxRecords({}, 42)).toBe(42)
  })
})

describe('normalizeSettings', () => {
  it('坏字段一律保留上一次的好值,不跳回默认值', () => {
    const prev = { askWhereToSave: false, downloadDir: '/data/dl', maxRecords: 42 }
    expect(normalizeSettings(undefined, prev)).toEqual(prev)
    expect(normalizeSettings({ askWhereToSave: 'yes', downloadDir: 42, maxRecords: 'abc' }, prev)).toEqual(prev)
  })

  it('只认合法字段,目录去空白', () => {
    const prev = DEFAULT_DOWNLOAD_SETTINGS
    expect(normalizeSettings({ askWhereToSave: false, downloadDir: '  /d  ' }, prev)).toEqual({
      askWhereToSave: false,
      downloadDir: '/d',
      maxRecords: prev.maxRecords
    })
  })

  it('maxRecords 走夹紧(而不是回退)', () => {
    const prev = DEFAULT_DOWNLOAD_SETTINGS
    expect(normalizeSettings({ maxRecords: 0 }, prev).maxRecords).toBe(MAX_RECORDS_MIN)
    expect(normalizeSettings({ maxRecords: 999999 }, prev).maxRecords).toBe(MAX_RECORDS_MAX)
  })
})

describe('isTerminal', () => {
  it('只有三种状态是终态', () => {
    const terminal: DownloadState[] = ['completed', 'cancelled', 'interrupted']
    const live: DownloadState[] = ['progressing', 'paused']
    for (const s of terminal) expect(isTerminal(s), s).toBe(true)
    for (const s of live) expect(isTerminal(s), s).toBe(false)
  })
})

describe('actionsFor', () => {
  it('进行中(有 item):暂停 + 取消', () => {
    expect(actionsFor(rec({ state: 'progressing' }), true)).toEqual(['pause', 'cancel', 'copyUrl'])
  })

  it('暂停/中断且 item 还在:继续 + 取消', () => {
    expect(actionsFor(rec({ state: 'paused' }), true)).toEqual(['resume', 'cancel', 'copyUrl'])
    expect(actionsFor(rec({ state: 'interrupted' }), true)).toEqual(['resume', 'cancel', 'copyUrl'])
  })

  it('重启后的暂停项没有 item:只能重下', () => {
    expect(actionsFor(rec({ state: 'paused' }), false)).toEqual(['retry', 'remove', 'copyUrl'])
    expect(actionsFor(rec({ state: 'interrupted' }), false)).toEqual(['retry', 'remove', 'copyUrl'])
  })

  it('已完成:打开 + 文件夹 + 删除', () => {
    expect(actionsFor(rec({ state: 'completed', fileExists: true }), false)).toEqual([
      'open',
      'showInFolder',
      'remove',
      'copyUrl'
    ])
  })

  it('文件已不在时不给「打开」', () => {
    expect(actionsFor(rec({ state: 'completed', fileExists: false }), false)).toEqual([
      'showInFolder',
      'remove',
      'copyUrl'
    ])
  })

  it('已取消:重下 + 删除', () => {
    expect(actionsFor(rec({ state: 'cancelled' }), false)).toEqual(['retry', 'remove', 'copyUrl'])
  })
})

describe('reconcileOnStart', () => {
  it('非终态降级为已中断并写明原因', () => {
    const out = reconcileOnStart([rec({ id: 'a', state: 'progressing' }), rec({ id: 'b', state: 'paused' })])
    expect(out.map((r) => r.state)).toEqual(['interrupted', 'interrupted'])
    expect(out[0].error).toBe('浏览器退出时中断')
  })

  it('终态原样(dropped 的 endedAt / error 不被改写)', () => {
    const done = rec({ id: 'c', state: 'completed', endedAt: 2000, error: undefined })
    const [out] = reconcileOnStart([done])
    expect(out).toEqual(done)
  })
})

describe('trimRecords', () => {
  it('未超限时原样返回', () => {
    const list = [rec({ id: 'a' })]
    expect(trimRecords(list, 5)).toBe(list)
  })

  it('终态超限删最旧的,进行中永不裁', () => {
    const list = [
      rec({ id: 'live', state: 'progressing', startedAt: 0 }),
      rec({ id: 'old', state: 'completed', startedAt: 1 }),
      rec({ id: 'mid', state: 'completed', startedAt: 2 }),
      rec({ id: 'new', state: 'completed', startedAt: 3 })
    ]
    const out = trimRecords(list, 2)
    // 上限 2 = 1 个非终态 + 1 个最新终态
    expect(out.map((r) => r.id)).toEqual(['live', 'new'])
  })

  it('非终态多于上限时全部保留(可超过 max)', () => {
    const list = [
      rec({ id: 'a', state: 'progressing', startedAt: 1 }),
      rec({ id: 'b', state: 'paused', startedAt: 2 }),
      rec({ id: 'c', state: 'completed', startedAt: 3 })
    ]
    expect(trimRecords(list, 1).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('保持原数组顺序', () => {
    const list = [
      rec({ id: 'new', state: 'completed', startedAt: 3 }),
      rec({ id: 'old', state: 'completed', startedAt: 1 }),
      rec({ id: 'mid', state: 'completed', startedAt: 2 })
    ]
    expect(trimRecords(list, 2).map((r) => r.id)).toEqual(['new', 'mid'])
  })
})

describe('sortRecords', () => {
  it('非终态在前(先来的在上),终态在后(新的在上)', () => {
    const list = [
      rec({ id: 'done-new', state: 'completed', startedAt: 9 }),
      rec({ id: 'live-2', state: 'progressing', startedAt: 5 }),
      rec({ id: 'done-old', state: 'cancelled', startedAt: 1 }),
      rec({ id: 'live-1', state: 'paused', startedAt: 4 })
    ]
    expect(sortRecords(list).map((r) => r.id)).toEqual(['live-1', 'live-2', 'done-new', 'done-old'])
  })

  it('不改动入参', () => {
    const list = [rec({ id: 'a', startedAt: 2 }), rec({ id: 'b', startedAt: 1 })]
    const before = list.map((r) => r.id)
    sortRecords(list)
    expect(list.map((r) => r.id)).toEqual(before)
  })
})

describe('percentOf / etaSeconds', () => {
  it('未知大小:进行中 0,已完成 100', () => {
    expect(percentOf(rec({ totalBytes: 0, receivedBytes: 500 }))).toBe(0)
    expect(percentOf(rec({ totalBytes: 0, receivedBytes: 500, state: 'completed' }))).toBe(100)
  })

  it('向下取整且夹在 0..100', () => {
    expect(percentOf(rec({ totalBytes: 3, receivedBytes: 1 }))).toBe(33)
    expect(percentOf(rec({ totalBytes: 100, receivedBytes: 150 }))).toBe(100)
    expect(percentOf(rec({ totalBytes: 100, receivedBytes: -5 }))).toBe(0)
  })

  it('剩余时间只在「下载中 + 速度/大小已知」时给出', () => {
    expect(etaSeconds(rec({ totalBytes: 1000, receivedBytes: 0, bytesPerSecond: 100 }))).toBe(10)
    expect(etaSeconds(rec({ totalBytes: 1000, receivedBytes: 1000, bytesPerSecond: 100 }))).toBe(0)
    expect(etaSeconds(rec({ totalBytes: 0, bytesPerSecond: 100 }))).toBeNull()
    expect(etaSeconds(rec({ totalBytes: 1000, bytesPerSecond: 0 }))).toBeNull()
    expect(etaSeconds(rec({ state: 'paused', bytesPerSecond: 100 }))).toBeNull()
  })
})

describe('uniqueFileName', () => {
  it('未占用时原样', () => {
    expect(uniqueFileName('a.pdf', () => false)).toBe('a.pdf')
  })

  it('占用时加 (n),扩展名按最后一个点切', () => {
    expect(uniqueFileName('a.pdf', (n) => n === 'a.pdf')).toBe('a (1).pdf')
    expect(uniqueFileName('a.tar.gz', (n) => n === 'a.tar.gz')).toBe('a.tar (1).gz')
  })

  it('无扩展名 / 以点开头', () => {
    expect(uniqueFileName('LICENSE', (n) => n === 'LICENSE')).toBe('LICENSE (1)')
    expect(uniqueFileName('.gitignore', (n) => n === '.gitignore')).toBe('.gitignore (1)')
  })

  it('连续占用时递增到第一个空位', () => {
    const taken = new Set(['a.pdf', 'a (1).pdf', 'a (2).pdf'])
    expect(uniqueFileName('a.pdf', (n) => taken.has(n))).toBe('a (3).pdf')
  })

  it('全部占用时回退带时间戳的名字(不会覆盖)', () => {
    const out = uniqueFileName('a.pdf', () => true, 2)
    expect(out).toMatch(/^a \(.+\)\.pdf$/)
    expect(out).not.toBe('a.pdf')
  })

  it('空文件名兜底为 download', () => {
    expect(uniqueFileName('   ', () => false)).toBe('download')
  })
})

describe('格式化', () => {
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024 * 1.44)).toBe('1.4 MB')
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 MB')
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(NaN)).toBe('—')
  })

  it('formatSpeed', () => {
    expect(formatSpeed(2048)).toBe('2.0 KB/s')
    expect(formatSpeed(0)).toBe('—')
    expect(formatSpeed(undefined)).toBe('—')
    expect(formatSpeed(NaN)).toBe('—')
  })

  it('formatEta', () => {
    expect(formatEta(null)).toBe('—')
    expect(formatEta(0.4)).toBe('不到 1 秒')
    expect(formatEta(12)).toBe('12 秒')
    expect(formatEta(90)).toBe('1 分 30 秒')
    expect(formatEta(3700)).toBe('1 小时 1 分')
    expect(formatEta(86400 * 2)).toBe('2 天')
    expect(formatEta(-1)).toBe('—')
  })

  it('formatProgressBytes:总大小未知时只显示已收', () => {
    expect(formatProgressBytes(rec({ receivedBytes: 2048, totalBytes: 4096 }))).toBe('2.0 KB / 4.0 KB')
    expect(formatProgressBytes(rec({ receivedBytes: 2048, totalBytes: 0 }))).toBe('2.0 KB')
  })
})
