/**
 * `fileDialogs` 的契约:三态必须分得清。
 *
 * - `canceled` —— 用户取消,不是错误,不该报错也不该动数据;
 * - `data`     —— 读到字节(⚠️ 必须是 Buffer:备份包是 gzip,按文本读会解码坏);
 * - `error`    —— 选中了但读不出来(与「取消」必须分开,否则调用方会把 EACCES 当无事发生)。
 *
 * 真读文件(临时目录),只 mock electron 的对话框 —— 与 `exportFile.test.ts` 同一手法。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** 每次调用前由用例设置:对话框返回什么 */
let openResult: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }
let saveResult: { canceled: boolean; filePath?: string } = { canceled: true }
let focusedWindow: unknown = null

const showOpenDialog = vi.fn(async (...args: unknown[]) => {
  void args
  return openResult
})
const showSaveDialog = vi.fn(async (...args: unknown[]) => {
  void args
  return saveResult
})

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...args),
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args)
  },
  BrowserWindow: { getFocusedWindow: () => focusedWindow }
}))

const { pickFile, pickSaveFile } = await import('../src/main/plugins/fileDialogs')

const dir = mkdtempSync(join(tmpdir(), 'file-dialogs-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('pickFile', () => {
  it('用户取消 / 没有选中任何文件 → canceled', async () => {
    openResult = { canceled: true, filePaths: [] }
    expect(await pickFile()).toEqual({ canceled: true })

    openResult = { canceled: false, filePaths: [] }
    expect(await pickFile()).toEqual({ canceled: true })
  })

  it('选中一个文件 → 返回绝对路径与**原始字节**(二进制不被解码破坏)', async () => {
    const path = join(dir, 'backup.json.gz')
    const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00])
    writeFileSync(path, bytes)
    openResult = { canceled: false, filePaths: [path] }

    const res = await pickFile()
    expect(res.canceled).toBe(false)
    expect(res.path).toBe(path)
    expect(Buffer.isBuffer(res.data)).toBe(true)
    expect(res.data?.equals(bytes)).toBe(true)
  })

  it('选了但读不出来 → canceled 为 false 且带 error(调用方必须中止,不能当成取消)', async () => {
    const path = join(dir, 'not-exist.json')
    openResult = { canceled: false, filePaths: [path] }
    const res = await pickFile()
    expect(res.canceled).toBe(false)
    expect(res.path).toBe(path)
    expect(res.data).toBeUndefined()
    expect(res.error).toBeTruthy()
  })

  it('有聚焦窗口时把对话框挂成它的子窗口(模态)', async () => {
    focusedWindow = { fake: 'window' }
    openResult = { canceled: true, filePaths: [] }
    showOpenDialog.mockClear()
    await pickFile()
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    expect(showOpenDialog.mock.calls[0][0]).toBe(focusedWindow)
    focusedWindow = null
  })
})

describe('pickSaveFile', () => {
  it('取消 → canceled 且没有路径', async () => {
    saveResult = { canceled: true }
    expect(await pickSaveFile()).toEqual({ canceled: true })
  })

  it('确认 → 回路径,不写文件', async () => {
    const path = join(dir, 'new-backup.json.gz')
    saveResult = { canceled: false, filePath: path }
    expect(await pickSaveFile()).toEqual({ canceled: false, path })
  })
})
