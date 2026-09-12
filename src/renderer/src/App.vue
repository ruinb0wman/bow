<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import type { FlatBookmark, SearchEngineId, Suggestion, TabInfo } from '@shared/types'
import { flatten } from '@shared/bookmarkTree'
import { buildSuggestions, highlightRanges } from '@shared/suggest'
import { SEARCH_ENGINES } from '@shared/url'
import { faviconLetter } from './lib/avatar'
import {
  ArrowLeft,
  ArrowRight,
  BookMarked,
  Bookmark as BookmarkIcon,
  History as HistoryIcon,
  Minus,
  Plus,
  RotateCw,
  Search,
  Settings as SettingsIcon,
  Square,
  Star,
  TriangleAlert,
  Undo2,
  X
} from 'lucide-vue-next'

const api = window.browserAPI

// ---------- 状态 ----------
const tabs = ref<TabInfo[]>([])
const address = ref('')
const addressEditing = ref(false)

// ---------- 地址栏建议(历史 / 书签模糊匹配) ----------
const suggestions = ref<Suggestion[]>([])
const activeIdx = ref(0)
const showSuggest = ref(false)
const bookmarkCache = ref<FlatBookmark[]>([])
const searchEngine = ref<SearchEngineId>('google')
let suggestTimer: ReturnType<typeof setTimeout> | null = null

const activeTab = computed(() => tabs.value.find((t) => t.active) ?? null)
const currentUrl = computed(() => activeTab.value?.url ?? '')
const loading = computed(() => !!activeTab.value?.loading)

const bookmarked = ref(false)
watch(
  currentUrl,
  async (url) => {
    if (!url || url === 'about:blank') {
      bookmarked.value = false
      return
    }
    const hits = await api.findBookmarksByUrl(url)
    bookmarked.value = hits.length > 0
  },
  { immediate: true }
)

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

