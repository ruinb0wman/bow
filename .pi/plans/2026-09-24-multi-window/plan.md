# 多窗口（重复启动开新窗口）+ MCP 适配

## 0. 目标与范围

**目标**：重复启动 bow（第二个实例被单实例锁挡下时）不再只是聚焦旧窗口，而是在已有进程里**开一个新窗口**；每个窗口有独立的标签集、独立的 Overlay 浮层、独立的内部页面标签（终端 / 笔记 / 设置）。MCP 保持单进程单端点，但能跨窗口寻址标签。

**已确认的决策**（来自用户）：

1. **触发方式**：重复打开 bow 实例 → 新窗口（不是「New Window 菜单」）。
2. **MCP 寻址**：全局唯一 `tabId`；`browser_list_tabs` 每条带 `windowId`；`browser_new_tab` 增加可选 `windowId`；页面类工具不传 `tabId` 时默认作用于**聚焦窗口**的活动标签。
3. **插件浮层 / 内部页面**：**每个窗口完全独立副本**（每窗口一套 Overlay、终端/笔记/设置都在触发它的那个窗口里打开）。

**不做**（本期）：把标签从 A 窗口 detach 到 B 窗口、跨窗口拖拽标签、会话持久化/窗口恢复。

**假设**：`stdio` MCP 实例是独立进程（`singleInstance.ts` 里 `isStdio` 恒返回 true，不抢锁），它自建的窗口天然只有一个，本计划不改它的语义。

---

## 1. 现状（为什么这不是加个按钮）

整个应用是**单窗口 + 单 TabManager 硬编码**，有四处「进程级单例」：

| 位置 | 现状代码 | 问题 |
| --- | --- | --- |
| `src/main/index.ts:44-46` | `let tabs: TabManager` / `let overlay` / `let kernel` | 全局唯一实例 |
| `src/main/index.ts:127-131` | `const mainWindow = createWindow(); tabs = new TabManager(mainWindow); overlay = new OverlayManager(mainWindow, tabs)` | 只建一个窗口 |
| `src/main/tabManager.ts:84` | `private nextId = 1` | **tabId 每个窗口从 1 开始 → 第二个窗口必然撞号** |
| `src/main/ipc.ts:18-25, 26-32` | `registerIpc(tabs, mainWindow, overlay, kernel)`，`sendToChrome` 闭包捕获 `mainWindow` | `ipcMain.handle` 是全局的，第二个窗口的 UI 会操作第一个窗口 |
| `src/main/ipc.ts:234-239` | `window:minimize/maximize/close` 全打在 `mainWindow` | 第二个窗口的标题栏按钮控制第一个窗口 |
| `src/main/closeConfirm.ts:24` | `let confirmed = false` 模块级 | 关 A 窗口后 B 窗口会**跳过**关闭确认 |
| `src/main/tabShortcuts.ts:71-76` | `app.on('web-contents-created')` → `getTabs()` 单例 | 无法分辨按键来自哪个窗口 |
| `src/main/index.ts:186-190` | `kernel.setBroadcaster` 只发 `mainWindow.webContents` | 插件事件到不了第二个窗口 |
| `src/main/plugins/kernel.ts:88-91` | `tabProvider` / `pageApi` 单例 | 插件拿不到「聚焦窗口」概念 |
| `src/main/mcp.ts:29` | `MCPDeps = { tabs: TabManager; kernel }` | MCP 只认一个 TabManager |

单实例/二次启动路径（`src/main/index.ts:79-91`）：

```ts
app.on('second-instance', (_e, argv, workingDirectory) => {
  focusFirstWindow(BrowserWindow.getAllWindows())   // ← 现在只聚焦
  if (IS_MCP_STDIO || !tabs) return
  const targets = collectOpenTargets(argv, ...)
  for (const target of targets) tabs.create(target)  // ← 开进旧窗口
})
```

`MCPDeps` 与 `target()`（`src/main/mcp.ts:29, 159-170`）：

