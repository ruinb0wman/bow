/**
 * 插件「导入一个 JSON 文件」的主进程共享工具(书签 / 密码共用)。
 *
 * 为什么是一个共享模块:两个插件的导入都要「弹系统文件选择框 → 读回 UTF-8 文本」,
 * 逻辑一模一样,各自复制一份迟早漂移(与 `exportFile.ts` 同一个理由)。
 *
 * 把**读文件也放在这里**是刻意的:插件侧只需要 `JSON.parse(picked.text)`,
 * 于是插件单测只 mock 这一个模块就够,不必去 mock `node:fs`。
 *
 * 对话框照 `logseq/main.ts` 的 `pickGraph` 写法:优先挂在当前聚焦窗口上(父窗口在场时是模态的),
 * 拿不到就退化成无父窗口的对话框。
 *
 * 见 `.pi/plans/2026-10-08-plugin-cleanup-imports-settings-split/plan.md`。
 */

import { BrowserWindow, dialog } from 'electron'
import { readFileSync } from 'node:fs'

export interface PickedJson {
  /** 用户取消 / 关掉了对话框 —— 不是错误,调用方安静返回即可 */
  canceled: boolean
  /** 选中文件的绝对路径(成功时给出) */
  path?: string
  /** 文件内容(UTF-8 文本;成功时给出) */
  text?: string
  /** 读文件失败的原因(路径已有但读不出来) */
  error?: string
}

/** 选一个 .json 文件并读回文本 */
export async function pickJsonFile(): Promise<PickedJson> {
  const options: Electron.OpenDialogOptions = {
    title: '选择 JSON 文件',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const parent = BrowserWindow.getFocusedWindow()
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return { canceled: true }
  const path = result.filePaths[0]
  try {
    return { canceled: false, path, text: readFileSync(path, 'utf-8') }
  } catch (e) {
    return { canceled: false, path, error: e instanceof Error ? e.message : String(e) }
  }
}
