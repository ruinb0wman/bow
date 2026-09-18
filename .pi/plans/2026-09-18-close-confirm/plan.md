# 关闭窗口确认:多标签时先弹应用内确认框

## 0. 目标与已拍板的前提

**目标**:点标题栏关闭按钮 / `Alt+F4` / 窗口管理器关闭窗口时,只要当前**还有 ≥2 个标签页**,先弹一个应用内确认框;
用户确认后才真正关闭(关闭窗口 = 退出应用,见 §1)。只有 1 个或 0 个标签时保持现状:直接关。

问卷结论(本次实现的前提,勿擅自改回):

| 问题 | 选择 |
| --- | --- |
| 拦哪种「关闭」 | **只拦关闭窗口/退出**,不拦关单个标签(`Ctrl+W` / 标签上的 × 保持原样) |
| 弹窗形态 | **应用内自绘模态**(复用 Overlay + `ModalShell`),不用 `dialog.showMessageBox` |
| 设置项 | **不加开关**,行为固定;常规设置页保持「搜索引擎 / 主页」两项不变 |
| 计数口径 | `tabs.listTabs().length`,**所有标签都算**(含 `bow://settings` 与设备检查的 DevTools 前端标签) |

> 假设(代码里没有的东西,不要当成现状):bow **不保存会话**——`settings.json` 只有
> `searchEngine/homepage/corsBypassEnabled/corsWhitelist`,`closedStack` 只在内存里,重启后标签不会恢复。
> 所以确认框文案里可以老实写「重启后不会恢复」;这也正是弹确认框的理由。

## 1. 现状(以下都是在仓库里实读到的)

- `src/main/index.ts:239`:`app.on('window-all-closed', () => app.quit())` —— **关窗口就等于退出应用**。
- `src/main/ipc.ts:130`:`ipcMain.handle('window:close', () => mainWindow.close())` —— 自绘标题栏的关闭按钮走这里
  (`App.vue:371` → `preload/index.ts:100`)。`Alt+F4` / WM 关闭不经过 IPC,直接触发 `BrowserWindow` 的 `close` 事件;
  **两条路径都汇聚到 `close` 事件**,所以只需在 `close` 上做拦截。
- 现在**没有任何** `close` / `before-quit` 拦截逻辑(`grep` 全仓库只有 `device-inspect` 插件用 `before-quit` 回收 adb 转发)。
- Overlay 框架:`overlay.ts` 的 `OverlayManager.show(content|null)`,核心浮层 id 目前只有 `'suggest'`
  (`shared/types.ts:57` `CoreOverlayContentId = 'suggest'`);
  `OverlayApp.vue:15` 的 `const CORE: Record<string, Component> = { suggest: markRaw(SuggestPanel) }`。
  `full` placement 会铺满窗口并接管焦点(`overlay.ts` 的 `show()` 里 `this.view!.webContents.focus()`)。
- overlay 事件回流:`组件 emit('overlay-event')` → `OverlayApp.emitEvent` → `api.overlayEmit(id,event,args)`
  → `ipc.ts` 的 `ui:overlay-event`(先判 `suggest`,再判 `close-request`,其余 `kernel.routeOverlayEvent`)。
  `kernel.routeOverlayEvent` 对非 `plugin:` id 直接 `return false`,**所以核心浮层必须自己处理事件,不能指望内核兜底**。
- `ModalShell.vue` 已提供遮罩 + Esc(模块级弹层栈只让栈顶响应)+ 点遮罩关闭,统一发 `'close-request'`。
- 可复用的样式在 `renderer/src/style.css`:` .modal-mask` / `.modal` / `.modal-head` / `.btn` / `.btn.primary` / `.btn.danger`
  (overlay 入口 `renderer/src/overlay/main.ts` import 了 `../style.css`)。

## 2. 方案(数据流与关键设计)

