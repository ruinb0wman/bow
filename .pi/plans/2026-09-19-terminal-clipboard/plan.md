# 终端:Ctrl+C 复制 / 无选区则中断 + Ctrl+V 粘贴

> 2026-09-19 · 目标文件 `src/plugins/terminal/{shared.ts,ui/TerminalView.vue}` · 前置:`.pi/plans/2026-09-19-terminal-plugin/plan.md`(终端插件本体,已完成)

## 1. 目标

1. **`Ctrl+C`**:终端里有选中内容 → 复制到剪贴板(**不发给 shell**);没有选中 → 放行,xterm 照旧把 `\x03` 送进 pty,shell 发中断信号(SIGINT)。
2. **`Ctrl+V`**:粘贴剪贴板文本到终端(走 xterm 的 `paste()`,保留 bracketed paste 与换行归一)。
3. `Ctrl+Shift+C` / `Ctrl+Shift+V` 的既有行为**保持可用**(已写进 README,不能默默砍掉)。

## 2. 现状(读过的代码)

`src/plugins/terminal/ui/TerminalView.vue` 的键盘钩子只认带 Shift 的组合:

```ts
function onKey(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return true
  const mod = event.ctrlKey || event.metaKey
  if (!mod || !event.shiftKey) return true      // ← 不带 Shift 的直接放行
  if (event.code === 'KeyC') { … writeClipboardText(selection) … return false }
  if (event.code === 'KeyV') { … readClipboardText().then(t => term?.paste(t)) … return false }
  return true
}
```

所以现在 `Ctrl+C` 一律进 shell(有选区也不会复制),`Ctrl+V` 不是粘贴 —— 正是本次要改的。

### 2.1 两个必须处理的 xterm 行为(已从 `node_modules/@xterm/xterm/lib/xterm.js` 核实)

- **钩子返回 `false` 不会 `preventDefault`**:
  `_keyDown(e){if(this._keyDownHandled=!1,this._keyDownSeen=!0,this._customKeyEventHandler&&!1===this._customKeyEventHandler(e))return!1;…}`
  → 浏览器对 `keydown` 的**默认动作照旧执行**。`Ctrl+V` 的默认动作就是「往 textarea 原生粘贴」。
- **xterm 自己监听了 `paste`**(而且在两处):
  `…addDisposableListener(this.textarea,"paste",e)… , this.element,"paste",e …` → `paste(e){paste(e,this.textarea,this.coreService,…)}` → 直接写进 pty。

结论:钩子里若不 `preventDefault`,`Ctrl+V` 会**粘两次**(xterm 原生那条 + 我们 IPC 那条)。
⚠️ 这也意味着**现状的 `Ctrl+Shift+V` 早已有双份粘贴的隐患**(Chromium 里 `Ctrl+Shift+V` = 粘贴为纯文本,默认动作同样会触发),只是真机 E2E 从没测过粘贴,一直没被发现。本次顺手修掉。

### 2.2 平台差异

- `src/main/devtools.ts`:仅 darwin 安装 `{role:'editMenu'}` 菜单,darwin 上菜单加速键 `⌘C`/`⌘V` 可能**先被菜单吃掉**,渲染层收不到 `keydown`;Windows/Linux 是 `Menu.setApplicationMenu(null)`,按键直达页面。
- mac 上终端的惯例是 `⌘C` 复制、`Ctrl+C` 仍然是中断信号(bash/zsh 里 `Ctrl+V` 是 quoted-insert)。
- `src/main/ua.ts` 的 `bowUserAgent()` 只改 app/Electron 令牌,**平台段保留** → 渲染层可用 `navigator.userAgent` 判 mac。

## 3. 设计

### 3.1 键位表(改完后的行为)

| 按键 | 有选区 | 无选区 |
| --- | --- | --- |
| `Ctrl+C`(win/linux) | 复制,**不发** `\x03` | 放行 → `\x03` → SIGINT |
| `Ctrl+V`(win/linux) | 粘贴 | 粘贴(剪贴板为空则什么都不发) |
| `Ctrl+Shift+C` | 复制(强制复制路径) | 什么都不做(不会误发中断) |
| `Ctrl+Shift+V` | 粘贴 | 粘贴 |
| `⌘C` / `⌘V`(mac) | 复制 / 粘贴 | `⌘C` 复制空选区 = 无操作 |
| `Ctrl+C`(mac) | — | SIGINT(不接管) |
| 带 `Alt` 的任何组合 | 不接管(AltGr 在部分布局上等于 Ctrl+Alt) | 同左 |

### 3.2 判定逻辑放纯函数里(可单测)

