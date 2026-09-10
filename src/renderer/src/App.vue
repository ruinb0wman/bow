<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import type { BookmarkNode, BookmarkTree, Settings, TabInfo } from '@shared/types'
import { childrenOf, findNode, flatten } from '@shared/bookmarkTree'
import { SEARCH_ENGINES } from '@shared/url'

const api = window.browserAPI

// ---------- 状态 ----------
const tabs = ref<TabInfo[]>([])
const bookmarks = ref<BookmarkTree>([])
const settings = ref<Settings>({ searchEngine: 'google', homepage: 'https://www.google.com' })
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

const showManager = ref(false)
const showSettings = ref(false)
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
  settings.value = await api.getSettings()
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
    }),
    api.onSettingsChanged((s) => {
      settings.value = s
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

// ---------- 书签 ----------
const rootChildren = computed(() => childrenOf(bookmarks.value, null))
const flatList = computed(() => flatten(bookmarks.value))
const allFolders = computed(() => flatList.value.filter((b) => b.type === 'folder'))

const managerRows = computed(() => {
  const out: Array<{ node: BookmarkNode; depth: number; path: string }> = []
  const walk = (list: BookmarkTree, depth: number, prefix: string): void => {
    for (const node of list) {
      const path = prefix ? `${prefix}/${node.title}` : node.title
      out.push({ node, depth, path })
      if (node.type === 'folder') walk(node.children, depth + 1, path)
    }
  }
  walk(bookmarks.value, 0, '')
  return out
})

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

function nameOf(id: string | null): string {
  if (!id) return '根目录'
  const node = findNode(bookmarks.value, id)
  return node?.title ?? '根目录'
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

async function addBookmarkManually(): Promise<void> {
  const title = window.prompt('书签名')
  const url = window.prompt('书签地址')
  if (!url) return
  await api.addBookmark({ title: title ?? url, url, folderId: newBmFolder.value || null })
}

const newBmFolder = ref<string | null>(null)

async function addFolderManually(): Promise<void> {
  const title = window.prompt('文件夹名称')
  if (!title) return
  await api.addFolder({ title, parentId: newBmFolder.value || null })
}

// 编辑状态
const editing = ref<string | null>(null)
const editTitle = ref('')
const editUrl = ref('')
const moving = ref<string | null>(null)

function startEdit(node: BookmarkNode): void {
  editing.value = node.id
  editTitle.value = node.title
  editUrl.value = node.type === 'bookmark' ? node.url : ''
}

async function saveEdit(node: BookmarkNode): Promise<void> {
  const patch: { title?: string; url?: string } = { title: editTitle.value }
  if (node.type === 'bookmark') patch.url = editUrl.value
  await api.updateBookmark(node.id, patch)
  editing.value = null
}

async function removeNodeById(id: string): Promise<void> {
  await api.removeBookmark(id)
}

async function moveTo(node: BookmarkNode, target: string): Promise<void> {
  await api.moveBookmark(node.id, target === '__root__' ? null : target)
  moving.value = null
}

// ---------- 设置 ----------
const settingsDraft = ref<Settings>({ searchEngine: 'google', homepage: '' })

function openSettings(): void {
  settingsDraft.value = { ...settings.value }
  showSettings.value = true
}

async function saveSettings(): Promise<void> {
  const h = settingsDraft.value.homepage.trim()
  await api.setSettings({ searchEngine: settingsDraft.value.searchEngine, homepage: h || 'https://www.google.com' })
  showSettings.value = false
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
          <span class="tab-letter">{{ t.crashed ? '💥' : faviconLetter(t) }}</span>
          <span class="tab-title">{{ t.crashed ? '页面崩溃' : t.title }}</span>
          <span v-if="t.loading" class="tab-spinner"></span>
          <button class="tab-close no-drag" title="关闭标签 (Ctrl+W)" @click.stop="closeTab(t.id)">×</button>
        </div>
        <button class="tab-new no-drag" title="新标签页 (Ctrl+T)" @click="newTab">＋</button>
      </div>
      <div class="win-controls no-drag">
        <button class="win-btn" title="最小化" @click="minimize">─</button>
        <button class="win-btn" title="最大化/还原" @click="maximize">□</button>
        <button class="win-btn close" title="关闭" @click="closeWindow">×</button>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <button class="tool-btn no-drag" title="后退" :disabled="!activeTab?.canGoBack" @click="back">←</button>
      <button class="tool-btn no-drag" title="前进" :disabled="!activeTab?.canGoForward" @click="forward">→</button>
      <button class="tool-btn no-drag" title="刷新 (Ctrl+R)" @click="reload">{{ loading ? '✕' : '⟳' }}</button>
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
        <button class="star no-drag" :class="{ on: bookmarked }" :title="bookmarked ? '取消收藏' : '收藏当前页 (Ctrl+D)'" @click="toggleStar">★</button>
      </div>
      <button class="tool-btn no-drag" title="管理书签" @click="showManager = true">📑</button>
      <button class="tool-btn no-drag" title="设置" @click="openSettings">⚙</button>
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
          📁 {{ node.title }} ▾
        </button>
        <button v-else class="bm-item" :title="node.url" @click="openBookmarkUrl(node.url)">🔖 {{ node.title }}</button>
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
            {{ child.type === 'folder' ? '📁' : '🔖' }} {{ child.title }}
          </button>
        </template>
      </template>
      <span v-if="rootChildren.length === 0" class="bm-empty">书签栏为空(双击标签栏新建标签)</span>
      <span class="bm-right">
        <button class="tool-btn small" title="管理书签" @click="showManager = true">管理…</button>
        <button class="tool-btn small" title="恢复刚刚关闭的标签 (Ctrl+Shift+T)" @click="restoreTab">↩</button>
      </span>
    </div>
  </div>

  <!-- 书签管理弹层 -->
  <Teleport to="body">
    <div v-if="showManager" class="modal-mask" @click.self="showManager = false">
      <div class="modal panel-bms">
        <div class="modal-head">
          <span>书签管理</span>
          <button class="win-btn" @click="showManager = false">×</button>
        </div>
        <div class="pbm-tools">
          <label class="pbm-target">
            添加到文件夹:
            <select v-model="newBmFolder">
              <option :value="null">根目录</option>
              <option v-for="f in allFolders" :key="f.id" :value="f.id">{{ f.path }}</option>
            </select>
          </label>
          <button class="btn" @click="addBookmarkManually">＋ 新建书签</button>
          <button class="btn" @click="addFolderManually">＋ 新建文件夹</button>
        </div>
        <div class="pbm-tools hint">当前添加目标:{{ nameOf(newBmFolder) }}</div>
        <div class="pbm-list">
          <div v-for="row in managerRows" :key="row.node.id" class="pbm-row" :style="{ paddingLeft: 12 + row.depth * 22 + 'px' }">
            <span class="pbm-icon">{{ row.node.type === 'folder' ? '📁' : '🔖' }}</span>
            <template v-if="editing === row.node.id">
              <input v-model="editTitle" class="pbm-input" placeholder="名称" />
              <input v-if="row.node.type === 'bookmark'" v-model="editUrl" class="pbm-input" placeholder="URL" />
              <button class="btn primary" @click="saveEdit(row.node)">保存</button>
              <button class="btn" @click="editing = null">取消</button>
            </template>
            <template v-else>
              <span class="pbm-title">{{ row.node.title }}</span>
              <span v-if="row.node.type === 'bookmark'" class="pbm-url">{{ row.node.url }}</span>
              <select
                v-if="moving === row.node.id"
                class="pbm-input"
                @change="(e) => moveTo(row.node, (e.target as HTMLSelectElement).value)"
              >
                <option value="__root__">根目录</option>
                <option v-for="f in allFolders.filter((x) => x.id !== row.node.id)" :key="f.id" :value="f.id">{{ f.path }}</option>
              </select>
            </template>
            <span class="pbm-actions">
              <button class="btn" @click="moving = moving === row.node.id ? null : row.node.id">
                {{ moving === row.node.id ? '取消移动' : '移动' }}
              </button>
              <button class="btn" @click="startEdit(row.node)">编辑</button>
              <button class="btn danger" @click="removeNodeById(row.node.id)">删除</button>
            </span>
          </div>
          <div v-if="managerRows.length === 0" class="bm-empty">暂无书签</div>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 设置弹层 -->
  <Teleport to="body">
    <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
      <div class="modal panel-settings">
        <div class="modal-head">
          <span>设置</span>
          <button class="win-btn" @click="showSettings = false">×</button>
        </div>
        <div class="set-row">
          <span class="set-label">默认搜索引擎</span>
          <div class="set-engines">
            <label v-for="(v, key) in SEARCH_ENGINES" :key="key" class="set-engine">
              <input v-model="settingsDraft.searchEngine" type="radio" :value="key" />
              {{ v.label }}
            </label>
          </div>
        </div>
        <div class="set-row">
          <span class="set-label">主页</span>
          <input v-model="settingsDraft.homepage" class="pbm-input wide" placeholder="https://www.google.com" />
        </div>
        <div class="set-actions">
          <button class="btn primary" @click="saveSettings">保存</button>
          <button class="btn" @click="showSettings = false">取消</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>