# 番茄钟插件（`pomo`）实施方案

- 日期：2026-10-03
- 模式：plan → 已实现（2026-10-03，build 模式执行完毕；验证见文末 §8）
- 已定决策（本次问答用户拍板）：
  1. **UI 形态：工具栏倒计时按钮 + 锚定下拉面板**（`below-chrome` 浮层，与「分屏」菜单同款）
  2. **范围：纯计时器**（专注 / 短休 / 长休 + 第几个番茄 + 今日完成数），不绑任务、不统计站点
  3. **给 AI 暴露 MCP 工具**：`browser_pomo_status` / `browser_pomo_start` / `browser_pomo_pause` / `browser_pomo_skip`（4 个）
  4. **提醒三件套**：系统桌面通知 + 提示音 + 应用内高亮闪烁

---

## 1. 目标与假设

**目标**：给 bow 加一个内置插件 `pomo`，提供番茄工作法计时：专注 25min / 短休 5min / 长休 15min，每 4 个番茄进一次长休。计时器跑在**主进程**（权威时钟），工具栏按钮实时显示 `mm:ss`，点开是锚定下拉面板（开始 / 暂停 / 跳过 / 重置 + 今日完成数），阶段结束时系统通知 + 提示音 + 按钮闪烁，并可通过 MCP 被 AI 查询与控制。

**假设**（若与实际不符请纠正）：

- 单机自用，不需要多窗口同步之外的复杂状态（多窗口天然共享主进程同一份状态）。
- 计时以**主进程时钟**为准，跨休眠 / 系统时间跳变用「每秒检查 `now >= endsAt`」兜底，不用长 `setTimeout`。
- 应用被杀 / 重启后，若持久化的计时已过期：**推进一个阶段并静默暂停**（不补发通知，避免开屏弹一堆）。
- 声音走渲染层 WebAudio（无二进制资源）；`AudioContext` 在用户第一次点番茄按钮/开始键时解锁，此后阶段结束能响；从未交互过则静默失败（可接受）。
- 面板不做「再点一次按钮收起」的 toggle 语义（插件浮层无法自行关闭，见 §5 的取舍），关闭只靠点面板外 / Esc / ×，与现有 `downloads`/`passwords` 一致。

---

## 2. 现状依据（读过的真实代码，不是猜的）

