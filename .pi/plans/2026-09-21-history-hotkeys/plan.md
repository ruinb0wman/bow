# 历史后退/前进快捷键(Ctrl+←/→) + 顺带把 Ctrl+R 挪进主进程

日期:2026-09-21 · 状态:待批准

## 1. 目标

给 bow 增加全局快捷键 **Ctrl+← = 后退、Ctrl+→ = 前进**(作用于**聚焦窗格**的那个标签,与 `Ctrl+W` 同口径);
顺带把 `Ctrl+R` 刷新从渲染层(chrome 聚焦时才有效)搬进主进程全局拦截,消除 README 的文档漂移。

**用户已拍板(2026-09-21,本次问答):**

| 决定 | 选择 | 理由 / 代价 |
| --- | --- | --- |
| 键位 | **只加 `Ctrl+←` / `Ctrl+→`**(不加 `Alt+←/→`) | 按用户要求;代价照旧:普通网页输入框、笔记页、终端里 `Ctrl+←/→` 的「按词移动光标」在**非终端页**上被浏览器吃掉(与 `Ctrl+Shift+方向` 分屏同一类取舍) |
| 终端页 | `Ctrl+←/→` **放行给 shell**(与 `Ctrl+L` 同策略) | 终端里 readline 的按词移动保住;终端里不能回退 |
| macOS | **不启用** | mac 上 `Ctrl+←/→` 常被系统 Mission Control / 切桌面抢走,而 `⌘+←/→` 是「行首/行尾」,两个都不能动 |
| 附带项 | **把 `Ctrl+R` 也搬进主进程** | 见 §2 的漂移说明;不做鼠标侧键 |

**假设/口径:**

- 「后退/前进」目标是**按键来源的那个 webContents 对应的标签**;拿不到来源(焦点在 chrome / overlay / DevTools 窗口)才退回活动标签 —— 与 `close` 分支完全一致。
- 按住不放不连发(`matchTabHotkey` 早已全局忽略 `isAutoRepeat`),与 Chrome 行为一致。
- `Ctrl+R` 在**终端页放行给 shell**(shell 的 `Ctrl+R` = 反向历史搜索,高频,绝不能吞) —— 这点用户没提,但和 `Ctrl+L` 同理,计划中作为必须项。

## 2. 要改的文件与现状(引用的都是已读到的真实代码)

### 2.1 `src/shared/shortcuts.ts`(纯逻辑,两端安全,单测的主战场)

- `TabHotkey`(`:31`)目前只有 `new/restore/close/switch/settings/focus-address/focus-address-anywhere/terminal`,
  需要加 `{ action: 'back' }`、`{ action: 'forward' }`、`{ action: 'reload' }`。
- `matchTabHotkey()`(`:59`)的结构:
  ```ts
  if (input.type !== 'keyDown') return null
  if (input.isAutoRepeat || input.isComposing) return null
  if (!(input.control || input.meta) || input.alt) return null
  const key = input.key.toLowerCase()
  if (input.shift) { ...t/l/e...; return null }
  if (key === 't' || input.code === 'KeyT') return { action: 'new' }
  ...
  ```
  注意两点:① 修饰键判据是 `control || meta`、且 `alt` 一律不参与;② `shift` 分支**先返回**,
  所以 `Ctrl+Shift+方向` 不会落到这里(它归 `matchSplitHotkey`,而 `tabShortcuts.ts` 是先调 `matchTabHotkey` 的,
  ⇒ 箭头键的匹配必须写在 `if (input.shift)` 之后、`control || meta` 兜底 `return null` 之前)。
- 箭头方向的现成映射在 `ARROW_DIRS`(`:126`,在 `matchTabHotkey` **之后**声明,`const` 在模块求值时初始化,
  运行时调用没问题,但读代码会跳;建议把这块 `const` 上移到 `matchTabHotkey` 之前)。
- `releasesToTerminal()`(`:95`)当前是 `return hotkey.action === 'focus-address'`,注释里明确「⚠️ 按 action 放行」。

