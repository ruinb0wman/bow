# 长按 Shift 显示并复制 tabId（2026-10-05）

- 模式：plan（待批准，第 3 稿）
- 前两稿：曾被否掉的两个形态 —— ①「标签栏每项都显示 id、点标签复制」②「id 徽标放标签栏项中央」。用户定稿为**页面区中央、每个窗格一个徽标**。

---

## 1. 目标

按住 Shift **~200ms** → **当前标签组**的每个窗格正中央浮出一个 `tabId N` 徽标；**点徽标 = 复制纯数字 id**（角标短暂变「已复制」）。

- 不分屏的标签 = 一个徽标（页面区正中央）；分屏 = 每个窗格各一个（各在**它自己窗格**的中央）。
- 非活动标签组不显示任何东西；**标签栏本身完全不动**（点顶部标签照常切换）。
- 松开 Shift / 按其它键 / 窗口失焦 / 窗口缩放 / 标签组变化 → 徽标消失。

**用户已拍板的点**：延迟 200ms 再显示（打大写字母不闪）、复制内容是**纯数字**、分屏每个窗格都显示、反馈是徽标短暂变「已复制」、徽标落在**页面内容中央**而不是标签栏。

**关键架构约束**（`docs/ARCHITECTURE.md` §3 开头）：

> 页面(WebContentsView)永远绘制在 chrome UI 之上,所以任何要浮在页面上的 UI 都必须交给 Overlay。

所以本方案**不用改 chrome 标签栏、不用改 preload、不用加 IPC 通道** —— 全部落在「主进程 + Overlay 宿主 + 一个新的浮层组件」三处。

---

## 2. 现状（读到的代码）

### 2.1 活动组的窗格几何现成可得

`TabManager.listGroups()`（`src/main/tabManager.ts:665-677`）返回的 `TabGroupInfo.panes` **只给活动组算几何**（非活动组是 `[]`）：

```ts
panes: geo && isActive(g) ? geo.panes.map((p) => ({ tabId: p.tabId, rect: { ...p.rect } })) : [],
```

`PaneBox = { tabId, rect }`（`src/shared/split.ts:35-38`），坐标是**窗口内容坐标**（页面区从 `chromeHeight` 起，`tabManager.ts:685-700` 的 `geometryOf`）。`TabManager.getChromeHeight()` 与 `window.getContentSize()` 都是现成入口。

### 2.2 Overlay 宿主：单例视图 + placement 决定 bounds

`src/main/overlay.ts`：

- 每窗口一个透明 `WebContentsView`（`#00000000`），**同一时刻只承载一份浮层**（`current` 是单数）。
- `show(content)` → `raise()` + `setVisible(true)` + `layout()` + `send('overlay:show', ...)`；
  **只有 `full` 与 `find` 会 `webContents.focus()`**（`overlay.ts:87-92`），关闭时也只有这两个会把焦点还给活动页（`overlay.ts:44-53`）。
- `layout()` 按 placement 切 bounds；`page-top-right` 的注释就是本方案要遵守的规矩：

```ts
// ⚠️ 必须**刚好**包住查找条:WebContentsView 没有点击穿透(见顶部注释),
// 铺满会把右半页的点击全吃掉。几何算法在 @shared/find(有单测)。
```

- 几何纯函数放 `@shared/find` 的 `findBarRect()` 并配单测 —— 本方案的徽标 bounds 走同一个套路。

### 2.3 全局按键只有主进程拿得到

同第 2 稿：`src/main/tabShortcuts.ts` 的 `app.on('web-contents-created')` + `before-input-event` 是唯一能看到「页面里有焦点时的 Shift」的地方；`ctx`（窗口上下文）与 `ctx.overlay` 在同一个 handler 里已就绪。`matchTabHotkey` 对裸 Shift 返回 `null`，所以插一段不会抢任何现有热键。

### 2.4 剪贴板与浮层组件契约

- `window.browserAPI.writeClipboardText` / `readClipboardText`（`preload/index.ts:125-126` → `main/ipc.ts:86-91`）对**有 preload 的页面**可用，Overlay 页面正是其中之一（`OverlayApp.vue` 就在用 `api.overlayEmit`）。渲染层 `navigator.clipboard` 的坑见 `ipc.ts` 注释。
- Overlay 组件契约：`payload` prop + `band-top` prop + `overlay-event` emit（见 `FindBar.vue:5`、`OverlayApp.vue:60-69` 的 `CORE` 注册表）。核心浮层 id 与 payload 类型在 `src/shared/types.ts:87-176`。

