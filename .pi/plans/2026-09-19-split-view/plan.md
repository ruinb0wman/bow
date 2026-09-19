# 左右分屏:两个标签并排 + 可自定义的宽度预设

## 0. 目标与已拍板的前提

**目标**:同一个窗口里左右并排显示**两个标签页**;宽度通过「预设」套用,预设可在设置页里增删改。
不做像素级拖动、不做上下分屏、不做多窗口。

问卷结论(本次实现的前提,勿擅自改回):

| 问题 | 选择 |
| --- | --- |
| 入口 | **工具栏按钮 + 下拉面板**(复用 `below-chrome` 核心浮层),不加专属快捷键 |
| 预设定义 | **设置页里自定义(增删改)**,落盘到 `settings.json`,支持比例(%)与像素(px)两种单位 |
| 分隔条 | **不可拖动**,只能套用预设(所以不需要透明拖拽浮层,也不需要主进程轮询鼠标) |
| 点第三个标签 | **退出分屏,全屏显示新标签**(分屏只对「一对标签」有意义) |

假设(代码里没有的东西,别当现状):

- 分屏状态**只在内存**(`TabManager` 字段),重启不恢复 —— 与 `closedStack`、element-fullscreen 的页面态一致;
  持久化的只有**预设列表**。
- 窗口最小宽度 720(`index.ts:createWindow` 的 `minWidth: 720`),所以「两窗格都能显示」几乎总是成立;
  极端窄窗走退化分支(见 §2.4)。

## 1. 现状(以下都是在仓库里实读到的)

- **每个标签 = 一个 `WebContentsView`**,由 `TabManager` 持有;`TabManager.layout()`(`tabManager.ts:496`)
  现在把**所有**标签视图铺成同一个矩形:
  ```ts
  const [w, h] = this.window.getContentSize()
  const top = this.chromeHeight
  const viewH = Math.max(0, h - top)
  for (const [, v] of this.views) {
    v.view.setBounds({ x: 0, y: top, width: w, height: viewH })
  }
  ```
  可见性不在这里,而在 `activate()`(`tabManager.ts:353`):`v.view.setVisible(vid === id)`。
  ⚠️ 副作用已在代码里确认:`create(url, activate=false)`(MCP `browser_new_tab {activate:false}`,
  `mcp.ts:471`)从不调 `activate()`,而 `View::SetVisible` 直接转发 `views::View::SetVisible`,Chromium 的
  `views::View::visible_` 默认 true(`electron_api_view.cc` + `view.cc`)→ **后台新建的标签视图会盖在当前页上**。
  本次把可见性收进 `layout()` 会顺手修掉它(§4 S3 的验证项 + §6 第 9 步真机对比)。
- **chrome UI(`App.vue`)是窗口自己的 webContents**,是合成时的**最底层**;页面视图按加入顺序盖在它上面
  (`docs/ARCHITECTURE.md` §3),所以**两个页面视图之间的空隙会露出底层(chrome 页面/窗口背景)** ——
  分隔条可以纯 DOM 画,不需要额外视图(本次也不可拖,所以不需要命中测试)。这一点未实测,见 §7 第 7 条。
- **核心浮层**:`OverlayContentId` 目前是 `'suggest' | 'confirm-close'`(`shared/types.ts:57`);
  `OverlayApp.vue` 的 `CORE` 注册表把它们映射到组件;`below-chrome` placement 的面板由主进程
  `OverlayManager.bandTopOf()` 定位,`bandTop = min(chromeHeight, ceil(payload.rect.y + payload.rect.height))`
  —— **payload 只要有 `rect` 字段就能贴住触发按钮**。
- **浮层事件回流**:组件 `emit('overlay-event')` → `OverlayApp` → `api.overlayEmit(id,event,args)`
  → `ipc.ts:108` 的 `ui:overlay-event`:`suggest` 特判转发 chrome,`close-request` 通用关闭,
  其余丢给 `kernel.routeOverlayEvent`(非 `plugin:` id 直接 `return false`)。**核心浮层必须自己开分支。**
- **chrome 是它自己下拉面板的 owner**(suggest 就是这样:chrome 生成 payload → `api.showOverlay` →
  面板只回传 `pick/hover/cancel`)。本次 `split-menu` 照抄这条路径。
- `JsonStore`(`stores.ts`):对象型数据**浅合并**默认值,数组字段整体替换;`settings.json` 缺字段时自动补默认值。
- `DEFAULT_SETTINGS` 在 `shared/url.ts:11`,必须满足 `Settings` 类型(`stores.ts:83` 直接传它);
  即「往 `Settings` 加字段」会被 tsc 强制要求同步默认值。
