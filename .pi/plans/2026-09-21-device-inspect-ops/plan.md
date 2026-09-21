# 手机 DevTools 窗格里分屏 + 让 LLM 能「操作 + 观测」手机页面

> 状态:**已实施**(2026-09-21),见 §10;真机验证待用户跑(§8)。
> 本计划写作时**不写代码**,只描述改动与验证步骤;§10 是实施后的回填。
> 依据全部来自直接读源码(每条都带 文件:行);真机行为标为「待真机」的都不当作已成立的事实。

## 0. 目标与结论

**第一问(用户原话)**:「手机调试窗口 devtools 阻止了分屏吗?」

**答:是 —— 但挡住的不是 DevTools 这个页面,而是 bow 自己的快捷键判据。**
`shouldTakeSplitHotkey()`(`src/shared/shortcuts.ts:175`)对「内部页面」一律不接管分屏键,
而设备检查插件打开的 DevTools 前端标签正是 `internal: true` + `internalPageId: null`
(`src/main/tabManager.ts:329-333` 写入、`:333` 的 `internalId: null`),于是焦点在那个窗格里按
`Ctrl+Shift+方向` / `Alt+Shift+方向` 时 bow 既不 `preventDefault` 也不分屏,按键被原样送进 DevTools 前端
(它只会拿去做按词选择,不会分屏)。
而 `splitFocused()` / `resizeFocused()` 本身对窗格种类**没有任何限制**,`groups:split` IPC 也没有判据
(`src/main/ipc.ts:103-110`)—— 也就是说这条限制只存在于「键盘入口」这一个点上。

顺带说明为什么「先分屏再把 DevTools 拖进那个窗格」也不行:分屏面板只有 聚焦/保存/套用/取消分屏
(`src/renderer/src/components/SplitMenu.vue`),全仓库没有跨组移动标签的能力(`shared/groups.ts` 只有
`splitGroup` / `replaceTabInGroups` / `removeTabFromGroups` / `ungroup`),而 `createInspectorTab()`
一律 `insertNewGroup(id)`(`src/main/tabManager.ts:333` 附近)—— 所以今天**确实没有任何一条路**能把手机
DevTools 放进一个分屏窗格。

**第二问**:让 MCP 能「操作和调试手机应用」。

今天的手机工具面只有 列目标 / 开 DevTools 前端 / `Runtime.evaluate` / 截图 / `adb connect`
(`src/plugins/device-inspect/main.ts:441-560`),LLM 想点一下只能自己写
`document.querySelector(...).click()` —— 那是**脚本合成事件**(`isTrusted: false`,不产生 touch/gesture,
不进焦点链路),而且每次都要手写查询表达式。本轮补上「真事件输入 + 元素快照 + 日志观测」三层。

**本轮范围(用户 2026-09-21 拍板)**

| 决策 | 选择 | 不做 |
| --- | --- | --- |
| 分屏入口 | **只改快捷键判据**(让 DevTools 窗格也吃 `Ctrl+Shift+方向` / `Alt+Shift+方向`) | 分屏面板加方向按钮、`device_inspect` 直接分屏打开 |
| MCP 能力 | **CDP 层**:点击/输入/按键/滚动 + 元素快照 + console/异常观测 | adb 原生层(坐标 tap / text / logcat / 整机截图) |
| 验证 | 先自动化(`typecheck` / `build` / `vitest` / 假 CDP 服务端 + 假 adb) | 真机回归由用户跑(清单见 §8) |

**假设**(若与你的实际需求不符请说):

1. 「在手机调试页面分屏」= 让手机 DevTools 自己占一个窗格,旁边开别的窗格(典型是
   `bow://terminal` 跑 pi,人看 DevTools、AI 操作手机),不是「把手机屏幕镜像进 bow」。
2. 本轮 MCP 只作用于 **CDP 可达的目标**(Android WebView / Chrome 页面);非 WebView 的原生 App 界面
   不在本轮(需要 adb `input` / `logcat`,见 §7)。

---

## 1. 取证:分屏被挡在哪一行

`src/shared/shortcuts.ts:163-178`(现状原文):

```ts
export interface SplitHotkeyTarget {
  internal: boolean          // TabInfo.internal
  internalPageId: InternalPageId | null   // TabRecord.internalId
}
…
 * - 设置页、DevTools 前端标签(inspector):不接管(它们自己的文本选择 / 前端快捷键要留着);
export function shouldTakeSplitHotkey(target: SplitHotkeyTarget | null): boolean {
  if (!target) return false
  return !target.internal || target.internalPageId === 'terminal'
}
```

- 判据只看 `internal` + `internalPageId`;DevTools 前端标签是 `internal: true` /
  `internalPageId === null`,落进「不接管」。
- 唯一调用点 `src/main/tabShortcuts.ts:178-193`(命中时才 `preventDefault` → `splitFocused` / `resizeFocused`)。
- `tests/shortcuts.test.ts:407` 已经**显式钉住**了这个行为:
  `it('DevTools 前端标签(internal=true 但没有内部页 id)→ 不接管')` —— 改判据必须同时改这条测试,
  否则红了也说不清是回归还是预期变更。
