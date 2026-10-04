# pi 状态联动通知改为系统级通知（完全替换窗内 toast）

日期：2026-10-04　模式：plan（只读调查）→ build

## 1. 目标与假设

把「终端里的 pi 状态联动」的通知通道从**窗口内底部居中 toast**换成**操作系统级通知**（Electron `Notification`），
标签角标（`TabInfo.agent`）保持不变。

用户已确认的决策（本次问答）：

| 决策点 | 选择 |
| --- | --- |
| 与窗内 toast 的关系 | **完全替换**（删除 ToastManager / ToastApp.vue / toast 渲染入口 / toast:* IPC / 通知栈归约） |
| 点击通知 | 必须保留「进入对应标签」（复用现有 `toast:activate` 的那段逻辑，抽成共用函数） |
| 触发时机 | **总是发**（不看窗口是否聚焦） |
| 通知范围 | `blocked`（等待确认）+ `idle && done`（已完成） |
| 提示音 | **静音**（`silent: true`，与番茄钟 `src/plugins/pomo/main.ts:88` 一致） |

由此推导的假设 / 口径：

1. 「系统级通知」= Electron 的 `Notification`（桌面环境通知），**不是**任务栏闪烁 / Dock 徽标 / 托盘气泡。
2. 窗内 toast 一整套连根拔掉，**不保留**「常驻直到用户处理」的语义：`blocked` 通知的生命周期改由 bow 尽量托管
   （agent 继续 / 标签关闭时 `close()`），但弹多久由桌面环境决定。
3. `blocked` = 一切 `ctx.ui.*` 弹框；`done` = `agent_settled`。这两档的判定在上游 pi 扩展里，**本次不改 pi 侧协议**
   （OSC `1337;bow` 一条都不动），只改 bow 落地端。
4. 不新增设置项（没有「窗内 / 系统」开关）。想要关掉就禁用终端插件或卸载状态桥。
5. 不新增 MCP 工具。

## 2. 现状（实际读到的代码）

### 2.1 数据流（现在）

```text
integrations/pi/bow-agent-state.ts  →  OSC ESC]1337;bow;{…}BEL
  → 终端插件剥序列（src/plugins/terminal/main.ts:302-320，parser）
  → ctx.service.agent.report({…signal, tabId})            （terminal/main.ts:185）
  → kernel.setAgentReporter → main/agentNotify.ts  (AgentNotify)
  → ① TabManager.setAgentState(tabId, badge)  → 标签角标
    ② ToastManager.set(items)  → 每窗口一个透明 WebContentsView（toast.html）画底部居中卡片
```

`main/agentNotify.ts:3` 自述：「这里把它变成 **标签角标** 与 **底部居中通知**，并管好三种定时器」。
`AGENT_DONE_BADGE_MS`（角标 10s）与 `AGENT_DONE_TOAST_MS`（done 通知 8s 自动关）都在 `@shared/agentState`。

### 2.2 点击进标签的实现（要保住的语义）

`src/main/ipc.ts:318-332`（`toast:activate`）：

```ts
agentNotify.dismiss(id)
const hit = windows.byTabId(item.tabId)
if (!hit) return false
windows.markActive(hit.ctx) // 多窗口:后续省略 windowId 的操作也落到这个窗口
hit.ctx.tabs.activate(item.tabId)
const view = hit.record.view.webContents
if (!view.isDestroyed()) view.focus()
if (hit.ctx.window.isMinimized()) hit.ctx.window.restore()
hit.ctx.window.show()
hit.ctx.window.focus()
```

这段就是系统通知的 `'click'` 要调用的东西，抽出来后两条路径共用（`src/main/index.ts:240-246` 的 `resolve` 与 `ipc.ts` 都拿得到 `windows`）。

### 2.3 系统通知的现成先例

`src/plugins/pomo/main.ts:85-91`：

```ts
if (!Notification.isSupported()) return
const notification = new Notification({ title: copy.title, body: copy.body, silent: true })
notification.on('click', focusSomeWindow)
notification.show()
```

即：`Notification` 在本项目已用、已过真机验证路径（番茄钟阶段结束），**不需要新依赖**。
仓库里 `app.setAppUserModelId(...)` **从未调用过**（Windows 通知的推荐前提）。

### 2.4 要被摘掉的接线（全量）

