# MCP 专属窗口：agent 调用不再落在用户正在用的窗口

## 1. 目标与结论

**目标**：pi（或任何 MCP 客户端）通过 bow 的 MCP 操作浏览器时，操作目标是一个 bow 为它自动创建并复用的
**专属窗口**，绝不落在用户正在浏览的主窗口上；用户主窗口保持原样，agent 也仍能按需（显式传 `tabId`）访问它。

**已确认的四个决策**（2026-10-02 用户选定）：

| 决策点 | 选择 |
| --- | --- |
| 隔离粒度 | 进程内**一个** agent 窗口，首次需要时自动创建、之后复用（不改 pi 配置、HTTP 端点保持无状态） |
| 用户主窗口 | **软隔离**：省略 `tabId` 只作用于 agent 窗口；显式传 `tabId`（哪怕是用户窗口里的标签）仍允许 |
| 视觉标识 | **轻标识**：窗口标题加 ` · Agent` 后缀 + agent 窗口相对聚焦窗口级联偏移 32px |
| 落地范围 | HTTP + stdio 统一按「窗口角色」解析默认目标 |

**假设**：agent 仍然复用常驻进程的默认 session（`persist:` 无分区），因此 agent 窗口与主窗口共享
cookies / 登录态 —— 这正是继续用 HTTP 模式的理由，本计划**不做** cookie 隔离。

---

## 2. 现状（从代码读到的行为）

### 2.1 触发条件

用户 pi 的 MCP 配置（`~/.pi/agent/mcp.json`）走 **HTTP**：

```json
"browser": { "url": "http://127.0.0.1:8765/mcp", "lifecycle": "keep-alive",
             "directTools": ["browser_navigate","browser_snapshot","browser_wait","browser_click","browser_eval"] }
```

端点由常驻主进程的 mcp-http 插件提供（`src/plugins/mcp-http/main.ts`，默认开启），
`McpHttpHost.attach(deps)` 拿到的 `deps = { windows, kernel }`（`src/main/index.ts:311`）。
所以 agent 的每一次工具调用都打在**用户这个常驻进程**里。

### 2.2 `src/main/mcp.ts` 的默认目标 = 聚焦窗口（这就是痛点）

`target()`（`src/main/mcp.ts:164-190`）：

```ts
tool('browser_navigate', ...) // 转成 JS 语义的原文
// 当前操作目标视图:可指定 tabId(全局唯一,经 WindowManager 跨窗口解析),默认取**聚焦窗口**
// 的活动标签(活动标签是内部页面时退到最近浏览的页面标签);
const target = (tabId?: number) => {
  if (tabId != null) { ... }        // ← 显式:允许任何窗口(软隔离要保留)
  const ctx = windows.focused()      // ← 省略 tabId 时落在这里 = 用户正在看的窗口
  ...
}
```

同文件还有两处直接 `windows.focused()`：`browser_navigate`（`:227`）、`browser_search`（`:263`）；
`browser_new_tab` 缺省（`:508`）也是 `windows.focused()`。`browser_list_tabs`（`:539-556`，`:542` 是 `focusedWindowId`），`MCP_INSTRUCTIONS`（`:67-136`）把「省略 tabId 时作用于**当前聚焦窗口**」写成了契约。
`browser_switch_tab`（`:526-536`）用 `windows.markActive(hit.ctx)` 改「后续默认窗口」并 `window.focus()`。

### 2.3 窗口注册表与创建路径

`src/main/windows.ts` 的 `WindowContext = { id, window, tabs, overlay, toasts }`，
`WindowRegistry` 只有 `byId / byTabId / focused / markActive / allTabs`；`focused()` 的优先级是
「`markActive` 显式指定 → OS 焦点 → 最近聚焦 → 最后创建」。
类注释明确「本类不负责创建 BrowserWindow —— 窗口的接线…留在 `index.ts`，`register()` 只登记已建好的三件套」。

窗口创建只有一个入口 `src/main/index.ts:25-45`（`createWindow`）+ `:101-112`（`createWindowContext`）：

```ts
function createWindowContext(targets: string[]): WindowContext {
  const win = createWindow()                       // 固定 1280x820、frame:false、<title>Bow</title>
  ...
  const ctx = windows!.register(win, tabs, overlay, toasts)
  wireWindowContext(ctx, targets)
}
```

