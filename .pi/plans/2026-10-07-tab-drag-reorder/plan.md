# 标签栏拖动排序（拖出窗口不生效）

## 1. 目标与前提

**目标**：在标签栏里按下并拖动一项，实时改变它的位置；松手即完成。**不做**任何「拖出窗口 → 新窗口 / detach」行为（
`2026-09-24-multi-window` 已明确不做跨窗口拖标签，这里继续保持）。

**前提/已核实的事实**（都读自代码，不是猜测）：

- 标签栏一项 = 一个**标签组**，顺序的真源是**主进程**的 `groups: TabGroup[]`：
  `tabManager.ts:96` 注释「顺序 = 标签栏顺序」；渲染层 `App.vue` 只是 `v-for="g in groups"`（`:key="g.id"`）。
  `listTabs()` 是按 **id** 排序的（`tabManager.ts:184`），与标签栏顺序无关 —— 所以**只需要重排 `groups`**。
- 组顺序已经影响别处：`Ctrl+数字` 走 `tabShortcuts.ts:310` 的 `listGroups()` 顺序；新标签插在活动组后面
  （`insertIndexAfterGroup`）。重排后这两个行为自动跟着变（符合预期）。
- 组顺序**只在内存**、不持久化（`README.md:494`「标签组只在内存，不跨重启保存」），所以无需落盘。
- 标签栏所在条带带 `-webkit-app-region: drag`，每个 `.tab` 是 `no-drag`（`style.css:69-74`，`App.vue:623`）——
  在 `no-drag` 子元素上按下不会触发系统窗口拖动。
- `body { user-select: none }`（`style.css:32`）→ 拖动时不会选中标签文字。

**手势选型**：用 **pointer 事件**（`pointerdown` + `window` 上的 `pointermove`/`pointerup`），不用 HTML5 DnD。
理由：①HTML5 原生拖拽会话可能被拖出窗口（与「不允许拖出」的约束相冲突，需额外压制）；
②`-webkit-app-region: drag` 的父条带里原生 drag 启动在某些平台不可靠；③指针方案能随时接管/取消，
且与仓库现有的「窗口级指针手势」写法一致（`.pi/plans/2026-09-21-logseq-table-block-select`）。

**排序语义**：实时排序（Chrome 式）——指针越过邻项中线就发一次 IPC，主进程重排后回推 `groups:changed`，
渲染层**不自己维护临时顺序**（避免两个真源）。不做浮动 ghost、不做插入指示线（项本身就在实时让位）。

## 2. 要改的文件与理由

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `src/shared/groups.ts` | 新增纯函数 `moveTabGroup(groups, groupId, toIndex)` | 组记账的唯一去处（现有 `insertIndexAfterGroup` / `neighborGroupIdAfterRemoval` 都在这），可单测 |
| `tests/groups.test.ts` | 新增一组用例 | 与 `split` / `groups` 的既有测试风格一致 |
| `src/main/tabManager.ts` | 新增公开方法 `moveGroup(groupId, toIndex): boolean` | `groups` 是 private，只有 TabManager 能改；改完 `publishGroups()` 即可（几何与顺序无关，不需要 `layout()`） |
| `src/main/ipc.ts` | 新增 `ipcMain.handle('groups:move', …)` | 与 `groups:activate` / `groups:ungroup` 并列；返回 `listGroups()` |
| `src/preload/index.ts` | `BrowserAPI` 加 `groupsMove(groupId, toIndex)` + 实现 | 命名对齐既有的 `groupsActivate` / `groupsUngroup` |
| `src/renderer/src/App.vue` | 拖动状态 + `onTabPointerdown` / `onDragMove` / `endDrag`；模板加 `@pointerdown` 与 `tab-dragging` 类；`@click` 换成吞掉拖后 click 的 `onTabClick` | 手势实现处 |
| `src/renderer/src/style.css` | `.tab.tab-dragging { opacity: .5; cursor: grabbing }` | 视觉反馈 |
| `README.md` | §「标签组与嵌套分屏」补一条 | 用户可见行为 |
| `docs/ARCHITECTURE.md` | API 表 / IPC 表 / 标签组机制 / `App.vue` 关键机制 / 测试计数 | 本仓库的文档是契约的一部分 |

