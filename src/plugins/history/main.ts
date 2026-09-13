/**
 * 浏览历史插件:记录主框架访问 / 搜索词,并向地址栏建议源贡献历史命中。
 * 数据文件沿用 history.json,格式与旧实现一致(零迁移)。
 */

import type { HistoryEntry, HistoryKind, HistoryList } from '@shared/types'
import type { SuggestItem } from '@shared/plugins'
import { addHistoryEntry } from '@shared/history'
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

    const record = (v: { title: string; url: string; kind?: HistoryKind; query?: string }): void => {
      const url = v.url.trim()
      if (!isHttpUrl(url)) return
      store.setRaw(addHistoryEntry(store.get(), { ...v, url }))
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
    ctx.ipc.handle('clear', (): boolean => {
      store.setRaw([])
      ctx.ipc.emit('changed', [])
      return true
    })
  }
}

export default plugin
