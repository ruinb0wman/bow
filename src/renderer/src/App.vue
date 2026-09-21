<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import type { Component } from 'vue'
import type {
  OverlayEvent,
  SplitMenuPayload,
  SplitPaneInfo,
  TabGroupInfo,
  TabInfo,
  Suggestion,
  SuggestPayload,
  SuggestRow
} from '@shared/types'
import type { PluginInfo } from '@shared/plugins'
import type { PluginSlot } from './plugins/types'
import { SETTINGS_URL } from '@shared/internalPages'
import { faviconLetter } from './lib/avatar'
import {
  blurredSession,
  dismissedSession,
  focusedSession,
  lostFocusSession,
  newSession,
  withResults
} from './lib/suggestSession'
import { PLUGIN_UI, SLOT_PLUGIN_ORDER } from './plugins/registry'
import { collectSlot } from './plugins/slots'
import {
  ArrowLeft,
  ArrowRight,
  Columns2,
  Minus,
  Plus,
  RotateCw,
  Settings as SettingsIcon,
  Square,
  TriangleAlert,
  Undo2,
  X
} from 'lucide-vue-next'

const api = window.browserAPI

// ---------- 状态 ----------
const tabs = ref<TabInfo[]>([])
const address = ref('')
const addressEditing = ref(false)
// 显式聚焦标记:区分「点击地址栏 / Ctrl+L / Ctrl+T / 新建标签」与「窗口被动恢复聚焦」,后者不全选文本
let explicitFocus = false
let selectOnFocus = false

// ---------- 插件:启用状态与 UI 插槽 ----------
const plugins = ref<PluginInfo[]>([])
const enabledIds = computed(() => new Set(plugins.value.filter((p) => p.enabled).map((p) => p.id)))

function slotComponents(slot: PluginSlot): Component[] {
  return collectSlot(PLUGIN_UI, slot, (id) => enabledIds.value.has(id), SLOT_PLUGIN_ORDER[slot])
}
const addressbarSlots = computed(() => slotComponents('addressbar-trailing'))
const toolbarSlots = computed(() => slotComponents('toolbar'))

// ---------- 地址栏建议(由插件内核聚合各建议源) ----------
const suggestions = ref<Suggestion[]>([])
const suggestRows = ref<SuggestRow[]>([])
const activeIdx = ref(0)
/**
 * 建议会话:面板可见性 = 「键盘焦点 + 请求代」。
 * 焦点信号不靠 DOM blur / `document.activeElement`(跨 WebContentsView 的焦点切换不可靠),
 * 而是 focus/blur 事件 + 主进程的 `chrome:page-focus`(见 `lib/suggestSession.ts` 顶部注释)。
 */
const suggestSession = ref(newSession())
const showSuggest = computed(() => suggestSession.value.visible)
let suggestTimer: ReturnType<typeof setTimeout> | null = null

const activeTab = computed(() => tabs.value.find((t) => t.active) ?? null)
const currentUrl = computed(() => activeTab.value?.url ?? '')
const loading = computed(() => !!activeTab.value?.loading)

// ---------- 标签组(标签栏的一项 = 一个组;组里是嵌套分屏树) ----------
const groups = ref<TabGroupInfo[]>([])
const splitMenuOpen = ref(false)
/**
 * 面板的「代」:每次打开/刷新 +1。
 * `pushSplitMenu()` 要 await 取布局,期间可能被 `closeSplitMenu()` 关掉(典型序列:
 * `groups-changed` 触发刷新 → 套用布局的 promise 落地把面板关掉 → 刷新的结果又把它打开),
 * 所以取数回来要先比一代,过期的结果直接丢弃。
 */
let splitMenuSeq = 0
const splitBtn = ref<HTMLElement | null>(null)
/** chrome 实测高度(既上报主进程,也用来定位分隔条的起点) */
const chromeHeight = ref(0)

const tabById = computed(() => new Map(tabs.value.map((t) => [t.id, t])))

/** 活动组 = 含活动标签的那个组(主进程不另存 activeGroupId,这里也用同一个口径) */
const activeGroup = computed(
  () => groups.value.find((g) => !!activeTab.value && g.tabIds.includes(activeTab.value.id)) ?? null
)

/** 组内窗格数 >1 才算真分屏 */
const isSplitGroup = (g: TabGroupInfo): boolean => g.tabIds.length > 1

/** 活动组的分隔条带:几何完全来自主进程(渲染层只画不重算) */
const activeGroupDividers = computed(() => activeGroup.value?.dividers ?? [])

