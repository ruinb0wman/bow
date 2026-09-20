# 终端里 `Ctrl+Alt+字母` 到不了 pty(pi 的 `Ctrl+Alt+P` 切模式失效)

## 0. 目标

焦点在 `bow://terminal` 里时按 `Ctrl+Alt+P`,要能像 Windows Terminal 一样把键送给 pty ——
这样在 bow 的终端里跑 pi / 任何 TUI,`Ctrl+Alt+P` 都能收到(pi-agents 用它切 plan/build 模式)。

**一句话结论**:不是 bow 主进程吞的,也不是 conpty 丢的 —— 是 **xterm.js 在 Windows 上把
`Ctrl+Alt+<可打印键>` 一律当成 AltGr(第三级 shift)**,在 `CoreBrowserTerminal._keyDown()` 里
**送数据之前**就 `return true`,而它其实已经把该发的字节算好了(`ESC + 控制字符`)。

**已拍板(用户跳过了问卷,按推荐项执行)**:

- 修复路线 = **包住 xterm 的那条私有判据**(不是自己在 `attachCustomKeyEventHandler` 里编码);
  理由见 §3.4,与上游 orca 为同一 bug 的做法一致(PR #8810)。
- **不加**设置开关(AltGr 布局仍分不出来的问题留作已知边界,见 §6)。
- **不修 macOS**(`Ctrl+Option+字母` 是另一处原因:`evaluateKeyboardEvent` 在 mac 上就返回不了 key);
  本机没有 mac 真机,写进 README 的已知边界。

## 1. 为什么 Windows Terminal 里就行

WT 拿到的是 Win32 `KEY_EVENT_RECORD`,里面**自带这次按键翻译出来的字符** `uChar.UnicodeChar`,
于是它能用「这次组合到底能不能打出字」来区分 AltGr 与真组合 ——
`microsoft/terminal` 的 `src/terminal/input/terminalInput.cpp`(`HandleKey`):

```cpp
// We distinguish AltGr+Key / Ctrl+Alt+Key combinations on international keyboard layouts from
// genuine, intentional Ctrl+Alt+Key combinations by checking whether the codepoint is valid.
// Windows should not send a valid codepoint for e.g. Ctrl+Alt+Q on a US ANSI layout,
// so we treat it as a genuine Ctrl+Alt+Q.
//
// However, this isn't universally true and more of a heuristic. ...
key.altGrPressed = anyAltPressed && anyCtrlPressed && (key.codepoint > 0x20 && key.codepoint != 0x7f);
```

判成「不是 AltGr」之后走 legacy 文本键编码 ⇒ `Ctrl+Alt+P` 编成 `ESC + ^P`(`\x1b\x10`)进 pty
(WT 还额外用「按下 Ctrl 与右 Alt 的时间差 > 50ms」猜 AltGr 伪造的那个 LeftCtrl,信号比浏览器多)。

**bow 的终端没有这些信号**:它是网页里的 xterm.js,只能吃 Chromium 给的 DOM `KeyboardEvent`。
而 xterm 在这里用的是一条很钝的判据(`node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts`):

```ts
  private _isThirdLevelShift(browser: IBrowser, ev: KeyboardEvent): boolean {
    const thirdLevelKey =
      (browser.isMac && !this.options.macOptionIsMeta && ev.altKey && !ev.ctrlKey && !ev.metaKey) ||
      (browser.isWindows && ev.altKey && ev.ctrlKey && !ev.metaKey) ||   // ← 只要 alt+ctrl 就算 AltGr
      (browser.isWindows && ev.getModifierState('AltGraph'));
    ...
```

`_keyDown()` 里的顺序是「先算字节 → 再查第三级 shift → 第三级就直接 return」:

```ts
    const result = evaluateKeyboardEvent(event, ..., this.browser.isMac, this.options.macOptionIsMeta);   // 1057 行前:已算出 \x1b\x10
    ...
    if (this._isThirdLevelShift(this.browser, event)) {
      return true;                       // ← 1057-1059:数据在这里被丢掉,后面根本没执行
    }
    ...
    this.coreService.triggerDataEvent(result.key, true);   // 1092:真正送进 pty 的地方
```

Chromium 其实**给了**区分信号:`getModifierState('AltGraph')` 只在这套布局能把该组合变成字符时才置上
(Chromium 的 `ui/events/keycodes/platform_key_map_win.cc` 里 `ReplaceControlAndAltWithAltGraph`,
以及 2021 年 xterm PR #3432 为死键问题补的第三条判据)。xterm 补了第三条却把「只要 alt+ctrl」的老判据
留在原地 ⇒ 真组合永远进不了编码器。

**真机确认过**:在跑着的 bow(Windows 实例)里 `navigator.platform === "Win32"`,
所以 xterm 的 `isWindows` 为真、上面第二条判据必然命中。

xterm 算出来的 `ESC + \x10` 正是 pi 认的形式:
`@earendil-works/pi-tui/dist/keys.js` 里 `matchesKey()` 的 legacy 分支
(`modifier === ctrl+alt && !_kittyProtocolActive && data === '\x1b' + rawCtrl`),`parseKey()` 同样能解析。

## 2. 要改的文件

| 文件 | 改什么 |
| --- | --- |
| `src/plugins/terminal/shared.ts` | 新增纯判据 `isGenuineCtrlAltChord()` + 形状 `CtrlAltChordLike` |
| `src/plugins/terminal/ui/xtermCtrlAltChord.ts`(**新增**) | `installWindowsCtrlAltChordRepair(term)`:包住 xterm core 的 `_isThirdLevelShift`,返回是否装上 |
| `src/plugins/terminal/ui/TerminalView.vue` | `createTerminal()` 里装上;调试把手暴露 `ctrlAltRepaired` |
| `tests/terminalShared.test.ts` | 判据的用例表 + 安装函数的假 core 用例 |
| `README.md` | 终端那节「键位」补 `Ctrl+Alt` 的说明与已知边界(443-450 行那条) |
| `docs/ARCHITECTURE.md` | 「终端层(node-pty)」清单加第 25 条(现有 18-24 在 1076-1104 行) |
| `D:/tmp/terminal-ctrl-alt-e2e.mjs`(仓库外,不提交) | 新的 Windows 真机 E2E:A 判据装上 / B 渲染层字节 / C WSL 里 `cat -v` 看到 `^[^P` |

不动:`src/main/tabShortcuts.ts`、`src/shared/shortcuts.ts`、`src/preload/**`、`ipc.ts`、
终端插件主进程(`main.ts`)、node-pty 相关。

## 3. 设计

### 3.1 判据(纯逻辑,放 `shared.ts`)

```ts
/** 判定「真的是 Ctrl+Alt 组合」需要的字段(与 DOM `KeyboardEvent` 结构化兼容,便于单测) */
export interface CtrlAltChordLike {
  type: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  /** `ev.getModifierState('AltGraph')` —— 真实 AltGr 打字符时为 true */
  altGraph: boolean
  isComposing?: boolean
}

export function isGenuineCtrlAltChord(input: CtrlAltChordLike): boolean {
  if (input.type !== 'keydown') return false
  if (input.isComposing) return false
  return input.ctrlKey && input.altKey && !input.metaKey && !input.altGraph
}
```

### 3.2 包装函数(新增 `ui/xtermCtrlAltChord.ts`)

`import type { Terminal } from '@xterm/xterm'`(**只用类型**,运行时不需要 xterm,单测可在 node 环境跑):

```ts
interface ThirdLevelShiftCore {
  _isThirdLevelShift?(browser: unknown, ev: KeyboardEvent): boolean
}

/** 返回 true = 装上了(拿到内部判据);false = 没这个接缝,行为退化成现状(绝不发错字节) */
export function installWindowsCtrlAltChordRepair(term: Terminal): boolean {
  const core = (term as unknown as { _core?: ThirdLevelShiftCore })._core
  const original = core?._isThirdLevelShift
  if (!core || typeof original !== 'function') return false
  core._isThirdLevelShift = function (browser, ev: KeyboardEvent) {
    const win = (browser as { isWindows?: boolean } | undefined)?.isWindows === true
    if (win && isGenuineCtrlAltChord({ ...eventFieldsOf(ev) })) return false
    return original.call(this, browser, ev)
  }
  return true
}
```

要点:

- **只把判定从 true 削弱成 false**,永远不自己产出字节 ⇒ 字节仍由 xterm 的编码器给
  (legacy `ESC+控制字符`,以后 xterm 支持 kitty / win32-input-mode 也自动跟着正确)。
- 显式要求 `browser.isWindows === true`(意图即「撤销 Windows 上的误判」;mac/Linux 上原样透传)。
- 拿不到 `_core._isThirdLevelShift` 时返回 false,行为 = 今天(丢键),不会更坏。
- 已核对 6.0.0 的**产物**(`lib/xterm.mjs`,Vite 走 `module` 字段):`_isThirdLevelShift` 方法名与
  `._isThirdLevelShift(...)` 调用点都保留,`_core` 属性名也保留(未做属性名压缩)。

### 3.3 接线(`TerminalView.vue`)

`createTerminal()` 里 `term.open(host.value)` 之后:

```ts
ctrlAltRepaired = installWindowsCtrlAltChordRepair(term)
```

`exposeDebugHandle()` 加一个只读字段 `ctrlAltRepaired`(E2E 用它断言「接缝存在」)。

### 3.4 为什么不在 `attachCustomKeyEventHandler` 里自己编码

上游 orca 为同一个 bug 先写了自编码版本,评审后改掉了,理由是复刻编码器必然差几处:
kitty 协议下的 TUI 会收到 legacy 字节、`Ctrl+Alt+2` 会退化成 `Alt+2`、`Ctrl+Alt+[` 会变成裸 CSI 引导符、
按物理 `code` 取键在 Dvorak/Colemak 上错位、还会绕过 xterm 自己的 `stopPropagation`。
包装判据这条路把它们一次性都解决(顺带修好 `Ctrl+Alt+Shift`、数字、符号、F 键)。

## 4. 步骤(每步独立可验证)

1. **S1** `src/plugins/terminal/shared.ts` 加 `CtrlAltChordLike` + `isGenuineCtrlAltChord`。
   验证:`bun run typecheck`。
2. **S2** 新增 `src/plugins/terminal/ui/xtermCtrlAltChord.ts`(含文件头注释:为什么包私有判据、
   上游依据、失败模式)。验证:`bun run typecheck`。
3. **S3** `tests/terminalShared.test.ts` 两个 describe:
   - 判据表:真组合(⇢ true)/`altGraph: true`(⇢ false)/带 Meta/只有 Ctrl/只有 Alt/keyup/输入法组合(⇢ false);
   - 安装函数用**假 core**:`{ _core: { _isThirdLevelShift(b, ev){...} } }` 断言①真组合时返回 false 且**没有**调用原判据、
     ②AltGr 事件时原判据被调用且返回值透传、③`{}` / `{ _core: {} }` 时返回 false 且不抛。
   验证:`bun run test`(基线 43 文件 / 844 例,预期 +8~12 例)。
4. **S4** `TerminalView.vue` 装上并把 `ctrlAltRepaired` 加进调试把手。验证:`bun run build` + `bun run typecheck`。
5. **S5** 文档:`README.md` 终端「键位」那条 + `docs/ARCHITECTURE.md` 终端层清单加第 25 条。
6. **S6** 写 `D:/tmp/terminal-ctrl-alt-e2e.mjs`(照 `terminal-pane-e2e.mjs` 的脚手架:隔离 `--user-data-dir`、
   `--remote-debugging-port=9392`、`MCP_HTTP=0`),**先在未修版本上跑一遍拿到红测**,再装修复跑绿。

### E2E 段(A/B/C,都在 `bow://terminal` 里)

- **A 判据装上**:`__bowTerminal.ctrlAltRepaired === true`(接缝存在,不是静默退化)。
- **B 渲染层字节**(不依赖 shell 是什么):在终端页里挂
  `window.__dataSeen = []; window.__bowTerminal.term.onData(d => __dataSeen.push(d))`,
  然后 CDP `Input.dispatchKeyEvent{type:'rawKeyDown', modifiers: alt|ctrl, key:'P', code:'KeyP', windowsVirtualKeyCode:80}`:
  - 控制组 `Ctrl+P` ⇒ `__dataSeen` 出现 `'\x10'`(证明 xterm 的编码/发送通路活着);
  - 本题 `Ctrl+Alt+P` ⇒ 出现 `'\x1b\x10'`(**pre-fix:一条都没有** —— 这就是红测);
  - `Ctrl+Alt+Shift+P` ⇒ 也出现 `'\x1b\x10'`;
  - 反向用例:在 xterm 的 textarea 上派发**合成** keydown(`new KeyboardEvent('keydown',{ctrlKey:true,altKey:true,modifierAltGraph:true,...})`)
    ⇒ `__dataSeen` **不得**变长(证明 AltGr 那条安全阀没被误伤;CDP 没法设 AltGraph,只能用合成事件)。
- **C pty → shell 侧**:预先往隔离 profile 写 `<PROFILE>/terminal.json`,默认配置钉成
  `wsl.exe --cd ~`;`__bowTerminal.send('cat -v\r')` 后按 `Ctrl+Alt+P` 再按 Enter,
  断言 `bufferText()` 里出现 `^[^P`(字节真的走完了 conpty + WSL 这一路,而不是停在渲染层)。
  ⚠️ 若这台机器没有 `wsl.exe`,C 段降级为只跑 B 段并在脚本里打印原因。

## 5. 验证

- `bun run typecheck` / `bun run build`。
- `bun run test`(基线 **43 文件 / 844 例**,预期只增不减)。
- Windows 真机:`bun.exe D:\tmp\terminal-ctrl-alt-e2e.mjs` **先红后绿(B 段的 `\x1b\x10`)**。
- 回归:`terminal-pane-e2e.mjs`、`terminal-e2e.mjs`、`terminal-clipboard-e2e.mjs` 全绿(它们钉了
  `Ctrl+L` / `Ctrl+W` / `Ctrl+Shift+L` / 分屏键 / 复制粘贴,正是最容易被这次改动波及的行为)。
- 人工验一次:在 bow 的 WSL 终端里跑 pi,按 `Ctrl+Alt+P` 能切模式(用户环境,最终判据)。

## 6. 风险 / 未知

1. **AltGr 布局(德语/法语/波兰语…)**:Chromium 在这类布局下会给 Ctrl+Alt 组合置上 `AltGraph`,
   于是我们的判据不成立 ⇒ 真组合仍被吞(**维持现状,不是回归**)。这是 Windows 上 `Ctrl+Alt ≈ AltGr`
   的固有歧义,WT 用 codepoint、Chromium 用布局表,两边都只能猜。真需要的话后续加设置项
   (`Ctrl+Alt 组合:自动 / 总是送给 shell`),代价是那些布局下打不出 AltGr 字符。
2. **依赖 xterm 私有方法名** `_core._isThirdLevelShift`:`package.json` 是 `^6.0.0`,升级后若改名,
   安装函数返回 false ⇒ 静默退回今天的行为(不会发错字节)。已确认产物里方法名未被压缩。
   (可选加固:S3 里加一条读 `node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts` 的
   源码扫描用例,接缝消失时 CI 直接红 —— 若不想读 node_modules 就跳过。)
3. **macOS 仍不可用**(`Ctrl+Option+字母` 在 mac 分支的 `evaluateKeyboardEvent` 里就没有 key),
   写进 README 已知边界;要修得单独走自编码那条路(见 §3.4 的代价)。
4. **conpty/WSL 往返**:`\x1b\x10` 要经 Windows 侧 conpty → WSL pty 才到 pi。上游 orca 用真 conpty 探针
   验过 `ESC + Ctrl-U` 能让 Windows 侧程序看到 `Alt, Control`,理论上换 WSL 客户端也原样透传 legacy 序列;
   但**这一步只有 E2E 段 C 能证**(也可能是 B 段绿、C 段红,那就要回到 conpty 编码层再看)。

## 7. 相关文档

- `README.md` 终端「键位」(443-450):补一句 `Ctrl+Alt+字母` 现在会送进 pty(修 xterm 在 Windows 上
  把它当 AltGr 吞掉的坑),并写清 AltGr 布局/mac 两条边界。
- `docs/ARCHITECTURE.md` 终端层清单(1076-1104)加第 25 条:误判点在 xterm、我们在哪里包它、
  失败模式、以及「为什么不在 key handler 里自己编码」。

## 8. 实施记录(2026-09-20,已完成)

**改了什么(与 §2 的差异)**:

- `src/plugins/terminal/shared.ts`:加 `CtrlAltChordLike` + `isGenuineCtrlAltChord()`(纯判据)。
- `src/plugins/terminal/ui/xtermCtrlAltChord.ts`(新):`installWindowsCtrlAltChordRepair(term)` ——
  包住 `term._core._isThirdLevelShift`,只在 `isWindows && isGenuineCtrlAltChord(ev)` 时返回 `false`,
  否则 `original.call(this, browser, ev)`;拿不到接缝返回 `false`。
- `src/plugins/terminal/ui/TerminalView.vue`:`createTerminal()` 里装上;调试把手加 `ctrlAltRepaired`。
- `tests/terminalShared.test.ts`:判据 4 例 + 安装函数(假 core)4 例。
- **计划外的第 5 个文件**:`tests/xtermAltGrSeam.test.ts`(§6.2 里标为可选的「契约测试」,实际加了)。
  它扫 `node_modules/@xterm/xterm/lib/xterm.mjs`(Vite 走 `module` 字段,渲染层用的就是它),
  钉住 `_isThirdLevelShift(e,i){`、`._isThirdLevelShift(` 与 `this._core=` 三处名字 ——
  `^6.0.0` 升级若改了它们,补丁会静默退化成丢键,这条用例把「静默」变成 CI 红。
- `README.md` 终端「键位」补一段;`docs/ARCHITECTURE.md` 终端层清单加第 25 条。

**验证结果**:

- `bun run typecheck` / `bun run build` 过。
- `bun run test`:**44 文件 / 854 例**(基线 43 / 844,+8 判据与安装函数 +2 契约)。
- 新 E2E `D:\tmp\terminal-ctrl-alt-e2e.mjs`(Windows 侧隔离实例,默认配置钉成 WSL):
  **13/13 ×2**。核心判据实测:
  - `A ctrlAltRepaired === true`(接缝真的装上,不是静默退化);`navigator.platform = Win32`;
  - `B term.onData`:`Ctrl+P` → `["\u0010"]`(控制组,编码通路活着);`Ctrl+Alt+P` → 追加 `"\u001b\u0010"`;
    `Ctrl+Alt+Shift+P` → 同样 `"\u001b\u0010"`;合成 `modifierAltGraph:true` 的 Ctrl+Alt+P → **不产出字节**(安全阀没被误伤);
  - `C` WSL 侧 `cat -v` 缓冲里出现 `^[^P`(回显行与 cat 输出行都是 `^P^[^P^[^P`)⇒ 字节走完了 conpty + WSL;
  - `D` 捕获阶段 keydown 记录器收到 `P+ctrl+alt`(主进程没 preventDefault)、appLog 无「快捷键」行。
- **pre-fix 红测**:把 Windows 侧副本的安装那一行注释掉重新 build,**8/13** ——
  红的正好是 5 条 Ctrl+Alt 相关(A 的 repaired、B 的三条、C 的 `^[^P`),
  而「控制组 Ctrl+P → `\x10`」与「D 页面收到 keydown」仍 PASS ⇒
  证明**键确实到了页面、编码通路也活着,只有 Ctrl+Alt 组合被 xterm 吞掉**,红测不是空判据。
  跑完用 `wsync sync` 覆盖回修复版并重新 build。
- 回归:`terminal-e2e.mjs` **21/21**、`terminal-clipboard-e2e.mjs` **21/21**、`terminal-pane-e2e.mjs` **43/43**。

**踩到的坑(与本次改动无关,但以后跑 E2E 要注意)**:

- 从 WSL 侧用 `cmd.exe /c "bun.exe …"` **管道**读输出时,脚本最后的 `process.exit()` 会把还没刷出去的
  几行截掉 —— `terminal-e2e.mjs` 的「结果:21/21 通过」就这样没了(看起来像跑崩了)。
  改成 Windows 侧重定向到文件(`> D:\tmp\xxx.txt 2>&1`)再读就完整。以后跑 E2E 一律重定向。

**未做 / 待办**:

- AltGr 布局(德语/法语/波兰语…)与 macOS 的 `Ctrl+Option+字母` 都不在本次范围内(见 §6)。
- 用户真机验收:重启 bow 后(若 pi 就跑在 bow 的终端里,重启会一起关掉这个会话)在终端里按 `Ctrl+Alt+P`
  应当能切模式。

**下游那一半也真机对过了(2026-09-20,收尾复验)**:用**装在本机的那份 pi-tui**跑了一段探针
(`dist/keys.js` 的 `parseKey` / `matchesKey`),喂进 bow 现在产出的字节 `\x1b\x10`:

```
bytes              "1b 10"
parseKey           "ctrl+alt+p"
matchesKey(seq, 'ctrl+alt+p')  true    ← pi-agents 注册的就是这条
matchesKey(seq, 'ctrl+p')      false   ← 不会与 shell 的 Ctrl+P 混淆
matchesKey(seq, 'ctrl+alt+q')  false
```

⇒ 整条链路闭合:xterm 产出 `\x1b\x10`(E2E B)→ 穿过 conpty + WSL tty(E2E C 的 `^[^P`)
→ pi 解析成 `ctrl+alt+p`(本探针)。