```ts
export type MCPDeps = { tabs: TabManager; kernel: PluginKernel }

const target = (tabId?: number) => {
  if (tabId != null) {
    const hit = tabs.getView(tabId)                 // ← 全局查一个 Map
    ...
  }
  let hit = tabs.getActiveBrowsingView()            // ← 「活动」= 唯一窗口的活动标签
  ...
}
```

`browser_list_tabs`（`mcp.ts:513-527`）输出里**没有** windowId，AI 无法区分两个窗口的同名标签。

---

## 2. 设计：`WindowManager` + `WindowContext`

新增 `src/main/windows.ts`，引入窗口注册表。核心类型：

```ts
export interface WindowContext {
  id: number                 // 窗口 id，进程内唯一
  window: BrowserWindow
  tabs: TabManager
  overlay: OverlayManager
}

/** MCP / 内核只依赖这个窄接口（便于测试注入 FakeWindows） */
export interface WindowRegistry {
  byTabId(tabId: number): { ctx: WindowContext; record: TabRecord } | null
  focused(): WindowContext | null
  allTabs(): TabInfo[]
}

export class WindowManager implements WindowRegistry {
  // 进程级 tabId 分配器：所有窗口共用一个计数器
  allocTabId(): number
  create(opts?: { targets?: string[] }): WindowContext
  byId(id): WindowContext | null
  byWebContents(wc: WebContents): WindowContext | null  // chrome / overlay / 标签视图 / 内部页
  focused(): WindowContext | null                        // BrowserWindow.getFocusedWindow() → ctx；回退最近聚焦
  allTabs(): TabInfo[]                                   // 汇总，每条带 windowId
  broadcast(channel: string, payload: unknown): void     // 遍历所有 ctx：chrome + overlay + 内部页
  remove(ctx): void
  readonly list: WindowContext[]
}
```

**关键点**：

- **全局 tabId**：`TabManager` 构造改为 `new TabManager(win, { windowId, allocTabId, allocGroupId })`，把 `private nextId = 1` 换成 `allocTabId()`；`nextGroupId` 同样走全局分配器（否则 `ctx.tabs.list()` 里不同窗口的 `groupId` 会撞号）。`TabInfo` 增加 `windowId?: number`，由 `decorate()` 补上。
- **`byWebContents` 是路由核心**：`ipc.ts` / `tabShortcuts.ts` / `web-contents-created` 全部靠它从 `event.sender` 或 `contents` 反查窗口。为此 `OverlayManager` 要暴露 `hasWebContents(wc): boolean`（现在 `view` 是 private，`overlay.ts:23`）。
- **每窗口一套 wiring**：把 `index.ts` 里 127-224 行的单窗口接线抽成 `wireWindowContext(ctx, { targets })`（见 §3 步骤 1），第一个窗口与后续窗口共用同一条路径。

---

## 3. 分步实施（每步可独立验证）

### 步骤 1：引入 WindowManager，单窗口行为不变（纯重构）

**文件**：`src/main/windows.ts`（新）、`src/main/index.ts`、`src/main/ipc.ts`、`src/main/tabShortcuts.ts`、`src/main/closeConfirm.ts`、`src/main/overlay.ts`、`src/main/plugins/kernel.ts`、`src/main/tabManager.ts`（仅构造签名）