调用方两处：`second-instance`（`:89-98`，重复启动开新窗口）、`whenReady` 首窗口（`:302`）、无其它。
`wireWindowContext`（`:116`）的 `did-finish-load`（`:180-192`）负责建标签：首个窗口用它保证 `registerIpc()` 已挂好
`tab:list` 广播。

### 2.4 stdio 模式天然隔离，但角色没被表达

`stdio` 不抢单实例锁（`src/main/singleInstance.ts:27-30`），是**独立进程**，自建窗口 —— 本来就碰不到
用户主窗口。本计划只是把「这个窗口是 agent 的」显式化，让两条传输共用同一套解析。

---

## 3. 设计

### 3.1 窗口角色

```ts
// src/main/windows.ts
export type WindowRole = 'user' | 'agent'

export interface WindowContext {
  id: number
  role: WindowRole          // 新增
  window: BrowserWindow
  tabs: TabManager
  overlay: OverlayManager
  toasts: ToastManager
}
```

- `'user'`：启动首窗口（非 stdio）、`second-instance` 开的新窗口、以及没有任何 MCP 参与时的一切窗口。
- `'agent'`：MCP 需要默认目标且当前没有 agent 窗口时由 `WindowManager.createAgentWindow()` 创建；
  stdio 进程的启动首窗口也是 `'agent'`。

### 3.2 `WindowRegistry` 新增三个方法（窄接口，FakeWindows 可注入）

```ts
export interface WindowRegistry {
  ... // byId / byTabId / focused / markActive / allTabs 不变

  /** MCP 的默认窗口:显式指定的优先,否则最近的 agent 窗口;**不创建**,没有就返回 null */
  agentWindow(): WindowContext | null
  /** 建一个新的 agent 窗口并设为 MCP 默认窗口;没有创建能力时返回 null */
  createAgentWindow(targets?: string[]): WindowContext | null
  /** 显式指定 MCP 后续操作的默认窗口(仅由 browser_switch_tab 在 agent 窗口间调用) */
  markAgentActive(ctx: WindowContext): void
}
```

`WindowManager` 实现（新增私有 `agentActiveId: number | null`）：

```ts
agentWindow(): WindowContext | null {
  if (this.agentActiveId != null) {
    const hit = this.byId(this.agentActiveId)
    if (hit?.role === 'agent') return hit
    this.agentActiveId = null
  }
  // 回退:最近登记的存活 agent 窗口(用户手动开了第二个 agent 窗口也能认)
  const newest = [...this.contexts].reverse().find((c) => c.role === 'agent') ?? null
  if (newest) this.agentActiveId = newest.id
  return newest
}

createAgentWindow(targets: string[] = []): WindowContext | null {
  if (!this.deps.createWindow) return null
  const ctx = this.deps.createWindow(targets, 'agent')  // 由 index.ts 注入,负责接线
  this.agentActiveId = ctx.id
  return ctx
}

markAgentActive(ctx: WindowContext): void { this.agentActiveId = ctx.id }
```

`remove(ctx)` 里补 `if (this.agentActiveId === ctx.id) this.agentActiveId = null`。

**与 `markActive` 分开的理由**：`markActive` 是用户侧（`ipc.ts:327` 点通知卡片）与 Wayland 焦点兜底用的
「聚焦窗口」，`focused()` 会在真实 focus 事件到来时清掉它；MCP 的默认窗口**不该被用户的鼠标点击或 OS 焦点
改变**，所以独立一个指针，且**不**在 `focus` 事件里清除。

`WindowManagerDeps` 增加：

```ts
export interface WindowManagerDeps {
  getFocusedWindow?: () => BrowserWindow | null
  /** index.ts 注入:建窗口 + 接线(WindowManager 自己不碰 BrowserWindow 创建路径) */
  createWindow?: (targets: string[], role: WindowRole) => WindowContext
}
```

### 3.3 MCP 侧统一取默认目标

`src/main/mcp.ts` 新增：

