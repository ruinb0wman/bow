# 标签组:分屏的两个标签合并为一项,Ctrl+数字切组

## 0. 目标与已拍板的前提

**问题**(用户原话):`tab1` 与 `tab2` 分屏后新建 `tab3` 会破坏 `tab1|tab2` 的分屏 —— 因为分屏状态是
`TabManager` 上的**全局单例**(`private split: SplitPair | null`),`activate()` 一旦发现点到的标签不在这一对里
就 `setSplit(null)`。

**目标**:引入**标签组**概念 —— 按用户提的模型落地(比"给分屏加个分组标记"更彻底、也更自然):

> **标签栏里的每一项就是一个组**;普通组只有 1 个标签,分屏组有 2 个;可以从别的组里把标签拿进来拼;
> 组空了就消失。`Ctrl+数字` 切的是**组**,不是标签。

问卷/对话结论(实现前提,勿擅自改回):

| 问题 | 选择 |
| --- | --- |
| 标签栏显示 | **组即标签栏的一项**(用户提出):2 标签的组显示成一项(左右两半各显示一个标题,点哪半聚焦哪半) |
| `Ctrl+W` / × / 中键 | **只关聚焦的那一半**(组降级为单标签) —— 组永不因关闭而"消失",除非最后一个标签也被关掉 |
| 「取消分屏」 | **拆成两个单标签组,两个标签都保留**(左右顺序不变) |
| 面板候选范围 | **可以拆别的组**(候选 = 所有不在本组里的标签;被拿走的标签从原组移出,原组因此空了就消失) |

假设(别当现状):

- 组**只在内存**,不跨重启(与现在的分屏状态一致);持久化的仍只有 `settings.json` 里的 `splitPresets`。
- 一个组最多 2 个标签(`MAX_GROUP_TABS`)。上下分屏 / 三窗格不在本次范围。
- 组没有独立的名字/颜色(不是 Chrome 的 tab group 那种带标签名的分组)。

## 1. 现状(仓库里实读到的)

- `src/main/tabManager.ts:77` 起:`split: SplitPair | null`(`{leftId,rightId}`)+ 全局的
  `splitLevel`/`splitPresetId`;`splitState()/enterSplit()/exitSplit()/applySplitLevel()`(`:540`–`:602`)、
  `forgetSplitMember()`(`:607`)、`layout()`(`:617` 起,按 `this.split` 决定两窗格几何与可见性)。
- `activate()`(`:388` 起)里这段就是 bug 的根:
  ```ts
  const leavingSplit = this.split != null && id !== this.split.leftId && id !== this.split.rightId
  ...
  if (leavingSplit) this.setSplit(null)
  ```
  `create(url, activate=true)`(Ctrl+T / `+` / MCP `browser_new_tab`)最后也会走 `activate()`,所以**新建标签必然拆掉分屏**。
- 两窗格的「聚焦窗格」是用 `activeId` 表示的(`wc.on('focus')` + `wc.on('input-event')` → `activatePaneIfSplitMember`,`:326`–`:337`),
  而 `activeId` 同时又是"活动标签"—— 组模型下它继续是"活动组里聚焦的那个标签",语义不变。
- `tabShortcuts.ts:77`–`:83`:`Ctrl+数字` 走 `tabs.listTabs()` + `switchIndexForDigit(digit, list.length)`
  —— 现在按**标签**索引,要改成按**组**索引(helper 本身是通用的,只需换入参并改注释)。
- `App.vue:441` 起:标签栏 `v-for="t in tabs"` 逐标签渲染(分屏成员靠 `tab-split` 的「左/右」小标记区分);
  `App.vue:528` 起的 `.split-divider` 用 `split.leftWidth/gap`。
- `SplitMenu.vue`:payload 是 `{rect, tabs, leftTabId, presets, split}`(`shared/types.ts` 的 `SplitMenuPayload`),
  面板自己算"候选 = 排除 leftTabId/rightTabId"。
- `shared/split.ts`:预设模型 + `computeSplitBounds()` + `matchSplitPreset()`(这些**都留用**);
  `SplitState`/`emptySplitState()` 在组模型下没有意义了(要被 `TabGroupInfo[]` 取代)。
- 现有真机 E2E `/tmp/split-e2e.mjs`(53/53)可直接扩展复用:直接 spawn `node_modules/electron/dist/electron`
  + `detached` + 杀进程组、`XDG_CONFIG_HOME` 隔离、`window.resizeTo` 改窗口尺寸(见上一份计划 §10.3 的坑)。

