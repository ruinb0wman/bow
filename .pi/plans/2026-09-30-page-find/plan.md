# bow 页内查找(Ctrl+F)

日期:2026-09-30 · 模式:plan · 状态:待批准

## 0. 目标与已确认的决策

**目标**:给 bow 补上 `Ctrl/Cmd+F` 页内查找。当前全仓库没有任何 `findInPage` / `stopFindInPage` 调用
(`grep -rn "findInPage" src/` 无命中),`matchTabHotkey` 也没有 `f` 分支 —— 所以按 `Ctrl+F` 是**死键**:
主进程不拦、Chromium 在 `WebContentsView` 里也没有内建查找条。

**用户已拍板(本轮问答)**:

| 决策 | 选择 |
| --- | --- |
| 查找条宿主 | **复用 Overlay**,给它加一个「页面右上角小条」placement(bounds 恰好包住条子,不吃页面点击)。代价:浮层同一时刻只能有一份 —— 打开地址栏建议 / 分屏面板 / 下载面板时查找条被替换(页内高亮仍在,状态在主进程) |
| 生效范围 | **网页 + 内部页(设置 / 笔记)**;终端页 `Ctrl+F`(shell 的 forward-char)与 DevTools 前端(自带查找)**一律放行** |
| 功能范围 | 输入即搜、`n/m` 计数、`Enter` 下一个 / `Shift+Enter` 上一个、`Esc` 关闭、`Aa` 区分大小写开关。**不做**全字匹配 / 正则(Electron `findInPage` 不支持,需自研高亮,列为后续) |

**必须说明的假设(代码里读出来的)**:

1. 查找高亮与计数全部用 Electron 原生 `webContents.findInPage()` + `'found-in-page'` 事件
   (`node_modules/electron/electron.d.ts`:`findInPage(text, {forward?, findNext?, matchCase?}): number`、
   `stopFindInPage('clearSelection'|'keepSelection'|'activateSelection')`、
   `FoundInPageResult = {requestId, activeMatchOrdinal, matches, selectionArea, finalUpdate}`)。
   原生实现会自己高亮全部匹配并滚动到当前项,不需要注入任何页面脚本,也不受页面 CSP 影响。
2. 浮层视图是**常驻单实例、透明、WebContentsView**;它没有点击穿透(`setIgnoreMouseEvents` 只属于
   BaseWindow/BrowserWindow,见 `main/toasts.ts` 顶部),所以**不能铺满窗口** —— 新 placement 的 bounds
   必须刚好是查找条那一个小矩形(与右下角通知同一套办法)。
3. `tabShortcuts.ts` 的 `before-input-event` 对**所有** webContents 生效(含 chrome / overlay / 标签页);
   `windows.byWebContents(contents)` 认不出 DevTools detach 窗口时会**回退到聚焦窗口**(见文件头注释)——
   所以「焦点在 Electron 自带 DevTools 里按 Ctrl+F」会被误当成 bow 的查找,必须单独挡掉(见 §3.4)。
4. 内部页面标签就是普通 `WebContentsView` + 应用 preload(`docs/ARCHITECTURE.md` §3),
   `findInPage` 对它们同样有效;终端页的 webContents 也是标签,靠「放行给 shell」排除。

---

## 1. 现状:必须挂在哪些既有机制上