### 2.2 `src/main/tabShortcuts.ts`(接线)

```ts
      if (hk) {
        const srcTabId = getTabs().findTabIdByWebContents(contents)
        const srcTab = srcTabId != null ? getTabs().getView(srcTabId)?.info ?? null : null
        if (releasesToTerminal(hk) && isTerminalTab(srcTab)) {
          log('快捷键放行给终端', hk.action)
          return
        }
        event.preventDefault()          // :80 —— 无条件,任何新的「不接管」分支都必须写在它**之前**
        const tabs = getTabs()
        switch (hk.action) { ... }
```
`close` 分支(`:121`)是「拿来源窗格、退回活动标签」的样板:
```ts
const target = srcTabId ?? tabs.getActiveTabInfo()?.id ?? null
if (target != null) tabs.close(target)
```

### 2.3 `src/main/tabManager.ts`

`back(id)` / `forward(id)`(`:608`/`:615`)已存在且返回 `boolean`(不可回退时 `false`),直接复用:
```ts
hit.view.webContents.navigationHistory.canGoBack() → goBack()
```
`reload(id)`(`:624`)也已存在。**主进程不需要新 API**。

### 2.4 `src/renderer/src/App.vue`(要删的重复实现)

```ts
function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  if (e.key === 'Escape' && splitMenuOpen.value) { closeSplitMenu(); return }
  // Ctrl+T / Ctrl+Shift+T / Ctrl+W / Ctrl+L / Ctrl+数字 已由主进程统一拦截(tabShortcuts.ts)
  if (mod && !e.shiftKey && key === 'r') { e.preventDefault(); void reload() }   // :561
}
```
主进程接管后这段是死代码(被 `preventDefault` 的按键渲染层收不到)。工具栏按钮(`:640-641`)的
`title="刷新 (Ctrl+R)"` 与 `reload()` 保留 —— 搬进主进程后这个 tooltip 才**真的**到处都成立。

### 2.5 文档

- `README.md:359`:「`Ctrl+L` 聚焦地址栏…、`Ctrl+R` 刷新、`Ctrl+,` 打开设置」——
  「`Ctrl+R` 刷新」现在没写任何限定,但实现只在渲染层(App.vue)接过,主进程与 Chromium 都没有这个默认键
  ⇒ **页面聚焦时按 Ctrl+R 其实没反应**(`docs/ARCHITECTURE.md:750` 的「chrome 侧只保留 Ctrl+R」正是这个设计的记录)。
  本次搬到主进程后这句话才成立,但要补「终端页除外」。
- `README.md:358-365`(手动快捷键清单):新增 `Ctrl+←/→` 一条。
- `README.md:443-449`(终端页键位):补 `Ctrl+←/→` 与 `Ctrl+R` 归 shell。
- `docs/ARCHITECTURE.md:41`(`tabShortcuts.ts` 摘要)、`:743-750`(§7.2 快捷键分工,「chrome 侧只保留 Ctrl+R」这句要改)、
  `:1106-1110`(releasesToTerminal 放行名单)、`:1123-1124`(按 action 放行的说明)。

## 3. 实施步骤(每步可独立验证)

### 步骤 1 — `src/shared/shortcuts.ts`:三个新 action + 匹配 + 放行规则 + 平台开关

1. `TabHotkey` 加 `{ action: 'back' } | { action: 'forward' } | { action: 'reload' }`,并更新函数头注释。
2. 把 `const ARROW_DIRS`(`:126`)上移到 `matchTabHotkey` 之前(纯搬移)。
3. `matchTabHotkey` 在 `if (input.shift) {...}` 之后插入:
   ```ts
   // Ctrl+←/→:历史后退/前进(仅 Ctrl,**不认 ⌘** —— macOS 上 ⌘+←/→ 是行首/行尾,另见 historyHotkeyEnabled)
   const code = input.code ?? ''
   const arrowDir = ARROW_DIRS[code] ?? (code.startsWith('Numpad') ? undefined : ARROW_DIRS[input.key])
   if (input.control && !input.meta && !input.alt && arrowDir) {
     if (arrowDir === 'left') return { action: 'back' }
     if (arrowDir === 'right') return { action: 'forward' }
     return null // Ctrl+↑/↓ 不接管
   }
   ```
   小键盘排除(`Numpad4/6` 在 Chrome 里 `key` 也是 `ArrowLeft/Right`)与数字切换的既有策略一致(`:88` 的 `code.startsWith('Numpad')`)。
