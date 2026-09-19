/** 标签组记账:加/摘/挤/拆/焦点/插入位置/邻居回落 */

import { describe, expect, it } from 'vitest'
import {
  MAX_GROUP_TABS,
  addTabToGroup,
  findGroup,
  findGroupOfTab,
  focusTab,
  focusedTabId,
  insertIndexAfterGroup,
  neighborGroupIdAfterRemoval,
  newTabGroup,
  removeTabFromGroups,
  setGroupLevel,
  ungroup
} from '../src/shared/groups'
import type { TabGroup } from '../src/shared/groups'
import { DEFAULT_SPLIT_LEVEL } from '../src/shared/split'

const L = { value: 50, unit: 'percent' } as const

/** 组字面量速写:[groupId, [tabIds], focus] */
function g(id: number, tabIds: number[], focus = 0, level = L): TabGroup {
  return { id, tabIds, focus, level: { ...level }, presetId: null }
}

describe('findGroupOfTab / findGroup / focusedTabId', () => {
  const groups = [g(10, [1, 2], 1), g(11, [3])]

  it('按标签找组', () => {
    expect(findGroupOfTab(groups, 2)?.id).toBe(10)
    expect(findGroupOfTab(groups, 3)?.id).toBe(11)
    expect(findGroupOfTab(groups, 99)).toBeNull()
  })

  it('按 id 找组', () => {
    expect(findGroup(groups, 11)?.tabIds).toEqual([3])
    expect(findGroup(groups, 99)).toBeNull()
  })

  it('聚焦成员取 focus 下标', () => {
    expect(focusedTabId(groups[0])).toBe(2)
    expect(focusedTabId(groups[1])).toBe(3)
  })

  it('focus 越界时夹到最后一个(防御,不抛)', () => {
    expect(focusedTabId({ ...groups[0], focus: 9 })).toBe(2)
  })
})

describe('focusTab', () => {
  it('把焦点挪到指定标签,不动别的组,不改入参', () => {
    const groups = [g(10, [1, 2]), g(11, [3])]
    const next = focusTab(groups, 2)
    expect(next[0].focus).toBe(1)
    expect(next[1]).toEqual(groups[1])
    expect(groups[0].focus).toBe(0)
  })

  it('已经是焦点 / 标签不存在 → 原样', () => {
    const groups = [g(10, [1, 2]), g(11, [3])]
    expect(focusTab(groups, 1)).toEqual(groups)
    expect(focusTab(groups, 99)).toEqual(groups)
  })
})

describe('addTabToGroup', () => {
  it('单标签组 + 新标签 → 新标签进右槽,焦点留在右槽(左 = 原来的标签)', () => {
    const { groups, evicted } = addTabToGroup([g(1, [10])], 1, 20, 99)
    expect(evicted).toBeNull()
    expect(groups).toEqual([g(1, [10, 20], 1)])
  })

  it('焦点在左半时加标签 → 焦点标签仍占左槽', () => {
    const { groups } = addTabToGroup([g(1, [10, 11], 0)], 1, 20, 99)
    // 11 被挤出去,10(聚焦的)留在左边
    expect(groups[0]).toEqual(g(1, [10, 20], 1))
  })

  it('焦点在右半时加标签 → 焦点标签挪到左槽,新标签进右槽', () => {
    const { groups, evicted } = addTabToGroup([g(1, [10, 11], 1)], 1, 20, 99)
    expect(groups[0]).toEqual(g(1, [11, 20], 1))
    expect(evicted).toBe(10)
  })

  it('被挤出去的成员在本组后面成为新的单标签组(继承档位)', () => {
    const groups = [g(1, [10, 11], 1, { value: 800, unit: 'px' }), g(2, [30])]
    const res = addTabToGroup(groups, 1, 20, 99)
    expect(res.evicted).toBe(10)
    expect(res.groups.map((x) => x.id)).toEqual([1, 99, 2])
    expect(res.groups[1]).toEqual({
      id: 99,
      tabIds: [10],
      focus: 0,
      level: { value: 800, unit: 'px' },
      presetId: null
    })
  })

  it('从别的组拿标签:原组降级为单标签,目标组拼成一对', () => {
    const groups = [g(1, [10, 11], 0), g(2, [30])]
    const res = addTabToGroup(groups, 2, 11, 99)
    expect(res.evicted).toBeNull()
    expect(res.groups).toEqual([g(1, [10]), g(2, [30, 11], 1)])
  })

  it('从别的组拿走最后一个标签 → 那个组直接消失', () => {
    const groups = [g(1, [10, 11], 0), g(2, [30])]
    // 把 10 拿走:组 1 还剩 11,不消失;换成单标签的组 2 拿走就消失
    const res = addTabToGroup([g(1, [10]), g(2, [30])], 1, 30, 99)
    expect(res.groups).toEqual([g(1, [10, 30], 1)])
  })

  it('标签已在目标组里 → 不动', () => {
    const groups = [g(1, [10, 11], 0)]
    expect(addTabToGroup(groups, 1, 11, 99).groups).toEqual(groups)
  })

  it('目标组不存在 → 原样返回', () => {
    const groups = [g(1, [10])]
    expect(addTabToGroup(groups, 42, 10, 99).groups).toEqual(groups)
  })

  it('MAX_GROUP_TABS 就是 2(这条只是把常量钉住,改大要连带改布局)', () => {
    expect(MAX_GROUP_TABS).toBe(2)
  })
})

