# 无限嵌套分屏:二叉布局树 + 方向键分屏/调大小 + 保存布局

> 取代 `.pi/plans/2026-09-19-split-view/plan.md` 与 `.pi/plans/2026-09-19-tab-groups/plan.md` 里的
> 「两窗格 + 宽度预设」模型(那两份计划里的 `MAX_GROUP_TABS = 2`、`computeSplitBounds`、
> `splitPresets` 全部作废,但**记账/可见性/事件/overlay 的骨架继续沿用**)。

## 0. 目标与已拍板的前提

**目标**:把「一个标签组 = 最多两个左右并排的窗格 + 从设置页挑宽度预设」换成
「一个标签组 = 一棵可任意嵌套的二叉布局树」,分屏与调大小全部走键盘:

- `Ctrl+Shift+←/→/↑/↓`:在**当前聚焦的窗格**上分屏;新窗格开一个空白标签并**立刻聚焦它**,
  位置按箭头(→ 右、← 左、↑ 上、↓ 下);
- `Alt+Shift+←/→/↑/↓`:**当前窗格向箭头方向扩张**(贴到边界就向上一层找能扩的祖先,都没有就不动);
- **去掉**宽度预设(设置页、`settings.json`、`SplitPreset` 全删)与分屏面板里的「更换右侧标签」;
- 分屏面板改成**布局管理器**:保存当前组的结构、在新标签组里套用保存的布局、删除布局;
- 多窗格组的标签栏项里**只有聚焦窗格显示名字,其它窗格只显示图标**。

**已拍板的前提**(本轮问卷,4+4 问):

| # | 决定 |
| --- | --- |
| 1 | 分屏产生的新窗格 = **新建空白标签**(`about:blank`)并聚焦它(不复制当前页、不从别的组拿标签) |
| 2 | **每次都嵌套一层**(二叉、新窗格吃掉被分窗格的一半)。不做「同轴插成兄弟 + 重新配平」 |
| 3 | `Alt+Shift+方向` 的箭头 = **当前窗格要扩张的方向**(走到最外层边界就不动) |
| 4 | 面板 = 结构概览(点窗格聚焦)+「保存布局」+ 已保存布局列表(套用/删除)+「取消分屏」;**宽度预设与候选标签列表删掉** |
| 5 | 保存的布局**只存结构**(嵌套方向 + 每个分隔的比例),不存 URL/标题 |
| 6 | 布局存**单独一个** `<userData>/split-layouts.json`(`createStore`,与 settings.json 解耦);`settings.json` 里的 `splitPresets` 从此不再读写 |
| 7 | 套用布局 = **只在新标签组里打开**(在当前组后面插一个新的标签栏项,N 个窗格 = N 个新空白标签,并切过去) |
| 8 | 一个组**最多 8 个窗格**(超出不响应并记日志) |

**假设**(读代码得出、不是问卷问的,若不对请指出):

- A1 `Ctrl+Shift+←/→` 与 `Alt+Shift+←/→` **只在聚焦的 webContents 属于「普通网页标签」时才拦**。
  地址栏(chrome)、`bow://settings`、终端页、DevTools 前端标签一律**放行给原处理**(地址栏/输入框里的
  「按词选择」、xterm 的选择扩展都还在)。代价:普通网页里的 `<input>/<textarea>` 也拿不到
  `Ctrl+Shift+方向`(主进程拿不到「当前焦点是不是可编辑元素」这个同步信息)。见 §6。
- A2 几何只有一处实现(`shared/split.ts`),主进程算完把**窗格 rect + 分隔条 rect**一起回传渲染层,
  渲染层不重算;坐标是**窗口内容坐标**(= chrome 渲染层的 CSS px,沿用 2026-09-19-split-view 的既有假设)。
- A3 「取消分屏」保留:把组里的 N 个窗格拆成**相邻的 N 个单标签组**(顺序 = 阅读顺序,标签都不销毁)。

## 1. 现状(仓库里实读到的)

- `src/shared/split.ts`(150 行)是**预设模型 + 两窗格几何**:`SplitPreset{id,label,value,unit}`、
  `DEFAULT_SPLIT_PRESETS`(5 档)、`normalizeSplitPresets`、`clampSplitValue`、`findSplitPreset`、
  `matchSplitPreset`、`splitLevelOf`、`splitValueLabel`,以及:
  ```ts
  /** 两窗格几何。…可用宽度放不下两个最小窗格时返回 null */
  export function computeSplitBounds(input: {totalWidth; level; gap?; minPane?}): SplitGeometry | null
  // → { totalWidth, leftWidth, gap }
  ```
- `src/shared/groups.ts` 明确把「只支持两个窗格」写死:
  ```ts
  /** 成员标签 id(1..MAX_GROUP_TABS 个),顺序 = 左窗格在前 */
  tabIds: number[]; focus: number; level: SplitLevel; presetId: string | null
  /** 一个组最多几个标签(= 几个窗格);想支持上下分屏/多窗格得先改这里和 `computeSplitBounds` 的调用方 */
  export const MAX_GROUP_TABS = 2
  ```
  函数面:`addTabToGroup`(进入右槽 + 挤掉非聚焦成员)、`removeTabFromGroups`、`ungroup`(拆成两个)、
  `setGroupLevel`、`focusTab`、`insertIndexAfterGroup`、`neighborGroupIdAfterRemoval`。
