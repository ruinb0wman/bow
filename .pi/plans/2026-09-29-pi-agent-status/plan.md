# 方案:终端里的 pi 状态联动(标签角标 + 右下角通知)

> 日期:2026-09-29 · 模式:plan(只读调研产出,未改任何源文件)

## 0. 目标与假设

**目标**:bow 的终端(`bow://terminal`)里跑 pi 时,

1. **正在执行** → 该终端所在的标签(标签栏的一项 = 一个标签组)显示「执行中」角标;
2. **需要用户交互确认** → 窗口**右下角**弹出通知,点击进入对应标签;
3. **任务执行完成** → 同样右下角弹通知,点击进入对应标签。

**假设**(读码后确定,若与预期不符请指出):

- 「终端里的 pi」= 在 bow 的终端标签里**交互式**运行 pi(TUI 模式),不是 bow 自己去拉起 pi。
- 状态来自 pi 自己:`pi.on('agent_start' / 'agent_settled' / 'ui_prompt_start' / 'ui_prompt_end')`
  (见 §1),所以需要给 pi 装一个**很薄的桥接扩展**;不装也能退化到「正在执行」角标(靠 pi 内建的 OSC 9;4)。
- 通知只发给**该标签所属的那个窗口**;跨窗口把标签抢过来不做(v1)。
- 现有通知/浮层的技术边界:`WebContentsView` **没有点击穿透**(见 §1.5),所以右下角通知必须是
  「按内容实际高度精确设 bounds 的小视图」,而不是「铺满窗口的透明层」。

---

## 1. 现状:已核实的证据

### 1.1 pi 侧有现成的一手信号(不需要解析 TUI 文本)

`@earendil-works/pi-coding-agent`(本机 0.87.1)的类型声明里有:

```
dist/core/extensions/types.d.ts:629
/** Fired when Pi starts waiting on a blocking user-facing extension UI prompt. */
export interface UIPromptStartEvent { type: "ui_prompt_start"; reason: "ui_prompt"; kind: UIPromptKind; title?: string }
dist/core/extensions/types.d.ts:637
export interface UIPromptEndEvent   { type: "ui_prompt_end";   reason: "ui_prompt"; kind: UIPromptKind; title?: string }
// UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom"
```

发射点确认是**包住所有 `ctx.ui.*` 对话框**的:

```
dist/core/extensions/runner.js:317  wrapUIPromptContext(ui) {
   select/confirm/input/editor/custom 全部 → this.withUIPrompt(kind, title, …)
runner.js:332  emitUIPromptEvent({ type: "ui_prompt_start", … })   // 进入对话框
runner.js:341  type: "ui_prompt_end"                                // 退出对话框
```

即 pi-agents 的 `plan_exit`(`ctx.ui.confirm`)、权限引擎的 ask、`ask_user_question` 这类都会触发。
CHANGELOG:`0.84.4`(2026-08-28)新增 —— **最低 pi 版本 = 0.84.4**。

生命周期事件按 pi 自己的导航示例(`examples/extensions/notify.ts`)选:
`agent_start` → 干活;`agent_settled` → 一轮彻底结束(**不是** `agent_end`,后者会被重试/压缩/排队续跑打断)。

### 1.2 扩展可以往 pty 写自定义 OSC(有先例)

- pi 自己就这么做:`TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1B]9;4;3\x07"`、`…CLEAR = "\x1B]9;4;0\x07"`,
  `turn_start` / `compaction_start` 置位、`agent_end` / `compaction_end` 清除,由设置
  `terminal.showTerminalProgress` 控制(**默认 false**,`docs/settings.md:89`)。
- `examples/extensions/notify.ts` 直接 `process.stdout.write("\x1b]777;notify;…\x07")`。
- 本机 `~/.pi/agent/extensions/herdr-agent-state.ts` 是同一思路的成品:维护 `working | blocked | idle`
  三态并上报(pane 管理器用 unix socket;它用 `pi.events.on("herdr:blocked")` + `agent_start`/`agent_settled`,
  并用 `ctx.mode !== "tui"` 门禁 + `rootSession` 防止子会话重复上报)。**本方案照抄这套状态机,只把出口换成 OSC。**

### 1.3 bow 的终端插件正好是 pty 的持有者(挂点干净)

`src/plugins/terminal/main.ts`:

- 会话按 tabId 绑定(`sessions: Map<number, Session>`),`proc.onData` 是**所有**输出的唯一入口:

```ts
proc.onData((data) => {
  session.replay = pushReplay(session.replay, data)   // 回放缓冲(页面刷新重放)
  enqueue(session, data)                              // 8ms 合批 → ctx.ipc.emit(TERMINAL_EVENTS.data, {tabId, chunk})
})
```