```ts
/** MCP 的默认操作窗口:agent 专属窗口;没有就按需建一个。**绝不回退到用户正在用的窗口** */
const agentCtx = (): WindowContext | null => windows.agentWindow() ?? windows.createAgentWindow()
```

改动点（全部把 `windows.focused()` 换成 `agentCtx()`）：

| 位置 | 现在 | 之后 |
| --- | --- | --- |
| `target()`（`:175`，函数体 `:164-190`） | `windows.focused()` | `agentCtx()` |
| `browser_navigate` 省略 tabId（`:227`） | `windows.focused()` | `agentCtx()` |
| `browser_search` 省略 tabId（`:263`） | `windows.focused()` | `agentCtx()` |
| `browser_new_tab` 缺省 windowId（`:508`） | `(...) ?? windows.focused()` | `(...) ?? agentCtx()` |
| `browser_list_tabs`（`:539-556`） | 只给 `focusedWindowId` | 补 `mcpWindowId: windows.agentWindow()?.id ?? null`（**不创建**）、每条 tab 补 `windowRole` |
| `browser_switch_tab`（`:526-536`） | 无条件 `markActive` + `window.focus()` | 见下 |

`browser_switch_tab` 的新语义（软隔离下的关键取舍）：

```ts
hit.ctx.tabs.activate(tabId)
if (hit.ctx.role === 'agent') {
  if (!hit.ctx.window.isDestroyed()) hit.ctx.window.focus()
  windows.markAgentActive(hit.ctx)          // 只在 agent 窗口之间切换默认目标
} else {
  // 目标标签属于用户自己的窗口:激活标签(显式意图),但**不**把它设成 MCP 的长期默认窗口,
  // 也不 window.focus() —— 否则 agent 一次 switch 就会长期劫持用户窗口。
  log('browser_switch_tab 指向用户窗口,不改变 MCP 默认窗口', tabId, hit.ctx.id)
}
return textContent({ ok: true, activate: true, tabId, windowId: hit.ctx.id, windowRole: hit.ctx.role,
                     mcpWindowId: windows.agentWindow()?.id ?? null })
```

理由：用户选的「软隔离 = 显式才可访问」指的是**每一次调用显式传 `tabId`**；`browser_switch_tab` 是
**粘性**状态，一旦允许它把默认目标钉在用户窗口，后续所有省略 `tabId` 的调用都会打进用户窗口，
等于隔离失效。返回体带 `mcpWindowId` 让模型知道默认目标实际在哪。

### 3.4 创建路径与轻标识（`src/main/index.ts`）

```ts
function createWindow(role: WindowRole = 'user'): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 720, minHeight: 480,
    ...(role === 'agent' ? agentCascade() : {}),   // 相对聚焦窗口 +32/+32,并按 workArea 夹住
    frame: false, show: false, backgroundColor: '#1e1f24',
    webPreferences: { preload: ..., contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  ...
}

function createWindowContext(targets: string[], role: WindowRole = 'user'): WindowContext {
  const win = createWindow(role)
  ...
  const ctx = windows!.register(win, tabs, overlay, toasts, role)
  wireWindowContext(ctx, targets)
}
```

- `windows = new WindowManager({ createWindow: (targets, role) => createWindowContext(targets, role) })`（`:215`）。
- 首窗口：`createWindowContext(initialTargets, IS_MCP_STDIO ? 'agent' : 'user')`（`:302`）。
- `second-instance` 保持 `'user'`（`:97`）。
- 标题标识放在 `wireWindowContext`（每窗口接线只此一处）：

```ts
if (ctx.role === 'agent') {
  // chrome 页面的 document.title（index.html 的 <title>Bow</title>）会同步到窗口标题,
  // 不拦掉的话 setTitle 会被覆盖。拦掉后 agent 窗口标题恒为 AGENT_WINDOW_TITLE。
  win.on('page-title-updated', (e) => e.preventDefault())
  win.setTitle(AGENT_WINDOW_TITLE)   // 'Bow · Agent'
}
```

`agentCascade()` 用 `screen.getDisplayMatching(refBounds).workArea` 把位置夹在屏幕内，
保证不会把 agent 窗口开到屏幕外（`screen` 只在 ready 后可用，调用点都在 ready 之后）。