| 事实 | 位置(引用) |
| --- | --- |
| 核心快捷键统一在 `matchTabHotkey` 识别、`tabShortcuts.ts` 分派;`preventDefault` 在 switch 之前,放行必须在那之前 `return` | `src/shared/shortcuts.ts:82`;`src/main/tabShortcuts.ts:69-76` |
| 终端页放行是**按 action** 的白名单:`releasesToTerminal()` 里列了 `focus-address / reload / downloads / back / forward` | `src/shared/shortcuts.ts:141-147` |
| Overlay 只有两种 placement:`full`(铺满、聚焦接管)与 `below-chrome`(从 chrome 底边起到底部,全宽带) | `src/main/overlay.ts:9-11`、`:118-142` |
| 浮层只在 `placement === 'full'` 时抢键盘焦点;关闭时也只在 `full` 时把焦点还给页面 | `src/main/overlay.ts:96-97`、`:65-79` |
| Overlay 页面 → 主进程的通用回传是 `ui:overlay-event`;`suggest`/`split-menu` 转发 chrome,`confirm-close` 有核心分支,其余走 `kernel.routeOverlayEvent()` | `src/main/ipc.ts:196-215` |
| `OverlayApp.vue` 注册表 = 核心 `{suggest, 'split-menu', 'confirm-close'}` + 已启用插件的 overlays;组件契约 = `payload` prop + `band-top` prop + `overlay-event` emit | `src/renderer/src/overlay/OverlayApp.vue:22-27` |
| `preload` 是一个通用 `BrowserAPI`,chrome / overlay / 内部页共用;订阅用 `subscribe(channel, cb)` | `src/preload/index.ts:16-46`、`:120-128` |
| **插件打不开浮层**(`PluginContext` 没有 overlay 面)⇒ 这个功能必须在**核心**,不能做成插件 | `src/main/plugins/types.ts:110-124` |

### 相关的既有行为(不是要改,是要遵守)

- 全窗浮层(书签 / 下载 / 关窗确认)打开时,`Ctrl+T` / `Ctrl+L` / `Ctrl+J` 都**不抢焦点**。查找同样照此:
  `overlay.isFullOpen` 时不打开。
- 窗口缩放 → `overlay.layout()`;chrome 高度上报 → `tabs.setChromeHeight()` + `overlay.layout()`;
  这些路已存在,小条会自动跟着重排。
- 新标签 / 关标签 → `tabs.on('tabs-changed')` 里 `overlay.raise()`,小条不会被新页面视图盖住。

---

## 2. 要改的文件(精确清单)

### 2.1 新增

| 文件 | 职责 |
| --- | --- |
| `src/shared/find.ts` | **纯逻辑**(三端安全、可单测):查找条尺寸常量 + `findBarRect()` 几何函数。不 import electron / vue |
| `src/main/findBar.ts` | 查找会话状态机(每窗口一份,`WeakMap<WindowContext, FindState>`):打开 / 改词 / 上下一项 / 关闭、`found-in-page` 监听与去重、标签生命周期收尾 |
| `src/renderer/src/components/FindBar.vue` | 查找条 UI(overlay 组件):输入框 / 计数 / `Aa` / 上下一项 / 关闭;只回传 `overlay-event`,结果经 `find:state` 推下来 |
| `tests/find.test.ts` | `shared/find.ts` 的几何用例 + `main/findBar.ts` 的状态机用例(用 `tests/fakeWc.ts` 的 `FakeWc` + 一个极小的 fake ctx) |

### 2.2 修改

