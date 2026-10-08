# 关掉标签组 → 激活**前一个**组(而不是后一个)

## 1. 目标与假设

**目标**:关掉标签栏里的一个组(该组是活动组、且组被关空)后,激活标签栏**位置在前(左)**的那一组;
只有前面没有组可用了才回落到后一组。

**假设/口径(已与用户确认)**
- 只改**组间**规则。组内窗格关掉后的焦点回落(`split.ts:159`,「下一个优先,没有才上一个」)**不动**。
- 「前一个」= 标签栏位置上的前一个(`groups` 数组里下标更小的那一项),不是「上次访问过的组(MRU)」。
- 关掉的组**不是**活动组时,活动组不移动(现状如此,保持)。

## 2. 现状(实际读到的代码)

唯一的决策点是纯函数 `src/shared/groups.ts:155-173`,现在**优先后一个**:

```ts
export function neighborGroupIdAfterRemoval(
  before: readonly TabGroup[],
  removedIds: readonly number[]
): number | null {
  if (before.length === 0) return null
  const removed = new Set(removedIds)
  const firstRemoved = before.findIndex((g) => removed.has(g.id))
  if (firstRemoved < 0) return null
  for (let i = firstRemoved; i < before.length; i += 1) {   // ← 先往后找
    if (!removed.has(before[i].id)) return before[i].id
  }
  for (let i = firstRemoved - 1; i >= 0; i -= 1) {          // ← 再往前找
    if (!removed.has(before[i].id)) return before[i].id
  }
  return null
}
```

它的注释也写死了这个方向:「优先**后一个**,没有就前一个」。

唯一调用方 `src/main/tabManager.ts:724-745`(`unregisterTab`,由 `close()` 与标签 `destroyed` 共用):

```ts
} else if (wasActive && res.removedGroupId != null) {
  // 整个组没了:切到最近的邻组
  const nextGroupId = neighborGroupIdAfterRemoval(before, [res.removedGroupId])
  const next = nextGroupId != null ? this.groups.find((g) => g.id === nextGroupId) ?? null : null
  const focus = next ? focusedTabId(next) : null
  if (focus != null) this.activate(focus)
  else this.activateLastVisible()
}
```

> 注意:`activateLastVisible()`(取 id 最大的标签)**只在 `neighborGroupIdAfterRemoval` 返回 null(所有组都没了)时**才走;
> 关中间/最后一个组时不会走到它。所以「激活最后一个 tab」的观感来自上面这条**优先后一组**的规则。

只被 `tabManager.ts` 与 `tests/groups.test.ts` 引用(全仓库 grep 确认无其他调用方)。

## 3. 改动清单

| 文件 | 改什么 |
| --- | --- |
| `src/shared/groups.ts` | `neighborGroupIdAfterRemoval` 两个查找循环**互换顺序**;函数注释改成「优先前一个,没有就后一个」 |
| `src/main/tabManager.ts` | 两处注释(`:720` 「活动组换到**最近的邻组**」、`:734` 「切到最近的邻组」)改成「换回**前一个**邻组(前面没有才用后一个)」。**逻辑不变** |
| `tests/groups.test.ts` | `describe('neighborGroupIdAfterRemoval')` 的标题与 3 条期望值跟着方向翻转;补一条「向前跳过多组」的用例 |
| `README.md` | `:490-491` 的 `Ctrl+W` 那条末尾补一句「组因此整项消失时,活动组落到**左边那一项**(没有左边才用右边)」 |

不需要改:`src/shared/split.ts`(组内窗格规则不动)、`tabShortcuts.ts` / `ipc.ts` / preload / 渲染层(全部只是 `close(id)`),
`docs/ARCHITECTURE.md`(全篇没有描述这个方向的句子,已 grep 确认)。

## 4. 步骤(每步可独立验证)

### 步骤 1 — 翻转纯函数的查找方向
文件:`src/shared/groups.ts`

把两个 `for` 循环对调,并改注释:

```ts
/**
 * 关掉/移除一个组之后该激活谁:优先**前一个**,没有就后一个(都按移除前的顺序算)。
 * `removedIds` 是本轮被移除的组 id(可能不止一个),相邻的已移除项要跳过去。
 */
export function neighborGroupIdAfterRemoval(
  before: readonly TabGroup[],
  removedIds: readonly number[]
): number | null {
  if (before.length === 0) return null
  const removed = new Set(removedIds)
  const firstRemoved = before.findIndex((g) => removed.has(g.id))
  if (firstRemoved < 0) return null
  for (let i = firstRemoved - 1; i >= 0; i -= 1) {          // ← 先往前找
    if (!removed.has(before[i].id)) return before[i].id
  }
  for (let i = firstRemoved; i < before.length; i += 1) {   // ← 没有前一个才往后找
    if (!removed.has(before[i].id)) return before[i].id
  }
  return null
}
```