1. `windows.ts`：实现 `WindowManager` / `WindowContext` / `WindowRegistry`。
2. `TabManager`：构造签名改为 `constructor(window, opts: { windowId: number; allocTabId: () => number; allocGroupId: () => number })`；`nextId`/`nextGroupId` 改由分配器产出；`decorate()` 补 `windowId`。
3. `OverlayManager`：加 `hasWebContents(wc)` 与 `get webContents()`。
4. `closeConfirm.ts`：`let confirmed = false` → `WeakMap<BrowserWindow, boolean>`；`installCloseConfirm(ctx)` / `confirmWindowClose(ctx)`（每窗口独立确认态）。
5. `ipc.ts`：签名改 `registerIpc(windows: WindowManager, kernel)`；每个 handler 用 `const ctx = windows.byWebContents(e.sender)` 取窗口；`sendToChrome` 改成按 ctx 发送；`window:minimize/maximize/close` 打在 `ctx.window`；`tab:self` 走 `ctx.tabs.findTabIdByWebContents`；`ui:overlay` / `ui:chrome-height` / `groups:*` / `layouts:*` / `nav:*` 全部落到 ctx。
6. `tabShortcuts.ts`：签名改 `setupTabShortcuts(getWindows, getKernel)`；`before-input-event` 里 `const ctx = getWindows().byWebContents(contents)`，`null` 时回退 `getWindows().focused()`，仍为 `null` 则直接 return（DevTools detach 窗口等）；所有动作改打 `ctx.tabs` / `ctx.overlay`；`focusAddressBar(ctx.tabs)`。
7. `kernel.ts`：
   - `setBroadcaster` 由 index.ts 传 `(ch, p) => windows.broadcast(ch, p)`。
   - `setTabProvider(() => ({ list: () => windows.allTabs(), getActive: () => windows.focused()?.tabs.getActiveTabInfo() ?? null }))`。
   - `setPageApi`：`activeTabId` 取聚焦窗口；`execute`/`focus` 用 `windows.byTabId(tabId)` 解析；`openDevToolsTab(frontend, title, activate, windowId?)` 默认聚焦窗口。
   - `setUiHost`：`overlayId()` / `closeOverlay()` 单窗口语义 → 改为 `overlayIds(): string[]` + `closeOverlay(id)`，或直接 `closePluginOverlays(pluginId)`（`kernel.ts:215-216` 的 deactivate 分支改成遍历所有窗口关闭匹配前缀的浮层）。
8. `index.ts`：whenReady 里建 `windows = new WindowManager(...)`，`createWindow()` 里的 127-224 行搬进 `wireWindowContext`；**只调一次** `setupDevTools()` / `setupTabShortcuts()` / `registerIpc()`（`ipcMain.handle` 重复注册会抛错）。

**验证**：`npm test` 全绿（此步不改 MCP/测试契约，应零测试改动）；`npm run dev` 单窗口功能回归（标签、分屏、浮层、快捷键、关窗口确认、终端/笔记）。

### 步骤 2：全局 tabId + MCP 跨窗口寻址（仍单窗口运行）

**文件**：`src/main/mcp.ts`、`src/main/mcpHttp.ts`（仅类型透传）、`src/main/plugins/mcpHttpHost.ts`（仅类型）、`src/shared/types.ts`、`tests/fakeTabs.ts`、`tests/mcpServer.test.ts`、`tests/mcpHttp*.test.ts`

1. `MCPDeps` 改为 `{ windows: WindowRegistry; kernel: PluginKernel }`。
2. `target(tabId?)`：
   - `tabId != null` → `windows.byTabId(tabId)`；未命中报 `标签 N 不存在`。
   - 省略 → `windows.focused()` 的 `getActiveBrowsingView()`；一个都没有时在该窗口建 `about:blank`。
3. `wcOf(tabId)` / `loadFor` 等全部经 `windows.byTabId` 解析。
4. `browser_new_tab` 增加 `windowId: z.number().optional()`，默认聚焦窗口；`browser_press_key` 的 `Ctrl+T` 在**目标标签所属窗口**建标签，`Ctrl+W` 关目标标签。
5. `browser_list_tabs` 每条加 `windowId`，响应顶层加 `focusedWindowId`。
6. `browser_switch_tab`：激活后 `ctx.window.focus()`（切后台窗口的标签应把窗口提到前台）；`browser_get_info` 加 `windowId`。
7. `MCP_INSTRUCTIONS`（`mcp.ts:60-128`）补充：`tabId` 全局唯一、`windowId` 用法、省略即聚焦窗口。
8. 测试：新增 `tests/fakeWindows.ts`（包一层 `FakeTabs` 实现 `WindowRegistry` 三方法）；`mcpServer.test.ts:40` 与 `mcpHttp.test.ts:38`、`mcpHttpService.test.ts` 里的 `{ tabs }` 改成 `{ windows: fakeWindows(tabs) }`；补两条断言：`list_tabs` 带 `windowId`、`new_tab` 指定 `windowId` 落到对应窗口。