```
点关闭按钮(window:close IPC) ─┐
Alt+F4 / WM close ────────────┴→ mainWindow.on('close')
                                   │ tabs.listTabs().length < 2 → 放行(直接关)
                                   │ overlay.currentId === 'confirm-close' → 放行(第二次触发 = 强制关)
                                   └ 否则 e.preventDefault()
                                      overlay.show({id:'confirm-close', payload:{tabCount}, placement:'full'})
                                             │
        overlay 页面:CloseConfirmModal(ModalShell)
          「取消」/Esc/点遮罩 → emit('overlay-event','close-request')
                → ipc.ts 现有分支 overlay.show(null) → 窗口不关(再次点 X 仍会弹)
          「关闭窗口」       → emit('overlay-event','confirm')
                → ipc.ts 新分支 → closeConfirm.confirmWindowClose(mainWindow)
                → confirmed = true → mainWindow.close() → 本次 close 放行
```

三个刻意的设计点:

1. **走现成的 overlay-event 通道,不新增 IPC 通道、不动 preload。** `ipc.ts` 里已经为 `suggest` 开了
   核心浮层特判的先例,`confirm-close` 照抄同样的位置加一个分支即可(`confirm` → 确认;`close-request` → 取消走通用分支)。
   好处:所有浮层组件对宿主的说话方式保持一致,`window.browserAPI` 表面不变(docs §7.1 无需改)。
2. **`overlay.currentId === 'confirm-close'` 时放行。** 这既是「Alt+F4 按第二次 = 强制关闭」的出口,
   也是 overlay 页面画不出来(dev server 未起 / overlay chunk 坏了)时**唯一不自锁**的出口——
   那时模态遮罩根本不存在,点不到任何按钮,而 `currentId` 是主进程自己的状态,不依赖渲染是否成功。
   已知代价:模态遮罩盖住整窗(含标题栏),所以这个出口只对键盘/窗口管理器触发有效,对鼠标点 X 无效。
3. **状态放在新模块 `closeConfirm.ts` 的模块级变量里,不塞进 `index.ts` 闭包。** 与 `tabShortcuts.ts` /
   `singleInstance.ts` 同风格,并让 `ipc.ts` 能直接 `import { confirmWindowClose }` 而**不必改 `registerIpc` 的签名**。
   单窗口应用,`confirmed` 一旦置位不再复位(窗口关了进程也就退了)。

## 3. 改动清单

新增:

| 文件 | 内容 |
| --- | --- |
| `src/main/closeConfirm.ts` | `installCloseConfirm(window, tabs, overlay)` + `confirmWindowClose(window)` + `CLOSE_CONFIRM_OVERLAY_ID` |
| `src/renderer/src/components/CloseConfirmModal.vue` | 核心浮层组件(`ModalShell` + `.modal-head` + `.btn`) |
| `tests/closeConfirm.test.ts` | 拦截/放行/确认/取消的假实现单测(仓库已有 `vi.mock('electron')` 先例) |

修改:

| 文件 | 改什么 |
| --- | --- |
| `src/shared/types.ts` | `CoreOverlayContentId` 加 `'confirm-close'`;新增 `CloseConfirmPayload`;`OverlayContentMap` 登记 |
| `src/main/ipc.ts` | `ui:overlay-event` 里加 `id === 'confirm-close' && event === 'confirm'` 分支 |
| `src/main/index.ts` | `overlay = new OverlayManager(...)` 之后调用 `installCloseConfirm(mainWindow, tabs, overlay)` |
| `src/renderer/src/overlay/OverlayApp.vue` | `CORE` 注册表加 `'confirm-close'` |
| `README.md` | 新小节「关闭窗口」(放在「手动使用快捷键」与「数据存储」之间) |
| `docs/ARCHITECTURE.md` | 目录地图、启动时序、§3 overlay 消息流表、§7.2 注册表、§9 IPC 表、§11 测试基线、§13 坑 |

**不动**:`src/preload/*`(无新 API)、`src/main/overlay.ts`、`src/main/tabShortcuts.ts`(Ctrl+W 行为不变)、
`src/renderer/src/App.vue`(关闭按钮仍只发 `window:close`)、常规设置页(不加开关)、
`docs/ARCHITECTURE.md §12 文档漂移审计`(那份表是另一件待办,不许顺手改)。