---

## 3. 设计

### 3.1 纯函数：长按识别（`src/shared/shortcuts.ts`）

```ts
/** 「长按 Shift 显示 tabId」的按住时长:短暂 Shift(打大写、Shift+字母)不该触发 */
export const REVEAL_HOLD_MS = 200

export type RevealSignal = 'show' | 'hide' | null

/**
 * 长按 Shift 识别(只在主进程 before-input-event 用;延迟计时在 tabShortcuts.ts):
 * - 纯 Shift 的 keyDown(无 Ctrl/Alt/Meta)→ 'show'
 * - Shift keyUp、或**任何别的键** keyDown → 'hide'(Shift+字母/方向键不算「按住 Shift」)
 * - 带 Ctrl/Alt/Meta 的 Shift(组合键的一半)、自动重复、输入法组合中 → null(不改变状态)
 * 不 preventDefault —— Shift 必须照常进页面。
 */
export function matchRevealModifier(input: KeyInputLike): RevealSignal
```

### 3.2 纯几何：徽标 bounds 与本地坐标（新增 `src/shared/tabIdBadge.ts`）

与 `@shared/find` 的 `findBarRect` 同构，但**这次的浮层必须紧包住徽标**（否则会吃掉页面点击）：

```ts
/** 徽标盒的估算尺寸(px,只用于算 bounds;真实大小由 CSS 决定) */
export const TAB_ID_BADGE_SIZE = { width: 96, height: 34 }
/** bounds 四周留白(px) */
export const TAB_ID_BADGE_PADDING = 6

/** 徽标中心(窗口内容坐标,与 PaneBox.rect 同系) */
export interface TabIdBadgeCenter { tabId: number; x: number; y: number }

/** 浮层 payload:`bounds` 已夹进窗口;`badges` 是**浮层视图本地坐标**(= 窗口坐标 − bounds 原点) */
export interface TabIdsPayload {
  bounds: Rect
  badges: Array<{ tabId: number; x: number; y: number }>
}

/** 中心点集合 → 浮层 bounds + 本地坐标;空集合返回 null */
export function tabIdBadgeLayout(
  centers: TabIdBadgeCenter[],
  windowWidth: number,
  windowHeight: number
): TabIdsPayload | null
```

算法：每个中心 ± `TAB_ID_BADGE_SIZE/2` 求并集 → 四周各加 `PADDING` → 夹在 `[0,w]×[0,h]` 内 → 本地坐标 = 中心 − bounds 原点。
**只包住徽标这点很关键**：不分屏时只有页面正中央约 `108×46` 一小块被接管；左右分屏时是中间一条窄横带；2×2 分屏才是中间区域。

### 3.3 Overlay 宿主：新增 `panes` placement（`src/main/overlay.ts`）

```ts
if (this.current.placement === 'panes') {
  const b = (this.current.payload as TabIdsPayload | undefined)?.bounds
  this.view.setBounds(b ?? { x: 0, y: 0, width: w, height: h })
  return
}
```

- **不聚焦**（`show()` 的 focus 条件只有 `full`/`find`，天然满足）：按住 Shift 打字/终端输入照常进页面，键盘焦点不跳。
- **关闭时不抢焦点**（`refocusTab` 条件同样不含它）。
- `isFullOpen` 不受影响（不是 `full`），`Ctrl+T`/窗口获焦等既有判断不变。

### 3.4 主进程：按住 → 显示 / 松开 → 收起（`src/main/tabShortcuts.ts`）

在既有 `before-input-event` 里、`matchTabHotkey` 之前插入（**不 return、不 preventDefault**）：

