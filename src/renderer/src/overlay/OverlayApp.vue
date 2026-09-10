<script setup lang="ts">
/** Overlay 根组件:根据主进程下发的 kind 渲染对应弹层 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ModalKind } from '@shared/types'
import BookmarksModal from '../components/BookmarksModal.vue'
import SettingsModal from '../components/SettingsModal.vue'

const api = window.browserAPI

const kind = ref<ModalKind | null>(null)
const unsubs: Array<() => void> = []

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') void api.openModal(null)
}

onMounted(() => {
  unsubs.push(
    api.onOverlayOpen((k) => {
      kind.value = k
    }),
    api.onOverlayClose(() => {
      kind.value = null
    })
  )
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <BookmarksModal v-if="kind === 'bookmarks'" @close="api.openModal(null)" />
  <SettingsModal v-if="kind === 'settings'" @close="api.openModal(null)" />
</template>