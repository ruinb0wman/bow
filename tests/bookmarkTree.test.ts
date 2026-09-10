import { describe, expect, it } from 'vitest'
import {
  addBookmark,
  addFolder,
  updateNode,
  removeNode,
  moveNode,
  findNode,
  flatten,
  findByUrl
} from '../src/shared/bookmarkTree'
import type { BookmarkTree } from '../src/shared/types'

function fresh(): BookmarkTree {
  return []
}

describe('书签树操作', () => {
  it('添加书签到根', () => {
    const { tree } = addBookmark(fresh(), { title: 'GitHub', url: 'https://github.com' })
    expect(tree).toHaveLength(1)
    expect(tree[0].type).toBe('bookmark')
    expect(findNode(tree, tree[0].id)?.title).toBe('GitHub')
  })

  it('添加文件夹并往文件夹里加书签', () => {
    let t = fresh()
    const folder = addFolder(t, { title: '开发' })
    t = folder.tree
    const bm = addBookmark(t, { title: 'Electron 文档', url: 'https://www.electronjs.org', folderId: folder.node.id })
    t = bm.tree
    expect(t[0].type).toBe('folder')
    if (t[0].type === 'folder') {
      expect(t[0].children).toHaveLength(1)
      expect(t[0].children[0].url).toBe('https://www.electronjs.org')
    }
  })

  it('文件夹不存在时书签落到根', () => {
    const { tree } = addBookmark(fresh(), { title: 'x', url: 'https://x.com', folderId: 'no-such' })
    expect(tree[0].type).toBe('bookmark')
  })

  it('更新名称与地址', () => {
    const { tree } = addBookmark(fresh(), { title: 'a', url: 'https://a.com' })
    const id = tree[0].id
    const next = updateNode(tree, id, { title: 'b', url: 'https://b.com' })
    expect(next && findNode(next, id)).toMatchObject({ title: 'b', url: 'https://b.com' })
  })

  it('删除节点', () => {
    const { tree } = addBookmark(fresh(), { title: 'a', url: 'https://a.com' })
    const id = tree[0].id
    const res = removeNode(tree, id)
    expect(res.removed).toBe(true)
    expect(res.tree).toHaveLength(0)
  })

  it('移动书签到文件夹与回根', () => {
    let t = fresh()
    const folder = addFolder(t, { title: 'F' })
    t = folder.tree
    const bm = addBookmark(t, { title: 'a', url: 'https://a.com' })
    t = bm.tree
    const mid = bm.node.id

    t = moveNode(t, mid, folder.node.id)!
    expect(findNode(t, mid)?.title).toBe('a')
    const folderAfter = findNode(t, folder.node.id)
    if (folderAfter && folderAfter.type === 'folder') {
      expect(folderAfter.children.map((c) => c.id)).toContain(mid)
    }

    t = moveNode(t, mid, null)!
    const treeRoot = t.filter((n) => n.id === mid)
    expect(treeRoot).toHaveLength(1)
  })

  it('移动 folder 到自身会失败(防环)', () => {
    let t = fresh()
    const f = addFolder(t, { title: 'F' })
    t = f.tree
    expect(moveNode(t, f.node.id, f.node.id)).toBeNull()
  })

  it('移动 folder 到其子文件夹会失败(防环)', () => {
    let t = fresh()
    const f = addFolder(t, { title: 'F' })
    t = f.tree
    const sub = addFolder(t, { title: 'Sub', parentId: f.node.id })
    t = sub.tree
    expect(moveNode(t, f.node.id, sub.node.id)).toBeNull()
  })

  it('flatten 输出目录路径', () => {
    let t = fresh()
    const f = addFolder(t, { title: 'A' })
    t = f.tree
    const bm = addBookmark(t, { title: 'B', url: 'https://b.com', folderId: f.node.id })
    t = bm.tree
    const flat = flatten(t)
    expect(flat.map((x) => x.path)).toEqual(['A', 'A/B'])
  })

  it('findByUrl 按地址查找', () => {
    const { tree } = addBookmark(fresh(), { title: 'G', url: 'https://github.com' })
    expect(findByUrl(tree, 'https://github.com')).toHaveLength(1)
    expect(findByUrl(tree, 'https://other.com')).toHaveLength(0)
  })
})