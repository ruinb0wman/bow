# 地址栏建议面板「失焦后不消失、Esc 无效」

## 0. 目标

现象(用户原话):地址栏**先聚焦** → 建议下拉正常出现;然后**用快捷键切标签** → 下拉**仍在**,
而且**按 Esc 没反应**;输入框看起来并没有聚焦。

一句话结论:**chrome 侧没有任何可靠信号能知道「键盘焦点被页面视图抢走了」**。
面板可见性现在挂在 `onAddressBlur` 的 DOM `blur` + 120ms 计时器里的 `document.activeElement` 判据上,
而跨 `WebContentsView` 的焦点切换恰恰是这条链路会静默失效的场景;
切标签就是 `TabManager.activate()` 里的 `v.view.webContents.focus()`。
第二处独立缺陷:`refreshSuggestions()` 对**在途**的建议结果没有作废机制
(分屏面板有 `splitMenuSeq`,建议面板没有,见 `docs/ARCHITECTURE.md` §13 第 8 条)。

**假设(如果理解错了请指出)**:
1. 「输入提示」= 地址栏的**建议下拉面板**(`SuggestPanel`),不是 input 里的灰色 placeholder。
   判断依据是「按 Esc 无效」——placeholder 与焦点无关、也本来就不吃 Esc,而下拉面板吃。
2. 「快捷键切换 tab」= `Ctrl/Cmd+数字`(仓库里唯一的切标签快捷键,`@shared/shortcuts.matchTabHotkey`);
   `Ctrl+W` 关掉当前标签、`Ctrl+Shift+T` 恢复标签走的是同一条路(`activate()` → `view.webContents.focus()`)。

---

## 1. 诊断(从代码直接推出,不依赖 Chromium 的模糊细节)

两条观察放在一起就能定性:

- **「Esc 无效」⇒ 那次 keydown 根本没进 chrome 渲染层**。chrome 渲染层里 Esc 只有两处处理点:
  地址输入上的 `onAddressKeydown`(收建议面板)与 `window` 上的 `onKeydown`(收分屏面板),
  两处都在同一个 webContents 里。`hideSuggest()` 是前者第一分支:

  ```ts
  function onAddressKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (showSuggest.value) hideSuggest()      // ← 面板开着就一定会收
      else syncAddress()
      return
    }
  ```

  既然 Esc 什么也没发生 ⇒ 这个函数没跑 ⇒ **chrome webContents 已经不是键盘焦点所有者**
  (焦点在新切过去的页面视图上,Esc 进了那个 webContents)。

- **「面板还在」⇒ `hideSuggest()` 没跑过** ⇒ `showSuggest` 还是 true、overlay 视图还在显示。

- chrome 侧能发现「焦点走了」的链路只有两条:`onWindowBlur`(整窗失焦,主进程 `mainWindow.on('blur')`)
  与 `onAddressBlur`(元素失焦)。后者是**唯一**可能覆盖「窗口内换视图」的那条:

  ```ts
  function onAddressBlur(): void {
    addressEditing.value = false
    explicitFocus = false
    selectOnFocus = false
    setTimeout(() => {
      // 焦点落在面板上时不要收(用户可能正要点某一行)
      if (document.activeElement !== addressInput.value) hideSuggest()
    }, 120)
  }
  ```

  它有两个死角:① `blur` 是**渲染层 DOM 事件**,而「焦点在同一个窗口内从 chrome 的 webContents
  换到某个页面 WebContentsView」不保证给元素派发 `blur`;② 就算 `blur` 派发了,判据用的是
  `document.activeElement` —— 这个值在 widget 级失焦时可以原地不动(元素仍在 DOM 上「持有焦点」)。
  两个死角里任意一个成立,`hideSuggest()` 就永远不会被调用,而后面的按键全部进页面视图 ⇒
  用户看到的就是**「面板留着 + Esc 无效」**。

- 同一个死角还有第三个可观察后果:`addressEditing` 卡在 `true` ⇒ `syncAddress()` 的守卫
  (`if (!addressEditing.value && activeTab.value)`)一直不成立 ⇒ **切标签后地址栏不同步新 URL**。

