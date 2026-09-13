<script setup lang="ts">
/** 书签管理入口按钮(书签插件贡献到 toolbar 插槽) */
import { BookMarked } from 'lucide-vue-next'

const api = window.browserAPI

function open(): void {
  void api.showOverlay({ id: 'plugin:bookmarks:panel', payload: undefined, placement: 'full' })
}
</script>

<template>
  <button class="tool-btn no-drag" title="管理书签" @click="open">
    <BookMarked :size="16" />
  </button>
</template>