| 文件 | 改什么 | 现状引用 |
| --- | --- | --- |
| `src/shared/types.ts` | ① `OverlayPlacement` 加 `'page-top-right'`;② `CoreOverlayContentId` 加 `'find'`;③ `OverlayContentMap` 加 `find: FindPayload`;④ 新增 `FindPayload` / `FindStateMessage` | 第 80-84、89-95、123-127 行 |
| `src/shared/shortcuts.ts` | ① `TabHotkey` 加 `{ action: 'find' }`;② `matchTabHotkey` 非 shift 分支加 `f`/`KeyF`;③ `releasesToTerminal` 加 `'find'`;④ 顶部与函数注释同步 | 第 30-65、106-116、141-147 行 |
| `src/main/overlay.ts` | ① `layout()` 增加 `page-top-right` 分支(调 `findBarRect`);② `show()` 给 `find` 也 `webContents.focus()`;③ `show(null)` 把 `find` 也纳入「关闭后把焦点还给活动页面」;④ `did-finish-load` 补发后对 `find` 补一次焦点 | 第 65-79、96-97、118-142、151-160 行 |
| `src/main/tabShortcuts.ts` | ① `hk.action === 'find'` 的 DevTools 放行(两个判据,见 §3.4);② `switch` 加 `case 'find'` → 调 `openFind(ctx, srcTabId)` | 第 44-56、69-175 行 |
| `src/main/ipc.ts` | `ui:overlay-event` 在通用 `close-request` **之前**加 `if (ev.id === 'find') { handleFindEvent(ctx, ev); return true }` | 第 196-215 行 |
| `src/main/index.ts` | `wireWindowContext` 里把 `tab-navigated` / `tab-activated` / `tab-closed` 接到 `findBar` 的收尾函数 | 第 143-158 行 |
| `src/preload/index.ts` | `BrowserAPI` 加 `onFindState`;实现 `subscribe('find:state', cb)`;`index.d.ts` 无需改(全局类型由 `BrowserAPI` 导出) | 第 16-46、120-128 行 |
| `src/renderer/src/overlay/OverlayApp.vue` | `import FindBar`;`CORE` 加 `find: markRaw(FindBar)` | 第 22-27 行 |
| `src/shared/shortcutCatalog.ts` | `view` 组加一条 `Ctrl+F`(label「页内查找」,note 写终端放行 / DevTools 放行 / 与其它浮层互斥) | 第 108-140 行 |
| `README.md` | 「手动使用快捷键」加 `Ctrl+F` 条目;终端一节把 `Ctrl+F` 列进「归 shell」;首段能力列表按需补一句 | 第 3、405-440、505-520 行 |
| `docs/ARCHITECTURE.md` | §3 布局引擎「两种 placement」→ 三种 + 新 placement 说明;§3 overlay 消息流表加 `find` 行 + `find:state` 反向下行;§7.2 快捷键分工补 `Ctrl+F` 的接管/放行判据;§7.2 `OverlayApp.vue` 注册表加 `find`;§8 通道表加 `find:state` | 各节 |
| `.pi/plans/settings-shortcuts-help.md` | §「视图与面板」键位清单补 `Ctrl+F`(该文件自己写了「改键位时同步本文件」) | 第 113-116、158-160 行 |

### 2.3 不改(有意)

- `src/main/plugins/**`、`src/renderer/src/plugins/**`:查找是**核心**能力(插件没有 overlay 面)。
- 三个 `tsconfig.*`:新文件都落在既有 include 里(`src/shared`、`src/main`、`src/renderer` 通配);
  `FindBar.vue` 不 import `node:*` / electron,不触发 bundle 边界问题。
- `src/main/windows.ts`:`WindowContext` 结构不变 —— 查找状态用模块级 `WeakMap` 挂在 `ctx` 上,
  不改 `register()` 签名,`tests/fakeWindows.ts` 不受影响。
- `overlay.html` / `electron.vite.config.ts`:复用 overlay 入口,不新增渲染 entry。

---

## 3. 关键实现细节

### 3.1 `src/shared/find.ts`(纯几何)

```ts
export const FIND_BAR_WIDTH = 420
export const FIND_BAR_HEIGHT = 44
export const FIND_BAR_MARGIN = 10
export const FIND_BAR_MIN_WIDTH = 220

/** 查找条在窗口内容坐标里的矩形:贴页面区右上角,四周留白;窗口太窄/太矮时夹住不越界 */
export function findBarRect(o: { windowWidth: number; windowHeight: number; chromeHeight: number }): Rect
```

`findBarRect` 的责任只有这一点:宽度 = `clamp(FIND_BAR_WIDTH, FIND_BAR_MIN_WIDTH, windowWidth - 2*margin)`,
`x = windowWidth - width - margin`(并夹到 `>= margin`),`y = clamp(chromeHeight + margin, 0, windowHeight - height - margin)`。
放共享层是为了能单测(与 `shared/split.ts` 的 `focusRingBars` 同一思路:几何只有一处实现)。

### 3.2 `src/shared/types.ts`