- 与 logseq 页的区别要保住:笔记页也不接管,但它是**页面自己**调 `splitPane` IPC
  (`src/plugins/logseq/ui/JournalView.vue:914`,文档在 `docs/ARCHITECTURE.md:754-757`)。DevTools 前端
  **没有** preload(`src/main/tabManager.ts:311-320` 的 webPreferences 里没有 `preload`),页面自己调不了
  IPC —— 所以只能由主进程接管,和终端页同一条理由。

---

## 2. 文件清单与改动点

### A. 分屏(3 个文件)

| 文件 | 现状(读到的代码) | 改什么 |
| --- | --- | --- |
| `src/shared/shortcuts.ts` | `SplitHotkeyTarget` 只有 `internal` / `internalPageId`;`shouldTakeSplitHotkey` 见上 | ① 加字段 `inspector: boolean`(来源 `TabInfo.inspector`,`@shared/types.ts:17`);② 判据改成 `if (target.inspector) return true` 优先于 internal 那条;③ 注释改成「DevTools 前端标签也接管」并写清代价 |
| `src/main/tabShortcuts.ts` | `:178-193` 只传 `{ internal, internalPageId }` | 传 `inspector: !!rec.info.inspector`;注释同步 |
| `tests/shortcuts.test.ts` | `:393-413` 五条用例 | 4 条已有用例补 `inspector: false`;新增 1 条「inspector → 接管」 |

### B. MCP(7 个文件,其中 2 个新增)

| 文件 | 现状 | 改什么 |
| --- | --- | --- |
| `src/main/actions.ts` | `:36-138` 里 `SNAPSHOT_FN` / `CLICK_FN` / `TYPE_FN` / `SCROLL_FN` 四个注入脚本字符串(未导出) | **纯搬移**:四个字符串搬到新文件 `src/main/pageScripts.ts` 并导出,本文件 import 回来(行为不变)。理由见 §2.1 |
| `src/main/pageScripts.ts`(**新**) | — | 四个脚本字符串的唯一来源(纯字符串、不 import electron → 插件与单测都能用) |
| `src/plugins/device-inspect/scripts.ts`(**新**) | — | 设备专属注入脚本:`POINT_FN`(选择器 → 视口中心坐标,先 `scrollIntoView`)、`FOCUS_FN`(聚焦 + 可选全选/清空,用于 `Input.insertText`) |
| `src/plugins/device-inspect/shared.ts` | 纯逻辑:adb 输出解析 / 目标改写 / 前端 URL / 提示文案(776 行) | 加纯函数:`resolveCdpKey()`(键名 → `Input.dispatchKeyEvent` 参数表)、`consoleEntryOf()` / `exceptionEntryOf()` / `logEntryOf()`(CDP 事件 → 归一化日志条目)、`stringifyRemoteObject()`;加 `ConsoleEntry` / `CdpKeySpec` 类型 |
| `src/plugins/device-inspect/cdp.ts` | 最小 CDP 客户端:只有 `send` / `close`,**事件通知被丢弃**(`:85` 的 `if (typeof message.id !== 'number') return`);只有 `cdpEvaluate` / `cdpScreenshot` | ① 客户端加事件订阅 `on(method, cb)`(id 缺失的消息派发给订阅者);② 新增 `cdpSnapshot` / `cdpTap` / `cdpType` / `cdpPressKey` / `cdpScroll` / `cdpConsole` |
| `src/plugins/device-inspect/main.ts` | `:441-560` 五个 `context.mcp.tool(...)`;`:320` 的 `withCdp()` 已经统一「连一下→发命令→必断开」 | 注册 6 个新工具(一条 `withCdp` 一个);`manifest.description` 补「并给 AI 操作/观测用的 device_* 工具」 |
| `src/main/mcp.ts` | `MCP_INSTRUCTIONS:44-110` 的「手机调试(device_*)」一节只讲了 eval/screenshot/list/inspect | 补工具选型与工作流(§3 步骤 9 有草案);`CORE_MCP_TOOL_NAMES` **不动**(新工具是插件工具) |

### 2.1 为什么把四个注入脚本搬出 `actions.ts`

- 手机上的 `device_snapshot` 想要的形状与 `browser_snapshot` **完全一致**(`{title,url,elements[]}`,
  `@shared/types.ts` 的 `PageSnapshot`),`selector` 也必须同一种算法 —— 否则 LLM 学到的经验不通用。
  这是仓库反复写死的原则:「同一个事实只能有一份」(见 `src/shared/devtools.ts` 顶部注释)。
- 但 `cdp.ts` 是**不 import electron** 的 I/O 层(`tests/deviceInspectCdp.test.ts` 在纯 node 环境下跑真
  TCP/WS),而 `actions.ts` → `logger.ts` → `import { app } from 'electron'` 是运行时依赖 ⇒ 直接
  `import { SNAPSHOT_FN } from '../../main/actions'` 会让那个单测炸在 `electron` 上。
