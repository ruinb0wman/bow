/**
 * 主进程里的「文件对话框」共享工具(核心的统一备份与还原在用)。
 *
 * 为什么是一个共享模块:弹对话框必须**挂在聚焦窗口上**(父窗口在场时是模态的),拿不到就退化成
 * 无父窗口 —— 这段样板别复制第二份。
 *
 * ⚠️ `pickFile()` 返回的是 **Buffer** 而不是文本:统一备份包是 gzip 二进制,用 `utf-8` 读会
 * 把字节解码坏(还原时表现为「gzip 解不开」)。
 *
 * 单插件的数据导入/导出(书签 JSON、密码库加密备份)已随统一备份上线而下线 —— 见
 * `.pi/plans/2026-11-05-backup-restore/plan.md`。
 */

import { BrowserWindow, dialog } from 'electron'
import { readFileSync } from 'node:fs'

export interface PickedFile {
  /** 用户取消 / 关掉了对话框 —— 不是错误,调用方安静返回即可 */
  canceled: boolean
  /** 选中文件的绝对路径(成功时给出) */
  path?: string
  /** 文件原始字节(成功时给出) */
  data?: Buffer
  /** 读文件失败的原因(路径已有但读不出来;此时 `canceled` 为 false) */
  error?: string
}

export interface FileDialogOptions {
  title?: string
  filters?: Electron.FileFilter[]
}

const DEFAULT_FILTERS: Electron.FileFilter[] = [{ name: '所有文件', extensions: ['*'] }]

/** 选一个文件并读回**原始字节** */
export async function pickFile(opts: FileDialogOptions = {}): Promise<PickedFile> {
  const options: Electron.OpenDialogOptions = {
    title: opts.title ?? '选择文件',
    properties: ['openFile'],
    filters: opts.filters ?? DEFAULT_FILTERS
  }
  const parent = BrowserWindow.getFocusedWindow()
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return { canceled: true }
  const path = result.filePaths[0]
  try {
    return { canceled: false, path, data: readFileSync(path) }
  } catch (e) {
    return { canceled: false, path, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 选一个保存位置;不写文件,只回路径 */
export async function pickSaveFile(
  opts: FileDialogOptions & { defaultPath?: string } = {}
): Promise<{ canceled: boolean; path?: string }> {
  const options: Electron.SaveDialogOptions = {
    title: opts.title ?? '保存文件',
    defaultPath: opts.defaultPath,
    filters: opts.filters ?? DEFAULT_FILTERS
  }
  const parent = BrowserWindow.getFocusedWindow()
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { canceled: true }
  return { canceled: false, path: result.filePath }
}