- `webContents.on('focus')` 存在(`electron.d.ts:17185`),可以用来做「点到哪半就激活哪半」。
- 单元测试基线:**36 文件 / 598 用例**(`docs/ARCHITECTURE.md` §11),纯逻辑放 `shared/` 才能被 vitest 覆盖。

## 2. 方案(数据流与关键设计)

### 2.1 状态模型

`TabManager` 新增:

```ts
interface SplitPair { leftId: number; rightId: number }
private split: SplitPair | null = null                              // 只有「一对」,不含方向含义之外的东西
private splitLevel: SplitLevel = { value: 50, unit: 'percent' }     // 左窗格宽度(可用的上一个预设)
private splitPresetId: string | null = null                         // 当前套用的预设 id(供面板高亮)
```

对外快照(`shared/split.ts`,三端共享):

```ts
export interface SplitState {
  active: boolean
  leftTabId: number | null
  rightTabId: number | null
  level: SplitLevel | null          // 当前左窗格宽度
  presetId: string | null           // 当前预设 id(预设被删掉后可能已不存在)
  leftWidth: number | null          // 主进程按当前窗口宽度算好的左窗格像素宽(渲染层画分隔条用)
  gap: number | null                // 两窗格间隔像素
}
```

`leftWidth/gap` 由主进程算:渲染层的 CSS px 与 `getContentSize()` 的 DIP 是同一套单位,所以渲染层可以
`left: leftWidth px; width: gap px` 直接画分隔条 —— **几何只有一处实现**(`computeSplitBounds`,纯函数,可单测)。

### 2.2 布局

`layout()` 成为可见性的**唯一来源**(修掉 §1 那个后台标签盖住当前页的既有 bug):

```ts
layout(): void {
  if (this.window.isDestroyed()) return            // 既有守卫,别删(2026-09-18 修 teardown 报错时加的)
  const [w, h] = this.window.getContentSize()
  const top = this.chromeHeight
  const viewH = Math.max(0, h - top)
  const geo = this.split ? computeSplitBounds({ totalWidth: w, level: this.splitLevel }) : null
  for (const [id, v] of this.views) {
    const isLeft = !!this.split && !!geo && id === this.split.leftId
    const isRight = !!this.split && !!geo && id === this.split.rightId
    const visible = geo ? isLeft || isRight : id === this.activeId
    if (visible) {
      v.view.setBounds(
        isLeft ? { x: 0, y: top, width: geo!.leftWidth, height: viewH }
        : isRight ? { x: geo!.leftWidth + geo!.gap, y: top, width: geo!.totalWidth - geo!.leftWidth - geo!.gap, height: viewH }
        : { x: 0, y: top, width: w, height: viewH }
      )
    }
    v.view.setVisible(visible)
  }
  if (this.split) this.emit('split-changed', this.splitState())   // 窗口缩放/预设变化 → 分隔条跟着动
}
```

`activate()` 里删掉 `v.view.setVisible(vid === id)`(布局接管),其余(焦点、`info.active`、事件)保持原样。

### 2.3 进入/退出/切换

| 动作 | 行为 |
| --- | --- |
| `enterSplit(rightTabId, level, presetId)` | 左 = **当前活动标签**,右 = `rightTabId`;已分屏时=**更换右窗格**(左不动) |
| `exitSplit()` | `split = null`;活动标签(可能是右窗格)独占整窗 |
| `applySplitLevel(level, presetId)` | 只改宽度;未分屏时仅记住,下次 `enterSplit` 用它 |
| `activate(id)` | `id` 不是分屏成员 → **先退出分屏**(问卷第 4 问)。是成员 → 只切焦点(两半都在) |
| 关闭成员(手动 `close` / `destroyed`) | 退出分屏,幸存那半接管整窗(`forgetSplitMember`) |
| 点到某一半的页面 | `wc.on('focus')` → 若是分屏成员且不是当前活动 → `activate(id)`(地址栏/导航跟随聚焦窗格) |

`split-changed` 广播:`sendToChrome`(chrome 需要它维护按钮态与面板 payload;overlay 面板的数据由 chrome 推)。

### 2.4 退化与边界

- 窗口窄到放不下两窗格(`avail < 2 * MIN_PANE`)→ `computeSplitBounds` 返回 `null` → 按「单窗格」渲染活动标签,
  但 `split` 状态**不清空**(窗口变宽自动恢复)。窗口 `minWidth: 720`,实际到不了这个分支。
- 分屏成员可以是任何标签:内部页面(`bow://settings`)、DevTools 前端标签都允许(并排看页面 + DevTools 是正经用法)。
- 左窗格 = 「打开面板时活动的那一半」?不 —— **进入时**取活动标签;**已分屏时不换左窗格**,只换右窗格。