/** 组内成员标签(按 tabIds 顺序;标签刚被关掉时过滤掉取不到的) */
function groupTabs(g: TabGroupInfo): TabInfo[] {
  return g.tabIds.map((id) => tabById.value.get(id)).filter((t): t is TabInfo => !!t)
}

/** 组内聚焦的标签 —— 地址栏、关闭按钮、中键都朝着它(`focus` 是 tabId,不是下标) */
function focusedTab(g: TabGroupInfo): TabInfo | undefined {
  const id = g.tabIds.includes(g.focus) ? g.focus : g.tabIds[0]
  return tabById.value.get(id)
}

function focusedTabId(g: TabGroupInfo): number {
  return g.tabIds.includes(g.focus) ? g.focus : g.tabIds[0]
}

/** 非聚焦窗格:标签栏里只显示图标(点击切过去) */
function otherPanes(g: TabGroupInfo): TabInfo[] {
  const focus = focusedTabId(g)
  return groupTabs(g).filter((t) => t.id !== focus)
}

const isGroupActive = (g: TabGroupInfo): boolean => !!activeTab.value && g.tabIds.includes(activeTab.value.id)
const groupLoading = (g: TabGroupInfo): boolean => groupTabs(g).some((t) => t.loading)
const groupCrashed = (g: TabGroupInfo): boolean => groupTabs(g).some((t) => t.crashed)
const groupTitle = (t: TabInfo | undefined): string => (t?.crashed ? '页面崩溃' : t?.title || t?.url || '新标签页')

// ---------- 事件订阅 ----------
const unsubs: Array<() => void> = []

function syncAddress(): void {
  if (!addressEditing.value && activeTab.value) {
    const u = activeTab.value.url
    address.value = u && u !== 'about:blank' ? u : ''
  }
}

const chromeRoot = ref<HTMLElement | null>(null)
const addressInput = ref<HTMLInputElement | null>(null)
const addressBarEl = ref<HTMLElement | null>(null)

onMounted(async () => {
  tabs.value = await api.listTabs()
  groups.value = await api.getGroups()
  syncAddress()
  plugins.value = await api.plugins.list()

  unsubs.push(
    api.onTabUpdated((tab) => {
      const idx = tabs.value.findIndex((t) => t.id === tab.id)
      if (idx >= 0) tabs.value[idx] = tab
      else tabs.value.push(tab)
      syncAddress()
    }),
    api.onTabsChanged((list) => {
      tabs.value = list
      syncAddress()
    }),
    api.onTabActivated(() => {
      syncAddress()
    }),
    api.plugins.onChanged((list) => {
      plugins.value = list
    }),
    // 主进程 Ctrl+T 新建标签后要求聚焦地址栏
    api.onFocusAddressRequest(() => {
      focusAddress()
    }),
    // 主进程窗口失焦:主动释放地址栏焦点,避免 Electron 把焦点恢复到地址栏
    api.onWindowBlur(() => {
      addressInput.value?.blur()
      hideSuggest()
      explicitFocus = false
      selectOnFocus = false
    }),
    // 主进程:键盘焦点已交给某个页面视图(切标签 / 点网页 / 关标签后切走 / 窗口重新聚焦)。
    // 这是「面板该不该还开着」的权威信号 —— 此时 Esc 已经进不了 chrome 渲染层,
    // 光靠 DOM blur 观测不到。
    api.onPageFocus(() => {
      loseSuggestFocus()
    }),
    // overlay → chrome 泛型事件:chrome 只处理 suggest 下拉与分屏面板(两者都是 chrome 自己打开的)
    api.onOverlayEvent((ev) => {
      if (ev.id === 'suggest') {
        if (ev.event === 'pick' && typeof ev.args === 'number') {
          const s = suggestions.value[ev.args]
          if (s) openSuggestion(s)
        } else if (ev.event === 'hover' && typeof ev.args === 'number') {
          activeIdx.value = ev.args
        } else if (ev.event === 'cancel') {
          hideSuggest()
          focusAddress()
        }
        return
      }
      if (ev.id === 'split-menu') handleSplitMenuEvent(ev)
    }),
    // 标签组结构由主进程变更(建组/拆组/聚焦那半/窗口缩放)→ 标签栏与面板跟着重画
    api.onGroupsChanged((list) => {
      groups.value = list
      if (splitMenuOpen.value) void pushSplitMenu()
    })
  )

  // chrome 高度上报(主进程据此布局 WebContentsView,分隔条也用它作起点)
  const report = (): void => {
    const height = Math.ceil(chromeRoot.value?.getBoundingClientRect().height ?? 0)
    chromeHeight.value = height
    void api.reportChromeHeight(height)
  }
  report()
  const ro = new ResizeObserver(report)
  if (chromeRoot.value) ro.observe(chromeRoot.value)
  const onResize = (): void => {
    report()
    if (showSuggest.value) pushSuggest() // 地址栏位置变化后重新对齐面板
  }
  window.addEventListener('resize', onResize)
  setTimeout(report, 300)
  unsubs.push(() => {
    ro.disconnect()
    window.removeEventListener('resize', onResize)
  })
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})