### 3.5 `MCP_INSTRUCTIONS` 契约改写（`src/main/mcp.ts:67-136`）

必须改的三段（它才是 LLM 唯一必读的行为契约）：

- 多窗口段：`省略 tabId 时作用于**当前聚焦窗口**` → `省略 tabId 时作用于 bow 为 MCP 客户端维护的**专属窗口**
  (响应里的 mcpWindowId;没有就自动创建一个,不会动用户正在浏览的窗口)。要操作某个具体标签就显式传 tabId —— 传的是
  用户窗口里的 tabId 时也能操作(列表里 windowRole: "user" 标出),这属于显式请求。`
- `browser_switch_tab` 段：改成「只会在 agent 窗口之间切换默认目标;指向用户窗口时只激活标签、不改默认目标」。
- 新增一句：agent 窗口标题带 ` · Agent` 后缀、会自动级联偏移,用户可随时手动关掉;不要每个操作都期望新窗口。

---

## 4. 步骤（每步可独立验证）

### 步骤 1：`src/main/windows.ts` — 窗口角色 + agent 窗口指针

1. 加 `WindowRole`、`WindowContext.role`；`register(..., role: WindowRole = 'user')`（默认值让现有调用不破）。
2. 加 `WindowRegistry` 三方法 + `WindowManager` 实现（§3.2）+ `remove()` 清理 `agentActiveId`。
3. `WindowManagerDeps.createWindow?: (targets: string[], role: WindowRole) => WindowContext`。
4. 导出 `AGENT_WINDOW_TITLE` 与 `agentCascade()` 所需的小工具（或放到 `windows.ts` 供 index 用；边框计算依赖
   Electron `screen`，实现留在 `index.ts`，`windows.ts` 只导出常量）。

**验证**：`npm test -- tests/windows.test.ts`（此步新增用例，见步骤 5）。此步不改 MCP，单窗口行为不变。

### 步骤 2：`src/main/index.ts` — 接线与标识

1. `createWindow(role)`：agent 级联偏移 + 标题拦截/`setTitle`。
2. `createWindowContext(targets, role = 'user')`；`register(..., role)`；把 `role` 传给 `wireWindowContext`（或从 ctx 读）。
3. `new WindowManager({ createWindow: (t, r) => createWindowContext(t, r) })`。
4. 首窗口 `role = IS_MCP_STDIO ? 'agent' : 'user'`。

**验证**：`npm run dev` —— 普通启动窗口标题/位置不变；`MCP=stdio npm run mcp` 起的窗口标题为 `Bow · Agent`；
`npm test` 全绿（此步不改契约）。

### 步骤 3：`src/main/mcp.ts` — 默认目标改走 agent 窗口

1. 新增 `agentCtx()`。
2. 上表五处替换（`target` / `navigate` / `search` / `new_tab` / `list_tabs`）。
3. `browser_switch_tab` 新语义 + 返回体加 `windowRole` / `mcpWindowId`。
4. `browser_list_tabs` 每条 tab 补 `windowRole`（用 `windows.byId(t.windowId!)?.role`，**不改** `TabInfo` 类型）。
5. 改写 `MCP_INSTRUCTIONS`（§3.5）。

**验证**：`npm test -- tests/mcpServer.test.ts`；真机 `npm run test:mcp`（stdio 语义不变）。

### 步骤 4：`tests/fakeWindows.ts` — 让假注册表满足新接口

- `ctx` 补 `role`（新增 option，默认 `'agent'`，这样绝大多数单窗口用例的 `agentWindow()` 直接返回它、行为不变）。
- 补 `agentWindow: () => ctx`、`createAgentWindow: () => ctx`、`markAgentActive: () => {}`。
- 新增 option 允许指定 `role: 'user'` 且 `agentWindow()` 返回 `null`（用于隔离用例）。

**验证**：`npm test` 中 `mcpServer` / `mcpHttp*` 全绿（它们都经这个 fake）。

### 步骤 5：测试补齐

`tests/windows.test.ts`：