## 2. 方案

### 2.1 数据模型:纯记账放 `shared/groups.ts`(可单测)

```ts
export interface TabGroup {
  id: number
  /** 成员标签 id(1..MAX_GROUP_TABS 个),顺序 = 左窗格在前 */
  tabIds: number[]
  /** 聚焦成员的下标(地址栏/前进后退跟着它) */
  focus: number
  /** 该组的窗格宽度档位(单标签组也保留,拼第二个标签时直接用) */
  level: SplitLevel
  presetId: string | null
}
export const MAX_GROUP_TABS = 2

findGroupOfTab(groups, tabId) / findGroup(groups, groupId) / focusedTabId(group)
focusTab(groups, tabId)                                  // 挪焦点
addTabToGroup(groups, groupId, tabId, evictedGroupId)     // 见下
removeTabFromGroups(groups, tabId)                        // → {groups, removedGroupId, focusTabId}
ungroup(groups, groupId, newGroupId)                      // 拆成相邻的两个单标签组
setGroupLevel(groups, groupId, level, presetId)
insertIndexAfterGroup(groups, afterGroupId)               // 新标签插到活动组右边
```

`addTabToGroup` 的三条语义(要写进注释,别靠猜):

1. 新标签**固定进右槽**,原来的聚焦成员留在左槽 ⇒ 点任何候选,"我一直在看的那页"不会跳到右边;
2. 组已满(2 个)时,原来的**非聚焦**成员被挤出去,自己在**本组后面**成为一个新的单标签组(不销毁标签);
3. 该标签原本在别的组里 → 先从原组摘掉(一个标签不能同时在两个组里);原组空了就消失。

**为什么坚持纯函数**:`TabManager` 直接吃 Electron,没有测试替身(`docs/ARCHITECTURE.md` §11),
把增删改的记账抽出来才可能真单测;`TabManager` 只负责"数组 → 视图可见性/bounds + 事件"。

### 2.2 `TabManager`:全局 split → 组列表

```ts
private groups: TabGroup[] = []      // 顺序 = 标签栏顺序
private nextGroupId = 1
private activeId: number | null      // 仍是「活动组里聚焦的标签」,所有既有代码继续可用
```

- **活动组 = `findGroupOfTab(groups, activeId)`**(不额外存 `activeGroupId`,不会不同步)。
- `listGroups(): TabGroupInfo[]`:`TabGroup` + 由 `computeSplitBounds()` 现算的 `leftWidth/gap`
  (只有活动组的 2 标签组才有非空值;非活动组回 `null` —— 它们根本没显示)。
- `layout()`:
  ```
  activeGroup = findGroupOfTab(groups, activeId)
  split = activeGroup && activeGroup.tabIds.length === 2 ? {left,right} : null
  geo   = split ? computeSplitBounds({totalWidth: w, level: activeGroup.level}) : null
  visible = geo ? (id===left || id===right) : id===activeId     // ← 不变式不变:可见性只在 layout() 里设
  ```
- `activate(id)`:**不再拆任何东西** —— 只把 `groups = focusTab(groups, id)` 并把 `activeId = id`
  (跨组也是同一套:活动组随之改变,`layout()` 立刻切视图)。**这条就是用户报的 bug 的修复点。**
- `create(url, activate)`:新建组(`members=[id]`,档位 = `DEFAULT_SPLIT_LEVEL`),
  插到 `insertIndexAfterGroup(groups, 当前活动组)`;`activate` 为真才激活它 ——
  **已有分屏组原封不动**(新组没被激活时它的视图隐藏,也不影响分屏几何)。
- `close(id)`:`removeTabFromGroups(groups, id)`;组还在就把焦点给它剩下的成员(窗口从"两半"变"一半");
  组没了(最后一个标签) → 若它是活动组,挑**位置最近的邻组**激活(优先后一个,其次前一个)。
- `destroyed` 生命周期:同 `close`(去掉现在那个 `forgetSplitMember(id)`)。
- 新增:`addTabToActiveGroup(tabId?)`(面板用;`tabId` 省略 = 先 `create('about:blank', false)` 再拼进来)、
  `ungroupActive()`(取消分屏)、`setActiveGroupLevel(level, presetId)`、`activateGroup(groupId)`
  (Ctrl+数字用:激活该组**聚焦的**成员)。