- `tab:closed` → `killSession(id, 'tab-closed')`;`before-quit` → `killAll('app-quit')`(清理挂点现成)。
- spawn 环境走 `cleanEnv(process.env)`(`shared.ts`),可以顺手注入 `BOW_TERMINAL=1`。
- 输出经 `ctx.ipc.emit` → `kernel.broadcastPluginEvent` → `windows.broadcast` = **chrome + overlay + 内部页面标签**
  (`src/main/windows.ts:169`)—— 也就是说「标签角标」所需的广播通道已经存在。

### 1.4 需要浮在页面上的 UI 只有 Overlay 一条路,但右下角通知不能复用它

`docs/ARCHITECTURE.md §3`:

> `contentView` 的子视图按加入顺序从底到顶;**页面(WebContentsView)永远绘制在 chrome UI 之上**,
> 所以任何要浮在页面上的 UI 都必须交给 Overlay。

`OverlayManager` 是**每窗口单例、同一时刻只承载一份内容**(`show()` 是替换语义,modal 与 suggest 互斥),
而通知需要「与 modal / suggest 并存 + 自己堆叠 + 自动消失」。所以本方案新增一个**平级的**
`ToastManager`(每窗口一个),不复用 OverlayManager 的 content 槽。

### 1.5 关键约束:`WebContentsView` 不能点击穿透

`node_modules/electron/electron.d.ts`:`setIgnoreMouseEvents` 只出现在 `BaseWindow`(3374)与
`BrowserWindow`(6197);`class WebContentsView extends View`(18879)**没有**。
⇒ 「全窗透明视图 + CSS `pointer-events:none` + 卡片自己接事件」是**不可行**的:落在视图矩形里的点击
会被这个视图吃掉,永远到不了下面的页面。**通知视图必须刚好包住通知卡片**,高度由渲染层实测回传。
(替代方案是 `parent` + `transparent` + `setIgnoreMouseEvents(true, {forward:true})` 的子窗口 —— 舍弃:
多一个窗口、Wayland 下透明窗不可靠,而本仓库明确以 WebContentsView 为基线。)

### 1.6 其余需要留意的既有行为(改代码时会踩)

- `TabManager.publish(id)` 已经就是「`info` 变了 → `emit('tab-updated')`」的入口,`decorate()` 是
  `{...info}` 展开 —— 给 `TabInfo` 加字段能自动流到 chrome(`tab:updated` / `tab:list-changed`)。
- `WindowManager.byWebContents()` 只认 chrome / overlay / 标签页视图(§3 的 `hasWebContents` 三处);
  新视图必须在这里登记,否则它的 `invoke` 解析不到窗口。
- `TabManager.activate(id)` 对**已激活**的标签**早退**(不 focus):
  `if (this.activeId === id) return` —— 点通知时若那个标签本来就在前台,还得补一次 `webContents.focus()`。
- `OverlayManager.raise()` 由 `tabs.on('tabs-changed')` 触发;新视图要自己接一次同样的置顶,并且要在
  `ui:overlay` 开浮层**之后**再置顶一次(否则 `below-chrome` 的建议下拉会盖住右下角通知)。
- `ipc.ts` 的 `ui:chrome-height` 分支里已经调用了 `ctx.overlay.layout()` —— 通知视图也要在那里重排。

---

## 2. 方案总览

```
   ┌─ pi(bow 终端里,tui 模式)──────────────┐
   │  integrations/pi/bow-agent-state.ts    │  ① 监听 agent_start / agent_settled /
   │  仅当 BOW_TERMINAL=1 时工作             │     ui_prompt_start / ui_prompt_end
   │  process.stdout.write(OSC 1337;bow;…)  │
   └───────────────┬────────────────────────┘
                   │ pty(与 pi 的 TUI 输出同一条流)
   ┌───────────────▼────────────────────────┐
   │ plugins/terminal/main.ts(每会话)        │  ② OscSignalParser 边收边剥:
   │  onData → { text, signals }             │     · text(已剥掉控制序列)→ 回放缓冲 + 合批下发
   │                                        │     · signals → 只用来算状态
   │ ctx.service.agent.report({tabId, …})   │
   └───────────────┬────────────────────────┘
                   │ 主进程内调用(kernel 注入的 reporter)
   ┌───────────────▼────────────────────────┐
   │ main/agentNotify.ts(进程级单例)         │  ③ 纯函数 shared/agentState.ts 决定:
   │                                        │     · 角标(working/blocked/done±10s 过期)
   │                                        │     · 通知栈(blocked 常驻 / done 8s 自动关)
   └──────┬──────────────────────┬──────────┘
          │ setAgentState()      │ set(items)
   ┌──────▼──────┐        ┌──────▼──────────────────────┐
   │ TabManager  │        │ main/toasts.ts(每窗口)       │
   │ info.agent  │        │ 精确 bounds 的 ToastManager  │
   │ → tab:updated│       │ → toast:show / toast:height  │
   └──────┬──────┘        └──────┬──────────────────────┘
          │                      │
   ┌──────▼──────────┐    ┌──────▼────────────┐
   │ App.vue 标签栏  │    │ toast.html(新渲染入口)│
   │ .tab-agent 角标 │    │ 卡片:点→进入标签     │
   └─────────────────┘    └───────────────────┘
```