## 3. 步骤（每步可独立验证）

### 步骤 1 — 纯函数 `moveTabGroup` + 单测

`src/shared/groups.ts`，放在 `insertIndexAfterGroup` 附近：

```ts
/**
 * 把某个组挪到 `toIndex`（标签栏顺序 = 数组顺序；`toIndex` 是**结果数组里的最终下标**）。
 * 下标夹进 `[0, length-1]`；组不存在 / 目标与当前一致 ⇒ **返回原引用**（调用方据此跳过 IPC 与重发事件）。
 */
export function moveTabGroup(groups: readonly TabGroup[], groupId: number, toIndex: number): TabGroup[] {
  const from = groups.findIndex((g) => g.id === groupId)
  if (from < 0) return groups as TabGroup[]
  const to = Math.max(0, Math.min(groups.length - 1, Math.trunc(toIndex)))
  if (to === from) return groups as TabGroup[]
  const next = [...groups]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
```

（`groups` 参数是 `readonly`，返回类型写 `TabGroup[]`：no-op 时把入参原样返回，因此断言一次即可 ——
上位调用者只比较引用，不会再改它。若不想用 `as`，可把参数类型放宽为 `TabGroup[]`，
`removeTabFromGroups` 等现有函数就是直接返回 `[...groups]` 的；**实现时选一种并在注释里说明**。）

`tests/groups.test.ts` 新增 `describe('moveTabGroup', …)`，用例：
1. 往后挪（`[10,11,12]` 把 10 挪到 1 → `[11,10,12]`），组内容与 `focus` 逐字节不变；
2. 往前挪（12 → 0 → `[12,10,11]`）；
3. 越界夹紧：`toIndex = 99` → 最后一位；`-5` → 第一位；
4. 组不存在 / 目标等于当前下标 ⇒ 返回**同一引用**（`toBe(groups)`）；
5. 空数组不抛。

**验证**：`npm test -- tests/groups.test.ts` 全绿；`npm run typecheck` 绿。

### 步骤 2 — TabManager 暴露 `moveGroup`

`src/main/tabManager.ts`：import 处加 `moveTabGroup`（与其它 `@shared/groups` 导入并列），
在 `activateGroup()` 旁边的「标签组」小节加：

```ts
/**
 * 拖动排序：把某个组挪到 `toIndex`（标签栏顺序）。返回是否真的动了。
 * 只改数组顺序 —— 几何/可见性只跟**活动组**有关，与顺序无关，所以不用 `layout()`；
 * 渲染层的标签栏吃 `groups:changed`，重排后必须 `publishGroups()`。
 */
moveGroup(groupId: number, toIndex: number): boolean {
  const next = moveTabGroup(this.groups, groupId, toIndex)
  if (next === this.groups) return false
  this.groups = next
  this.publishGroups()
  log('标签组排序', groupId, '→', toIndex)
  return true
}
```

**验证**：`npm run typecheck`；这一步没有独立的运行验证，行为在步骤 5 的真浏览器里一起验。

### 步骤 3 — IPC + preload

`src/main/ipc.ts`，紧随 `groups:ungroup`：

```ts
// 拖动排序:渲染层把「被拖的组 + 结果数组里的最终下标」报上来;主进程重排后回推 groups:changed。
// 组 id 不存在 / 下标越界都由 moveTabGroup 兜住(夹紧、no-op),这里只做类型检查。
ipcMain.handle('groups:move', (e, groupId?: unknown, toIndex?: unknown) => {
  const ctx = ctxOf(e)
  if (ctx) {
    if (typeof groupId === 'number' && typeof toIndex === 'number') ctx.tabs.moveGroup(groupId, toIndex)
    return ctx.tabs.listGroups()
  }
  return []
})
```