- `src/main/tabManager.ts`:
  - `private groups: TabGroup[]` + `listGroups()` 只给**活动组且恰好 2 个标签**算几何:
    ```ts
    const geo = g.id === active?.id && g.tabIds.length === 2 ? computeSplitBounds({totalWidth: width, level: g.level}) : null
    // 返回 { ...g, tabIds, leftWidth: geo?.leftWidth ?? null, gap: geo?.gap ?? null }
    ```
  - `layout()` 是**可见性的唯一来源**,两窗格写死成左右:
    ```ts
    const split = active && active.tabIds.length === 2 ? active : null
    ... v.view.setBounds({x:0, y:top, width: geo.leftWidth, height: viewH}) / {x: geo.leftWidth+geo.gap, ...}
    ```
  - 分屏入口:`addTabToActiveGroup(tabId?)`(addTabToGroup + 挤人)、`ungroupActive()`、
    `setActiveGroupLevel(level, presetId)`、`activateGroup(groupId)`。
- `src/main/ipc.ts`:核心通道 `groups:get / groups:activate / groups:add-tab / groups:ungroup / groups:set-preset`
  (`set-preset` 里用 `findSplitPreset(splitPresets(), id)` 解析,预设是 `settings.json` 里的快照)。
- `src/main/tabShortcuts.ts`:先 `matchTabHotkey(input)`,再 `getKernel()?.handleHotkey(input)`;
  `src/shared/shortcuts.ts` 的 `matchTabHotkey` 里 `if (input.shift) { if (key==='t') return restore; return null }`
  —— 所以 `Ctrl+Shift+方向` 现在是**没人管**的(等于放行给页面)。
- `src/renderer/src/App.vue`:标签栏 `v-for="g in groups"`,2 标签组渲染两个 `.tab-half`(各带标题);
  分隔条是**单条**:
  ```html
  <div v-if="splitGeometry" class="split-divider"
       :style="{ left: `${splitGeometry.leftWidth}px`, width: `${splitGeometry.gap}px`, top: `${chromeHeight}px` }" />
  ```
  `SplitMenuPayload = { rect, tabs, groups, activeGroupId, presets }` 由 chrome 组装,
  面板回传 `add / add-new / apply / ungroup / cancel`。
- `src/renderer/src/components/SplitMenu.vue`:「宽度预设」一排按钮 + 「更换右侧标签」候选列表
  + 「新建空白标签并在右侧分屏」。
- `src/renderer/src/settings/GeneralSettings.vue`:「分屏预设」增删改(名称/数值/单位/删除/恢复默认),
  写入 `settings:set({splitPresets})`;`src/shared/types.ts` 的 `Settings.splitPresets`、
  `src/shared/url.ts` 的 `DEFAULT_SETTINGS.splitPresets = DEFAULT_SPLIT_PRESETS`。
- `src/main/stores.ts` 已导出 `createStore<T>(filename, defaults, opts)`(插件在用的通用 JSON 存储),
  数组型 defaults 走「整体替换」语义 —— 保存布局可以直接用它。
- 单测:`tests/split.test.ts`(22 例,全是预设/几何)、`tests/groups.test.ts`(26 例,含
  `expect(MAX_GROUP_TABS).toBe(2)`)、`tests/shortcuts.test.ts`(31 例)。MCP 与插件**都不碰**标签组
  (grep 过 `src/main/mcp.ts` / `src/main/plugins/*` / `src/plugins/*`,零命中),所以 IPC 面可以自由改。

## 2. 方案

### 2.1 `src/shared/split.ts` 重写:二叉布局树 + 几何 + 布局形状

```ts
export type SplitAxis = 'row' | 'column'          // row = 左右并排(a 左 b 右);column = 上下堆叠(a 上 b 下)
export type PaneDir = 'left' | 'right' | 'up' | 'down'

export type LayoutNode =
  | { kind: 'leaf'; tabId: number }
  | { kind: 'split'; axis: SplitAxis; ratio: number; a: LayoutNode; b: LayoutNode }

export interface Rect { x: number; y: number; width: number; height: number }
export interface PaneBox { tabId: number; rect: Rect }
export interface LayoutGeometry { panes: PaneBox[]; dividers: Rect[] }  // panes 只含**可见**叶子

export const SPLIT_GAP = 4          // 每个分隔条的宽度(px)
export const MIN_PANE = 120         // 单窗格最小宽/高(px)
export const RATIO_MIN = 0.1        // 比例夹紧
export const RATIO_MAX = 0.9
export const SPLIT_RESIZE_STEP = 0.05  // Alt+Shift+方向,每次 5%
export const MAX_GROUP_PANES = 8
export const MAX_LAYOUT_PRESETS = 20
```

纯函数(全部返回新树,不改入参):

| 函数 | 语义 |
| --- | --- |
| `paneCount(node)` / `paneTabIds(node)` / `hasPane(node, tabId)` | 叶子数 / **阅读顺序**叶子表 / 包含判断 |
| `splitPane(root, tabId, dir, newTabId)` | 把 `tabId` 那个叶子替换成 `{axis: axisOfDir(dir), ratio: 0.5, a, b}`:← / ↑ 时新标签放 `a`,→ / ↓ 时放 `b`(**每次都嵌套一层**,不做同轴兄弟合并) |
| `removePane(root, tabId)` → `{root: LayoutNode \| null, nextFocusTabId: number \| null}` | 摘叶子;空容器**塌缩**(只剩一个孩子就用它顶替);`nextFocusTabId` = 阅读顺序的**下一个**叶子,没有就上一个 |
| `resizePane(root, tabId, dir, step)` | 从叶子向上找**第一个「轴匹配且聚焦子树在可扩张侧」**的祖先,改它的 `ratio`(夹到 `RATIO_MIN..RATIO_MAX`);找不到就整棵树原样返回 |
| `computeLayout(root, area, opts)` → `LayoutGeometry` | 见下 |

方向 ↔ 轴 ↔ 可扩张侧(这张表是 `splitPane`/`resizePane` 的唯一依据):

| dir | 轴 | 新窗格位置 | 可扩张侧 = 聚焦子树必须是 |
| --- | --- | --- | --- |
| `left` | `row` | `a` | `b`(向左扩 = 吃掉左边邻居) |
| `right` | `row` | `b` | `a` |
| `up` | `column` | `a` | `b` |
| `down` | `column` | `b` | `a` |

