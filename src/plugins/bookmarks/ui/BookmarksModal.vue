<script setup lang="ts">
/** 收藏 Launchpad 面板(书签插件贡献的 full 浮层):搜索 + 磁贴网格 + 管理 */
import { RButton } from '@ruinb0w/ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BookmarkNode, BookmarkTree } from '@shared/types'
import { childrenOf } from '@shared/bookmarkTree'
import { isInternalUrl } from '@shared/internalPages'
import { ArrowLeft, ArrowRightLeft, Folder, Pencil, Plus, Search, Trash2, X } from '@lucide/vue'
import { domainHue, faviconLetter } from '@renderer/lib/avatar'
import { openAllInFolder, openBookmarkBackground } from '@renderer/lib/openFolder'
import ModalShell from '@renderer/components/ModalShell.vue'

defineOptions({ inheritAttrs: false })

const api = window.browserAPI
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

function requestClose(): void {
  emit('overlay-event', 'close-request')
}
function onShellEvent(event: string, args?: unknown): void {
  emit('overlay-event', event, args)
}

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

function showNotice(text: string, ms = 2000): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, ms)
}

// ---------- 打开 ----------
function openBookmark(node: BookmarkNode, e: MouseEvent): void {
  if (node.type !== 'bookmark') return
  if (e.ctrlKey || e.metaKey) {
    openBookmarkBackground(api, node.url)
    return
  }
  void api.goUrl(node.url)
  requestClose()
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
  // 预填当前页(http(s) 与 bow:// 内部页;about:blank、devtools: 等不预填)
  const tab = await api.getActiveTab()
  if (adding.value !== 'bookmark') return // 等待期间用户已取消/切到新建文件夹
  const url = tab?.url ?? ''
  if (/^https?:/i.test(url) || isInternalUrl(url)) {
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
    await api.plugins.invoke('bookmarks', 'add', { title: title || url, url, folderId: viewFolderId.value ?? null })
    showNotice(viewFolderId.value === null ? '已添加书签' : `已添加到「${viewTitle.value}」`)
  } else if (adding.value === 'folder') {
    if (!title) {
      showNotice('请填写文件夹名称')
      return
    }
    const inFolderView = viewFolderId.value !== null
    await api.plugins.invoke('bookmarks', 'addFolder', { title }) // 一级结构:目录始终在根(插件已强制)
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
  await api.plugins.invoke('bookmarks', 'update', editing.value.id, patch)
  editing.value = null
}

async function removeNodeById(id: string): Promise<void> {
  await api.plugins.invoke('bookmarks', 'remove', id)
}

async function moveTo(node: BookmarkNode, target: string): Promise<void> {
  await api.plugins.invoke('bookmarks', 'move', node.id, target === '__root__' ? null : target)
  moving.value = null
}

// ---------- 拖动排序 / 拖进目录 ----------
/**
 * 指针手势,与标签栏拖动(`App.vue`)同一套骨架:4px 阈值、`setPointerCapture`、window 四监听。
 * 但书签是网格 + 两种落点(缝隙 = 改顺序,目录磁贴 = 移入),所以落点计算自己写;
 * 且**松手才提交一次 IPC**(网格里实时让位会让被拖的磁贴在鼠标下滑走)。
 */
const gridEl = ref<HTMLElement | null>(null)
const navEl = ref<HTMLElement | null>(null)
const draggingId = ref<string | null>(null)
/** 当前高亮的落点:落进哪个目录磁贴 / 插在哪个磁贴之前(两者互斥) */
const drop = ref<{ into: string | null; before: string | null; index: number | null } | null>(null)
let dragMoved = false // 本次手势是否真的拖动过:松手后浏览器补的那次 click 要靠它吞掉
let dragStartX = 0
let dragStartY = 0
const DRAG_THRESHOLD = 4

function onTilePointerdown(node: BookmarkNode, e: PointerEvent): void {
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest('.la-actions')) return // 编辑/移动/删除按钮优先
  if (search.value.trim()) return // 过滤后的下标映射不回全集,搜索时先不给拖
  draggingId.value = node.id
  dragMoved = false
  drop.value = null
  dragStartX = e.clientX
  dragStartY = e.clientY
  // 接管指针:拖到面板外也能收到 pointerup,不至于留下拖拽态
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
  window.addEventListener('blur', endDrag)
}

function onDragMove(e: PointerEvent): void {
  if (draggingId.value == null) return
  if (!dragMoved && Math.abs(e.clientX - dragStartX) < DRAG_THRESHOLD && Math.abs(e.clientY - dragStartY) < DRAG_THRESHOLD) return
  dragMoved = true
  document.body.classList.add('la-dragging')
  computeDrop(e.clientX, e.clientY)
}

/**
 * 指针 → 落点。走到「返回」条 = 移出到根末尾;命中目录磁贴(拖的不是目录)= 移入该目录;
 * 否则算插入位 = 中心点排在指针之前的磁贴数(行优先:整行在上方,或同一行且中心在左)。
 */