| 事实 | 出处 |
| --- | --- |
| 插件两侧契约：`src/plugins/<id>/main.ts` = `PluginMain`；`ui.ts` = `PluginUiContribution` | `src/main/plugins/types.ts`、`src/renderer/src/plugins/types.ts`、`docs/ARCHITECTURE.md` §5.1 |
| 边界由测试强制：`main.ts` 不得引 `.vue`/`@renderer`；`ui.ts` 不得引 `electron` | `tests/pluginBoundaries.test.ts` |
| `tsconfig.node.json` 的 `include` **只收录固定文件名**；但 `src/plugins/*/shared.ts` 已经在列（web/node 两处都在） | `tsconfig.node.json:30`、`tsconfig.web.json:27` |
| 工具栏插槽组件 = 普通 Vue 组件，直接用 `window.browserAPI`；可显示角标/百分比 | `src/plugins/downloads/ui/DownloadsButton.vue`（`.db-pct` 就是先例） |
| 工具栏按钮打开浮层：`api.showOverlay({ id:'plugin:<id>:panel', placement, payload })` | `src/plugins/passwords/ui/PasswordsButton.vue:23`、`…/downloads/ui/DownloadsButton.vue:60` |
| `below-chrome` 条带从 chrome 底边起铺到窗口底；`payload.rect` 供面板自己贴按钮定位；`meta.bandTop` 由主进程注入 | `src/main/overlay.ts:93,118,158`、`src/renderer/src/components/SplitMenu.vue:20-26` |
| Overlay 宿主把 `payload` 与 `band-top` 作为 props 传给插件组件 | `src/renderer/src/overlay/OverlayApp.vue:67-72` |
| 面板发 `overlay-event` 事件：`event === 'close-request'` 由主进程统一关闭浮层（插件不必注册） | `src/main/ipc.ts:240,255-259` |
| 插件 IPC：`ctx.ipc.handle(method, fn)` ← 渲染层 `api.plugins.invoke(id, method, ...args)`；`ctx.ipc.emit(event, payload)` → chrome/overlay/内部页面的 `api.plugins.onEvent` | `src/main/plugins/kernel.ts:389-391`、`src/preload/index.ts:111-119` |
| 插件存储在 `<userData>/<file>`，`storage()` 按文件名缓存，`get/set/setRaw` | `src/main/plugins/types.ts:22-26`、`docs/ARCHITECTURE.md` §5.2 |
| MCP 工具：`ctx.mcp.tool(name, { description, inputSchema }, handler)`；返回体用 `textContent()`/`errorContent()`（`zod` raw shape） | `src/plugins/downloads/main.ts:22,521-548`、`src/main/plugins/mcpResult.ts` |
| 全局热键：`ctx.shortcuts.register(HotkeySpec, handler)`（`Ctrl/Cmd+Shift+O` 当前空闲） | `src/plugins/passwords/main.ts:522`、`src/shared/shortcuts.ts:240-258` |
| 插件必须在 `BUILTIN_PLUGINS` 与 `PLUGIN_UI` 各登记一行；`SLOT_PLUGIN_ORDER` 未列出的排最后 | `src/main/plugins/builtin.ts`、`src/renderer/src/plugins/registry.ts:29-45` |
| 设置页侧栏自动包含「已启用且贡献 `settingsSections`」的插件，无需手工登记 | `src/shared/settingsNav.ts:3`、`README.md`「设置页」 |
| Electron `Notification` 可用；打包 appId 已配（`com.ruinb0w.bow`），Windows 通知可落地 | `package.json:9-10`、Electron 类型 `node_modules/electron/electron.d.ts` |
| MCP 冒烟用 `names.includes(...)` 断言、只打印工具数，**不**断言精确条数 | `scripts/mcp-smoke.mjs:88-107` |
| `app.setAppUserModelId` / `new Notification(` 目前全仓库**没有**使用（本插件是第一处） | grep 全仓库 |

---

## 3. 数据模型与状态机

### 3.1 存储（单文件 `pomo.json`）

```ts
// 与「数据 + 设置」双文件惯例不同：番茄钟的 state 很小且每次转换都要原子写，
// 放一个文件里少一次 open/rename（storage() 按文件名缓存，同文件只会有一个 JsonStore）。
interface PomoStore {
  settings: PomoSettings
  state: PomoState
}

interface PomoSettings {
  focusMinutes: number            // 默认 25
  shortBreakMinutes: number       // 默认 5
  longBreakMinutes: number        // 默认 15
  roundsBeforeLongBreak: number   // 默认 4
  autoStartNext: boolean          // 默认 false：阶段结束后进入下一阶段但保持暂停
  notify: boolean                 // 默认 true（系统通知）
  sound: boolean                  // 默认 true（提示音）
}

interface PomoState {
  phase: Phase                    // 'focus' | 'short-break' | 'long-break'，默认 'focus'
  running: boolean                // 默认 false
  endsAt: number | null           // epoch ms；running 时有效
  remainingMs: number             // 暂停 / 未开始时剩余
  cycleIndex: number              // 本轮已完成的专注数 0..roundsBeforeLongBreak
  completedToday: number
  completedDate: string           // 本地 'YYYY-MM-DD'；跨天在读取/完成时归零
}
```

**不每 tick 写盘**：只在 `start/pause/skip/reset/settings/阶段完成` 这些转换时 `store.set(...)`。倒计时显示由渲染层拿 `endsAt` 本地插值，主进程不逐秒 IPC。

### 3.2 纯逻辑（放 `src/plugins/pomo/shared.ts`，两端安全、可单测）