```ts
export type OverlayPlacement = 'full' | 'below-chrome' | 'page-top-right'
export type CoreOverlayContentId = 'suggest' | 'confirm-close' | 'split-menu' | 'find'

/** 页内查找浮层的初始状态(结果由 find:state 反向推,不走 payload) */
export interface FindPayload {
  query: string
  matchCase: boolean
}

/** 主进程 → overlay:查找结果下行。refocus=true 表示「Ctrl+F 再次按下,请重新聚焦并全选输入框」 */
export interface FindStateMessage {
  requestId?: number
  matches?: number
  activeMatchOrdinal?: number
  finalUpdate?: boolean
  refocus?: boolean
}

export interface OverlayContentMap {
  suggest: SuggestPayload
  'confirm-close': CloseConfirmPayload
  'split-menu': SplitMenuPayload
  find: FindPayload
}
```

### 3.3 `src/main/overlay.ts`

- `layout()` 加分支(**只在小矩形里,绝不满屏**):

```ts
if (this.current.placement === 'page-top-right') {
  const r = findBarRect({ windowWidth: w, windowHeight: h, chromeHeight: this.tabs.getChromeHeight() })
  this.view.setBounds(r)
  return
}
```

- `show()` 的聚焦条件:`placement === 'full' || content.id === 'find'`。
  因为结果走独立的 `find:state` 通道,**不会**在每次 `found-in-page` 时重调 `show()`,
  所以这里「每次 show 都聚焦」不会在地敲字时把焦点从页面抢回来。
- `show(null)` 的 `refocusTab` 改成 `this.current.placement === 'full' || this.current.id === 'find'`。
- `did-finish-load` 补发之后:`if (this.current?.id === 'find') this.view!.webContents.focus()`
  (首开时视图可能刚创建,`show()` 里的 focus 会早于加载完成)。

### 3.4 `src/main/tabShortcuts.ts`

在 `const hk = matchTabHotkey(input)` 之后、任何 `preventDefault` 之前,加两条 DevTools 放行:

```ts
// Ctrl+F 在 DevTools 里归 DevTools 自己:
// ① Electron 自带 DevTools 的 detach 窗口不是 bow 的窗口 —— byWebContents 认不出会回退到聚焦窗口,
//    不挡下来的话 bow 会抢走 DevTools 的查找(URL 判据与 devtools.ts 同源);
// ② 远程调试前端标签(TabInfo.inspector)自带查找,且它的 URL 可能是 https 前端(不只 devtools://)——
//    第二种判据必须在下面拿到 srcTab 之后再查。
if (hk?.action === 'find' && isDevToolsFrontendUrl(contents.getURL())) return
```

然后在现有 `if (releasesToTerminal(hk) && isTerminalTab(srcTab)) { ... return }` 之前(或紧随其后)
加第二种:

```ts
if (hk.action === 'find' && srcTab?.info.inspector) {
  log('快捷键放行给 DevTools 前端', 'find')
  return
}
```

`switch` 里加:

```ts
case 'find': {
  // 全窗浮层开着时不抢焦点(与 Ctrl+T / Ctrl+L 同策略)
  if (!overlay.isFullOpen) findBar.openFind(ctx, srcTabId)
  break
}
```

终端页由 `releasesToTerminal`(§3.5)放行,走不到这里。

### 3.5 `src/shared/shortcuts.ts`

- `TabHotkey` 加 `| { action: 'find' }`(注释:页内查找;**终端页让给 shell 的 forward-char**)。
- `matchTabHotkey` 非 shift 分支加:`if (key === 'f' || input.code === 'KeyF') return { action: 'find' }`。
  `Ctrl+Shift+F` 走 `shift` 分支,那里只认 t/l/e,已经 `return null` —— 所以**元素全屏插件的
  `Ctrl+Shift+F` 不受影响**(它在 `matchTabHotkey` 未命中后才交给 `kernel.handleHotkey`)。
- `releasesToTerminal` 加 `hotkey.action === 'find'`,注释里写「`Ctrl+F` = readline 的 forward-char」。

### 3.6 `src/main/findBar.ts`

状态与 API:

```ts
interface FindState {
  tabId: number
  wc: WebContents
  query: string
  matchCase: boolean
  requestId: number
  onFound: (e: Event, r: FoundInPageResult) => void
}
const states = new WeakMap<WindowContext, FindState>()

export function openFind(ctx: WindowContext, tabIdHint: number | null): void
export function handleFindEvent(ctx: WindowContext, ev: OverlayEvent): void
export function closeFind(ctx: WindowContext): void
export function onTabNavigated(ctx: WindowContext, tabId: number): void
export function onTabClosed(ctx: WindowContext, tabId: number): void
export function onTabActivated(ctx: WindowContext, tabId: number): void
```

- `openFind(ctx, hint)`:
  1. `if (ctx.overlay.isFullOpen) return`;目标 = `hint ?? ctx.tabs.getActiveTabInfo()?.id`,取不到就返回。
  2. 已有 `state` 且 `state.tabId === 目标`:保留 query/matchCase,`ctx.overlay.show(...)` 重开小条
     (这会替换掉当前任何浮层)+ `ctx.overlay.send('find:state', { refocus: true })`,直接返回
     —— 这样「已在查找时再按 Ctrl+F」是**重新聚焦 + 全选**,不是清空重来。
  3. 已有 state 但目标不同:先 `closeFind(ctx)`(清旧标签高亮)。
  4. 建 state(`query:''`、`matchCase:false`),`wc.on('found-in-page', onFound)`,
     `ctx.overlay.show({ id: 'find', placement: 'page-top-right', payload: { query: '', matchCase: false } })`。
- `handleFindEvent(ctx, ev)`:
  - `'query'` `{text, matchCase}`:`state.query = text`、`state.matchCase = !!matchCase`;
    空词 → `wc.stopFindInPage('clearSelection')` 并推 `{matches:0, activeMatchOrdinal:0}`;
    否则 `run(ctx, state, { findNext: false, forward: true })`。
  - `'next'` `{forward}`:空词忽略;`run(ctx, state, { findNext: true, forward: !!forward })`。
  - `'close'`:`closeFind(ctx)`。
- `run()`:`state.requestId = wc.findInPage(state.query, { forward, findNext, matchCase: state.matchCase })`。
- `onFound`:`if (r.requestId !== state.requestId) return`(迟到的旧请求丢弃);
  `pushState(ctx, r)`。
- `pushState`:**只有 `ctx.overlay.currentId === 'find'` 才 `ctx.overlay.send('find:state', …)`**
  —— 否则查找条已被别的浮层替换,不能再把它顶出来(这正是「复用 overlay」这条路的边界)。
- `closeFind(ctx)`:`wc.stopFindInPage('clearSelection')`、`wc.removeListener('found-in-page', onFound)`、
  `states.delete(ctx)`、`ctx.overlay.show(null)`(由 §3.3 把焦点还给活动页面)。
- 生命周期收尾:三个 `onTab*` 都只在 `state && state.tabId === tabId`(activated 则是 `!== tabId`)时
  `closeFind(ctx)`。即 **v1 的语义:导航 / 切到别的标签 / 关标签都收起查找条**(Chrome 是每标签记忆查询并保留高亮;
  这里刻意简化,写进 §5 的偏差表)。
- 防御:`wc.isDestroyed()` 一律先判;`findInPage` 调用包一层 try/catch
  (页面崩溃/正在销毁时抛错不能让 `before-input-event` 冒泡)。

### 3.7 `src/main/ipc.ts`

```ts
if (ev.id === 'find') {                        // 必须在这条之前
  findBar.handleFindEvent(ctx, ev)
  return true
}
if (ev.event === 'close-request') { ctx.overlay.show(null); return true }
```

### 3.8 `src/main/index.ts`

在 `wireWindowContext` 既有标签事件处补三行:

```ts
tabs.on('tab-navigated', (p) => { kernel.emitEvent('tab:navigated', p); findBar.onTabNavigated(ctx, p.tabId) })
tabs.on('tab-activated', (t) => { kernel.emitEvent('tab:activated', t); findBar.onTabActivated(ctx, t.id) })
tabs.on('tab-closed', (t) => { kernel.emitEvent('tab:closed', t); agentNotify.tabClosed(t.id); findBar.onTabClosed(ctx, t.id) })
```

