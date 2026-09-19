/**
 * 标签组:标签栏里的**每一项就是一个组**。
 *
 * - 普通组只有 1 个标签(绝大多数情况),分屏组有 2 个(顺序 = 左窗格在前);
 * - 组内有一个「聚焦成员」(`focus` 下标) —— 地址栏、前进后退都跟着它走;
 * - 组空了就被移除(不存在「空组」这种状态);
 * - 每个组自带分屏宽度档位(`level`/`presetId`),单标签组也保留着,下一次拼进第二个标签时直接用。
 *
 * 这里是**纯记账**(不碰 Electron、不碰视图):`TabManager` 负责把数组映射成视图可见性与 bounds、
 * 发事件;单测在 `tests/groups.test.ts`(`docs/ARCHITECTURE.md` §11 的约定:纯逻辑必须能脱离 Electron 跑)。
 */

import type { SplitLevel } from './split'

export interface TabGroup {
  id: number
  /** 成员标签 id(1..MAX_GROUP_TABS 个),顺序 = 左窗格在前 */
  tabIds: number[]
  /** 聚焦成员的下标(恒在 `tabIds` 范围内) */
  focus: number
  /** 该组的窗格宽度档位(拼第二个标签时用) */
  level: SplitLevel
  presetId: string | null
}

/** 一个组最多几个标签(= 几个窗格);想支持上下分屏/多窗格得先改这里和 `computeSplitBounds` 的调用方 */
export const MAX_GROUP_TABS = 2

export function findGroupOfTab(groups: readonly TabGroup[], tabId: number): TabGroup | null {
  return groups.find((g) => g.tabIds.includes(tabId)) ?? null
}

export function findGroup(groups: readonly TabGroup[], groupId: number): TabGroup | null {
  return groups.find((g) => g.id === groupId) ?? null
}

/** 组内当前聚焦的标签 id;空组(不该存在)返回 null */
export function focusedTabId(group: TabGroup): number | null {
  return group.tabIds[Math.min(group.focus, group.tabIds.length - 1)] ?? null
}

/** 组内除聚焦成员之外的那个(只有分屏组才有) */
function otherTabId(group: TabGroup): number | null {
  const focused = focusedTabId(group)
  return group.tabIds.find((id) => id !== focused) ?? null
}

/** 造一个新组(单标签) */
export function newTabGroup(
  id: number,
  tabId: number,
  level: SplitLevel,
  presetId: string | null = null
): TabGroup {
  return { id, tabIds: [tabId], focus: 0, level: { ...level }, presetId }
}

/** 把焦点挪到某个标签上(标签必须在某个组里;不在就原样返回) */
export function focusTab(groups: readonly TabGroup[], tabId: number): TabGroup[] {
  return groups.map((g) => {
    const i = g.tabIds.indexOf(tabId)
    return i >= 0 && i !== g.focus ? { ...g, focus: i } : g
  })
}

/**
 * 往组里加一个标签(分屏面板的「在右侧打开」):
 *
 * 1. 新标签**固定进右槽**,原来的聚焦成员留在左槽 ⇒ 点任何候选,「我一直在看的那页」都不会跳;
 * 2. 组已经满了(2 个)时,原来的**非聚焦**成员被挤出去,自己在**本组后面**成为一个新的单标签组
 *    (调用方用 `evictedGroupId` 给它编 id)—— 不销毁标签,只是把它移出组;
 * 3. 该标签原本属于别的组时先摘掉(一个标签不能同时在两个组里);原组因此空了就消失。
 *
 * 返回新数组(不改入参)。`evicted` 非空时调用方已经消耗掉 `evictedGroupId`。
 */