## 4. 分步实施(每步单独可验证)

**S1 `src/shared/types.ts` —— 类型先行**
把 `CoreOverlayContentId = 'suggest'` 改成 `'suggest' | 'confirm-close'`,加:
```ts
/** 关闭窗口确认浮层的 payload(标签数按主进程拦下时的快照,见 closeConfirm.ts) */
export interface CloseConfirmPayload { tabCount: number }
export interface OverlayContentMap { suggest: SuggestPayload; 'confirm-close': CloseConfirmPayload }
```
顺便把上面那段注释里的「约定:`suggest` = …」补一行 `confirm-close`。
验证:`bun run typecheck`(此时 `OverlayContentMap` 有新 key 但没人用,应全绿)。

**S2 `src/main/closeConfirm.ts` —— 主进程拦截器**
```ts
import type { BrowserWindow } from 'electron'
import type { TabManager } from './tabManager'
import type { OverlayManager } from './overlay'
import { log } from './logger'

/** 必须与 OverlayApp.vue 核心注册表的 key 一致 */
export const CLOSE_CONFIRM_OVERLAY_ID = 'confirm-close'
/** 触发确认的标签数下限:1 个标签直接关,不打扰 */
const MIN_TABS_TO_CONFIRM = 2

/** 用户已确认关闭。单窗口应用,置位后不再复位 */
let confirmed = false

export function installCloseConfirm(window: BrowserWindow, tabs: TabManager, overlay: OverlayManager): void {
  window.on('close', (e) => {
    if (confirmed) return
    // 确认框已经开着还再次触发关闭(Alt+F4 / 窗口管理器)→ 视为强制关闭。
    // 这条同时是 overlay 页面加载失败时的唯一出口:那时遮罩画不出来,点不到任何按钮。
    if (overlay.currentId === CLOSE_CONFIRM_OVERLAY_ID) {
      log('再次触发关闭,跳过确认')
      return
    }
    const tabCount = tabs.listTabs().length
    if (tabCount < MIN_TABS_TO_CONFIRM) return
    e.preventDefault()
    overlay.show({ id: CLOSE_CONFIRM_OVERLAY_ID, payload: { tabCount }, placement: 'full' })
    log('关闭窗口已拦下,等待确认', tabCount)
  })
}

/** 用户在确认框里点了「关闭窗口」:放行本次 close */
export function confirmWindowClose(window: BrowserWindow): void {
  confirmed = true
  if (!window.isDestroyed()) window.close()
}
```
验证:`bun run typecheck`。

**S3 `src/main/ipc.ts` —— 事件路由**
在 `ui:overlay-event` 的 `suggest` 分支后、`close-request` 分支前插入:
```ts
if (ev.id === CLOSE_CONFIRM_OVERLAY_ID && ev.event === 'confirm') {
  confirmWindowClose(mainWindow)
  return true
}
```
(`import { CLOSE_CONFIRM_OVERLAY_ID, confirmWindowClose } from './closeConfirm'`)。
`close-request`(取消)继续走现有分支 → `overlay.show(null)`。
验证:`bun run typecheck`。

**S4 `src/main/index.ts` —— 接线**
`overlay = new OverlayManager(mainWindow, tabs)` 之后加 `installCloseConfirm(mainWindow, tabs, overlay)`。
位置放在 `mainWindow.on('focus', …)` 那一簇之前/之后都行,但必须在窗口创建之后、用户可能触发关闭之前。
验证:`bun run dev` → 开 2 个标签 → 点关闭按钮:窗口**不关**,但此时还没注册组件,overlay 是空白遮罩 → 按 Esc 应能取消
(这一步只验证「拦住了、Esc 能退出」;真正的 UI 在 S5)。

