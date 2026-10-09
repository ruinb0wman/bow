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

function openPanel(payload?: unknown): void {
  void api.showOverlay({ id: 'plugin:files:panel', payload, placement: 'full' })
}

onMounted(() => {
  unsubs.push(
    api.plugins.onEvent(async (ev) => {
      if (ev.id !== 'files' || ev.event !== FILES_EVENT.openPanel) return
      // `plugin:event` 是**广播到所有窗口**的,而这次选择请求属于某一个标签 ——
      // 只有拥有那个标签的窗口才该开面板(否则每个窗口都会弹一个)
      const payload = ev.args as { tabId?: number } | undefined
      if (typeof payload?.tabId === 'number') {
        const tabs = await api.listTabs().catch(() => [])
        if (!tabs.some((t) => t.id === payload.tabId)) return
      }
      openPanel(payload)
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