describe('removeTabFromGroups', () => {
  it('关掉聚焦那半 → 组降级为单标签,焦点给幸存的那个', () => {
    const res = removeTabFromGroups([g(1, [10, 11], 1), g(2, [30])], 11)
    expect(res.groups).toEqual([g(1, [10]), g(2, [30])])
    expect(res.removedGroupId).toBeNull()
    expect(res.focusTabId).toBe(10)
  })

  it('关掉非聚焦那半 → 焦点仍是原来那个', () => {
    const res = removeTabFromGroups([g(1, [10, 11], 1)], 10)
    expect(res.groups).toEqual([g(1, [11])])
    expect(res.focusTabId).toBe(11)
  })

  it('关掉组里最后一个标签 → 整组移除并报出组 id', () => {
    const res = removeTabFromGroups([g(1, [10]), g(2, [30])], 10)
    expect(res.groups).toEqual([g(2, [30])])
    expect(res.removedGroupId).toBe(1)
    expect(res.focusTabId).toBeNull()
  })

  it('标签不存在 → 原样', () => {
    const groups = [g(1, [10])]
    const res = removeTabFromGroups(groups, 99)
    expect(res.groups).toEqual(groups)
    expect(res.removedGroupId).toBeNull()
  })
})

describe('ungroup', () => {
  it('拆成相邻的两个单标签组,保持左右顺序并继承档位', () => {
    const groups = [g(0, [9]), g(1, [10, 11], 1, { value: 800, unit: 'px' }), g(2, [30])]
    const next = ungroup(groups, 1, 99)
    expect(next.map((x) => [x.id, x.tabIds])).toEqual([
      [0, [9]],
      [1, [10]],
      [99, [11]],
      [2, [30]]
    ])
    expect(next[1].level).toEqual({ value: 800, unit: 'px' })
    expect(next[2].level).toEqual({ value: 800, unit: 'px' })
    expect(next[1].focus).toBe(0)
    expect(next[2].focus).toBe(0)
  })

  it('单标签组 / 不存在的组 → 原样', () => {
    const groups = [g(1, [10]), g(2, [30])]
    expect(ungroup(groups, 1, 99)).toEqual(groups)
    expect(ungroup(groups, 42, 99)).toEqual(groups)
  })
})

describe('setGroupLevel', () => {
  it('只改目标组', () => {
    const groups = [g(1, [10]), g(2, [30])]
    const next = setGroupLevel(groups, 2, { value: 900, unit: 'px' }, 'x800')
    expect(next[1].level).toEqual({ value: 900, unit: 'px' })
    expect(next[1].presetId).toBe('x800')
    expect(next[0]).toEqual(groups[0])
  })
})

describe('insertIndexAfterGroup', () => {
  it('插在指定组后面 / 无活动组时放最后', () => {
    const groups = [g(1, [10]), g(2, [30]), g(3, [40])]
    expect(insertIndexAfterGroup(groups, 2)).toBe(2)
    expect(insertIndexAfterGroup(groups, 3)).toBe(3)
    expect(insertIndexAfterGroup(groups, null)).toBe(3)
    expect(insertIndexAfterGroup(groups, 42)).toBe(3)
    expect(insertIndexAfterGroup([], null)).toBe(0)
  })
})

describe('neighborGroupIdAfterRemoval', () => {
  it('优先后一个,没有就前一个', () => {
    const groups = [g(1, [10]), g(2, [30]), g(3, [40])]
    expect(neighborGroupIdAfterRemoval(groups, [2])).toBe(3)
    expect(neighborGroupIdAfterRemoval(groups, [3])).toBe(2) // 最后一个 → 前一个
    expect(neighborGroupIdAfterRemoval(groups, [1])).toBe(2)
    expect(neighborGroupIdAfterRemoval(groups, [1, 2, 3])).toBeNull()
    expect(neighborGroupIdAfterRemoval([], [1])).toBeNull()
    expect(neighborGroupIdAfterRemoval(groups, [99])).toBeNull()
  })

  it('连续移除多个时跳过它们', () => {
    const groups = [g(1, [10]), g(2, [30]), g(3, [40]), g(4, [50])]
    expect(neighborGroupIdAfterRemoval(groups, [2, 3])).toBe(4)
  })
})

describe('newTabGroup', () => {
  it('单标签、焦点 0、档位是给的副本(默认 50%)', () => {
    const a = newTabGroup(5, 7, DEFAULT_SPLIT_LEVEL)
    expect(a).toEqual({ id: 5, tabIds: [7], focus: 0, level: { value: 50, unit: 'percent' }, presetId: null })
    expect(a.level).not.toBe(DEFAULT_SPLIT_LEVEL)
  })
})
