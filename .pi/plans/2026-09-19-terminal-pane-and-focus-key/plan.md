# 地址栏 `bow://terminal` 就地打开(顶替聚焦窗格)+ 聚焦地址栏的新快捷键 `Ctrl/Cmd+Shift+L`

> 2026-09-19 · 目标文件 `src/shared/{shortcuts,split,groups,internalPages}.ts`、`src/main/{tabShortcuts,tabManager}.ts` · 前置:`2026-09-19-nested-split`(嵌套分屏)、`2026-09-19-terminal-plugin`(终端)

## 1. 目标(含用户拍板的语义)

1. **新增 `Ctrl/Cmd+Shift+L`:任何焦点下都聚焦地址栏,含终端页(`bow://terminal`)。**
   `Ctrl+L` 与现状完全不变(普通页聚焦地址栏;终端页让给 shell 当「清屏」)。
   约束:新组合**绝不能**落进 `releasesToTerminal()` 的放行名单,否则在终端里又失效。
2. **地址栏输入 / 建议下拉选中 `bow://terminal` 时,在当前**聚焦窗格**就地打开终端 —— 不新建标签、不自己造分屏。**
   用户的原话:「分屏后我输入 bow://terminal 进入 xterm,而不是输入后打开新的分屏」。
   即:`Ctrl+Shift+方向` 先分出一个空白窗格 → 地址栏输入 `bow://terminal` → 终端**顶替那个窗格**。
3. **工具栏「新终端」按钮不变**,仍在新的 tab 组里开一个新标签(用户明确要求)。
4. **聚焦窗格已经是终端时,`bow://terminal` 不生效**(不换标签、不新建;地址栏文字照旧)。

> ⚠️ 计划里我替用户补的两条假设(需求没覆盖,写在 §6 风险里,批准时可直接改):
> - 聚焦窗格是**别的内部页面**(如 `bow://settings`)时,同样被顶替(与「地址栏输入 = 导航当前标签」一致);
> - 顶替会**关掉**原标签,但走 `TabManager.close()` 所以进 `closedStack`,`Ctrl+Shift+T` 能找回(不静默丢页面)。

## 2. 现状(读过的代码)

### 2.1 快捷键

`src/shared/shortcuts.ts:52`(`matchTabHotkey`)——带 Shift 只认 `Ctrl+Shift+T`,其余一律 `null`:

```ts
  if (input.shift) {
    if (key === 't' || input.code === 'KeyT') return { action: 'restore' }
    return null // Ctrl+Shift+数字 等不作为标签切换
  }
```

`src/shared/shortcuts.ts:72`——放行规则按 **action** 判断,所以给 `focus-address` 再加一个组合会被一起放行:

```ts
export function releasesToTerminal(hotkey: TabHotkey): boolean {
  return hotkey.action === 'close' || hotkey.action === 'focus-address'
}
```

`src/main/tabShortcuts.ts:66`——`focus-address` 分支(与 `new` 一样,modal 打开时不抢焦点):

```ts
          case 'focus-address': {
            if (!getOverlay().isFullOpen) {
              focusAddressBar(tabs)
              log('快捷键:聚焦地址栏(Ctrl+L)')
            }
            break
          }
```

### 2.2 `bow://terminal` 的打开通路

地址栏 → `nav:go`(`src/main/ipc.ts:124`)→ `resolveNavigationWithFiles`(原样返回 `bow://terminal`,`SCHEME_RE` 命中)→ `tabs.openUrl(res.url)`;

`src/main/tabManager.ts:540`:

```ts
  openUrl(url: string, activate = true): TabInfo {
    const internal = parseInternalUrl(url)
    if (internal) return this.openInternal(internal)
    ...
```

`src/main/tabManager.ts:524`:

```ts
  openInternal(page: InternalPageId): TabInfo {
    if (INTERNAL_PAGES[page].singleton) { ...已有则只聚焦... }
    return this.create(internalPageUrl(page), true)   // ← 终端走这里:永远新标签
  }
```

`src/shared/internalPages.ts:27` 的登记注释就是这条行为的依据:

```ts
 * - false(终端页):每次打开都是新标签(每个终端标签一个独立 shell 会话)。
```

**为什么必须「换视图」而不是 `navigate()`**:内部页面(终端页)依赖应用 preload,而 preload 只能在 `WebContentsView` 创建时给(`spawn()` 里的 `...(internalId ? { preload } : {})`),普通标签的 webContents 永远变不成内部页面 —— `TabManager.navigate()` 的注释明确「跨内部 ↔ 普通边界一律拒绝」。所以「就地打开」= 新建一个内部页面视图,**在布局树里换掉那个叶子**,再把旧标签关掉。

工具栏按钮走的是另一条路:`TerminalButton.vue` → `api.createTab(TERMINAL_URL)` → `tab:create` → `tabs.create()`,**不经过 `openUrl`**,所以按用户要求天然保持「新标签」,本次不动它。

## 3. 设计

### 3.1 快捷键:新 action,而不是新组合挂到旧 action 上

`src/shared/shortcuts.ts`:

```ts
export type TabHotkey =
  | { action: 'new' }
  | { action: 'restore' }
  | { action: 'close' }
  | { action: 'switch'; digit: number }
  | { action: 'settings' }
  /** Ctrl/Cmd+L:普通页聚焦地址栏;终端页**让给 shell**(见 releasesToTerminal) */
  | { action: 'focus-address' }
  /** Ctrl/Cmd+Shift+L:任何焦点都聚焦地址栏(含终端)—— 刻意独立成一个 action,免得被放行规则连坐 */
  | { action: 'focus-address-anywhere' }
```

```ts
  if (input.shift) {
    if (key === 't' || input.code === 'KeyT') return { action: 'restore' }
    if (key === 'l' || input.code === 'KeyL') return { action: 'focus-address-anywhere' }
    return null
  }
```

`releasesToTerminal()` **一行不改**(只放 `close` + `focus-address`),新 action 天然不在名单里;注释补一句为什么新 action 不能并进 `focus-address`。

`src/main/tabShortcuts.ts` 两个 case 落到同一段(都遵守「modal 打开时不抢焦点」):

```ts
          case 'focus-address':
          case 'focus-address-anywhere': {
            if (!getOverlay().isFullOpen) {
              focusAddressBar(tabs)
              log('快捷键:聚焦地址栏', hk.action === 'focus-address' ? '(Ctrl+L)' : '(Ctrl+Shift+L)')
            }
            break
          }
```

### 3.2 键位选择的理由(给用户看的「建议」结论)

| 候选 | 结论 |
| --- | --- |
| **`Ctrl/Cmd+Shift+L`(采用)** | 与 `Ctrl+L` 同族好记;readline/shell **没有** `Ctrl+Shift+L` 绑定(xterm 的 `attachCustomKeyEventHandler` 也只认 `Ctrl/⌘+Shift+C/V`);且主进程 `preventDefault` 后按键根本进不到 xterm。空闲键位(现有:`Ctrl+Shift+T/F/I`、`Ctrl+Shift+方向`)。 |
| `F6` | Chrome/Edge 的「聚焦地址栏」惯例,但全局接管后终端 TUI 程序(vim/htop)再也收不到 F6。 |
| `Ctrl+Shift+K` | 一样空闲,助记性弱。 |
| `Alt+D` / `Ctrl+E` / `Ctrl+K` | **不可用**:readline 的 `kill-word` / `end-of-line` / `kill-to-end`,正是「被 xterm 占用」的典型。 |

### 3.3 树里换叶子(两个纯函数)

`src/shared/split.ts` 追加(与 `splitPane` / `removePane` 同风格,引用不变语义):

```ts
/**
 * 把一个叶子**原地换成另一个标签 id**(树结构与几何都不变):终端「顶替当前聚焦窗格」靠它,
 * 比 split+remove 的往返更直接(那条路会先嵌一层再塌缩)。
 * 树里没有 `tabId` 时原样返回(引用不变)。
 */
export function replacePane(root: LayoutNode, tabId: number, newTabId: number): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') return node.tabId === tabId ? leaf(newTabId) : node
    const a = walk(node.a)
    const b = walk(node.b)
    return a === node.a && b === node.b ? node : { ...node, a, b }
  }
  return walk(root)
}
```