`src/preload/index.ts`：`BrowserAPI` 的「标签组」块加
`groupsMove: (groupId: number, toIndex: number) => Promise<TabGroupInfo[]>`，实现加
`groupsMove: (groupId, toIndex) => ipcRenderer.invoke('groups:move', groupId, toIndex)`。

**验证**：`npm run typecheck`（两个 tsconfig 都过）。

### 步骤 4 — 渲染层手势

`src/renderer/src/App.vue` 的 `<script setup>`，新增一小节（放在「标签操作」附近）：

```ts
// ---------- 标签栏拖动排序 ----------
/**
 * 用指针手势而不是 HTML5 拖拽:原生拖拽会话能被拖出窗口,本功能明确**不允许**拖出去开新窗口
 * (跨窗口拖标签在 multi-window 一期就列为不做);指针方案还能随时收手,不受 app-region 影响。
 * 顺序真源仍是主进程:每越过一个邻项中线就发一次 IPC,主进程重排后回推 groups:changed ——
 * 渲染层不另存一份「临时顺序」,松手/丢事件都不会留下对不上的状态。
 */
const draggingGroupId = ref<number | null>(null)
/** 本次手势按下后是否真的拖动过:PointerUp 之后浏览器还会补一次 click,得凭它吞掉 */
let dragMoved = false
let dragStartX = 0
const DRAG_THRESHOLD = 4

function onTabPointerdown(g: TabGroupInfo, e: PointerEvent): void {
  if (e.button !== 0) return
  const el = e.target as HTMLElement
  // 关闭按钮 / 组内非聚焦窗格图标各有自己的点击语义,不在它们身上起拖
  if (el.closest('.tab-close, .tab-pane-icon')) return
  draggingGroupId.value = g.id
  dragMoved = false
  dragStartX = e.clientX
  // 接管指针:拖到窗口外(页面区)也能收到 pointerup,不至于留下拖拽态
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
  window.addEventListener('blur', endDrag)
}

/** 指针 x → 目标下标:排在「中线在指针左边」的所有**其它**项之后(只用别人的中线,手感才不抖) */
function dropIndexFor(draggedId: number, x: number): number | null {
  const els = Array.from(chromeRoot.value?.querySelectorAll<HTMLElement>('.tabstrip-left .tab') ?? [])
  // DOM 还没跟上数据(IPC 回来的那一帧)不算,免得多发一次 IPC
  if (els.length !== groups.value.length) return null
  let k = 0
  for (let i = 0; i < els.length; i += 1) {
    if (groups.value[i].id === draggedId) continue
    const r = els[i].getBoundingClientRect()
    if (x > r.left + r.width / 2) k += 1
  }
  return Math.min(k, groups.value.length - 1)
}

function onDragMove(e: PointerEvent): void {
  const id = draggingGroupId.value
  if (id == null) return
  if (!dragMoved && Math.abs(e.clientX - dragStartX) < DRAG_THRESHOLD) return
  dragMoved = true
  const to = dropIndexFor(id, e.clientX)
  const cur = groups.value.findIndex((g) => g.id === id)
  if (to == null || cur < 0 || to === cur) return // 每一帧 mousemove 不该都发 IPC
  void api.groupsMove(id, to)
}

function endDrag(): void {
  draggingGroupId.value = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
  window.removeEventListener('blur', endDrag)
  // 不清 dragMoved:紧随其后的那次 click 要靠它吞掉(下一个 pointerdown 才复位)
}

/** 拖过之后浏览器仍会补一次 click:吞掉它,否则松手会把被拖的标签激活 */
function onTabClick(g: TabGroupInfo): void {
  if (dragMoved) return
  void activateTab(focusedTabId(g))
}
```

并在既有 `onBeforeUnmount` 里补 `endDrag()`（窗口级监听不跟着组件卸载走）。

模板（`App.vue:619-630`）：