- 所以搬到一个**无 electron 的纯字符串模块**。这不是为了好看:`src/plugins/element-fullscreen/scripts.ts`
  已经是同款约定(插件目录下 `scripts.ts` 放注入脚本),`tsconfig.node.json` 的 include 里
  `src/plugins/*/scripts.ts` 与 `src/main/**/*` 都已覆盖,**无需改 tsconfig**。

---

## 3. 实施步骤

每条都标了「改哪些文件」与「怎么验」,顺序即依赖顺序。

### 步骤 1:A 的判据(纯函数)

- 文件:`src/shared/shortcuts.ts`。
- 目标代码形状:

```ts
export interface SplitHotkeyTarget {
  internal: boolean
  internalPageId: InternalPageId | null
  /** 远程调试的 DevTools 前端标签(`TabInfo.inspector`):同为内部页面,但分屏键归浏览器 */
  inspector: boolean
}

export function shouldTakeSplitHotkey(target: SplitHotkeyTarget | null): boolean {
  if (!target) return false
  if (target.inspector) return true        // 手机调试窗格:页面里没有 preload,自己调不了 IPC
  return !target.internal || target.internalPageId === 'terminal'
}
```

- 验:`bun run test tests/shortcuts.test.ts`(步骤 3 一起跑)。

### 步骤 2:接上调用点

- 文件:`src/main/tabShortcuts.ts`(`:178-193`),加 `inspector: !!rec.info.inspector`,注释里把
  「地址栏 / 设置页 / DevTools 前端」改成「地址栏 / 设置页」并写明 DevTools 前端现在的代价。

### 步骤 3:钉住新判据

- 文件:`tests/shortcuts.test.ts`(`:393-413`):4 条已有用例补 `inspector: false`;新增:
  `it('DevTools 前端标签(inspector)→ 接管(否则手机调试窗格里分不了屏)')` → `true`。
- 验:`bun run test tests/shortcuts.test.ts`。

**手动验收(A 的部分)**:真机 bow 里打开一个手机目标的 DevTools 前端 → 焦点落在该窗格 → 按
`Ctrl+Shift+→` → 应立刻出现「DevTools | 空白」两窗格(空白窗格聚焦);再 `Ctrl+L` 输 `bow://terminal`
(或 `Ctrl+Shift+E`)得到「手机 DevTools | 终端」。`Alt+Shift+方向` 能把分隔条推来推去。
回归:**设置页**里按同一组合仍应是「不接管」(输入框的按词选择还在)。

### 步骤 4:抽出注入脚本(纯搬移,零行为变更)

- 新文件 `src/main/pageScripts.ts`:`SNAPSHOT_FN` / `CLICK_FN` / `TYPE_FN` / `SCROLL_FN`(逐字搬,
  不改一个字符)+ 顶部注释写明「唯一来源:main/actions.ts 与设备检查插件的 CDP 注入共用」。
- `src/main/actions.ts`:删掉四个常量,改 `import { CLICK_FN, SCROLL_FN, SNAPSHOT_FN, TYPE_FN } from './pageScripts'`。
- 验:`bun run test tests/mcpServer.test.ts`(snapshot/click/type/scroll 四条路径都有用例)+ `bun run typecheck`。

### 步骤 5:纯逻辑(键位表 + 日志归一化)

- 文件:`src/plugins/device-inspect/shared.ts`。
- `resolveCdpKey(key: string): CdpKeySpec | null`,键名沿用核心 `browser_press_key` 的写法
  (`src/main/actions.ts:220-248` 的别名表:enter/return/tab/escape/esc/space/backspace/delete/up/down/left/right/home/end/pageup/pagedown)。
  返回 `{ key, code, windowsVirtualKeyCode, text? }`,取值对齐 Puppeteer 的 US 键位表
  (`Enter → {key:'Enter', code:'Enter', keyCode:13, text:'\r'}`、`Tab → 9`、`Escape → 27`、
  `Backspace → 8`、`Delete → 46`、`ArrowUp/Down/Left/Right → 38/40/37/39`);不认识 → `null`。
- `stringifyRemoteObject(raw)`:CDP `RemoteObject` → 短字符串(`value` / `unserializableValue` /
  `description` / `preview.properties` 兜底,长度上限 500,超出加 `…`)。
- `consoleEntryOf` / `exceptionEntryOf` / `logEntryOf` → `ConsoleEntry { source: 'console'|'exception'|'log',
  level: string, text: string, url?, line?, timestamp, stack? }`。
- 验:`tests/deviceInspect.test.ts` 加用例(键位表逐项 + 三种事件 + 超长截断 + 怪输入不抛)。

### 步骤 6:CDP 客户端:事件订阅 + 6 个操作

- 文件:`src/plugins/device-inspect/cdp.ts`。
- **事件订阅**(向后兼容,现有测试只解构 `send`/`close`):

```ts
export interface CdpClient {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  /** 订阅事件通知(如 Runtime.consoleAPICalled);返回取消订阅。订阅前到达的事件会被丢弃 */
  on(method: string, cb: (params: Record<string, unknown>) => void): () => void
  close(): void
}
```

  实现:`onmessage` 里 `typeof message.id !== 'number'` 的那一支不再直接 return,而是按 `message.method`
  查订阅表派发(`:85`)。