- 同样一根因:**`focusAddress()` 只改 DOM 焦点**(不把键盘焦点交给 chrome webContents)。
  `tabShortcuts.ts` 里那行注释其实已经点明了这个规矩 —— 只是渲染层有两条路没走它:

  ```ts
  /**
   * 聚焦地址栏:先把键盘焦点交给 chrome WebContents(否则渲染层的 el.focus() 只是改 DOM 状态、
   * 键盘事件仍进页面),再请求渲染层聚焦并全选地址栏。Ctrl+L 与 Ctrl+T 新建标签共用。
   */
  ```

  没走的两条路:`newTab()`(工具栏 `+` / 双击标签栏 —— `await api.createTab()` 已经把键盘焦点
  交给新页面视图了,紧接着的 `focusAddress()` 只动了 DOM)与 overlay 的 `cancel` 分支
  (`hideSuggest(); focusAddress()`)。所以「点 + 新建标签」也能复现同一现象。

- 与之并列的第二处缺陷(独立的竞态,与焦点无关):`refreshSuggestions()` 无条件落地结果。

  ```ts
  async function refreshSuggestions(input: string): Promise<void> {
    const res = await api.plugins.suggest(input)
    suggestions.value = res.suggestions
    ...
    showSuggest.value = suggestions.value.length > 0     // ← 期间失焦/被关掉也照样把面板弹回来
    pushSuggest()
  }
  ```

  打字触发 100ms 防抖(`onAddressInput`)后立刻切走标签:防抖仍会发出请求,响应回来时
  面板已经被「120ms 兜底」收掉,这个 `showSuggest.value = true` 又把它弹回来 —— 而且此刻
  键盘焦点已在页面视图,于是又是「面板留着 + Esc 无效」。分屏面板早就为同一类问题加了「代」计数
  (`splitMenuSeq`,ARCHITECTURE §13 第 8 条),建议面板没有。

**设计原则(本次要落的那条规矩)**:

> 「键盘焦点在谁手里」只有主进程知道 —— 因为 `webContents.focus()` 就是它调的。
> 渲染层不许猜(不拿 DOM blur / `activeElement` 当焦点事实),只准把面板生命周期挂到主进程的
> 权威信号上;任何焦点离开或显式关闭都必须**作废在途请求**。

---

## 2. 要改的文件

| 文件 | 改什么 |
| --- | --- |
| `src/main/tabManager.ts` | `TabEvents` 加 `view-focused`;`spawn()` 里 `wc.on('focus')` 旁边 emit(带一条 log) |
| `src/main/ipc.ts` | 转发 `view-focused` → chrome(`chrome:page-focus`),带「迟到即丢」判据;新增 `chrome:request-focus-address` handler |
| `src/main/tabShortcuts.ts` | 导出既有的 `focusAddressBar()`(内部函数,不改行为) |
| `src/preload/index.ts` | `BrowserAPI` 加 `onPageFocus` / `requestAddressFocus` + 实现 |
| `src/renderer/src/lib/suggestSession.ts` | **新增**:建议会话纯逻辑(焦点 + 请求代 → 可见性),无 Vue/DOM |
| `src/renderer/src/App.vue` | 会话接线、`page-focus` 处理、`newTab()` 走主进程聚焦、blur 时取消防抖 |
| `tests/suggestSession.test.ts` | **新增**:会话状态机单测 |
| `docs/ARCHITECTURE.md` | §7.2 焦点策略、§9 `send` 表、§13 已知坑加一条 |
| `D:\tmp\suggest-focus-e2e.mjs` | **新增**:真机 E2E(照 `/mnt/d/tmp/nested-split-panel-e2e.mjs` 的 CDP 骨架) |

---

## 3. 改动清单

### 3.1 主进程:`页面视图拿到键盘焦点` → 通知 chrome

`src/main/tabManager.ts` —— `TabEvents` 加一条,并在 `spawn()` 里那两行**已经存在**的
`wc.on('focus')` 接线旁加一个 emit(该事件是可信的:分屏「聚焦窗格同步」就靠它):

```ts
export interface TabEvents {
  ...
  /** 某个页面视图拿到了键盘焦点(chrome 的地址栏/面板在这一刻起已不是键盘焦点所有者) */
  'view-focused': (tabId: number) => void
}

// spawn() 内,与 activatePaneIfGroupMember 同一个事件源:
wc.on('focus', activatePaneIfGroupMember)
wc.on('focus', () => {
  log('键盘焦点交给页面视图', id)
  this.emit('view-focused', id)
})
```

> log 是给 E2E 断言用的第一现场(与终端 E2E 断言「快捷键:关标签」同一套路)。