4. `Ctrl+R` 放进非 shift 分支(与其它 tab 热键一样认 `control || meta`,mac 上 `⌘R` 刷新技术上正确):
   ```ts
   if (key === 'r' || input.code === 'KeyR') return { action: 'reload' }
   ```
   位置:紧跟 `if (key === 'l' || input.code === 'KeyL')` 之后。
   ⚠️ 不要动 `shift` 分支 ⇒ `Ctrl+Shift+R`(硬刷新)保持现状(不接管)。
5. 新增平台开关(放在 `releasesToTerminal` 附近,便于单测):
   ```ts
   /**
    * Ctrl+←/→(历史后退/前进)是否在本平台启用。
    * macOS 上 Ctrl+←/→ 常被系统(Mission Control / 切换桌面)先吃掉,而 ⌘+←/→ 是行首/行尾 ——
    * 2026-09-21 用户拍板:mac 不启用。matchTabHotkey 里箭头只认 control(不认 meta),
    * 这里再挡一层,保证 mac 上「按键不接管」而不是「接管后什么都不做」。
    */
   export function historyHotkeyEnabled(platform: string): boolean {
     return platform !== 'darwin'
   }
   ```
6. `releasesToTerminal` 放行名单加两个:**`back`/`forward`**(readline 按词移动)与 **`reload`**(shell 反向历史搜索):
   ```ts
   return hotkey.action === 'focus-address' || hotkey.action === 'back' ||
          hotkey.action === 'forward' || hotkey.action === 'reload'
   ```
   同步更新该函数的注释(现状写的是一句 `return hotkey.action === 'focus-address'` 加一段解释)。

**验证:** `npm run typecheck` + 步骤 4 的单测(先红后绿)。

### 步骤 2 — `tests/shortcuts.test.ts`:补单测

在 `matchTabHotkey` / `releasesToTerminal` 两个 describe 内新增用例:

- `Ctrl+←` → `{action:'back'}`;`Ctrl+→` → `{action:'forward'}`(`key` 与 `code` 任缺其一都能认出方向,照 `arrow()` 辅助函数的写法)。
- **不命中**:`⌘+←`(仅 meta)必须是 `null`;`Alt+Ctrl+←`、`Ctrl+Shift+←`(后者同时断言 `matchSplitHotkey` 仍是 `split left`)、
  `keyUp`、`isAutoRepeat`、`isComposing`、`Ctrl+Numpad4`、`Ctrl+↑/↓`。
- `Ctrl+R` → `{action:'reload'}`、`⌘R` → `reload`、`Ctrl+Shift+R` → `null`(硬刷新不接管)。
- `releasesToTerminal`:`back`/`forward`/`reload` 均为 `true`;`new`/`switch`/`settings` 仍为 `false`。
- `historyHotkeyEnabled('darwin') === false`,其余(`'win32'`/`'linux'`,以及顺带一个 `'freebsd'`)为 `true`。

**验证:** `bun run test`(基线 44 文件 / 862 例,预期只增不减)。

### 步骤 3 — `src/main/tabShortcuts.ts`:接线

1. import 里加 `historyHotkeyEnabled`。
2. 在 `if (releasesToTerminal(...))` 之后、`event.preventDefault()` **之前**插入 mac 闸门:
   ```ts
   // macOS:不启用 Ctrl+←/→ 历史导航(见 historyHotkeyEnabled)。不接管 ⇒ 原样留给系统/页面。
   if ((hk.action === 'back' || hk.action === 'forward') && !historyHotkeyEnabled(process.platform)) return
   ```