嵌套后的实际观感(前提 2 的直接后果,`ratio` 默认 0.5):

```
A                       ─Ctrl+Shift+→(焦点 A)→   row[A | N]                A=50%  N=50%
row[A | N]              ─Ctrl+Shift+→(焦点 N)→   row[A | row[N | N2]]      A=50%  N=25%  N2=25%
row[A | row[N | N2]]    ─Alt+Shift+→(焦点 N)→   N 所在的**内层 row** 的 ratio 0.5→0.55 ⇒ N=27.5%, N2=22.5%
```

`computeLayout(root, area, {gap, minPane, focusedTabId})`:递归切分,**每层**扣掉 `gap`:

```
split 节点:
  horizontal = axis === 'row'
  avail = (horizontal ? rect.width : rect.height) - gap
  avail < 2*minPane  → 只渲染**含 focusedTabId 的那一支**(铺满 rect、本层不出分隔条;
                       容器不拆,窗口变大后自动恢复 —— 与旧 computeSplitBounds 返回 null 的退化同义)
  否则 sizeA = clamp(round(avail * ratio), minPane, avail - minPane); sizeB = avail - sizeA
       horizontal: walk(a, {x, y, width: sizeA, height}) / walk(b, {x: x+sizeA+gap, ..., width: sizeB})
                   dividers.push({x: rect.x + sizeA, y: rect.y, width: gap, height: rect.height})
       vertical:   同理换成高度 / {y: y+sizeA, width: rect.width, height: gap}
leaf → panes.push({tabId, rect})
```

**布局形状(只存结构,存盘用)**:

```ts
export type LayoutShape = { kind: 'leaf' } | { kind: 'split'; axis: SplitAxis; ratio: number; a: LayoutShape; b: LayoutShape }
export interface LayoutPreset { id: string; name: string; shape: LayoutShape }

shapeOf(node): LayoutShape                 // 去掉 tabId
instantiateShape(shape, tabIds): LayoutNode | null   // 先序把 tabIds 发给叶子;数量对不上 → null
shapePaneCount(shape): number
shapeSummary(shape): string                // 「左右 2 · 上下 1」这类给面板显示的副标题
normalizeLayoutPresets(raw: unknown): LayoutPreset[]  // 逐项校验 axis/ratio/深度/叶子数(>MAX_GROUP_PANES → 丢),
                                                      // 补 id、去重、截到 MAX_LAYOUT_PRESETS,**产出新对象**(同 normalizeSplitPresets 的口径)
nextLayoutPresetId(ids: string[]): string  // 「布局 N」的 id
```

删掉的:`SplitPreset` / `SplitUnit` / `SplitLevel` / `DEFAULT_SPLIT_PRESETS` / `normalizeSplitPresets` /
`clampSplitValue` / `findSplitPreset` / `matchSplitPreset` / `splitLevelOf` / `splitValueLabel` /
`SPLIT_PERCENT_RANGE` / `SPLIT_PX_RANGE` / `SPLIT_PRESET_LIMIT` / `DEFAULT_SPLIT_LEVEL` / `computeSplitBounds` /
`SplitGeometry`。

### 2.2 `src/shared/groups.ts`:组 = 一棵树

```ts
export interface TabGroup {
  id: number
  /** 窗格布局树(叶子 = 标签 id;先序遍历 = 标签栏里的窗格顺序 = 分隔条从左到右/从上到下) */
  tree: LayoutNode
  /** 聚焦的窗格(恒是树里的一个叶子,不再用下标 —— 任意嵌套下「第几槽」没有意义) */
  focus: number
}
```

- 保留:`findGroupOfTab`(改用 `hasPane`)、`findGroup`、`insertIndexAfterGroup`、`neighborGroupIdAfterRemoval`。
- 改:`focusedTabId(g)` → 直接返回 `g.focus`(带「不在树里就退到第一个叶子」的防御);
  `focusTab(groups, tabId)` → 命中就 `focus = tabId`;
  `removeTabFromGroups` → 包 `removePane`(整棵树空了才移除组);
  `ungroup(groups, groupId, newGroupIds: number[])` → 按阅读顺序拆成 N 个单标签组(用调用方给的 id 表)。
- 新增:`newTabGroup(id, tabId)`(单叶子)、`splitGroup(groups, groupId, focusedTabId, dir, newTabId)`、
  `groupTabIds(g)`(=`paneTabIds(g.tree)`)。
- **删掉** `MAX_GROUP_TABS` / `addTabToGroup` / `setGroupLevel`(上限改由 `MAX_GROUP_PANES` +
  `TabManager` 把关;档位/预设的概念整体消失)。

### 2.3 `src/main/tabManager.ts`

- `listGroups()`:活动组算一次 `computeLayout(tree, {x:0, y: chromeHeight, width: w, height: h - chromeHeight},
  {gap: SPLIT_GAP, minPane: MIN_PANE, focusedTabId: activeId})`,把结果并进快照;非活动组 `panes/dividers = []`。
  ```ts
  export interface TabGroupInfo {           // 不再 extends TabGroup(树不下发)
    id: number
    tabIds: number[]                         // 阅读顺序
    focus: number                            // 聚焦窗格
    panes: PaneBox[]                         // 活动组才有;只含可见叶子
    dividers: Rect[]                         // 活动组才有
  }
  ```
- `layout()`:唯一可见性来源不变,改成「可见集合 = 活动组的 `panes`」:
  在 `panes` 里的设 `setBounds(pane.rect)`,`其它一律 setVisible(false)`;
  末尾在「活动组窗格数 ≥ 2」时 `publishGroups()`(窗口 resize / chrome 高度变化都靠它刷新分隔条)。