- 新函数(全部返回 `{ok:true,…} | {ok:false,error}` 风格,与 `cdpEvaluate` 一致):
  - `cdpSnapshot(client, maxElements)`:`Runtime.evaluate` 跑 `(${SNAPSHOT_FN})(maxElements)`
    (`returnByValue: true`),用现成的 `readEvalOutcome()` 解析 → `{ok, data: PageSnapshot}`。
  - `cdpTap(client, { selector?, x?, y?, mode = 'touch' })`:
    ① `selector` → `Runtime.evaluate` 跑 `POINT_FN` 拿视口中心点(先 `scrollIntoView({block:'center',inline:'center'})`);
    ② `mode==='touch'`:`Input.dispatchTouchEvent` `touchStart` → `touchEnd`(同一组 `touchPoints:{x,y,radiusX:1,radiusY:1,force:1,id:1}`);
    ③ 若 ② 报错 → `Emulation.setTouchEmulationEnabled({enabled:true, maxTouchPoints:5})` 后重试一次(见 §6 风险 2);
    ④ 再失败或 `mode==='mouse'` → `Input.dispatchMouseEvent` `mousePressed` + `mouseReleased`
    (`button:'left'`, `clickCount:1`)。
    返回实际生效的 `mode` 与坐标,LLM 据此判断走的是哪条路。
  - `cdpType(client, { selector?, text, clear = true })`:`Runtime.evaluate` 跑 `FOCUS_FN`
    (聚焦 + `clear` 时全选:input/textarea 用 `el.select()`,contenteditable 用 Range 覆盖全部内容)
    → `Input.insertText({text})`(**insertText 替换当前选区**,所以 clear 不需要单独的清空事件)
    → 再 `Runtime.evaluate` 读回 `activeElement` 的 `value`/`textContent` → `{ok, value}`。
    走 IME 插入路径而不是直接改 `.value`,是为了让 React/Vue 受控输入与 `input`/`beforeinput` 监听器
    都收到 `isTrusted` 的事件(核心 `TYPE_FN` 是逐字符 `setter` + 手工派发,手机上不够真)。
  - `cdpPressKey(client, key)`:`resolveCdpKey` → `Input.dispatchKeyEvent` `keyDown`(有 `text` 的键)/`rawKeyDown`(方向键等)+ `keyUp`(与 Puppeteer 同一套:有 `text` 用 `keyDown`,否则 `rawKeyDown`)。
  - `cdpScroll(client, { selector?, direction, amount? })`:`Runtime.evaluate` 跑 `(${SCROLL_FN})(sel,direction,amount)` —— 与核心 `browser_scroll` 同一份脚本、同一套语义(方向/步长/返回 `top`)。
  - `cdpConsole(client, { durationMs = 800, reload = false, maxEntries = 100 })`:
    `on('Runtime.consoleAPICalled'|'Runtime.exceptionThrown'|'Log.entryAdded')` 订阅 → `Runtime.enable` / `Log.enable`(单个失败只记日志,不影响另一个)→ 可选 `Page.enable` + `Page.reload` →
    等 `durationMs` → 取消订阅 → `{ok, entries: entries.slice(0, maxEntries), truncated}`。
- 验:`tests/deviceInspectCdp.test.ts`(步骤 6 的测试见 §4)。

### 步骤 7:设备专属注入脚本

- 新文件:`src/plugins/device-inspect/scripts.ts`,两个字符串常量(用 `String.raw`,不用反引号插值 ——
  与 `element-fullscreen/scripts.ts` 同款写法):
  - `POINT_FN`:见步骤 6;元素尺寸为 0 / 找不到 → 返回 `{error}`(交给上层提升为失败)。
  - `FOCUS_FN(sel, clear)`:非可输入元素 → `{error}`(文案与核心 `TYPE_FN` 的「目标不是可输入元素」对齐);
    返回 `{selector, cleared, readback}`。

### 步骤 8:注册 6 个 MCP 工具

- 文件:`src/plugins/device-inspect/main.ts`(插入位置:`device_eval` / `device_screenshot` 之后,
  `device_connect` 之前),一律经现成的 `withCdp()` + `pickTarget()`(`targetKey` 省略时只在「恰好一个目标」
  生效,否则报错要求显式指定 —— 与现有工具一致):

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `device_snapshot` | `targetKey?, maxElements?=200` | `{ok, targetKey, data:{title,url,elements[]}}` |
| `device_tap` | `targetKey?, selector?, x?, y?, mode?: 'touch'\|'mouse'` | `{ok, targetKey, mode, x, y, selector?}`;`selector` 与 `(x,y)` 二选一,都给或都不给 → 失败并回显两种用法 |
| `device_type` | `targetKey?, selector?, text`(必填), `clear?=true` | `{ok, targetKey, typed, value}` |
| `device_press_key` | `targetKey?, key`(必填) | `{ok, targetKey, pressed}`;不认识的键 → 失败 |
| `device_scroll` | `targetKey?, selector?, direction`, `amount?` | `{ok, targetKey, top, direction}` |
| `device_console` | `targetKey?, durationMs?=800`(夹到 ≤10000), `reload?=false`, `maxEntries?=100` | `{ok, targetKey, durationMs, entries[], truncated}` |