```ts
let revealTimer: ReturnType<typeof setTimeout> | null = null
let revealOff: (() => void) | null = null

/** 取活动组窗格 → 中心点 → 纯函数算 bounds/本地坐标 → 交给 Overlay */
function showReveal(ctx: WindowContext): void {
  const panes = ctx.tabs.listGroups().find((g) => g.panes.length > 0)?.panes ?? []
  if (panes.length === 0) return
  // 已有别的浮层(建议下拉 / 分屏面板 / 查找条 / 插件面板)时不抢
  if (ctx.overlay.isOpen && ctx.overlay.currentId !== 'tab-ids') return
  const [w, h] = ctx.tabs.window.getContentSize()
  const payload = tabIdBadgeLayout(
    panes.map((p) => ({ tabId: p.tabId, x: p.rect.x + p.rect.width / 2, y: p.rect.y + p.rect.height / 2 })),
    w, h
  )
  if (!payload) return
  ctx.overlay.show({ id: 'tab-ids', placement: 'panes', payload })
  if (!revealOff) {
    // 窗口缩放 / 分屏变化 → 窗格几何变了,重新取数重算(而不是留一堆错位徽标)
    const refresh = (): void => showReveal(ctx)
    ctx.tabs.window.on('resize', refresh)
    ctx.tabs.on('groups-changed', refresh)
    revealOff = () => {
      ctx.tabs.window.off('resize', refresh)
      ctx.tabs.off('groups-changed', refresh)
    }
  }
}

function clearReveal(ctx: WindowContext): void {
  revealOff?.()
  revealOff = null
  if (revealTimer) { clearTimeout(revealTimer); revealTimer = null }
  if (!ctx.tabs.window.isDestroyed() && ctx.overlay.currentId === 'tab-ids') ctx.overlay.show(null)
}
```

分支：

- `'hide'` → `clearReveal(ctx)`；
- `'show'` → 重置 200ms 计时器；到点先查 `ctx.tabs.window.isFocused()` 与 `!ctx.overlay.isFullOpen`，再 `showReveal(ctx)`。

**只关自己那一份**：`clearReveal` 里那句 `currentId === 'tab-ids'` 保证「按住 Shift 期间插件/ chrome 打开了别的浮层」时不会误关别人的面板（此时我们的徽标已被顶掉，这次 Shift 就到此为止）。

### 3.5 浮层组件（新增 `src/renderer/src/components/TabIdsOverlay.vue` + 注册）

- `OverlayApp.vue` 的 `CORE` 加一行：`'tab-ids': markRaw(TabIdsOverlay)`。
- 组件：`defineProps<{ payload: TabIdsPayload; bandTop: number }>()`（`bandTop` 恒 0，只为对齐宿主契约 —— 与 `FindBar.vue` 同款）。
- 渲染：根 `position: fixed; inset: 0`（视图 bounds 就是紧包盒），每个徽标 `position:absolute; left:x; top:y; transform:translate(-50%,-50%)`，内容是 `tabId {{ tabId }}`。
- 点击：`await api.writeClipboardText(String(tabId))` → `await api.readClipboardText()` 核对（Windows 上 `clipboard.writeText` 失败是静默的，`JournalView.vue:748-752` 已有先例）→ 该徽标文案变「已复制」/「复制失败」，1.2s 后复原。**复制就是写系统剪贴板，不打扰页面、不切标签。**
- 样式（scoped）：深色半透明胶囊 + 边框 + 阴影 + 等宽字体，明显区别于页面内容。

### 3.6 交互结果一览

| 操作 | 结果 |
| --- | --- |
| 按住 Shift 200ms | 活动组每个窗格中央出现 `tabId N` |
| 点徽标 | 复制该 id（纯数字），徽标变「已复制」，**页面不受影响** |
| 松开 Shift / 按其它键 | 徽标消失 |
| 窗口失焦 | 徽标消失（`window.blur` → 主进程会 `clearReveal`，见 §4 步骤 6） |
| 窗口缩放 / 分屏变化 | 徽标按新几何重排（`refresh`） |
| 已有面板打开时按住 Shift | 什么都不发生（不抢面板） |
| 标签栏普通点击 | 与现在完全一致（本方案不碰标签栏） |

---

## 4. 改动清单（有序，每步可独立验证）

1. **`src/shared/shortcuts.ts`**：加 `REVEAL_HOLD_MS` / `RevealSignal` / `matchRevealModifier()`，并在文件顶部用途注释里补一句。
   验证：`npm run typecheck`。