`src/shared/groups.ts` 追加(焦点跟着换;标签不在任何组里时原样返回):

```ts
export function replaceTabInGroups(groups: readonly TabGroup[], oldTabId: number, newTabId: number): TabGroup[] {
  const group = findGroupOfTab(groups, oldTabId)
  if (!group) return [...groups]
  return groups.map((g) =>
    g.id === group.id
      ? { ...g, tree: replacePane(g.tree, oldTabId, newTabId), focus: g.focus === oldTabId ? newTabId : g.focus }
      : g
  )
}
```

### 3.4 登记表加一个「打开位置」轴

`src/shared/internalPages.ts`:

```ts
export interface InternalPageSpec {
  url: string
  title: string
  entry: string
  singleton: boolean
  /** 'tab' = 新标签;'pane' = **顶替当前聚焦窗格**(地址栏输入不新建标签,终端用) */
  openIn: 'tab' | 'pane'
}

export const INTERNAL_PAGES = {
  settings: { url: SETTINGS_URL, title: '设置', entry: 'settings', singleton: true, openIn: 'tab' },
  terminal: { url: TERMINAL_URL, title: '终端', entry: 'terminal', singleton: false, openIn: 'pane' }
} as const satisfies Record<InternalPageId, InternalPageSpec>

/** 内部页面是否「顶替当前聚焦窗格」打开(地址栏通路用;工具栏按钮的 `create()` 不受影响) */
export function opensInPane(id: InternalPageId): boolean {
  return INTERNAL_PAGES[id].openIn === 'pane'
}
```

`singleton` 仍是 `openInternal()`(设置页/回落新标签)的语义开关,`openIn` 是**正交**的第二根轴:终端的 `singleton:false` 现在只在「没有活动窗格 → 回落新标签」时起作用。

### 3.5 `TabManager`:顶替聚焦窗格

`src/main/tabManager.ts` 新增(与 `openInternal` / `splitFocused` 并列):

```ts
  /**
   * 在**当前聚焦窗格**就地打开内部页面(地址栏输入 `bow://terminal` 的通路):
   * 不新建标签、不自造分屏 —— 新建一个带应用 preload 的内部页面视图**顶替**原窗格的叶子
   * (树结构与几何不变),原标签走 `close()` 进关闭栈(`Ctrl+Shift+T` 可找回)。
   *
   * 为什么必须换视图:内部页面依赖应用 preload,而 preload 只在 `WebContentsView` 创建时给,
   * 普通标签的 webContents 永远变不成内部页面(`navigate()` 拒绝跨边界)。
   *
   * 聚焦窗格**已经是**该内部页面 → 什么都不做(返回 null,调用方保持现状)。
   */
  openInternalInPane(page: InternalPageId): TabInfo | null {
    const group = this.activeGroup()
    const oldId = group ? focusedTabId(group) : null
    if (group == null || oldId == null) return null
    const old = this.views.get(oldId)
    if (!old) return null              // 焦点 id 漂移(理论上不该发生):宁可不动,也不造一个不在任何组里的孤儿视图
    if (old.internalId === page) return null
    const { id, info } = this.spawn(internalPageUrl(page))
    this.groups = replaceTabInGroups(this.groups, oldId, id)
    this.activate(id)      // 先激活:id 进树后 layout() 立刻把新视图摆到原窗格的 rect 上
    this.close(oldId)      // 再关旧标签:此时 activeId 已是 id,不会把焦点清空(且进 closedStack)
    this.emit('tab-created', this.decorate({ ...info, active: true }))
    log('聚焦窗格内打开', page, oldId, '→', id)
    return this.getActiveTabInfo()
  }