- 工具描述里必须写死的三条(否则 LLM 会误用):
  1. 这些作用于**手机上的页面**,不是 bow 的标签页(与 `browser_*` 对照);
  2. `device_console` **只捕获调用期间**的日志(默认 800ms);要看加载期日志传 `reload: true`;
  3. `device_tap` / `device_type` 发的是**真输入事件**,失败时可用 `device_eval` 兜底,但优先用真事件。
- 验:`bun run typecheck` + `bun run build`;真机部分见 §8。

### 步骤 9:`MCP_INSTRUCTIONS`(LLM 的行为契约)

- 文件:`src/main/mcp.ts:44-110` 的「手机调试(device_*)」小节扩成:

```
- 工作流:device_list_targets 拿 targetKey → device_snapshot 拿元素与 selector →
  device_tap / device_type 操作用它返回的 selector(不要自己猜 CSS 选择器)。
- 取值仍优先 device_eval(最省 token);判断视觉效果用 device_screenshot(截的是手机屏幕,不是 bow 的标签)。
- 控制台/未捕获异常用 device_console;它只覆盖调用窗口(默认 800ms),要看页面加载期的日志传 reload: true。
- device_tap 默认发触摸事件(mode:'touch'),目标不认时改 mode:'mouse'。
```

### 步骤 10:冒烟脚本(不需要真机的那一半)

- 文件:`scripts/mcp-smoke.mjs:92-96` 附近,加 `assert(names.includes('device_snapshot') …)` 一类断言,
  与既有 `browser_wait` / `browser_add_bookmark` / `adblock_stats` 的写法一致(只验工具**在册**;
  真机行为不在冒烟里)。
- 验:`bun run build && bun run test:mcp`(需要图形环境;按仓库既有提示,沙箱里跑不了就在沙箱外跑)。

### 步骤 11:文档同步

| 文件 | 位置 | 改什么 |
| --- | --- | --- |
| `README.md` | `:300-331` MCP 工具表 | 加 6 行 `device_*` |
| `README.md` | `:656-690` 设备检查插件小节 | 补一句「AI 侧不止 eval/截图:还有快照 / 点击 / 输入 / 按键 / 滚动 / 日志」 |
| `README.md` | `:370-373`、`:425-427` | 分屏键的「不接管」清单里去掉 DevTools 前端,写清代价(DevTools 内部的按词选择让位) |
| `docs/ARCHITECTURE.md` | `:29-105` §1 目录地图 | 加 `main/pageScripts.ts`;设备检查行加 `scripts.ts` |
| `docs/ARCHITECTURE.md` | `:493` §5.8 贡献矩阵 | device-inspect 的 MCP 工具列成 11 个 |
| `docs/ARCHITECTURE.md` | `:586-596` §6.2 | 插件工具 17 → **23**、合计 36 → **42**;工具调用点的 file:line 全部按改后重数;补「插件工具的 schema 不做 strict」这条仍然成立 |
| `docs/ARCHITECTURE.md` | `:747-757` §7.2 | 分屏键的接管范围改成「普通网页标签 / 终端页 / **DevTools 前端标签(inspector)**」并解释为什么(没有 preload,页面自己调不了 IPC) |
| `docs/ARCHITECTURE.md` | `:105` §1 末尾 | 顺手把「tests/ 43 个测试文件(838 个用例)」改成改后的实测值(这一行本来就已经漂了) |
| `.pi/skills/bow-browser/SKILL.md` | `:8`、`:30` | 工具总数 36 → 42(19 核心 + 23 插件);「调试手机」一行补 snapshot→tap/type 与 console 的选型 |

> §12 的漂移清单按仓库规则处理:本轮**不新增**条目(改判据时同一次把文档改对);若顺手发现新漂移,按 §14 补进去。

### 步骤 12:收尾验收

- `bun run typecheck`、`bun run build`、`bun run test`(记录文件数/用例数,基线见 §4)。
- 报告里明确区分:**已自动化验证** vs **待真机**(§8)。

---

## 4. 测试计划(自动化)

**基线**:最近一次记录是 45 文件 / 930 例(2026-09-21)。本轮只加用例、不动既有断言(除非步骤 3 明写)。

1. `tests/shortcuts.test.ts`(+1~5 例):给既有 5 条 `shouldTakeSplitHotkey` 用例补 `inspector: false`,
   新增 inspector 接管 1 条;顺带钉一条「inspector 不是靠 `internalPageId === null` 兜住的」
   (即 `inspector: false, internal: true, internalPageId: null` 仍为 `false`)。
2. `tests/deviceInspect.test.ts`(+~15 例):`resolveCdpKey`(Enter/Tab/Escape/Backspace/Delete/四个方向/
   `ArrowUp` 与 `up` 两种写法/`PageDown`/未知键 → null);`stringifyRemoteObject`(值 / undefined /
   unserializableValue / preview 兜底 / 超长截断);三种事件 → `ConsoleEntry`;怪输入(缺字段、params 为
   `{}`、`args` 不是数组)不抛。
