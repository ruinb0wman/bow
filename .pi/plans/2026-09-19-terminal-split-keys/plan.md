# 终端里也能用 `Ctrl+Shift+方向` 分屏 / `Alt+Shift+方向` 调大小

## 0. 目标

焦点落在终端窗格(`bow://terminal`)时,`Ctrl/Cmd+Shift+方向` 要能分屏、`Alt+Shift+方向` 要能调整
聚焦窗格大小 —— 与普通网页标签完全一致。当前这两个组合被主进程**刻意放行**给 xterm,
而 xterm 把它们编成 CSI 序列(`\e[1;6C` / `\e[1;4C`)送进 pty ⇒ 既不进 shell 也不分屏,按键像掉了一样。

**假设 / 已拍板(2026-09-19 问卷)**:

- 接管范围 = **只终端页**(`internalId === 'terminal'`)。设置页、设备检查的 DevTools 前端标签
  保持原样(仍拿这两个组合做文本选择/前端快捷键),地址栏同理(它压根不属于任何标签)。
- 代价接受:**两个组合都从 shell 手里拿走**。接管后 shell 与终端里的程序(vim / tmux / fzf)
  再也收不到 `Ctrl+Shift+方向` / `Alt+Shift+方向`(bash/zsh 默认没绑,个别配置会用)。

## 1. 现状取证(读过的代码)

`src/main/tabShortcuts.ts:135-153`(分屏快捷键分支,真正的原因在这里):