```html
<div
  v-for="g in groups"
  :key="g.id"
  class="tab no-drag"
  :class="{
    active: isGroupActive(g),
    crashed: groupCrashed(g),
    'group-split': isSplitGroup(g),
    'tab-dragging': draggingGroupId === g.id
  }"
  @pointerdown="onTabPointerdown(g, $event)"
  @click="onTabClick(g)"
  @auxclick="(e) => { if (e.button === 1) closeTab(focusedTabId(g)) }"
>
```

`.tab-pane-icon` / `.tab-close` 的 `@click.stop` 与 `@auxclick.stop` 不动。

`src/renderer/src/style.css` 的 `.tab.group-split` 附近：

```css
/* 拖动排序中:被拖的那一项半透明(顺序本身就是实时重排的,不需要 ghost / 插入指示线) */
.tab.tab-dragging {
  opacity: 0.5;
  cursor: grabbing;
}
```

**顺带核对（不改）**：`@dblclick="newTab"` 在 `.tabstrip-left` 上，双击标签项本身会冒泡到它 —— 这是既有行为
（拖动是单次 mousedown，不会触发 dblclick），本次不动它；如果实测发现拖动后偶发双击，再单独处理。

**验证**（步骤 4+5 一起，见下）。

### 步骤 5 — 真浏览器验证（bow 的 dev 模式）

1. `npm run dev`，开 3~4 个标签（含一个 `Ctrl+Shift+方向` 分出的分屏组）。
2. 用 bow 浏览器（CDP `Input.dispatchMouseEvent`：`mousePressed` → 多次 `mouseMoved` → `mouseReleased`，
   `button:'left'`，`buttons:1`，坐标取各标签项中线）：
   - 把第 1 项拖到第 3 项右侧 ⇒ DOM `.tab` 顺序变化，且 `browserAPI.getGroups()` 的 `id` 顺序与 DOM 一致；
   - 拖动中的项带 `.tab-dragging`；松手后消失；**被拖的项没有被激活**（`getActiveTab()` 不变）；
   - 单击一次标签（没有拖动）仍能激活 → 阈值/吞 click 没把点击吃掉；
   - 单独点 `×`、中键点项体（`auxclick`）行为不变；
   - `Ctrl+1..3` 跟着新顺序切组（同一份 `listGroups()`）。
3. 分屏组整体挪动：拖动一个分屏组，两个窗格仍在同一项里（不会拆组）；拖完 `layout` 后窗格几何正常
   （活动组两半都可见、分隔条位置正确）。
4. 把鼠标拖出标签栏（拖到页面区/窗口外）松手：**不发生新窗口、不发生 detach**，顺序按最后一次有效位置落下；
   之后 `pointermove` 残留监听见 `pointerup`/`blur` 已清理（再拖动一次仍正常）。
5. 回归：`npm test`（含步骤 1 新增用例）、`npm run typecheck` 全绿；`bow://settings` 的快捷键页不受影响（没有新键位）。

### 步骤 6 — 文档

- `README.md` §「标签组与嵌套分屏」（`:479` 「新建标签永远是新建一个组」那条附近）补一条：
  「**按住标签项左右拖动可调整顺序**（一项 = 一个组，分屏组整体挪）；只改变顺序，拖到窗口外不会新开窗口、
  也不会把标签挪到别的窗口。顺序只在内存，不跨重启保存。」
- `docs/ARCHITECTURE.md`：
  - §7.1 API 表「标签组」行补 `groupsMove(groupId,toIndex)`；
  - §7.2「标签栏按组渲染」条目补一句：拖动排序是**指针手势 + 实时排序**，顺序真源仍是主进程 `groups`
    （每跨一次邻项中线发一次 `groups:move`），故**没有**渲染层临时顺序；
  - IPC 表（`:929` 附近）补 `groups:move | groupId, toIndex | TabGroupInfo[]（拖动排序:把某组挪到结果数组的最终下标；夹紧 / no-op 在 moveTabGroup）`；
  - `:221` 标签组小节补「数组顺序 = 标签栏顺序，`Ctrl+1..9` 与『新标签插在活动组后』都跟着它走」；
  - §测试计数：`groups`(26→31) 与「合计 713」按实际改（跑完 `npm test` 抄真实数字）；
  - 若 `App.vue` 的体积/职责描述写死了行数（`:763` 的「13KB」），按需更新。

