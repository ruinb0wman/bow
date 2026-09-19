/**
 * 浏览历史插件:记录主框架访问 / 搜索词,并向地址栏建议源贡献历史命中。
 * 数据文件沿用 history.json,格式与旧实现一致(零迁移);
 * 保留条数配置存于 history-settings.json(默认 500,范围 1–100000)。
 */

import type { HistoryEntry, HistoryKind, HistoryList, HistorySettings } from '@shared/types'
import type { SuggestItem } from '@shared/plugins'
import {
  HISTORY_CAP,
  addHistoryEntry,
  clampHistoryCap,
  removeHistoryEntries,
  trimHistory
} from '@shared/history'
import { isInternalUrl } from '@shared/internalPages'
import { scoreFields } from '@shared/suggest'
import { isHttpUrl } from '@shared/url'
import type { PluginContext, PluginMain } from '../../main/plugins/types'

interface NavigatedPayload {
  tabId: number
  url: string
  title: string
}

interface SearchPayload {
  url: string
  query: string
  title?: string
}

const plugin: PluginMain = {
  manifest: {
    id: 'history',
    name: '浏览历史',
    description: '记录访问与搜索,并在地址栏提供历史建议',
    version: '1.0.0',
    core: true
  },
  capabilities: ['ui', 'suggest'],

  activate(ctx: PluginContext): void {
    const store = ctx.storage<HistoryList>({ file: 'history.json', defaults: [] })
    const settings = ctx.storage<HistorySettings>({
      file: 'history-settings.json',
      defaults: { maxEntries: HISTORY_CAP }
    })

    const cap = (): number => clampHistoryCap(settings.get().maxEntries)

    const emitChanged = (): void => {
      ctx.ipc.emit('changed', store.get())
    }

    const record = (v: { title: string; url: string; kind?: HistoryKind; query?: string }): void => {
      const url = v.url.trim()
      // 2026-09-19:内部页(`bow://terminal` / `bow://settings`)也进历史 —— 空地址栏的「最近」列表里
      // 直接就有「终端」,输「终」/「term」也能模糊命中,不必再打整串 URL。
      if (!isHttpUrl(url) && !isInternalUrl(url)) return
      store.setRaw(addHistoryEntry(store.get(), { ...v, url }, cap()))
    }

    ctx.events.on('tab:navigated', (p: NavigatedPayload) => {
      record({ title: p.title || p.url, url: p.url })
    })
    ctx.events.on('search:performed', (p: SearchPayload) => {
      record({ title: p.title || p.query, url: p.url, kind: 'search', query: p.query })
    })

    ctx.suggest.register({
      id: 'history',
      priority: 10,
      provide(query: string, limit: number): SuggestItem[] {
        const q = query.trim()
        const list = store.get()
        if (!q) {
          return list.slice(0, limit).map(
            (h): SuggestItem => ({
              kind: 'history',
              id: h.id,
              title: h.query ?? h.title,
              url: h.url,
              query: h.query,
              visitedAt: h.visitedAt,
              score: 1
            })
          )
        }
        const out: SuggestItem[] = []
        for (const h of list) {
          const score = scoreFields(q, h.query ?? h.title, h.url)
          if (score <= 0) continue
          out.push({
            kind: 'history',
            id: h.id,
            title: h.query ?? h.title,
            url: h.url,
            query: h.query,
            visitedAt: h.visitedAt,
            score
          })
        }
        return out
      }
    })

    ctx.ipc.handle('list', (): HistoryEntry[] => store.get())
    ctx.ipc.handle('count', (): number => store.get().length)
    /** 按 id 批量删除(单条删除传单元素数组),返回实际删除条数 */
    ctx.ipc.handle('remove', (ids: string[]): number => {
      const list = store.get()
      const next = removeHistoryEntries(list, Array.isArray(ids) ? ids : [])
      const removed = list.length - next.length
      if (removed > 0) {
        store.setRaw(next)
        emitChanged()
      }
      return removed
    })
    ctx.ipc.handle('clear', (): boolean => {
      store.setRaw([])
      emitChanged()
      return true
    })
    ctx.ipc.handle('getSettings', (): HistorySettings => ({ maxEntries: cap() }))
    ctx.ipc.handle('setSettings', (patch: Partial<HistorySettings>): HistorySettings => {
      const maxEntries = clampHistoryCap(patch.maxEntries ?? cap())
      settings.set({ maxEntries })
      // 立即按最旧优先裁剪,避免保留条数降低后旧数据滞留
      store.setRaw(trimHistory(store.get(), maxEntries))
      emitChanged()
      return { maxEntries }
    })
  }
}

export default plugin