```ts
export const DEFAULT_SETTINGS: PomoSettings
export const PHASE_LABELS: Record<Phase, string>          // 专注 / 短休息 / 长休息
export function durationMs(phase: Phase, s: PomoSettings): number
export function localDateKey(now: number): string          // 本地 YYYY-MM-DD
export function normalizeSettings(input: unknown): PomoSettings   // 夹紧到合理区间（1..180 分钟等）
export function normalizeState(input: unknown, s: PomoSettings, now: number): PomoState
export function remainingMsOf(state: PomoState, now: number): number
export function startPhase(state: PomoState, s: PomoSettings, now: number): PomoState
export function pausePhase(state: PomoState, now: number): PomoState
export function resetPhase(state: PomoState, s: PomoSettings): PomoState   // 回到本阶段满时长、暂停
export function completePhase(state: PomoState, s: PomoSettings, now: number,
                              opts: { count: boolean; autoStart: boolean }): {
  next: PomoState
  completed: { phase: Phase; focus: boolean }   // 用于通知文案
}
```

`completePhase` 状态转移（`count=false` 即 `skip`，不增加 `completedToday`）：

- `phase === 'focus'` 且 `count` → `completedToday += 1`、`cycleIndex += 1`
  - `cycleIndex >= roundsBeforeLongBreak` → 下一阶段 `long-break`
  - 否则 → `short-break`
- 其它阶段 → 下一阶段 `focus`；若刚结束的是 `long-break` → `cycleIndex = 0`
- 跨天：`localDateKey(now) !== completedDate` 时先归零 `completedToday`

---

## 4. 要改 / 新增的文件

### 新增

| 文件 | 内容 |
| --- | --- |
| `src/plugins/pomo/shared.ts` | §3 的类型 + 纯逻辑（无 electron / node，两端安全） |
| `src/plugins/pomo/main.ts` | `PluginMain`：主进程时钟、IPC、MCP 工具、通知、热键 |
| `src/plugins/pomo/ui.ts` | `PluginUiContribution`：toolbar 插槽 + overlay + settingsSection |
| `src/plugins/pomo/ui/PomoButton.vue` | 工具栏按钮：图标 + `mm:ss`、点击开面板、阶段结束闪烁 + 响铃 |
| `src/plugins/pomo/ui/PomoPanel.vue` | `below-chrome` 下拉面板：状态、开始/暂停/跳过/重置、今日完成数 |
| `src/plugins/pomo/ui/PomoSettings.vue` | 设置分区：各时长、长休轮数、自动开始、通知 / 声音开关 |
| `tests/pomoShared.test.ts` | 纯逻辑单测（状态机 / 跨天 / 夹紧 / 剩余时间） |
| `tests/pomoPlugin.test.ts` | 假 ctx + `vi.mock('electron')` + fake timers：转换、IPC、MCP 返回体 |

### 登记 / 修改

| 文件 | 改动 |
| --- | --- |
| `src/main/plugins/builtin.ts` | `BUILTIN_PLUGINS` 追加 `pomo`（放末尾，不参与网络钩子与建议源次序） |
| `src/renderer/src/plugins/registry.ts` | `PLUGIN_UI` 追加 `pomoUi`；`SLOT_PLUGIN_ORDER.toolbar` 追加 `'pomo'` 到末尾（可省略，但显式一点可读） |
| `src/shared/shortcutCatalog.ts` | 「视图与面板」加 `Ctrl+Shift+O`（仅在做可选热键时） |
| `README.md` | 顶部功能行、数据存储、插件体系列表、MCP 工具一览（+4 行）、插件设置小节、快捷键一节（可选热键） |
| `docs/ARCHITECTURE.md` | §5.8 主进程侧矩阵 + 渲染层侧矩阵各加一行；§6.2 插件工具 15→19、合计 34→38 并补静态计数出处 |
| `scripts/mcp-smoke.mjs` | 可选：加 4 条 `assert(names.includes('browser_pomo_*'))`（现有断言是 `includes`，不加也不会红） |

> 不动 `tsconfig.node.json`：纯逻辑放已收录的 `shared.ts`，不新增被 include 的文件名。
> 不动 `INTERNAL_PAGES` / `electron.vite.config.ts` / `rendererEntry.ts`：本方案不开内部页面。
> 不动 `settingsNav.ts`：设置分区自动出现。

