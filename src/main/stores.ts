/** 书签 / 设置 的 JSON 持久化(userData 下),原子写入 */

import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { BookmarkTree, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/url'
import { flattenToSingleLevel } from '@shared/bookmarkTree'
import { log, logError } from './logger'

export class JsonStore<T> {
  private file: string
  private data: T

  constructor(filename: string, defaults: T) {
    this.file = join(app.getPath('userData'), filename)
    this.data = this.load(defaults)
  }

  private load(defaults: T): T {
    try {
      const raw = readFileSync(this.file, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(defaults)) {
        // 数组型数据(书签树):整体替换,不接受对象
        return (Array.isArray(parsed) ? parsed : defaults) as T
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 对象型数据(设置):浅合并,保证新字段有默认值
        return { ...(defaults as object), ...(parsed as object) } as T
      }
      return defaults
    } catch {
      return defaults
    }
  }

  get(): T {
    return this.data
  }

  set(patch: Partial<T>): T {
    this.data = { ...this.data, ...patch } as T
    this.save()
    return this.data
  }

  setRaw(raw: T): T {
    this.data = raw
    this.save()
    return this.data
  }

  private save(): void {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      renameSync(tmp, this.file)
    } catch (e) {
      logError('存储写入失败', this.file, e)
    }
  }
}

let bookmarksStore: JsonStore<BookmarkTree> | null = null
let settingsStore: JsonStore<Settings> | null = null

export function initStores(): void {
  if (bookmarksStore || settingsStore) return
  bookmarksStore = new JsonStore<BookmarkTree>('bookmarks.json', [])
  settingsStore = new JsonStore<Settings>('settings.json', DEFAULT_SETTINGS)
  // 一级目录迁移:启动时展平历史深层嵌套(幂等,已是一级时无写入)
  const raw = bookmarksStore.get()
  const flat = flattenToSingleLevel(raw)
  if (JSON.stringify(flat) !== JSON.stringify(raw)) {
    bookmarksStore.setRaw(flat)
    log('书签数据已迁移为一级目录')
  }
  log('stores 初始化完成')
}

export function getBookmarksStore(): JsonStore<BookmarkTree> {
  if (!bookmarksStore) initStores()
  return bookmarksStore!
}

export function getSettingsStore(): JsonStore<Settings> {
  if (!settingsStore) initStores()
  return settingsStore!
}