function computeDrop(x: number, y: number): void {
  const nav = navEl.value?.getBoundingClientRect()
  if (nav && x >= nav.left && x <= nav.right && y >= nav.top && y <= nav.bottom) {
    drop.value = { into: null, before: null, index: null }
    return
  }
  const dragged = viewItems.value.find((n) => n.id === draggingId.value)
  const others = viewItems.value.filter((n) => n.id !== draggingId.value)
  const tiles = Array.from(gridEl.value?.querySelectorAll<HTMLElement>('.la-tile') ?? [])
  let k = 0
  let into: string | null = null
  tiles.forEach((el, i) => {
    const node = viewItems.value[i]
    if (!node || node.id === draggingId.value) return
    const r = el.getBoundingClientRect()
    if (
      node.type === 'folder' &&
      dragged?.type !== 'folder' &&
      x >= r.left &&
      x <= r.right &&
      y >= r.top &&
      y <= r.bottom
    ) {
      into = node.id
      return
    }
    // 整块在指针上方 = 这一行都排在指针之前;指针落在本行竖直区间内 = 比水平中心
    if (y > r.bottom) k += 1
    else if (y >= r.top && x > r.left + r.width / 2) k += 1
  })
  drop.value = into
    ? { into, before: null, index: null } // 移入目录:追加到该目录末尾
    : // `k` 已经排除被拖项 ⇒ 它直接就是「移出后的最终下标」;高亮那把插到 others[k] 之前
      { into: null, before: others[k]?.id ?? null, index: k }
}

function endDrag(): void {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', endDrag)
  window.removeEventListener('blur', endDrag)
  document.body.classList.remove('la-dragging')
  // 不清 dragMoved:紧随其后的那次 click 要靠它吞掉(下一个 pointerdown 才复位)
  const id = draggingId.value
  const target = drop.value
  draggingId.value = null
  drop.value = null
  if (!dragMoved || id == null || !target) return
  // `index` 已是「移出被拖项之后」的最终下标(计算时排除了它),不用再减一
  void api.plugins.invoke('bookmarks', 'move', id, target.into ?? viewFolderId.value, target.index ?? undefined)
}

/** 拖过之后浏览器仍会补一次 click:吞掉它,否则松手会进入目录 / 打开书签 */
function onTileClick(node: BookmarkNode, e: MouseEvent): void {
  if (dragMoved) return
  if (node.type === 'folder') onFolderClick(node, e)
  else openBookmark(node, e)
}

// ---------- 生命周期 ----------
const unsubs: Array<() => void> = []
onMounted(async () => {
  bookmarks.value = await api.plugins.invoke<BookmarkTree>('bookmarks', 'list')
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'bookmarks' || ev.event !== 'changed') return
      bookmarks.value = ev.args as BookmarkTree
      // 当前目录被删除时退回根视图
      if (viewFolderId.value !== null) {
        const stillThere = (ev.args as BookmarkTree).some((n) => n.id === viewFolderId.value)
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
  <ModalShell @overlay-event="onShellEvent">
    <div class="panel-launch">
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
        <button class="win-btn" title="关闭" @click="requestClose"><X :size="13" /></button>
      </div>

      <!-- 目录视图返回条 -->
      <div v-if="viewFolderId !== null" class="la-nav" ref="navEl" :class="{ 'drop-root': drop?.into === null && drop?.index === null }">
        <RButton size="small" @click="back"><ArrowLeft :size="13" /> 返回</RButton>
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
        <div v-else class="la-grid" ref="gridEl">
          <div
            v-for="node in viewItems"
            :key="node.id"
            class="la-tile"
            :class="{
              folder: node.type === 'folder',
              dragging: draggingId === node.id,
              'drop-into': drop?.into === node.id,
              'drop-before': drop?.before === node.id
            }"
            :title="tileTitle(node)"
            @pointerdown="onTilePointerdown(node, $event)"
            @click="onTileClick(node, $event)"
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
        <RButton size="small" type="primary" @click="confirmAdd">添加</RButton>
        <RButton size="small" @click="cancelAdd">取消</RButton>
      </div>

      <!-- 编辑小表单 -->
      <div v-if="editing" class="la-bar" @click.stop>
        <input v-model="editTitle" class="pbm-input" placeholder="名称" />
        <input v-if="editing.type === 'bookmark'" v-model="editUrl" class="pbm-input" placeholder="URL" />
        <RButton size="small" type="primary" @click="saveEdit">保存</RButton>
        <RButton size="small" @click="cancelEdit">取消</RButton>
      </div>

      <!-- 移动选择(候选:根 + 根级目录) -->
      <div v-if="moving" class="la-bar" @click.stop>
        <span class="la-move-title">移动到:</span>
        <RButton size="small" @click="moveTo(moving, '__root__')">根目录</RButton>
        <RButton size="small" v-for="f in rootFolders" :key="f.id" @click="moveTo(moving, f.id)">{{ f.title }}</RButton>
      </div>

      <!-- 底部工具条 -->
      <div class="la-foot">
        <RButton size="small" @click="startAddBookmark"><Plus :size="13" /> 新建书签</RButton>
        <RButton size="small" @click="startAddFolder"><Plus :size="13" /> 新建文件夹</RButton>
        <span class="la-hint">单击目录进入; Ctrl+点击目录后台打开全部页面; 拖动磁贴排序,拖到目录上移入</span>
        <span v-if="notice" class="la-notice">{{ notice }}</span>
      </div>
    </div>
  </ModalShell>
</template>