---

## 5. 实施步骤（每一步独立可验证）

### 步骤 1：纯逻辑 + 单测（`src/plugins/pomo/shared.ts` + `tests/pomoShared.test.ts`）

- 按 §3 实现；`tests/pomoShared.test.ts` 钉住：四连专注后进长休、长休后 `cycleIndex` 归零、跳过不计数、跨天归零、设置夹紧、暂停后 `remainingMs` 精确。
- 验证：`npx vitest run tests/pomoShared.test.ts` 绿；`npm run typecheck` 对此文件 0 报错。

### 步骤 2：主进程插件（`src/plugins/pomo/main.ts`）

- `manifest = { id: 'pomo', name: '番茄钟', description: '专注 / 休息计时器', version: '1.0.0' }`；`capabilities = ['ui','mcp']`（做可选热键再加 `'shortcut'`）。
- `activate(ctx)`：
  - `const store = ctx.storage<PomoStore>({ file: 'pomo.json', defaults: { settings: DEFAULT_SETTINGS, state: initial } })`；
  - 启动时 `normalizeState`：若持久化 `running && now >= endsAt` → `completePhase({count:true, autoStart:false})`（静默）；
  - `setInterval(1000)`：`if (state.running && Date.now() >= state.endsAt) finishPhase()`；句柄存闭包，`deactivate` 里 `clearInterval`；
  - `finishPhase()`：`completePhase({count:true, autoStart:settings.autoStartNext})` → `persist()` → `ctx.ipc.emit('state', snapshot())`；若 `settings.notify && Notification.isSupported()` → `new Notification({ title, body, silent: true }).show()`（声音交给渲染层，避免双响）；再 `ctx.ipc.emit('phase-end', { phase, focus })`；
  - `ctx.ipc.handle`：`getState`（返回 `{ settings, state: normalized, serverNow }`）、`getSettings`、`setSettings`（`normalizeSettings` + 广播 `state`）、`start`、`pause`、`skip`、`reset`、`toggle`；
  - `ctx.mcp.tool(...)` 四个工具，返回 `textContent({...})`，schema 用 zod（`z.string()` 等），与 `downloads/main.ts` 同款；
  - （可选）`ctx.shortcuts.register({ key:'o', code:'KeyO', ctrl:true, shift:true }, () => toggle())`。
- `deactivate()`：`clearInterval`（自有非内核资源）。
- 关键点：主进程**不能**开/关浮层；面板控制全部由渲染层调 `plugins.invoke`，关闭走 `close-request`（§2 已确认）。
- 验证：`npm run typecheck` 绿；`npx vitest run tests/pomoPlugin.test.ts`（步骤 5）覆盖。

### 步骤 3：渲染层 UI（`ui.ts` + 三个组件）

- `ui.ts`：
  ```ts
  export default {
    id: 'pomo',
    slots: { toolbar: [PomoButton] },
    overlays: [{ id: 'plugin:pomo:panel', component: PomoPanel, placement: 'below-chrome' }],
    settingsSections: [PomoSettings]
  }
  ```
- `PomoButton.vue`（照 `DownloadsButton.vue` 的骨架）：
  - `onMounted` → `invoke('getState')` + 订阅 `plugins.onEvent`（`state` 更新快照、`phase-end` 触发闪烁与响铃）；
  - 本地 `setInterval(1000)` 仅在 `running` 时刷新显示（`remainingMsOf`），卸载/暂停即清；
  - 显示：空闲只显示 `Timer` 图标；运行时图标 + `mm:ss`（`font-variant-numeric: tabular-nums`）；`phase-end` 后加 ~4s 的 `.blink` class；
  - 点击：`const r = el.getBoundingClientRect(); api.showOverlay({ id:'plugin:pomo:panel', placement:'below-chrome', payload:{ rect:{...} } })`。