(实现时按现有代码就地追加,不要重排既有调用顺序。)

### 3.9 `src/preload/index.ts`

```ts
// BrowserAPI
/** 仅 overlay 的查找条使用:主进程下行查找结果 / 重新聚焦信号 */
onFindState: (cb: (msg: FindStateMessage) => void) => () => void
// 实现
onFindState: (cb) => subscribe('find:state', cb)
```

### 3.10 `src/renderer/src/components/FindBar.vue`

- props `{ payload: FindPayload; bandTop: number }`;emits `'overlay-event': [event, args?]`。
- 本地 `text = ref(props.payload.query)`、`matchCase = ref(props.payload.matchCase)`、
  `matches`、`active`。
- `onMounted`:`input.focus(); input.select()`;订阅 `api.onFindState(msg)`,卸载时取消:
  - 有 `refocus` → `input.focus(); input.select()`;
  - 有 `matches` → 更新计数(仅 `text` 非空时显示 `n/m`;`matches === 0` 显示「无结果」)。
- 输入 `@input` 80ms 防抖 → `emit('overlay-event','query',{ text, matchCase })`;
  `matchCase` 切换后立即 emit(不走防抖)。
- `@keydown`:Enter → `emit('overlay-event','next',{ forward: !e.shiftKey })`;Esc → `emit('overlay-event','close')`。
- 按钮(上一个 / 下一个 / `Aa` / 关闭)一律 `@mousedown.prevent` **并且**操作后 `input.focus()`,
  否则点一下按钮输入框就失焦、`Esc` / Enter 会失效(沉淀自 `SplitMenu.vue` 的 `@mousedown.prevent` 经验,
  差别是这里要保持**本** webContents 的输入焦点)。
- 视觉沿用 overlay 既有语言:透明背景 + `var(--bg3)` 条身 + `var(--border)` + 圆角 + 投影,
  内联 scoped style(与 `SplitMenu.vue` 一致);图标用 `lucide-vue-next` 的 `Search / ChevronUp / ChevronDown / X`。
- 计数区固定宽度,避免数字变化时按钮抖动。

### 3.11 `src/shared/shortcutCatalog.ts`

`view` 组、`Ctrl+Shift+F` 之前插一条:

```ts
{
  keys: ['Ctrl', 'F'],
  label: '页内查找',
  note: '高亮并计数,Enter 下一个 / Shift+Enter 上一个 / Esc 关闭 / Aa 区分大小写;终端页除外 —— 那里 Ctrl+F 是 shell 的按词前进;DevTools 前端有自己的查找。地址栏建议 / 分屏面板 / 下载面板打开时查找条会被替换(高亮仍在)'
}
```

`tests/shortcutCatalog.test.ts` 的「关键键位都在册」加 `expect(has(['Ctrl','F'])).toBe(true)`。

---

## 4. 测试计划

**纯逻辑(现有 vitest 即可,不需要真的 Electron):**

| 文件 | 用例 |
| --- | --- |
| `tests/shortcuts.test.ts` | `matchTabHotkey(ctrl+f)` → `{action:'find'}`;`Ctrl+Shift+F` → `null`(留给元素全屏);`Ctrl+Alt+F` → `null`;`keyUp`/`isAutoRepeat`/`isComposing` → `null`;`releasesToTerminal({action:'find'})` → `true` |
| `tests/find.test.ts` | `findBarRect`:正常窗口;窄窗口(宽度被夹到 `MIN`、x 仍 `>= margin`);`chromeHeight` 很靠底(y 被夹住);返回值恒为正尺寸 |
| `tests/findBar.test.ts`(可并入 `find.test.ts`) | 用 `FakeWc`(需给它加 `findInPage` / `stopFindInPage`,并 `emit('found-in-page', …)`)与一个最小 fake ctx:① 打开 → `overlay.show` 收到 `{id:'find',placement:'page-top-right'}` 且 `findInPage` 被调;② 改词 → `findNext:false`;下一次 → `findNext:true`;③ 旧 `requestId` 的结果被丢弃;④ `currentId !== 'find'` 时不 `send('find:state')`;⑤ 关闭 → `stopFindInPage('clearSelection')` + `overlay.show(null)`;⑥ 切标签 / 导航 / 关标签 → 关闭 |
| `tests/shortcutCatalog.test.ts` | 关键键位加 `Ctrl+F` |