`src/plugins/terminal/shared.ts` 追加(与文件既有风格一致:同构无依赖,单测直接跑):

```ts
export interface TerminalKeyLike {
  type: string
  key?: string      // 字符键(受 Shift/布局影响)
  code?: string     // 物理键('KeyC'),布局无关,优先
  ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean
}

export type TerminalClipboardIntent = 'copy' | 'copy-if-selection' | 'paste'

/** 主键字符:优先物理 code(AZERTY 下 key 可能是符号),退化用 key */
function clipboardKeyChar(input: TerminalKeyLike): string {
  const code = (input.code ?? '').toLowerCase()
  if (/^key[a-z]$/.test(code)) return code.slice(3)
  return (input.key ?? '').toLowerCase()
}

export function matchClipboardKey(input: TerminalKeyLike, isMac: boolean): TerminalClipboardIntent | null {
  if (input.type !== 'keydown') return null
  if (input.altKey) return null                      // AltGr 保护
  const primary = isMac ? input.metaKey : input.ctrlKey
  const shifted = input.shiftKey && (input.ctrlKey || input.metaKey)  // ⌃⇧C/⌃⇧V 老习惯
  if (!primary && !shifted) return null
  const key = clipboardKeyChar(input)
  if (key === 'c') return input.shiftKey ? 'copy' : 'copy-if-selection'
  if (key === 'v') return 'paste'
  return null
}
```

### 3.3 视图侧接线(`TerminalView.vue`)

```ts
/** mac 上复制粘贴用 ⌘(Ctrl+C 在 mac 上仍是中断) */
const IS_MAC = /Mac/i.test(navigator.userAgent)

function onKey(event: KeyboardEvent): boolean {
  const intent = matchClipboardKey(event, IS_MAC)
  if (!intent) return true
  // 必须自己 preventDefault:钩子返回 false 不会阻止浏览器默认动作,
  // 不拦的话 Ctrl+V 会被 xterm 自己的 textarea paste 监听再粘一次(双份)
  event.preventDefault()
  if (intent === 'paste') {
    void api.readClipboardText().then((text) => { if (text) term?.paste(text) })
    return false
  }
  const selection = term?.getSelection() ?? ''
  // Ctrl+C 且没有选区 = 不接管:xterm 会把它变成 \x03 送进 pty(SIGINT)
  if (!selection) return intent === 'copy-if-selection'
  void api.writeClipboardText(selection)
  return false
}

/**
 * 原生 copy 事件的兜底:菜单栏 / 右键的「复制」不走 keydown(菜单 role 会直接派发 copy 事件)。
 * xterm 的选区画在 canvas 上、不是 DOM 选区,浏览器默认复制不到,所以这里自己塞。
 */
function onNativeCopy(event: ClipboardEvent): void {
  const selection = term?.getSelection() ?? ''
  if (!selection) return
  event.preventDefault()
  event.clipboardData?.setData('text/plain', selection)
}
```

`onNativeCopy` 挂载/卸载:`term.open(host.value)` 之后 `host.value.addEventListener('copy', onNativeCopy)`,`onBeforeUnmount` 里移除(host 元素在整个页面生命周期内不变,`retry()` 也不需要重复挂)。

> 注意 `if (!selection) return intent === 'copy-if-selection'` 这行的语义:**`copy-if-selection` 返回 `true`(放行给 shell)**,`copy` 返回 `false`(吞掉,不改剪贴板)。

## 4. 步骤

| 步 | 文件 | 内容 | 独立判据 |
| --- | --- | --- | --- |
| S1 | `src/plugins/terminal/shared.ts` | 加 `TerminalKeyLike` / `TerminalClipboardIntent` / `matchClipboardKey`(§3.2) | `bun run typecheck` |
| S2 | `tests/terminalShared.test.ts` | 表驱动用例(§5.1) | `bun run test tests/terminalShared.test.ts` |
| S3 | `src/plugins/terminal/ui/TerminalView.vue` | 重写 `onKey`(含 `preventDefault`)+ `onNativeCopy` 挂载/卸载 | typecheck + 真机 E2E |
| S4 | `README.md`(+2 处)、`docs/ARCHITECTURE.md`(§13 终端层加第 22 条)、本计划追加实施记录 | 键位文档 + 「为什么不 preventDefault 会双份粘贴」这条坑 | 通读自查 |
| S5 | Windows 侧真机 E2E(§5.2) | 复制 / 中断 / 粘贴三次判定 | `21/21 + 6/6` 全绿 |

S3 与 S1/S2 无依赖顺序(纯函数先落地更容易验),但 S3 的 E2E 必须等 `bun run build`。

## 5. 验证

