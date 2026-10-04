/**
 * 插件导出到「bow 下载目录」的主进程共享工具。
 *
 * 为什么是一个共享模块:书签与密码插件的导出都必须落在**下载插件设置的那个目录** ——
 * 目录的唯一来源是 `<userData>/downloads-settings.json` 的 `downloadDir`(空串 = 系统下载目录)。
 * 让两个插件各自拼一套解析逻辑迟早漂移,所以放在这里,并复用下载插件自己的
 * `DEFAULT_DOWNLOAD_SETTINGS` / `uniqueFileName`(纯函数),默认值与去重规则同源。
 *
 * 只读文件、不缓存:下载插件的设置存在它自己的 JsonStore 内存副本里,这里读盘一次即可,
 * 也避免两个 JsonStore 实例对同一文件各持一份快照(内核注释:插件间共享 storage 文件名是错误用法)。
 *
 * 见 `.pi/plans/2026-10-04-bookmarks-passwords-export/plan.md`。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_DOWNLOAD_SETTINGS, uniqueFileName } from '@plugins/downloads/shared'

export interface ExportWriteResult {
  ok: boolean
  path?: string
  error?: string
}

/** 生效的 bow 下载目录:downloads-settings.json 的 downloadDir;空串 / 读不到 → 系统下载目录 */
export function resolveDownloadsDir(): string {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'downloads-settings.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { downloadDir?: unknown }
    const dir = typeof parsed.downloadDir === 'string' ? parsed.downloadDir.trim() : ''
    if (dir) return dir
  } catch {
    // 文件不存在 / 坏 JSON:回退默认
  }
  return DEFAULT_DOWNLOAD_SETTINGS.downloadDir || app.getPath('downloads')
}

/** 本地日期 YYYY-MM-DD(导出文件名用;不用 toISOString,避免时区把它拨到前一天) */
export function dateStamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 把一段文本写进 bow 下载目录,同名自动加 ` (1)` 后缀。
 * `mode: 0o600` 只对 POSIX 生效(Windows 忽略);密码库备份是密文,收紧权限没有副作用。
 */
export function writeToDownloads(filename: string, content: string): ExportWriteResult {
  try {
    const dir = resolveDownloadsDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const name = uniqueFileName(filename, (n) => existsSync(join(dir, n)))
    const path = join(dir, name)
    writeFileSync(path, content, { encoding: 'utf-8', mode: 0o600 })
    return { ok: true, path }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