**手动 / 真机(门禁外用,和既有 E2E 一样需要先解决 `libasound.so.2`,见 MEMORY 环境节):**

1. `npm run dev`,在网页里按 `Ctrl+F` → 右上角出现小条且**不遮住页面点击**(点查找条之外的页面能正常交互);
   输入词 → 高亮 + `n/m`;Enter / Shift+Enter 走动;点 `Aa` 变区分大小写;Esc 关掉且高亮消失。
2. `bow://settings` 与 `bow://logseq` 里同样验一遍。
3. 终端页按 `Ctrl+F` → 必须进 shell(readline 前进一格),不弹小条。
4. 分屏:在右窗格点一下再 `Ctrl+F`,高亮只出现在右窗格(查找目标是聚焦窗格)。
5. 打开地址栏建议(`Ctrl+L` 后打字)→ 查找条被替换、高亮仍在;再按 `Ctrl+F` 查找条回来且输入框全选。
6. 手机调试的 DevTools 前端标签里按 `Ctrl+F` → 走 DevTools 自己的查找(不弹 bow 的小条)。
7. 拖窗口缩放 / 切深浅色,小条始终贴页面区右上角。

---

## 5. 风险、已知偏差与不确定项

| 项 | 说明 / 处置 |
| --- | --- |
| **浮层单实例冲突** | 查找条与地址栏建议 / 分屏面板 / 下载面板不能共存(用户已接受)。`pushState` 用 `currentId === 'find'` 兜底,保证异步结果**不会**把别的浮层顶掉。 |
| **导航 / 切标签就收起** | Chrome 是每标签记忆查询与高亮,本版刻意简化成收起。若之后要贴 Chrome,需要把 `FindState` 从「每窗口一份」扩成「每标签一份」并做恢复。 |
| **DevTools 抢键** | Electron 自带 DevTools 的 detach 窗口不在 `WindowManager` 里,`byWebContents` 会回退聚焦窗口 → 必须用 `isDevToolsFrontendUrl(contents.getURL())` 挡(§3.4 判据①);只看 `srcTab.inspector` 会漏掉它。 |
| **首开焦点竞态** | overlay 视图第一次创建时 `show()` 的 `webContents.focus()` 可能早于 `did-finish-load`;靠 `did-finish-load` 补一次 + FindBar `onMounted` 的 DOM focus 双保险(§3.3、§3.10)。 |
| **iframe 内匹配** | `findInPage` 会搜入同源/跨源 iframe(Chromium 行为),但 `found-in-page` 的 `selectionArea` 与计数以主框架为准 —— 与 Chrome 表现基本一致,不做额外处理。 |
| **`matchCase` 中文/IME** | `findInPage` 对 IME 组合中的输入按 `input` 事件值搜索,组合未上屏时搜不到属正常;不做特殊处理。 |
| **`found-in-page` 事件归属** | 监听器挂在目标标签的 webContents 上;标签销毁时 Electron 自动清理,但代码里仍显式 `removeListener` 并先判 `isDestroyed()`。 |
| **未验** | 真机上的 `Esc` 是否会被 Overlay 视图的 `before-input-event` 之外的路径吞掉;真机 iframe 高亮;macOS 上 `⌘F` 与 editMenu 的加速键先后(既有 `Ctrl+Shift+I` 已验证同一条通路,风险低)。 |

---

## 6. 实施步骤(每步可独立验证)