验证:读一遍 diff,确认除了循环顺序与注释外没有任何其他变化(返回 `null` 的三个前置分支保持原样)。

### 步骤 2 — 同步主进程的注释(不改逻辑)
文件:`src/main/tabManager.ts`

- `:720`(`unregisterTab` 的 doc):`- 组空了 → 整组移除,活动组换到**最近的邻组**;`
  → `- 组空了 → 整组移除,活动组换回**前一个**邻组(前面没有才用后一个);`
- `:734`(内联注释):`// 整个组没了:切到最近的邻组`
  → `// 整个组没了:切回前一个邻组(前面没有才用后一个;都没有才是 activateLastVisible)`
- `:409`(`destroyed` 处理器里那句「组空了就整组消失并切到邻组」)方向无关,可不动;要改就一并写「切到前一个邻组」。

验证:`grep -n "邻组" src/main/tabManager.ts` 三处口径一致。

### 步骤 3 — 更新单测
文件:`tests/groups.test.ts:219-233`

`groups = [solo(1,10), solo(2,30), solo(3,40)]`:

| 调用 | 旧期望 | 新期望 | 说明 |
| --- | --- | --- | --- |
| `([2])` | 3 | **1** | 关中间项 → 左边那项 |
| `([3])` | 2 | 2 | 关最后一项 → 前一个(不变) |
| `([1])` | 2 | 2 | 关第一项 → 没有前一个,回落后一个(不变) |
| `([1,2,3])` | null | null | 全没了 |
| `([])` / `([99])` | null | null | 边界 |

`describe` 标题改成 `'优先前一个,没有就后一个'`;第二条用例(`[solo(1,10), solo(2,30), solo(3,40), solo(4,50)]`,移除 `[2,3]`)
由 `toBe(4)` 改成 `toBe(1)`;再补一条:

```ts
it('向前找时跳过相邻的多个已移除组', () => {
  const groups = [solo(1, 10), solo(2, 30), solo(3, 40), solo(4, 50)]
  expect(neighborGroupIdAfterRemoval(groups, [3, 4])).toBe(2)
  expect(neighborGroupIdAfterRemoval(groups, [1, 2])).toBe(3) // 前面没了 → 后一个
})
```

验证:`npx vitest run tests/groups.test.ts` 全绿(groups 那组 26→27 例左右);再 `npm test` 全仓库绿。

### 步骤 4 — 补一句文档
文件:`README.md:490-491`,把那条 bullet 结尾改成:

```
- `Ctrl+W` / 标签上的 × / 中键点项体 = 关掉**聚焦的那个窗格**:它所在的节点会塌缩(剩下的兄弟顶替它占满那块地方),
  焦点落到阅读顺序里的下一个窗格;把组里最后一个窗格也关掉,这一项就消失,活动组落到**左边那一项**(没有左边才用右边)。
```

验证:`grep -n "左边那一项" README.md` 命中;README 其它地方没有相反的描述(已 grep「邻组/最近」确认无冲突)。

### 步骤 5 — 真机/真 Electron 冒烟(可选但推荐)
按仓库既有做法,用 headless Electron + CDP(见 `.pi/plans/2026-10-07-tab-drag-reorder` 的经验:
`npx electron . --ozone-platform=headless --remote-debugging-port=<p>`,`chrome` 是 `BrowserWindow` 自己的 webContents)跑一遍:

1. 开 3 个标签 → 标签栏 `[1][2][3]`,切到第 2 项;
2. 点第 2 项的 `×` → 断言 `tab:list` 里 `active === true` 的那项是**第 1 项**(旧行为会是第 3 项);
3. 切到第 1 项再关 → 断言激活的是剩下的**第 1 项**(旧第 2 项,回落到右边);
4. 关掉分屏组里最后一个窗格 → 断言活动组变成左边那项、`.tab-dragging` 之类的残留态无异常。

验证:断言 2、3 的方向与预期一致即可(脚本可放 `/tmp`,不进仓库)。

## 5. 风险与未知

- **这是有意改变用户可见行为的变更**,不是修 bug:任何依赖旧顺序的习惯都会变。没有序列化/持久化影响(标签组只在内存)。
- `removedIds` 目前实际只会传一个 id(`[res.removedGroupId]`);多 id 的循环保留但**只有单测覆盖** —— 若只想改组间规则,不要顺手改 `split.ts:159`,否则 `README:491`、`tests/split.test.ts:188` 的语义都会跟着变。
- 我没能直接跑起应用复现用户描述的「总是激活最后一个」:按代码读,关中间组时激活的是**后一个**(在 3 项里正好是右边那项),所以观感像「总是最后一项」——本计划按「优先前一个」这个目标修,方向与用户确认过的预览一致。
- `activateLastVisible()`(取 id 最大)仍保留为「所有组都没了」时的兜底;`listTabs()` 按 id 排序与标签栏顺序无关,不受影响。
