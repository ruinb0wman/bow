<script setup lang="ts">
/** 收藏 Launchpad 面板(运行在顶层 Overlay 页面中):搜索 + 磁贴网格 + 管理 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BookmarkNode, BookmarkTree } from '@shared/types'
import { childrenOf } from '@shared/bookmarkTree'
import { ArrowLeft, ArrowRightLeft, Folder, Pencil, Plus, Search, Trash2, X } from 'lucide-vue-next'
import { domainHue, faviconLetter } from '../lib/avatar'
import { openAllInFolder, openBookmarkBackground } from '../lib/openFolder'

const api = window.browserAPI
const emit = defineEmits<{ close: [] }>()

const bookmarks = ref<BookmarkTree>([])
const search = ref('')
const viewFolderId = ref<string | null>(null) // null = 根视图
const editing = ref<BookmarkNode | null>(null)
const editTitle = ref('')
const editUrl = ref('')
const moving = ref<BookmarkNode | null>(null)
// 新建表单(Electron 渲染进程不支持 window.prompt,只能用内联输入)
const adding = ref<'bookmark' | 'folder' | null>(null)
const addTitle = ref('')
const addUrl = ref('')
const addTitleInput = ref<HTMLInputElement | null>(null)
const addUrlInput = ref<HTMLInputElement | null>(null)
const notice = ref('')
let noticeTimer: number | undefined
const searchInput = ref<HTMLInputElement | null>(null)

const rootChildren = computed(() => childrenOf(bookmarks.value, null))
const rootFolders = computed(() => rootChildren.value.filter((n) => n.type === 'folder'))
const viewTitle = computed(() => {
  if (viewFolderId.value === null) return '收藏'
  const hit = rootFolders.value.find((f) => f.id === viewFolderId.value)
  return hit?.title ?? '收藏'
})
const viewItems = computed(() => {
  const list = childrenOf(bookmarks.value, viewFolderId.value)
  const q = search.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((n) => {
    const title = n.title.toLowerCase()
    const url = n.type === 'bookmark' ? n.url.toLowerCase() : ''
    return title.includes(q) || url.includes(q)
  })
})

function countOf(node: BookmarkNode): number {
  if (node.type !== 'folder') return 0
  return node.children.filter((c) => c.type === 'bookmark').length
}

function tileTitle(node: BookmarkNode): string {
  if (node.type === 'folder') return `目录: ${node.title}(${countOf(node)} 页)\n单击进入, Ctrl+点击后台打开全部`
  return `${node.title}\n${node.url}\n单击当前标签打开, Ctrl+点击后台打开`
}

function showNotice(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 2000)
}

// ---------- 打开 ----------
function openBookmark(node: BookmarkNode, e: MouseEvent): void {
  if (node.type !== 'bookmark') return
  if (e.ctrlKey || e.metaKey) {
    openBookmarkBackground(api, node.url)
    return
  }
  void api.goUrl(node.url)
  emit('close')
}

function onFolderClick(node: BookmarkNode, e: MouseEvent): void {
  if (node.type !== 'folder') return
  if (e.ctrlKey || e.metaKey) {
    void openAllInFolder(api, node).then((count) => {
      showNotice(count === 0 ? '该目录没有页面' : `已后台打开 ${count} 个页面`)
    })
    return
  }
  viewFolderId.value = node.id
  search.value = ''
}

function back(): void {
  viewFolderId.value = null
  search.value = ''
}

// ---------- 管理 ----------
async function startAddBookmark(): Promise<void> {
  editing.value = null
  moving.value = null
  adding.value = 'bookmark'
  addTitle.value = ''
  addUrl.value = ''
  // 预填当前页(仅 http/https;about:blank、devtools: 等不预填)
  const tab = await api.getActiveTab()
  if (adding.value !== 'bookmark') return // 等待期间用户已取消/切到新建文件夹
  const url = tab?.url ?? ''
  if (/^https?:/i.test(url)) {
    addUrl.value = url
    addTitle.value = tab?.title ?? ''
  }
  await nextTick()
  if (adding.value !== 'bookmark') return
  // 聚焦第一个空字段:已有标题就跳到地址,否则先填名称
  const target = addTitle.value ? addUrlInput.value : addTitleInput.value
  target?.focus()
  target?.select()
}

function startAddFolder(): void {
  editing.value = null
  moving.value = null
  adding.value = 'folder'
  addTitle.value = ''
  addUrl.value = ''
  void nextTick(() => {
    addTitleInput.value?.focus()
    addTitleInput.value?.select()
  })
}

function cancelAdd(): void {
  adding.value = null
  addTitle.value = ''
  addUrl.value = ''
}

async function confirmAdd(): Promise<void> {
  const title = addTitle.value.trim()
  if (adding.value === 'bookmark') {
    const url = addUrl.value.trim()
    if (!url) {
      showNotice('请填写书签地址')
      return
    }
    await api.addBookmark({ title: title || url, url, folderId: viewFolderId.value ?? null })
    showNotice(viewFolderId.value === null ? '已添加书签' : `已添加到「${viewTitle.value}」`)
  } else if (adding.value === 'folder') {
    if (!title) {
      showNotice('请填写文件夹名称')
      return
    }
    const inFolderView = viewFolderId.value !== null
    await api.addFolder({ title }) // 一级结构:目录始终在根(IPC 已强制)
    if (inFolderView) {
      // 新目录建在根,退回根视图才能看到结果
      viewFolderId.value = null
      search.value = ''
    }
    showNotice(inFolderView ? '已在根目录新建文件夹' : '已新建文件夹')
  }
  cancelAdd()
}

function startEdit(node: BookmarkNode): void {
  adding.value = null
  editing.value = node
  editTitle.value = node.title
  editUrl.value = node.type === 'bookmark' ? node.url : ''
}

function cancelEdit(): void {
  editing.value = null
}

async function saveEdit(): Promise<void> {
  if (!editing.value) return
  const patch: { title?: string; url?: string } = { title: editTitle.value }
  if (editing.value.type === 'bookmark') patch.url = editUrl.value
  await api.updateBookmark(editing.value.id, patch)
  editing.value = null
}

async function removeNodeById(id: string): Promise<void> {
  await api.removeBookmark(id)
}

async function moveTo(node: BookmarkNode, target: string): Promise<void> {
  await api.moveBookmark(node.id, target === '__root__' ? null : target)
  moving.value = null
}

// ---------- 生命周期 ----------
const unsubs: Array<() => void> = []
onMounted(async () => {
  bookmarks.value = await api.listBookmarks()
  unsubs.push(
    api.onBookmarksChanged((tree) => {
      bookmarks.value = tree
      // 当前目录被删除时退回根视图
      if (viewFolderId.value !== null) {
        const stillThere = tree.some((n) => n.id === viewFolderId.value)
        if (!stillThere) viewFolderId.value = null
      }
    })
  )
  await nextTick()
  searchInput.value?.focus()
})
onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (noticeTimer) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal panel-launch">
      <!-- 头部:标题 + 搜索 -->
      <div class="la-head">
        <span class="la-title">收藏</span>
        <div class="la-search">
          <Search :size="15" class="la-search-icon" />
          <input
            ref="searchInput"
            v-model="search"
            class="la-search-input"
            placeholder="搜索收藏…"
            spellcheck="false"
          />
        </div>
        <button class="win-btn" title="关闭" @click="emit('close')"><X :size="13" /></button>
      </div>

      <!-- 目录视图返回条 -->
      <div v-if="viewFolderId !== null" class="la-nav">
        <button class="btn" @click="back"><ArrowLeft :size="13" /> 返回</button>
        <span class="la-nav-title">{{ viewTitle }}</span>
      </div>

      <!-- 网格 -->
      <div class="la-body">
        <div v-if="viewItems.length === 0" class="la-empty">
          {{
            search.trim()
              ? '无匹配结果'
              : viewFolderId === null
                ? '暂无收藏(在地址栏点击星标收藏当前页)'
                : '该目录还没有书签'
          }}
        </div>
        <div v-else class="la-grid">
          <div
            v-for="node in viewItems"
            :key="node.id"
            class="la-tile"
            :class="{ folder: node.type === 'folder' }"
            :title="tileTitle(node)"
            @click="node.type === 'folder' ? onFolderClick(node, $event) : openBookmark(node, $event)"
            @auxclick="(e) => { if (node.type === 'bookmark' && (e as MouseEvent).button === 1) openBookmarkBackground(api, node.url) }"
          >
            <div
              class="la-avatar"
              :style="node.type === 'bookmark' ? { background: `hsl(${domainHue(node.url)} 45% 42%)` } : {}"
            >
              <Folder v-if="node.type === 'folder'" :size="24" />
              <template v-else>{{ faviconLetter(node.title) }}</template>
              <span v-if="node.type === 'folder'" class="la-badge">{{ countOf(node) }}</span>
            </div>
            <span class="la-name">{{ node.title }}</span>
            <div class="la-actions" @click.stop>
              <button class="la-act" title="编辑" @click="startEdit(node)"><Pencil :size="11" /></button>
              <button
                v-if="node.type === 'bookmark'"
                class="la-act"
                title="移动"
                @click="moving = moving === node ? null : node"
              >
                <ArrowRightLeft :size="11" />
              </button>
              <button class="la-act danger" title="删除" @click="removeNodeById(node.id)"><Trash2 :size="11" /></button>
            </div>
          </div>
        </div>
      </div>

      <!-- 新建小表单 -->
      <div v-if="adding" class="la-bar" @click.stop @keydown.esc.stop="cancelAdd">
        <input
          ref="addTitleInput"
          v-model="addTitle"
          class="pbm-input"
          :placeholder="adding === 'bookmark' ? '书签名' : '文件夹名称'"
          spellcheck="false"
          @keyup.enter="confirmAdd"
        />
        <input
          v-if="adding === 'bookmark'"
          ref="addUrlInput"
          v-model="addUrl"
          class="pbm-input wide"
          placeholder="https://example.com"
          spellcheck="false"
          @keyup.enter="confirmAdd"
        />
        <button class="btn primary" @click="confirmAdd">添加</button>
        <button class="btn" @click="cancelAdd">取消</button>
      </div>

      <!-- 编辑小表单 -->
      <div v-if="editing" class="la-bar" @click.stop>
        <input v-model="editTitle" class="pbm-input" placeholder="名称" />
        <input v-if="editing.type === 'bookmark'" v-model="editUrl" class="pbm-input" placeholder="URL" />
        <button class="btn primary" @click="saveEdit">保存</button>
        <button class="btn" @click="cancelEdit">取消</button>
      </div>

      <!-- 移动选择(候选:根 + 根级目录) -->
      <div v-if="moving" class="la-bar" @click.stop>
        <span class="la-move-title">移动到:</span>
        <button class="btn" @click="moveTo(moving, '__root__')">根目录</button>
        <button v-for="f in rootFolders" :key="f.id" class="btn" @click="moveTo(moving, f.id)">{{ f.title }}</button>
      </div>

      <!-- 底部工具条 -->
      <div class="la-foot">
        <button class="btn" @click="startAddBookmark"><Plus :size="13" /> 新建书签</button>
        <button class="btn" @click="startAddFolder"><Plus :size="13" /> 新建文件夹</button>
        <span class="la-hint">单击目录进入; Ctrl+点击目录后台打开全部页面</span>
        <span v-if="notice" class="la-notice">{{ notice }}</span>
      </div>
    </div>
  </div>
</template>