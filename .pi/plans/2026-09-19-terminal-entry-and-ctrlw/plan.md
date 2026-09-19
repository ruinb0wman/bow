# 终端入口顺手化(内部页进历史 + 可收藏 + `Ctrl+Shift+E`)+ `Ctrl+W` 关聚焦窗格(含终端)

> 2026-09-19 · 目标文件 `src/shared/{shortcuts,internalPages}.ts`、`src/main/{tabShortcuts,tabManager}.ts`、
> `src/plugins/history/main.ts`、`src/plugins/bookmarks/{main.ts,ui/*.vue}` · 文档 `README.md`、`docs/ARCHITECTURE.md`
> 前置:`.pi/plans/2026-09-19-nested-split`(嵌套分屏)、`.pi/plans/2026-09-19-terminal-pane-and-focus-key`(`bow://terminal` 顶替窗格 + `Ctrl+Shift+L`)

## 1. 目标(用户问卷拍板的语义)

用户原话:「1. `bow://terminal` 不会保存在历史中,也不能收藏,输入时麻烦;2. `ctrl+w` 快捷键我希望能关掉 focus 的 terminal 或者分屏」。

| # | 决定 | 用户选择 |
| --- | --- | --- |
| G1 | `Ctrl/Cmd+W` **一律**关掉聚焦的那个窗格/标签 —— 终端里也一样(不再放行给 shell 当「删词」) | 「Ctrl+W 一律关聚焦窗格(含终端)」 |
| G2 | **不做** `Ctrl+D`;只让星标能收藏 `bow://` 内部页,并把 README/tooltip 里「(Ctrl+D)」的说法删掉 | 「不做 Ctrl+D,只让星标能收藏 bow:// 页」 |
| G3 | `bow://terminal` **与** `bow://settings` 都记进浏览历史 | 「bow://settings 也一起记进历史」 |
| G4 | 新增快捷键 **`Ctrl/Cmd+Shift+E` = 在聚焦窗格开终端**(顶替当前窗格) | 键位 + 行为两项都选了第一项 |
| G5 | 从历史建议 / 书签点 `bow://terminal`:**沿用地址栏语义 = 顶替当前聚焦窗格** | 「沿用地址栏语义:顶替当前聚焦窗格」 |

> ⚠️ 计划里我替用户补的假设(需求没覆盖,列在 §7,批准时可直接改):
> - 内部页的历史标题取**记录当时**的 tab 标题(终端页此刻通常还是初始标题「终端」,不会带上 shell 名);
> - `Ctrl+W` 关闭走的是既有的 `TabManager.close()`,所以旧标签仍进 `closedStack`,`Ctrl+Shift+T` 能找回;
> - `Ctrl+Shift+E` 在「聚焦窗格已经是终端」时是**空操作**(与地址栏输 `bow://terminal` 一致,不换标签、不新开)。

## 2. 现状(实读到的代码)

### 2.1 `Ctrl+W` 现在在终端里被放行给 shell

`src/shared/shortcuts.ts:83`:

```ts
export function releasesToTerminal(hotkey: TabHotkey): boolean {
  return hotkey.action === 'close' || hotkey.action === 'focus-address'
}
```

`src/main/tabShortcuts.ts:19` + `:51` —— 放行的判据是**活动标签**,不是「按键从哪个 webContents 来」:

```ts
/** 活动标签是不是终端页(`bow://terminal`):决定 Ctrl+W / Ctrl+L 归 shell 还是归浏览器 */
function isTerminalTab(tab: TabInfo | null): boolean {
  return !!tab && parseInternalUrl(tab.url) === 'terminal'
}
...
        if (releasesToTerminal(hk) && isTerminalTab(getTabs().getActiveTabInfo())) {
          log('快捷键放行给终端', hk.action)
          return
        }