2. **`tests/shortcuts.test.ts`**：加 `describe('matchRevealModifier 长按 Shift 识别')`：纯 Shift keyDown→`'show'`；带 Ctrl/Meta/Alt→`null`；Shift keyUp→`'hide'`；别的键 keyUp→`null`；别的键 keyDown→`'hide'`；`isAutoRepeat`/`isComposing`→`null`。
   验证：`npx vitest run tests/shortcuts.test.ts`。
3. **`src/shared/tabIdBadge.ts`**（新）：`TAB_ID_BADGE_SIZE` / `TAB_ID_BADGE_PADDING` / `TabIdBadgeCenter` / `TabIdsPayload` / `tabIdBadgeLayout()`（§3.2）。
4. **`tests/tabIdBadge.test.ts`**（新）：单个中心 → bounds 紧包且有 padding、本地坐标 = 中心 − 原点；左右两个中心 → 并集横带；2×2 → 并集盒；贴窗口边/角 → bounds 被夹进窗口且本地坐标仍指向正确像素;空数组 → `null`;负/越界中心不产出界外 bounds。
   验证：`npx vitest run tests/tabIdBadge.test.ts`。
5. **`src/shared/types.ts`**：`OverlayPlacement` 加 `'panes'`；`CoreOverlayContentId` 加 `'tab-ids'`；`OverlayContentMap` 加 `'tab-ids': TabIdsPayload`（payload 类型从 `./tabIdBadge` 导入，与现有从 `./split` 导入同款）；顺手更新 `page-top-right` 上方那段 placement 说明注释。
   验证：`npm run typecheck`。
6. **`src/main/overlay.ts`**：`layout()` 加 `'panes'` 分支（§3.3）。
   验证：`npm run typecheck`。
7. **`src/renderer/src/components/TabIdsOverlay.vue`**（新）+ **`OverlayApp.vue`** 的 `CORE` 注册（§3.5）。
   验证：`npm run dev`，见 §5。
8. **`src/main/tabShortcuts.ts`**：§3.4 的 `revealTimer` / `revealOff` / `showReveal()` / `clearReveal()`，插在 `matchTabHotkey` 之前；在 `index.ts:158` 那个 `win.on('blur')` 里顺手调 `clearReveal(ctx)`（需要把它导出）——保证「按住 Shift 切走窗口」不留残留。
   验证：`npm run typecheck` + §5 手测。
9. **`src/shared/shortcutCatalog.ts`**：`tabs` 组加 `{ keys: ['Shift'], label: '按住显示当前标签组各窗格的 tabId，点击徽标复制', note: '…' }`；**`tests/shortcutCatalog.test.ts`** 的「关键键位都在册」清单加 `expect(has(['Shift'])).toBe(true)`。
   验证：`npx vitest run tests/shortcutCatalog.test.ts`。
10. **`README.md`**：`:406-445` 快捷键清单加一条（含「徽标浮在页面区中央、只覆盖它自己那一小块」这一代价）；`:115-122` 多窗口 `tabId` 段加半句「按住 Shift 点徽标即可复制 tabId，直接贴给 LLM/MCP」。
11. **`docs/ARCHITECTURE.md`**：§3 的 placement 列表（「三种 placement」→ 四种，补 `panes` 及其「紧包徽标」理由）；§7.2 的 overlay 行/核心浮层清单补 `tab-ids`。§9 **不用改**（没有新通道）。
    （`App.vue` / `preload` / `MCP` / 插件都不动，§7.1 也不用改。）

---

## 5. 验证

1. **单测**：`npm run typecheck`（两套 tsconfig）+ `npm test`（`shortcuts` / `tabIdBadge` / `shortcutCatalog` 三处）。
2. **手动（dev）**——
   - 单标签：打开一个网页，**把焦点点进页面里的输入框**，按住 Shift 200ms → 页面正中央出现 `tabId N`；松开即消失；按住 Shift 连续打大写字母（`Shift+A`）全程不闪。
   - 点徽标 → `Ctrl+V` 粘出数字；**页面内容没有任何变化**（焦点、滚动、选区都不动）；徽标显示「已复制」。
   - 分屏（左右 / 2×2）：每个窗格中央各有自己的 id；点哪个复制哪个。
   - 切换到另一个标签组后再按住 Shift：只显示**当前**组的 id（旧组无徽标）。
   - 终端页里按住 Shift：徽标出现，且此时打字仍进终端（键盘焦点没被抢走）。
   - 窗口失焦 / 缩放窗口 / 按住 Shift 时 `Ctrl+W` 关掉一个窗格：徽标消失或按新几何重排，无残留。
   - 开着建议下拉 / 分屏面板时按住 Shift：面板不被顶掉，什么都不发生。
   - 「点徽标以外」的页面区域：不该被吃掉 —— 用**单标签**场景确认页面四边与上下角仍可点、可滚（只有正中央约 `108×46` 那块被徽标接管）；分屏时中间的横带被接管属预期。