| 位置 | 现状 |
| --- | --- |
| `src/main/toasts.ts` | 整个 ToastManager（透明 WebContentsView、按实测高度摆 bounds） |
| `src/renderer/src/toast/{main.ts,ToastApp.vue,toast.css}`、`src/renderer/toast.html` | 第六个渲染入口 |
| `src/main/index.ts:7,120-121,132,186,243` | `ToastManager` 的 import / new / 注册 / `toasts.raise()` / `toasts: hit.ctx.toasts` |
| `src/main/windows.ts:21,41-42,126-129,151` | `WindowContext.toasts`、`register()` 参数、`byWebContents` 的通知视图分支 |
| `src/main/ipc.ts:232,295,299-333` | `toasts.raise()`、`toasts.layout()`、`toast:height/dismiss/activate` 三个 handler |
| `src/main/rendererEntry.ts:9`、`electron.vite.config.ts:35` | `'toast'` 入口名与 vite input |
| `src/preload/index.ts:15,26-27,99-109,171-176` | `ToastShowMessage` 类型 + `browserAPI.toasts.*` |
| `src/shared/agentState.ts:63-115,248-322` | `AgentToastItem`/`ToastAction`/`ToastContext`/`reduceToasts`/`toastsWouldChange`/`MAX_AGENT_TOASTS`/`AGENT_DONE_TOAST_MS` |

`@shared/find.ts:5` 与 `docs/ARCHITECTURE.md` 多处**引用** `main/toasts.ts` 的注释（解释「WebContentsView 没有点击穿透」），
这些是解释性引用，delete 之后要把引用改成对应位置（`find` 本来就说的是同一约束，改成 §3 开头的通用约束即可）。

## 3. 目标形态（行为规格）

1. **角标**：完全不变（`blocked` > `working` > `done`，`done` 10s 过期）。
2. **系统通知**，两种，文案沿用现有纯函数（见 §4.1）：
   - `blocked` → 标题「pi 需要确认」，正文 = `[对话框标题, 会话标签].join(' · ')`（如 `切换到 build？ · π - bow - /repo`）；
   - `done` → 标题「pi 已完成」，正文 = `signal.text || signal.title`（会话标签，如 `π - bow - /repo`）；
   - `silent: true`，不看窗口焦点。
3. **点击通知** → 与旧 `toast:activate` 逐条等价：切标签 + `markActive` + 补页面 focus + 恢复/前台/聚焦窗口。
   标签已经关了 → 什么都不做（`activateAgentTab` 返回 `false`）。
4. **撤回**（旧 toast 的「working 撤掉 blocked 卡片」等价物）：同一标签已有 `blocked` 通知时，
   收到 `working` / `idle`(非 done) / 新的 `blocked` / 标签关闭 → 对旧通知调 `close()`（best-effort，Linux 上部分 daemon 会忽略）。
   `done` 通知不追踪、不主动 close，交给桌面环境（原来那个 8s 自动关随之删除）。
5. 通知只在 `resolve(tabId)` 找得到标签时发（与现在一致：信号晚于标签关闭到达就丢弃并打日志）。

## 4. 实施步骤（有序，每步可独立验证）

### 步骤 1 — `src/shared/agentState.ts`：只留协议与角标

- 保留：`BOW_OSC_*`、`OscSignalParser`、`normalizeAgentSignal`、`AgentState`/`AgentBadge`/`AgentSignal`、
  `AGENT_DONE_BADGE_MS`、`badgeOfSignal`、`toastHeadline`。
- 删除：`AgentToastItem`、`ToastAction`、`ToastContext`、`reduceToasts`、`toastsWouldChange`、
  `MAX_AGENT_TOASTS`、`AGENT_DONE_TOAST_MS`。
- 改名：`toastHeadline(kind, signal)` → `notificationCopy(kind, signal)`（toast 已经不存在了，名字要如实）。
- 更新文件头注释（现在是「信号解析 + 角标 + 底部居中通知栈的归约」→ 两件事）。
- 验证：`npx tsc --noEmit -p tsconfig.json` 会先把所有引用点报出来（Step 2–7 逐个消掉）。

### 步骤 2 — 新增 `src/main/systemNotify.ts`（Electron 薄壳 + 测试缝）

```ts
export interface AgentNotice { kind: 'blocked' | 'done'; title: string; body?: string; tabId: number }
export interface NoticeHandle { close(): void }
export interface SystemNotifyPort { show(notice: AgentNotice): NoticeHandle }

export interface SystemNotifyDeps {
  activate: (tabId: number) => void
  /** 测试/诊断缝:`BOW_NOTIFY_LOG` 指向文件时每次 show/close 追加一行 JSONL,并挂 __bowNotifyClick */
  logPath?: string
}

export function createSystemNotifier(deps: SystemNotifyDeps): SystemNotifyPort
```

