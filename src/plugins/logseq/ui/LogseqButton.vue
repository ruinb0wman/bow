<script setup lang="ts">
/** 工具栏「笔记」按钮:在新标签组里开一个编辑器(与终端按钮同款;`bow://logseq` 也可直接在地址栏输入) */
import { RButton } from '@ruinb0w/ui'
import { NotebookPen } from '@lucide/vue'
import { LOGSEQ_URL } from '@shared/internalPages'

const api = window.browserAPI

function open(): void {
  void api.createTab(LOGSEQ_URL)
}
</script>

<template>
  <RButton text circle size="default" class="no-drag" title="笔记(打开 Logseq 图)" @click="open">
    <NotebookPen :size="16" />
  </RButton>
</template>