### 5.1 单测(`tests/terminalShared.test.ts`,约 14 例)

- 非 keydown / `type:'keyup'` → `null`
- win:`Ctrl+C` → `copy-if-selection`;`Ctrl+V` → `paste`;`Ctrl+Shift+C` → `copy`;`Ctrl+Shift+V` → `paste`
- win:单独的 `C` / `Shift+C` / `Ctrl+Z`(非 C/V)→ `null`
- mac:`⌘C` → `copy-if-selection`、`⌘V` → `paste`;**`Ctrl+C`(无 ⌘)→ `null`**(中断信号不被抢)
- mac:`⌃⇧C` / `⌃⇧V`(带 Shift)仍被认
- 两个平台:`Ctrl+Alt+C` / `AltGr` 形态 → `null`
- `code` 缺失(`'KeyC'` 用 `code`,缺了用 `key:'c'`)都能命中

### 5.2 真机 E2E(`D:/tmp/terminal-clipboard-e2e.mjs`,Windows 侧隔离 userData + CDP)

沿用既有脚本骨架(`--user-data-dir` 隔离 + `bun.exe` 跑;`__bowTerminal` 调试把手)。

1. **复制**:先 `writeClipboardText('SENTINEL')` → 终端 `echo COPY_PROBE_42` → `term.selectAll()` → CDP `Input.dispatchKeyEvent` 发 `Ctrl+C` → 剪贴板 = 含 `COPY_PROBE_42` 且**不含** `SENTINEL`;缓冲里**没有新增 `^C`**(说明没被当成中断)。
2. **无选区 = 中断**:`term.clearSelection()` + 剪贴板哨兵 → 发 `Start-Sleep -Seconds 20; Write-Output "SLEPT_OUT"` → 1s 后 Ctrl+C → 数秒内 `SLEPT_OUT` **不出现**(命令被打断)、剪贴板仍是哨兵(没被复制覆盖)、再发一条带标记的 `echo` 仍能回显(shell 还活着)。
3. **粘贴**:剪贴板 ← `Write-Output "PASTED_OK_7"` → Ctrl+V → 该命令文本出现**且只出现一次**(这是「双份粘贴」的判据)→ 回车 → 输出行再出现一次 ⇒ 粘贴真的到了 pty。
4. **原生 copy 事件**(菜单/右键路径):CDP 里 `new ClipboardEvent('copy', {clipboardData: new DataTransfer()})` 派发到 `.terminal-host` → `getData('text/plain')` = xterm 选区。
5. **回归**:`Ctrl+Shift+C` / `Ctrl+Shift+V` 各跑一次(同一套意图,真机确认过一次即可)。

## 6. 风险 / 未知

1. **CDP 注入的按键能不能进 xterm 的自定义钩子**:能 —— 它是普通 DOM `keydown`(之前「验不了」的是**主进程** `before-input-event`,不是渲染层)。若实测不行,退化方案:在页面里对 textarea 派发合成 `KeyboardEvent`,代码路径相同(E2E 判据不变)。
2. **PowerShell 5.1 的 `^C` 回显不可靠** → 判据 2 用 `Start-Sleep …; Write-Output` 标记法,不依赖 `^C` 是否出现在缓冲里。
3. **mac 未实测**:dev 模式下 darwin 有 `editMenu`,菜单加速键可能吃掉 `⌘C`/`⌘V`。复制这条已由 `onNativeCopy`(copy 事件)兜住;粘贴若被菜单吃掉,会走 xterm 自己的 textarea `paste` 路径(一样能粘)。计划里标注为**未在真机验证**。
4. **行为变更**:bash/zsh 里 `Ctrl+V` 原本是 quoted-insert(读作「下一个键取字面量」),现在被粘贴占用 —— 用户明确要求,文档里写明。
5. `term.paste()` 会走 `onData → invoke('write')`,与手工输入的路径完全一致;不引入新的 IPC 通道(仍用既有 `clipboard:read-text` / `write-text`)。

## 7. 不做的事

- 不接管 `Ctrl+Insert` / `Shift+Insert`(Windows 控制台惯例)与 Linux 中键粘贴(xterm 自己处理)。
- 不做右键菜单;不加设置项(键位固定)。
- 不改主进程 `before-input-event`(终端里 `Ctrl+C`/`Ctrl+V` 本来就没被拦,`Ctrl+W`/`Ctrl+L` 的放行逻辑不动)。

---

## 8. 实施记录(2026-09-19)

### 8.1 落地

按计划完成,无设计变更:

