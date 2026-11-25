/**
 * 「bow 下载目录」的解析(统一备份默认把包存到这里,文件白名单也用它)。
 *
 * 目录的唯一来源是 `<userData>/downloads-settings.json` 的 `downloadDir`(空串 = 系统下载目录);
 * 两处各拼一套解析逻辑迟早漂移,所以放在这里。
 *
 * 只读文件、不缓存:下载插件的设置存在它自己的 JsonStore 内存副本里,这里读盘一次即可,
 * 也避免两个 JsonStore 实例对同一文件各持一份快照(内核注释:插件间共享 storage 文件名是错误用法)。
 */

import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_DOWNLOAD_SETTINGS } from '@plugins/downloads/shared'

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

/** 本地日期 YYYY-MM-DD(备份文件名用;不用 toISOString,避免时区把它拨到前一天) */
export function dateStamp(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