- `create()` 内部抽出 `private spawn(url?): {id, info}`(建 `WebContentsView`、接线、`addChildView`、
  `loadRendererEntry`/`navigate`,**不碰 groups、不 activate**);`create()` = `spawn` + `insertNewGroup` + `activate`
  (行为与现在逐字一致,便于回归);`createInspectorTab()` 不动(它自己 inline 建视图 + `insertNewGroup`)。
- 新增:
  - `splitFocused(dir: PaneDir): boolean` —— 活动组窗格数 ≥ `MAX_GROUP_PANES` 直接 `false` + 日志;
    否则 `spawn('about:blank')` → `splitGroup(...)` → `activate(新标签)`(activate 内部已经
    `layout()` + `publishGroups()` + `tabs-changed`);
  - `resizeFocused(dir: PaneDir): boolean` —— `resizePane` 后 `layout()` + `publishGroups()`;
  - `activeGroupTree(): LayoutNode | null`(IPC 保存布局时取形状);
  - `saveActiveLayout(name?)` (**≥2 窗格**才存,否则返回现有列表并记日志);
  - `applyLayout(shape: LayoutShape)` —— `spawn` N 个空白标签 → `instantiateShape(shape, ids)` →
    在当前组后面插一个**新组** → `activate(第一个叶子)`;`activate()` 会连带把新组设为活动组;
  - `ungroupActive()` 重写为「N 个窗格 → N 个单标签组」。
- 删掉:`addTabToActiveGroup`、`setActiveGroupLevel`。
- `activate()` / `unregisterTab()` / `focus`+`input-event` 双触发这些**不动**(聚焦语义没变:
  `activeId` = 聚焦窗格 = 焦点所在组的聚焦叶子)。

### 2.4 快捷键(`src/shared/shortcuts.ts` + `src/main/tabShortcuts.ts`)

`shared/shortcuts.ts` 新增(与 `matchTabHotkey` 并列,不改它):

```ts
export type SplitHotkey = { kind: 'split'; dir: PaneDir } | { kind: 'resize'; dir: PaneDir }
export function matchSplitHotkey(input: KeyInputLike): SplitHotkey | null
```

| 规则 | split | resize |
| --- | --- | --- |
| 修饰键 | `(ctrl \|\| meta) && shift && !alt` | `alt && shift && !ctrl && !meta` |
| 主键 | `ArrowLeft/Right/Up/Down`(`code` 优先,兼容非 QWERTY;`key` 兜底) | 同左 |
| 自动重复 | **忽略**(长按不会连开一屏窗格) | **允许**(长按连续调整大小) |
| 其它 | `type !== 'keyDown'` / `isComposing` 一律 null | 同左 |

`main/tabShortcuts.ts`:在 `matchTabHotkey` 之后、`kernel.handleHotkey` 之前插一段:

```ts
const sh = matchSplitHotkey(input)
if (sh) {
  // 只在「聚焦的 webContents 属于普通网页标签」时接管(见 §0 的 A1)
  const tabId = tabs.findTabIdByWebContents(contents)
  const rec = tabId != null ? tabs.getView(tabId) : null
  if (!rec || rec.info.internal) return            // 不 preventDefault:地址栏/设置/终端/DevTools 前端原样处理
  if (overlay.isFullOpen) return                   // 全窗弹层开着时不抢(与 Ctrl+T/Ctrl+L 同策略)
  event.preventDefault()
  if (sh.kind === 'split') tabs.splitFocused(sh.dir)
  else tabs.resizeFocused(sh.dir)
  log('快捷键:分屏/调整大小', sh.kind, sh.dir)
  return
}
```

### 2.5 保存的布局(`<userData>/split-layouts.json`)

- `src/main/stores.ts`:加 `getLayoutsStore()`(`createStore<LayoutPreset[]>('split-layouts.json', [])`),
  与 `getSettingsStore()` 并列;`initStores()` 里一起初始化。
- 读取一律过 `normalizeLayoutPresets()`(文件被写坏/旧版本数据不会炸);写入前同样归一化。
- 文件名/命名:`name` 默认「布局 N」(N = 现有最大序号 +1;面板不提供改名输入框 —— overlay 里的
  文本输入要抢 overlay webContents 的焦点,与现有面板 `@mousedown.prevent` 的约定冲突,
  改名留作后续;面板用副标题显示 `shapeSummary` + 窗格数)。
- `settings.json` 里遗留的 `splitPresets` 键**不读不写**(`JsonStore` 浅合并会把它原样留在文件里,
  无害;不写迁移代码)。

### 2.6 IPC / preload

| 通道 | 变化 |
| --- | --- |
| `groups:get` / `groups:activate` / `groups:ungroup` | 保留(`ungroup` 语义变成「N 窗格 → N 组」) |
| `groups:add-tab` / `groups:set-preset` | **删除** |
| `groups:split` | 新增,`dir: PaneDir` → `TabGroupInfo[]`(键盘走的主进程内部路径;这条同时是 E2E 的唯一入口,见 §5) |
| `groups:resize` | 新增,`dir: PaneDir` → `TabGroupInfo[]` |
| `layouts:list` | 新增 → `LayoutPreset[]`(已归一化) |
| `layouts:save` | 新增,`name?: string` → `LayoutPreset[]`(当前组 <2 窗格则原样返回) |
| `layouts:apply` | 新增,`id: string` → `TabGroupInfo[]` |
| `layouts:delete` | 新增,`id: string` → `LayoutPreset[]` |

`preload/index.ts`:`BrowserAPI` 去掉 `groupsAddTab` / `groupsSetPreset`,加
`splitPane(dir)` / `resizePane(dir)` / `getLayouts()` / `saveLayout(name?)` / `applyLayout(id)` / `deleteLayout(id)`
(注释里点明「split/resize 的键盘入口在主进程,E2E 与兜底才走 IPC」)。

### 2.7 渲染层:标签栏 + 面板

`src/renderer/src/App.vue`:

- 多窗格组的项:**聚焦窗格**照旧渲染 `.tab-letter` + `.tab-title`;其余窗格只渲 `faviconLetter`
  一个图标 chip(`.tab-pane-icon`,点击 `activateTab(t.id)`、中键 `closeTab(t.id)`、`title` = 标题、
  崩溃时画 `TriangleAlert`)。组项仍带 `Columns2` 标记;`loading` 仍按整组显示 spinner;
  `×` 关聚焦窗格。
- 分隔条:`v-if` 单条 → `v-for="(d, i) in activeGroupDividers"`,直接吃主进程坐标:
  ```html
  <div v-for="(d, i) in activeGroupDividers" :key="i" class="split-divider"
       :style="{ left: d.x+'px', top: d.y+'px', width: d.width+'px', height: d.height+'px' }" />
  ```
  (`activeGroupDividers` = 活动组的 `dividers`;`style.css` 的 `.split-divider` 去掉 `bottom: 0`,
  垂直分隔条要显式高度。)
- `pushSplitMenu()` payload 改成 `{ rect, panes, focusedTabId, layouts }`:
  ```ts
  export interface SplitPaneInfo { tabId: number; title: string; url: string; crashed: boolean }
  export interface SplitMenuPayload {
    rect: Rect
    panes: SplitPaneInfo[]          // 活动组,阅读顺序
    focusedTabId: number | null
    layouts: LayoutPreset[]         // 保存的布局(只存结构)
  }
  ```
- `handleSplitMenuEvent` 改为 `focus(tabId) → api.activateTab` / `save → api.saveLayout()` /
  `apply(id) → api.applyLayout(id)` 后**关面板**(新组已激活,payload 立刻过期)/
  `delete(id) → api.deleteLayout(id)` / `ungroup` / `cancel`。
- `api.onGroupsChanged` 的既有刷新逻辑不动。

`src/renderer/src/components/SplitMenu.vue` 重写:

- 头部:「分屏」+「取消分屏」(窗格数 >1 时)。
- 结构概览:窗格列表(序号 + 标题,聚焦那个高亮),点一行 = 聚焦该窗格;下面一行小字提示
  `Ctrl+Shift+方向 分屏 / Alt+Shift+方向 调大小`。
- 「保存当前布局」按钮(窗格 ≥2 才可点;`panes.length < 2` 时禁用 + 提示先分屏)。
- 已保存布局列表:每行 = 名称 + 副标题(`N 窗格 · 左右 x · 上下 y`)、点行 = 在新标签组打开、
  行尾垃圾桶 = 删除;空列表给一句提示。
- 事件名:`focus` / `save` / `apply` / `delete` / `ungroup` / `cancel`。

`src/renderer/src/style.css`:删 `.tab.group-split .tab-half*`(整块),加 `.tab-pane-icon`;
`.tab.group-split` 的宽度按「1 标题 + N 图标」重设(min-width 160 / max-width 300 保留,图标 18px,
标题 `flex:1 min-width:0`)。

### 2.8 设置页:删掉宽度预设

- `src/shared/types.ts`:`Settings` 去掉 `splitPresets`;`SplitMenuPayload` 换成 §2.7 的形状;
  `TabGroupInfo` 换成 §2.3 的形状。
- `src/shared/url.ts`:`DEFAULT_SETTINGS` 去掉 `splitPresets`。
- `src/renderer/src/settings/GeneralSettings.vue`:删掉「分屏预设」整块(模板 + `splitPresets` ref +
  `savePresets` / `addPreset` / `removePreset` / `resetPresets` / `onUnitChange` / `presetError` +
  `.split-presets*` 样式 + 相关 import);「常规」只剩搜索引擎与主页。

## 3. 改动清单

| 文件 | 改什么 |
| --- | --- |
| `src/shared/split.ts` | **重写**:二叉布局树 + `computeLayout` + 布局形状/预设归一化;删掉整套宽度预设 |
| `src/shared/groups.ts` | `TabGroup{id,tree,focus}`;`splitGroup`/`groupTabIds`/树版 `removeTabFromGroups`/N 叶 `ungroup`;删 `MAX_GROUP_TABS`/`addTabToGroup`/`setGroupLevel` |
| `src/shared/shortcuts.ts` | 加 `matchSplitHotkey`(`SplitHotkey`) |
| `src/shared/types.ts` | `Settings` 去 `splitPresets`;`TabGroupInfo` 去 `level/presetId/leftWidth/gap`,加 `panes/dividers`;`SplitMenuPayload` 换形状 |
| `src/shared/url.ts` | `DEFAULT_SETTINGS` 去 `splitPresets` |
| `src/main/tabManager.ts` | `spawn` 抽取;`splitFocused`/`resizeFocused`/`activeGroupTree`/`saveActiveLayout`/`applyLayout`;树版 `listGroups`/`layout`/`unregisterTab`/`ungroupActive`;删 `addTabToActiveGroup`/`setActiveGroupLevel` |
| `src/main/tabShortcuts.ts` | 插 `matchSplitHotkey` 分支(仅普通网页标签 + 非全窗弹层) |
| `src/main/ipc.ts` | 删 `groups:add-tab`/`groups:set-preset`;加 `groups:split`/`groups:resize`/`layouts:*` |
| `src/main/stores.ts` | `getLayoutsStore()`(`split-layouts.json`) |
| `src/preload/index.ts` | 组 API 换面(见 §2.6) |
| `src/renderer/src/App.vue` | 标签栏窗格图标渲染;多条分隔条;面板 payload/事件 |
| `src/renderer/src/components/SplitMenu.vue` | 重写为布局管理器 |
| `src/renderer/src/style.css` | `.tab-half*` → `.tab-pane-icon`;`.split-divider` 去掉 `bottom` |
| `src/renderer/src/settings/GeneralSettings.vue` | 删分屏预设块 |
| `tests/split.test.ts` | 重写:树操作 / 几何 / 形状 / 预设归一化 |
| `tests/groups.test.ts` | 重写:树版组记账(分屏/塌缩/焦点/N 叶拆组) |
| `tests/shortcuts.test.ts` | 加 `matchSplitHotkey` 用例 |
| `README.md` | §手动使用快捷键、§标签组与分屏、§数据存储(`split-layouts.json`;settings.json 去预设)、§设置页常规、§代码结构里 `groups.ts`/`split.ts` 的说明 |
| `docs/ARCHITECTURE.md` | §2 文件树注释、§3 布局引擎的「标签组」段(树/几何/可见性三不变式改写)、§7 IPC 表与 `groups:changed`、`settings.json` 行、overlay `split-menu` 说明、§11 用例数、§12 里被本次改动作废的行 |