一句话:**pi 只负责把状态「喊」出来(OSC),bow 的终端插件负责听,主进程负责决定,chrome 与通知视图负责画。**

---

## 3. 信号协议(新,写进文档)

控制序列(iTerm2 私有区间 1337,未知键会被别的终端忽略;xterm.js 对未知 OSC 也是静默忽略):

```
ESC ] 1337 ; bow ; <JSON> BEL
\x1b]1337;bow;{"v":1,...}\x07
```

JSON 负载(v1,全部字段可选除 `v`/`state`):

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `v` | `1` | 协议版本;不认识的版本整条丢弃(不能因为新版本把老 bow 弄坏) |
| `state` | `"working" \| "blocked" \| "idle"` | 三态**只有这三态**,`done` 不进 state |
| `done` | `true` | 仅随 `state:"idle"` 出现,表示「这一轮**跑完了**」(区别于「本来就没跑」) |
| `agent` | `string` | 代理名,默认 `"pi"`,用于通知标题 |
| `title` | `string` | 对话框标题(blocked 时)或会话名 |
| `text` | `string` | 副标题(如 `π - bow - /path/to/cwd`) |

**为什么 JSON 而不是 `;` 分隔**:`JSON.stringify` 保证字符串里不会出现裸 `\x07`(BEL)与 `\x1b`,
所以「扫到第一个 BEL 就结束」是无歧义的,中文/引号/分号都不用转义。
**不用 `tabId`**:权威身份是「信号从哪个 pty 会话进来」,负载里带 id 会变成第二个真相源(且可被伪造/嵌套)。

`idle + done` 而不是 `state:"done"`:`agent_settled` 与「session 起来但没干活」都是 idle,
让 bow 侧用 `done` 标志区分「完成」和「没跑」,规则只有一条。

**降级信号(可选,不装桥接扩展也有)**:解析 pi 内建的 `ESC]9;4;3`(活动)/`ESC]9;4;0`(清除),
映射到 `working` / `idle`。规则:**同一个会话一旦见过一次 `1337;bow` 信号,就再也不用 9;4**
(否则桥接说的 `blocked` 会被 9;4 的 `working` 覆盖)。

---

## 4. pi 侧桥接扩展(新文件,仓库内)

新文件 `integrations/pi/bow-agent-state.ts`(装到 `~/.pi/agent/extensions/`),
由 `scripts/install-pi-agent-state.mjs` 幂等写入(带 `// managed by bow` 头 + `--dry-run/--uninstall/--print`),
和 herdr 的做法一致(`~/.pi/agent/extensions/herdr-agent-state.ts` 头部就写着 "managed by herdr; 重装会覆盖")。

状态机(照抄 herdr 的 `desiredState()` 结构):

```ts
export default function (pi: ExtensionAPI) {
  if (process.env.BOW_TERMINAL !== '1') return   // 只在 bow 的终端里说话,别的终端不受影响

  let active = false            // agent 在跑
  let activeRun = false         // 本次 run 真的开跑过(settle 时用来判 done)
  let promptDepth = 0           // ui_prompt 的嵌套深度
  let promptTitle: string | undefined
  let lastKey = ''              // 去重:同一状态不重复喊

  const emit = (state, done, title?, text?) => { … process.stdout.write(`\x1b]1337;bow;${JSON.stringify({v:1,state,…})}\x07`) }
  const publish = (done = false) =>
    promptDepth > 0 ? emit('blocked', false, promptTitle, sessionLabel())
    : active        ? emit('working', false, undefined, sessionLabel())
    :                 emit('idle', done, undefined, sessionLabel())

  pi.on('session_start',  (_e, ctx) => { if (ctx.mode !== 'tui') return; root = true; active = ctx.isIdle?.() === false; publish() })
  pi.on('agent_start',    () => { active = true; activeRun = true; publish() })
  pi.on('agent_settled',  (_e, ctx) => { if (ctx.isIdle?.() !== true) return; const d = activeRun; active = false; activeRun = false; publish(d) })
  pi.on('ui_prompt_start',(e) => { promptDepth++; promptTitle = e.title; publish() })
  pi.on('ui_prompt_end',  ()  => { if (--promptDepth <= 0) { promptDepth = 0; promptTitle = undefined } publish() })
  pi.on('session_shutdown',()  => emit('idle'))
}
```

要点:`ctx.mode === 'tui'` 门禁(RPC/JSON/print 没有 pty,别乱喊);`root` 门禁(子会话不重复上报);
`sessionLabel()` 取 `pi.getSessionName() ?? basename(cwd)`;
扩展文件**不进 bow 的 tsconfig**(它 import 的是 pi 的类型,不是 bow 的依赖)。