`src/main/ipc.ts` —— 紧挨现有的 `tabs.on('tab-updated', ...)` 那组:

```ts
// 页面视图抢走键盘焦点 = chrome 的瞬态面板(suggest / split-menu)必须收起。
// 判据用 webContents.isFocused():Electron 的 'focus' 事件可能迟到(此刻 chrome 已经又拿回焦点,
// 典型是 Ctrl+T:create() 先 focus 新页面视图,紧接着 focusAddressBar() 把焦点还给 chrome),
// 不校验就会把刚打开的地址栏面板立刻收回去。
tabs.on('view-focused', () => {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isFocused()) return
  sendToChrome('chrome:page-focus')
})
```

`src/preload/index.ts` —— 接口 + 实现(挨着 `onWindowBlur`):

```ts
/** 主进程:键盘焦点已交给某个页面视图 → chrome 收起自己的瞬态面板 */
onPageFocus: (cb: () => void) => () => void
// 实现
onPageFocus: (cb) => subscribe('chrome:page-focus', cb),
```

### 3.2 渲染层:建议会话状态机(纯逻辑,可单测)

新增 `src/renderer/src/lib/suggestSession.ts`(与 `lib/modalStack.ts` 同风格:纯函数、被 `tests/` 直接 import):

```ts
/**
 * 地址栏建议面板的会话状态(纯逻辑:不 import Vue / 不碰 DOM)。
 * 可见性只有两个输入:①地址栏是否握着键盘焦点 ②最近一次请求的代。
 * **任何**让焦点离开、或显式关闭的路径都必须走这里的转移(它负责 +1 代),
 * 否则在途的 `plugins:suggest` 响应回来会把面板重新弹出来(分屏面板的 splitMenuSeq 同款教训)。
 */
export interface SuggestSession {
  /** 地址栏输入框当前是否持有焦点(focus/blur 事件 + 主进程 page-focus 信号共同维护) */
  focused: boolean
  /** 请求代:focus / blur / 关闭 都 +1 */
  seq: number
  /** 面板是否该可见 */
  visible: boolean
}

export const newSession = (): SuggestSession => ({ focused: false, seq: 0, visible: false })

/** 聚焦地址栏:开一代新会话,等结果(此刻面板先不显示) */
export const focusedSession = (s: SuggestSession): SuggestSession => ({ focused: true, seq: s.seq + 1, visible: false })

/** DOM blur:作废在途请求,但**不动可见性** —— 焦点可能只是落在面板上(120ms 兜底负责收) */
export const blurredSession = (s: SuggestSession): SuggestSession => ({ focused: false, seq: s.seq + 1, visible: s.visible })

/** 键盘焦点确实交给页面视图了(page-focus):收面板 + 作废在途请求 */
export const lostFocusSession = (s: SuggestSession): SuggestSession => ({ focused: false, seq: s.seq + 1, visible: false })

/** 显式关闭(Esc / 选中 / 窗口失焦 / 关面板):可见性置假,在途请求一律作废 */
export const dismissedSession = (s: SuggestSession): SuggestSession => ({ ...s, seq: s.seq + 1, visible: false })

/** 结果落地:代不一致 或 已失焦 → 原样返回(同一个对象,调用方用 `next === s` 判过期);否则 可见 = 有行 */
export const withResults = (s: SuggestSession, snapshot: number, rowCount: number): SuggestSession =>
  snapshot === s.seq && s.focused ? { seq: s.seq, focused: true, visible: rowCount > 0 } : s
```

`App.vue` 接线要点(所有既有 `showSuggest.value` 读取点**不用动**,改成 computed):

- `const session = ref(newSession())`;`const showSuggest = computed(() => session.value.visible)`
- `onAddressFocus` → `session.value = focusedSession(session.value)`(其余 select / explicitFocus 逻辑不变)
- `onAddressBlur` → `session.value = blurredSession(session.value)` + **`suggestTimer` 一并取消** + 保留 120ms 兜底
  (兜底里调 `hideSuggest()`;取消防抖是必需的:否则「打字后 100ms 内失焦」会让防抖照发一个**新一代**的请求,
  结果落地时代是新的 → 面板照样弹出来)