export function addTabToGroup(
  groups: readonly TabGroup[],
  groupId: number,
  tabId: number,
  evictedGroupId: number
): { groups: TabGroup[]; evicted: number | null } {
  const source = findGroupOfTab(groups, tabId)
  if (source && source.id === groupId) return { groups: [...groups], evicted: null }
  // 先摘掉,否则同一个标签会同时出现在两个组里
  let next = source ? removeTabFromGroups(groups, tabId).groups : [...groups]
  const i = next.findIndex((g) => g.id === groupId)
  if (i < 0) return { groups: [...groups], evicted: null } // 目标组已不存在(不该发生)
  const target = next[i]
  const focused = focusedTabId(target)
  if (focused == null) return { groups: [...groups], evicted: null }
  const evicted = target.tabIds.length >= MAX_GROUP_TABS ? otherTabId(target) : null
  next[i] = { ...target, tabIds: [focused, tabId], focus: 1 }
  if (evicted != null) {
    next = [
      ...next.slice(0, i + 1),
      newTabGroup(evictedGroupId, evicted, target.level, target.presetId),
      ...next.slice(i + 1)
    ]
  }
  return { groups: next, evicted }
}

/**
 * 从组里移除一个标签(关标签 / `destroyed`)。
 * 组空了就整组移除;返回的 `focusTabId` 是移除后该组聚焦的成员(组没了则为 null),
 * `removedGroupId` 非空表示这个组消失了(调用方需要另挑一个活动组)。
 */
export function removeTabFromGroups(
  groups: readonly TabGroup[],
  tabId: number
): { groups: TabGroup[]; removedGroupId: number | null; focusTabId: number | null } {
  const group = findGroupOfTab(groups, tabId)
  if (!group) return { groups: [...groups], removedGroupId: null, focusTabId: null }
  const tabIds = group.tabIds.filter((id) => id !== tabId)
  if (tabIds.length === 0) {
    return {
      groups: groups.filter((g) => g.id !== group.id),
      removedGroupId: group.id,
      focusTabId: null
    }
  }
  // 移掉之后成员恒为 1 个(MAX_GROUP_TABS=2),焦点回到剩下的那个
  const kept: TabGroup = { ...group, tabIds, focus: 0 }
  return {
    groups: groups.map((g) => (g.id === group.id ? kept : g)),
    removedGroupId: null,
    focusTabId: focusedTabId(kept)
  }
}

/**
 * 取消分屏:把 2 个成员的组拆成**相邻的两个单标签组**(两个标签都保留,保持原来的左右顺序),
 * 档位/预设两个组都继承。组里只有 1 个标签时原样返回。`newGroupId` 是右半新组的 id。
 */
export function ungroup(groups: readonly TabGroup[], groupId: number, newGroupId: number): TabGroup[] {
  const i = groups.findIndex((g) => g.id === groupId)
  if (i < 0) return [...groups]
  const group = groups[i]
  if (group.tabIds.length < 2) return [...groups]
  const [left, right] = group.tabIds
  return [
    ...groups.slice(0, i),
    { ...group, tabIds: [left], focus: 0 },
    newTabGroup(newGroupId, right, group.level, group.presetId),
    ...groups.slice(i + 1)
  ]
}

/** 设置某组的宽度档位(套用预设) */
export function setGroupLevel(
  groups: readonly TabGroup[],
  groupId: number,
  level: SplitLevel,
  presetId: string | null
): TabGroup[] {
  return groups.map((g) => (g.id === groupId ? { ...g, level: { ...level }, presetId } : g))
}

/**
 * 新标签插到哪:紧跟在活动组后面(与「新标签开在当前标签右边」的习惯一致);
 * 没有活动组就放最后。返回插入下标。
 */
export function insertIndexAfterGroup(groups: readonly TabGroup[], afterGroupId: number | null): number {
  if (afterGroupId == null) return groups.length
  const i = groups.findIndex((g) => g.id === afterGroupId)
  return i < 0 ? groups.length : i + 1
}

/**
 * 关掉/移除一个组之后该激活谁:优先**后一个**,没有就前一个(都按移除前的顺序算)。
 * `removedIds` 是本轮被移除的组 id(可能不止一个)。
 */
export function neighborGroupIdAfterRemoval(
  before: readonly TabGroup[],
  removedIds: readonly number[]
): number | null {
  if (before.length === 0) return null
  const removed = new Set(removedIds)
  const firstRemoved = before.findIndex((g) => removed.has(g.id))
  if (firstRemoved < 0) return null
  for (let i = firstRemoved; i < before.length; i += 1) {
    if (!removed.has(before[i].id)) return before[i].id
  }
  for (let i = firstRemoved - 1; i >= 0; i -= 1) {
    if (!removed.has(before[i].id)) return before[i].id
  }
  return null
}