### 2.5 面板数据流(chrome 是 owner,与 suggest 同构)

```
[工具栏「分屏」按钮] --click--> App.vue openSplitMenu()
      api.listTabs() + api.getSettings() + split 状态
      → api.showOverlay({ id:'split-menu', placement:'below-chrome',
                          payload:{ rect, tabs, presets, split } })
                     │
        Overlay 页面: SplitMenu.vue(只读 payload,透明背板点哪里都关)
          点候选标签  → emit('overlay-event','enter', tabId)
          点宽度预设  → emit('overlay-event','apply', presetId)
          关闭分屏    → emit('overlay-event','exit')
          新建并分屏  → emit('overlay-event','enter-new')
          点背板/Esc  → emit('overlay-event','cancel')
                     │  ipc.ts: 'split-menu' 与 suggest 同一个分支转发 chrome
        App.vue 收到 → 调 api.splitEnter/… → 主进程改状态 → sendToChrome('split:changed')
                     → App.vue 若面板开着,用新状态重推 payload(面板不关,方便连点几档宽度)
```

`enter` 后面板**不关**(马上能选宽度);`exit`/`cancel` 后面板关。点第三个标签/关标签导致退出分屏时,
`split:changed` 让按钮态与面板同步(面板重推;若此时面板还开着且分屏已被外面的操作关掉,面板显示「选标签开始分屏」)。

### 2.6 分隔条

`App.vue` 里一个 `position: fixed` 的元素(在 `.chrome` 内,`height: max-content` 不受影响):

```html
<div v-if="split.active && split.leftWidth != null" class="split-divider"
     :style="{ left: split.leftWidth + 'px', width: (split.gap ?? 4) + 'px', top: chromeHeight + 'px' }" />
```

`pointer-events: none`(不可拖,不抢事件),颜色用 `--bg3` + 两侧 `--border`。
`chromeHeight` 用 `report()` 里已有的实测值存一个 ref。

## 3. 改动清单

新增:

| 文件 | 内容 |
| --- | --- |
| `src/shared/split.ts` | 类型(`SplitPreset`/`SplitLevel`/`SplitState`)+ 纯函数 + `DEFAULT_SPLIT_PRESETS` / `EMPTY_SPLIT_STATE` |
| `src/renderer/src/components/SplitMenu.vue` | 分屏下拉面板(核心浮层组件) |
| `tests/split.test.ts` | 预设归一化 / 档位解析 / 几何计算 的纯逻辑单测 |

修改:

| 文件 | 改什么 |
| --- | --- |
| `src/shared/types.ts` | `CoreOverlayContentId` 加 `'split-menu'`;新增 `SplitMenuPayload`;`OverlayContentMap` 登记;`Settings.splitPresets` |
| `src/shared/url.ts` | `DEFAULT_SETTINGS.splitPresets = DEFAULT_SPLIT_PRESETS`(tsc 强制) |
| `src/main/tabManager.ts` | 分屏状态 + `splitState/enterSplit/exitSplit/applySplitLevel` + `layout()` 接管可见性与两窗格几何 + `forgetSplitMember` + `wc.on('focus')` + `'split-changed'` 事件 |
| `src/main/ipc.ts` | 4 个 handler(`split:get/enter/exit/apply`)+ `split-changed` 广播 + `ui:overlay-event` 的 `split-menu` 转发分支 |
| `src/preload/index.ts` | `getSplitState` / `splitEnter` / `splitExit` / `splitApplyPreset` / `onSplitChanged` |
| `src/renderer/src/App.vue` | 工具栏按钮 + 面板开关 + `split` 状态 + 标签栏分屏标记 + 分隔条 + Esc 关面板 |
| `src/renderer/src/overlay/OverlayApp.vue` | `CORE` 注册 `'split-menu'` |
| `src/renderer/src/settings/GeneralSettings.vue` | 「分屏宽度预设」分区(增删改 + 恢复默认) |
| `README.md` | 新小节「分屏」+ 设置页一节补预设说明 |
| `docs/ARCHITECTURE.md` | §1 目录地图、§3 视图模型/浮层表、§7.1/7.2、§8 默认值、§9 IPC 表、§11 测试基线 |

**不动**:`src/main/index.ts`(接线都在 `ipc.ts`;resize 已经调 `tabs.layout()`)、`src/main/overlay.ts`、
`src/main/tabShortcuts.ts`(不加分屏快捷键)、`closeConfirm.ts`、所有插件、`docs/ARCHITECTURE.md §12 漂移表`。

## 4. 分步实施(每步单独可验证)