- `refreshSuggestions` →
  ```ts
  const snap = session.value.seq
  const res = await api.plugins.suggest(input)
  const next = withResults(session.value, snap, res.suggestions.length)
  if (next === session.value) return   // 代过期:期间失焦/被关掉 → 结果整条丢弃(绝不重开面板)
  suggestions.value = res.suggestions
  suggestRows.value = res.rows
  activeIdx.value = 0
  session.value = next
  pushSuggest()
  ```
- `hideSuggest()` → `session.value = dismissedSession(session.value)` + 清 data + `api.showOverlay(null)`(在途请求随之作废)
- 新增订阅:
  ```ts
  /** 主进程:键盘焦点已交给页面视图。渲染层不再猜(不看 DOM blur / activeElement) */
  api.onPageFocus(() => {
    addressInput.value?.blur()          // 让 DOM 状态与事实对齐(本来就失焦则是空操作)
    if (suggestTimer) clearTimeout(suggestTimer)
    hideSuggest()
    addressEditing.value = false
    syncAddress()                       // 卡住的 addressEditing 会让切标签后地址栏不同步新 URL
    if (splitMenuOpen.value) closeSplitMenu()
  })
  ```

### 3.3 地址栏的**键盘**焦点请求必须过主进程

`src/main/tabShortcuts.ts`:`export function focusAddressBar(tabs: TabManager)`(只加导出,不改实现)。

`src/main/ipc.ts`:

```ts
// 渲染层请求「真正的」地址栏聚焦:先把键盘焦点交给 chrome webContents,再由它回消息让渲染层聚焦+全选。
// (渲染层自己 el.focus() 只改 DOM 状态,键盘事件仍进页面 —— 见 tabShortcuts.focusAddressBar 的注释)
ipcMain.handle('chrome:request-focus-address', () => {
  focusAddressBar(tabs)
  return true
})
```

`src/preload/index.ts`:`requestAddressFocus: () => Promise<boolean>` → `ipcRenderer.invoke('chrome:request-focus-address')`。

`src/renderer/src/App.vue`:`newTab()` 的 `focusAddress()` 换成 `void api.requestAddressFocus()`
(这样「点 + / 双击标签栏」后地址栏真的能打字;主进程那边收到请求后发 `chrome:focus-address` →
渲染层走原来的 `focusAddress()`,DOM 聚焦 + 全选的既有行为不变)。

### 3.4 文档

- §7.2 `App.vue` 关键机制里的「焦点策略」那条:补一句「面板可见性不看 DOM blur,只认主进程的
  `chrome:page-focus` + 请求代(`lib/suggestSession.ts`)」。
- §9 `send` 表加一行:`chrome:page-focus` ← `ipc.ts`(订阅 `view-focused`,`isFocused()` 校验后转发)。
- §13 已知坑加一条(编号顺延,与第 8 条「代」并列):跨 `WebContentsView` 的焦点切换不能靠 DOM blur 观测,
  owner 类面板必须在主进程发信号 + 在渲染层作废在途请求。

---

## 4. 步骤(每步独立可验证)

1. **纯逻辑先行**:新增 `src/renderer/src/lib/suggestSession.ts` + `tests/suggestSession.test.ts`
   → `npx vitest run tests/suggestSession.test.ts` 绿(不看界面就能验状态机)。
2. **主进程信号链路**:`tabManager.ts`(事件 + log)→ `ipc.ts`(转发 + `isFocused()` 判据)→ `preload`。
   → `npm run typecheck`;真机跑一下,确认切标签时日志出现「键盘焦点交给页面视图」。
3. **App.vue 接线**(3.2)→ `npm test`(基线 44 文件 / 862 例不动)+ Windows 侧 `npm run build`。
4. **真机 E2E** `D:\tmp\suggest-focus-e2e.mjs`(§5 的用例)。
5. **地址栏键盘焦点走主进程**(3.3)→ 手验「点 + 新建标签后直接打字」能进地址栏。
6. **文档**(3.4)。
7. (可选,低风险加固)§6「未决」三条:面板自己的 Esc / overlay 订阅时机 / 浮层归属校验。

---

## 5. 验证

### 5.1 单测(新增,~10 例)

`tests/suggestSession.test.ts`:聚焦后结果可用 / 失焦后结果丢弃 / 关闭后在途响应不复活 /
`page-focus` 后可见性为假 / 代不一致时返回**同一个对象**(调用方靠 `===` 判过期) / 空结果不显示面板。

