<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import type { BookmarkNode, BookmarkTree, TabInfo } from '@shared/types'
import { childrenOf, flatten } from '@shared/bookmarkTree'
import {
  ArrowLeft,
  ArrowRight,
  BookMarked,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Folder,
  Minus,
  Plus,
  RotateCw,
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
const bookmarks = ref<BookmarkTree>([])
const address = ref('')
const addressEditing = ref(false)

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

const expandedFolders = ref<Set<string>>(new Set())
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
  bookmarks.value = await api.listBookmarks()
  syncAddress()

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
    api.onBookmarksChanged((tree) => {
      bookmarks.value = tree
      const valid = new Set(flatten(tree).map((b) => b.id))
      for (const id of [...expandedFolders.value]) {
        if (!valid.has(id)) expandedFolders.value.delete(id)
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

// ---------- 书签(管理弹层已迁移到 Overlay 页面 components/BookmarksModal.vue) ----------
const rootChildren = computed(() => childrenOf(bookmarks.value, null))

function isFolderOpen(id: string): boolean {
  return expandedFolders.value.has(id)
}

function toggleFolder(id: string | null): void {
  if (!id) return
  const set = expandedFolders.value
  if (set.has(id)) set.delete(id)
  else set.add(id)
}

function folderChildren(id: string): BookmarkNode[] {
  return childrenOf(bookmarks.value, id)
}

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

function faviconLetter(t: TabInfo): string {
  const title = t.title?.trim() ?? ''
  return title ? title[0].toUpperCase() : '·'
}

function openBookmarkUrl(url: string): void {
  void api.goUrl(url)
}
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
            <template v-else>{{ faviconLetter(t) }}</template>
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
      <div class="addressbar no-drag">
        <input
          ref="addressInput"
          v-model="address"
          class="address-input"
          spellcheck="false"
          placeholder="输入网址或搜索内容…"
          @focus="addressEditing = true; $event.target.select()"
          @blur="addressEditing = false"
          @keydown.enter="go(address)"
          @keydown.esc="syncAddress"
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
      <button class="tool-btn no-drag" title="管理书签" @click="api.openModal('bookmarks')">
        <BookMarked :size="16" />
      </button>
      <button class="tool-btn no-drag" title="设置" @click="api.openModal('settings')">
        <SettingsIcon :size="16" />
      </button>
    </div>

    <!-- 书签栏 -->
    <div class="bmbar no-drag">
      <template v-for="node in rootChildren" :key="node.id">
        <button
          v-if="node.type === 'folder'"
          class="bm-folder"
          :class="{ open: isFolderOpen(node.id) }"
          :title="'文件夹: ' + node.title"
          @click="toggleFolder(node.id)"
        >
          <Folder :size="13" />
          <span class="bm-label">{{ node.title }}</span>
          <ChevronDown v-if="isFolderOpen(node.id)" :size="12" class="bm-chevron" />
          <ChevronRight v-else :size="12" class="bm-chevron" />
        </button>
        <button v-else class="bm-item" :title="node.url" @click="openBookmarkUrl(node.url)">
          <Bookmark :size="13" />
          <span class="bm-label">{{ node.title }}</span>
        </button>
      </template>
      <!-- 展开的文件夹子项 -->
      <template v-for="node in rootChildren" :key="'c' + node.id">
        <template v-if="node.type === 'folder' && isFolderOpen(node.id)">
          <button
            v-for="child in folderChildren(node.id)"
            :key="child.id"
            class="bm-item sub"
            :class="{ folder: child.type === 'folder' }"
            :title="child.type === 'folder' ? child.title : child.url"
            @click="child.type === 'folder' ? toggleFolder(child.id) : openBookmarkUrl(child.url)"
          >
            <Folder v-if="child.type === 'folder'" :size="12" />
            <Bookmark v-else :size="12" />
            <span class="bm-label">{{ child.title }}</span>
          </button>
        </template>
      </template>
      <span v-if="rootChildren.length === 0" class="bm-empty">书签栏为空(双击标签栏新建标签)</span>
      <span class="bm-right">
        <button class="tool-btn small" title="管理书签" @click="api.openModal('bookmarks')">管理…</button>
        <button class="tool-btn small" title="恢复刚刚关闭的标签 (Ctrl+Shift+T)" @click="restoreTab">
          <Undo2 :size="14" />
        </button>
      </span>
    </div>
  </div>
</template>