```ts
      // 分屏快捷键:`Ctrl/Cmd+Shift+方向` 分屏、`Alt+Shift+方向` 调整当前窗格大小。
      // 只在「聚焦的 webContents 属于**普通网页标签**」时接管 —— 地址栏、`bow://settings`、终端页、
      // DevTools 前端里的这些组合(按词选择 / xterm 的选择扩展 / 前端自己的快捷键)必须原样留给它们。
      const splitHk = matchSplitHotkey(input)
      if (splitHk) {
        const tabId = getTabs().findTabIdByWebContents(contents)
        const rec = tabId != null ? getTabs().getView(tabId) : null
        if (rec && !rec.info.internal) {
          ...
          event.preventDefault()
          if (splitHk.kind === 'split') getTabs().splitFocused(splitHk.dir)
          else getTabs().resizeFocused(splitHk.dir)
```

终端标签在 `spawn()` 里被登记成 `kind:'internal'` + `info.internal:true` + `internalId:'terminal'`
(`src/main/tabManager.ts:219-248`) ⇒ `!rec.info.internal` **不成立** ⇒ 不 `preventDefault` ⇒ 按键进页面。
`tabs.openUrl('bow://terminal')`(`tabManager.ts:580-595`)最终走 `openInternalInPane()`:`spawn()` 换叶子 +
`replaceTabInGroups()` + `close(旧)`(`tabManager.ts:555-572`),所以「终端窗格」就是个普通 `TabRecord`,
`findTabIdByWebContents()` 能反查到它。

xterm 侧确认(`node_modules/@xterm/xterm/src/common/input/Keyboard.ts:138-160`):带修饰的方向键走
`case 37..40` 的 `if (modifiers) result.key = C0.ESC + '[1;' + (modifiers+1) + 'A'`,
然后 `CoreBrowserTerminal._keyDown()` 里 `this.coreService.triggerDataEvent(result.key, true)` 送进 pty。
**⇒ 文档里「xterm 选择扩展」的说法不准确**(`SelectionService.shouldForceSelection()` 只看鼠标事件),
顺手在注释里更正 —— 那不是「留着有用」,是纯丢键。

`TerminalView.vue:74-95` 的 `attachCustomKeyEventHandler(onKey)` 只接管 `Ctrl+C/V`,`Ctrl+Shift+L` 的
E2E 已证明主进程能收能拦(`D:/tmp/terminal-pane-e2e.mjs` F 段)⇒ **渲染层不需要任何改动**。

焦点链路没问题:`wireLifecycle` 的 `activatePaneIfGroupMember`(`tabManager.ts:379-387`)会在终端视图
`focus`/`input-event` 时把 `activeId` 切到终端 ⇒ `activeGroup()/focusedTabId()` 拿到的就是终端所在组。
`splitFocused()` / `resizeFocused()`(`tabManager.ts:706-745`)本身不关心窗格是不是内部页。

## 2. 要改的文件

| 文件 | 改什么 |
| --- | --- |
| `src/shared/shortcuts.ts` | 新增纯判据 `shouldTakeSplitHotkey()`(可单测);更正 `matchSplitHotkey` 的注释 |
| `src/main/tabShortcuts.ts` | 分屏分支用新判据替换 `rec && !rec.info.internal` |
| `tests/shortcuts.test.ts` | 给新判据加用例 |
| `README.md` | 「手动使用快捷键」「标签组与嵌套分屏 → ⚠️ 代价」「终端 → 键位」三处 |
| `docs/ARCHITECTURE.md` | 文件表 §2 那一行(41)+ §7.2 快捷键分工(714-716) |
| `D:/tmp/terminal-pane-e2e.mjs`(仓库外,不提交) | 新增 G 段:终端里真按键 → 分屏 / 调大小 / 按键没进页面 |

不需要动:`src/plugins/terminal/**`、`src/preload/**`、`ipc.ts`(E2E 已有 `groups:split|resize` 兜底入口)、
`split.ts` / `groups.ts` 的任何几何逻辑。

## 3. 步骤

### S1. `src/shared/shortcuts.ts`:抽出接管判据

在 `matchSplitHotkey` 下方新增(与 `releasesToTerminal` 并列,风格一致):

```ts
/** 聚焦视图的「够用」形状(只取判据需要的两个字段,便于单测) */
export interface SplitHotkeyTarget {
  /** 是否为内部页面(`TabInfo.internal`) */
  internal: boolean
  /** 内部页面 id(非 `bow://` 页面为 null) */
  internalPageId: InternalPageId | null
}

/**
 * `Ctrl+Shift+方向` / `Alt+Shift+方向` 该由浏览器接管吗?
 * - 普通网页标签:接管(代价:网页 `<input>` 也拿不到,见 README);
 * - 终端页(`bow://terminal`):**接管** —— 终端里 xterm 会把它编成 CSI 序列送进 pty,
 *   不拦就永远分不了屏 / 调不了大小;
 * - 设置页 / DevTools 前端标签(以及 `null` = 地址栏、浮层、其它窗口):不接管。
 */
export function shouldTakeSplitHotkey(target: SplitHotkeyTarget | null): boolean {
  if (!target) return false
  return !target.internal || target.internalPageId === 'terminal'
}
```

顶部 `import type { InternalPageId } from './internalPages'`(`internalPages.ts` 无任何依赖,不产生环)。

同文件 `matchSplitHotkey` 的注释末尾那段(现在写的是「调用方还必须保证只在……普通网页标签……终端……原样留给它们」)
改成指向新判据,并更正 xterm 的表述:

```
 * 调用方用 `shouldTakeSplitHotkey()` 决定是否接管:普通网页标签与**终端页**都接管
 * (终端里 xterm 会把组合编成 CSI 序列送进 pty,不拦就分不了屏),地址栏 / 设置页 / DevTools 前端原样留给它们。
```

### S2. `src/main/tabShortcuts.ts`:把判据接进去

```ts
      const splitHk = matchSplitHotkey(input)
      if (splitHk) {
        const tabId = getTabs().findTabIdByWebContents(contents)
        const rec = tabId != null ? getTabs().getView(tabId) : null
        // 判据见 shouldTakeSplitHotkey():普通网页标签与终端页归浏览器,
        // 地址栏(rec=null)、设置页、DevTools 前端保持原样。
        if (rec && shouldTakeSplitHotkey({ internal: rec.info.internal, internalPageId: rec.internalId })) {
```

同时把该分支上方那段注释(135-138 行)改成说明「终端页也接管,代价是 shell 收不到」。
`import` 行加 `shouldTakeSplitHotkey`。

> 行为变化只有一处:`rec.internalId === 'terminal'` 时从「放行」变「`preventDefault` + 分屏/调大小」。
> 地址栏(`rec === null`)、设置页、DevTools 前端、全窗弹层开着时的早退路径(`isFullOpen`)全不变。

### S3. `tests/shortcuts.test.ts`:钉住判据

新增 `describe('shouldTakeSplitHotkey 分屏快捷键接管判据')`,五例:

- `{internal:false, internalPageId:null}`(普通网页)→ `true`
- `{internal:true, internalPageId:'terminal'}` → `true`(这条就是本次修的行为)
- `{internal:true, internalPageId:'settings'}` → `false`
- `{internal:true, internalPageId:null}`(inspector:DevTools 前端标签的真实形状)→ `false`
- `null`(地址栏 / 浮层)→ `false`

`matchSplitHotkey` 本身的既有用例不动(它的语义没变)。

### S4. 文档

- `README.md:363-365`(手动使用快捷键):「只在**普通网页标签**上接管 …… 终端页 / `xterm 选择扩展`」
  → 「在**普通网页标签**与**终端页**上接管;地址栏、设置页、DevTools 前端里的它们保持原样(按词选择 / 前端自己的快捷键)」。
- `README.md:413-415`(⚠️ 代价):补上「终端页也接管,所以 shell 与 vim/tmux 之类也收不到这两个组合」,
  删掉「终端页不受影响」。
- `README.md` 终端一节「键位」那条:在 `Ctrl+L` 归 shell 之后补一句
  「**`Ctrl+Shift+←/→/↑/↓` / `Alt+Shift+←/→/↑/↓` 归浏览器** —— 终端窗格上照样分屏 / 调大小,shell 收不到这两个组合」。
- `docs/ARCHITECTURE.md:41`:`(终端页里 Ctrl+L 与分屏键放行给 shell)` → `(终端页里只有 Ctrl+L 放行给 shell;分屏键在终端页也接管)`。
- `docs/ARCHITECTURE.md:714-716`:改成「属于**普通网页标签或终端页**时 `preventDefault`」+ 一句原因与代价;
  顺手删掉「xterm 选择扩展」这个不准确的说法。
- `SplitMenu.vue:88` 的面板提示是通用文案(没提限制),**不改**。

### S5. E2E(仓库外,`D:/tmp/terminal-pane-e2e.mjs` 追加 G 段)

复用该脚本既有的 `keyTo(conn,…)` / `groups()` / `activate()` / `appLog` 机制:

1. `vkOf` 补 `ArrowLeft/ArrowUp/ArrowRight/ArrowDown`。
2. 在终端页装**捕获阶段** keydown 记录器 `window.__seenKeys`(记录 `key+修饰键`),
   先发一个普通 `ArrowRight` 当**控制组**,断言 `__seenKeys` 里**有** `ArrowRight` —— 证明记录器有效、
   主进程接管前按键确实会进页面。
3. `logMark = appLog.length`;对终端 target 发 `Ctrl+Shift+ArrowRight`:
   - 日志出现 `快捷键:分屏/调整大小` + `split` + `right`,且**不**出现 `快捷键放行给终端`;
   - `__seenKeys` 里**没有** `ArrowRight+ctrl+shift`(⇒ 按键没进页面,xterm 也就没机会送进 pty);
   - 组从 1 窗格变 2 窗格、焦点落到新窗格、终端标签仍在组里。
4. `activate(终端标签)` 等 `groups[0].focus` 回到它(E2E 铁律:分屏后不要指望 OS 焦点自动落位),
   记录终端窗格 rect 宽度;发 `Alt+Shift+ArrowRight`:
   - 日志出现 `resize` + `right`;
   - 终端窗格 rect **变宽**(左窗格朝右扩张)。
5. 回归:地址栏聚焦时发 `Ctrl+Shift+ArrowRight` → 组数/窗格数不变(证明没把 chrome 也顺手接管了);
   `Ctrl+L` 仍 `快捷键放行给终端`(F 段已有,保持绿)。
6. 收尾断言 `!appLog.includes('未捕获异常')`。

### S6. 全量验证 + 提交

```
bun run typecheck && bun run test && bun run build
```
Windows 侧(先 `wsync sync`,D: 侧 `bun.exe run build`):
```
bun.exe D:/tmp/terminal-pane-e2e.mjs        # 含新 G 段,跑两遍
bun.exe D:/tmp/nested-split-e2e.mjs         # 47/47
bun.exe D:/tmp/terminal-e2e.mjs             # 21/21
bun.exe D:/tmp/terminal-clipboard-e2e.mjs   # 21/21
```
按仓库惯例提交:`feat(shortcuts): …` + `docs(plans): 记录…`(`.pi/plans/2026-09-19-terminal-split-keys/plan.md` 的 §8 实施记录)。

## 4. 风险 / 未知

- **xterm 的键盘钩子不影响这件事**:`before-input-event` 在主进程、早于页面 keydown;
  `onKey` 只在 `Ctrl+C/V` 上插手,不会把 `Ctrl+Shift+方向` 提前吃掉。无需改终端插件。
- **`Alt+Shift+方向` 的平台性**:Windows 上 `Alt+Shift` 是输入法切换键(按下再放开),带方向键时
  由 `before-input-event` 收到的 `input.alt/shift` 是否稳定,需要真机确认 —— 计划里已经用
  「普通网页窗格里同一个组合能 resize」当控制组:若那条也不动,问题就不在终端页的判据上。
- **`preventDefault` 是否真的让页面收不到 keydown**:tabShortcuts 注释与 `Ctrl+Shift+L` 的 E2E 都支持这一点,
  S5 的 `__seenKeys` 判据会当场证伪或证实(这是本次唯一需要真机确认的机制性假设)。
- **macOS 未验**:本机只有 Windows 侧能跑 node-pty E2E;`Cmd+Shift+方向` 走的是同一条 `matchSplitHotkey`
  (`control || meta`),但 `Alt(Meta?)+Shift+方向` 在 mac 上是否被系统占走不确定 —— 记进 §8 遗留。
- **可能被用户感知的代价**(已拍板接受):终端里 shell/vim/tmux 失去这两个组合;README/ARCHITECTURE 写清楚。
- 未做:渲染层「原始组合直通 shell」的逃生通道(问卷第三选项,本次不选);`Ctrl+R` 刷新在终端里的语义未动。

---

## 8. 实施记录(2026-09-19,已完成)

改动与 §3 计划一致,只有两处偏差:

1. `tabShortcuts.ts` 里写成 `internal: !!rec.info.internal`(`TabInfo.internal?: boolean` 是可选布尔,
   直接传会与 `SplitHotkeyTarget.internal: boolean` 不兼容)。纯类型层面的调整,行为不变。
2. `D:/tmp/nested-split-e2e.mjs` 第 11 段 `Ctrl+W` 那一步会在 `Input.dispatchKeyEvent` 上 CDP 超时
   (主进程当场关掉当前 webContents,应答永远不回来)——**既有问题**:`git stash` 掉本次改动、只留 HEAD
   重新 build 后同样复现。给这一处加了 try/catch(只吞那一条超时,后面的「标签数 -1」判据照旧),
   脚本随即跑完 **47/47**。与本次功能无关。

### 验证证据(Windows 侧真机)

- `bun run typecheck` 过;`bun run test` **39 文件 / 737 用例**(新增 5 例判据单测);`bun run build` 过。
- `D:/tmp/terminal-pane-e2e.mjs`(新增 G 段 12 项)**43/43 ×2**,关键实测:
  - `Ctrl+Shift+→`:主进程日志 `快捷键:分屏/调整大小 split right`,终端组 1 → 2 窗格、焦点落到新窗格;
  - `Alt+Shift+→`:日志 `… resize right`,终端窗格几何 **639 → 702**;
  - 终端页的捕获阶段 keydown 记录器里只有控制组的 `["ArrowRight"]` —— 两个带修饰的组合**一个都没进页面**
    (⇒ `preventDefault` 确实生效,xterm 没机会送进 pty);
  - 地址栏聚焦时同样的按键不接管(组结构不变、无分屏日志)。
- 回归:`terminal-e2e` **21/21**、`terminal-clipboard-e2e` **21/21**、`nested-split-e2e` **47/47**。

### 遗留

- **mac 未验**:`Cmd+Shift+方向` 走同一条 `matchSplitHotkey`,但 `Alt+Shift+方向` 在 mac 上是否被系统占用
  (Option+Shift+方向)没真机确认 —— 本机没有 mac 环境。
- `Alt+Shift` 在 Windows 上是输入法切换键:**单次** resize 已实测生效;**长按连续调整**(自动重复的 resize)
  没有专门验,也没验「按住 Alt+Shift 再按方向」与输入法切换的相互影响。