// ---------- 标签操作 ----------
async function newTab(): Promise<void> {
  await api.createTab('about:blank')
  await nextTick()
  // 必须走主进程:createTab() 已经把键盘焦点交给了新页面视图,
  // 这里再 el.focus() 只会「看着聚焦了」——打字依旧进页面(见 requestAddressFocus)
  requestAddressFocus()
}

async function closeTab(id: number, e?: MouseEvent): Promise<void> {
  e?.stopPropagation()
  await api.closeTab(id)
  const list = await api.listTabs()
  if (list.length === 0) await api.createTab('about:blank')
}

function restoreTab(): void {
  void api.restoreTab()
}

// ---------- 分屏面板(chrome 是 owner,面板只回传事件) ----------
function splitButtonRect(): SplitMenuPayload['rect'] {
  const r = splitBtn.value?.getBoundingClientRect()
  return { x: r?.x ?? 0, y: r?.y ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 }
}

/** 组装并显示面板(已打开时重推 = 用最新窗格/布局刷新) */
async function pushSplitMenu(): Promise<void> {
  const seq = ++splitMenuSeq
  const [layouts, g] = await Promise.all([api.getLayouts(), Promise.resolve(activeGroup.value)])
  if (seq !== splitMenuSeq) return // 取数期间被关掉 / 又推过一次 → 丢弃这次结果
  const panes: SplitPaneInfo[] = g
    ? groupTabs(g).map((t) => ({ tabId: t.id, title: groupTitle(t), url: t.url, crashed: t.crashed }))
    : []
  const payload: SplitMenuPayload = {
    rect: splitButtonRect(),
    panes,
    focusedTabId: g ? focusedTabId(g) : null,
    // IPC 走结构化克隆,不能传 Vue 响应式代理 → 逐个摊平(shape 是纯数据,可整体克隆)
    layouts: layouts.map((l) => ({ ...l }))
  }
  splitMenuOpen.value = true
  await api.showOverlay({ id: 'split-menu', placement: 'below-chrome', payload })
  // 下发期间又被关掉:把这次竞态里最后落下的浮层收回去
  if (seq !== splitMenuSeq) void api.showOverlay(null)
}

async function toggleSplitMenu(): Promise<void> {
  if (splitMenuOpen.value) {
    closeSplitMenu()
    return
  }
  await pushSplitMenu()
}

function closeSplitMenu(): void {
  if (!splitMenuOpen.value) return
  splitMenuOpen.value = false
  splitMenuSeq += 1 // 作废正在进行的 pushSplitMenu
  void api.showOverlay(null)
}

function handleSplitMenuEvent(ev: OverlayEvent): void {
  const arg = ev.args
  switch (ev.event) {
    // 点面板里的窗格行 = 聚焦那个窗格
    case 'focus':
      if (typeof arg === 'number') void api.activateTab(arg)
      break
    // 保存当前组的结构(单窗格组没东西可存,主进程会原样返回)
    case 'save':
      void api.saveLayout().then(() => pushSplitMenu())
      break
    // 套用布局 = 在当前组后面新开一个标签组;面板立刻关掉(它的数据已过期)
    case 'apply':
      if (typeof arg === 'string') void api.applyLayout(arg).then(() => closeSplitMenu())
      break
    case 'delete':
      if (typeof arg === 'string') void api.deleteLayout(arg).then(() => pushSplitMenu())
      break
    case 'ungroup':
      void api.groupsUngroup().then(() => closeSplitMenu())
      break
    case 'cancel':
      closeSplitMenu()
      break
  }
}

async function activateTab(id: number): Promise<void> {
  await api.activateTab(id)
}

// ---------- 导航 ----------
async function go(input: string): Promise<void> {
  const res = await api.go(input)
  if (res.parsed === 'search') address.value = ''
  else if (res.url) address.value = res.url
  addressEditing.value = false
}