## 4. 分步实施(每步单独可验证)

1. **纯逻辑**:重写 `src/shared/split.ts` + `src/shared/groups.ts`,重写 `tests/split.test.ts`、
   `tests/groups.test.ts`。
   验证:`bun run test tests/split.test.ts tests/groups.test.ts` 全绿(vitest 不做类型检查,此时别的文件还没改完;
   注意 `test` 脚本是 `vitest run`,**不要**用 bun 自带的 `bun test`)。
2. **主进程/共享类型**:`shared/types.ts`、`shared/url.ts`、`main/tabManager.ts`、`main/stores.ts`、
   `main/ipc.ts`、`main/tabShortcuts.ts`、`preload/index.ts`。
   验证:`bun run typecheck` 的 node 侧通过(web 侧此时预期报 App.vue/GeneralSettings 的错)。
3. **渲染层**:`App.vue`、`SplitMenu.vue`、`style.css`、`GeneralSettings.vue`。
   验证:`bun run typecheck` 双侧通过 + `bun run build` 通过 + `bun run test`(全量)绿。
4. **探针 + E2E**(先探针后写脚本,遵守仓库既有习惯):
   - 探针:确认 `Input.dispatchKeyEvent` / 主进程 `sendInputEvent` **能否**触发
     `before-input-event`(会话记忆里 CDP 那条是「不能」);结果直接决定 E2E 走真按键还是走
     `groups:split` / `groups:resize` 这组 IPC 兜底 —— **如实记录,不假装验过**。
   - Windows 真机 E2E(`D:/tmp/nested-split-e2e.mjs`,照 `terminal-clipboard-e2e.mjs` 的骨架):
     §5 的矩阵。
5. **文档**:README / ARCHITECTURE 按 §3 更新;跑一次全量测试把 §11 的用例数改成实测值。

## 5. 验证矩阵

**单测(纯逻辑,必须覆盖)**

- `splitPane`:单叶子 → 两叶子;方向决定 `a/b`;嵌套三层后的阅读顺序;`tabId` 不在树里 → 原样;
  `ratio` 恒 0.5。
- `removePane`:摘中间叶子 → 空容器塌缩、层级 -1;摘到只剩一个 → `root` 为叶子;树空 → `root = null`;
  `nextFocusTabId` 取阅读顺序下一个、没有则上一个。
- `resizePane`:同一棵树分别对 4 个方向断言「动的是哪一层/`ratio` 往哪边」;聚焦在不可扩张侧时
  向上找一层(有祖先可扩)/ 到顶不动(无祖先);`ratio` 夹在 0.1/0.9。
- `computeLayout`:2 叶 50/50(可用宽 = 宽 - gap);三层嵌套的 rect 累加与 gap 扣减正确;
  `avail < 2*minPane` 时只出聚焦支、`dividers` 为空;`ratio` 极端值被 `MIN_PANE` 夹住;
  `dividers` 数量 = 内部节点数(未退化的);rect 互不重叠。
- `shapeOf` → `instantiateShape` 往返:`paneCount` 一致、先序遍历的 tabId 顺序一致;
  `tabIds` 数量不匹配 → `null`。
- `normalizeLayoutPresets`:非数组/坏项/坏轴/坏 ratio/叶子数 >8/超条数 → 丢掉或截断,产出新对象。
- `groups`:组内分屏不改动别的组;摘叶子后组降级;N 叶 `ungroup` 拆出 N 个相邻单标签组且顺序正确;
  `focusTab` 只改命中组。
- `matchSplitHotkey`:`Ctrl/Cmd+Shift+方向` → split;`Alt+Shift+方向` → resize;split 忽略自动重复、
  resize 允许;带 Alt 的 split / 带 Ctrl 的 resize / 无 shift / keyUp / isComposing → null;
  `code`(`ArrowLeft`)与 `key` 两种来源都认。

**真机 E2E(Windows `bow.exe`,CDP)**

| # | 操作 | 判据 |
| --- | --- | --- |
| 1 | 新建标签 → 分屏 3 次(走探针确认的真按键,或 `splitPane` IPC) | `groups:get` 里 tabIds 长度 4;标签栏**项数 1**;`.tab-title` 在项内只有 1 个、`.tab-pane-icon` 有 3 个 |
| 2 | 读每个页面 target 的 `window.innerWidth/innerHeight` | 与 `groups:get` 回传的 `panes[].rect` **逐个吻合**(真实 bounds 的直接证据,含 gap 扣减) |
| 3 | `.split-divider` 数量 | = 内部节点数(3 次嵌套 = 3),且 `getBoundingClientRect()` 与 `dividers[]` 吻合 |
| 4 | 聚焦第 3 个窗格 → 调大小(某方向) | 该窗格 `innerWidth/innerHeight` 变大、同层邻居变小、其它窗格不变;到最外层边界再按同方向 → 无变化 |
| 5 | 关掉中间那个窗格 | 窗格数 -1;容器塌缩(剩余 pane 的 rect 重新铺满被让出的区域);焦点落到阅读顺序的下一个 |
| 6 | 「取消分屏」 | 标签栏项数 = 窗格数,每项 1 个标签,顺序 = 阅读顺序 |
| 7 | 保存布局 → `layouts:list` | 长度 1,`shape` 里**没有** `tabId`;`split-layouts.json` 落盘且内容合法 |
| 8 | 套用该布局 | 出现一个新的标签栏项,窗格数与形状一致(各页面 target 的 innerWidth 组合与保存时同构);原组不受影响 |
| 9 | 删除布局 | `layouts:list` 空、文件里也没有;套用已删除的 id → 无事发生 |
| 10 | 回归 | `Ctrl+1..9` 按组切换;`Ctrl+W` / × 只关聚焦窗格;窗口 resize 后分隔条与各窗格同步;终端插件 E2E(`terminal-e2e.mjs` / `terminal-clipboard-e2e.mjs`)**21/21 + 21/21**;关闭窗口确认框行为不变;主进程无新的 `未捕获异常` |