### S1 `src/shared/split.ts`(纯逻辑先行)

```ts
export type SplitUnit = 'percent' | 'px'
export interface SplitPreset { id: string; label: string; value: number; unit: SplitUnit }
export interface SplitLevel { value: number; unit: SplitUnit }
export interface SplitState { active; leftTabId; rightTabId; level; presetId; leftWidth; gap }
export interface SplitGeometry { leftWidth: number; gap: number; totalWidth: number }

export const SPLIT_GAP = 4
export const SPLIT_MIN_PANE = 120
export const SPLIT_PERCENT_RANGE = [10, 90] as const
export const SPLIT_PX_RANGE = [160, 4000] as const
export const SPLIT_PRESET_LIMIT = 12
export const DEFAULT_SPLIT_LEVEL: SplitLevel = { value: 50, unit: 'percent' }
export const DEFAULT_SPLIT_PRESETS: SplitPreset[] = [
  { id: 'p25', label: '左 1/4', value: 25, unit: 'percent' },
  { id: 'p33', label: '左 1/3', value: 33, unit: 'percent' },
  { id: 'p50', label: '对半',   value: 50, unit: 'percent' },
  { id: 'p67', label: '左 2/3', value: 67, unit: 'percent' },
  { id: 'p75', label: '左 3/4', value: 75, unit: 'percent' }
]
export const EMPTY_SPLIT_STATE: SplitState = { active:false, leftTabId:null, rightTabId:null, level:null, presetId:null, leftWidth:null, gap:null }

export function clampSplitValue(unit: SplitUnit, value: number): number          // 取整 + 按单位夹紧
export function normalizeSplitPresets(raw: unknown): SplitPreset[]              // 过滤坏项、夹紧、去重 id、截断到 LIMIT
export function nextSplitPresetId(ids: string[]): string                        // 'p1'… 取未占用的最小序号
export function resolveSplitLevel(presets: SplitPreset[], presetId?: string | null): { level: SplitLevel; presetId: string | null }
export function computeSplitBounds(input: { totalWidth: number; level: SplitLevel; gap?: number; minPane?: number }): SplitGeometry | null
```

`computeSplitBounds` 的语义(要写进注释,不要靠猜):

- 可用宽度 `avail = floor(totalWidth) - gap`;**percent 按 `avail` 算**(所以 50% = 两半等宽),**px 直接用**;
- 左窗格夹紧到 `[minPane, avail - minPane]`;
- `avail < 2 * minPane` 或 `totalWidth` 非有限值 → 返回 `null`(调用方退化为单窗格)。

验证:`bun run typecheck`(此时还没人引用,应全绿)。

### S2 `tests/split.test.ts`

覆盖:`resolveSplitLevel`(命中 / 未命中 / 预设列表为空)、`normalizeSplitPresets`(非数组、`value` 是字符串、
unit 乱写、超限截断、id 重复、空 label 补默认名)、`clampSplitValue` 两端、`computeSplitBounds`
(percent 50 → 两半等宽、percent 越界夹紧、px 固定宽、窄窗返回 `null`、`totalWidth` 为 0/NaN)。
验证:`bunx vitest --run tests/split.test.ts`。

### S3 `src/main/tabManager.ts`

按 §2.2/§2.3 实现。要点:

- `TabEvents` 加 `'split-changed': (s: SplitState) => void`;
- `layout()` 接管 `setVisible`(**确认这是修 bug,不是行为回归**);
- `forgetSplitMember(id)` 在 `close(id)` 开头与 `wireLifecycle` 的 `destroyed` 里都调用;
- `wc.on('focus')` 只在「已分屏 && id 是成员 && 不是当前活动」时 `activate(id)`,递归由 `activate` 的
  `if (this.activeId === id) return` 挡住;
- `splitState()` **每次现算** `leftWidth/gap`(不缓存),保证窗口缩放后渲染层拿到的是新值。

验证:`bun run typecheck`;`bunx vitest --run`(既有 598 例不得变红 —— `tests/fakeTabs.ts` 没实现分屏面,
MCP 测试不碰 `split*`,应当无影响)。

### S4 `src/main/ipc.ts` + `src/preload/index.ts`