- `show()`：`Notification.isSupported()` 为假 / 构造抛错 → 记日志（含 `supported:false`）并返回 no-op handle，**绝不抛**
  （`resolve(tabId)` 的上游是插件调用链）。
- `new Notification({ title, body, silent: true })` + `on('click', () => deps.activate(notice.tabId))` + `show()`。
- `handle.close()` → `try { n.close() } catch {}`。
- `logPath` 存在时：追加一行 `{event:'show'|'close', kind, title, body, tabId, supported, at}`（`appendFileSync`，失败即吞），
  并 `globalThis.__bowNotifyClick = (tabId) => deps.activate(tabId)`。
  **为什么需要这个缝**：E2E 跑在 headless（没有 notification daemon），`isSupported()` 可能为假，
  而且**操作系统级的点击无法从 CDP 合成** —— 只能靠这个全局去驱动同一条 click 回调。与终端页给 E2E 用的
  `window.__bowTerminal` 是同一类做法，且只在环境变量设置时存在。
- 验证：新增 `tests/systemNotify.test.ts`（照 `tests/pomoPlugin.test.ts:13-37` 的假 `Notification` 写法）。

### 步骤 3 — 新增 `src/main/agentActivate.ts`：把 `toast:activate` 的逻辑抽出来

```ts
export function activateAgentTab(
  deps: Pick<WindowRegistry, 'byTabId' | 'markActive'>,
  tabId: number
): boolean
```

- 函数体 = `ipc.ts:322-331` 那 9 行（把 `log('通知已点开', …)` 改成 `log('代理通知已点开', …)`）。
- 验证：新增 `tests/agentActivate.test.ts`（用 `tests/fakeWindows.ts` 的假注册表：找得到标签 → 调 `markActive` +
  `tabs.activate` + `view.focus()`；找不到 → 返回 `false` 且不炸）。

### 步骤 4 — 重写 `src/main/agentNotify.ts`

新依赖面（**仍不 import electron**，保持「纯逻辑可单测」这条既有设计）：

```ts
export interface AgentTarget { setBadge(badge: AgentBadge | null): void }
export interface AgentNotifyDeps {
  resolve: (tabId: number) => AgentTarget | null
  notify: SystemNotifyPort
  schedule?: (fn: () => void, ms: number) => () => void
  now?: () => number
}
```

- `report(report)`：`resolve` → `null` 则打日志返回；`applyBadge`（原样保留，含 done 角标 10s 定时器）；
  再按 §3.2/§3.4 发或撤系统通知（`Map<tabId, NoticeHandle>` 只存 `blocked` 那一条）。
- `tabClosed(tabId)`：`cancelTab(tabId)`（角标定时器）+ `close()` 掉 blocked 句柄 + 清 badges。
- 删除：`items` / `ports` / `list()` / `get()` / `dismiss()` / `apply()` / `toastContext()` / `toastKey()` / `nextId`。
- 文件头注释重写（三层分工里「toasts.ts 是视图宿主」那层消失；`done` 通知不再有过期定时器）。
- 验证：重写 `tests/agentNotify.test.ts`（假 `SystemNotifyPort` 记录 show/close）。

### 步骤 5 — 主进程接线

- `src/main/index.ts`：
  - 删 `ToastManager` import（:7）、`new ToastManager(win)`（:120）、`register(...)` 的参数（:121）、
    `toasts.raise()`（:186，保留 `overlay.raise()`）、`resolve` 返回值里的 `toasts: hit.ctx.toasts`（:243）；
  - `agentNotify = new AgentNotify({ resolve: (tabId) => {…setBadge only…}, notify: createSystemNotifier({ activate: (tabId) => activateAgentTab(windows!, tabId), logPath: process.env.BOW_NOTIFY_LOG }) })`；
  - 更新 :67 与 :190-197 的注释（「通知栈里会留着已死窗口的条目… apply() 写已销毁的 ToastManager」→
    这句解释改成「已死窗口的 blocked 系统通知要 close 掉」，行为仍由 `for (const tab of tabs.listTabs()) agentNotify.tabClosed(tab.id)` 兜住）。
