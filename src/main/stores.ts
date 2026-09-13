/**
 * JSON 持久化(userData 下,原子写入)与核心设置存储。
 *
 * 书签 / 历史 / CORS 等数据已交由对应插件通过插件内核的 storage() 自行管理,
 * 这里只保留通用的 JsonStore 与核心设置(搜索引擎 / 主页)。
 */

import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/url'
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
        // 数组型数据:整体替换,不接受对象
        return (Array.isArray(parsed) ? parsed : defaults) as T
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 对象型数据:浅合并,保证新字段有默认值
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

/** 创建任意 userData 下的 JSON 存储(插件内核与核心设置共用) */
export function createStore<T>(filename: string, defaults: T): JsonStore<T> {
  return new JsonStore<T>(filename, defaults)
}

let settingsStore: JsonStore<Settings> | null = null

export function initStores(): void {
  if (settingsStore) return
  settingsStore = new JsonStore<Settings>('settings.json', DEFAULT_SETTINGS)
  log('stores 初始化完成')
}

export function getSettingsStore(): JsonStore<Settings> {
  if (!settingsStore) initStores()
  return settingsStore!
}