- 事件:`'groups-changed'` 取代 `'split-changed'`(payload `TabGroupInfo[]`),其余事件(`tab-*`)不动。
- `wc.on('focus'|'input-event')` 的处理简化为:该标签属于活动组、且不是当前聚焦的那个 → `activate(id)`
  (跨组的视图不可见,收不到输入,不必特判)。

关键不变式(照旧,别改回去):①**页面视图可见性只在 `layout()` 里设**;②两窗格之间的 4px 空隙与分隔条几何
只由 `computeSplitBounds()` 算(主进程把 `leftWidth/gap` 回传);③`ui:overlay-event` 里 `split-menu`
的转发必须在通用 `close-request` 之前。

### 2.3 IPC / preload

| 通道 | 参数 | 返回 |
| --- | --- | --- |
| `groups:get` | — | `TabGroupInfo[]` |
| `groups:activate` | groupId | `TabGroupInfo[]` |
| `groups:add-tab` | tabId? | `TabGroupInfo[]`(省略 tabId = 新建空白标签再拼进当前组) |
| `groups:ungroup` | — | `TabGroupInfo[]`(拆当前组) |
| `groups:set-preset` | presetId | `TabGroupInfo[]`(套在**当前组**上) |

发送:`groups:changed`(只发 chrome,与现在的 `split:changed` 同位置)。
删掉 `split:get/enter/exit/apply` 与 `split:changed`(内部 API,无兼容负担)。
`browserAPI`:`getGroups/onGroupsChanged/groupsActivate/groupsAddTab/groupsUngroup/groupsSetPreset`
(去掉 `getSplitState/splitEnter/splitExit/splitApplyPreset/onSplitChanged`)。

### 2.4 标签栏渲染(`App.vue`)

- 数据:`groups`(结构)+ `tabs`(内容:标题/loading/crashed)。**一项 = 一个组**:
  - 1 个标签:与现在一样(字母头像 + 标题 + spinner + ×);
  - 2 个标签:一项里左右两半,各显示自己的头像 + 标题(各占 50% 宽,`text-overflow: ellipsis`),
    中间一条竖线;**聚焦的那半**加高亮背景(`--bg3`);点左半 → `activateTab(leftId)`,点右半 → `activateTab(rightId)`;
    整项(非两半区域)点一下 → 激活该组的聚焦成员。
- `×` / 中键 / `Ctrl+W` 都只关**聚焦的那一半**(标题里写清:「关闭聚焦的一半 (Ctrl+W)」)。
- `+` 按钮与 `Ctrl+T` 走 `create()` → 新组,插在活动组右边并激活(既有分屏组不受影响)。
- 分屏组项给一点视觉提示:标题前的 `Columns2` 小图标(替代现在贴在标签上的「左/右」小方块)。
- 分隔条继续用活动组的 `leftWidth/gap`,`v-if` 改成「活动组是 2 标签组且 `leftWidth != null`」。

### 2.5 快捷键(`tabShortcuts.ts` / `shared/shortcuts.ts`)

- `Ctrl+数字`:`tabs.listGroups()` + `switchIndexForDigit(digit, groups.length)` + `tabs.activateGroup(...)`
  (9 = 最后一组;越界忽略)。`shared/shortcuts.ts` 里 `switchIndexForDigit` 的实现不动,只改注释措辞
  (它本来就是"第 digit 项 / 9 取最后一项"的通用映射)。
- `Ctrl+T` / `Ctrl+Shift+T` / `Ctrl+W` / `Ctrl+L` / `Ctrl+,` 的实现都不用改:它们已经作用于
  "活动标签",而组模型下"活动标签"就是聚焦的那一半 —— `Ctrl+W` 关一半、组降级,正好是拍板的语义。
- 面板快捷键(上一轮决定的):无新增。

### 2.6 MCP 与插件面

- 核心 MCP 工具**签名不变**(`browser_list_tabs` / `browser_close_tab` / `browser_new_tab` …):
  `close_tab {tabId}` 关的是**一个标签**(组降级,另一个窗格继续显示);`new_tab` 建新组,不再拆别人的组。