```ts
tabs.on('split-changed', (s) => sendToChrome('split:changed', s))

const splitPresets = (): SplitPreset[] => normalizeSplitPresets(getSettingsStore().get().splitPresets)
ipcMain.handle('split:get', () => tabs.splitState())
ipcMain.handle('split:enter', (_e, rightTabId?: number, presetId?: string) => {
  const { level, presetId: pid } = resolveSplitLevel(splitPresets(), presetId)
  if (typeof rightTabId === 'number') tabs.enterSplit(rightTabId, level, pid)
  else tabs.enterSplit(tabs.create('about:blank', false).id, level, pid)   // 没有别的标签:新建一个再分屏
  return tabs.splitState()
})
ipcMain.handle('split:exit', () => { tabs.exitSplit(); return tabs.splitState() })
ipcMain.handle('split:apply', (_e, presetId: string) => {
  const { level, presetId: pid } = resolveSplitLevel(splitPresets(), presetId)
  tabs.applySplitLevel(level, pid)
  return tabs.splitState()
})
```

`ui:overlay-event` 的转发分支改成 `if (ev.id === 'suggest' || ev.id === 'split-menu') { sendToChrome('overlay-event', ev); return true }`
(**必须在通用 `close-request` 分支之前**,否则 chrome 收不到、`splitMenuOpen` 会变脏)。

`preload/index.ts` 的 `BrowserAPI` 加 5 个成员(`getSplitState` / `splitEnter` / `splitExit` / `splitApplyPreset` / `onSplitChanged`),
实现一律 `ipcRenderer.invoke` / `subscribe`(与既有成员同风格)。`index.d.ts` 不用改(它 re-export `BrowserAPI`)。

验证:`bun run typecheck`;`bun run dev` 里从 chrome 控制台 `await browserAPI.getSplitState()` 应返回
`{active:false,…}`(此时 UI 还没接,先证明通道通了)。

### S5 `src/renderer/src/App.vue`

- `const split = ref<SplitState>({ ...EMPTY_SPLIT_STATE })`、`const presets = ref<SplitPreset[]>([])`、
  `const splitMenuOpen = ref(false)`、`let splitMenuPayload: SplitMenuPayload | null = null`、
  `const chromeHeight = ref(0)`(在既有 `report()` 里赋值);
- `onMounted`:`split.value = await api.getSplitState()`,订阅 `api.onSplitChanged(s => { split.value = s; if (splitMenuOpen.value) void pushSplitMenu() })`;
- `openSplitMenu()` 组 payload(§2.5);`pushSplitMenu()` 在面板开着时重推;`closeSplitMenu()` 置 `splitMenuOpen=false` + `api.showOverlay(null)`;
- `api.onOverlayEvent` 增加 `split-menu` 分支:`enter`→`api.splitEnter(tabId)`(不关面板)、
  `enter-new`→`api.splitEnter()`、`apply`→`api.splitApplyPreset(id)`、`exit`→`api.splitExit()`+关面板、`cancel`→关面板;
- 工具栏加按钮(在插件插槽与「恢复刚关闭的标签」之间):
  `<button ref="splitBtn" class="tool-btn no-drag" :class="{on: split.active}" title="分屏" @click="toggleSplitMenu"><Columns2 :size="16"/></button>`;
- 标签栏:分屏成员加 class(`split-left`/`split-right`),CSS 用顶部 2px 强调条区分左右;
- `onKeydown` 加 `Escape` → 关面板;
- 分隔条(§2.6)。

验证:`bun run dev` 点按钮出面板、点候选标签进入分屏、两半都在、预设按钮即时改宽度、Esc/点空白关闭。

### S6 `src/renderer/src/components/SplitMenu.vue` + `OverlayApp.vue` 注册

组件:`defineProps<{ payload: SplitMenuPayload; bandTop: number }>()`;根节点
`@mousedown.prevent`(与 `SuggestPanel` 同款,避免跨 webContents 抢焦点),一个 `position: fixed; inset: 0`
的透明背板 `@mousedown.self="cancel"`;面板本体靠右定位
(`right = window.innerWidth - (rect.x + rect.width)`,`top = rect.y + rect.height - bandTop + 2`)。

面板内容:

1. 头部「分屏」(已分屏时右侧显示「关闭分屏」);
2. 已分屏时:左/右两个标签标题(用 `payload.tabs` + `payload.split.leftTabId/rightTabId` 查);
3. 「宽度预设」:每个预设一个按钮(左边一个按比例画的小示意图 + `label` + `50%`/`800px`),
   当前 `payload.split.presetId` 高亮;没有预设时给一句「去 设置 → 常规 里添加」;
4. 「在右侧打开」/「更换右侧标签」:候选 = `tabs` 去掉左窗格(与右窗格);为空时是「新建空白标签并分屏」;
5. 底部一行提示「分屏只保留两个标签;点其它标签会退出分屏」。

`OverlayApp.vue` 的 `CORE` 加 `'split-menu': markRaw(SplitMenu)`。

验证:`bun run typecheck`;dev 里走一遍完整交互。