- `PomoPanel.vue`（照 `SplitMenu.vue` 的定位写法）：
  - `props: { payload?: { rect: Rect }; bandTop: number }`；`box = { top: r.y + r.height - bandTop + 2, right: innerWidth - (r.x + r.width) }`；
  - 透明 backdrop `@mousedown.self` → `emit('overlay-event','close-request')`；× 同；Esc 监听同；
  - 控制按钮调 `invoke('pomo','start'|'pause'|'skip'|'reset')`；订阅 `plugins.onEvent` 刷新；本地 1s 刷新倒计时；
  - 「今日完成 🍅×N」+「第 k/settings.roundsBeforeLongBreak 个」。
- `PomoSettings.vue`：数字输入（分钟）+ 开关，`invoke('pomo','setSettings', patch)`；即时保存。
- 验证：`npm run typecheck` 绿；`npx vitest run tests/pluginBoundaries.test.ts tests/pluginUiSlots.test.ts` 绿；`npm run dev` 手验按钮显示、面板开合、阶段结束三件套。

### 步骤 4：登记接线（`builtin.ts` / `registry.ts`）

- `BUILTIN_PLUGINS` 末尾追加 `import pomo from '@plugins/pomo/main'` + `pomo`。
- `PLUGIN_UI` 末尾追加 `pomoUi`；`SLOT_PLUGIN_ORDER.toolbar` 末尾加 `'pomo'`。
- 验证：`npm run typecheck` + `npm run build` 绿；`npm run dev` 里设置页出现「番茄钟」分区、插件管理里可启停。

### 步骤 5：测试（`tests/pomoPlugin.test.ts`）

- `vi.mock('electron', () => ({ Notification: class {...} }))`（其余同名导出按需补）；
- 假 ctx 复刻 `passwordPlugin.test.ts` 的 `memStore` + 记录型 `PluginContext`；
- 用 `vi.useFakeTimers()` 推进 25 分钟，断言：`phase` 变 `short-break`、`completedToday=1`、`cycleIndex=1`；连续 4 次后进 `long-break` 且 `cycleIndex=0`；`skip` 不计数；跨天 `completedToday` 归零；MCP `browser_pomo_status` 返回体形状。
- 验证：`npx vitest run tests/pomoPlugin.test.ts tests/pomoShared.test.ts` 绿。

### 步骤 6（可选，建议做）：全局热键 `Ctrl/Cmd+Shift+O`

- `ctx.shortcuts.register({ key:'o', code:'KeyO', ctrl:true, shift:true }, () => toggle())`（`toggle` = 运行中暂停、否则开始/继续）；
- `capabilities` 加 `'shortcut'`；`src/shared/shortcutCatalog.ts` 的「视图与面板」加条目；README 快捷键一节同步。
- 冲突检查：核心快捷键只认 `Ctrl(+Shift)+{T,W,L,E,R,J,F,1..9,,,方向}`，插件只有密码 `Ctrl+Shift+P`；`O` 空闲。

### 步骤 7：文档与冒烟

- 更新 `README.md`（顶部功能行 / 数据存储加 `pomo.json` / 插件体系列表 / MCP 工具一览 +4 行 / 插件设置小节 / 快捷键一节）与 `docs/ARCHITECTURE.md`（§5.8 两表、§6.2 计数 15→19、34→38、静态出处加 `pomo/main.ts`）；
- `scripts/mcp-smoke.mjs` 加可选断言；
- 验证：`npm run test:mcp`（stdio 冒烟）绿、`npm run typecheck` 0、`npx vitest run` 全绿（注意既有 Node 26 的 `mcpHttp.test.ts` 已知失败与本次无关）。

---

## 6. 关键取舍与风险