### 5.2 真机 E2E(`D:\tmp\suggest-focus-e2e.mjs`,Windows 侧,CDP)

照 `nested-split-panel-e2e.mjs` 的骨架(自带 `--user-data-dir` 隔离 profile、`--remote-debugging-port`、
跑前 `npm run build` 之后起 `electron .`):

| # | 用例 | 期望 |
| --- | --- | --- |
| 1 | 控制组:`Ctrl+L`(发到任意 target,主进程接管)→ 等面板出现 | overlay target 里 `.suggest-panel` 存在 |
| 2 | **失焦即收**:`window.browserAPI.activateTab(另一标签)` → 等 300ms | `.suggest-panel` 不存在;日志有「键盘焦点交给页面视图」 |
| 3 | **在途响应不复活**:`el.value='x'` + `input` 事件(起 100ms 防抖)→ 立刻 `activateTab` → 等 500ms | 面板仍不存在(**修前必红**,不依赖环境的 DOM blur 语义) |
| 4 | 地址栏重同步:`activateTab` 后读 `.address-input` 的 value | 等于新标签 URL(修前可能卡在旧值) |
| 5 | 回归:鼠标真点第 1 行建议 | 页面导航/地址栏变成该行 URL(**验证「点面板」没被误判成失焦**) |
| 6 | 回归:`Ctrl+L` → `Esc` → 面板消失(控制组) | 面板不存在 |

方法论照旧:先在**未改**的 build 上跑一遍记录红测结果(第 3 条必须红),再在改后跑绿;
E2E 脚本从 WSL 侧读输出时用 Windows 侧重定向(`> D:\tmp\xxx-out.txt`)避免汇总行被 `process.exit()` 截掉。

### 5.3 回归

- `npm test`(全量)、`npm run typecheck`、Windows `npm run build`。
- 既有真机 E2E(它们大量断言地址栏焦点与 `Ctrl+L`):
  `terminal-entry-e2e.mjs`(21)、`terminal-pane-e2e.mjs`(43)、`terminal-clipboard-e2e.mjs`(21)、
  `nested-split-panel-e2e.mjs`、`nested-split-e2e.mjs`。
- 用户手验:①对地址栏按 `Ctrl+3`,面板立刻消失、Esc 之后不再是死键 ②面板开着点网页/切标签不残留
  ③点 `+` 新建标签后能直接打字 ④切标签后地址栏显示的是新标签的 URL。

---

## 6. 风险 / 未知 / 可选加固

**风险**

- `wc.on('focus')` 的时序:Electron 的 `focus` 事件是异步投递的。已有代码依赖它(分屏聚焦窗格同步),
  但本次新增了「迟到即丢」的 `isFocused()` 判据来兜住 `Ctrl+T` 那条竞态 —— 正好用 E2E 用例 1 覆盖。
- `mainWindow.webContents.isFocused()` 在 CDP 驱动下的语义可能与真机不同(窗口本身可能不是 OS 焦点)
  → E2E 只能验「消息送达 + 面板收起」,最终要用户真机确认。
- 收面板时连分屏面板一起收(`closeSplitMenu()`):如果用户开着分屏面板去点网页,面板会关。
  这是期望行为,但会写进文档。
- `hideSuggest()` / `closeSplitMenu()` 里的 `api.showOverlay(null)` 是**无条件**关当前浮层:
  若此刻 overlay 的 current 是插件浮层,会被一起关掉(既有缺口,不在本次范围)。
- overlay 的 `cancel` 分支(点建议面板空白处)仍用 DOM 级的 `focusAddress()`:改成主进程请求后,
  主进程回发的 `chrome:focus-address` 会让焦点事件再触发一次 `refreshSuggestions`,存在
  「刚关掉的面板又被弹回来」的次序问题(要另加「本次聚焦不要弹面板」的意图位才能干净解决)。
  **本次不动**,作为已知缺口记下来。
- macOS 未验(本机没有);本改动与平台无关,但不做承诺。

**未决(可选,建议一起做但可拆分)**

- `SuggestPanel.vue` 自己接 Esc(`onMounted` 挂 window keydown → `emit('overlay-event','cancel')`):
  鼠标点过面板后 overlay 视图握着键盘焦点,此时 Esc 进的是 overlay 页面 —— 属于同一类「Esc 无效」。
  改动很小(一个组件),但会与 chrome 侧的 Esc 路径并存(都走 `cancel` → `hideSuggest()`,幂等)。