**验证**：`npm test`；`npm run test:mcp`；`browser_list_tabs` 输出含 `windowId`。

### 步骤 3：重复启动 → 新窗口

**文件**：`src/main/index.ts`、`src/main/singleInstance.ts`、`tests/singleInstance.test.ts`

1. `second-instance` 改成：`windows.create({ targets })`；`windows` 未就绪（`whenReady` 尚未完成）时只记录待开目标或直接 return。
2. `wireWindowContext(ctx, { targets })` 的 `did-finish-load` 分支：第一个窗口用 `initialTargets`，后续窗口用自己的 `targets`，都为空则开设置里的主页。
3. 新窗口位置做级联偏移（`createWindow` 现在硬编码 1280x820，`index.ts:21-24`），避免完全重叠。
4. `focusFirstWindow`（`singleInstance.ts:33`）不再被 second-instance 使用；若确认无其它调用方则删除并同步删 `tests/singleInstance.test.ts:44-69` 那组用例，否则保留并注明仅用于「无窗口时兜底」。
5. `app.on('web-contents-created')` 的外链处理（`index.ts:115-124`）改成 `windows.byWebContents(contents)?.tabs.create(url) ?? windows.focused()?.tabs.create(url)`（页面 `window.open` 开在同窗口；chrome/overlay 来源回退聚焦窗口）。

**验证**（手动，需真机）：
- 启动 bow，再次从桌面图标/终端启动 → 出现**第二个窗口**，第一个窗口原样保留。
- 第二个窗口有独立的标签栏，两个窗口的标签互不影响；MCP `browser_list_tabs` 同时列出两窗口标签且 `windowId` 不同。
- `browser_navigate { tabId: <窗口2的标签> }` 只导航窗口 2；省略 `tabId` 时作用于**聚焦窗口**。
- 关窗口确认、Ctrl+J 下载面板、Ctrl+, 设置、Ctrl+Shift+E 终端各自只在**触发它的窗口**生效。
- 关闭所有窗口后进程退出（`window-all-closed`）。

### 步骤 4：文档

**文件**：`docs/ARCHITECTURE.md`、`README.md`、`src/main/mcp.ts` 的 `MCP_INSTRUCTIONS`

- ARCHITECTURE §2 启动时序、§3 视图模型、§6 MCP 子系统补多窗口与 `windowId`；§9 IPC 通道表说明「按 `event.sender` 路由窗口」。
- README「重复窗口」一节（`README.md:177`、`108`、`270`）从「只把已有窗口带到前台」改为「重复启动开新窗口」。
- 记录 `tabId` 全局唯一、`windowId` 语义。

---

## 4. 对 MCP 的影响（直接回答用户）

**会，且必须改，但不改协议形状**：