- `TabInfo` 加一个可选字段 `groupId?: number`(`listTabs()` 里填),让 AI 能看出哪两个标签是一对
  —— 不加这个字段它也猜不出来,而"误关一半"是这类自动化最容易踩的坑。MCP 文档(README 的
  行为约定一段)补一句:关掉分屏的一半不会关掉整个组。
- 插件侧(`PluginTabApi.list()`/`getActive()`)跟着自动带上 `groupId`,不新增 API。

## 3. 改动清单

新增:

| 文件 | 内容 |
| --- | --- |
| `src/shared/groups.ts` | `TabGroup` + `MAX_GROUP_TABS` + 全部纯记账函数 |
| `tests/groups.test.ts` | 分组记账的单测(加/摘/挤/拆/焦点/插入位置) |

修改:

| 文件 | 改什么 |
| --- | --- |
| `src/shared/types.ts` | 新增 `TabGroupInfo`(TabGroup + leftWidth/gap);`SplitMenuPayload` 改为 `{rect, tabs, groups, activeGroupId, presets}`;`TabInfo.groupId?` |
| `src/shared/split.ts` | 删 `SplitState`/`emptySplitState`(其余留用) |
| `src/main/tabManager.ts` | 全局 split → `groups: TabGroup[]`;`create/activate/close/destroyed/layout` 改写;新 API;`groups-changed` 事件;`listTabs()` 填 `groupId` |
| `src/main/ipc.ts` | 5 个 `groups:*` handler + `groups:changed` 发送(替换 `split:*`) |
| `src/main/tabShortcuts.ts` | `Ctrl+数字` 按组切 |
| `src/preload/index.ts` | 5 个新 API 替换旧的 split API |
| `src/renderer/src/App.vue` | 标签栏按组渲染(两半可点)、分隔条取活动组、面板 payload |
| `src/renderer/src/components/SplitMenu.vue` | payload/文案改「组」语义(候选 = 所有不在本组的标签;「取消分屏」= 拆成两个标签) |
| `src/renderer/src/style.css` | 组项样式(`.tab.group`/`.tab-half`/`.tab-half.focused`) |
| `README.md` | 「## 分屏」改写成「## 标签组与分屏」:组即标签栏一项、Ctrl+数字切组、新建标签不再拆组、关一半的语义 |
| `docs/ARCHITECTURE.md` | §1/§3(组模型 + 只由 layout 设可见性)/§7.1·§7.2/§9(IPC 表)/§11(基线数字)/§13(不变式) |

**不动**:`shared/split.ts` 的预设与几何、设置页预设 UI、`closeConfirm`、插件内核与各插件、
`docs/ARCHITECTURE.md §12` 漂移表。

## 4. 分步实施(每步单独可验证)

- **S1 `src/shared/groups.ts`** —— 按 §2.1 落地(纯函数,含注释里的三条 `addTabToGroup` 语义)。
  验证:`bun run typecheck`。
- **S2 `tests/groups.test.ts`** —— 覆盖:加进空组/满组(挤出去的那个成为新组且**原组保持左=焦点**)、
  从别的组拿标签(原组降级 / 原组消失)、关掉聚焦那半与关掉另一半后的 `focus` 与 `focusTabId`、
  `ungroup` 的顺序与档位继承、`focusTab`、`insertIndexAfterGroup`(有/无活动组)、组空即消失。
  验证:`bunx vitest --run tests/groups.test.ts`。
- **S3 `tabManager.ts`** —— 按 §2.2/§2.6 改写。要点:`activate()` 里删掉 `leavingSplit` 那段(核心修复);
  `layout()` 用活动组;`close()`/`destroyed` 用 `removeTabFromGroups`;`listTabs()` 填 `groupId`。
  验证:`bun run typecheck` + `bunx vitest --run`(既有 621 例不得变红)。
- **S4 `ipc.ts` + `preload/index.ts`** —— 按 §2.3。验证:typecheck;`bun run dev` 里
  `await browserAPI.getGroups()` 返回 `[{id:1,tabIds:[1],focus:0,…}]`。
- **S5 `tabShortcuts.ts`** —— Ctrl+数字按组切。验证:真机步骤 E。
- **S6 `App.vue` + `SplitMenu.vue` + `style.css`** —— 按 §2.4/§2.5。验证:`bun run typecheck` + `bun run build` + 真机。
- **S7 文档** —— README / ARCHITECTURE 按 §3 更新(§11 基线数字等实测后填)。
- **S8 真机 E2E** —— 扩展现有脚本(见 §5)。