- `OverlayApp.vue` 把 `api.onOverlayShow(...)` 订阅挪到 `await api.plugins.list()` **之前**:
  现在订阅在 await 之后,`did-finish-load` 的重放消息有丢失窗口(首次聚焦地址栏时面板可能不出现)。
- `OverlayManager.show(null)` 加 `expectId` 归属校验(只关「我自己的」浮层),消除上面那条既有缺口。

---

## 8. 实施记录(2026-09-21,已完成)

提交:`7c5b0a5` fix(chrome) / `6a07201` docs(ARCHITECTURE)。改动文件与 §2 一致,另加 `src/main/index.ts`(focusActivePage 加一条日志,给 E2E 分辨「窗口获焦导致的重聚焦」)。

### 8.1 真机 E2E 实测:诊断结论成立(而且是**两个死角同时存在**)

`D:\tmp\suggest-focus-e2e.mjs`(Windows 侧 CDP,与 `/mnt/d/tmp/nested-split-panel-e2e.mjs` 同骨架):

| 跑法 | 结果 |
| --- | --- |
| 修前 build(git stash 掉补丁后重建) | **5/8**:红的正是「切标签后面板消失」「主进程有 view-focused 信号」「Esc 收掉后迟到响应把面板弹回来」 |
| 修后 build | **8/8**(连跑两次都是 8/8) |

修前的探针(P 段,`blur`/`focus` 计数 + `document.activeElement`)跨两次运行分别抓到两种死角:

- 一次:`blur 1→1`(**根本没有 DOM blur**)→ `onAddressBlur` 与它的 120ms 兜底整条不跑;
- 一次:`blur 1→2`(blur 派发了)但 `document.activeElement` **仍是 address-input** → 兜底的 `if (document.activeElement !== addressInput.value)` 判据直接跳过。

两条都指向同一件事:**面板可见性不能挂在 DOM 上**。修后 `activeElement` 已被对齐成非地址栏(我们主动 `blur()`)。

### 8.2 与计划的偏差

- **不加可选的 §6「未决」三条**(面板自己的 Esc / overlay 订阅时机 / `showOverlay(null)` 归属校验):本次范围已收敛,留作已知缺口。
- **分屏面板刻意不跟 page-focus**(计划里原本写了「顺手把分屏面板也收了」):真机 E2E 立刻抓到回归 ——
  点分屏面板的窗格行本身就是「聚焦那个窗格」,会把面板关掉,`nested-split-panel-e2e` 的「连点两行切窗格」直接挂。
  已去掉 `loseSuggestFocus()` 里的 `closeSplitMenu()`,并在 ARCHITECTURE §7.2 写明这条差异。
- overlay `cancel` 分支仍用 DOM 级 `focusAddress()`(见 §6),本次不动。

### 8.3 回归

- `npm run typecheck` 过;`npm test` **45 文件 / 872 例**(基线 44/862,新增 `tests/suggestSession.test.ts` 10 例);Windows 侧 `npm run build` 过。
- 真机 E2E:`terminal-entry-e2e` 42/42、`terminal-pane-e2e` 43/43、`terminal-e2e` 21/21、`terminal-clipboard-e2e` 21/21、`nested-split-e2e` 60/60。
- ⚠️ `nested-split-panel-e2e` **在本机是既有 flaky**:修前 6 跑 4 挂、修后 10 跑 2 挂,失败形状完全相同
  (点第 2 个窗格行后,tab1 的视图送来一个**迟到 focus 事件** → `activatePaneIfGroupMember` 把 `activeId` 拉回去)。
  已用 `[DBG]` 版脚本(`nested-split-panel-dbg5.mjs`)在**两个 build 上**都复现 ⇒ 与本改动无关(与终端 E2E 里记的
  「CDP 驱动时窗口聚焦时机不同,旧窗格迟到的 focus 事件会把 activeId 拉回去」同一现象)。

### 8.4 待用户真机确认(本机自动化覆盖不到的部分)

1. 地址栏聚焦 → `Ctrl+3` 切标签:面板应立刻消失,之后 Esc 不再是死键;切标签后地址栏应显示新标签的 URL。
2. 工具栏 `+` / 双击标签栏新建标签后应能**直接打字**(主进程会真的把键盘焦点交给 chrome)。
3. 面板开着时点网页区域、或切到别的标签再回来:不应残留。
