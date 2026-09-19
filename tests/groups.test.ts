/** 标签组记账(树版):分屏/摘窗格/塌缩/焦点/N 叶拆组 */

import { describe, expect, it } from 'vitest'
import {
  findGroup,
  findGroupOfTab,
  focusTab,
  focusedTabId,
  groupTabIds,
  insertIndexAfterGroup,
  neighborGroupIdAfterRemoval,
  newTabGroup,
  removeTabFromGroups,
  splitGroup,
  ungroup
} from '../src/shared/groups'
import type { TabGroup } from '../src/shared/groups'
import { leaf, paneTabIds } from '../src/shared/split'
import type { LayoutNode } from '../src/shared/split'

const row = (a: LayoutNode, b: LayoutNode, ratio = 0.5): LayoutNode => ({ kind: 'split', axis: 'row', ratio, a, b })
const col = (a: LayoutNode, b: LayoutNode, ratio = 0.5): LayoutNode => ({
  kind: 'split',
  axis: 'column',
  ratio,
  a,
  b
})

/** 组字面量速写:[groupId, tree, focus] */
function g(id: number, tree: LayoutNode, focus = paneTabIds(tree)[0]): TabGroup {
  return { id, tree, focus }
}
/** 单窗格组的速写 */
function solo(id: number, tabId: number): TabGroup {
  return newTabGroup(id, tabId)
}

describe('findGroupOfTab / findGroup / focusedTabId / groupTabIds', () => {
  const groups = [g(10, row(leaf(1), leaf(2)), 2), solo(11, 3)]

  it('按标签找组(任意深度)', () => {
    expect(findGroupOfTab(groups, 1)?.id).toBe(10)
    expect(findGroupOfTab(groups, 2)?.id).toBe(10)
    expect(findGroupOfTab(groups, 3)?.id).toBe(11)
    expect(findGroupOfTab(groups, 99)).toBeNull()
  })

  it('按 id 找组', () => {
    expect(findGroup(groups, 11)?.tree).toEqual(leaf(3))
    expect(findGroup(groups, 99)).toBeNull()
  })

  it('聚焦窗格 / 组内窗格顺序', () => {
    expect(focusedTabId(groups[0])).toBe(2)
    expect(focusedTabId(groups[1])).toBe(3)
    expect(groupTabIds(groups[0])).toEqual([1, 2])
  })

  it('focus 漂移出树时退到阅读顺序的第一个叶子(防御,不抛)', () => {
    expect(focusedTabId({ ...groups[0], focus: 99 })).toBe(1)
  })
})

describe('newTabGroup', () => {
  it('单窗格、焦点就是它', () => {
    expect(newTabGroup(5, 7)).toEqual({ id: 5, tree: { kind: 'leaf', tabId: 7 }, focus: 7 })
  })
})

describe('focusTab', () => {
  it('把焦点挪到指定窗格,不动别的组,不改入参', () => {
    const groups = [g(10, row(leaf(1), leaf(2)), 1), solo(11, 3)]
    const next = focusTab(groups, 2)
    expect(next[0].focus).toBe(2)
    expect(next[1]).toBe(groups[1])
    expect(groups[0].focus).toBe(1)
  })

  it('已经是焦点 / 标签不存在 → 原样(引用不变)', () => {
    const groups = [g(10, row(leaf(1), leaf(2)), 1)]
    expect(focusTab(groups, 1)[0]).toBe(groups[0])
    expect(focusTab(groups, 99)[0]).toBe(groups[0])
  })
})

describe('splitGroup', () => {
  it('单窗格组分屏 → 两窗格,新窗格是聚焦窗格', () => {
    const groups = [solo(1, 10)]
    const next = splitGroup(groups, 1, 10, 'right', 20)
    expect(next[0]).toEqual({ id: 1, tree: row(leaf(10), leaf(20)), focus: 20 })
  })

  it('方向决定新窗格在 a 还是 b 侧', () => {
    expect(splitGroup([solo(1, 10)], 1, 10, 'left', 20)[0].tree).toEqual(row(leaf(20), leaf(10)))
    expect(splitGroup([solo(1, 10)], 1, 10, 'up', 20)[0].tree).toEqual(col(leaf(20), leaf(10)))
    expect(splitGroup([solo(1, 10)], 1, 10, 'down', 20)[0].tree).toEqual(col(leaf(10), leaf(20)))
  })

  it('在深处窗格上分屏:只动目标组', () => {
    const groups = [g(1, col(row(leaf(1), leaf(2)), leaf(3)), 2), solo(2, 9)]
    const next = splitGroup(groups, 1, 2, 'down', 20)
    expect(next[0].tree).toEqual(col(row(leaf(1), col(leaf(2), leaf(20))), leaf(3)))
    expect(next[0].focus).toBe(20)
    expect(next[1]).toBe(groups[1])
  })

  it('目标组不存在 / 窗格不在树里 → 原样(新数组,元素引用不变)', () => {
    const groups = [solo(1, 10)]
    const missGroup = splitGroup(groups, 42, 10, 'right', 20)
    expect(missGroup).toEqual(groups)
    expect(missGroup[0]).toBe(groups[0])
    const missTab = splitGroup(groups, 1, 99, 'right', 20)
    expect(missTab[0]).toBe(groups[0])
  })
})

