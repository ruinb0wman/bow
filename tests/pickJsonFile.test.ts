/**
 * 「选一个 JSON 文件并读回文本」工具(书签 / 密码导入共用)的契约。
 *
 * 这里钉的是调用方(插件)依赖的三态区分:
 * - `canceled` —— 用户取消,不是错误,不该报错也不该动数据;
 * - `text`     —— 读到内容;
 * - `error`    —— 选中了但读不出来(与「取消」必须分开,否则插件会把 EACCES 当无事发生)。
 *
 * 真读文件(临时目录),只 mock electron 的对话框 —— 与 `exportFile.test.ts` 同一手法。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** 每次调用前由用例设置:对话框返回什么 */
let dialogResult: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }
let focusedWindow: unknown = null

const showOpenDialog = vi.fn(async (...args: unknown[]) => {
  void args
  return dialogResult
})

vi.mock('electron', () => ({
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) },
  BrowserWindow: { getFocusedWindow: () => focusedWindow }
}))

const { pickJsonFile } = await import('../src/main/plugins/pickJsonFile')

const dir = mkdtempSync(join(tmpdir(), 'pick-json-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('pickJsonFile', () => {
  it('用户取消 / 没有选中任何文件 → canceled', async () => {
    dialogResult = { canceled: true, filePaths: [] }
    expect(await pickJsonFile()).toEqual({ canceled: true })

    dialogResult = { canceled: false, filePaths: [] }
    expect(await pickJsonFile()).toEqual({ canceled: true })
  })

  it('选中一个文件 → 返回绝对路径与 UTF-8 文本', async () => {
    const path = join(dir, 'backup.json')
    writeFileSync(path, '{"ok":1}', 'utf-8')
    dialogResult = { canceled: false, filePaths: [path] }
    expect(await pickJsonFile()).toEqual({ canceled: false, path, text: '{"ok":1}' })
  })

  it('选了但读不出来 → canceled 为 false 且带 error(调用方必须中止,不能当成取消)', async () => {
    const path = join(dir, 'not-exist.json')
    dialogResult = { canceled: false, filePaths: [path] }
    const res = await pickJsonFile()
    expect(res.canceled).toBe(false)
    expect(res.path).toBe(path)
    expect(res.text).toBeUndefined()
    expect(res.error).toBeTruthy()
  })

  it('有聚焦窗口时把对话框挂成它的子窗口(模态)', async () => {
    focusedWindow = { fake: 'window' }
    dialogResult = { canceled: true, filePaths: [] }
    showOpenDialog.mockClear()
    await pickJsonFile()
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    expect(showOpenDialog.mock.calls[0][0]).toBe(focusedWindow)
    focusedWindow = null
  })
})