async function back(): Promise<void> {
  await api.back()
}
async function forward(): Promise<void> {
  await api.forward()
}
async function reload(): Promise<void> {
  await api.reload()
}
async function stopLoading(): Promise<void> {
  await api.stop()
}

// ---------- 地址栏建议 ----------
/**
 * 深拷贝成普通对象:IPC 走结构化克隆,不能传 Vue 响应式代理
 * (rows 由 IPC 返回后存进 ref 即被深度代理,segments 是嵌套数组,必须逐层摊平)。
 */
function toPlainRows(rows: SuggestRow[]): SuggestRow[] {
  return rows.map((r) => ({ ...r, segments: r.segments.map((s) => ({ ...s })) }))
}

/** 把聚合结果推给顶层 Overlay 面板(带地址栏实测矩形,用于对齐定位);无建议/不可见则关闭浮层 */
function pushSuggest(): void {
  const el = addressBarEl.value
  if (!showSuggest.value || suggestions.value.length === 0 || !el) {
    void api.showOverlay(null)
    return
  }
  const rect = el.getBoundingClientRect()
  const payload: SuggestPayload = {
    rows: toPlainRows(suggestRows.value),
    suggestions: suggestions.value.map((s) => ({ ...s })),
    activeIdx: activeIdx.value,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
  void api.showOverlay({ id: 'suggest', payload, placement: 'below-chrome' })
}

async function refreshSuggestions(input: string): Promise<void> {
  // 焦点已不在地址栏:一条请求都不发(防抖早于 blur 时会有这种排列)
  if (!suggestSession.value.focused) return
  const snapshot = suggestSession.value.seq
  const res = await api.plugins.suggest(input)
  // 代不一致(= 期间失焦 / 被关掉 / 又开了一代)→ 结果整条丢弃,靠 `===` 判定
  const next = withResults(suggestSession.value, snapshot, res.suggestions.length)
  if (next === suggestSession.value) return
  suggestions.value = res.suggestions
  suggestRows.value = res.rows
  activeIdx.value = 0
  suggestSession.value = next
  pushSuggest()
}

/** 取消还在等 100ms 防抖的那次建议请求(面板都收了就不该再发) */
function clearSuggestTimer(): void {
  if (!suggestTimer) return
  clearTimeout(suggestTimer)
  suggestTimer = null
}

/** 清空建议数据(不动会话状态,也不碰浮层) */
function clearSuggestRows(): void {
  suggestions.value = []
  suggestRows.value = []
  activeIdx.value = 0
}

function hideSuggest(): void {
  suggestSession.value = dismissedSession(suggestSession.value)
  clearSuggestTimer()
  clearSuggestRows()
  void api.showOverlay(null)
}

/**
 * 键盘焦点已经交给页面视图(主进程 `chrome:page-focus`):
 * 收面板 + 作废在途请求 + 把地址栏的编辑态与 DOM 状态跟事实对齐。
 * 这里不看 DOM blur / `activeElement` —— 它们在这类焦点切换下不可靠。
 *
 * 浮层只在「本来就是我们的面板」时才去关:`showOverlay(null)` 是**无条件**关当前浮层的,
 * 无差别调用会把插件自己的浮层一并关掉。
 */
function loseSuggestFocus(): void {
  const hadPanel = showSuggest.value
  // 地址栏不在编辑态时(焦点本就在页面上、窗口获焦导致的重聚焦…)不要白做功:
  // 这条处理每次页面视图获焦都会跑(切/关/新建标签、点窗格、窗口获焦),而 blur+syncAddress
  // 会改 `address.value` 触发整棵 chrome 重渲染。判据用 DOM 的 activeElement ——
  // 这里问的是「元素此刻是不是 DOM 焦点」,它答的是准的(不可靠的是把它当**键盘**焦点用)。
  const wasEditing = addressEditing.value || document.activeElement === addressInput.value
  suggestSession.value = lostFocusSession(suggestSession.value)
  clearSuggestTimer()
  clearSuggestRows()
  if (hadPanel) void api.showOverlay(null)
  if (wasEditing) {
    addressInput.value?.blur() // 让 DOM 状态与事实对齐(本来就失焦则是空操作)
    addressEditing.value = false
    syncAddress() // 否则切标签后地址栏会停在旧 URL(addressEditing 卡在 true)
  }
}

function onAddressFocus(e: FocusEvent): void {
  addressEditing.value = true
  suggestSession.value = focusedSession(suggestSession.value)
  // 仅显式聚焦(点击 / Ctrl+L / 新建标签)才全选;窗口被动恢复聚焦不全选
  const shouldSelect = explicitFocus || selectOnFocus
  explicitFocus = false
  selectOnFocus = false
  if (shouldSelect) (e.target as HTMLInputElement).select()
  void refreshSuggestions(address.value)
}

function onAddressMousedown(): void {
  selectOnFocus = true
}

function onAddressInput(): void {
  clearSuggestTimer()
  suggestTimer = setTimeout(() => void refreshSuggestions(address.value), 100)
}

function onAddressBlur(): void {
  addressEditing.value = false
  explicitFocus = false
  selectOnFocus = false
  // 失焦本身不动可见性(焦点可能只是落在建议面板上),也不发新请求;
  // 真正「焦点回不来」由下面这个兜底与主进程的 page-focus 信号负责。
  suggestSession.value = blurredSession(suggestSession.value)
  clearSuggestTimer()
  setTimeout(() => {
    if (document.activeElement !== addressInput.value) hideSuggest()
  }, 120)
}

function onAddressKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    if (showSuggest.value) hideSuggest()
    else syncAddress()
    return
  }
  const open = showSuggest.value && suggestions.value.length > 0
  if (e.key === 'Enter') {
    if (open) {
      e.preventDefault()
      openSuggestion(suggestions.value[activeIdx.value] ?? suggestions.value[0])
    } else {
      void go(address.value)
    }
    return
  }
  if (!open) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIdx.value = (activeIdx.value + 1) % suggestions.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIdx.value = (activeIdx.value - 1 + suggestions.value.length) % suggestions.value.length
  } else if (e.key === 'Tab') {
    e.preventDefault()
    openSuggestion(suggestions.value[activeIdx.value] ?? suggestions.value[0])
  }
}