---

## 5. 逐文件改动

### 新增

| 文件 | 内容 |
| --- | --- |
| `src/shared/agentState.ts` | 纯逻辑(无 electron/DOM):协议常量、`AgentSignal`/`AgentToastItem`/`AgentBadge` 类型、`OscSignalParser`、`badgeOfSignal()`、通知栈归约 `reduceToasts()`、`toastHeadline()`、两个过期常量 |
| `src/main/agentNotify.ts` | 进程级服务:`report(signal)` / `tabClosed(tabId)`;按注入的端口(`resolve(tabId) → {setBadge, toasts}`)落地;持有 done 角标与 done 通知的定时器 |
| `src/main/toasts.ts` | 每窗口 `ToastManager`:懒建 `WebContentsView`(透明、复用应用 preload)、`set/items/getItem/dismiss/hasWebContents/raise/layout/setHeight/destroy` |
| `src/renderer/toast.html` | 第六个渲染入口(CSP 与 overlay.html 同款) |
| `src/renderer/src/toast/main.ts` + `ToastApp.vue` + `toast.css` | 通知栈视图:`api.toasts.onShow` → 渲染卡片;`ResizeObserver` → `reportHeight`;点卡片 → `activate`;`×` → `dismiss` |
| `integrations/pi/bow-agent-state.ts` | 见 §4 |
| `scripts/install-pi-agent-state.mjs` | 幂等安装/卸载桥接扩展(`--dry-run`/`--uninstall`/`--print`),默认目标 `~/.pi/agent/extensions/bow-agent-state.ts` |
| `scripts/e2e-agent-status.mjs` | E2E:假 pi(只发 OSC 的 node 脚本)→ 断言角标 / 通知 / 点击进标签(见 §7.3) |
| `tests/agentState.test.ts` | 解析器 + 归约的用例 |
| `tests/agentNotify.test.ts` | 端口注入式用例(通知/角标/关闭标签清理/定时器) |
| `tests/terminalAgentSignal.test.ts` | 终端插件:假 pty 注入 → 断言「控制序列被剥掉 + 状态上报 + 会话结束清理」 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/shared/types.ts` | `TabInfo` 增 `agent?: AgentBadge`(注释写清:仅主进程写,终端插件经 `service.agent` 上报) |
| `src/main/tabManager.ts` | 新增 `setAgentState(tabId, badge \| null)`:值变了就写 `info.agent` 并 `this.publish(id)` |
| `src/main/windows.ts` | `WindowContext` 增 `toasts: ToastManager`;`register(window, tabs, overlay, toasts)`;`byWebContents()` 增 `ctx.toasts.hasWebContents(wc)` |
| `src/main/index.ts` | `createWindowContext()` 建 `ToastManager` 并登记;`wireWindowContext()` 里 `win.on('resize')`→`toasts.layout()`、`tabs.on('tabs-changed')`→`overlay.raise(); toasts.raise()`、`tabs.on('tab-closed')`→`agentNotify.tabClosed(id)`;`whenReady` 里建 `AgentNotify` 并 `kernel.setAgentReporter((s) => agentNotify.report(s))` |
| `src/main/ipc.ts` | 新增 `toast:height` / `toast:dismiss` / `toast:activate`;`ui:overlay` 分支里 `ctx.toasts.raise()`;`ui:chrome-height` 分支里 `ctx.toasts.layout()` |
| `src/main/plugins/types.ts` | `PluginServiceApi` 增 `agent: { report(signal: AgentSignal & { tabId: number }): void }` |
| `src/main/plugins/kernel.ts` | `setAgentReporter(fn)` + `service.agent.report` 委派(未注入时打一条 warn,不静默吞) |
| `src/preload/index.ts` | `BrowserAPI` 增 `toasts: { onShow, reportHeight, dismiss, activate }`(用现成的 `subscribe()` helper) |
| `src/renderer/src/App.vue` | `groupAgent(g)` 聚合(blocked > working > done)+ 标签项里 `.tab-agent` 角标与 tooltip |
| `src/renderer/src/style.css` | `.tab-agent`(+ `.agent-working/-blocked/-done`)样式,复用现成的 `@keyframes spin`(见 `.tab-spinner`) |
| `src/main/rendererEntry.ts` | `RendererEntryName` 增 `'toast'` |
| `electron.vite.config.ts` | `rollupOptions.input` 增 `toast: resolve('src/renderer/toast.html')` |
| `src/plugins/terminal/shared.ts` | `cleanEnv()` 补 `out.BOW_TERMINAL = '1'`(注释:桥接扩展靠它判断自己在 bow 里) |
| `src/plugins/terminal/main.ts` | 每会话一个 `OscSignalParser`;`onData` 改为「剥序列 → 文本走原路 / 信号走 `service.agent.report`」;`onExit`/`killSession`/`killAll` 上报 `idle`;`createTerminalPlugin(deps?)` 留出假 pty 注入缝(默认 `createTerminalPlugin()` 不变) |
| `tests/fakeWindows.ts`、`tests/windows.test.ts` | 跟上 `WindowContext.toasts` / `register()` 的新形参 |
| `package.json` | `"pi:install-status": "node scripts/install-pi-agent-state.mjs"`、`"test:e2e:agent": "node scripts/e2e-agent-status.mjs"` |
| `README.md` | §终端 增「AI 代理状态联动」小节;启动脚本清单加 `pi:install-status`;`## 无需显示环境的部分` 或 E2E 段加新脚本 |
| `docs/ARCHITECTURE.md` | §1 目录地图、§3(新增视图行 + `WindowContext` + `byWebContents`)、§5.2(`service.agent`)、§7.1(preload)、§7.2(六个渲染入口 + 角标)、§9(`toast:*` 三行)、§11(脚本)、§13(「WebContentsView 不能点击穿透」这条坑) |