1. **`tabId` 命名空间**：现在每个 `TabManager` 从 1 编号（`tabManager.ts:84`），两个窗口必然撞号。改法是把分配器提到进程级（步骤 1），`tabId` 仍是 `number`，对客户端透明。
2. **「活动标签」语义**：`target()` 省略 `tabId` 时原意是唯一窗口的活动标签（`mcp.ts:159-170`）。多窗口下改为**聚焦窗口**的活动标签；无聚焦窗口时回退最近聚焦的窗口。
3. **列表表达力**：`browser_list_tabs` 必须带 `windowId`（否则 AI 看到两个 `id: 1` 无法区分），`browser_new_tab` 需要可选 `windowId`。
4. **传输层不受影响**：HTTP 仍是单进程单端口（`mcpHttp.ts:36` 一个 `startMcpHttpServer`），stdio 仍是单连接。MCP 服务只需拿到 `WindowRegistry` 而不是单个 `TabManager`。**stdio 实例本身只有一个窗口**，其 `windowId` 恒为 1，行为与今天一致。
5. **插件工具**：走 `ctx.tabs` / `ctx.pages` 的插件（adblock 元素框选、element-fullscreen、device-inspect 的 DevTools 标签）需要内核把这两个面改成跨窗口解析（步骤 1.7）；否则第二个窗口里的插件操作会打到第一个窗口。

---

## 5. 测试与验证清单

- **单测**：步骤 1 应零改动通过；步骤 2 改 `mcpServer` / `mcpHttp*` 的 deps 构造并补 `windowId` 断言；步骤 3 更新 `singleInstance.test.ts`、`closeConfirm.test.ts`（每窗口确认态）。
- **新增单测建议**：`WindowManager` 的 `byTabId` / `focused` / `allTabs` 用纯对象假窗口测；`closeConfirm` 的「关 A 后 B 仍确认」用例。
- **MCP 冒烟**：`npm run test:mcp`、`npm run test:mcp:http`（多窗口下 `list_tabs` 与指定 `windowId` 建标签）。
- **真机**：见步骤 3 验证清单。

---

## 6. 风险与未知

1. **改动面大**：`index.ts` 是启动时序的唯一权威（ARCHITECTURE §2 明确「顺序有语义」），把窗口接线抽成 `wireWindowContext` 时容易打乱「hook 必须先于窗口创建」的约束（`setupDevTools` / `setupTabShortcuts` / `installHooks` 必须在任何窗口前）。重构后必须复核这一步。
2. **`ctx.tabs.list()` 的语义变化**：从「本窗口标签」变成「所有窗口标签」，插件（element-fullscreen 的 `findTab(tabId)`、adblock）若假设 id 局部唯一，需一并核对；`TabInfo.windowId` 给了它们区分的依据。
3. **DevTools detach 窗口**：它是 Electron 自己开的 `BrowserWindow`，不在 `WindowManager` 里；`byWebContents` 解析不到 → 快捷键回退聚焦窗口或跳过，需明确取舍（本计划取「回退聚焦窗口，仍解析不到则跳过」）。
4. **全局设置/布局/书签/历史是共享 JSON**（`stores.ts`）：两个窗口同时改设置会 last-write-wins，不做冲突处理（可接受，但要写进文档）。
5. **`second-instance` 的时序**：极早到达时 `windows` 尚未建好；需要和现有 `!tabs` 守卫同思路处理，否则丢目标或崩。
6. **`focusFirstWindow` 的删除**：需先确认没有其它调用方（当前只有 `index.ts:81` 与测试）。
7. **未能从代码确定**:macOS 的 `app.on('activate')`(Dock 点击、无窗口时)当前未实现;多窗口后是否要补属于平台行为,未验证。

---

## 7. 实施记录(2026-09-24)

**已完成全部四步**(步骤 1+2 合并提交)。新增/改动:

- 新增 `src/main/windows.ts`(`WindowManager`/`WindowContext`/`WindowRegistry`):进程级 `tabId`/`groupId` 分配器、`byWebContents`/`byTabId`/`focused`/`allTabs`/`broadcast`/`remove`。
- `TabManager` 构造改为 `(window, ids: TabIdAllocator)`;`nextId`/`nextGroupId` 全部走分配器;`TabRecord` 导出。
- `index.ts`:抽出 `createWindowContext()` / `wireWindowContext()`;`second-instance` → 开新窗口;kernel 依赖与 UI 宿主改经 `WindowManager`。
- `ipc.ts`:拆成 `registerIpc(windows, kernel)`(全局只注册一次,handler 用 `event.sender` 反查窗口)+ `wireWindowIpc(ctx)`(每窗口接线)。
- `tabShortcuts.ts`:按键来源 `byWebContents` → 窗口,回退聚焦窗口。
- `closeConfirm.ts`:确认态从模块级布尔改为按窗口 `WeakSet`。
- `mcp.ts`:`MCPDeps = { windows, kernel }`;`target()` 跨窗口解析;`browser_new_tab` 加 `windowId`;`browser_list_tabs` 带 `windowId` + `focusedWindowId`;`browser_switch_tab` 调 `windows.markActive()`(并把窗口提到前台);`browser_get_info` 带 `windowId`。
- `kernel.ts`:`PluginUiHost` 改为 `closePluginOverlays(pluginId)`;`openDevToolsTab` 加 `windowId`。
- 文档:README 单实例/重复窗口/关闭窗口;ARCHITECTURE §0/§1/§2/§3/§6/§9/§5.2。
- 测试:新增 `tests/fakeWindows.ts`、`tests/windows.test.ts`(5 条);`mcpServer.test.ts` 新增多窗口寻址 2 条;`closeConfirm.test.ts` 新增按窗口隔离 1 条;`fakeTabs` 补 `findTabIdByWebContents`。

**验证**:`tsc` node+web 均通过;`vitest run` **47 文件 / 1021 用例全绿**;`npm run build` 通过。

**真机 E2E(2026-09-24,真实 Wayland/niri 桌面)**:
- 脚本:临时脚本(隔离 `--user-data-dir=/tmp/...`)启动实例 1(`MCP_HTTP=1`)+ 实例 2(重复启动),再用 MCP HTTP 客户端断言。**10/10 PASS**:
  端点监听 / 启动后 1 个窗口 / 重复启动后 2 个窗口(`windowIds=[1,2]`)/ `focusedWindowId` 存在 / tabId 全局唯一 /
  `new_tab{windowId}` 落到目标窗口 / 按返回 tabId 跨窗口 `get_info` / 列表含新标签 / `switch_tab` 返回 windowId / `switch_tab` 后 `focusedWindowId` 变为目标窗口。
- **发现并修复的真问题**:Wayland 下窗口管理器会拒绝 `window.focus()`,导致 `BrowserWindow.getFocusedWindow()` 不跟着 `browser_switch_tab` 变 → 省略 tabId 的后续调用会仍打在旧窗口。修法:`WindowManager.markActive(ctx)` 显式指定默认窗口(优先级高于 OS 焦点,真实 focus 事件一到即失效)。
- `npm run test:mcp`(真实 Electron + stdio)全部通过:44 个工具、instructions 下发、导航/搜索/点击/输入/截图/整页截图/书签/adblock/等待语义均正常。
  ⚠️ 该冒烟测试会往**真实** profile(`~/.config/mcp-browser`)写一条 `Example` 书签(项目既有行为,非本次引入);已把 `bookmarks.json` 还原为 `[]`。

**待真机验证(已由上面的隔离 E2E 覆盖,仅剩人工观感)**:
1. 启动 bow → 再次启动 → 第二个窗口出现且第一个窗口原样保留(已验证);
2. 两窗口标签互不影响;`browser_list_tabs` 的 `windowId`/`focusedWindowId` 正确;指定后台窗口 `tabId` 的页面操作生效(已验证);
3. Ctrl+J / Ctrl+, / Ctrl+Shift+E / 元素框选只在**触发它的窗口**生效;关窗口确认按窗口隔离(单测覆盖 + 需人工看观感);
4. 关闭所有窗口后进程退出(需人工确认)。

**工作区注意**:`package.json`、`scripts/dist.mjs`、`scripts/verify-dist.mjs`、`src/plugins/default-browser/main.ts` 有**本次改动之前就存在**的未提交修改(AppImage/默认浏览器),与本计划无关,未触碰。