**S5 `src/renderer/src/components/CloseConfirmModal.vue` + `OverlayApp.vue` —— 确认框 UI**
组件契约与 `SuggestPanel`/`BookmarksModal` 一致:`payload` prop + `overlay-event` emit(`OverlayApp.vue` 会无条件传 `:band-top`,本组件声明 `inheritAttrs: false` 忽略它):
```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { CloseConfirmPayload } from '@shared/types'
import ModalShell from '@renderer/components/ModalShell.vue'

const props = defineProps<{ payload: CloseConfirmPayload }>()
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()
// 与 BookmarksModal 一致:宿主无条件传 band-top,别让它落到 ModalShell 的根元素上
// (本弹层是 full placement,bandTop 恒为 0,不需要这个 prop)
defineOptions({ inheritAttrs: false })
const cancelBtn = ref<HTMLButtonElement | null>(null)

function onShellEvent(event: string, args?: unknown): void { emit('overlay-event', event, args) }
function cancel(): void { emit('overlay-event', 'close-request') }
function confirm(): void { emit('overlay-event', 'confirm') }

// 默认焦点给「取消」:Enter 不该顺手把窗口关掉
onMounted(() => cancelBtn.value?.focus())
</script>

<template>
  <ModalShell @overlay-event="onShellEvent">
    <div class="modal-head">关闭窗口?</div>
    <div class="cc-body">当前有 <strong>{{ props.payload.tabCount }}</strong> 个标签页,关闭后会一并关闭;bow 不保存会话,重启后不会恢复。</div>
    <div class="cc-actions">
      <button ref="cancelBtn" class="btn" @click="cancel">取消</button>
      <button class="btn primary" @click="confirm">关闭窗口</button>
    </div>
  </ModalShell>
</template>
```
样式用 `<style scoped>` 只写 `.cc-body` / `.cc-actions`(padding、`display:flex; justify-content:flex-end; gap:8px`);
遮罩/面板/按钮复用 `style.css` 既有类,不新增全局样式。
`OverlayApp.vue` 的 `CORE` 加一行 `'confirm-close': markRaw(CloseConfirmModal)`。
验证:`bun run dev` → 见 §8 手动验收清单。

**S6 `tests/closeConfirm.test.ts` —— 单测**
仿 `tests/mcpHttp.test.ts` 的 `vi.mock('electron', …)` + `FakeTabs`,假 window 用 `EventEmitter` + `{ isDestroyed: () => false, close: vi.fn() }`,
假 overlay 用 `{ currentId: null, show: vi.fn() }`。用例:

1. 0/1 个标签 → `close` 不 `preventDefault`、不 `overlay.show`(直接关)。
2. ≥2 个标签 → `preventDefault` 被调用,`overlay.show` 收到 `{ id:'confirm-close', placement:'full', payload:{ tabCount } }`。
3. `confirmWindowClose(window)` → `window.close()` 被调用;随后 `close` 事件**不再**被拦(放行)。
4. 取消(模拟 `overlay.show(null)`,`currentId` 变回 null)→ 窗口没关;再次 `close` 仍会弹确认(取消不是永久放行)。
5. `overlay.currentId === 'confirm-close'` 时再次 `close` → 放行(强制关闭/防自锁出口)。

验证:`bunx vitest --run tests/closeConfirm.test.ts`,再 `bunx vitest --run`(全量)与 `bun run typecheck`。

