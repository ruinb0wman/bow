/**
 * 导出工具(书签 / 密码共用)的目录解析与落盘契约。
 *
 * 这里钉的是两条容易静默漂移的约定:
 * - 「bow 下载目录」= `downloads-settings.json` 的 downloadDir(空串 → 系统下载目录);
 * - 同名文件不覆盖,落成 ` (1)`(与下载插件同一份 `uniqueFileName`)。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const { dateStamp, resolveDownloadsDir, writeToDownloads } = await import('../src/main/plugins/exportFile')

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

describe('writeToDownloads', () => {
  it('写入内容并返回绝对路径', () => {
    const res = writeToDownloads('a.json', '{"x":1}')
    expect(res.ok).toBe(true)
    expect(res.path).toBe(join(downloadsDir, 'a.json'))
    expect(readFileSync(res.path!, 'utf-8')).toBe('{"x":1}')
  })

  it('POSIX 上收紧为 0o600(Windows 忽略)', () => {
    if (process.platform === 'win32') return
    const res = writeToDownloads('perm.json', '{}')
    expect(statSync(res.path!).mode & 0o777).toBe(0o600)
  })

  it('目标目录不存在时自动创建', () => {
    const missing = join(created[0], 'missing', 'nested')
    seedSettings({ downloadDir: missing })
    const res = writeToDownloads('a.json', '{}')
    expect(res.ok).toBe(true)
    expect(res.path).toBe(join(missing, 'a.json'))
    expect(existsSync(res.path!)).toBe(true)
  })

  it('同名文件不覆盖,落成 (1)', () => {
    writeToDownloads('a.json', 'first')
    const second = writeToDownloads('a.json', 'second')
    expect(second.path).toBe(join(downloadsDir, 'a (1).json'))
    expect(readFileSync(join(downloadsDir, 'a.json'), 'utf-8')).toBe('first')
    expect(readFileSync(second.path!, 'utf-8')).toBe('second')
  })
})