- `src/main/windows.ts`：`WindowContext` 去掉 `toasts`；`register(window, tabs, overlay, role)`；
  `byWebContents` 去掉通知视图分支；删 `toasts.ts` 的 import 与 :41-42 注释。
- `src/main/ipc.ts`：删 `ctx.toasts.raise()`（:232，保留 `ctx.overlay.show()` 那支）、`ctx.toasts.layout()`（:295）、
  `toast:height` / `toast:dismiss` / `toast:activate` 三个 handler（:299-333）；`ui:overlay` 与 `ui:chrome-height`
  两处注释里「把通知再抬一次 / 同时重排底部居中通知」同步删掉。
- `src/main/rendererEntry.ts:9`、`electron.vite.config.ts:35`：删 `toast` 入口。
- `src/preload/index.ts`：删 `AgentToastItem` import（:15）、`ToastShowMessage`（:26-27）、注释块（:99-102）、
  `toasts` 类型定义（:103-109）与实现（:171-176）。
- `src/main/ua.ts:31-39`（`applyBrowserIdentity`）：`if (process.platform === 'win32') app.setAppUserModelId(APP_DESKTOP_NAME)`。
  **为什么**：Windows 的 toast 需要 AppUserModelID；`APP_DESKTOP_NAME`（`com.ruinb0w.bow`）与 `build.appId` / `.desktop` 同源，
  顺带把番茄钟那条系统通知也一起修好。
- 验证：`npm run typecheck` 归零。

### 步骤 6 — 删除 toast 一整套

`git rm`：`src/main/toasts.ts`、`src/renderer/src/toast/main.ts`、`src/renderer/src/toast/ToastApp.vue`、
`src/renderer/src/toast/toast.css`、`src/renderer/toast.html`、`tests/toasts.test.ts`。
`src/shared/find.ts:5` 的注释引用改成不指向 `main/toasts.ts`。

### 步骤 7 — 文档与文案

- `README.md:3`（顶部特性：**底部居中通知** → **系统通知**）、`:30`（E2E 描述）、`:534-537`（行为三档：改成
  「弹出系统通知；`blocked` 会等到 agent 继续或标签关闭才撤回；`done` 交给系统通知中心」，并删掉「8 秒后自动收起」）、
  `:1035`（测试清单删 `tests/toasts.test.ts`）、`:1057-1061`（六个渲染入口 → 五个，删 toast.html 行）。
- `docs/ARCHITECTURE.md`：`:37`、`:45-48`（目录地图：删 `toasts.ts` 行、`agentNotify.ts` 描述改写）、
  `:91-92`（删 toast.html 段）、`:114`（`agentState.ts` 描述）、`:186`（`byWebContents` 列举去掉「通知视图」）、
  `:204`（删 Toast 行）、`:217-221`（删「通知视图同理…再抬一次」）、`:390`（`service.agent` 说明）、
  `:752`（browserAPI 通知行删除）、`:758-770`（「六个渲染入口」→「五个」+ 删 toast 行）、
  `:945-946`（`ui:chrome-height` 说明 + `toast:*` 三行删除）、`:1014`（`test:e2e:agent` 描述）、
  `:1155-1157`（已知坑里「通知视图 bounds」那段改为通用约束）。
- `src/plugins/terminal/ui/TerminalSettings.vue:296-302`：文案 → 「显示成**标签角标**与**系统通知**（点通知回到对应标签）」。
- `src/main/plugins/types.ts:86-96`、`src/plugins/terminal/main.ts:176-186`：注释里的「底部居中通知」→「系统通知」。
- `integrations/pi/bow-agent-state.ts:6-11`：注释「弹出右下角通知（点通知进入对应标签）」→「弹出系统通知」。
  这是**注释级改动**，但装到 `~/.pi/agent/extensions/` 的那份是拷贝 —— 改完要重跑 `npm run pi:install-status`
  （或在设置页点一次「安装」）才会同步；不改协议所以不重装也不会坏。

### 步骤 8 — 测试与 E2E

- `tests/agentState.test.ts`：删 `reduceToasts` / `toastsWouldChange` / `MAX_AGENT_TOASTS` 三个 describe，
  保留解析器与角标用例；`toastHeadline` 的用例改成 `notificationCopy`。
