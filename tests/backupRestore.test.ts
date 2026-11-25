/**
 * 统一备份 / 还原的**写盘路径**(`main/backup.ts`)与「还原期间禁止落盘」的闸门。
 *
 * 这里钉的是本方案最危险的一段:整包校验 → 现态快照 → 冻结 → 逐文件原子写 → 重启。
 * 手法与 `pickJsonFile.test.ts` 一致:真读真写临时目录,只 mock `electron`(对话框 / app)。
 * ⚠️ `app.exit` 必须 mock 掉,否则测试进程会真的退出。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLE_VERSION, buildEnvelope, parseEnvelope } from '../src/shared/backup'

const userData = mkdtempSync(join(tmpdir(), 'bow-backup-'))
const downloads = mkdtempSync(join(tmpdir(), 'bow-dl-'))
afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
  rmSync(downloads, { recursive: true, force: true })
})

/** 每个用例前由测试设置:两个对话框各自返回什么 */
let openResult: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }
let saveResult: { canceled: boolean; filePath?: string } = { canceled: true }
let confirmResponse = 1
const relaunch = vi.fn()
const exit = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'downloads' ? downloads : userData),
    getVersion: () => '0.1.0',
    relaunch: () => relaunch(),
    exit: (code: number) => exit(code)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => openResult,
    showSaveDialog: async () => saveResult,
    showMessageBox: async () => ({ response: confirmResponse })
  }
}))

const { exportBackup, restoreBackup, PRE_RESTORE_FILE } = await import('../src/main/backup')
const { createStore, freezeStores } = await import('../src/main/stores')

function bundleAt(path: string, files: Record<string, string>): void {
  const envelope = buildEnvelope(files, { appVersion: '0.1.0', createdAt: 1 })
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(envelope), 'utf-8')))
}

beforeEach(() => {
  openResult = { canceled: true, filePaths: [] }
  saveResult = { canceled: true }
  confirmResponse = 1
  relaunch.mockClear()
  exit.mockClear()
})

describe('导出', () => {
  it('把已存在的数据文件打成一个 gzip 包,内容逐字一致', async () => {
    const history = '[\n  { "id": "h1", "url": "https://a.example" }\n]'
    writeFileSync(join(userData, 'history.json'), history, 'utf-8')
    writeFileSync(join(userData, 'pomo.json'), '{"settings":{}}', 'utf-8')

    const out = join(downloads, 'bow-backup-test.json.gz')
    saveResult = { canceled: false, filePath: out }
    const res = await exportBackup()

    expect(res).toEqual({ ok: true, path: out })
    const parsed = parseEnvelope(gunzipSync(readFileSync(out)).toString('utf-8'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('应解析成功')
    expect(parsed.envelope.files['history.json']).toBe(history)
    expect(parsed.envelope.version).toBe(BUNDLE_VERSION)
    // 不存在的文件不塞默认值
    expect('terminal.json' in parsed.envelope.files).toBe(false)
  })

  it('用户取消保存对话框 → canceled,不写文件', async () => {
    saveResult = { canceled: true }
    expect(await exportBackup()).toEqual({ canceled: true })
  })
})

describe('还原', () => {
  const TARGET = join(userData, 'history.json')

  it('取消 → 什么都不变', async () => {
    writeFileSync(TARGET, '["before"]', 'utf-8')
    expect(await restoreBackup()).toEqual({ canceled: true })
    expect(readFileSync(TARGET, 'utf-8')).toBe('["before"]')
    expect(existsSync(join(userData, PRE_RESTORE_FILE))).toBe(false)
  })

  it('包坏了 → 一个字节都不写,也不会生成现态快照', async () => {
    writeFileSync(TARGET, '["before"]', 'utf-8')
    const bad = join(downloads, 'bad.json.gz')
    writeFileSync(bad, 'not a gzip')
    openResult = { canceled: false, filePaths: [bad] }

    const res = await restoreBackup()
    expect(res.error).toContain('gzip')
    expect(readFileSync(TARGET, 'utf-8')).toBe('["before"]')
    expect(existsSync(join(userData, PRE_RESTORE_FILE))).toBe(false)
  })

  it('确认框点「取消」→ 不写盘', async () => {
    writeFileSync(TARGET, '["before"]', 'utf-8')
    const ok = join(downloads, 'ok.json.gz')
    bundleAt(ok, { 'history.json': '["after"]' })
    openResult = { canceled: false, filePaths: [ok] }
    confirmResponse = 0

    expect(await restoreBackup()).toEqual({ canceled: true })
    expect(readFileSync(TARGET, 'utf-8')).toBe('["before"]')
  })

  it('成功:文件被覆盖、现态快照留下旧内容、重启被延后到响应之后', async () => {
    vi.useFakeTimers()
    try {
      writeFileSync(TARGET, '["before"]', 'utf-8')
      const ok = join(downloads, 'ok2.json.gz')
      bundleAt(ok, { 'history.json': '["after"]' })
      openResult = { canceled: false, filePaths: [ok] }

      expect(await restoreBackup()).toEqual({ ok: true })
      expect(readFileSync(TARGET, 'utf-8')).toBe('["after"]')

      // 现态快照 = 还原**之前**的内容
      const snap = parseEnvelope(gunzipSync(readFileSync(join(userData, PRE_RESTORE_FILE))).toString('utf-8'))
      expect(snap.ok).toBe(true)
      if (!snap.ok) throw new Error('快照应可解析')
      expect(snap.envelope.files['history.json']).toBe('["before"]')

      // 响应先回来,重启在 300ms 之后
      expect(relaunch).not.toHaveBeenCalled()
      vi.advanceTimersByTime(400)
      expect(relaunch).toHaveBeenCalledTimes(1)
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('device-inspect 的 forwards 在写盘时被清空', async () => {
    const ok = join(downloads, 'devinspect.json.gz')
    bundleAt(ok, {
      'device-inspect.json': JSON.stringify({ version: 2, adbCommand: 'adb-wsl', forwards: [{ port: 9222 }] })
    })
    openResult = { canceled: false, filePaths: [ok] }
    await restoreBackup()

    const written = JSON.parse(readFileSync(join(userData, 'device-inspect.json'), 'utf-8')) as Record<string, unknown>
    expect(written.forwards).toEqual([])
    expect(written.adbCommand).toBe('adb-wsl')
  })
})

describe('还原闸门:冻结期间任何 store 都不落盘', () => {
  it('冻结后 set 不写盘,解冻后下一个 set 才生效', () => {
    // 前面的还原用例故意停在「冻结」状态(真实进程此时就要退出了)
    freezeStores(false)
    const store = createStore<{ n: number }>('gate.json', { n: 0 })
    expect(store.set({ n: 1 })).toEqual({ n: 1 })
    expect(JSON.parse(readFileSync(join(userData, 'gate.json'), 'utf-8'))).toEqual({ n: 1 })

    freezeStores(true)
    try {
      store.setRaw({ n: 2 })
      expect(JSON.parse(readFileSync(join(userData, 'gate.json'), 'utf-8'))).toEqual({ n: 1 })
    } finally {
      freezeStores(false)
    }
    store.setRaw({ n: 3 })
    expect(JSON.parse(readFileSync(join(userData, 'gate.json'), 'utf-8'))).toEqual({ n: 3 })
  })
})