3. `tests/deviceInspectCdp.test.ts`(+~12 例):扩展那个**真 WebSocket**假 CDP 服务端
   (`:70` `startFakeCdp`)让它能:① 记录收到的 `method` 序列;② 主动 `push()` 事件帧(id 缺失);
   ③ 支持 `'error'` 行为(回 `{id, error:{message}}`)。用例:
   - `cdpSnapshot`:返回 `elements` 数组,且发出去的就是 `Runtime.evaluate` + `returnByValue`;
   - `cdpTap`(selector):方法序列 = `Runtime.evaluate`(POINT_FN) → `Input.dispatchTouchEvent` ×2,
     坐标 = 假 rect 的中心(钉住「用 CSS 像素、不乘 dpr」);
   - `cdpTap` 触摸失败 → 先 `Emulation.setTouchEmulationEnabled` 再重试;再失败 → `Input.dispatchMouseEvent` ×2;
   - `cdpTap`(`mode:'mouse'`)直接走鼠标;**两种定位方式都给 / 都不给** → 参数错误;
   - `cdpType`:`FOCUS_FN` → `Input.insertText({text})` → 读回值;`clear:false` 时脚本参数里不含全选;
   - `cdpPressKey('Enter')`:`keyDown` 带 `text:'\r'` + `keyUp`;`ArrowDown` 用 `rawKeyDown`;未知键 → 失败;
   - `cdpScroll`:`Runtime.evaluate` 收到 `SCROLL_FN` 且返回 `top`;
   - `cdpConsole`:push 三种事件 → 归一化条目顺序/上限 `maxEntries` 生效;`reload:true` 时先发
     `Page.enable` + `Page.reload`;`Runtime.enable` 报错但 `Log.enable` 成功时仍能拿到 `Log` 条目。
   > 这一层是**真 TCP + 真 WS 握手**跑的(既有做法),所以「事件被误当响应」「订阅被漏掉」这类错误跑不掉。
4. `tests/pluginBoundaries.test.ts`:新文件 `src/plugins/device-inspect/scripts.ts` 会被自动扫到
   (`ui.ts` 不得 import electron / `main.ts` 不得 import `.vue`),不需要改;`main.ts` 若因新 import 触雷会红。

**不做的自动化**:`device_*` 工具处理器本身(`main.ts` 里的 handler)没有单测 —— 它 import electron
(`app` / `net`),仓库现有测试**没有** mock electron 的先例,而插件工厂也没有依赖注入的口子。
真正端到端的验证沿用上一轮的做法(假 adb + 假设备 + 真 MCP 客户端手动跑一次,见
`.pi/plans/device-inspect.md` §12),本轮把它写成 §8 的手动清单。

---

## 5. 风险与未知

1. **代价(已知,必须写进文档)**:DevTools 前端窗格接管 `Ctrl+Shift+方向` 后,DevTools 内部的
   「按 `Ctrl+Shift+方向` 按词选择」在它自己的输入框(Styles / Console 提示)里会失效。
   `Alt+Shift+方向` 在 DevTools 里本来没有绑定,基本无代价。
2. **触摸注入的前置条件(待真机)**:`Input.dispatchTouchEvent` 在部分目标上要求先
   `Emulation.setTouchEmulationEnabled(true)`,也有些版本直接可用。因此实现按
   「先直接发 → 失败才开模拟 → 再失败走鼠标」的顺序;若真机上三条都失败,退路是 `mode:'mouse'`
   或 `device_eval`。**这条必须在真机上验一次**,不要按「应该能用」写死在文档里。
3. **坐标口径(待真机)**:元素中心点用 `getBoundingClientRect()`(视口 CSS 像素),不乘 dpr。
   页面处于**捏合缩放 / 软键盘顶起 / visualViewport 偏移**时,注入坐标可能整体偏移
   (`visualViewport.offsetTop/scale ≠ 1` 的情形)。缓解:我们注入前先 `scrollIntoView`;真机验证时用
   `device_eval` 读一个计数器确认点中。若实测偏得厉害,再考虑 `Emulation.setPageScaleFactor` 归一。
4. **`Input.insertText` 的可达性(待真机)**:它走 IME 路径,对受控输入更真,但个别 WebView 版本对
   `contenteditable` 的插入行为不同。兜底:`device_eval` + 核心 `TYPE_FN` 那一套。
5. **每次调用都重跑一遍发现**:`withCdp()` → `pickTarget()` → `snapshot()`(adb devices +
   `/proc/net/unix` + 每个套接字 `/json`)。WSL 下每条 adb 都是冷启动 `wsl.exe`,一次可能几百 ms~数秒。
   `snapshot → tap → snapshot` 的循环会把这笔开销乘 3。**本轮不改**(加 TTL 缓存会让「设备刚断开」
   这类状态变脏),先按 §9 记进 scratchpad,真机觉得慢再做「短 TTL + 显式刷新」。
6. **`device_console` 的窗口语义**:只覆盖调用期间。要抓「页面加载期」的日志必须 `reload: true`
   (会丢当前页面状态)。若 LLM 忘了,会误判「没有日志」—— 所以工具描述与 `MCP_INSTRUCTIONS` 都写死。
