<script setup lang="ts">
/**
 * Overlay 通用宿主:根据主进程下发的内容 id 渲染注册表组件,并回传泛型事件。
 * 新增浮层 = 扩展 shared/types 的 OverlayContentId + 在这里注册组件,宿主代码零改动。
 */
import { markRaw, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Component } from 'vue'
import type { OverlayContentId, OverlayShowMessage } from '@shared/types'
import BookmarksModal from '../components/BookmarksModal.vue'
import SettingsModal from '../components/SettingsModal.vue'
import SuggestPanel from '../components/SuggestPanel.vue'

const api = window.browserAPI

const REGISTRY: Record<OverlayContentId, Component> = {
  'modal:bookmarks': markRaw(BookmarksModal),
  'modal:settings': markRaw(SettingsModal),
  suggest: markRaw(SuggestPanel)
}

const content = ref<OverlayShowMessage | null>(null)
const unsubs: Array<() => void> = []

function emitEvent(event: string, args?: unknown): void {
  if (content.value) void api.overlayEmit(content.value.id, event, args)
}

onMounted(() => {
  unsubs.push(
    api.onOverlayShow((msg) => {
      content.value = msg
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <component
    :is="content ? REGISTRY[content.id] : null"
    :payload="content?.payload"
    :band-top="content?.meta.bandTop ?? 0"
    @overlay-event="emitEvent"
  />
</template>