- `tests/agentNotify.test.ts`：重写（见 Step 4）。
- `tests/systemNotify.test.ts`、`tests/agentActivate.test.ts`：新增（见 Step 2/3）。
- `tests/windows.test.ts`（`:34,42-43,99-106`）、`tests/fakeWindows.ts:27`、`tests/find.test.ts:90`：`ctx` 里去掉 `toasts` 字段。
- `scripts/e2e-agent-status.mjs`：把 `:247-330` 那段通知视图断言换成**系统通知日志**断言：
  - spawn 时加 `BOW_NOTIFY_LOG=<dir>/notify-<run>.jsonl`（`dir` 已是每次独立的临时目录）；
  - `blocked` → 等日志里出现 `kind:'blocked'`、`title:'pi 需要确认'`、`body` 含 `切换到 build？`；
  - 从**主进程 inspector target**（`inspectPort`，脚本 `:280-298` 已经在用它读主进程状态）执行
    `globalThis.__bowNotifyClick(<tabId>)` → 断言 chrome 侧活动标签切回该 tab，且 `tab.agent` 仍是 `blocked`
    （保留旧断言「点通知 ≠ 回答弹框」）；
  - `working` 之后 → 日志里出现该通知的 `event:'close'`；`done` → `kind:'done'` / `title:'pi 已完成'`；
  - 补一条否定断言：`findTarget('toast.html')` 永远为 `null`；
  - 删掉 bounds/高度相关的断言与 `probe` 里找 toast 视图的片段（`inspectPort` 本身保留）；
  - 脚本头注释（`:1-20`）里的链路说明同步改。
- 验证：`npm test`（或 `bunx vitest run`；**不要** `bun test`）。

## 5. 验证清单

| 命令 | 期望 |
| --- | --- |
| `npm run typecheck` | 0 错误（会抓出所有漏改的 `toasts` / `AgentToastItem` / `toastHeadline` 引用） |
| `npm test` | 全绿；`tests/toasts.test.ts` 已删，新增 2 个文件 |
| `npm run build` | 绿；vite 少了 toast 入口，`out/renderer/toast.html` 不再产出 |
| `npm run test:e2e:agent` | 绿（headless；只断言「通知被尝试发出 + 文案」，不断言桌面真的弹了） |
| 真机手验（Windows/WSL，必须） | ① pi 里触发一次 confirm → 桌面出现系统通知、点击回到对应终端标签；② `done` 也能收到；③ 任务栏/通知中心里应用名是 bow 而不是 Electron（验 `setAppUserModelId`）；④ 窗口聚焦时也会弹（口径 = 总是发） |

## 6. 风险与未知

1. **Windows toast 可能根本不出**：`build.win.target` 是 `dir`，开发/未安装形态通常没有带 AppUserModelID 的
   Start Menu 快捷方式；本次补 `setAppUserModelId` 是必要不充分条件。番茄钟的既有系统通知同样受此限制 ——
   真机验证是唯一的判定手段（E2E 在 headless 下只能验「尝试发出」）。
2. **`blocked` 不再常驻**：桌面环境可能几秒后把它收进通知中心，用户容易错过「pi 在等你确认」——这是用户已接受的取舍。
   旧的窗内 toast 是 bow 自己管的常驻卡片，删掉就没了。
3. **`close()` 不是所有平台都有效**（Linux 部分 daemon）：agent 继续后通知可能仍留在通知中心，点进去时标签可能已关
   → 走 `activateAgentTab` 的 `false` 分支（无副作用）。
4. **`Notification.isSupported()` 在 headless / 无 daemon 时可能为假**：生产上表现为「什么都没有」，且**不再有窗内兜底**。
   日志（`logError`）里会留下原因，排查靠它。
5. **macOS**：dev 模式下通知显示为 Electron（未打包）；打包后需要签名才有稳定表现 —— 无真机，不在本次验证范围。
6. **`globalThis.__bowNotifyClick` 是测试缝**：只在 `BOW_NOTIFY_LOG` 设置时挂载，不进正常路径；评审时留意它别被别的代码依赖。
7. **`service.agent` 契约**（`PluginContext` 的 `service.agent.report`）**签名不变**，桌面插件不受影响；
   但 `docs/ARCHITECTURE.md:390` 描述的「通知进底部居中视图」必须同步，否则文档漂移。

## 7. 不做（non-goals）

- 不加「通知开关 / 声音开关」设置项；不改 pi 桥接扩展的 OSC 协议与事件集；不动标签角标；
- 不保留窗内 toast 的任何降级路径（用户明确选择完全替换）；
- 不为系统通知新增 MCP 工具。