- `register(..., 'agent')` 后 `ctx.role === 'agent'`；无 agent 窗口时 `agentWindow()` 为 `null`。
- `createAgentWindow()` 调用了注入工厂、设为默认、返回该窗口；工厂缺失时返回 `null`。
- agent 窗口 `closed` 后 `agentWindow()` 不再返回它（并回退到别的 agent 窗口 / null）。
- `markAgentActive` 在多个 agent 窗口间切换；对 `'user'` 窗口调用后 `agentWindow()` 仍返回 agent 窗口。

`tests/mcpServer.test.ts`（重写「多窗口寻址」describe）：

- **隔离核心**：注册表 = 1 个 user 窗口 + 一个能建窗口的 `createAgentWindow` 假工厂 →
  `browser_navigate {url}` 落在**新建的 agent 窗口**（工厂被调用一次），user 窗口 `listTabs()` 保持为空；
  第二次调用**复用**同一 agent 窗口（工厂仍只调过 1 次）。
- `browser_list_tabs` **不**触发建窗口（工厂调用次数不变），返回 `mcpWindowId` 与每条 tab 的 `windowRole`。
- 软隔离：`browser_get_info { tabId: userTabId }` 成功且 `windowId` = 用户窗口 id。
- `browser_new_tab` 省略 windowId → 落 agent 窗口；显式 `windowId` 为用户窗口 → 落用户窗口。
- `browser_switch_tab`：目标是 user 窗口里的标签 → `mcpWindowId` **不变**（仍指 agent 窗口）；
  目标是 agent 窗口 → `mcpWindowId` 跟着变。
- 现有断言 `focusedWindowId`（`:562`、`:575`、`:593`）按新语义改写（`focusedWindowId` 不再等于默认目标）。

**验证**：`npm test`（期望全绿，重点看 `windows` / `mcpServer` / `mcpHttp*` / `mcpActivity`）。
真机：`npm run test:mcp:http`（先起常驻 bow，在主窗口里留一个标签）→ 断言主窗口标签数不变、
冒烟脚本新标签都开在 agent 窗口（脚本用返回的 `tabId` 驱动，无需改动，只需人工确认窗口归属）。

### 步骤 6：文档同步

| 文件 | 改什么 |
| --- | --- |
| `README.md` | `:111-118`「单实例 / 多窗口」段：省略 `tabId` 现在是作用 **agent 专属窗口**（自动创建+复用），不再是聚焦窗口；`browser_switch_tab` 新语义；agent 窗口标题带 ` · Agent`。`:275-280`、`:339+` 工具表与 `:382+` 行为约定同步。 |
| `docs/ARCHITECTURE.md` | §3「视图模型」：`WindowContext` 加 `role`，列新三个方法；§6.2 工具表 `browser_list_tabs` 行加 `mcpWindowId`/`windowRole`、`browser_switch_tab` 行改默认目标语义；§6.3 `target()` 段改「省略 tabId → agent 窗口」；§12 漂移表视情况补一行。 |
| `.pi/skills/bow-browser/SKILL.md` | 「标准工作流 / 参数速查 / 边界」补一句：默认操作目标是 agent 专属窗口（标题 ` · Agent`），不会动用户窗口；要操作用户窗口里的页需显式 `tabId`（`list_tabs` 的 `windowRole` 可区分）。工具数不变（仍是 19 核心）。 |

**验证**：`grep -rn "聚焦窗口" README.md docs/ARCHITECTURE.md .pi/skills/bow-browser/SKILL.md src/main/mcp.ts`
应只剩解释旧行为/新语义的段落，没有「省略 tabId 落在聚焦窗口」的残留。

---

## 5. 风险、未知与不做

### 风险

1. **`browser_switch_tab` 语义变化**是对外契约的破坏性调整（已写进 `MCP_INSTRUCTIONS` 与 README）。
   缓解：返回体带 `mcpWindowId`，模型能立刻看到默认目标；`windowRole` 标明窗口归属。
2. **`browser_list_tabs` 的 `focusedWindowId` 语义变「参考信息」**：仍保留该字段（用户正在看哪个窗口），
   但不再是默认目标。旧文档/提示词若依赖它需要一并改（步骤 6）。