**不改**:MCP 工具(`browser_list_tabs` 暂不暴露 `agent`,避免 §6.2 表格与 SKILL.md 的连锁文档漂移;
以后要暴露时在 `src/main/mcp.ts:538` 的字段清单里加一行 `agent: t.agent`)。

---

## 6. 实施步骤(每步都能独立验证)

### 阶段 A:纯逻辑 + 单测(不碰 electron)

1. **`src/shared/agentState.ts`** + `tests/agentState.test.ts`。
   解析器必须覆盖:一次 chunk 多条信号 / 一条信号被切成两个 chunk / 中文与引号 /
   负载里出现裸 `]` / 未知 `v` 丢弃 / 坏 JSON 丢弃但**不吞掉周围文本** / 非 bow 的 OSC(如 `]0;title`)原样透传 /
   `9;4` 降级解析 / 保留缓冲上限。归约必须覆盖:working→idle(done) 产出 done 通知且清角标 /
   working→blocked 产出 blocked 通知 / blocked→working 关掉该 tab 的 blocked 通知 /
   idle(非 done) 什么都不弹 / 同一状态重复上报不重复弹 / `tab-closed` 清空该 tab。
   **验证**:`npm test -- agentState`。

2. **`src/main/agentNotify.ts`** + `tests/agentNotify.test.ts`(注入假端口 + 假时钟/`setTimeout`)。
   **验证**:`npm test -- agentNotify`。

### 阶段 B:终端插件接上(仍可无 UI 验证)

3. `src/plugins/terminal/{shared,main}.ts`:注入 `BOW_TERMINAL`、接解析器、上报状态、
   结束时清状态、`createTerminalPlugin(deps)` 缝。
   **验证**:`tests/terminalAgentSignal.test.ts`(假 pty 推入带 OSC 的输出 → 断言
   ① `data` 事件里的文本不含 `\x1b]1337` ② `service.agent.report` 收到 `blocked` ③ 回放缓冲里也只有剥干净的文本)
   + `npm test -- terminalShared`(env 用例)。

4. 内核面:`plugins/types.ts` 的 `service.agent` + `kernel.ts` 的 `setAgentReporter` + `TabManager.setAgentState`。
   **验证**:`npm run typecheck`;`npm test`(全绿)。

### 阶段 C:通知宿主与点击进入(主进程)

5. `src/main/toasts.ts` + `rendererEntry` + `electron.vite.config.ts` + `toast.html`/`ToastApp.vue`/`toast.css`
   + `windows.ts`(`toasts` 字段、`byWebContents`、`register`)+ `index.ts` 接线 + `ipc.ts` 三个通道 + `preload`。
   **验证**:`npm run dev` → 手写一次 `printf '\033]1337;bow;{"v":1,"state":"blocked","title":"手测"}\007'`
   (或在终端页 console 里 `__bowTerminal.send(...)`)→ 右下角出现卡片;`×` 能关;
   点卡片能激活对应标签;窗口缩放 / 分屏后卡片仍贴右下角且不吃页面点击(在卡片外的右下区域点一下网页按钮)。
   `npm run typecheck && npm test`。

6. `App.vue` 角标 + `style.css`。
   **验证**:同上手测;分屏组里任一半有状态时,组项显示角标(blocked 优先)。

### 阶段 D:pi 桥接 + 安装脚本

7. `integrations/pi/bow-agent-state.ts` + `scripts/install-pi-agent-state.mjs` + `package.json` 脚本。
   **验证**:`node scripts/install-pi-agent-state.mjs --dry-run` → 打印将写入的路径与内容;
   真跑一次 → `~/.pi/agent/extensions/bow-agent-state.ts` 出现且带 managed 头;
   `--uninstall` 能删干净(只删带 managed 头的那个文件,不动别人的扩展)。
   然后**手工验收**:`npm run dev` → 开终端 → `pi` → 让它跑一个长任务 → 切到别的标签:
   ①跑的时候角标亮 ②让它要求确认(如 `bash` 触发权限或 plan_exit)→ 右下角出现「等待确认」通知
   ③确认完让它跑完 → 出现「已完成」通知,点击回到那个终端标签。