3. **E2E（可选）**：`scripts/open-bow.mjs` 起真 Electron + CDP。对**页面 target** 发 `Input.dispatchKeyEvent` `rawKeyDown`（`key:'Shift'`、`modifiers:8`）—— MEMORY 已实测 CDP 在页面 target 上会触发主进程 `before-input-event`；然后在 overlay target 断言 `.tab-id-badge` 出现、文本 = 预期 id、位置 ≈ 窗格中心；用 `modifiers:8` 点它；在任一有 preload 的 target 上 `Runtime.evaluate('browserAPI.readClipboardText()')` 断言 `'3'`；`keyUp` 后断言徽标消失。
4. **不回归**：`npm run build`；`npm run test:mcp`（浮层是单例，确认 MCP 的 `browser_screenshot` 之类不因新 placement 出问题 —— 它不会主动显示这个浮层）。

---

## 6. 风险与未知

- **裸 Shift 会不会触发 `before-input-event`**：Electron 的 `Input.type` 只声明 `keyUp | keyDown`，修饰键理论上照常触发，但**三个平台都要真机确认一遍**（Windows 打包版 + Linux/Wayland + mac 若有真机）。若某平台不发裸 Shift，退化方案是渲染层 keydown（chrome 有焦点时）+ 主进程双路，或换成「按住 Shift 且鼠标在窗内移动过」的探针。
- **输入法把单按 Shift 当「中/英切换」**：`matchRevealModifier` 的 `isComposing` 过滤会挡掉一部分；这类平台下可能按不出来。README `:179` 已记过同一现象。
- **徽标那一小块会吃掉鼠标事件（点击 / 拖拽 / Shift+滚轮横滚）**：`WebContentsView` 没有点击穿透。已用「bounds 紧包徽标」把面积压到最小（单标签 ≈ 中央 `108×46`；左右分屏 ≈ 中间一条窄横带），并且只在按住 Shift 且满 200ms 后才出现。**这是本方案唯一的硬代价**，已写进 README。若实测仍碍事，可选的补救（不在本次范围）：① 在徽标 `mousedown` 时用 `webContents.sendInputEvent` 把事件按窗格坐标重投给页面（约 +40 行，可让 Shift+拖拽选字恢复）；② 换触发手势（如 `Alt`）或改成点击标签栏才显示。
- **浮层是单例**：按住 Shift 期间若有别的浮层打开，我们的徽标被顶掉且不会再自动回来（当次 Shift 结束）。已用 `currentId === 'tab-ids'` 的守卫保证不误关别人的面板。
- **几何刷新时机**：`groups-changed` 只在活动组分屏时才发（`tabManager.ts:863`），单窗格组的窗口缩放不发 —— 所以 `resize` 单独挂了一个监听；两处都挂才全覆盖。真机验一遍「按住 Shift 拖窗口边缘」的观感。
- **多窗口**：`before-input-event` 的来源 `contents` 已经 `byWebContents` 反查窗口，所以徽标只出现在按键来源的那个窗口；但**别的窗口若之前处于揭示态**（理论上不可能：清楚 Shift 会 clear）不在此列。真机验一次「按住 Shift 时切到另一个 bow 窗口」。
- 未决：`tabId` 徽标要不要顺带显示 `windowId`（多窗口下 LLM 也可能需要）。本次按用户要求只显示 tabId。

---

## 7. 不做的事

- 不碰标签栏（`App.vue` 的 `.tab` / `.tab-pane-icon` 一行不改），不碰 preload，不加 IPC 通道，不改 MCP 工具签名；
- 不做「点击标签栏复制」「常显 tabId」「右键菜单」「复制 windowId」；
- 不新增依赖、不写存储、不加设置项（200ms 与徽标尺寸都是常量）。