3. **首个 agent 窗口的创建时机**：由第一次**需要默认目标**的调用触发（页面工具 / `navigate` / `search` /
   `new_tab`）；`browser_list_tabs`、`browser_close_tab`、显式 `tabId` 的工具不会凭空开窗。这是刻意的，
   但意味着「MCP 一连接就弹窗」不会发生 —— 若用户期望连上就有一个窗口，需另讨论。
4. **窗口标题拦截** `page-title-updated` 只对 agent 窗口 `preventDefault`；不影响普通窗口。
   `frame:false` 下标题只在 WM / 任务栏可见（niri 的窗口列表），chrome UI 内不可见 —— 若用户要「在浏览器里
   一眼看出」，需要动渲染层（本次不做，属已排除的「加明显标识」选项）。
5. **插件贡献的 MCP 工具**（`adblock_*` / `device_*` / `downloads`）多数不依赖 bow 窗口（`device_*` 作用于
   手机 CDP target）。`ctx.pages.activeTabId()`（`kernel.setPageApi` 的 `windows.focused()`）仍是聚焦窗口语义；
   目前没有插件 MCP 工具在省略 tab 时走它（`passwords` / `quark` 不贡献 MCP 工具），**本计划不传播角色到这层**，
   列为已知缺口。

### 未知

- `screen.getDisplayMatching()` 在 niri/Wayland 下返回的 `workArea` 是否可靠（多显示器 + 分数缩放的
  偏移/夹取效果需要真机看一眼）。若不可靠，退化为「只在同屏内 +32/+32，不夹取」。
- `win.setTitle()` 在 niri 下是否真的覆盖 `app_id` 之外的窗口标题显示（需真机确认；不影响隔离行为）。

### 明确不做

- ❌ 新增 `browser_new_window` / `browser_close_window`：用户选了「共用一个 agent 窗口」，多开窗口会带来
  窗口堆积与关窗确认（`closeConfirm.ts` 对 ≥2 标签的窗口会拦下 `close`）的交互复杂度。agent 需要干净环境时
  用 `browser_close_tab` + 复用窗口即可。
- ❌ HTTP 端点改为有状态 session（per-client 窗口）：本次不需要（用户选了共享窗口）。
- ❌ cookie / storage 隔离（`session.fromPartition`）：agent 继续共享主窗口登录态。
- ❌ 跨窗口拖标签、窗口会话持久化（沿用多窗口计划的不做项）。

---

## 6. 执行结果(2026-10-02)

全部步骤 1–6 已落地。

**单元测试**:`npx vitest run` → **1253 passed / 1 failed**。唯一失败是
`tests/mcpHttp.test.ts > DNS rebinding 防护:非白名单 Host 被拒`,原因与本次改动无关:
Node 26 的 http 客户端对 `options.headers.Host` 与 `options.host:port` 不一致**同步抛错**
(`node -e` 可复现),请求根本没发出。属于既有环境问题,未改。

**编译**:`npx tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json` 均无输出;`npm run build` 成功。

**真机 stdio 冒烟**:`SMOKE_LD_LIBRARY_PATH=~/.cache/bow-alsa/usr/lib npm run test:mcp` → ✅ 全部通过
(42 个工具、instructions 4115 字符、等待/截图/插件工具断言全绿)。

**真机 HTTP 隔离验证**(隔离实例:`BOW_ELECTRON_ARGS=--user-data-dir=/tmp/bow-aw-test MCP_HTTP_PORT=8799`):

```
BEFORE {"focusedWindowId":1,"mcpWindowId":null,       "tabs":[[1,"user","https://www.google.com.hk/"]]}
NEW_TAB {"ok":true,"tabId":2,"windowId":2,"url":"https://example.com"}
AFTER  {"focusedWindowId":1,"mcpWindowId":2,          "tabs":[[1,"user",…],[2,"agent","about:blank"]]}
```

即:第一次页面工具调用**自动新建了 agent 窗口**(windowId 2),用户窗口(id 1)的标签原样未动;
`mcpWindowId` 从 null 变成 2。软隔离(显式 tabId)、`windowRole`、`list_tabs` 不建窗口等由单测覆盖。

**仍待在真机上看一眼的两点**(§5 未知):`screen.getDisplayMatching().workArea` 在 niri 下的级联位置是否合理;
`win.setTitle('Bow · Agent')` 在 niri 窗口列表里是否可见。