8. (可选,本阶段可后置)**终端设置页的「Pi 状态联动」**:显示「已接入 / 未接入」+ 一键安装按钮
   (复用 `TerminalSettings.vue` 的分区)。若要做:桥接源必须以**打包后仍可读**的形式存在 ——
   把 `integrations/**` 加进 `package.json` 的 `build.files`,主进程用
   `readFileSync(join(app.getAppPath(), 'integrations/pi/bow-agent-state.ts'))`(asar 对 fs 透明)读源,
   插件侧经 `ctx.ipc.handle('installPiBridge', …)` 落盘。**先确认 `npm run dist` 后该文件真的在产物里**
   (`scripts/verify-dist.mjs` 目前只查外部依赖,不查 `files` 清单)。

### 阶段 E:E2E 与文档

9. `scripts/e2e-agent-status.mjs`(照 `scripts/e2e-device-inspect.mjs` 的骨架:独立 userData + 独立
   `--remote-debugging-port` + MCP stdio client + `evalOn(chrome target)`),见 §7.3。
   **验证**:`npm run test:e2e:agent`。
10. README / ARCHITECTURE 更新 + 跑一遍完整门禁:`npm run typecheck && npm test && npm run build`。
11. 记一笔到 memory/scratchpad:真机(Windows 侧 bow.exe + 真 pi)验收结论。

---

## 7. 验证矩阵

### 7.1 单元测试

| 文件 | 覆盖 |
| --- | --- |
| `tests/agentState.test.ts` | §6.1 的解析/归约清单(这是本方案**最值钱**的测试:协议边界全在这里) |
| `tests/agentNotify.test.ts` | 端口注入:通知入栈/出栈、角标写回、`tabClosed` 清理、done 过期定时器(假时钟) |
| `tests/terminalAgentSignal.test.ts` | 假 pty:剥离 + 上报 + 会话回收 + 「见过桥接信号后忽略 9;4」 |
| `tests/terminalShared.test.ts`(扩展) | `cleanEnv` 注入 `BOW_TERMINAL` |

### 7.2 手工验收(真 pi)

阶段 D 的第 7 步五条 + `npm run dist` 后在新产物里重复(尤其 Linux 侧 node-pty 行为)。

### 7.3 E2E(不需要真 pi、不需要 API key)

用假 pi(`$BOW_E2E_DIR/fake-pi.mjs`,按延时打印 OSC 的 node 脚本)驱动**真代码路径**:

1. 启动 headless Electron(`MCP=stdio` + `--remote-debugging-port`);
2. chrome target 上 `window.browserAPI.createTab('bow://terminal')`(MCP 的 `browser_navigate` 拒收非 http(s));
3. 终端页 target 上 `window.__bowTerminal.send('node <fake-pi>\r')`
   —— 先用 `__bowTerminal.bufferText()` 断言 `echo $BOW_TERMINAL` = 1;
4. 假 pi 发 `blocked` →
   - chrome target:`window.browserAPI.listTabs()` 里那个标签 `agent === 'blocked'`;
     `document.querySelector('.tab-agent.blocked')` 存在;
   - toast target(URL 以 `toast.html` 结尾):`document.body.innerText` 含标题,`querySelector('.toast-card')` 存在;
5. 在 toast target 上 `.click()` → 断言 chrome 里 `listTabs()` 的 `active === true` 落在那条,通知消失;
6. 假 pi 发 `idle + done` → 断言出现 done 通知、角标先变 `done`(随后过期);
7. 关掉标签 → 断言通知/角标都清理干净。

---

