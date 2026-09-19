/**
 * 标签组:标签栏里的**每一项就是一个组**,组里是一棵可任意嵌套的分屏布局树。
 *
 * - 普通组只有 1 个窗格(绝大多数情况),分屏组有 2..`MAX_GROUP_PANES` 个;
 * - `focus` 是**聚焦窗格的标签 id**(不是下标 —— 任意嵌套下「第几槽」没有意义),地址栏/前进后退跟着它走;
 * - 组空了就被移除(不存在「空组」这种状态)。
 *
 * 这里是**纯记账**(不碰 Electron、不碰视图):树操作全部委托给 `@shared/split`,
 * `TabManager` 只负责把树映射成视图可见性与 bounds、发事件。单测在 `tests/groups.test.ts`。
 */

import type { LayoutNode, PaneDir } from './split'
import { hasPane, paneTabIds, removePane, replacePane, splitPane } from './split'

export interface TabGroup {
  id: number
  /** 窗格布局树(叶子 = 标签 id;先序遍历 = 标签栏里的窗格顺序) */
  tree: LayoutNode
  /** 聚焦的窗格(恒是树里的一个叶子) */
  focus: number
}

/** 组内窗格标签 id(阅读顺序) */
export function groupTabIds(group: TabGroup): number[] {
  return paneTabIds(group.tree)
}

export function findGroupOfTab(groups: readonly TabGroup[], tabId: number): TabGroup | null {
  return groups.find((g) => hasPane(g.tree, tabId)) ?? null
}

export function findGroup(groups: readonly TabGroup[], groupId: number): TabGroup | null {
  return groups.find((g) => g.id === groupId) ?? null
}

/** 组内当前聚焦的窗格标签 id;`focus` 漂移出树(不该发生)时退到阅读顺序的第一个叶子 */
export function focusedTabId(group: TabGroup): number | null {
  if (hasPane(group.tree, group.focus)) return group.focus
  return paneTabIds(group.tree)[0] ?? null
}

/** 造一个新组(单窗格) */
export function newTabGroup(id: number, tabId: number): TabGroup {
  return { id, tree: { kind: 'leaf', tabId }, focus: tabId }
}

/** 把焦点挪到某个窗格上(标签必须在某个组里;不在就原样返回) */
export function focusTab(groups: readonly TabGroup[], tabId: number): TabGroup[] {
  return groups.map((g) => (hasPane(g.tree, tabId) && g.focus !== tabId ? { ...g, focus: tabId } : g))
}

/**
 * 在目标组的某个窗格上分屏(新标签 `newTabId`,位置按 `dir`);新窗格成为聚焦窗格。
 * 目标组不存在 / `focusedTabId` 不在树里时原样返回。
 */
export function splitGroup(
  groups: readonly TabGroup[],
  groupId: number,
  focusedTabId: number,
  dir: PaneDir,
  newTabId: number
): TabGroup[] {
  const target = findGroup(groups, groupId)
  if (!target || !hasPane(target.tree, focusedTabId)) return [...groups]
  return groups.map((g) =>
    g.id === groupId ? { ...g, tree: splitPane(g.tree, focusedTabId, dir, newTabId), focus: newTabId } : g
  )
}

/**
 * 把一个窗格标签**原地换掉**(终端「顶替当前聚焦窗格」打开用):树结构与几何不变,只换叶子。
 * 旧 id 是聚焦窗格时,焦点跟着换到新 id。标签不在任何组里时原样返回。
 */
export function replaceTabInGroups(groups: readonly TabGroup[], oldTabId: number, newTabId: number): TabGroup[] {
  const group = findGroupOfTab(groups, oldTabId)
  if (!group) return [...groups]
  return groups.map((g) =>
    g.id === group.id
      ? { ...g, tree: replacePane(g.tree, oldTabId, newTabId), focus: g.focus === oldTabId ? newTabId : g.focus }
      : g
  )
}

/**
 * 从组里移除一个窗格(关标签 / `destroyed`)。
 * 容器只剩一个孩子时塌缩;组空了就整组移除;返回的 `focusTabId` 是移除后该组聚焦的窗格(组没了则为 null),
 * `removedGroupId` 非空表示这个组消失了(调用方需要另挑一个活动组)。
 */
export function removeTabFromGroups(
  groups: readonly TabGroup[],
  tabId: number
): { groups: TabGroup[]; removedGroupId: number | null; focusTabId: number | null } {
  const group = findGroupOfTab(groups, tabId)
  if (!group) return { groups: [...groups], removedGroupId: null, focusTabId: null }
  const { root, nextFocusTabId } = removePane(group.tree, tabId)
  if (root == null) {
    return {
      groups: groups.filter((g) => g.id !== group.id),
      removedGroupId: group.id,
      focusTabId: null
    }
  }
  const kept: TabGroup = { ...group, tree: root, focus: nextFocusTabId ?? paneTabIds(root)[0] ?? group.focus }
  return {
    groups: groups.map((g) => (g.id === group.id ? kept : g)),
    removedGroupId: null,
    focusTabId: kept.focus
  }
}

/**
 * 取消分屏:把组里的 N 个窗格拆成**相邻的 N 个单标签组**(顺序 = 阅读顺序,标签都不销毁)。
 * 第一个新组沿用原来的组 id;其余用调用方给的 `newGroupIds`(需要 N-1 个,不够就原样返回)。
 */
export function ungroup(groups: readonly TabGroup[], groupId: number, newGroupIds: readonly number[]): TabGroup[] {
  const i = groups.findIndex((g) => g.id === groupId)
  if (i < 0) return [...groups]
  const group = groups[i]
  const ids = paneTabIds(group.tree)
  if (ids.length < 2) return [...groups]
  if (newGroupIds.length < ids.length - 1) return [...groups]
  const made: TabGroup[] = ids.map((tabId, n) => ({
    id: n === 0 ? group.id : newGroupIds[n - 1],
    tree: { kind: 'leaf', tabId },
    focus: tabId
  }))
  return [...groups.slice(0, i), ...made, ...groups.slice(i + 1)]
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