function openSuggestion(s: Suggestion): void {
  hideSuggest()
  if (s.kind === 'search' && s.query) {
    void go(s.query)
    return
  }
  if (s.url) {
    void api.goUrl(s.url)
    address.value = s.url
    addressEditing.value = false
  }
}

// ---------- 窗口 ----------
const minimize = (): void => void api.minimize()
const maximize = (): void => void api.maximize()
const closeWindow = (): void => void api.closeWindow()

// ---------- 设置 ----------
/** 打开设置:内部标签页 bow://settings(已存在则聚焦,否则新建) */
function openSettings(): void {
  void api.go(SETTINGS_URL)
}

// activeIdx 由方向键 / overlay 悬停驱动:同步回显到面板
watch(activeIdx, () => {
  if (showSuggest.value) pushSuggest()
})

// ---------- 快捷键 ----------
/**
 * DOM 级聚焦 + 全选(不动键盘焦点)。**只在主进程已经拿到键盘焦点之后调**:
 * 渲染层自己 `el.focus()` 只改 DOM 状态,键盘事件仍会进页面 ——
 * 需要真正聚焦时走 `requestAddressFocus()`(经主进程)。
 */
function focusAddress(): void {
  const el = addressInput.value
  if (!el) return
  explicitFocus = true
  el.focus()
  el.select()
}

/**
 * 请求「真正的」地址栏聚焦:主进程把键盘焦点交给 chrome webContents,
 * 再回发 `chrome:focus-address` → 渲染层 `focusAddress()`。
 * (主进程那边拿到焦点后同样会发这条消息,所以这里只管发请求。)
 */
function requestAddressFocus(): void {
  void api.requestAddressFocus()
}