## 8. 风险、未知与对策

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| **必须装桥接扩展** | blocked/done 两个需求都依赖 pi 扩展;不装只剩「正在执行」角标(且还需 pi 打开 `terminal.showTerminalProgress`) | 安装脚本 + 文档 + (可选)设置页一键安装;README 里明确写清楚「哪一部分需要装什么」 |
| **pi 版本下限** | `ui_prompt_*` 自 pi 0.84.4 才有 | 桥接里对未知事件名不做假设(vitest 外不报错);文档写最低版本 |
| **写入 stdout 与 TUI 打架** | pi 的 TUI 每帧一次 `process.stdout.write`,我们的写是零宽 OSC,同线程串行,不会撕裂在_write 中间_;且 pi 自己的 9;4 就是这么干的 | 只在状态**变化**时写(去重),必要时可用 `try{}catch{}` 包住 |
| **控制序列跨 chunk** | pty 的 chunk 边界任意 | 解析器带状态与保留缓冲(上限 4KB,超限丢弃并放行,避免坏流把内存吃掉) |
| **回放里重放旧信号** | 页面刷新会重放回放缓冲 | 解析在 `onData` 时做,**回放缓冲只存剥干净后的文本** |
| **右下角视图挡住页面点击** | `WebContentsView` 无点击穿透(§1.5) | 视图高度 = 渲染层实测高度;空栈即 `setVisible(false)`;报告到达前用估算高度 |
| **浮层盖住通知** | `below-chrome` 建议下拉是全宽带 | `ui:overlay` 之后补一次 `toasts.raise()` |
| **多窗口语义** | 通知只出现在标签所属窗口;窗口最小化时不抢焦点 | v1 明确这样;`toast:activate` 里 `markActive` + `restore/show/focus` |
| **点通知时目标标签已在前台** | `TabManager.activate()` 会早退不 focus | 激活后补一次 `record.view.webContents.focus()` |
| **tmux / screen / ssh 里跑 pi** | 外层复用器可能不放行 OSC(9;4 同理) | 文档写明限制;不做特殊处理 |
| **`node-pty` 假注入缝** | 为了让插件可单测要引入 `deps` 参数 | 只加一个可选参数,默认值不变,`builtin.ts` 的 `import terminal from …` 不受影响 |
| **打包后读不到桥接源**(仅设置页一键安装需要) | 现在 `build.files` 只有 `out/**` | 该功能列入可选阶段 D-8;做的话加 `integrations/**` 并实测产物 |

**未确定**:① 是否要把 `agent` 加进 `browser_list_tabs`(有独立价值,但要同步改 README §MCP 工具一览 + `.pi/skills/bow-browser/SKILL.md`);
② 是否需要「通知开关 / 免打扰」设置(本方案先不做,v1 的弹窗行为就是需求原文);
③ 若用户只在 bow 里跑 `claude`/其他代理,协议是通用的,但本方案只实现 pi 的桥接。

---

## 9. 明确不做(避免范围滑坡)

- 不做跨窗口「把标签搬到当前窗口」;不做通知中心/历史;
- 不解析 pi 的 TUI 文本(用一手扩展事件);
- 不改 pi 的 `settings.json` 去替用户打开 `terminal.showTerminalProgress`(只在文档里说);
- 不给右下角通知做富交互(只有「点卡片进入标签」与「×」);
- 不引入新的第三方依赖。

---

## 10. 执行记录(2026-09-29,已实现)

按 §6 的阶段 A→E 做完了(阶段 D-8「设置页一键接入」也已补做,见下)。

**实际新增**:`src/shared/agentState.ts`、`src/main/agentNotify.ts`、`src/main/toasts.ts`、
`src/renderer/toast.html`、`src/renderer/src/toast/{main.ts,ToastApp.vue,toast.css}`、
`integrations/pi/bow-agent-state.ts`、`scripts/{install-pi-agent-state.mjs,e2e-agent-status.mjs}`、
`src/plugins/terminal/piBridge.ts`(D-8:设置页一键接入的纯规则)、
`tests/{agentState,agentNotify,toasts,terminalAgentSignal,piBridgeExtension,piBridge}.test.ts`。
**实际修改**:见计划 §5 的表格,另加 D-8 的四处:`package.json`(`build.files` 加 `integrations` 目录、两条脚本)、
`tsconfig.node.json`(`piBridge.ts` 进 include)、终端插件(三个 IPC handler)、`ui/TerminalSettings.vue`(新的分区 + `data-bridge-*` 钩子)。

**与计划的三处偏离(都是有意的)**

1. `9;4` 降级序列现在**也会被剥掉**(计划 §8 只说「回放里存剥干净的文本」)。
   理由:它已经是 bow 的角标数据源,再交给 xterm 等于两套通道并存。测试钉住了这个行为。
2. 通知视图的高度策略从「实测与估算取大者」改成「实测**只对量它时的条数有效**,其余按估算」。
   原来的写法会让 view 永远不小于 `104px × 条数`(估算变成下界),白白挡住页面点击 ——
   正是本次最该避免的失效模式。`tests/toasts.test.ts` 里专门有一条「实测可以比估算小」。
3. 降级路径**不报 `done`**:pi 在 `compaction_end` 也会 `setProgress(false)`,报 done 会变成假「已完成」通知。

**无法在本机验证的一环 → 已解决**:`npm run test:e2e:agent` 需要 Electron,而本开发容器缺 `libasound.so.2`。
解法**不需要 root**:`ldd node_modules/electron/dist/electron` 确认只缺这一个 → `absolute curl` 从 Arch 镜像的 `extra.db`
查出 `alsa-lib` 的 FILENAME → 下载 + `bsdtar -xf` 到 `/tmp/alsa-root` → `LD_LIBRARY_PATH=/tmp/alsa-root/usr/lib`。
于是真 E2E 真的跑了:**开发产物 31/31、打包产物(`BOW_E2E_BIN`)32/32 全绿**,包括真终端、真通知视图、
点卡片进标签、以及设置页一键接入真的写/删文件。