### S7 `src/renderer/src/settings/GeneralSettings.vue`(预设增删改)

在「主页」行之后加一个 `.set-row.set-col` 分区:

- 每行:`label` 输入 + `value` 数字输入 + 单位 `select`(percent/px) + 删除按钮;
- 底部:「添加预设」(`nextSplitPresetId`)与「恢复默认」(`DEFAULT_SPLIT_PRESETS`);
- 任何改动 → `normalizeSplitPresets(draft)` → 若与 draft 长度不同则提示被丢弃的非法项 → `api.setSettings({ splitPresets })`;
- 落盘走既有 `settings:set`(即时保存,无保存按钮)。

验证:改一条预设 → 读 `~/.config/mcp-browser/settings.json`(dev 下 XDG)确认写进;刷新设置页后仍显示。

### S8 文档

- `README.md`:`## 关闭窗口` 之后加 `## 分屏`(入口、四个交互规则、预设与单位说明、窄窗退化、不持久化);
  `## 设置页` 的「常规」一条补「分屏宽度预设」。
- `docs/ARCHITECTURE.md`:§1 目录地图(`shared/split.ts`、`SplitMenu.vue`)、§3(分屏时的视图布局 + `split-menu` 浮层)、
  §7.1(`browserAPI` 新成员)、§7.2(`CORE` 注册表 + 「分屏面板由 chrome 拥有,与 suggest 同构」)、
  §8(`settings.json` 默认值加 `splitPresets`)、§9(4 个 IPC 通道 + `split:changed` 发送行)、
  §11(测试基线改成新数字 + 表格补一行)、§13(补一条坑:面板 owner 必须在 chrome;`layout()` 是可见性唯一来源)。

验证:`grep` 校对文档里出现的通道名/字段名与代码一致。

## 5. 验证矩阵

| 层次 | 命令 | 期望 |
| --- | --- | --- |
| 类型 | `bun run typecheck` | 两个 tsconfig 都过 |
| 单测 | `bunx vitest --run` | 新增 `split.test.ts` 全绿,既有 598 例不变红 |
| 构建 | `bun run build` | 通过(无新外部依赖,`bundleScan` 不受影响) |
| 真机 | 见 §6 | 两窗格真实尺寸、退出规则、预设落盘 |

## 6. 真机验收(必做,CDP;沿用 2026-09-18 那套手法)

```bash
XDG_CONFIG_HOME=/tmp/bow-split-<ts> bunx electron . --remote-debugging-port=9223
```
(隔离 profile 同时避开单实例锁与真实用户数据;userData 落在 `/tmp/bow-split-<ts>/mcp-browser/`。)

用 CDP 连三类目标:chrome(`/renderer/index.html`)、overlay(`/renderer/overlay.html`,**第一次 show 才创建,
要轮询等元素出现**)、以及每个页面标签(`data:text/html,…`,一页一个 target)。

| # | 步骤 | 断言 |
| --- | --- | --- |
| 1 | `browserAPI.createTab('data:text/html,<title>A</title>…')` 两次 | 两个页面 target,各自 `innerWidth === 窗口内容宽` |
| 2 | 点工具栏分屏按钮 → overlay 里点候选行 | `getSplitState()` = `{active:true, leftTabId, rightTabId, leftWidth: round((W-4)*50/100)}` |
| 3 | 读两个页面 target 的 `window.innerWidth/innerHeight` | 左 = `leftWidth`,右 = `W-4-leftWidth`,两者 `innerHeight = H - chromeHeight`(**真实 bounds 的直接证据**) |
| 4 | `splitApplyPreset('p25')` / `('p75')` | `leftWidth` 随之变;两个页面 target 的 `innerWidth` 同步变 |
| 5 | 点第二个(右)窗格的页面 | `getActiveTab()` 变成右窗格那个标签(地址栏跟着换) |
| 6 | `createTab` 并 activate 第三个标签 | `split.active === false`;该页面 target `innerWidth === W` |
| 7 | 重新分屏后关掉其中一个成员 | `split.active === false`,幸存那半 `innerWidth === W` |
| 8 | 设置页改预设 → 重开设置页 | 值持久化;`cat /tmp/bow-split-<ts>/mcp-browser/settings.json` 里有 `splitPresets` |
| 9 | 顺带回归:`browser_new_tab {activate:false}`(或 `createTab(url,false)`) | **不再**盖住当前页(§1 的既有 bug 已修) |
| 10 | 全程 | `browser.log` 里 `未捕获异常` 0 条 |

若第 5 步失败(说明 `wc.on('focus')` 对 WebContentsView 不可靠):改用 `wc.on('before-input-event')` 作为
激活窗格的触发器(输入事件一定会到对应 webContents);这条**只改触发源,不改状态机**。