## 6. 风险与未知

1. **`before-input-event` 的 E2E 可验性**(最高不确定项):会话记忆里 CDP
   `Input.dispatchKeyEvent` 进得来渲染层的钩子、但**验不了主进程 `before-input-event`**;主进程
   `sendInputEvent` 是否走那条路也没实测过。→ 第 4 步先做探针;若都不可靠,真按键只能由**真人**验,
   E2E 用 `groups:split`/`groups:resize` IPC 覆盖同一段代码路径(与之前 tab-groups 那次的做法一致),
   并在计划与提交信息里写明「真按键未端到端验」。
2. **按键冲突**(A1 的代价):普通网页里的 `<input>/<textarea>` 会失去 `Ctrl+Shift+←/→` 按词选择、
   `Alt+Shift+←/→`(部分编辑器/输入法的调换)。地址栏、设置页、终端、DevTools 前端不受影响。
   缓解手段(本次不做,写进文档):给地址栏/可编辑元素做一个「编辑中」上报,主进程据此放行;
   或改成一键组合(如 `Ctrl+Shift+Alt+方向`)。
3. **嵌套 + 每次减半 ⇒ 深处窗格很快小于 120px**:`computeLayout` 会退化(只显示聚焦那一支),
   用户可能觉得「窗格不见了」。缓解:退化只是渲染层的事(树不拆,窗口拉大就回来);面板的窗格列表
   始终列出全部叶子。8 窗格上限是硬约束。
4. **内存/进程**:一个组最多 8 个真 `WebContentsView`(各一个渲染进程)。这是用户明确要的能力,
   不做额外限制,但要在 README 里写清楚。
5. **`TabGroupInfo` / `SplitMenuPayload` / `Settings` 三处类型同时改**:必须主进程 + 渲染层一起改
   (typecheck 会兜住);期间 `bun run test` 里引用旧字段的测试会红,属预期(第 1 步先改测试)。
6. **`spawn()` 抽取的风险**:`create()` 是热路径(启动首页、MCP、插件都走它),抽取后必须保证
   「事件/日志/publish 顺序」不变;回归靠既有 E2E + 全量单测。
7. **未定**:布局改名(面板无输入框)、面板里直接加方向按钮、把布局列表也搬进设置页 —— 都不做,
   留作后续;真机观感(8 个图标挤在 300px 的项里是否难看)需要真人看一眼再定样式。

## 7. 不做(明确排除)

- 不做同轴「兄弟合并 + 重新配平」(前提 2 直接排除):连续同方向分屏会得到 50/25/25 这类嵌套比例,
  想拉平用 `Alt+Shift+方向`。
- 不做鼠标拖拽分隔条调大小(分隔条继续 `pointer-events: none`);不做窗格之间用快捷键移动焦点
  (仍然靠点击聚焦)。
- 不做「布局里保存 URL/标题/工作区」;不做布局改名。
- 不动 `activate()` 的聚焦语义、不动 `Ctrl+数字` 切组语义、不动分屏组在 MCP 面的表现
  (`TabInfo.groupId` 保留,`browser_list_tabs` 格式不变)。
- 不修 `docs/ARCHITECTURE.md` §12 里与本次无关的漂移行。

---

## 8. 实施记录(2026-09-19 完成)

### 8.1 与计划的偏差

1. **探针结论反转(计划 §6.1 的最大不确定项)**:会话记忆里写着「CDP 的 `Input.dispatchKeyEvent` 验不了主进程
   `before-input-event`」,`D:/tmp/nested-split-probe.mjs` 实测**能触发**(页面 target 上发 `rawKeyDown` +
   `modifiers` 就进了 `before-input-event`,按一次 Ctrl+Shift+→ 就分出一个窗格)。
   所以 E2E 的 1 / 5 / 11 / 12 段用的是**真按键**,不是 IPC 兜底。
   探针里 B 组(主进程 `sendInputEvent`)没触发,但那是**发错了目标**(发给了 chrome 的 webContents,
   会被「只在普通网页标签接管」的规则跳过),不能据此判断 `sendInputEvent` 本身 —— 结论只写「CDP 页面按键可用」。
2. **`resizePane` 的祖先顺序写反过一次**:第一版是自外向内(外层先命中就改外层),写单测时与
   「由内向外找最近的可扩张祖先」的语义不符(例:`row(row(1,2),3)` 里聚焦 2 按 → 应当扩外层而不是先动内层…
   正确行为是先看内层能不能动)。改成**先递归子节点、子节点没动才改自己**,测试 `'优先动最靠近叶子的那一层'`
   与 `'里层动不了时向上一层找可扩张的祖先'` 一起钉住。
3. `clampRatio` 对 ±`Infinity` 改成**饱和**到 0.1 / 0.9(只有 `NaN` 落 0.5);
   `computeLayout` 的 `dividers` 改成**先序** push(由外向内、从左到右),断言更直观。