3. `switch (hk.action)` 新增两个 case(放在 `close` 之前,顺序随意,便于阅读):
   ```ts
   case 'back':
   case 'forward': {
     // 目标是按键来源的那个窗格(与 Ctrl+W 同):分屏里回退/前进的是**聚焦窗格**的历史
     const target = srcTabId ?? tabs.getActiveTabInfo()?.id ?? null
     if (target == null) break
     const ok = hk.action === 'back' ? tabs.back(target) : tabs.forward(target)
     log(hk.action === 'back' ? '快捷键:后退(Ctrl+←)' : '快捷键:前进(Ctrl+→)', target, ok ? 'ok' : '无历史')
     break
   }
   case 'reload': {
     // 原先只在渲染层(chrome 聚焦时)承接:页面聚焦时 Ctrl+R 是死键 ⇒ 搬到这里,全焦点生效。
     const target = srcTabId ?? tabs.getActiveTabInfo()?.id ?? null
     if (target != null) tabs.reload(target)
     log('快捷键:刷新(Ctrl+R)', target ?? '(无来源)')
     break
   }
   ```
   刻意**不**为它们加「全窗弹层开着就不生效」的闸门(那是 `Ctrl+T/L/Shift+E` 的策略):
   后退/前进/刷新在弹层开着时无害,且与 `close` 的口径一致;`closeConfirmOpen()` 也不拦(那个框只关心 `Ctrl+T/W`)。
4. 更新文件头注释里的快捷键清单(`Ctrl+T / Ctrl+Shift+T / Ctrl+W / Ctrl+L / …`)。

**验证:** `npm run typecheck` + `npm run build`;手测见步骤 6。

### 步骤 4 — `src/renderer/src/App.vue`:删掉重复的 Ctrl+R

删 `onKeydown` 里 `if (mod && !e.shiftKey && key === 'r') {...}` 一段,以及因此不再使用的
`const mod` / `const key`;保留 `Escape` 分支、`reload()` 函数与工具栏按钮,tooltip 文案不动。

**验证:** `npm run typecheck`(web project)+ `bun run test`;手测点工具栏刷新仍然工作。

### 步骤 5 — 文档

按 §2.5 逐条改 `README.md` 与 `docs/ARCHITECTURE.md`;README 新增条目建议措辞:

```
- `Ctrl+←` / `Ctrl+→`:后退 / 前进(**聚焦的那个窗格**的历史)。在**普通网页标签**上全局接管 ⇒
  网页输入框里的「按词移动光标」让位(与 `Ctrl+Shift+方向` 分屏同一类代价);**终端页里放行给 shell**
  (readline 的按词移动);**macOS 上不启用**(`Ctrl+←/→` 常被系统抢走,`⌘+←/→` 是行首/行尾)
- `Ctrl+R` 刷新**聚焦窗格**:原先只有浏览器 UI 聚焦时才有效,现在页面里也生效;**终端页里仍归 shell**
  (`Ctrl+R` = 反向历史搜索)
```

**验证:** 改完用 `grep -n "Ctrl+R" README.md docs/ARCHITECTURE.md` 复核「chrome 侧只保留 Ctrl+R」这类旧说法都已改掉。

### 步骤 6 — 验证(人工 / E2E)

- 必做:`npm run typecheck`、`bun run test`、`npm run build`。
- 真机手测(Windows 侧 `wsync` → `npm run build` → 重启 bow):
  1. 普通标签打开 A → B,`Ctrl+←` 回 A、`Ctrl+→` 回 B;在**输入框聚焦**时按 `Ctrl+←` 也是回退(预期 = 接管),
     同时确认输入框的按词移动确实丢了(这是已知代价)。
  2. 分屏两个窗格、焦点在右窗格:`Ctrl+←` 只动右窗格的历史,左窗格不变;焦点在地址栏(无来源)时退回活动标签。
  3. 终端页:按 `Ctrl+←/→` 不导航(`bash` 里应看到按词移动)、`Ctrl+R` 触发反向搜索;`Ctrl+L` 仍是清屏。
  4. `Ctrl+R` 在页面/地址栏/笔记页/设置页都刷新;工具栏按钮仍可刷新。
  5. mac 只有在有真机时才验(预期:行为零变化)。