---

## 8. 执行记录(2026-10-05)

按计划全部落地,**实现与计划的差异只有两处**:

1. **不新增 IPC 通道、不改 preload、不改 chrome** —— 计划里就是主进程直接开 Overlay(`ctx.overlay.show`),
   落地后确认这条最省:徽标组件自己在 overlay 页里写剪贴板(`browserAPI.writeClipboardText` + 读回核对),
   chrome 侧一行都不用动。`docs/ARCHITECTURE.md` §7.1 / §9 因此**不需要改**(只改了 §3 的 placement 与 §7.2 的注册表)。
2. **揭示期间的监听改成「每次刷新都重挂」**(`showReveal` 里先 `revealOff?.()` 再重挂)。原计划是
   `if (!revealOff)` 只挂一次 —— 但若上一个被揭示的窗口被关掉,`revealOff` 会一直指着它,
   下一个窗口的监听就永远挂不上。重挂是幂等的(旧闭包先摘掉),成本可忽略。

### 真机 E2E 实测(新增 `scripts/e2e-tab-id-reveal.mjs` + `npm run test:e2e:tabid`)

**原计划里最大的未知被证实**:CDP 在**页面 target** 上发裸 `Shift` 的 `rawKeyDown` 确实会触发主进程的
`before-input-event` —— 也就是说「按住 Shift」这条路在真 Electron 上成立。18 条断言全绿:

- 短按 60ms **不显示**(打大写字母不闪);
- 长按后 overlay target 出现,活动组一个窗格 → 一个徽标,文案 `tabId N`;
- **浮层视图 `innerWidth/innerHeight` = 108×46** ⇒ bounds 确实紧包徽标(不是铺满页面区);
- 徽标圆心(本地坐标)≈ 窗格中心;
- 显示期间 `document.hasFocus()` 仍为 true ⇒ **不抢键盘焦点**;
- 点徽标 → `readClipboardText()` = 纯数字 id,徽标变「已复制」;
- 松开 Shift 消失;已有 `split-menu` 浮层时不显示;
- 分屏后每个窗格各一个徽标且 id 一一对应;按着 Shift 再分屏 → 徽标跟随重算成 3 个(refresh 路径)。

### 验证结果

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | ✓(两套 tsconfig) |
| `npm test` | ✓ 65 文件 / 1248 例(新增 `tests/tabIdBadge.test.ts` 7 例 + `tests/shortcuts.test.ts` 的 `matchRevealModifier` 6 例) |
| `npm run build` | ✓ |
| `npm run test:e2e:tabid` | ✓ 18 条断言(见上) |
| `npm run test:mcp` | ✓ 全通过(确认新 placement 没影响浮层单例与既有工具) |

### 仍未做 / 待真机

- **Windows / macOS 上的裸 Shift**:E2E 只在 Linux(ozone headless)上跑过;两个平台的行为需真机各按一次。
- **输入法把单按 Shift 当「中/英切换」**的场景:E2E 里没有输入法,真机需确认(预期该平台下不显示)。
- **按住 Shift 时拖窗口边缘**(resize 的 refresh 路径)只与 groups-changed 走同一函数,未单独实测。
- 未提交(工作区改动 + 新增 4 个文件)。

### 追加(同一轮的收尾验证)

- 设置页把 `shortcutCatalog` 的 `label` / `note` **直接插值**(`ShortcutsHelp.vue` 的 `{{ item.note }}`,不渲染 Markdown),
  我第一版 note 里写了 `**当前**` 与 `` `tabId` `` —— 会原样显示。已改成纯文本,并把它变成不变式:
  `tests/shortcutCatalog.test.ts` 新增「展示文案是纯文本」用例(覆盖 label / note / platformNote / keys / hint)。
  **变异验证**:把 `**` 加回去 → 用例立刻 FAILED,改回即绿。
- 另跑了一次临时的真机检查(设置页 → 快捷键分区):新条目在册、`<kbd>Shift</kbd>` 正确、说明文字无 Markdown 泄漏。
- 最终一轮完整验证:`npm run typecheck` ✓ / `npm test` **65 文件 1249 例** ✓ / `npm run build` ✓ /
  `npm run test:e2e:tabid` **18 条** ✓ / `npm run test:mcp` ✓。
