<script setup lang="ts">
/** 书签管理弹层(运行在顶层 Overlay 页面中) */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { BookmarkNode, BookmarkTree } from '@shared/types'
import { childrenOf, findNode, flatten } from '@shared/bookmarkTree'
import { Bookmark, Folder, Plus, X } from 'lucide-vue-next'

const api = window.browserAPI
const emit = defineEmits<{ close: [] }>()

const bookmarks = ref<BookmarkTree>([])
const newBmFolder = ref<string | null>(null)
const editing = ref<string | null>(null)
const editTitle = ref('')
const editUrl = ref('')
const moving = ref<string | null>(null)

const allFolders = computed(() => flatten(bookmarks.value).filter((b) => b.type === 'folder'))
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

function nameOf(id: string | null): string {
  if (!id) return '根目录'
  const node = findNode(bookmarks.value, id)
  return node?.title ?? '根目录'
}

async function addBookmarkManually(): Promise<void> {
  const title = window.prompt('书签名')
  const url = window.prompt('书签地址')
  if (!url) return
  await api.addBookmark({ title: title ?? url, url, folderId: newBmFolder.value || null })
}

async function addFolderManually(): Promise<void> {
  const title = window.prompt('文件夹名称')
  if (!title) return
  await api.addFolder({ title, parentId: newBmFolder.value || null })
}

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

const unsubs: Array<() => void> = []
onMounted(async () => {
  bookmarks.value = await api.listBookmarks()
  unsubs.push(
    api.onBookmarksChanged((tree) => {
      bookmarks.value = tree
    })
  )
})
onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal panel-bms">
      <div class="modal-head">
        <span>书签管理</span>
        <button class="win-btn" title="关闭" @click="emit('close')"><X :size="13" /></button>
      </div>
      <div class="pbm-tools">
        <label class="pbm-target">
          添加到文件夹:
          <select v-model="newBmFolder">
            <option :value="null">根目录</option>
            <option v-for="f in allFolders" :key="f.id" :value="f.id">{{ f.path }}</option>
          </select>
        </label>
        <button class="btn" @click="addBookmarkManually"><Plus :size="13" /> 新建书签</button>
        <button class="btn" @click="addFolderManually"><Plus :size="13" /> 新建文件夹</button>
      </div>
      <div class="pbm-tools hint">当前添加目标:{{ nameOf(newBmFolder) }}</div>
      <div class="pbm-list">
        <div v-for="row in managerRows" :key="row.node.id" class="pbm-row" :style="{ paddingLeft: 12 + row.depth * 22 + 'px' }">
          <span class="pbm-icon">
            <Folder v-if="row.node.type === 'folder'" :size="13" />
            <Bookmark v-else :size="13" />
          </span>
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
</template>