7. **多客户端共存**:DevTools 前端与我们的 CDP 连接可以同时挂在一个目标上(Chromium 允许),但
   `device_console` 期间如果人在 DevTools 里点 Console 的「清空」,两边看到的不是同一份 —— 只影响观感。
8. **脚本搬移的回归面**:步骤 4 是纯字符串搬移,唯一风险是漏掉某个引用(比如注释里提到行号)。
   `bun run test tests/mcpServer.test.ts` + `typecheck` 足以覆盖。

---

## 6. 与既有不变式的关系(改之前先确认没破坏)

- 「`@shared/devtools` 是 bow 自带前端地址的唯一拼装处」—— 本计划不碰。
- 「`target(tabId?)` 是页面类工具的统一取目标入口 / inspector 不出现在页面工具目标里」
  (`src/main/mcp.ts:138-150`)—— 新工具走的是插件自己的 `pickTarget()`,不碰核心那条。
- 「插件不得 import `.vue` / `@renderer`;`ui.ts` 不得 import electron」(测试自动扫)—— 新文件都守着。
- 「主进程新增文件名要登记进 `tsconfig.node.json` 的 include」—— 本轮新文件是
  `src/main/pageScripts.ts`(被 `src/main/**/*` 覆盖)与 `src/plugins/device-inspect/scripts.ts`
  (被 `src/plugins/*/scripts.ts` 覆盖),**两条都不需要改 tsconfig**(已在步骤 4/7 说明)。
- 「改工具语义必须同步 `MCP_INSTRUCTIONS`」—— 步骤 9。

---

## 7. 明确不做(本轮)

- 分屏面板加方向按钮、`device_inspect` 直接分屏打开(用户本轮没选;真机用过快捷键后觉得别扭再加)。
- adb 原生层:`input tap/text/swipe/keyevent`、`logcat`、`screencap`(整机截图)。那条路要 adb I/O 支持
  二进制 stdout + 新的 argv 构造 + 更多真机验证,是独立一轮。
- iOS / Flutter / RN 原生层(协议不同,既有文档已明确不支持)。
- 手势级滚动(`Input.synthesizeScrollGesture`)/ 双指缩放 / 长按拖拽。
- 目标发现的 TTL 缓存(见 §5.5)。

---

## 8. 真机验证清单(交给用户)

**前置**:bow 已 `npm run build`(设备检查插件在主进程里,`out/` 不更新就是旧行为);
手机已授权 USB 调试;要调的 App 调了 `WebView.setWebContentsDebuggingEnabled(true)`;
长时间调试前 `adb shell input keyevent KEYCODE_WAKEUP` + `svc power stayon true`(完事还原)。

1. **分屏**:打开某个手机目标的 DevTools 前端 → 焦点在该窗格 → `Ctrl+Shift+→` 出现两窗格 →
   `Ctrl+L` + `bow://terminal`(或 `Ctrl+Shift+E`)→ 得到「手机 DevTools | 终端」;
   `Alt+Shift+←/→` 能推分隔条;DevTools 面板(Elements/Console/Network/Application)在自己的窄窗格里
   仍可用、刷新目标不丢状态。
2. **回归**:设置页里 `Ctrl+Shift+方向` 仍是「不接管」(输入框按词选择可用);终端页/普通网页的分屏
   行为与以前一致;笔记页分屏仍由页面自己处理。
3. **快照**:`device_snapshot` 返回的 `elements[].selector` 能直接喂给 `device_tap`(点中的是同一个元素);
   与 `browser_snapshot` 的形状一致。
4. **点击**:`device_tap {selector}` 触发页面里**监听 touchstart/click** 的逻辑(页面自带的计数器/日志能证明);
   `mode:'mouse'` 也能中;坐标点(`{x,y}`)可用。
5. **输入**:`device_type` 能把文字打进受控输入框(React/Vue 的 `onChange` 触发、值不被回滚)、
   `clear:true` 会替换原内容、**传空 text 能把框清空**(这两条是本轮唯一靠 CDP 语义、没在真机验证过的假设;
   假设不成立时先用 `device_eval` 兑底,再把结论回填到 `docs/ARCHITECTURE.md` §13);
   `device_press_key {key:'Enter'}` 能提交表单/触发回车动作。
6. **滚动**:`device_scroll` 的 `top` 单调变化,页面真的滚了(自定义滚动容器传 `selector` 试一次)。
7. **观测**:`device_console` 能抓到手动在页面里 `console.log` 的内容与未捕获异常;
   `reload:true` 能抓到加载期日志(含 CSP/网络类 `Log` 条目)。
8. **失败态**:设备拔线 / 目标已关闭 / 多个目标却不给 `targetKey` —— 三类都要有可读的 `error`,
   不能是空数组或静默成功。

---

## 9. 实施后要写进记忆的两条

