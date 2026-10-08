import type { BookmarkNode, BookmarkTree, FlatBookmark } from './types'
import { isHttpUrl } from './url'
import { isInternalUrl } from './internalPages'

/** 书签树纯逻辑(可单测):所有操作返回新树,不修改入参 */

let idCounter = 0
export function genId(prefix = 'bm'): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function cloneTree(tree: BookmarkTree): BookmarkTree {
  return JSON.parse(JSON.stringify(tree)) as BookmarkTree
}

function findIn(list: BookmarkNode[], id: string): { node: BookmarkNode; parent: BookmarkTree | null } | null {
  for (const node of list) {
    if (node.id === id) return { node, parent: list }
    if (node.type === 'folder') {
      const hit = findIn(node.children, id)
      if (hit) return hit
    }
  }
  return null
}

export interface AddBookmarkInput {
  title: string
  url: string
  folderId?: string | null
}

export function addBookmark(tree: BookmarkTree, input: AddBookmarkInput): { tree: BookmarkTree; node: BookmarkNode } {
  const next = cloneTree(tree)
  const node: BookmarkNode = {
    id: genId(),
    type: 'bookmark',
    title: input.title.trim() || input.url,
    url: input.url
  }
  if (input.folderId) {
    const hit = findIn(next, input.folderId)
    if (hit && hit.node.type === 'folder') {
      hit.node.children.push(node)
      return { tree: next, node }
    }
    // 目标文件夹不存在 → 落到根
  }
  next.push(node)
  return { tree: next, node }
}

export function addFolder(tree: BookmarkTree, input: { title: string; parentId?: string | null }): { tree: BookmarkTree; node: BookmarkNode } {
  const next = cloneTree(tree)
  const node: BookmarkNode = { id: genId('folder'), type: 'folder', title: input.title.trim() || '新文件夹', children: [] }
  if (input.parentId) {
    const hit = findIn(next, input.parentId)
    if (hit && hit.node.type === 'folder') {
      hit.node.children.push(node)
      return { tree: next, node }
    }
  }
  next.push(node)
  return { tree: next, node }
}

export function updateNode(tree: BookmarkTree, id: string, patch: { title?: string; url?: string }): BookmarkTree | null {
  const next = cloneTree(tree)
  const hit = findIn(next, id)
  if (!hit) return null
  if (patch.title !== undefined) hit.node.title = patch.title.trim() || hit.node.title
  if (patch.url !== undefined && hit.node.type === 'bookmark') hit.node.url = patch.url.trim() || hit.node.url
  return next
}

export function removeNode(tree: BookmarkTree, id: string): { tree: BookmarkTree; removed: boolean } {
  const next = cloneTree(tree)
  const hit = findIn(next, id)
  if (!hit || !hit.parent) return { tree: next, removed: false }
  const idx = hit.parent.findIndex((n) => n.id === id)
  if (idx >= 0) {
    hit.parent.splice(idx, 1)
    return { tree: next, removed: true }
  }
  return { tree: next, removed: false }
}

/** targetFolderId: null 表示移动到根 */
export function moveNode(tree: BookmarkTree, id: string, targetFolderId: string | null): BookmarkTree | null {
  const next = cloneTree(tree)
  const source = findIn(next, id)
  if (!source || !source.parent) return null

  // 禁止移动到自身/自身子节点;目标必须是存在的文件夹
  let targetFolder: BookmarkNode | null = null
  if (targetFolderId) {
    const t = findIn(next, targetFolderId)
    if (!t || t.node.type !== 'folder') return null
    targetFolder = t.node
    if (targetFolder.id === id) return null
    if (source.node.type === 'folder' && isDescendant(source.node, targetFolderId)) return null
  }

  const idx = source.parent.findIndex((n) => n.id === id)
  const [moved] = source.parent.splice(idx, 1)
  if (targetFolder) targetFolder.children.push(moved)
  else next.push(moved)
  return next
}

/** targetId 是否在 folder 的子孙中 */
function isDescendant(folder: BookmarkNode, targetId: string): boolean {
  if (folder.type !== 'folder') return false
  for (const c of folder.children) {
    if (c.id === targetId) return true
    if (c.type === 'folder' && isDescendant(c, targetId)) return true
  }
  return false
}

export function findNode(tree: BookmarkTree, id: string): BookmarkNode | null {
  return findIn(tree, id)?.node ?? null
}

