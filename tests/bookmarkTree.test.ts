import { describe, expect, it } from 'vitest'
import {
  addBookmark,
  addFolder,
  flattenToSingleLevel,
  normalizeImportedTree,
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

describe('一级目录迁移 flattenToSingleLevel', () => {
  it('深层书签并入最近根级目录,嵌套目录删除', () => {
    const tree: BookmarkTree = [
      {
        id: 'f1',
        type: 'folder',
        title: 'A',
        children: [
          { id: 'b1', type: 'bookmark', title: 'B1', url: 'https://b1.com' },
          {
            id: 'f2',
            type: 'folder',
            title: 'A1',
            children: [
              { id: 'b2', type: 'bookmark', title: 'B2', url: 'https://b2.com' },
              {
                id: 'f3',
                type: 'folder',
                title: 'A1a',
                children: [{ id: 'b3', type: 'bookmark', title: 'B3', url: 'https://b3.com' }]
              }
            ]
          }
        ]
      },
      { id: 'b0', type: 'bookmark', title: 'B0', url: 'https://b0.com' }
    ]
    expect(flattenToSingleLevel(tree)).toEqual([
      {
        id: 'f1',
        type: 'folder',
        title: 'A',
        children: [
          { id: 'b1', type: 'bookmark', title: 'B1', url: 'https://b1.com' },
          { id: 'b2', type: 'bookmark', title: 'B2', url: 'https://b2.com' },
          { id: 'b3', type: 'bookmark', title: 'B3', url: 'https://b3.com' }
        ]
      },
      { id: 'b0', type: 'bookmark', title: 'B0', url: 'https://b0.com' }
    ])
  })

  it('空嵌套目录删除,空根级目录保留', () => {
    const tree: BookmarkTree = [
      {
        id: 'f1',
        type: 'folder',
        title: 'A',
        children: [{ id: 'f2', type: 'folder', title: 'B', children: [] }]
      },
      { id: 'f3', type: 'folder', title: 'Empty', children: [] }
    ]
    expect(flattenToSingleLevel(tree)).toEqual([
      { id: 'f1', type: 'folder', title: 'A', children: [] },
      { id: 'f3', type: 'folder', title: 'Empty', children: [] }
    ])
  })

  it('已是一级的树原样返回(幂等)', () => {
    const tree: BookmarkTree = [
      {
        id: 'f1',
        type: 'folder',
        title: 'A',
        children: [{ id: 'b1', type: 'bookmark', title: 'B1', url: 'https://b1.com' }]
      },
      { id: 'b0', type: 'bookmark', title: 'B0', url: 'https://b0.com' }
    ]
    expect(flattenToSingleLevel(tree)).toEqual(tree)
    expect(flattenToSingleLevel(flattenToSingleLevel(tree))).toEqual(tree)
  })

  it('纯目录链无书签时仅剩空根目录', () => {
    const tree: BookmarkTree = [
      {
        id: 'f1',
        type: 'folder',
        title: 'A',
        children: [
          { id: 'f2', type: 'folder', title: 'B', children: [{ id: 'f3', type: 'folder', title: 'C', children: [] }] }
        ]
      }
    ]
    expect(flattenToSingleLevel(tree)).toEqual([{ id: 'f1', type: 'folder', title: 'A', children: [] }])
  })
})

describe('normalizeImportedTree 导入校验', () => {
  it('根不是数组 → null(调用方据此报「不是书签树」)', () => {
    expect(normalizeImportedTree(null)).toBeNull()
    expect(normalizeImportedTree({})).toBeNull()
    expect(normalizeImportedTree('[]')).toBeNull()
  })

  it('空数组是合法输入(等于清空)', () => {
    expect(normalizeImportedTree([])).toEqual({ tree: [], dropped: 0, reissued: 0 })
  })

  it('合法树原样保留,空标题书签用 url 兜底', () => {
    const raw = [
      { id: 'b1', type: 'bookmark', title: 'A', url: 'https://a.com' },
      { id: 'b2', type: 'bookmark', title: '  ', url: 'https://b.com' },
      { id: 'b3', type: 'bookmark', title: '内部页', url: 'bow://settings' },
      { id: 'f1', type: 'folder', title: '夹', children: [{ id: 'b4', type: 'bookmark', title: 'C', url: 'https://c.com' }] }
    ]
    const res = normalizeImportedTree(raw)
    expect(res).toMatchObject({ dropped: 0, reissued: 0 })
    expect(res?.tree[1]).toEqual({ id: 'b2', type: 'bookmark', title: 'https://b.com', url: 'https://b.com' })
    expect(res?.tree[3]).toMatchObject({ id: 'f1', type: 'folder', children: [{ id: 'b4' }] })
  })

  it('结构不合法的节点 / 非 http(s)·bow:// 的 url 被丢弃并计数', () => {
    const res = normalizeImportedTree([
      null,
      42,
      { id: 'b1', type: 'bookmark', title: '好', url: 'https://a.com' },
      { id: 'b2', type: 'bookmark', title: 'ftp', url: 'ftp://b.com' },
      { id: 'b3', type: 'bookmark', title: 'javascript', url: 'javascript:alert(1)' },
      { id: 'x', type: 'widget', title: '未知类型' },
      { id: 'b4', type: 'bookmark', title: '没有 url' }
    ])
    expect(res?.dropped).toBe(6)
    expect(res?.tree).toHaveLength(1)
  })

  it('id 缺失 / 重复 / 非字符串 → 重新发放(保证 move/remove 定位唯一)', () => {
    const res = normalizeImportedTree([
      { id: 'dup', type: 'bookmark', title: '1', url: 'https://a.com' },
      { id: 'dup', type: 'bookmark', title: '2', url: 'https://b.com' },
      { id: '  ', type: 'bookmark', title: '3', url: 'https://c.com' },
      { id: 7, type: 'bookmark', title: '4', url: 'https://d.com' }
    ])
    expect(res?.reissued).toBe(3)
    const ids = (res?.tree ?? []).map((n) => n.id)
    expect(ids).toContain('dup')
    expect(new Set(ids).size).toBe(4)
  })

  it('深层嵌套被压成一级目录(与激活时的迁移同一条不变量)', () => {
    const res = normalizeImportedTree([
      {
        id: 'f1',
        type: 'folder',
        title: 'A',
        children: [
          {
            id: 'f2',
            type: 'folder',
            title: 'B',
            children: [{ id: 'b1', type: 'bookmark', title: '深', url: 'https://deep.com' }]
          }
        ]
      }
    ])
    expect(res?.tree).toEqual([
      { id: 'f1', type: 'folder', title: 'A', children: [{ id: 'b1', type: 'bookmark', title: '深', url: 'https://deep.com' }] }
    ])
  })

  it('目录缺 children 当空目录(保留,用户可能有意建待整理)', () => {
    const res = normalizeImportedTree([{ id: 'f1', type: 'folder', title: '空' }])
    expect(res?.tree).toEqual([{ id: 'f1', type: 'folder', title: '空', children: [] }])
  })
})