- 可选(本仓库**没有** E2E 框架,脚本一直是临时放 `D:\tmp`):写 `D:\tmp\history-hotkey-e2e.mjs`,
  用 CDP 在**页面 target** 上发 `rawKeyDown{ key:'ArrowLeft', code:'ArrowLeft', modifiers:2 }`(memory 已证实
  页面 target 的 CDP 按键会触发主进程 `before-input-event`)断言 URL 回退/前进、`Ctrl+R` 触发 `did-start-loading`;
  终端窗格那条因要读 pty 输出,建议留在手测。执行时**从 Windows 侧重定向到文件再读**
  (`cmd.exe /c "bun.exe D:\tmp\… > D:\tmp\…-out.txt 2>&1"`),避免 `process.exit()` 截掉汇总行。

### 步骤 7 — 提交

一次 `feat:` 提交(源码 + 单测 + 文档);计划文件在 `.pi/plans/`(gitignore,不入库)。
提交信息里写明两条取舍:网页输入框按词移动让位、mac 不启用。

## 4. 风险 / 未知

1. **最大的行为代价**:普通网页/笔记页(`bow://logseq`)里 `Ctrl+←/→` 不再做按词移动 —— 用户已知情并选择接受。
   如果日后后悔,回退点很小:把匹配移到一个 `shouldTakeHistoryHotkey(target)` 判据(照 `shouldTakeSplitHotkey`,
   在设置页 / DevTools 前端 / `contenteditable` 场景放行)——但 `before-input-event` **同步**拿不到页面聚焦元素,
   「只在输入框放行」这条路做不到,只能按页面类型粗粒度放行。
2. **macOS 是纸面结论**:本次不做真机验证(core 逻辑里 `Ctrl+←/→` 只认 `control`,加上主进程 `darwin` 闸门,
   最坏情形是「mac 上按了没反应」,不会是错误行为)。`⌘+←/→` 已由「箭头只认 control」保证不受影响。
3. **DevTools 前端 / 远程调试标签(inspector)**:`Ctrl+←/→`、`Ctrl+R` 会被主进程吃掉并作用于(回退到)活动标签。
   这与既有 tab 热键(`Ctrl+W` 等)口径一致,但 DevTools 控制台里的按词移动会丢 —— 属 §4.1 同类代价,本次不特殊处理。
4. **`Ctrl+R` 的连带影响面**:从「chrome 聚焦才有效」变成「全局有效」,行为变化比新快捷键更大;
   唯一需要保住的例外(终端 shell 的 `Ctrl+R`)已由 `releasesToTerminal` 覆盖,需在步骤 6.3 手测确认。
6. **MCP 侧连带影响**:`browser_press_key {key:'Ctrl+Left'}` 走 `pressKey()`(原生 `sendInputEvent`),
   而它**同样**触发 `before-input-event` ⇒ 从此是「后退」而不再是「按词移动光标」(`Ctrl+R` 那条早有专门分支,
   `Ctrl+W/T` 同理)。这与 App 的新行为一致,且 MCP 本来就有 `browser_back` / `browser_forward`,不算能力缺口;
   但要意识到「AI 想让页面按词移动光标」从此在这个组合上做不到(README 的 `browser_press_key` 说明可视情况补一句)。
7. `bun run test` 基线 862 例来自 memory(2026-09-20 之后),本仓库测试数会随新增用例上升;以实际输出为准,
   不追平这个数字。

## 5. 实施记录(2026-09-21,已完成编码与单测)

按 §3 步骤 1–5 全部落地,6 个文件改动(`git status` 见下),没有偏离计划的地方;两处小调整:

- `matchTabHotkey` 里箭头分支的条件写成 `input.control && !input.meta && arrowDir`(去掉了冗余的 `!input.alt` ——
  Alt 已由上一行的兜底 `if (!(input.control || input.meta) || input.alt) return null` 挡住,并补了一条单测钉住)。