4. **发现并修掉一个计划没预见到的真实竞态**:`App.vue` 的 `pushSplitMenu()` 要 await 取布局,
   而「套用布局」的 promise 落地时会关面板 —— 过期的刷新结果又把面板弹回来了(面板 E2E 第 4 段先红,
   定位为产品 bug 而不是测试问题)。修法:`splitMenuSeq` 代计数,关面板时 +1,异步结果回来先比代,过期丢弃/收回。
5. 布局名自动生成「布局 N」(不做改名输入框:overlay 里的文本输入要跟 `@mousedown.prevent`
   的既有约定打架);副标题用 `shapeSummary()` 显示形状(如「3 窗格 · 左右 1 · 上下 1」)。

### 8.2 文件

| 文件 | 实际改动 |
| --- | --- |
| `src/shared/split.ts` | 重写:二叉布局树 + `computeLayout` + 布局形状/预设归一化;整套宽度预设删除 |
| `src/shared/groups.ts` | 重写:`TabGroup{id,tree,focus}` + 树版记账;删 `MAX_GROUP_TABS`/`addTabToGroup`/`setGroupLevel` |
| `src/shared/shortcuts.ts` | 新增 `SplitHotkey` + `matchSplitHotkey`(split 忽略自动重复、resize 允许) |
| `src/shared/types.ts` | `TabGroupInfo{id,tabIds,focus,panes,dividers}`、`SplitPaneInfo`、新 `SplitMenuPayload`;`Settings` 去 `splitPresets` |
| `src/shared/url.ts` | `DEFAULT_SETTINGS` 去 `splitPresets` |
| `src/main/tabManager.ts` | 抽出 `spawn()`;`splitFocused`/`resizeFocused`/`activeGroupTree`/`applyLayout`;树版 `listGroups`/`layout`/`ungroupActive`;`geometryOf()` |
| `src/main/tabShortcuts.ts` | `matchSplitHotkey` 分支(只普通网页标签 + 非全窗弹层 + 不抢终端) |
| `src/main/ipc.ts` | 删 `groups:add-tab`/`groups:set-preset`;加 `groups:split`/`groups:resize`/`layouts:{list,save,apply,delete}` |
| `src/main/stores.ts` | `getLayoutsStore()`(`split-layouts.json`) |
| `src/preload/index.ts` | `splitPane`/`resizePane`/`getLayouts`/`saveLayout`/`applyLayout`/`deleteLayout`;删两个旧组 API |
| `src/renderer/src/App.vue` | 标签栏图标栈、多条分隔条、面板 payload/事件、`splitMenuSeq` 竞态修复 |
| `src/renderer/src/components/SplitMenu.vue` | 重写为布局管理器 |
| `src/renderer/src/style.css` | `.tab-pane-icon`;`.split-divider` 去掉 `bottom`(横竖都用主进程给的矩形) |
| `src/renderer/src/settings/GeneralSettings.vue` | 删分屏预设块 |
| `tests/{split,groups,shortcuts}.test.ts` | 重写/扩充:46 + 22 + 40 例 |
| `README.md` / `docs/ARCHITECTURE.md` | 快捷键、标签组与嵌套分屏、数据存储、设置页、视图模型、IPC 表、用例数、§13 坑清单 |

### 8.3 验证(实测)

- `bun run typecheck` 过、`bun run build` 过。
  ⚠️ 注意:`tsc` **不检查 `.vue` 的 script/template**(`include` 里的 `*.vue` 只是不报错而已),
  所以标签栏/面板的改动只能靠 `build` + 真机 E2E 兜。
- `bun run test`:**39 文件 / 719 用例全绿**(新增/重写:`split` 46、`groups` 22、`shortcuts` 40)。
- 真机(Windows,`D:\Workspace\browser` + `bun.exe`,代码经 `wsync` 同步后 `bun run build`):
  - `D:/tmp/nested-split-e2e.mjs` **47/47,跑两遍** —— 真实按键分屏/调大小、几何与真实 bounds、
    分隔条、塌缩、保存/套用/删除布局、取消分屏、Ctrl+1/Ctrl+W/Ctrl+T、窗口 resize、8 窗格上限、无未捕获异常。
  - `D:/tmp/nested-split-panel-e2e.mjs` **13/13,跑两遍** —— 面板的真鼠标点击链路(开面板、点窗格行聚焦、
    保存、套用并自动关面板、取消分屏、Esc)。
  - 回归:`D:/tmp/terminal-e2e.mjs` **21/21**、`D:/tmp/terminal-clipboard-e2e.mjs` **21/21**。
  - 设置页冒烟:`D:/tmp/settings-smoke.mjs` **5/5**(常规分区仍渲染、分屏预设块已删干净)—— 因为 `.vue` 不被 `tsc` 覆盖。
- 判据上的一条重要修正:**显示器 125% 时页面 `innerWidth` 允许比 rect 大/小 1px**
  (`split-geom-probe.mjs`:scaleFactor=1.25、dpr=1.25;317 DIP 的窗格报 318)。
  真正的几何判据换成「DIP 层面精确相邻(只隔一个 4px gap)、铺满右边界、rect 互不重叠」+ `dividers` 逐个吻合。

### 8.4 遗留(未验 / 未做)

- **macOS 完全没跑**(⌘ 路径、`Alt+Shift+方向` 与 mac 键盘映射、`editMenu` 是否吃加速键)—— 要真人确认。
- 网页 `<input>/<textarea>` 里的 `Ctrl+Shift+方向` 被接管(计划 §0 的 A1/§6.2,已知代价)。
- 布局改名、面板方向按钮、布局列表进设置页 —— 按计划 §7 未做。
- 8 个图标挤在 300px 的标签项里**没有人工看观感**(只有 DOM 断言:1 标题 + N 图标)。
