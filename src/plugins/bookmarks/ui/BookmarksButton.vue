<script setup lang="ts">
/** 书签管理入口按钮(书签插件贡献到 toolbar 插槽) */
import { RButton } from '@ruinb0w/ui'
import { BookMarked } from '@lucide/vue'

const api = window.browserAPI

function open(): void {
  void api.showOverlay({ id: 'plugin:bookmarks:panel', payload: undefined, placement: 'full' })
}
</script>

<template>
  <RButton text circle size="default" class="no-drag" title="管理书签" @click="open">
    <BookMarked :size="16" />
  </RButton>
</template>