## 7. 风险与未知

1. **`layout()` 接管可见性**是行为变更(修 bug),但它同时影响「后台标签」「崩溃标签」「关闭中标签」等路径 ——
   真机第 6/7/9 步 + `browser.log` 无异常是判据;尤其要确认**关窗口那条路径**不受影响:
   `layout()` 与 `activate()` 开头已有的 `window.isDestroyed()` 守卫(2026-09-18 修 `Object has been destroyed` 时加的)
   **必须原样保留**,新加的 `setVisible` 循环要在守卫之后、且对已销毁窗口不执行。
2. **`wc.on('focus')` 对 WebContentsView 是否触发**未实测(有 fallback,见 §6)。
3. **`split:changed` 触发频率**:窗口 resize 期间每帧一条 IPC。payload 很小,且 resize 本来就在跑 `layout()`;
   若观察到卡顿,改成「仅在 `leftWidth` 变化时 emit」(在 TabManager 里缓存上一次值)。
4. **像素预设 + 窗口缩放**:px 档在窄窗里会被 `computeSplitBounds` 夹紧(不会出现半窗格消失),
   但用户看到的宽度不等于预设值 —— 这是刻意行为,文档要写清。
5. **预设被删但正在使用**:`presetId` 指向不存在的预设 → 面板不高亮,宽度保持。可接受,文档提一句。
6. `Settings` 是插件也读的核心存储(`cors` 迁移读 `corsBypassEnabled`),加字段对它们无影响(浅合并只增不改)。
7. **两窗格之间的空隙到底画的是谁**(推断:chrome 页面的背景,因为窗口 webContents 是合成底层)——
   没有实测过。两种结果都不影响功能:`SPLIT_GAP = 4` 的空隙露出的颜色无论来自 chrome 页面(`--bg`)
   还是窗口 `backgroundColor`(`index.ts` 里也是 `#1e1f24`),视觉上都是同一条深色分隔带。
   受影响的只是 §2.6 那个带 `--border` 描边的美化元素 —— 若真机发现空隙里描边不可见,直接删掉这个元素,
   保留纯空隙(不算回归)。

## 8. 不做(明确排除)

- 上下分屏 / 多窗格(>2)/ 拖动分隔条 / 分屏快捷键 / MCP 分屏工具 / 分屏状态持久化 / 左右窗格互换按钮。

## 9. 收尾

- 提交按仓库惯例拆:① 功能(`shared/split.ts` + main + preload + renderer + tests)② 文档(README + ARCHITECTURE)
  ③ 计划文件(`.pi/plans/2026-09-19-split-view/plan.md` 追加实施记录),或在 ① 里带上计划文件 —— 与
  `78a46c8`/`bb069ad` 的形态一致。
- 完成后:SCRATCHPAD 若有相关条目勾掉;把「真机验证结论 + 测试基线新数字」写进 MEMORY.md 与当日 daily。

---

## 10. 实施记录(2026-09-19 完成)

### 10.1 与计划的偏差(三处,均已落进代码与文档)

1. **进入分屏的默认宽度**。计划里 `resolveSplitLevel(presets, undefined)` 的语义是「没传 presetId 就用列表第一个」,
   实现后真机表现为**进入分屏默认 25%**(默认预设表第一项是「左 1/4」),这不是用户期望的默认。
   改成:`split:enter` **省略 presetId 时沿用 `TabManager` 记住的档位**(进程内首次 = `DEFAULT_SPLIT_LEVEL` 50%,
   之后 = 上一次套用的预设);`enterSplit(rightTabId, preset|null)` 只在调用方明确给了预设时覆盖档位。
   连带**删掉了 `resolveSplitLevel`**(它只服务于这个已被推翻的语义,留着就是死代码),新增
   `matchSplitPreset(presets, level)`:面板在 `presetId` 为空(本次会话还没点过预设)时按「值+单位」反查高亮那一项。
2. **活动窗格的触发源**:计划只写 `wc.on('focus')`。实现时同时接上 `wc.on('input-event')`
   (注释里写了原因:鼠标点击/滚轮/键盘都会先经过它,某个平台不发 focus 也不会出现「看着右半却在操作左半」)。
   两者共用同一个 handler,`activateId === id` 早退防递归。
3. **`SplitMenuPayload` 多了 `leftTabId`**:面板要在「未分屏」时也知道谁将成为左窗格(候选列表要把它排除),
   计划里靠 `split.leftTabId` 推,未分屏时它是 null,于是显式加一个字段(chrome 组装:`split.active ? split.leftTabId : 活动标签`)。