onMounted(async () => {
  tabs.value = await api.listTabs()
  syncAddress()

  const settings = await api.getSettings()
  searchEngine.value = settings.searchEngine
  await refreshBookmarks()

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
    api.onBookmarksChanged(() => {
      void refreshBookmarks()
    }),
    api.onSettingsChanged((s) => {
      searchEngine.value = s.searchEngine
    })
  )

  // chrome 高度上报(主进程据此布局 WebContentsView)
  const report = (): void => {
    void api.reportChromeHeight(Math.ceil(chromeRoot.value?.getBoundingClientRect().height ?? 0))
  }
  report()
  const ro = new ResizeObserver(report)
  if (chromeRoot.value) ro.observe(chromeRoot.value)
  window.addEventListener('resize', report)
  setTimeout(report, 300)
  unsubs.push(() => {
    ro.disconnect()
    window.removeEventListener('resize', report)
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

// ---------- 地址栏建议(历史 / 书签模糊匹配) ----------
async function refreshBookmarks(): Promise<void> {
  bookmarkCache.value = flatten(await api.listBookmarks()).filter((b) => b.type === 'bookmark')
}

async function refreshSuggestions(input: string): Promise<void> {
  const history = await api.listHistory()
  suggestions.value = buildSuggestions(input, history, bookmarkCache.value)
  activeIdx.value = 0
  showSuggest.value = suggestions.value.length > 0
}

function hideSuggest(): void {
  showSuggest.value = false
  suggestions.value = []
  activeIdx.value = 0
}

function onAddressFocus(e: FocusEvent): void {
  addressEditing.value = true
  ;(e.target as HTMLInputElement).select()
  void refreshSuggestions(address.value)
}

function onAddressInput(): void {
  if (suggestTimer) clearTimeout(suggestTimer)
  suggestTimer = setTimeout(() => void refreshSuggestions(address.value), 100)
}

function onAddressBlur(): void {
  addressEditing.value = false
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

interface TitleSeg {
  text: string
  hl: boolean
}

/** 标题高亮分段:match 到的字符用 .hl 包裹 */
function titleSegments(s: Suggestion): TitleSeg[] {
  const text = s.title
  const q = address.value.trim()
  if (!q || s.kind === 'search') return [{ text, hl: false }]
  const segs: TitleSeg[] = []
  let cur = 0
  for (const [st, en] of highlightRanges(q, text)) {
    if (st > cur) segs.push({ text: text.slice(cur, st), hl: false })
    segs.push({ text: text.slice(st, en), hl: true })
    cur = en
  }
  if (cur < text.length) segs.push({ text: text.slice(cur), hl: false })
  return segs
}

function subText(s: Suggestion): string {
  if (s.kind === 'search') return `使用 ${SEARCH_ENGINES[searchEngine.value]?.label ?? 'Google'} 搜索`
  if (s.kind === 'bookmark') return s.path ?? s.url ?? ''
  return s.url ?? ''
}

// ---------- 书签(管理/打开统一由 Overlay 面板 BookmarksModal 承担) ----------
async function toggleStar(): Promise<void> {
  const url = currentUrl.value
  if (!url || url === 'about:blank') return
  if (bookmarked.value) {
    const hits = await api.findBookmarksByUrl(url)
    for (const h of hits) await api.removeBookmark(h.id)
    bookmarked.value = false
    return
  }
  await api.addBookmark({ title: activeTab.value?.title ?? url, url })
  bookmarked.value = true
}

// ---------- 窗口 ----------
const minimize = (): void => void api.minimize()
const maximize = (): void => void api.maximize()
const closeWindow = (): void => void api.closeWindow()

// ---------- 快捷键 ----------
function focusAddress(): void {
  const el = addressInput.value
  if (!el) return
  el.focus()
  el.select()
}

function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  if (mod && e.shiftKey && key === 't') {
    e.preventDefault()
    restoreTab()
  } else if (mod && !e.shiftKey && key === 't') {
    e.preventDefault()
    void newTab()
  } else if (mod && !e.shiftKey && key === 'w') {
    e.preventDefault()
    if (activeTab.value) void closeTab(activeTab.value.id)
  } else if (mod && !e.shiftKey && key === 'l') {
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
    <div class="toolbar" :class="{ 'suggest-open': showSuggest && suggestions.length > 0 }">
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
      <div class="addressbar no-drag" :class="{ 'suggest-open': showSuggest && suggestions.length > 0 }">
        <div class="addressbar-row">
          <input
            ref="addressInput"
            v-model="address"
            class="address-input"
            spellcheck="false"
            placeholder="输入网址或搜索内容…"
            @focus="onAddressFocus"
            @blur="onAddressBlur"
            @input="onAddressInput"
            @keydown="onAddressKeydown"
          />
          <button
            class="star no-drag"
            :class="{ on: bookmarked }"
            :title="bookmarked ? '取消收藏' : '收藏当前页 (Ctrl+D)'"
            @click="toggleStar"
          >
            <Star :size="15" :fill="bookmarked ? 'currentColor' : 'none'" />
          </button>
        </div>
        <div v-if="showSuggest && suggestions.length > 0" class="suggest" @mousedown.prevent>
          <div
            v-for="(s, i) in suggestions"
            :key="s.id"
            class="suggest-row"
            :class="{ active: i === activeIdx }"
            @mouseenter="activeIdx = i"
            @click="openSuggestion(s)"
          >
            <span class="s-icon">
              <Search v-if="s.kind === 'search'" :size="14" />
              <HistoryIcon v-else-if="s.kind === 'history'" :size="14" />
              <BookmarkIcon v-else :size="14" />
            </span>
            <span class="s-main">
              <span class="s-title">
                <template v-for="(seg, si) in titleSegments(s)" :key="si">
                  <span v-if="seg.hl" class="hl">{{ seg.text }}</span>
                  <template v-else>{{ seg.text }}</template>
                </template>
              </span>
              <span class="s-sub">{{ subText(s) }}</span>
            </span>
          </div>
        </div>
      </div>
      <button class="tool-btn no-drag" title="管理书签" @click="api.openModal('bookmarks')">
        <BookMarked :size="16" />
      </button>
      <button class="tool-btn no-drag" title="恢复刚刚关闭的标签 (Ctrl+Shift+T)" @click="restoreTab">
        <Undo2 :size="14" />
      </button>
      <button class="tool-btn no-drag" title="设置" @click="api.openModal('settings')">
        <SettingsIcon :size="16" />
      </button>
    </div>
  </div>
</template>