1. **面板不能 toggle（只能开）**：插件没有关闭自己浮层的 API（`close-request` 被 `ipc.ts:255` 提前拦截，插件 `overlay-event` 收不到；`ctx.ipc` 也无法驱动 `ui:overlay`）。因此按钮点击一律「打开/刷新」，收起靠点面板外 / Esc / ×——与 `downloads`/`passwords` 现状一致。若一定要 toggle，可让面板关闭时额外发一个自定义事件（`overlay-event('pomo-closed')` → 插件 `ctx.ipc.emit('panel-closed')` → 按钮清 `open`），属可选打磨，不在首版。
2. **每秒检查的间隔只在 `running` 时消耗**：`setInterval(1000)` 常驻但空转成本极低；不做长 `setTimeout`，因为跨休眠会漂移。
3. **桌面通知的声音**：统一 `silent: true`，声音只由渲染层 WebAudio 出，避免 macOS 上双响；代价是「应用零窗口 / 从未交互过」时提示音不响（系统通知仍在）。
4. **`Notification` 是仓库首处使用**：Windows 需 appId（已配）；Linux 依赖桌面通知服务，`Notification.isSupported()` 为 false 时静默跳过，不阻塞计时。
5. **未知**：无合成管线 / headless 环境里 `Notification` 与音频的表现未经实测（README 已有「无显示环境下截图可能黑帧」的同类说明）；多窗口下所有 chrome 的按钮都会闪烁与响——可接受（同一份状态）。
6. **不做**：任务绑定、站点统计、内部页面 `bow://pomo`、跨设备同步、番茄历史持久化（只记今日完成数）。

---

## 7. 实现与验证记录（2026-10-03）

- 新增：`src/plugins/pomo/{shared.ts,main.ts,ui.ts,ui/PomoButton.vue,ui/PomoPanel.vue,ui/PomoSettings.vue}`；
  `tests/pomoShared.test.ts`(17 例)、`tests/pomoPlugin.test.ts`(11 例)。
- 登记：`BUILTIN_PLUGINS`、`PLUGIN_UI` + `SLOT_PLUGIN_ORDER.toolbar`、`shortcutCatalog`、`scripts/mcp-smoke.mjs`、README、ARCHITECTURE §5.8/§6.2/§8/§10、bow-browser SKILL.md（已同步全局）。
- 验证（全绿）：
  - `npm run typecheck` 0；`npx vitest run` **60 文件 / 1217 例**；`npm run build` 绿；
  - `SMOKE_LD_LIBRARY_PATH=~/.cache/bow-alsa/usr/lib npm run test:mcp` → **38 工具**，4 个 `browser_pomo_*` 在册且 start/pause 生效；
  - 真 Electron + CDP（临时脚本，不入库）：工具栏 `.pomo-btn` 出现 → 点击开出 below-chrome 面板（`25:00`/专注）→ 点「开始」时钟走动 + 按钮 `.on` → **`Ctrl+Shift+O` 真的暂停/继续** → 设置页侧栏「番茄钟」+ `.pomo-settings`（4 数字输入 + 3 开关）。
- 与原计划的两处实现差异：
  1. 纯逻辑全部放 `shared.ts`（未新建 `schedule.ts`），因此**不需要**动 `tsconfig.node.json` 的 include；
  2. `deactivate` 只 `clearInterval`（模块级闭包变量），未用 `ctx` 参数。

## 8. 验收清单

- [ ] `pomo.json` 在 `<userData>` 下生成，内容含 `settings` + `state`，仅转换时写入。
- [ ] 工具栏按钮显示 `mm:ss`，暂停/空闲时不空转。
- [ ] 面板能开始 / 暂停 / 跳过 / 重置，显示「第 k 个 · 今日 N 个」。
- [ ] 阶段结束：系统通知 + 提示音 + 按钮闪烁；`notify` / `sound` 开关生效。
- [ ] 4 个专注后进入长休，长休后计数归零。
- [ ] 关闭浏览器再打开：运行中的计时按 `endsAt` 续算；过期则推进一个阶段并暂停。
- [ ] `browser_pomo_status/start/pause/skip` 在 MCP 冒烟里可调用、返回 `{ok:true,...}`。
- [ ] 插件管理里停用 `pomo` 后：按钮消失、浮层被关闭、MCP 工具消失、定时器停止。
- [ ] `npm run typecheck` 0；`npx vitest run` 全绿；`npm run build` 绿；`npm run test:mcp` 绿。