/** 展平为带路径的列表,便于 MCP 与 UI 展示 */
export function flatten(tree: BookmarkTree, prefix = ''): FlatBookmark[] {
  const out: FlatBookmark[] = []
  for (const node of tree) {
    const path = prefix ? `${prefix}/${node.title}` : node.title
    if (node.type === 'folder') {
      out.push({ id: node.id, type: 'folder', title: node.title, path })
      out.push(...flatten(node.children, path))
    } else {
      out.push({ id: node.id, type: 'bookmark', title: node.title, url: node.url, path })
    }
  }
  return out
}

/** 按 URL 查找书签(供“星标”判断) */
export function findByUrl(tree: BookmarkTree, url: string): FlatBookmark[] {
  return flatten(tree).filter((b) => b.type === 'bookmark' && b.url === url)
}

/** 供 UI 展示根层级 */
export function childrenOf(tree: BookmarkTree, folderId: string | null): BookmarkNode[] {
  if (!folderId) return tree
  const hit = findIn(tree, folderId)
  return hit && hit.node.type === 'folder' ? hit.node.children : []
}

/**
 * 一级目录迁移:目录层级只保留一级。
 * - 所有深度 ≥2 的书签并入其深度 1 的祖先目录(例如 A/B/bm 与 A/B/C/bm 都并入 A);
 * - 删除全部非根目录(其书签已上移);
 * - 保留根级目录(含空目录,用户可能有意创建待整理);
 * - 已是一级的树原样返回(幂等)。
 */
export function flattenToSingleLevel(tree: BookmarkTree): BookmarkTree {
  const next: BookmarkTree = []
  for (const node of tree) {
    if (node.type === 'bookmark') {
      next.push({ ...node })
      continue
    }
    // 根级目录:深度优先收集其全部子孙书签,嵌套目录本身删除
    const flatChildren: BookmarkNode[] = []
    const walk = (list: BookmarkTree): void => {
      for (const c of list) {
        if (c.type === 'bookmark') flatChildren.push({ ...c })
        else walk(c.children)
      }
    }
    walk(node.children)
    next.push({ ...node, children: flatChildren })
  }
  return next
}

/** `normalizeImportedTree` 的结果 */
export interface ImportedBookmarks {
  tree: BookmarkTree
  /** 结构不合法、或 url 不是 http(s)/`bow://` 而被丢弃的条目数 */
  dropped: number
  /** id 缺失 / 重复 / 非字符串而被重新发放的条目数 */
  reissued: number
}

/**
 * 校验并归一「外部 JSON 书签树」(设置页导入用)。根不是数组 → `null`(调用方报「不是书签树」)。
 *
 * 规则:
 * - 节点必须是 `{title: string, type: 'bookmark' | 'folder'}`;folder 递归 `children`(缺省当空);
 * - 书签 url 必须是 http(s) 或 `bow://` 内部页 —— 与 `browser_add_bookmark` / 星标同一道门槛,其余丢弃;
 * - id 缺失 / 重复 / 非字符串 → 重新发放(`move`/`remove` 按 id 定位,重复 id 会让它们指向错的节点);
 * - 最后跑一次 `flattenToSingleLevel()`,与激活时的迁移同一条不变量(目录恒在根)。
 */
export function normalizeImportedTree(raw: unknown): ImportedBookmarks | null {
  if (!Array.isArray(raw)) return null
  const stats = { dropped: 0, reissued: 0 }
  const seen = new Set<string>()

  const takeId = (value: unknown, prefix: string): string => {
    const id = typeof value === 'string' ? value.trim() : ''
    if (id && !seen.has(id)) {
      seen.add(id)
      return id
    }
    stats.reissued += 1
    const next = genId(prefix)
    seen.add(next)
    return next
  }

  const walk = (list: unknown[]): BookmarkNode[] => {
    const out: BookmarkNode[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        stats.dropped += 1
        continue
      }
      const node = item as Record<string, unknown>
      const title = typeof node.title === 'string' ? node.title : ''
      if (node.type === 'folder') {
        const children = Array.isArray(node.children) ? walk(node.children) : []
        out.push({ id: takeId(node.id, 'fd'), type: 'folder', title, children })
        continue
      }
      if (node.type !== 'bookmark') {
        stats.dropped += 1
        continue
      }
      const url = typeof node.url === 'string' ? node.url.trim() : ''
      if (!isHttpUrl(url) && !isInternalUrl(url)) {
        stats.dropped += 1
        continue
      }
      out.push({ id: takeId(node.id, 'bm'), type: 'bookmark', title: title.trim() || url, url })
    }
    return out
  }

  return { tree: flattenToSingleLevel(walk(raw)), ...stats }
}