```

`src/main/tabShortcuts.ts:86` —— `close` 关的是 `getActiveTabInfo()`,不是按键来源的那个窗格:

```ts
          case 'close': {
            const active = tabs.getActiveTabInfo()
            if (active) tabs.close(active.id)
            if (tabs.listTabs().length === 0) tabs.create('about:blank', true)
```

结论:① 终端里 `Ctrl+W` 到不了浏览器 → 关不掉;② 焦点在**地址栏**而活动标签是终端时,`Ctrl+W` / `Ctrl+L` 都被
「放行」掉(既没给 shell、也没给浏览器)→ 是死键;③ 关的是活动标签而不是按键来源窗格(两者的 `findTabIdByWebContents(contents)` 反查已经存在,分屏快捷键就在用)。

分屏里的关窗格行为**已经是对的**(`src/main/tabManager.ts:495` 的 `close()` + `unregisterTab()`:组里还有窗格就塌缩,组空了整项消失),
所以 G1 的实质改动只有「终端也归浏览器」+ 关「来源窗格」。

### 2.2 内部页不发布 `tab-navigated`(因此不进历史)

`src/main/tabManager.ts:259`(`spawn()` 内):

```ts
    wc.on('did-navigate', (_e, url) => {
      if (kind === 'page') this.emit('tab-navigated', { tabId: id, url, title: wc.getTitle() || url })
      onNavigate()
    })
```

`docs/ARCHITECTURE.md:257` 把这条写成了不变量:「内部页面不发布 `tab-navigated`(不进历史)」。
事件只有一个消费者关心历史(`src/plugins/history/main.ts:61`),另有 `element-fullscreen` / `adblock` 订阅它做
「导航即取消框选」(传进去的只是 `tabId`,内部页不可能在框选中,多收一次无害)。

### 2.3 历史只认 http(s)

`src/plugins/history/main.ts:55`:

```ts
    const record = (v: { title: string; url: string; kind?: HistoryKind; query?: string }): void => {
      const url = v.url.trim()
      if (!isHttpUrl(url)) return
      store.setRaw(addHistoryEntry(store.get(), { ...v, url }, cap()))
    }
```

`src/shared/history.ts` 的 `addHistoryEntry` 本身与协议无关,按 URL 精确去重、最近优先。

### 2.4 星标 / 书签只认 http(s)

`src/plugins/bookmarks/ui/StarButton.vue:15`:

```ts
  // 仅 http(s) 页面可收藏(内部页面如 bow://settings 不参与书签)
  currentUrl = /^https?:/i.test(url) ? url : ''
```

`src/plugins/bookmarks/ui/StarButton.vue:57` tooltip 还写着没实现的 `Ctrl+D`:
`:title="on ? '取消收藏' : '收藏当前页 (Ctrl+D)'"`(`docs/ARCHITECTURE.md:945` 的漂移表第 1 条)。

`src/plugins/bookmarks/main.ts:148`(MCP `browser_add_bookmark`):

```ts
        if (!isHttpUrl(url)) return textContent({ ok: false, error: '书签地址必须是 http/https' })
```

`src/plugins/bookmarks/ui/BookmarksModal.vue:115` 新增表单的预填也只认 http(s);`shared/bookmarkTree.ts` 本身**不做** URL 校验
(所以手工在面板里填 `bow://terminal` 现在就能存,只是星标不亮、MCP 拒绝)。

### 2.5 打开通路(历史/书签点 `bow://terminal` 已经就是「顶替聚焦窗格」)

`src/renderer/src/App.vue:427` 的 `openSuggestion` → `api.goUrl(s.url)`;`BookmarksModal` 的单击也是 `api.goUrl(node.url)`
→ `ipc.ts` 的 `nav:url` → `TabManager.openUrl()`(`src/main/tabManager.ts:534`):

```ts
    const internal = parseInternalUrl(url)
    if (internal) {
      if (opensInPane(internal)) {
        return this.openInternalInPane(internal) ?? this.getActiveTabInfo() ?? this.openInternal(internal)
      }
```

⇒ G5 **不需要改代码**,只需在文档里写清「点历史/书签里的终端 = 顶替聚焦窗格」。

## 3. 设计

### 3.1 G1:`Ctrl+W` 归浏览器 + 按「按键来源」判断终端

`src/shared/shortcuts.ts`:

```ts
export function releasesToTerminal(hotkey: TabHotkey): boolean {
  // 2026-09-19 用户拍板:终端里 Ctrl+W 也要关窗格(shell 的「删词」让位)。
  // 名单只剩 Ctrl+L(清屏)—— 它是 shell 的高频键,且没有替代品。
  return hotkey.action === 'focus-address'
}
```

同时把 `matchTabHotkey` 的 `shift` 分支扩一个 action(G4 要用,见 3.2)。

`src/main/tabShortcuts.ts`:把「终端判据」从活动标签换成**按键来源**的标签(反查函数已存在):

```ts
        const srcTabId = getTabs().findTabIdByWebContents(contents)
        const srcTab = srcTabId != null ? getTabs().getView(srcTabId)?.info ?? null : null
        if (releasesToTerminal(hk) && isTerminalTab(srcTab)) { ... return }
```

副作用是**修掉两个死键**:焦点在地址栏(或 overlay)而活动标签是终端时,`Ctrl+L` 现在真的会聚焦地址栏
(以前被「放行」吞掉);`Ctrl+W` 现在真的会关掉那个终端标签。

`close` 分支改成先关「来源窗格」:

```ts
          case 'close': {
            const target = srcTabId ?? getTabs().getActiveTabInfo()?.id ?? null
            if (target != null) tabs.close(target)
            if (tabs.listTabs().length === 0) tabs.create('about:blank', true)
            log('快捷键:关闭标签(Ctrl+W)', target ?? '(none)')
            break
          }
```

(来源为 null = 焦点在 chrome/overlay/DevTools 窗口 → 退回活动标签,与今天一致。关窗格 → 塌缩/整组消失的语义全在
`TabManager.close()` 里,不动。)

### 3.2 G4:`Ctrl/Cmd+Shift+E` = 在聚焦窗格开终端

`src/shared/shortcuts.ts` —— `TabHotkey` 加一个**独立 action**(理由与 `Ctrl+Shift+L` 相同:`releasesToTerminal` 是按 action 放行的,
不独立就会被整体让给 shell;而且它必须在终端里也能用 —— 虽然终端里它是空操作,但绝不能漏给 shell):

```ts
  | { action: 'terminal' }
...
  if (input.shift) {
    if (key === 't' || input.code === 'KeyT') return { action: 'restore' }
    if (key === 'l' || input.code === 'KeyL') return { action: 'focus-address-anywhere' }
    if (key === 'e' || input.code === 'KeyE') return { action: 'terminal' }
    return null
  }
```

`src/main/tabShortcuts.ts`(与 `new` / `focus-address` 同策略:全窗弹层打开时不抢焦点):

```ts
          case 'terminal':
            if (!getOverlay().isFullOpen) {
              tabs.openUrl(TERMINAL_URL) // 顶替聚焦窗格;已是终端 / 没有活动窗格 → 内部自行兜底
              log('快捷键:在聚焦窗格打开终端(Ctrl+Shift+E)')
            }
            break
```

选 `openUrl()` 而不是直接 `openInternalInPane()`:它把「没有活动窗格 → 开新标签」的兜底也带上了,与地址栏输入
`bow://terminal` 完全同一条路(用户在 G5 里选的就是这个语义)。

### 3.3 G3:内部页进历史

`src/main/tabManager.ts`(`spawn()` 的 `did-navigate`):内部页面的**真实** URL 是 `file://…/terminal.html` 或 dev server 地址,
对外一律用逻辑 URL:

```ts
    wc.on('did-navigate', (_e, url) => {
      if (kind === 'page') this.emit('tab-navigated', { tabId: id, url, title: wc.getTitle() || url })
      else if (kind === 'internal' && internalId != null) {
        // 内部页也记一条访问(2026-09-19):URL 用 bow://<id>,标题用当时的标签标题
        this.emit('tab-navigated', { tabId: id, url: internalPageUrl(internalId), title: info.title })
      }
      onNavigate()
    })
```

(`inspector` 分支刻意不动:DevTools 前端仍然不进历史。)

`src/plugins/history/main.ts`:

```ts
      // 2026-09-19:内部页(bow://terminal / bow://settings)也进历史 —— 地址栏空输入时的「最近」列表里
      // 直接就有「终端」,输「终」/「term」也能模糊命中,不必再打整串 URL
      if (!isHttpUrl(url) && !isInternalUrl(url)) return
```

带来的效果(**这就是 G3 想要的「输入不麻烦」**):空地址栏 → 建议首行/前排出现「终端」`bow://terminal`;
输入 `终` 或 `term` → 历史源命中;回车 → `openUrl()` → 顶替聚焦窗格(或没有活动窗格时开新标签)。
设置页同理,只是它打开时走 `openInternal()` 的 singleton 语义(已存在则聚焦)。

### 3.4 G2:星标 / 书签支持 `bow://` 内部页

- `StarButton.vue`:`/^https?:/i.test(url) || isInternalUrl(url)`(import `isInternalUrl` from `@shared/internalPages`),
  注释随之改;tooltip 去掉 `(Ctrl+D)`。
- `BookmarksModal.vue` 的 `startAddBookmark` 预填同样放开到内部页(注释同步)。
- `bookmarks/main.ts` 的 MCP `browser_add_bookmark`:校验改为 `isHttpUrl(url) || isInternalUrl(url)`,
  报错文案 / schema 描述改成「http(s) 地址或 `bow://` 内部页面」。
- `shared/bookmarkTree.ts` / IPC `add` **不用改**(它们本来就不校验协议)。

### 3.5 副作用自查(逐条对过代码)

| 改动 | 影响面 | 结论 |
| --- | --- | --- |
| `tab-navigated` 多出内部页 | `history`(要的就是它)、`adblock` / `element-fullscreen`(只 `picking.delete(tabId)`,内部页不可能在框选中) | 无害,已逐处读过 |
| `releasesToTerminal` 去掉 `close` | 终端里的 `Ctrl+W` 不再进 pty;`TerminalView.vue:79` 的 `onKey` 只接管复制/粘贴,不会与主进程抢 | 一致,无双重处理 |
| 终端判据换成来源 webContents | 焦点在 chrome/overlay 时不再「假放行」 | 修掉两个死键 |
| 新增 `Ctrl+Shift+E` | 插件热键只有 `element-fullscreen` 的 `Ctrl+Shift+F`;shell 与常见网页不用该组合(DevTools 前端同理,和现有 `Ctrl+Shift+L` 同一代价) | 无冲突 |
| 星标/书签放开 `bow://` | `openBookmarkBackground`(中键/Ctrl+点击)走 `createTab` → 内部页在**新标签组**打开;单击 = 顶替聚焦窗格 | 与 G5 一致,写进文档 |

## 4. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/shared/shortcuts.ts` | `releasesToTerminal` 只放行 `focus-address`;`TabHotkey` 加 `{action:'terminal'}`;`matchTabHotkey` 认 `Ctrl+Shift+E`;注释更新 |
| `src/main/tabShortcuts.ts` | 终端判据 = 来源 webContents;`close` 关来源窗格;新增 `terminal` 分支;import `TERMINAL_URL` |
| `src/main/tabManager.ts` | `spawn()` 的 `did-navigate` 对 `kind==='internal'` 发布逻辑 URL 的 `tab-navigated` |
| `src/plugins/history/main.ts` | `record()` 放行 `isInternalUrl` |
| `src/plugins/bookmarks/main.ts` | MCP `browser_add_bookmark` 放行内部页 |
| `src/plugins/bookmarks/ui/StarButton.vue` | 星标支持内部页;tooltip 删 `(Ctrl+D)` |
| `src/plugins/bookmarks/ui/BookmarksModal.vue` | 新增表单预填支持内部页 |
| `tests/shortcuts.test.ts` | 放行名单用例改写;新增 `Ctrl+Shift+E` 用例 |
| `tests/history.test.ts` | 新增 `bow://terminal` 的去重/合并用例(可选,约 2 例) |
| `README.md` | 快捷键清单(+`Ctrl+Shift+E`、删 `Ctrl+D`、终端键位改写)、分屏/终端/历史/书签小节 |
| `docs/ARCHITECTURE.md` | `:41` 目录说明、`:257` 不变量表、`:707` 快捷键分工、`:1028` 教训 21、`:945` 漂移表第 1 条、`:905` 用例基线 |

## 5. 分步实施(每步单独可验证)

| 步骤 | 内容 | 验证 |
| --- | --- | --- |
| S1 | `shortcuts.ts`:`releasesToTerminal` 名单 + `terminal` action;`tabShortcuts.ts`:来源判据、`close` 分支、`terminal` 分支 | `bun run typecheck` + `tests/shortcuts.test.ts` 绿 |
| S2 | (可单独砍掉)既有缺陷顺手修:确认框打开期间 `Ctrl+T` / `Ctrl+W` 仍生效(`SCRATCHPAD` 那条)→ 给 `close` 补 `if (getOverlay().isFullOpen) break` | 单测层面不可测;并入 §6 的 E2E 「确认框开着时 Ctrl+W 不改标签数」 |
| S3 | `tabManager.ts` 内部页发布 `tab-navigated` + 历史插件放行内部 URL | `bun run build` 过;真机:开一次 `bow://terminal` → `history.json` 出现该 URL |
| S4 | 星标 / 书签面板 / MCP 放开 `bow://` + tooltip 去 `(Ctrl+D)` | 真机:终端标签点星标 → `bookmarks.json` 有 `bow://terminal` |
| S5 | 文档(README + ARCHITECTURE,含漂移表与用例基线) | 通读对照实现,`grep -n "Ctrl+D"` 应只剩「未实现/已删除」的说明 |
| S6 | 全量回归 + 真机 E2E(§6),实施记录追加到本文件 §8 | `bun run test` 全绿(基线 39 文件 / 730 例)、E2E 全项通过、无新 `未捕获异常` |

## 6. 验证矩阵

### 6.1 单测

- `bun run typecheck` / `bun run build` 过;
- `bun run test`:基线 **39 文件 / 730 例**,预期 +3~5 例(`shortcuts` 改写 + `history` 新增);
- `tests/shortcuts.test.ts` 关键断言:
  - `releasesToTerminal(matchTabHotkey(Ctrl+W))` → **false**;`Ctrl+L` → **true**;`Ctrl+Shift+L` → false;
  - `matchTabHotkey(Ctrl+Shift+E)` → `{action:'terminal'}`,且 `releasesToTerminal` 为 false;
  - `Ctrl+Shift+E` 不误伤现有分支(`Ctrl+Shift+T` 仍是 restore,`Ctrl+E` 仍是 null)。

### 6.2 真机 E2E(Windows 侧,`D:/tmp/terminal-entry-e2e.mjs`,沿用隔离 userData + CDP 骨架)

| # | 场景 | 判据 |
| --- | --- | --- |
| 1 | 单个终端标签里按 `Ctrl+W` | 标签消失;插件日志 `会话已结束 … tab-closed`;`browser_list_tabs` 不含该 id;无 `未捕获异常` |
| 2 | 分屏 `[网页 \| 终端]`,焦点在终端窗格按 `Ctrl+W` | 只剩一个 tabId,网页窗格独占整窗(几何 = 窗口内容区,DIP 相邻/不重叠);会话被回收 |
| 3 | 分屏里焦点在**网页**窗格按 `Ctrl+W` | 只关网页窗格,终端窗格顶替;终端会话仍在(`write` 返回 true) |
| 4 | 焦点在地址栏 + 活动标签是终端,按 `Ctrl+L` | 地址栏聚焦(先 `blur()` 再断言,叠加主进程日志);`Ctrl+W` 关闭该终端标签 |
| 5 | 普通网页按 `Ctrl+Shift+E` | 该窗格 url 变 `bow://terminal`;旧标签可从 `Ctrl+Shift+T` 找回;`history.json` 有该条 |
| 6 | 已在终端的窗格再按 `Ctrl+Shift+E` | 无变化(标签 id 不变、不新建) |
| 7 | 空地址栏(聚焦不输入) | 建议列表里有 `bow://terminal`(最近访问的终端);点它/回车 = 顶替聚焦窗格 |
| 8 | 地址栏输 `终` / `term` | 历史源命中该条(标题「终端」/ URL 里的 term) |
| 9 | 终端标签点星标 | 星标点亮;`bookmarks.json` 含 `bow://terminal`;再点取消收藏可移除 |
| 10 | 书签面板点「终端」书签 / 中键点它 | 单击:聚焦窗格变终端(页面进关闭栈);中键:新标签组开终端,当前页不动 |
| 11 | 关闭窗口确认框(2 标签)打开时按 `Ctrl+W`(S2 若做) | 标签数不变(文案与列表一致);取消后一切照旧 |
| 12 | 回归 | `terminal-e2e.mjs` 21/21、`terminal-clipboard-e2e.mjs` 21/21(终端复制/粘贴、`Ctrl+L` 清屏)仍全绿 |

> ⚠️ E2E 注意(MEMORY + 前两份计划的教训):`Ctrl+W` 关掉的正是正在被 CDP 派发按键的 webContents →
> `Input.dispatchKeyEvent` 会超时。判据用「主进程日志 + 标签列表 + 插件会话表」,不要等 CDP 应答。

## 7. 风险 / 未知

1. **shell 的 `Ctrl+W`(删词)彻底不可用**(G1 的代价)。README 里必须明写,并给出替代(bash/WSL 是 `Alt+Backspace`;
   PowerShell 绑定的替代键依 PSReadLine 配置,**不在文档里硬写**,只提示「各 shell 快捷键不同」)。全屏程序(vim 的窗口切换)同理。
2. **终端历史条目的标题**是记录当时的 `info.title`(通常就是「终端」)。想让标题稳定/好看就得另开事件,本计划不做。
3. **历史被终端刷屏**:频繁开终端会把「最近 8 条」占满(这既是便利也是噪音);保留条数与删除都在设置页已有。
4. `Ctrl+Shift+E` 在网页里(如 code-server / 在线 IDE)会被我们抢走 —— 与现有 `Ctrl+Shift+L/T` 同一代价,写进 README「代价」。
5. **mac 未验**(前两份计划同样遗留):`Cmd+Shift+E` 与 `Cmd+W` 的落点只在 Windows 真机实测。
6. `tab-navigated` 语义被放宽(多了内部页)——`docs/ARCHITECTURE.md` 的不变量表必须同步,否则下一轮又会当成「未实现」。
7. S2(确认框期间 `Ctrl+W`)是**既有缺陷**的顺手修,如果评审想保持本次改动面最小,直接砍掉即可(不影响 G1~G5)。

## 8. 不做的事(明确排除)

- 不实现 `Ctrl+D` 收藏(G2);只删掉文档/tooltip 里骗人的说法。
- 不改「工具栏终端按钮 = 新标签组」的既有语义。
- 不改 MCP 的 `browser_press_key Ctrl+W` / `browser_close_tab`(它们直接调 `tabs.close()`,与本计划无关);
  `browser_navigate` 仍只接受 http(s)。
- 不让历史/书签里的 `bow://terminal` 换成「新标签」语义(G5 选了与地址栏一致)。
- 不给终端加「会话恢复 / 持久化」之类的新能力。

## 9. 实施记录(2026-09-19 完成)

### 9.1 落地(按计划,无设计变更)

| 文件 | 改动 |
| --- | --- |
| `src/shared/shortcuts.ts` | `releasesToTerminal` 只放行 `focus-address`(Ctrl+W 移出名单);`TabHotkey` 新增 `{action:'terminal'}`;`matchTabHotkey` 的 shift 分支认 `Ctrl/Cmd+Shift+E`;注释解释「为什么 Ctrl+W 不再放行」 |
| `src/main/tabShortcuts.ts` | 放行判据改成**按键来源**的 webContents(`findTabIdByWebContents(contents)` → `getView(id)?.info`);`close` 关来源窗格;新增 `terminal` 分支(`openUrl(TERMINAL_URL)`);`closeConfirmOpen()`(只认 `confirm-close` overlay)期间跳过 `new` / `close` |
| `src/main/tabManager.ts` | `spawn()` 的 `did-navigate` 对 `kind==='internal'` 发布**逻辑 URL**(`bow://<id>`)的 `tab-navigated`;`TabEvents['tab-navigated']` 注释更新 |
| `src/plugins/history/main.ts` | `record()` 放行 `isInternalUrl` |
| `src/plugins/bookmarks/main.ts` | MCP `browser_add_bookmark` 接受 `bow://` 内部页(schema 描述与报错文案同步) |
| `src/plugins/bookmarks/ui/StarButton.vue` | 星标支持内部页;tooltip 去掉 `(Ctrl+D)` |
| `src/plugins/bookmarks/ui/BookmarksModal.vue` | 「新增书签」预填支持内部页 |
| `tests/shortcuts.test.ts` | 放行名单用例改写(只有 Ctrl+L)+ `Ctrl+Shift+E` 用例 |
| `tests/history.test.ts` | `bow://` 内部页去重/置顶用例 |
| `README.md` / `docs/ARCHITECTURE.md` | 快捷键清单、关闭窗口、分屏、终端、历史、星标/MCP 全部同步;§12 漂移表第 1 条标为已消除;§11 用例基线 730 → 732 |

### 9.2 验证(实测)

- `bun run typecheck` / `bun run build` 过。
- `bun run test` → **39 个文件 / 732 个用例全绿**(基线 730,+2);连跑 4 次稳定。
  (中间有 1 次 `mcpHttpService` 单例失败,重跑不复现 —— 端口竞态,与本次改动无关。)
- 真机(Windows,`D:/tmp/terminal-entry-e2e.mjs`,隔离 userData + CDP):**42/42 ×2**(T1~T9 全部覆盖,
  §6.2 的 12 组判据逐条通过,含几何并集、历史建议真渲染、星标收藏、确认框期间快捷键失效)。
- 回归:`terminal-e2e.mjs` **21/21**、`terminal-clipboard-e2e.mjs` **21/21**、`terminal-pane-e2e.mjs` **31/31**、
  `nested-split-e2e.mjs` **47/47**。
- 主进程日志无 `未捕获异常`(ConPTY 的 `AttachConsole failed` 堆栈是已知噪声,见 ARCHITECTURE 教训 18)。

### 9.3 偏差与新增发现

1. **S2 的实现比计划更窄**:计划写的是「`isFullOpen` 时跳过 new/close」,落地改成**只认 `confirm-close` overlay**
   (`getOverlay().currentId === CLOSE_CONFIRM_OVERLAY_ID`)。原因:书签面板(`plugin:bookmarks:panel`)也是 `full` 布局,
   按 `isFullOpen` 会让「开着书签面板时 Ctrl+T 不建标签」——那是没必要的回归。顺带把 `SCRATCHPAD` 里那条既有缺陷修掉。
2. **E2E 新教训:分屏/新建后不要依赖「OS 焦点自动落到新窗格」**。CDP 驱动的窗口聚焦时机和人工点不一样,
   旧窗格迟到的 `focus` 事件会走 `activatePaneIfGroupMember` 把 `activeId` 拉回去 —— 于是「`bow://terminal` 顶替哪个窗格」
   变得不确定(E2E 里表现为「替换了网页而不是新窗格」)。真机脚本里改成**显式 `activateTab(新窗格)` 再断言**后才稳定;
   探针(`D:/tmp/term-split-probe.mjs`,连做 3 轮无间隙)证明不显式聚焦时也会踩到,但概率不稳定。
3. 关闭一个**正在加载**的标签会打一条 `加载失败 … ERR_FAILED (-2)`(pending loadURL 被 abort)。既有行为,非本次引入。
4. `nested-split-e2e.mjs` 首跑 46/47(标签栏标题项),**重跑 47/47** —— 该检查没有等页面标题更新,是脚本自身的时序敏感,与本改动无关。

### 9.4 仍未验证

- **mac**:`Cmd+W` / `Cmd+Shift+E` 只在 Windows 真机验过(与前两份计划同样的遗留)。
- 真机上「终端里长按 Ctrl+W 会不会残留什么」之类的手感问题,只有实际用几天才知道。