function onKeydown(e: KeyboardEvent): void {
  // Esc 关掉分屏面板(面板在 below-chrome 条带里,Esc 由 chrome 自己接)
  if (e.key === 'Escape' && splitMenuOpen.value) {
    closeSplitMenu()
  }
  // Ctrl+T / Ctrl+Shift+T / Ctrl+W / Ctrl+L / Ctrl+R / Ctrl+←/→ / Ctrl+数字
  // 已全部由主进程统一拦截(tabShortcuts.ts),渲染层不再重复处理——
  // 被 preventDefault 的按键渲染层根本收不到,留在这里只会是死代码。
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="chrome" ref="chromeRoot">
    <!-- 标签栏 -->
    <div class="tabstrip">
      <div class="tabstrip-left drag" @dblclick="newTab">
        <div
          v-for="g in groups"
          :key="g.id"
          class="tab no-drag"
          :class="{
            active: isGroupActive(g),
            crashed: groupCrashed(g),
            'group-split': isSplitGroup(g)
          }"
          @click="activateTab(focusedTabId(g))"
          @auxclick="(e) => { if (e.button === 1) closeTab(focusedTabId(g)) }"
        >
          <Columns2 v-if="isSplitGroup(g)" class="tab-split-icon" :size="11" />
          <!-- 多窗格组只有**聚焦窗格**显示标题,其余窗格只留图标(点哪个切哪个) -->
          <span class="tab-letter">
            <TriangleAlert v-if="focusedTab(g)?.crashed" :size="12" />
            <template v-else>{{ faviconLetter(focusedTab(g)?.title ?? '') }}</template>
          </span>
          <span class="tab-title">{{ groupTitle(focusedTab(g)) }}</span>
          <span
            v-for="t in otherPanes(g)"
            :key="t.id"
            class="tab-pane-icon"
            :title="groupTitle(t)"
            @click.stop="activateTab(t.id)"
            @auxclick.stop="(e) => { if (e.button === 1) closeTab(t.id) }"
          >
            <TriangleAlert v-if="t.crashed" :size="10" />
            <template v-else>{{ faviconLetter(t.title) }}</template>
          </span>
          <span v-if="groupLoading(g)" class="tab-spinner"></span>
          <button
            class="tab-close no-drag"
            :title="isSplitGroup(g) ? '关闭聚焦的窗格 (Ctrl+W)' : '关闭标签 (Ctrl+W)'"
            @click.stop="closeTab(focusedTabId(g))"
          >
            <X :size="12" />
          </button>
        </div>
        <button class="tab-new no-drag" title="新标签页 (Ctrl+T)" @click="newTab">
          <Plus :size="15" />
        </button>
      </div>
      <div class="win-controls no-drag">
        <button class="win-btn" title="最小化" @click="minimize"><Minus :size="13" /></button>
        <button class="win-btn" title="最大化/还原" @click="maximize"><Square :size="11" /></button>
        <button class="win-btn close" title="关闭" @click="closeWindow"><X :size="13" /></button>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <button class="tool-btn no-drag" title="后退" :disabled="!activeTab?.canGoBack" @click="back">
        <ArrowLeft :size="16" />
      </button>
      <button class="tool-btn no-drag" title="前进" :disabled="!activeTab?.canGoForward" @click="forward">
        <ArrowRight :size="16" />
      </button>
      <button
        class="tool-btn no-drag"
        :title="loading ? '停止加载' : '刷新 (Ctrl+R)'"
        @click="loading ? stopLoading() : reload()"
      >
        <X v-if="loading" :size="16" />
        <RotateCw v-else :size="16" />
      </button>
      <div ref="addressBarEl" class="addressbar no-drag">
        <div class="addressbar-row">
          <input
            ref="addressInput"
            v-model="address"
            class="address-input"
            spellcheck="false"
            placeholder="输入网址或搜索内容…"
            @mousedown="onAddressMousedown"
            @focus="onAddressFocus"
            @blur="onAddressBlur"
            @input="onAddressInput"
            @keydown="onAddressKeydown"
          />
          <component v-for="(C, i) in addressbarSlots" :key="`at-${i}`" :is="C" />
        </div>
      </div>
      <!-- 插件工具栏按钮(书签管理等) -->
      <component v-for="(C, i) in toolbarSlots" :key="`tb-${i}`" :is="C" />
      <button
        ref="splitBtn"
        class="tool-btn no-drag split-btn"
        :class="{ on: !!activeGroup && isSplitGroup(activeGroup) }"
        :title="activeGroup && isSplitGroup(activeGroup) ? '分屏中(保存/套用布局、取消分屏)' : '分屏:把当前标签拆成多个窗格'"
        @click="toggleSplitMenu"
      >
        <Columns2 :size="16" />
      </button>
      <button class="tool-btn no-drag" title="恢复刚刚关闭的标签 (Ctrl+Shift+T)" @click="restoreTab">
        <Undo2 :size="14" />
      </button>
      <button class="tool-btn no-drag" title="设置 (Ctrl+,)" @click="openSettings">
        <SettingsIcon :size="16" />
      </button>
    </div>

    <!-- 分隔条:一个空隙一条,几何完全来自主进程(`groups:changed` 里的 dividers) -->
    <div
      v-for="(d, i) in activeGroupDividers"
      :key="i"
      class="split-divider"
      :style="{
        left: `${d.x}px`,
        top: `${d.y}px`,
        width: `${d.width}px`,
        height: `${d.height}px`
      }"
    />
  </div>
</template>