## 4. 实际落地的验证（2026-10-07）

- `npx vitest run tests/groups.test.ts` → **31 passed**（原 26，+5）；`npx vitest run` → **65 文件 / 1254 用例全绿**。
- `npm run typecheck` 绿；`npm run build` 绿（`.vue` 不在 tsc 范围，必须 build 一次）。
- **真 Electron 驱动**（一次性脚本 `/tmp/bow-drag-verify.mjs`，未入库；思路同 `scripts/e2e-tab-id-reveal.mjs`：
  `npx electron . --ozone-platform=headless --remote-debugging-port=…` + CDP 在 **chrome target** 上发
  `Input.dispatchMouseEvent`），**19 项全过**：
  - 拖第 1 项到第 3 项右侧 → 主进程 `getGroups()` 顺序变为 `[原2, 原3, 原1]`，DOM 顺序（用 `dataset.vIdx` 标记反查）一致；
  - 拖动中 `.tab-dragging` 存在、松手消失；
  - 松手**不会**激活被拖的标签（补发的那次 click 被吞掉）；单击（没拖动）仍能激活；
  - 点 `×` 仍能关窗格（总数 −1）；
  - 分屏组整体挪位、窗格数与几何照常（没被拆组）；
  - 往标签栏下方（页面区）拖 300px 再松手：**组数不变、仍只有一个窗口的 chrome**、拖拽态被清掉
    （说明 `setPointerCapture` 确实把 `pointerup` 送到了 chrome）。
- 未入库 `scripts/e2e-tab-reorder.mjs`（计划里列为不做）；要长期回归保护再说一声。

## 5. 风险与未决

1. **实时 IPC 的观感**：每次跨越邻项中线都会走一次 `invoke` + `groups:changed` 往返。同进程、亚毫秒级，
   理论上跟手；如果实测有滞后/抖动，退路是「本地位移 + 松手时一次提交」（需要同时保存原顺序以便取消，
   代码量略增）。**先用实时提交，实测不行再换**。
2. **指针捕获是否跨窗口边界仍派发 `pointerup`**：Chromium 的 `setPointerCapture` 通常能兜住，
   但没在 Electron 44 的 `WebContentsView` 架构下实测过。兜底已经有三重：`pointercancel` + `blur` +
   下一个 `pointerdown` 复位；且因为实时提交，「丢 pointerup」只会留下一点点样式残留，不会造成旧实现那种
   数据不一致（**这是选实时提交的一个附带好处**）。
3. **标签超出可视区**：`.tabstrip-left` 是 `overflow: hidden`，标签多了会被裁掉（既有行为，没有横向滚动）。
   被裁掉的项拿不到指针 → 只能拖到可见范围内。不改。
4. **`-webkit-app-region: drag` 与手势的交互**：`.tab` 是 `no-drag`，理论上按下不会触发窗口拖动；
   若实测出现「拖标签时窗口跟着跑」，退路是在拖动期间给标签栏条带临时摘掉 `drag` 类（主进程无需改）。
5. **不做的事**（明确排除）：拖出窗口 / detach 到新窗口、跨窗口拖标签、拖动到别的组里合并、拖拽分屏窗格、
   标签栏横向滚动与自动滚动、`Ctrl+Shift+PageUp/Down` 之类的键盘排序、顺序持久化。
6. **未决**：是否要顺带给拖动加 `<TransitionGroup>` 滑动动画（约 8 行 CSS，Chrome 的手感来源之一）。
   默认不做 —— 与本仓库「不加没要求的东西」一致；想要就单独说。