其余按计划:预设只在设置页增删改、不可拖分隔条、点第三个标签退出分屏、`layout()` 接管可见性(并顺手修掉
`create(url, activate=false)` 的后台标签会盖住当前页的既有 bug)。

### 10.2 文件

新增:`src/shared/split.ts`、`src/renderer/src/components/SplitMenu.vue`、`tests/split.test.ts`、本文件。
修改:`src/shared/types.ts`、`src/shared/url.ts`、`src/main/tabManager.ts`、`src/main/ipc.ts`、
`src/preload/index.ts`、`src/renderer/src/App.vue`、`src/renderer/src/overlay/OverlayApp.vue`、
`src/renderer/src/settings/GeneralSettings.vue`、`src/renderer/src/style.css`、`README.md`、`docs/ARCHITECTURE.md`。

### 10.3 验证

| 项 | 结果 |
| --- | --- |
| `bun run typecheck` | 过(两个 tsconfig) |
| `bunx vitest --run` | **37 文件 / 621 用例全绿**(基线 36/598 → 新增 `tests/split.test.ts` 23 例) |
| `bun run build` | 过 |
| 真机 CDP E2E(`/tmp/split-e2e.mjs`,**53/53 通过**,跑了两遍) | 见下 |

真机 E2E 手法(可复用):`XDG_CONFIG_HOME=/tmp/bow-split-run` 隔离 profile + `--remote-debugging-port=9333`,
**直接 spawn `node_modules/electron/dist/electron`(不要用 `bunx electron`)** 并 `detached: true`,
收尾 `process.kill(-pid)` 杀整个进程组 —— 第一版用 `bunx` 只杀掉了包装进程,残留实例占着调试端口,
第二轮连上去看到的是**旧 bundle 的页面**(`split-btn` 永远找不到),白白怀疑了半天。
另外**开头就要检查调试端口没被占用**,否则同样会连到旧实例。

断言覆盖(全部通过):

- 基线:活动页 `innerWidth/innerHeight` = 窗口内容区 - chrome 高;后台页 `visibilityState = hidden`;
- UI 路径:工具栏按钮 → 面板列出其它标签 → 点候选 → 分屏生效(左/右 id、默认 50%、gap=4、
  按钮 `.on`、标签栏「左/右」标记、分隔条渲染);
- 真实 bounds:两个页面 target 的 `innerWidth` 分别 = `leftWidth` 与 `总宽-间隔-leftWidth`,高度 = 窗口高 - chrome 高
  (**比截图更硬的证据**:页面的 viewport 就是视图的 bounds);
- 面板里点 25% 预设 → geometry 与页面宽度同步变;`setSettings` 写 px 预设(800px)后套用 → 左窗格恰好 800;
  套用一个**已被删除的预设 id** → 忽略,宽度不变;
- 点第三个标签 → 退出分屏、按钮/分隔条复位、新标签铺满;
- **点右半页 → 活动标签变成右半**(CDP `Input.dispatchMouseEvent` 下发到该 target;`input-event` 兜底路径生效),
  分屏不退出;
- 关掉分屏的一半 → 退出分屏、幸存那半铺满;
- **既有 bug 回归**:`createTab(url, false)` 的后台标签 `visibilityState = hidden`(不再盖住当前页),
  激活后变 visible、原活动页转 hidden;
- 设置页:两条预设渲染 → 改值(66)+ 添加 → 落盘 `["800px","66%","50%"]` → 删除 → 剩两条;
- 窗口缩放(`window.resizeTo`;Electron **没有**实现 `Browser.getWindowForTarget`):比例档按新宽度重算、
  页面宽度与分隔条左偏移同步;
- 无右窗格时「新建空白标签并分屏」:多一个标签、左窗格不变、右窗格 = 新标签;
- 面板关闭路径:点空白(背板)关闭、`Esc` 关闭;
- 主进程 `未捕获异常` 0 条。

未验证的一条(建议用户手工点一下):**真实鼠标点击另一半时地址栏是否跟随**。CDP 合成点击既走通了
`input-event` 路径(所以状态机是通的),但它在原生层不移动键盘焦点 —— 与真实点击不完全等价。
若用户实测发现点右半后地址栏没换,把 `wc.on('focus')` 那条换成/加上 `before-input-event` 即可(只换触发源)。

### 10.4 收尾

- SCRATCHPAD 无相关条目需要勾。
- 文档:README 新增「## 分屏」+ 设置页/数据存储/架构速览同步;ARCHITECTURE §1/§3/§7.1/§7.2/§8/§9/§11/§13 同步
  (§12 漂移审计表按约定未动;§11 基线数字已更新为 37/621)。