## 5. 验证矩阵

| 层次 | 命令 | 期望 |
| --- | --- | --- |
| 类型 | `bun run typecheck` | 过 |
| 单测 | `bunx vitest --run` | 新增 `groups.test.ts` 全绿,既有 621 例不变红 |
| 构建 | `bun run build` | 过 |
| 真机 | `/tmp/groups-e2e.mjs`(由 split-e2e 扩展) | 见下 |

真机新增/改写的断言(在上一轮 53 条基础上):

1. **核心修复**:tab1|tab2 分屏 → 新建 tab3(UI 按钮 + `Ctrl+T` 两条路径)→ 分屏**仍在**
   (`getGroups()` 里那对 `tabIds` 不变、`leftWidth` 不变),tab3 独占整窗;`Ctrl+1` 切回组 1 → 两窗格恢复原宽度;
2. 组即标签栏一项:`.tab` 的**项数 = 组数**(2 标签组只占一项),该项里两个 `.tab-half` 的标题分别是两个页面标题;
3. `Ctrl+数字`:组数 ≥3 时按组跳;`Ctrl+9` = 最后一组;
4. 点组项的右半 → 聚焦右半(`getActiveTab()` 变成右标签、地址栏 URL 跟着变);点左半同理;
5. `Ctrl+W` 只关聚焦那半:组从 2 标签变 1 标签,另一个页面**还活着**且独占整窗;再 `Ctrl+W` 才关掉它(组消失,项数 -1);
6. 「取消分屏」→ 组数 +1、两个标签都在、两个页面 `innerWidth` 都等于整窗宽(先后激活各看一次);
7. 面板候选包含**别的分屏组里的标签**:把 B 从 B|C 组拿进 A 组 → A 组 = A|B,B|C 组降级为 C 单标签组(项数不变、C 还在);
8. 后台新建标签(`createTab(url,false)`)不激活 → 分屏组的两个页面仍 `visibilityState=visible`(没被顶掉);
9. 关闭窗口/全部标签:组全部消失时窗口空 UI 的行为与现在一致(不新增异常);
10. 主进程 `未捕获异常` 0 条。

## 6. 风险与未知

1. **`activate()` 不再拆组**是这次的核心行为改动:所有依赖"点别的标签 = 退出分屏"的地方都会跟着变 ——
   唯一需要复查的是 `openUrl()`/`openInternal()`,它们只调 `activate()`,语义变成"切到那个标签所在的组",这是想要的。
2. **`Ctrl+数字` 的口径变了**(之前按标签、现在按组):对单标签组用户无感;对分屏用户是拍板要的效果。
   文档要写清"数字指的是标签栏第几项"。
3. **标签栏布局**:2 标签组的一项里塞两个标题,窄窗口下会很挤(min-width 需要从 90px 提到 ~150px,
   两个标题各 ~60px)。可能要允许组项比普通项宽一些 —— 具体数值在真机上看着调。
4. **`groupId` 出现在 `TabInfo`** 会让 MCP 返回体变大一点(每个标签多一个整数字段),可忽略。
5. **`split:changed` → `groups:changed` 的改名**:`preload` 的 API 名也跟着变;没有外部消费者(插件面没暴露),
   风险仅限本仓库内部调用点(全在 `App.vue`/`SplitMenu.vue`)。
6. 组顺序 = 数组顺序;`Ctrl+数字` 的稳定性和"新标签插在活动组右边"都依赖它 —— 别在别处 `sort`。

## 7. 不做(明确排除)

- 上下分屏 / 3+ 窗格 / 组的名字与颜色 / 组的持久化(重启不恢复)/ 拖拽标签入组(仍用面板选)/ 拖动分隔条。

---

## 8. 实施记录(2026-09-19 完成)

### 8.1 与计划的偏差(两处)

1. **`addTabToGroup` 的新标签会夺焦**:计划里写「新标签固定进右槽,原来的聚焦成员留在左槽」,
   实现时右槽同时是**组的聚焦成员**(`focus: 1`)—— 刚拼进来的标签就是当前页,地址栏显示它的 URL,
   这比「焦点留在左边、右边悄悄加载」更符合「我刚选的那页」的直觉(而且和 `Ctrl+T` 新建标签后聚焦地址栏的
   习惯一致)。被挤出去的非聚焦成员自成一组,不销毁标签。