| 文件 | 改动 |
| --- | --- |
| `src/plugins/terminal/shared.ts` | + `TerminalKeyLike` / `TerminalClipboardIntent` / `matchClipboardKey(input, isMac)` |
| `src/plugins/terminal/ui/TerminalView.vue` | `onKey` 重写(用 `matchClipboardKey` + **自己 `preventDefault`**);新增 `onNativeCopy` 并在 `.terminal-host` 上挂载/卸载;`IS_MAC` 由 `navigator.userAgent` 判定 |
| `tests/terminalShared.test.ts` | +11 例(两平台 × 各组合 + Alt 保护 + 非 keydown + `code` 缺失兜底),28 → **39** |
| `README.md` | 「手动使用快捷键」与「终端」两处的键位说明 |
| `docs/ARCHITECTURE.md` | §13 终端层新增第 22 条;测试基线 681 → **692**(§1 与 §11 三处) |

### 8.2 验证结果

- `bun run typecheck` 通过;`bun run test` → **39 文件 / 692 用例全绿**(+11)。
- **新 E2E**(`D:/tmp/terminal-clipboard-e2e.mjs`,Windows 侧隔离 userData + CDP)**21/21,跑两遍**:

  | 组 | 判据 |
  | --- | --- |
  | A 有选区 Ctrl+C | 剪贴板换成选区(226 字符,哨兵被覆盖);缓冲 `^C` 数不变且长度不变 ⇒ 没被当成中断 |
  | B 无选区 Ctrl+C | 剪贴板仍是哨兵(没走复制);缓冲出现 `^C`;`Start-Sleep 20` 被真打断(`SLEPT_OUT` 永不出现、新命令立刻回显);中断后 shell 可用 |
  | C Ctrl+V | 粘贴文本**恰好出现 1 次**(双份粘贴的判据);回车后输出标记出现 ⇒ 真的进了 pty;另断言 keydown 的 `defaultPrevented === true`(机制:原生粘贴那条路被压掉) |
  | D 原生 copy 事件 | `DataTransfer` 拿到 501 字符含标记且 `defaultPrevented === true`;**无选区时不接管** |
  | E 回归 | `Ctrl+Shift+C` 复制、`Ctrl+Shift+V` 单份粘贴并执行、`Ctrl+Alt+C` 不接管(AltGr 保护) |

- **回归**:既有 `D:/tmp/terminal-e2e.mjs` 仍 **21/21**(键位改动没破坏 attach/写入/字号/回收)。
- 未重跑 `npm run dist`:本次无新增依赖、无打包配置改动(纯 renderer 侧)。

### 8.3 与计划的偏差与新增发现

1. **E2E 首轮 20/21,失败的是测试时序不是产品**:判据里“打断后立刻发下一条命令”整行被吃掉 ——
   Windows PowerShell 的 ConsoleHost 处理 Ctrl+C 时**会冲掉控制台输入缓冲**。改成先 `waitFor` 中断回显落定、
   再发下一条,⇒ 21/21。(同一原因也解释了两个“同一步骤内连续发送”的用例为何有时看着像没反应。)
2. **`^C` 回显实际可用**:探针实测 PowerShell 5.1 在空闲提示符上按 Ctrl+C 确实会输出 `^C`,
   所以中断判据从“计数 `^C`”用上了(比计划里的标记法更直接);标记法(`SLEPT_OUT` 不出现)仍保留作交叉验证。
3. **双份粘贴从“推算”变成“可判据”**:xterm 的 `_keyDown` 在钩子返回 `false` 时直接 `return !1`(不 `preventDefault`),
   而 `Ctrl+V` 的默认动作是原生粘贴、xterm 又在 textarea 与 element 上都挂了 `paste` 监听 ——
   机制层面成立;但因为旧实现已被替换,无法回到旧行为直接实测“粘两份”,
   所以 E2E 用两个可验证的替代判据:① 真机 Ctrl+V / Ctrl+Shift+V 都只粘 1 次;② 合成 keydown 后 `defaultPrevented === true`。

### 8.4 仍未验证(mac / 观感)

- **mac 全程未跑**(没真机):`⌘C`/`⌘V` 路径、以及 dev 模式下 `editMenu` 菜单加速键是否会吃掉 `⌘V`。
  逻辑上:复制由原生 `copy` 事件兼底(已真机验过这条机制,Windows 侧同样可触发),
  粘贴即使被菜单吃掉也会走 xterm 自己的 textarea `paste` 路径(行为一样)。
- 多行/宽字符粘贴的**观感**(括号粘贴是否被 shell 识别)、以及大段粘贴的性能。
- `Ctrl+V` 占用后,bash/zsh 里的 quoted-insert 不再可用(已知取舍,已写进 README)。