**S7 文档**
- `README.md`:在「手动使用快捷键」(约 349 行)之后、「数据存储」(约 359 行)之前插入
  ```markdown
  ## 关闭窗口

  点标题栏关闭按钮 / `Alt+F4` / 窗口管理器关闭窗口时,只要还有 **2 个及以上标签页**,会先弹出应用内确认框
  (设置页 `bow://settings` 与设备检查的 DevTools 前端标签**也算在内**):

  - 「取消」/ `Esc` / 点遮罩 → 回到页面,窗口不关;
  - 「关闭窗口」→ 关掉窗口并退出 bow,全部标签页一并丢弃(**bow 不保存会话**,重启不会恢复);
  - 确认框开着时再按一次 `Alt+F4` = 直接关闭(也是 overlay 渲染异常时唯一不自锁的出口)。

  只有 1 个标签(或没有标签)时直接关闭,不打扰。`Ctrl+W` / 标签上的 × 关单个标签**不**确认。
  ```
- `docs/ARCHITECTURE.md`:
  - §1 目录地图:`tabManager.ts` 行附近加 `closeConfirm.ts   关闭窗口确认:多标签时拦下 close 事件改用应用内确认框`;
    `src/components/` 那行加 `CloseConfirmModal(关闭确认)`。
  - §2 启动时序:第 7 行后加 `7.5 installCloseConfirm(mainWindow, tabs, overlay)   拦 close;≥2 标签时弹确认框`。
  - §3 overlay 消息流的表:第二行说明改成「`ev.id === 'suggest'` 转发 chrome;`ev.id === 'confirm-close'` 且 `event === 'confirm'` → `closeConfirm.confirmWindowClose()`;`ev.event === 'close-request'` 主进程直接关;其余 `kernel.routeOverlayEvent()`」,
    并在表下补一句:关闭拦截的状态与出口(`currentId === 'confirm-close'` 二次触发放行)。
  - §7.2:`OverlayApp.vue` 那句改成 核心 `{suggest: SuggestPanel, 'confirm-close': CloseConfirmModal}`。
  - §9 IPC 表:`ui:overlay-event` 行补「含 `confirm-close` 的确认/取消」;`window:close` 行补「≥2 标签时被 `closeConfirm` 拦下,先弹确认框」。
    (preload 无新方法,§7.1 不动。)
  - §11 测试约定:基线 `35 个文件 / 573 个用例` → 按实测改成 `36 个 / 573+N`,「其余」列表补 `closeConfirm`(N)。
  - §13 架构层:补一条「关闭拦截三原则:①只拦窗口不拦标签;②`currentId === 'confirm-close'` 的二次触发必须放行(overlay 画不出来时否则窗口关不掉);
    ③Windows 会话结束走 `query-session-end`/`session-end`,不经 `close` 的路径别去 preventDefault」。
  - 行号有漂移的先例(§12),写文档时按内容定位、不要照抄本计划里的行号。

## 5. 验证矩阵

| 步骤 | 命令 | 期望 |
| --- | --- | --- |
| S1–S3 后 | `bun run typecheck` | 全绿 |
| S6 后 | `bunx vitest --run tests/closeConfirm.test.ts` | 5 例全绿 |
| S6 后 | `bunx vitest --run` | 全绿(基线 573 + N) |
| S5 后 | `bun run dev` + §8 清单 | 见下 |

## 6. 手动验收清单(`bun run dev`,必做)

1. 开 2 个网页标签 → 点自绘的关闭按钮 → 确认框出现,数字 = 2;`Esc` → 回到页面,窗口在;再点 X → 仍弹确认(第 4 条用例的真机版)。
2. 确认框里点「关闭窗口」→ 窗口关闭、进程退出(终端里 electron 退出)。
3. 重开,开 2 个标签 → `Alt+F4`(不是点 X)→ 确认框出现;再 `Alt+F4` → 直接关闭(强制出口)。
4. 只开 1 个标签 → 点 X → **不弹框**,直接关。
5. 0 标签的极端情形(关掉全部标签后会自动补 `about:blank`,所以实际是 1 个)→ 点 X 直接关。
6. 设置页标签 + 1 个网页标签(共 2)→ 点 X → 弹确认(证明 `bow://settings` 计入)。
7. 确认框里点「取消」/点遮罩 → 不关,且焦点回到页面(OverlayManager 的 `refocusTab` 行为)。
8. 确认框开着时按 `Ctrl+T` / `Ctrl+W` → 标签数会变(见 §7 风险 1),确认后窗口照常关。

## 7. 风险与未知

