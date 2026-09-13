<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import type { Component } from 'vue'
import type { Suggestion, SuggestPayload, SuggestRow, TabInfo } from '@shared/types'
import type { PluginInfo } from '@shared/plugins'
import { SETTINGS_URL } from '@shared/internalPages'
import { faviconLetter } from './lib/avatar'
import { PLUGIN_UI } from './plugins/registry'
import {
  ArrowLeft,
  ArrowRight,
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

function slotComponents(slot: 'addressbar-trailing' | 'toolbar'): Component[] {
  const out: Component[] = []
  for (const ui of PLUGIN_UI) {
    if (!enabledIds.value.has(ui.id)) continue
    const list = ui.slots?.[slot]
    if (list) out.push(...list)
  }
  return out
}
const addressbarSlots = computed(() => slotComponents('addressbar-trailing'))
const toolbarSlots = computed(() => slotComponents('toolbar'))

// ---------- 地址栏建议(由插件内核聚合各建议源) ----------
const suggestions = ref<Suggestion[]>([])
const suggestRows = ref<SuggestRow[]>([])
const activeIdx = ref(0)
const showSuggest = ref(false)
let suggestTimer: ReturnType<typeof setTimeout> | null = null

const activeTab = computed(() => tabs.value.find((t) => t.active) ?? null)
const currentUrl = computed(() => activeTab.value?.url ?? '')
const loading = computed(() => !!activeTab.value?.loading)

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
    // overlay → chrome 泛型事件:chrome 只处理 suggest 下拉
    api.onOverlayEvent((ev) => {
      if (ev.id !== 'suggest') return
      if (ev.event === 'pick' && typeof ev.args === 'number') {
        const s = suggestions.value[ev.args]
        if (s) openSuggestion(s)
      } else if (ev.event === 'hover' && typeof ev.args === 'number') {
        activeIdx.value = ev.args
      } else if (ev.event === 'cancel') {
        hideSuggest()
        focusAddress()
      }
    })
  )

  // chrome 高度上报(主进程据此布局 WebContentsView)
  const report = (): void => {
    void api.reportChromeHeight(Math.ceil(chromeRoot.value?.getBoundingClientRect().height ?? 0))
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
  focusAddress()
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
  const res = await api.plugins.suggest(input)
  suggestions.value = res.suggestions
  suggestRows.value = res.rows
  activeIdx.value = 0
  showSuggest.value = suggestions.value.length > 0
  pushSuggest()
}

function hideSuggest(): void {
  showSuggest.value = false
  suggestions.value = []
  suggestRows.value = []
  activeIdx.value = 0
  void api.showOverlay(null)
}

function onAddressFocus(e: FocusEvent): void {
  addressEditing.value = true
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
  if (suggestTimer) clearTimeout(suggestTimer)
  suggestTimer = setTimeout(() => void refreshSuggestions(address.value), 100)
}

function onAddressBlur(): void {
  addressEditing.value = false
  explicitFocus = false
  selectOnFocus = false
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
function focusAddress(): void {
  const el = addressInput.value
  if (!el) return
  explicitFocus = true
  el.focus()
  el.select()
}

function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  // Ctrl+T / Ctrl+Shift+T / Ctrl+W / Ctrl+数字 已由主进程统一拦截(tabShortcuts.ts),
  // 此处仅保留 chrome 聚焦时需要渲染层执行的快捷键
  if (mod && !e.shiftKey && key === 'l') {
    e.preventDefault()
    focusAddress()
  } else if (mod && !e.shiftKey && key === 'r') {
    e.preventDefault()
    void reload()
  }
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
          v-for="t in tabs"
          :key="t.id"
          class="tab no-drag"
          :class="{ active: t.active, crashed: t.crashed }"
          @click="activateTab(t.id)"
          @auxclick="(e) => { if (e.button === 1) closeTab(t.id) }"
        >
          <span class="tab-letter">
            <TriangleAlert v-if="t.crashed" :size="13" />
            <template v-else>{{ faviconLetter(t.title) }}</template>
          </span>
          <span class="tab-title">{{ t.crashed ? '页面崩溃' : t.title }}</span>
          <span v-if="t.loading" class="tab-spinner"></span>
          <button class="tab-close no-drag" title="关闭标签 (Ctrl+W)" @click.stop="closeTab(t.id)">
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
      <button class="tool-btn no-drag" title="恢复刚刚关闭的标签 (Ctrl+Shift+T)" @click="restoreTab">
        <Undo2 :size="14" />
      </button>
      <button class="tool-btn no-drag" title="设置 (Ctrl+,)" @click="openSettings">
        <SettingsIcon :size="16" />
      </button>
    </div>
  </div>
</template>