2. **`Ctrl+数字` 的合成按键没能端到端验证**:CDP `Input.dispatchKeyEvent` 注入的按键**不会**触发主进程的
   `before-input-event`(与鼠标的 `input-event` 不同 —— 后者能触发)。所以 E2E 退回调 `groupsActivate()`
   (快捷键处理器唯一的实现路径就是它),并在输出里明确标注;`matchTabHotkey`/`switchIndexForDigit` 本身有单测,
   接线只有三行。

### 8.2 文件

新增:`src/shared/groups.ts`、`tests/groups.test.ts`、本文件。
修改:`src/shared/types.ts`(`TabGroupInfo`、`SplitMenuPayload`、`TabInfo.groupId`)、
`src/shared/split.ts`(删 `SplitState`/`emptySplitState`)、`src/shared/shortcuts.ts`(注释口径:项数 = 组数)、
`src/main/tabManager.ts`(全局 split → `groups: TabGroup[]` + 新 API)、`src/main/ipc.ts`(5 个 `groups:*`)、
`src/main/tabShortcuts.ts`、`src/preload/index.ts`、`src/renderer/src/App.vue`(标签栏按组渲染)、
`src/renderer/src/components/SplitMenu.vue`、`src/renderer/src/style.css`、`README.md`、`docs/ARCHITECTURE.md`。

### 8.3 验证

| 项 | 结果 |
| --- | --- |
| `bun run typecheck` | 过 |
| `bunx vitest --run` | **38 文件 / 646 用例全绿**(新增 `tests/groups.test.ts` 26 例;`split` 22 例) |
| `bun run build` | 过 |
| 真机 CDP E2E(`/tmp/groups-e2e.mjs`) | **52/52 通过**(跑了三遍,第一遍修了两处脚本自身的 bug) |

真机断言覆盖(全部通过):

- 组即标签栏一项:2 个标签 = 2 项;拼成一对后**只剩 1 项**、该项带 `group-split` 与两个 `.tab-half`、
  聚焦半高亮;`listTabs()` 的每项带 `groupId`;
- **核心修复**:`createTab` 新建 tab3 → 原分屏组仍是 `[A,B]`、宽度不变,两页只是 `hidden`(没被拆也没被关),
  标签栏 2 项;切回组 1 → 两页恢复 `visible`、左页宽仍等于 leftWidth;
- 点左半/右半 → `getActiveTab()` 跟着切、聚焦标记跟着走;
- `.tab-close` 只关聚焦那半:组从 2 标签变 1 标签、那半的页面**已销毁**、幸存那半 `innerWidth = 整窗宽`;
- 「取消分屏」:组数 +1、两个标签都在、活动的是被拼进来的那个(D)并独占整窗、A 只是 `hidden`;
- 从别的组拿标签:把 C 拼进 A 组 → `[A,C]`,C 原来的单标签组**消失**;满组时加 D → `[A,D]`,C 被挤出成新组且紧跟其后;
- 预设:套 25% 后 `leftWidth` 与左页宽同步、组上记下 `presetId`;`window.resizeTo` 后按新宽度重算、分隔条位移跟随;
- 关掉组里最后一个标签 → 组消失、活动组落到邻组;
- 预设写进 `settings.json`;
- 主进程 `未捕获异常` 0 条;
- 另外把 chrome UI 截图(`Page.captureScreenshot`)存到 `/tmp/groups-chrome.png` 人工看过一眼:
  组项是「分屏图标 + 两个半格标题 + 一个 ×」、聚焦半有底色、分隔条位置正确。

脚本本身的三个坑(下次直接避开):① 起手要**关掉启动时的首页标签**,否则所有组数断言差 1;
② 面板是 toggle,步骤之间要显式确认它当前是开还是关(否则点一下只是把它关了);
③ CDP 请求要带超时 —— 页面被销毁后 `Runtime.evaluate` 永远不 resolve,会把整个脚本挂死。

### 8.4 遗留

- 真实鼠标点另一半时地址栏是否跟随:`input-event` 路径已被 CDP 鼠标事件验证通过(与上一轮结论一致);
- `Ctrl+数字` 的真实按键路径没端到端验(见 §8.1 第 2 条),但处理器唯一实现路径 `groupsActivate()` 已验;
- 标签栏 2 标签组的 min-width 目前 160px(普通标签 90px),多组时看着是否偏挤由用户真机定。
