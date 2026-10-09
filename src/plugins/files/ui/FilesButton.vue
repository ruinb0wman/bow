<script setup lang="ts">
/**
 * 「文件」入口按钮(toolbar 插槽):打开文件管理面板。
 * 面板本身在 `FilesPanel.vue`,由 overlay 宿主渲染 —— 主进程不能直接开浮层,
 * 所以设置页/快捷键想开面板时只能发事件,由本组件负责开(与密码插件同路子)。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { FolderOpen } from 'lucide-vue-next'
import { FILES_EVENT } from '../shared'

const api = window.browserAPI
const unsubs: Array<() => void> = []

function openPanel(): void {
  void api.showOverlay({ id: 'plugin:files:panel', payload: undefined, placement: 'full' })
}

onMounted(() => {
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'files' || ev.event !== FILES_EVENT.openPanel) return
      openPanel()
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <button class="tool-btn no-drag" title="文件:浏览 AI 可读写的工作目录" @click="openPanel">
    <FolderOpen :size="16" />
  </button>
</template>
