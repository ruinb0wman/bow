<script setup lang="ts">
/** 地址栏星标(书签插件贡献到 addressbar-trailing 插槽) */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { FlatBookmark } from '@shared/types'
import { isInternalUrl } from '@shared/internalPages'
import { Star } from 'lucide-vue-next'

const api = window.browserAPI
const on = ref(false)
let currentUrl = ''
const unsubs: Array<() => void> = []

async function refresh(): Promise<void> {
  const tab = await api.getActiveTab()
  const url = tab?.url ?? ''
  // http(s) 与 bow:// 内部页(终端/设置)都可收藏;about:blank、devtools:// 等不参与
  currentUrl = /^https?:/i.test(url) || isInternalUrl(url) ? url : ''
  if (!currentUrl) {
    on.value = false
    return
  }
  const hits = await api.plugins.invoke<FlatBookmark[]>('bookmarks', 'findByUrl', currentUrl)
  on.value = hits.length > 0
}

async function toggle(): Promise<void> {
  if (!currentUrl) return
  if (on.value) {
    const hits = await api.plugins.invoke<FlatBookmark[]>('bookmarks', 'findByUrl', currentUrl)
    for (const h of hits) await api.plugins.invoke('bookmarks', 'remove', h.id)
    on.value = false
    return
  }
  const tab = await api.getActiveTab()
  await api.plugins.invoke('bookmarks', 'add', { title: tab?.title ?? currentUrl, url: currentUrl })
  on.value = true
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.onTabUpdated(() => void refresh()),
    api.onTabActivated(() => void refresh()),
    api.plugins.onEvent((ev) => {
      if (ev.id === 'bookmarks' && ev.event === 'changed') void refresh()
    })
  )
})
onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <button
    class="star no-drag"
    :class="{ on }"
    :title="on ? '取消收藏' : '收藏当前页'"
    @click="toggle"
  >
    <Star :size="15" :fill="on ? 'currentColor' : 'none'" />
  </button>
</template>