1. **确认框打开期间 `Ctrl+T` / `Ctrl+W` 仍生效**(主进程 `tabShortcuts.ts` 是全局拦截,`new` 分支只在 `isFullOpen` 时不抢焦点、
   并不禁止新建;`close` 分支没有任何 modal 判断)。后果:文案里的 `tabCount` 是拦下时的快照,可能过时(不影响确认结果)。
   处理:本次按现状接受;若要收紧,应在 `tabShortcuts.ts` 里对 `isFullOpen` 时跳过 `new`/`close`——那是独立改动,不在本计划内。
2. **确认框会顶掉当前已打开的全窗浮层**(如书签面板):`OverlayManager.show()` 对 `full` 是直接替换 `current`。
   用户「开着书签面板按 Alt+F4」会看到书签面板被换掉、取消后不自动还原。可接受,但要知道。
3. **不拦单个标签**:误按 `Ctrl+W` 关掉一个标签依旧没有确认。
4. **系统关机/注销**:Electron 文档明确「Windows 上系统关机/重启/注销时 `before-quit` 不触发」,Windows 走
   `query-session-end` → `session-end`(不经窗口 `close`);Linux 走 SIGTERM 进程级退出。所以本方案不需要额外放行代码,
   但也**不要**顺手加 `before-quit` 拦截——那才会真的挡住注销。真机验证时如果要跑关机测试,注意这一点。
5. **`overlay.currentId` 是主进程状态,不保证渲染成功**:若 overlay 页面因 dev server 未起而加载失败,确认框不会出现,
   此时**第二次触发关闭**会直接放行(设计如此)。真机上表现为「第一次点 X 没反应,第二次才关」。
6. **未验证**:`bun run dev` 下的真机行为本次只能人工跑(仓库没有 E2E;`.vue` 组件没有单测先例,`tests/` 全是 node 环境的 .ts)。
   组件层只能靠 `bun run typecheck` + 手动清单。

## 8. 收尾

- 改动完成后:更新 `docs/ARCHITECTURE.md` §11 的测试基线数字(实跑 `bunx vitest --run` 取真实值)。
- 往 `SCRATCHPAD.md` 记一条待办:§7 风险 1(`Ctrl+T/Ctrl+W` 在 modal 打开时仍生效)是否要收紧。

---

## 9. 实施记录(2026-09-18 完成)

改动与计划一致,只有两处偏差:

1. **§13 的坑没有插进「架构层」编号列表**(那会把后面 7–28 全部重编号)。改成在列表末尾新开一组
   「**关闭窗口确认**」,编号 29/30 续在原序列后面 —— 与既有「**远端调试(设备检查插件)**」分组风格一致。
2. **§11 顺手修了两处早已漂移的数字**:`deviceInspect.test.ts` 425行/38例 → 565/49,`deviceInspectTargets.test.ts`
   434/20 → 608/28(那两条在 2026-09-18 20:57 加过用例,文档没跟上),`deviceInspectRelay` 236→237 行。
   §12 的漂移审计表**没动**(那份表是另一件待办)。

验证结果:

| 项 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过(`tsconfig.node.json` + `tsconfig.web.json`) |
| `bunx vitest --run tests/closeConfirm.test.ts` | 6 例全绿 |
| `bunx vitest --run` | **36 个文件 / 598 个用例全绿**(基线 35/592 → +1 文件 +6 例) |
| `bun run build` | 通过;`out/main/index.js` 与 `out/renderer/assets/overlay-*.js` 里都能 grep 到 `confirm-close` |
| 真机 E2E(CDP) | 见下 |

**真机 E2E 是脚本化的**(不是手点):`bunx electron . --remote-debugging-port=93xx` +
`XDG_CONFIG_HOME=/tmp/...`(借 `applyBrowserIdentity()` 用 `appData` 拼 userData 这一点做隔离 profile,
既不碰真身数据也不受单实例锁影响),再用 CDP 驱动 chrome 视图与 overlay 视图。驱动脚本在
`/tmp/cc-cdp.ts`(主流程)、`/tmp/cc-close2.ts`(边界)、`/tmp/cc-stack.ts`(栈取证)。

实测输出(2 标签):