1. `src/shared/find.ts` + `src/shared/types.ts` 类型/常量 → `npm run typecheck`(此时无人引用,零行为变化)。
2. `src/shared/shortcuts.ts`(action + match + releasesToTerminal)+ `tests/shortcuts.test.ts` → `npm test`(find 相关用例,暂时**先不加** tabShortcuts 的 case,避免半成品)。
3. `src/main/findBar.ts` + `tests/findBar.test.ts`(含给 `tests/fakeWc.ts` 加 `findInPage`/`stopFindInPage`)→ `npm test`。
4. `src/main/overlay.ts` 的 placement / 焦点 / 收尾 + `tests/find.test.ts` 几何用例 → `npm test`。
5. `src/main/tabShortcuts.ts` + `src/main/ipc.ts` + `src/main/index.ts` 接线 → `npm run typecheck`。
6. `src/preload/index.ts` + `OverlayApp.vue` + `FindBar.vue` → `npm run dev` 走 §4 的手动 1-4 条。
7. `src/shared/shortcutCatalog.ts` + `tests/shortcutCatalog.test.ts` → `npm test`。
8. 文档:`README.md`、`docs/ARCHITECTURE.md`、`.pi/plans/settings-shortcuts-help.md`。
9. 总门禁:`npm run typecheck` + `npm test` + `npm run build`;再跑一遍 §4 手动 5-7 条 + 真机 E2E 两条(用 `~/.cache/bow-alsa/usr/lib` 的 `LD_LIBRARY_PATH`)。

---

## 7. 实施结果与验证(2026-09-30 已完成)

与 §2 清单的偏差:测试合并进 `tests/find.test.ts`(几何 + 状态机,15 用例),未单独建 `tests/findBar.test.ts`;
`tests/fakeWc.ts` 加了 `findInPage` / `stopFindInPage` / `emitFoundInPage`,`tests/fakeTabs.ts` 加了 `getActiveTabInfo`。

**门禁**:`npm run typecheck` ✓;`npm test` **1250 passed**(唯一失败是既有的 Node 26 `mcpHttp` DNS-rebinding,
与本次无关);`npm run build` ✓。

**真 Electron E2E**(headless,`LD_LIBRARY_PATH=~/.cache/bow-alsa/usr/lib`,`--ozone-platform=headless`,CDP 驱动):

- ✓ 网页里 CDP 发 `Ctrl+F` → overlay 的 `.fb-root` 出现;
- ✓ **overlay 视图 bounds 实测 = 420×44**(`window.innerWidth/innerHeight`),证明 placement 是「恰好包住查找条」
  而不是铺满窗口(不然会把页面点击吃掉);
- ✓ `Esc` → 查找条关闭(主进程 `stopFindInPage('clearSelection')` + `overlay.show(null)`);
- ✓ 终端页 `Ctrl+F` **不弹**查找条(`releasesToTerminal` 放行给 shell);
- ✓ 输入词后主进程确实走到 `findInPage`(日志 `findBar run needle 1`)。

**未能在本容器验证**:原生 `found-in-page` 的计数 / 高亮。原因查清了,是**环境限制,不是代码问题**:

- `--ozone-platform=headless`(现有 E2E 用的旗标)下,`findInPage` 对 **`WebContentsView` 返回 `matches: 0`**;
  对 `BrowserWindow` 自己的 webContents 却正常返回 3。用一个 30 行独立 probe 复现:
  - `--ozone-platform=headless`:window webContents → 3;`WebContentsView` → 0;
  - `--headless=new`:同一个 `WebContentsView` → **3**。
- 用 `--headless=new` 跑 bow 时 overlay 视图在 CDP 下不稳定(查找条组件会在打字前后被重建),
  没有可用的稳定断言,所以没有把它固化成常驻 E2E。
- ⇒ 计数 / 高亮需要在**真显示器**(或 `--headless=new` + 更稳的窗口生命周期)上再肉眼确认一次;
  查找到的「输入 → findInPage」链路已在真 Electron 里验过,缺的只是最后一步原生回包。

**回归**:既有 `npm run test:e2e:agent`(真 Electron + 真终端 + 真 OSC)再次全绿 ——
overlay / 标签生命周期 / 快捷键三处改动没有影响代理状态链路。
(第一次跑超时是环境里积压了 190 个上一次 E2E 没回收的 electron 进程;清掉后一次通过。)
