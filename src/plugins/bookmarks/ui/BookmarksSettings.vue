<script setup lang="ts">
/**
 * 书签插件设置分区(bow://settings → 书签):导入 / 导出。
 *
 * 两件事都在**主进程**做(渲染层只发起调用):导出把整棵树写进 bow 下载目录,
 * 导入用系统文件选择框选一份 JSON 并**整树替换**(校验 + 归一在 `normalizeImportedTree()`)。
 * 书签面板(星标旁边那个管理浮层)不再放导出按钮 —— 那是日常整理的地方,备份这类低频操作归设置页。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Download, Upload } from 'lucide-vue-next'
import { flatten } from '@shared/bookmarkTree'
import type { BookmarkTree } from '@shared/types'
import type { BookmarkExportResult, BookmarkImportResult } from '../shared'

const api = window.browserAPI

const tree = ref<BookmarkTree>([])
const exportArmed = ref(false)
const importArmed = ref(false)
const exportPath = ref('')
const summary = ref('')
const error = ref('')
const notice = ref('')
const unsubs: Array<() => void> = []
let noticeTimer: number | undefined

const counts = computed(() => {
  const flat = flatten(tree.value)
  return {
    bookmarks: flat.filter((b) => b.type === 'bookmark').length,
    folders: flat.filter((b) => b.type === 'folder').length
  }
})

function flash(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 2600)
}

function apply(next: BookmarkTree): void {
  tree.value = next
}

async function refresh(): Promise<void> {
  apply(await api.plugins.invoke<BookmarkTree>('bookmarks', 'list'))
}

async function exportBookmarks(): Promise<void> {
  error.value = ''
  const res = await api.plugins.invoke<BookmarkExportResult>('bookmarks', 'export')
  exportArmed.value = false
  if (!res.ok) {
    error.value = res.error || '导出失败'
    return
  }
  exportPath.value = res.path || ''
  flash('书签已导出')
}

async function importBookmarks(): Promise<void> {
  error.value = ''
  summary.value = ''
  const res = await api.plugins.invoke<BookmarkImportResult>('bookmarks', 'import')
  importArmed.value = false
  // 用户取消文件选择框:不是错误,什么都不说
  if (res.canceled) return
  if (!res.ok) {
    error.value = res.error || '导入失败'
    return
  }
  await refresh()
  const extra: string[] = []
  if (res.dropped) extra.push(`跳过 ${res.dropped} 条无效条目`)
  if (res.reissued) extra.push(`${res.reissued} 条重发了 id`)
  summary.value =
    `已导入 ${res.bookmarks ?? 0} 个书签 / ${res.folders ?? 0} 个目录` +
    (extra.length ? `(${extra.join('、')})` : '')
  flash('书签已替换')
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id === 'bookmarks' && ev.event === 'changed') apply((ev.args as BookmarkTree) ?? [])
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (noticeTimer) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <section class="bm-settings">
    <div class="section-title">书签</div>
    <div class="set-row">
      <span class="set-label">当前</span>
      <span class="bm-settings-state">共 {{ counts.bookmarks }} 个书签 / {{ counts.folders }} 个目录</span>
    </div>

    <div class="section-title">备份</div>
    <div class="set-row">
      <span class="set-label">导出全部书签</span>
      <template v-if="exportArmed">
        <span class="bm-settings-hint">整棵树写进 bow 下载目录(与 bookmarks.json 内容一致)。</span>
        <button class="btn primary" @click="exportBookmarks"><Download :size="12" />确认导出</button>
        <button class="btn" @click="exportArmed = false">取消</button>
      </template>
      <button v-else class="btn" :disabled="counts.bookmarks + counts.folders === 0" @click="exportArmed = true">
        <Download :size="12" />导出…
      </button>
    </div>
    <div v-if="exportPath" class="bm-settings-hint">已导出:<code>{{ exportPath }}</code></div>

    <div class="set-row">
      <span class="set-label">导入书签</span>
      <template v-if="importArmed">
        <span class="bm-settings-hint">
          会<strong>整树替换</strong>当前书签(现共 {{ counts.bookmarks + counts.folders }} 项),这一步不可撤销。
        </span>
        <button class="btn danger" @click="importBookmarks"><Upload :size="12" />确认导入</button>
        <button class="btn" @click="importArmed = false">取消</button>
      </template>
      <button v-else class="btn" @click="importArmed = true"><Upload :size="12" />导入…</button>
    </div>
    <div v-if="summary" class="bm-settings-hint">{{ summary }}</div>

    <div v-if="error" class="bm-settings-error">{{ error }}</div>
    <div class="bm-settings-hint">
      文件就是「导出」出来的那份 JSON(根为数组,书签带 <code>title</code> / <code>url</code>,目录带 <code>children</code>);
      地址不是 http(s) 或 <code>bow://</code> 的条目、以及结构不合法的节点会被跳过。
    </div>
    <div v-if="notice" class="bm-settings-notice">{{ notice }}</div>
  </section>
</template>

<style scoped>
.bm-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bm-settings-state {
  color: var(--fg-dim);
  font-size: 13px;
}
.bm-settings-hint {
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.6;
}
.bm-settings-error {
  color: var(--danger);
  font-size: 12px;
}
.bm-settings-notice {
  color: var(--fg-dim);
  font-size: 12px;
}
</style>