```

`openUrl()` 只改内部页面那一行:

```ts
  openUrl(url: string, activate = true): TabInfo {
    const internal = parseInternalUrl(url)
    if (internal) {
      // 「顶替聚焦窗格」型内部页面(终端):不新建标签/分屏;已是它则原样返回(不生效)
      if (opensInPane(internal)) {
        return this.openInternalInPane(internal) ?? this.getActiveTabInfo() ?? this.openInternal(internal)
      }
      return this.openInternal(internal)
    }
    ...
```

三个分支的含义:顶替成功 → 新终端;已是终端 → 返回当前标签(不生效);**一个标签都没有** → `openInternal()` 回落新标签。注意 `spawn()` 里 `about:blank` 的普通页与内部页共用同一条路径,顶替后新视图自带 preload、且不进 `lastBrowsingId`(内部页)。

### 3.6 副作用自查(逐条对过代码)

- `nav:go`(`ipc.ts`)与 `nav:url`(建议下拉 / 书签)都走 `openUrl`,两条地址栏通路一起生效;书签只管 http(s),MCP `browser_navigate/search` 只接受 http(s)(`mcp.ts`),不受影响。
- `close(oldId)` → `unregisterTab(oldId)` 时树里已经换成 `id`,`findGroupOfTab` 返回 null → 组不会被二次改动;`lastBrowsingId` 若指向 oldId 会被 `close()` 清掉。
- `Ctrl+数字` 切组、标签栏窗格图标、`groups:changed` 广播都读 `listGroups()`,换叶子后自然一致。
- 终端页 `tab:self` 拿到的是**新** tabId(会话绑新 id),`__bowTerminal.tabId` 自洽。

## 4. 步骤

| 步 | 文件 | 内容 | 独立判据 |
| --- | --- | --- | --- |
| S1 | `src/shared/shortcuts.ts` | 新 action + `matchTabHotkey` 的 shift 分支 + 注释(§3.1) | `bun run typecheck` |
| S2 | `tests/shortcuts.test.ts` | 改「Ctrl+Shift+L 不命中」那条 + 新增用例(§5.1) | `bun run test tests/shortcuts.test.ts` |
| S3 | `src/main/tabShortcuts.ts` | 两个 case 合并(§3.1) | typecheck |
| S4 | `src/shared/split.ts` | `replacePane`(§3.3) | typecheck |
| S5 | `tests/split.test.ts` | `replacePane` 用例(§5.1) | `bun run test tests/split.test.ts` |
| S6 | `src/shared/groups.ts` | `replaceTabInGroups`(§3.3) | typecheck |
| S7 | `tests/groups.test.ts` | `replaceTabInGroups` 用例(§5.1) | `bun run test tests/groups.test.ts` |
| S8 | `src/shared/internalPages.ts` | `openIn` + `InternalPageSpec` + `opensInPane`(§3.4) | typecheck |
| S9 | `tests/internalPages.test.ts` | 登记表断言(**终端 pane / 设置 tab**)(§5.1) | `bun run test tests/internalPages.test.ts` |
| S10 | `src/main/tabManager.ts` | `openInternalInPane()` + `openUrl()` 路由(§3.5) | typecheck + 真机 E2E |
| S11 | `README.md` | 快捷键清单加 `Ctrl+Shift+L`;「终端」段的入口说明改成「按钮=新标签 / 地址栏=顶替当前窗格」;「标签组与分屏」补一句「先分屏,再输 `bow://terminal`」 | 通读自查 |
| S12 | `docs/ARCHITECTURE.md` | §4 的 `INTERNAL_PAGES` 片段与不变量表加 `openIn`;`TabManager` 方法表加 `openInternalInPane`;§11 测试基线与表(顺手把 §1 line 98 里早已漂移的 692 改成实测值) | 通读自查 |
| S13(可选) | `src/renderer/src/components/SplitMenu.vue` | 提示文案末尾加「分屏后在地址栏输入 `bow://terminal` 即在该窗格开终端」 | `bun run build` |
| S14 | Windows 真机 E2E(§5.2) | 新脚本 + 终端既有脚本回归 | 见 §5.2 |

S1–S9 是纯逻辑,先落地跑单测;S10 之后要 `wsync sync` → Windows 侧 `bun.exe run build` → 跑 E2E。

## 5. 验证

### 5.1 单测(约 12 例)

`tests/shortcuts.test.ts`:
- `Ctrl+Shift+L` / `Cmd+Shift+L` → `{ action: 'focus-address-anywhere' }`;
- 非 QWERTY:`key:''` / `key:'ł'` + `code:'KeyL'` 仍命中;
- 原断言「`Ctrl+Shift+L` → null」删掉,换成 `Ctrl+Shift+逗号` / `Ctrl+Shift+M` 之类仍 `null`;
- **`releasesToTerminal`(新 action) === false**;`close` / `focus-address` 仍 `true`;
- `Ctrl+L`(不带 Shift)行为零变化。

`tests/split.test.ts`(`replacePane`):换中间叶子(树结构与 `ratio` 不变、只有目标叶子变)、换根叶子、树里没有目标 id → **返回同一引用**、深层节点只重建路径上的祖先(兄弟子树引用不变)。

`tests/groups.test.ts`(`replaceTabInGroups`):分屏组里换聚焦叶子 → `focus` 跟着换、非聚焦叶子 → `focus` 不变、单窗格组、id 不在任何组 → 原样返回(新数组)。

`tests/internalPages.test.ts`:`INTERNAL_PAGES.terminal.openIn === 'pane'`、`settings.openIn === 'tab'`、`opensInPane('terminal') === true` / `opensInPane('settings') === false`。

### 5.2 真机 E2E(Windows 侧,`D:/tmp/terminal-pane-e2e.mjs`,沿用隔离 userData + CDP 骨架)

1. **两个标签的数据页做成左右分屏** → 聚焦右窗格;记录它的 `tabId` 与 rect。
2. **地址栏真输入**:在 chrome 目标里给 `.address-input`(`App.vue:565`)填 `bow://terminal` 并派发 `Enter`(或直接调 `window.browserAPI.go('bow://terminal')`,与输入回车是同一条 `nav:go`)⇒
   ① 标签总数不变、组内仍是 2 个窗格;② 聚焦窗格是**新** tabId,`url === 'bow://terminal'` 且 `internal === true`;
   ③ 旧 tabId 从 `listTabs()` 消失;④ 新窗格的 rect 与旧窗格**逐一相等**(几何不变);
   ⑤ 终端目标(`terminal.html`)里 `window.__bowTerminal.status === 'ready'`,`bufferText()` 含提示符 ⇒ 会话真的起来了。
3. **建议下拉通路**:`window.browserAPI.goUrl('bow://terminal')`(=`nav:url`,与点建议同一函数)在另一个分屏窗格上复现同样结果。
4. **不生效**:聚焦终端时再 `go('bow://terminal')` ⇒ tabId 与窗格数、rect 全不变。
5. **单标签场景**:一个普通页标签(无分屏)里 `go('bow://terminal')` ⇒ **标签数仍为 1**、该标签变成终端。
6. **快捷键**:用 CDP `Input.dispatchKeyEvent`(`rawKeyDown` + `modifiers` 位掩码,页面 target)对**终端目标**发 `Ctrl+Shift+L` ⇒
   ① chrome 目标里 `document.activeElement` 是地址栏输入框(注意:chrome 是独立 target,要在 chrome 目标里取 activeElement);
   ② 终端缓冲文本/长度**没变**(没有 `^L` / 没清屏)⇒ 验证「不被 xterm 占用」。
7. **回归**:`Ctrl+L` 在终端里仍清屏(终端既有 E2E `terminal-e2e.mjs` 21/21 + `terminal-clipboard-e2e.mjs` 21/21);
   `Ctrl+T` / `Ctrl+Shift+方向` / 标签栏图标聚焦各跑一遍;工具栏「新终端」按钮仍开**新标签组**(`createTab('bow://terminal')` ⇒ 组数 +1)。
8. 每个脚本各跑两遍(第一遍覆盖首轮冷启动)。

跑完把 `bun run test` 的**实际文件数/用例数**回填 S12 的文档数字。

## 6. 风险 / 未知

1. **顶替会关掉当前页(主要风险)**:在真实网页上直接输 `bow://terminal` 会替换掉那个页面。缓解:走 `close()` ⇒ 进 `closedStack`,`Ctrl+Shift+T` 可恢复;文档写明。若用户更想要「只有空白窗格才顶替,否则不生效」,改 `openInternalInPane` 里一行判断即可(计划批准时可提出)。
2. **`Ctrl+Shift+L` 会被所有普通网页标签抢走**:与 `Ctrl+Shift+方向` 同类代价(主进程拿不到「焦点是不是可编辑元素」的同步信息)。`Ctrl+Shift+L` 在浏览器/常见网页里没有通用语义(不像 `Ctrl+Shift+L` 在 VS Code 里是「选中所有匹配项」),代价可接受。
3. **设置页也会被顶替**:`bow://settings` 是内部页面,在它上面输 `bow://terminal` 同样会被换掉(设置页可 `Ctrl+,` 重新打开)。属于假设 ①,需要用户确认。
4. **顶点/崩溃目标**:顶替 DevTools 前端(inspector)窗格时,`close()` 不会把它压进 `closedStack`(既有策略),需要从设备检查面板重开。属可接受。
5. **mac 未实测**(无真机):`Cmd+Shift+L`、以及 `Ctrl+Shift+L` 在 mac 上是否被别的默认菜单吃掉。逻辑上 `before-input-event` 与平台无关,但 mac 的 `editMenu` 加速键只在部分组合上有效(`Ctrl+Shift+L` 不在其中,风险低)。
6. **`replacePane` 的引用语义**:若实现时忘了「兄弟子树引用不变」,会让 `listGroups()` 每次都发新对象导致渲染层多余重画 —— 单测里钉住这条。
7. **`spawn` 到 `activate` 之间的可见性**:新视图在 `layout()` 之前只有默认 bounds(既有 `create()` 同样如此);若真机看到闪一下,可在 `spawn` 后立刻 `setVisible(false)`,由 E2E 判定是否需要。

## 7. 不做的事

- 不改 `releasesToTerminal` 的现有名单(`Ctrl+W` / `Ctrl+L` 仍归 shell)。
- 不给终端按钮加「分屏」语义(`createTab` → 新标签,用户明确要求)。
- 不做「地址栏输入 `bow://terminal` 自动分屏」(用户明确否掉)。
- 不加设置项(键位与打开位置都固定)。
- 不动 `Ctrl+Shift+T` 恢复路径(`restoreLastClosed()` 仍 `create()`,即使恢复到的是终端 URL)。

---

## 8. 实施记录(2026-09-19)

### 8.1 落地(按计划,无设计变更)

| 文件 | 改动 |
| --- | --- |
| `src/shared/shortcuts.ts` | 新 action `focus-address-anywhere`;`matchTabHotkey` 的 shift 分支加 `Ctrl/Cmd+Shift+L`;`releasesToTerminal` 的注释写明新 action 刻意不放行 |
| `src/main/tabShortcuts.ts` | `focus-address` / `focus-address-anywhere` 合并到一个 case(日志区分两者) |
| `src/shared/split.ts` | + `replacePane(root, tabId, newTabId)`(原地换叶子,引用语义:路径外子树不变) |
| `src/shared/groups.ts` | + `replaceTabInGroups(groups, old, new)`(换叶子 + 焦点跟着换) |
| `src/shared/internalPages.ts` | + `InternalPageSpec` / `openIn: 'tab' | 'pane'` / `opensInPane()`(settings=tab、terminal=pane) |
| `src/main/tabManager.ts` | + `openInternalInPane()`(`spawn` + `replaceTabInGroups` + `activate` + `close(旧)`),`openUrl()` 按 `opensInPane` 分流 |
| `tests/{shortcuts,split,groups,internalPages}.test.ts` | +11 例(shortcuts 42、split 50、groups 26、internalPages 11) |
| `README.md` / `docs/ARCHITECTURE.md` / `SplitMenu.vue` | 快捷键清单 + 「按钮=新标签 / 地址栏=顶替聚焦窗格」+ §4 的 openIn 两轴与不变量 + §13 第 23/24 条 + 测试基线 719→**730** |

### 8.2 验证结果

- `bun run typecheck` 过;`bun run test` → **39 文件 / 730 用例全绿**(+11);`bun run build` 过(Windows 侧 `bun.exe run build` 同样过)。
- **新真机 E2E**(`D:/tmp/terminal-pane-e2e.mjs`,Windows 侧 `bun.exe`,隔离 `--user-data-dir` + CDP)**31/31,跑两遍**:

  | 组 | 判据 |
  | --- | --- |
  | A 真地址栏输入 | 点地址栏 → `Input.insertText('bow://terminal')` → Enter:**标签数仍为 1**、旧 id 消失、新标签 `url='bow://terminal'` 且 `internal=true`、组/焦点同步、`__bowTerminal.status==='ready'`(会话真起来了) |
  | B 分屏窗格被顶替 | 2 窗格组、聚焦数据页 → `go('bow://terminal')`:标签总数不变、旧窗格标签消失、新窗格是终端页、**窗格 rect 逐一相等**(`{x:643,y:76,w:638,h:746}`) |
  | C 已是终端 | `go('bow://terminal')` 返回当前 tabId;标签数 / 窗格数 / 终端 target 数 / 活动标签全不变 |
  | D `goUrl()` 通路 | 第 3 个窗格被顶替、标签数不变、会话就绪(E2E 判据同 B) |
  | E 工具栏按钮通路 | `createTab('bow://terminal')` 标签数 +1、新组只有 1 个窗格(仍「新标签」) |
  | F 键位 | 先 `blur()` 地址栏(前置断言未聚焦);`Ctrl+L` → 主进程日志 `快捷键放行给终端 focus-address`、地址栏仍未聚焦;`Ctrl+Shift+L` → 日志 `快捷键:聚焦地址栏 (Ctrl+Shift+L)`、**无**放行日志、地址栏聚焦、终端缓冲一字未变(没被当清屏) |

- **回归**:`terminal-e2e.mjs` **21/21**、`terminal-clipboard-e2e.mjs` **21/21**(键位改动与终端本体都没被破坏)。

### 8.3 偏差与新增发现

1. **E2E 判据踩到「DOM 焦点会残留」**:`document.activeElement` 在 chrome 页里跨窗格切换**不会**自动清——A 段聚焦过地址栏后,F 段一开始 `addressFocused()` 就是 `true`(假阳性)。修法:先 `blur()` 并断言前置未聚焦;再叠一层**主进程日志判据**(放行/接管是主进程的决策,日志是第一现场)。
2. **`nested-split-e2e.mjs` 的 Ctrl+W 处会 CDP 超时**(41 项后中断,`cdp timeout Input.dispatchKeyEvent`):**与本次改动无关** —— 把 6 个 src 文件 `git stash` 后在 HEAD 上重建重跑,复现同一位置同一超时。原因是 `Ctrl+W` 关掉的就是正在被 CDP 派发按键的那个 webContents,`rawKeyDown` 的应答赶不上 target 销毁(该脚本自己的注释里已记过 keyUp 必超时,keyDown 同样会踩)。
3. **建议下拉的首行是搜索行,但 Enter 依然导航**:`mergeSuggestions` 对非空 query 固定插一条 `kind:'search'` 行,`openSuggestion` 走 `go(s.query)` → `resolveNavigation('bow://terminal')` 命中 `SCHEME_RE` → 仍返回 `url`。所以「真输入 + Enter」能开出终端(E2E 的 A 段就是这个链路)。
4. 分屏出的 `about:blank` 窗格被立刻导航会记一条 `加载失败 … ERR_ABORTED (-3)`,属既有行为(blank 的加载被新导航打断),不影响结果。

### 8.4 仍未验证

- **mac 全程未跑**(无真机):`Cmd+Shift+L` 路径、以及 mac 的 `editMenu` 加速键是否会吃掉它。逻辑上 `before-input-event` 与平台无关,且 `Ctrl/Cmd+Shift+L` 不是标准菜单加速键,风险低。
- Chrome 之外的输入法/键盘布局只在单测层覆盖了 `code` 兜底(非 QWERTY 按物理 `KeyL` 命中)。
- 顶替**非空页面**时的视觉/恢复体验(旧页面进关闭栈 → `Ctrl+Shift+T` 找回)只验了机制,没做人工观感确认。