describe('removeTabFromGroups', () => {
  it('关掉聚焦窗格 → 组降级,焦点交给阅读顺序的下一个', () => {
    const res = removeTabFromGroups([g(1, row(leaf(10), leaf(11)), 11), solo(2, 30)], 11)
    expect(res.groups).toEqual([g(1, leaf(10)), solo(2, 30)])
    expect(res.removedGroupId).toBeNull()
    expect(res.focusTabId).toBe(10)
  })

  it('关掉非聚焦窗格 → 焦点仍是原来那个', () => {
    const res = removeTabFromGroups([g(1, row(leaf(10), leaf(11)), 11)], 10)
    expect(res.groups).toEqual([g(1, leaf(11), 11)])
    expect(res.focusTabId).toBe(11)
  })

  it('三窗格去掉中间那个:容器塌缩,焦点给阅读顺序的下一个', () => {
    const res = removeTabFromGroups([g(1, row(leaf(10), col(leaf(11), leaf(12))), 11)], 11)
    expect(res.groups).toEqual([g(1, row(leaf(10), leaf(12)), 12)])
    expect(res.focusTabId).toBe(12)
  })

  it('去掉最后一个窗格 → 整组移除并报出组 id', () => {
    const res = removeTabFromGroups([solo(1, 10), solo(2, 30)], 10)
    expect(res.groups).toEqual([solo(2, 30)])
    expect(res.removedGroupId).toBe(1)
    expect(res.focusTabId).toBeNull()
  })

  it('标签不存在 → 原样', () => {
    const groups = [solo(1, 10)]
    const res = removeTabFromGroups(groups, 99)
    expect(res.groups).toEqual(groups)
    expect(res.groups[0]).toBe(groups[0])
    expect(res.removedGroupId).toBeNull()
  })
})

describe('ungroup', () => {
  it('N 个窗格拆成相邻的 N 个单标签组(阅读顺序、第一个沿用原 id)', () => {
    const groups = [solo(0, 9), g(1, row(leaf(10), col(leaf(11), leaf(12))), 12), solo(2, 30)]
    const next = ungroup(groups, 1, [99, 98])
    expect(next.map((x) => [x.id, paneTabIds(x.tree)])).toEqual([
      [0, [9]],
      [1, [10]],
      [99, [11]],
      [98, [12]],
      [2, [30]]
    ])
    expect(next[1].focus).toBe(10)
    expect(next[2].focus).toBe(11)
  })

  it('单窗格组 / 不存在的组 → 原样', () => {
    const groups = [solo(1, 10), solo(2, 30)]
    expect(ungroup(groups, 1, [99])).toEqual(groups)
    expect(ungroup(groups, 42, [99])).toEqual(groups)
  })

  it('给的 id 不够(N-1 个以下)→ 原样,不产出半截结果', () => {
    const groups = [g(1, row(leaf(10), col(leaf(11), leaf(12))), 11)]
    expect(ungroup(groups, 1, [99])).toEqual(groups)
  })
})

describe('insertIndexAfterGroup', () => {
  it('插在指定组后面 / 无活动组时放最后', () => {
    const groups = [solo(1, 10), solo(2, 30), solo(3, 40)]
    expect(insertIndexAfterGroup(groups, 2)).toBe(2)
    expect(insertIndexAfterGroup(groups, 3)).toBe(3)
    expect(insertIndexAfterGroup(groups, null)).toBe(3)
    expect(insertIndexAfterGroup(groups, 42)).toBe(3)
    expect(insertIndexAfterGroup([], null)).toBe(0)
  })
})

describe('neighborGroupIdAfterRemoval', () => {
  it('优先后一个,没有就前一个', () => {
    const groups = [solo(1, 10), solo(2, 30), solo(3, 40)]
    expect(neighborGroupIdAfterRemoval(groups, [2])).toBe(3)
    expect(neighborGroupIdAfterRemoval(groups, [3])).toBe(2) // 最后一个 → 前一个
    expect(neighborGroupIdAfterRemoval(groups, [1])).toBe(2)
    expect(neighborGroupIdAfterRemoval(groups, [1, 2, 3])).toBeNull()
    expect(neighborGroupIdAfterRemoval([], [1])).toBeNull()
    expect(neighborGroupIdAfterRemoval(groups, [99])).toBeNull()
  })

  it('连续移除多个时跳过它们', () => {
    const groups = [solo(1, 10), solo(2, 30), solo(3, 40), solo(4, 50)]
    expect(neighborGroupIdAfterRemoval(groups, [2, 3])).toBe(4)
  })
})
