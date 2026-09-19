/**
 * 书签插件:书签树 CRUD(IPC)、地址栏建议源、星标/管理面板 UI、MCP 工具。
 * 数据文件沿用 bookmarks.json;一级目录迁移(展平深层嵌套)在激活时幂等执行。
 */

import { z } from 'zod'
import type { BookmarkNode, BookmarkTree, FlatBookmark } from '@shared/types'
import type { SuggestItem } from '@shared/plugins'
import {
  addBookmark,
  addFolder,
  findByUrl,
  findNode,
  flatten,
  flattenToSingleLevel,
  moveNode,
  removeNode,
  updateNode
} from '@shared/bookmarkTree'
import { isInternalUrl } from '@shared/internalPages'
import { isHttpUrl } from '@shared/url'
import { scoreFields } from '@shared/suggest'
import { textContent } from '../../main/plugins/mcpResult'
import type { PluginContext, PluginMain } from '../../main/plugins/types'

interface AddInput {
  title?: string
  url: string
  folderId?: string | null
}

const plugin: PluginMain = {
  manifest: {
    id: 'bookmarks',
    name: '书签',
    description: '收藏管理、地址栏星标与书签建议',
    version: '1.0.0',
    core: true
  },
  capabilities: ['ui', 'suggest', 'mcp'],

  activate(ctx: PluginContext): void {
    const store = ctx.storage<BookmarkTree>({ file: 'bookmarks.json', defaults: [] })

    // 一级目录迁移:幂等,已是一级时无写入
    const raw = store.get()
    const flat = flattenToSingleLevel(raw)
    if (JSON.stringify(flat) !== JSON.stringify(raw)) {
      store.setRaw(flat)
      ctx.log('书签数据已迁移为一级目录')
    }

    const emitChanged = (): void => {
      ctx.ipc.emit('changed', store.get())
    }

    ctx.ipc.handle('list', (): BookmarkTree => store.get())
    ctx.ipc.handle('add', (input: AddInput): BookmarkNode => {
      const added = addBookmark(store.get(), {
        title: input.title ?? '',
        url: input.url,
        folderId: input.folderId ?? null
      })
      store.setRaw(added.tree)
      emitChanged()
      return added.node
    })
    ctx.ipc.handle('addFolder', (input: { title?: string }): BookmarkNode => {
      // 一级目录结构:文件夹始终创建在根目录,忽略调用方传入的 parentId
      const added = addFolder(store.get(), { title: input.title ?? '', parentId: null })
      store.setRaw(added.tree)
      emitChanged()
      return added.node
    })
    ctx.ipc.handle('update', (id: string, patch: { title?: string; url?: string }) => {
      const tree = updateNode(store.get(), id, patch)
      if (!tree) return { ok: false, error: '书签不存在' }
      store.setRaw(tree)
      emitChanged()
      return { ok: true }
    })
    ctx.ipc.handle('remove', (id: string) => {
      const res = removeNode(store.get(), id)
      if (res.removed) {
        store.setRaw(res.tree)
        emitChanged()
      }
      return res
    })
    ctx.ipc.handle('move', (id: string, targetFolderId: string | null) => {
      const tree = store.get()
      const node = findNode(tree, id)
      if (!node) return { ok: false, error: '书签不存在' }
      // 一级目录不变量:目录恒在根;书签目标仅限根或根级目录
      const rootFolderIds = new Set<string>()
      for (const n of tree) if (n.type === 'folder') rootFolderIds.add(n.id)
      if (node.type === 'folder') {
        if (targetFolderId !== null) return { ok: false, error: '目录只能位于根目录' }
        return { ok: true }
      }
      if (targetFolderId !== null && !rootFolderIds.has(targetFolderId)) {
        return { ok: false, error: '目标必须是根级目录' }
      }
      const moved = moveNode(tree, id, targetFolderId)
      if (!moved) return { ok: false, error: '移动失败(目标文件夹不存在或形成循环)' }
      store.setRaw(moved)
      emitChanged()
      return { ok: true }
    })
    ctx.ipc.handle('findByUrl', (url: string): FlatBookmark[] => findByUrl(store.get(), url))

    ctx.suggest.register({
      id: 'bookmarks',
      priority: 20,
      provide(query: string): SuggestItem[] {
        const q = query.trim()
        if (!q) return []
        const out: SuggestItem[] = []
        for (const b of flatten(store.get())) {
          if (b.type !== 'bookmark') continue
          const score = scoreFields(q, b.title, b.url ?? '')
          if (score <= 0) continue
          out.push({
            kind: 'bookmark',
            id: b.id,
            title: b.title,
            url: b.url,
            path: b.path,
            visitedAt: 0,
            score
          })
        }
        return out
      }
    })

    ctx.mcp.tool(
      'browser_add_bookmark',
      {
        description: '添加书签',
        inputSchema: {
          title: z.string().optional().describe('书签标题,缺省用 URL'),
          url: z.string().describe('http(s) 地址,或 bow:// 内部页(如 bow://terminal)'),
          folderId: z.string().optional().describe('目标文件夹 id(根级目录),缺省根目录')
        }
      },
      async (args) => {
        const url = String(args.url ?? '')
        // bow:// 内部页(终端/设置)也可以收藏:收藏后点它 = 顶替聚焦窗格(与地址栏同一条路)
        if (!isHttpUrl(url) && !isInternalUrl(url)) {
          return textContent({ ok: false, error: '书签地址必须是 http/https 或 bow:// 内部页' })
        }
        const added = addBookmark(store.get(), {
          title: String(args.title ?? ''),
          url,
          folderId: (args.folderId as string | undefined) ?? null
        })
        store.setRaw(added.tree)
        emitChanged()
        const urlText = added.node.type === 'bookmark' ? added.node.url : url
        return textContent({ ok: true, id: added.node.id, title: added.node.title, url: urlText })
      }
    )

    ctx.mcp.tool('browser_list_bookmarks', { description: '列出全部书签' }, async () =>
      textContent({ ok: true, bookmarks: flatten(store.get()) })
    )
  }
}

export default plugin