- `ARROW_DIRS` 从 `matchSplitHotkey` 上方搬到 `matchTabHotkey` 上方(两个匹配器共用,注释已更新)。

改动的文件:`README.md` / `docs/ARCHITECTURE.md`(§2.5 列的全部位置)/ `src/main/tabShortcuts.ts` /
`src/renderer/src/App.vue` / `src/shared/shortcuts.ts` / `tests/shortcuts.test.ts`。

**验证结果(真实执行):**

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过(node + web 两个 project) |
| `bun run test` | **45 文件 / 882 例全绿**(基线 44 文件 / 862 例,+20 例 = 新增的 3 个 describe) |
| `npm run build` | 通过 |

**未做(留给用户/真机):**

- 步骤 6 的手测 1–5(需 Windows 侧 `wsync` → `npm run build` → **重启 bow**;若 pi 就跑在 bow 里,重启会关掉当前会话)。
- 步骤 6 的可选 CDP E2E 脚本(`D:\tmp\history-hotkey-e2e.mjs`)—— 本仓库没有 E2E 框架,不擅自新建。
- macOS 真机(计划里就是「纸面结论」)。

## 6. 真机 E2E(WSL/Linux 侧,2026-09-21 实跑)

计划里 §3 步骤 6 那个「可选」的 E2E 做了 —— 不是 Windows 真机,而是**本机 Linux Electron 上的真跑**
(`/mnt/d/tmp/history-hotkey-e2e-wsl.mjs`,骨架照 `D:/tmp/terminal-ctrl-alt-e2e.mjs`:隔离 `--user-data-dir`
+ `--remote-debugging-port=9395` + CDP,再起一个 `127.0.0.1:9396` 的两页静态站造历史)。

| 判据 | post-fix | pre-fix(`git checkout HEAD~1 -- src` 重建) |
| --- | --- | --- |
| 页面里 `Ctrl+←` → 后退到 `/a` | PASS | **FAIL**(URL 停在 `/b`) |
| 页面里 `Ctrl+→` → 前进到 `/b` | PASS | PASS(**平凡通过**:pre-fix 根本没离开过 `/b`) |
| 页面聚焦时 `Ctrl+R` 刷新 | PASS | **FAIL**(证实了 README 那句话原先确实是死的) |
| chrome 聚焦时 `Ctrl+R` 仍刷新 | PASS | PASS |
| 回归:`Ctrl+Shift+←` 仍是分屏(新增 2 个窗格) | PASS | PASS |
| 终端页 `Ctrl+←/→`、`Ctrl+R`、`Ctrl+L` 产出 xterm 字节且主进程不接管 | PASS | PASS |
| 主进程日志有「快捷键:后退/刷新」 | PASS | **FAIL**(日志里只有「分屏/调整大小」) |
| **合计** | **18/18(连跑 2 次全绿)** | **14/18(红的正好是 4 条新能力判据)** |

输出留档:`D:\tmp\history-hotkey-out-postfix.txt` / `-out-prefix.txt`。

**这轮 E2E 自己犯的两个错(已修,记下来)**:① 「主进程没对终端写日志」那条断言看的是**全量**日志,
结果被上面页面段写进去的「快捷键:后退」误判成红 —— 改成只取「终端段开始之后新增的」行;
② Linux 侧 `node-pty` 只有 win32/darwin prebuild ⇒ 终端 `status=error`,别拿它当 FAIL。

**仍未验证(不因这轮 E2E 而消失)**:
- 「字节真的进了 pty」这一层 —— 本机 pty 起不来,上面验的是 xterm 编码 + 渲染层 IPC + 主进程没
  `preventDefault`;pty/shell 那一跳要 Windows 真机(或装了 Linux prebuild 的机器)补。
- Windows 真机的组合键路径(`node-pty` + conpty 那一整跳)与 macOS(darwin 闸门只有单测覆盖)。