**E2E 自己找出来的一个断言错误**(不是产品 bug):点通知只等于「去看一眼」,不等于用户在终端里回答了弹框 ——
角标必须**仍停在 `blocked`**(状态只有 pi 自己报出来才算数)。原断言写成「点完角标不再是 blocked」,
而且判定式在「角标已清空」时返回假值、永远不可能判成功。现在两条语义都单独断言了。

**阶段 D-8(设置页一键接入)已完成**:
- `src/plugins/terminal/piBridge.ts` = 纯规则 + 注入 fs(与仓库脚本同一套文件名/归属标记/源路径,不变式由 `tests/piBridgeExtension.test.ts` 钉住);
- 终端插件新增 `piBridgeStatus` / `piBridgeInstall` / `piBridgeUninstall` 三个 IPC(`piBridgeUninstall` 走通用 `plugins.invoke`,**不动 preload**);
- 设置页 → 终端 → 「Pi 状态联动」:状态文字 + 安装/更新/重装 + 卸载,覆盖非 bow 文件要显式「覆盖」;
- `package.json` 的 `build.files` 加 `integrations` 目录,并**实测**过打包产物里真有 `/integrations/pi/bow-agent-state.ts`(解析 asar header + 在打包版里点了一遍安装)。

**仍然存在的既有问题(与本功能无关)**:`tests/mcpHttp.test.ts` 的 DNS-rebinding 用例在 Node 26 上失败 ——
Node 现在要求手写的 `Host` 头与连接 authority 一致(已用 5 行 node 脚本单独复现,与 bow 无关;
仓库声明的 engines 是 `>=22.19.0`)。

---

## 11. 现场修复(2026-09-30,用户真机反馈后)

用户报「终端里 `echo $BOW_TERMINAL` 是空」→ 查出**两个真原因**,都已在代码/文档层面修掉:

1. **Windows 的 `bow.exe` + WSL profile**:Windows 侧的环境变量**默认不会进发行版**,只有列进 `WSLENV` 的才会。
   在同一个发行版里做了对照实验(`wsl.exe --cd ~ -e zsh -lc`,实测表见 `withBowTerminalEnv` 的注释):
   不加 `WSLENV` = 空(复现用户的现象)、加了 = `1`、与用户已有的 `WSLENV` 合并 = `1`。
   → 新增 `withBowTerminalEnv(env, shell)`(`@plugins/terminal/shared`),在 spawn env 里接上;5 条单测。
2. **扩展装错了系统**:设置页按钮写的是 **bow 进程的** `homedir()`(Windows 的 `%USERPROFILE%\.pi\agent\extensions`),
   而跑到 WSL 里的 pi 读的是 **发行版的** `~/.pi/agent/extensions`。README 里已写清「同一台机器不同系统时要装两份」,
   以及从 WSL 里 `cp` 过去的一行命令。

顺带纠正一个误导:用户在终端里跑的手写 OSC 命令「没有输出」是**正常的** —— 它写的是不可见控制序列,
效果在**标签栏角标**,不是终端文字;判定「我在不在 bow 的终端里」看 `ps -o comm= -p $PPID`。

## 12. 设置页加「WSL2 请执行这条命令」(2026-09-30,用户要求)

需求原话:「在设置中加上一条说明,如果使用wsl2请执行以下命令将扩展安装到wsl2中」。

- 纯逻辑:`piBridge.windowsPathToWsl()`(`C:\a\b` → `/mnt/c/a/b`;UNC / POSIX 返回 null)与
  `wslHint(env)`(只在 `platform === 'win32'` 且能换算时给出 `{from,to,command}`);
  `PiBridgeEnv` 加可选 `platform`,主进程传 `process.platform`。
- 数据:`PiBridgeStatus.wsl?`(类型在 `shared`,渲染层要用);`piBridgeStatus()` 只在有值时挂这个键。
- UI:`TerminalSettings.vue` 在「路径行」下面显示说明块(粗体标题照抄用户措辞 + `<code>` 命令行 + 复制按钮),
  显示条件是 `bridge.wsl` 存在 **且** 用户的终端配置里有 `wsl.exe`(复用已测的 `isWslShell`)。
- E2E:非 Windows 上断言「**不**给这段提醒」(免得给不存在 WSL 的人看误导提示)。
- 验法(Windows 专有 UI 在 Linux 上怎么验):临时 patch **构建产物**的 `platform`/`homedir` 两行 +
  `BOW_FAKE_PLATFORM=win32 BOW_FAKE_WIN_HOME='C:\Users\ruinb'` 跑真应用 —— 走真 `wslHint()`;
  断言文案、命令一致、复制按钮写进主进程剪贴板、按钮变「已复制」、命令行宽度不撑破布局,并截图存档。
  ⚠️ 渲染层 stub 不可行:`window.browserAPI` 是 contextBridge 暴露的**冻结**对象,赋值会静默失败。