```
确认框标题: 关闭窗口?
确认框正文: 当前有 2 个标签页,关闭后会一并关闭;bow 不保存会话,重启后不会恢复。
按钮: ["取消","关闭窗口"] 默认焦点: 取消
点完 X 后进程还活着: true
取消后确认框还在吗: false
取消后进程还活着: true
二次点击后确认框标题: 关闭窗口?
已点击「关闭窗口」→ 应用已退出(CDP 端口已关),第 250 ms
```

边界(3 标签 / 1 标签):3 标签 → 文案「当前有 3 个标签页」→ 开着确认框**再次触发关闭**(用
`browserAPI.closeWindow()`,与 `Alt+F4` 走的是同一个 `close` 事件路径)→ 日志「再次触发关闭,跳过确认」→ 应用退出;
1 标签 → 不弹框直接退出。

**注意**:鼠标点 X 的「二次触发」在真机上不可达(遮罩盖住标题栏),只能用 Alt+F4 / 窗口管理器 —— 脚本里
用 `closeWindow()` 等价替代。因此 §8 清单里的 Alt+F4 两条只剩「键盘事件本身是否到达 WM」没验(那是 WM 的事)。

## 10. 验证时发现的既有缺陷(不在本次范围,已记 SCRATCHPAD)

关窗口时**每个标签都会在主进程抛一次 `TypeError: Object has been destroyed`**(与本次改动无关:
1 标签不弹框直接关的那次也有 1 条,异常数恒等于标签数)。用主进程 inspector 注入 `uncaughtException`
打印栈拿到根因:

```
TypeError: Object has been destroyed
    at TabManager.layout            ← window.getContentSize():窗口已销毁
    at TabManager.activate
    at TabManager.activateLastVisible
    at WebContents.<anonymous>      ← wireLifecycle 的 wc.on('destroyed')
TypeError: Object has been destroyed
    at TabManager.sendTabsList      ← ipc.ts 的 tabs.on('tabs-changed') → mainWindow.webContents.send
    at WebContents.<anonymous>      ← 同一个 destroyed 处理器里的 this.emit('tabs-changed')
```

即:窗口销毁 → 各标签 view 的 webContents 依次 `destroyed` → `TabManager.wireLifecycle` 的处理器在
**窗口已死**的前提下继续 `layout()` / `emit('tabs-changed')`。因为关闭流程本来就要退出,影响只是日志噪音;
修法是 `layout()` 开头加 `if (this.window.isDestroyed()) return`,以及 `ipc.ts` 的 `sendTabsList` 同样先判窗口。

## 11. 追加:§10 那条既有缺陷已顺手修掉(用户拍板「顺手修掉」)

改动(三处,与关闭确认本身解耦,单独提交):

| 位置 | 改动 |
| --- | --- |
| `tabManager.ts` 的 `layout()` | 开头 `if (this.window.isDestroyed()) return` |
| `tabManager.ts` 的 `activate()` | 取到记录后、改 `activeId` 前,窗口已销毁就直接返回(否则 `layout()` 被挡住后仍会撞在 `window.webContents.send` 上) |
| `ipc.ts` | 抽出 `sendToChrome(channel, payload)`,同时判窗口与 `webContents` 是否销毁;`sendTabsList` / `broadcast` / `tab-updated` / suggest 转发统一改用它 |

**没有单测**:`tests/` 里没有 `TabManager` / `ipc.ts` 的替身(它们直接吃真实 `BrowserWindow`/`WebContentsView`),
给这个加假实现不值当。改用真机判据(比原来更硬):三条关闭路径的 `browser.log` 里 `未捕获异常` 必须为 **0 条**。

| 真机路径 | 修前 | 修后 |
| --- | --- | --- |
| 2 标签 → 确认框 → 确认退出 | 2 条 | **0 条** |
| 1 标签 → 不弹框直关 | 1 条 | **0 条** |
| 3 标签 → 开着确认框再触发 close → 退出 | 3 条 | **0 条** |

(修前 3 条跑法:在同一轮里先注入 `uncaughtException` 打印栈的监听,再用 CDP 关窗;见 §10。)
