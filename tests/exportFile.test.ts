/**
 * 「bow 下载目录」的解析契约(统一备份默认存到这里,文件白名单也用它)。
 *
 * 钉的是一条容易静默漂移的约定:
 * 「bow 下载目录」= `downloads-settings.json` 的 downloadDir(空串 → 系统下载目录)。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''
let downloadsDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => (key === 'userData' ? userDataDir : downloadsDir),
    getVersion: () => '0.0.0'
  }
}))

const { dateStamp, resolveDownloadsDir } = await import('../src/main/plugins/exportFile')

const created: string[] = []

function seedSettings(value?: unknown): void {
  const file = join(userDataDir, 'downloads-settings.json')
  if (value === undefined) return
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf-8')
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'export-file-'))
  created.push(base)
  userDataDir = join(base, 'userdata')
  downloadsDir = join(base, 'downloads')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(downloadsDir, { recursive: true })
})

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

describe('resolveDownloadsDir', () => {
  it('没有设置文件时回退系统下载目录', () => {
    expect(resolveDownloadsDir()).toBe(downloadsDir)
  })

  it('downloadDir 有值时用它', () => {
    const custom = join(created[0], 'my-downloads')
    seedSettings({ downloadDir: custom })
    expect(resolveDownloadsDir()).toBe(custom)
  })

  it('downloadDir 为空串时回退系统下载目录', () => {
    seedSettings({ downloadDir: '   ' })
    expect(resolveDownloadsDir()).toBe(downloadsDir)
  })

  it('坏 JSON 回退系统下载目录,不抛', () => {
    seedSettings('{ not json')
    expect(resolveDownloadsDir()).toBe(downloadsDir)
  })
})

describe('dateStamp', () => {
  it('本地日期补零', () => {
    expect(dateStamp(new Date(2026, 9, 4))).toBe('2026-10-04')
    expect(dateStamp(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