1. `shouldTakeSplitHotkey` 的 inspector 例外(以及「DevTools 前端没有 preload,所以只能由主进程接管」这个理由)。
2. 真机上 `device_tap` 的触摸注入是否直接可用 / 是否要 `Emulation.setTouchEmulationEnabled` /
   坐标在捏合缩放下是否偏移 —— 这三条**只有真机能定论**,验证完必须回填到
   `docs/ARCHITECTURE.md` §13「远端调试」那一节(现有 20~30 条同款经验的写法)。

---

## 10. 实施记录(2026-09-21)

### 改了什么(全部已落地)

| 步骤 | 文件 | 证据 |
| --- | --- | --- |
| A1 判据 | `src/shared/shortcuts.ts` | `SplitHotkeyTarget` 加 `inspector`;`shouldTakeSplitHotkey` 先判 `inspector`(它同时满足 `internal && internalId === null`,顺序写反就会被旧规则吃掉) |
| A2 调用点 | `src/main/tabShortcuts.ts:178-193` | 传 `inspector: !!rec.info.inspector` |
| A3 测试 | `tests/shortcuts.test.ts` | 4 条旧用例补 `inspector: false`,新增 2 条(inspector 接管 / 非 inspector 的内部页面仍不接管);该文件 59 例全绿 |
| B1 脚本搬移 | `src/main/pageScripts.ts`(**新**)、`src/main/actions.ts` | 4 个注入脚本逐字节搬移(124 行),`actions.ts` 只留 import;`tests/mcpServer.test.ts` 59 例全绿证明行为未变 |
| B2 纯逻辑 | `src/plugins/device-inspect/shared.ts` | `resolveCdpKey` / `stringifyRemoteObject` / `consoleEntryOf` / `exceptionEntryOf` / `logEntryOf` + `ConsoleEntry` / `CdpKeySpec`;`tests/deviceInspect.test.ts` 49 → **62 例** |
| B3 CDP 客户端 | `src/plugins/device-inspect/cdp.ts` | 加事件订阅 `on(method, cb)`(id 缺失的帧不再丢弃)+ `cdpSnapshot` / `cdpTap` / `cdpType` / `cdpPressKey` / `cdpScroll` / `cdpConsole`;`tests/deviceInspectCdp.test.ts` 12 → **31 例**(假 CDP 服务端加 `requests` 记录、`push()` 事件帧、`'error'` 行为、按参数分派的 `results` 函数) |
| B4 插件脚本 | `src/plugins/device-inspect/scripts.ts`(**新**) | `POINT_FN`(scrollIntoView + 中心点)、`FOCUS_FN`(聚焦 + 全选)、`READ_FOCUSED_FN`;`tsconfig.node.json` 的 `src/plugins/*/scripts.ts` 与 `src/main/**/*` 已覆盖,**无需改 tsconfig** |
| B5 MCP 工具 | `src/plugins/device-inspect/main.ts` | 6 个新工具;`withCdp()` 的 `run` 多收一个「实际选中的目标」,返回体里带 `targetKey` |
| B6 契约 | `src/main/mcp.ts` | `MCP_INSTRUCTIONS` 补手机工作流、console 窗口语义、坐标口径 |
| B7 冒烟 | `scripts/mcp-smoke.mjs` | 11 个 `device_*` 工具在册断言(不需要真机) |
| B8 文档 | `README.md`、`docs/ARCHITECTURE.md`(§1 目录图 / 测试基线 / §5.8 / §6.2 计数 36→42 / §7.2 / §11 测试表)、`.pi/skills/bow-browser/SKILL.md` | 计数与实测一致:插件工具 23、合计 42、测试 45 文件 / 965 例 |

### 实际验证(本轮已跑)

- `bun run typecheck`(node + web)干净。
- `bun run build` 成功;产物里 11 个 `device_*` 工具名与 `__bowDevicePoint__` 都在 `out/main/index.js`(注:插件主进程代码未构建不生效)。
- `bun run test` → **45 个文件 / 965 个用例全绿**(文档里的上一版基线是 45 / 930;+35 = `shortcuts` 58→59、
  `deviceInspect` 49→62、`deviceInspectCdp` 10→31,逐文件数用 `git show HEAD:<file> | grep -c '^\s*it('` 核对过)。
- **`bun run test:mcp` 已跑通**(`SMOKE_ELECTRON_ARGS="--ozone-platform=headless"`,`/tmp/mcp-smoke.log`):
  `✓ 工具数: 42` —— 19 核心 + 23 插件,11 个 `device_*` 全在册,与文档计数一致
  (设备本身没接,所以只验了「在册」这一层)。

### 实施中与计划不同的两点

1. **`device_tap` 多了「自动降级为鼠标」**:计划原文只写了「再失败或 `mode==='mouse'` → 鼠标」,实现把
   「触摸 → 开触摸模拟重试 → 鼠标」做成一条自动降级的链,并把**实际生效的 `mode`** 放进返回体
   (调用方不用自己猜走了哪条路)。代价是显式 `mode:'touch'` 也不再保证只在触摸层尝试 —— 已在工具描述里写明。
2. **顺手补了 `withCdp()` 的返回目标**:多步工作流(snapshot → tap)需要知道自己刚操作的是哪个
   `targetKey`,否则「省略 targetKey」的调用在目标变化后会静默换对象。
