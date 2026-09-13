<script setup lang="ts">
/** 历史插件设置分区(运行在核心设置弹层内) */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Eraser } from 'lucide-vue-next'

const api = window.browserAPI
const count = ref(0)
const unsubs: Array<() => void> = []

async function refresh(): Promise<void> {
  count.value = await api.plugins.invoke<number>('history', 'count')
}

async function clear(): Promise<void> {
  await api.plugins.invoke('history', 'clear')
  count.value = 0
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id === 'history' && ev.event === 'changed') void refresh()
    })
  )
})
onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <div class="set-row">
    <span class="set-label">浏览历史</span>
    <span class="set-hcount">{{ count }} 条记录</span>
    <button class="btn danger" title="删除全部浏览历史记录" @click="clear">
      <Eraser :size="13" />清除浏览历史
    </button>
  </div>
</template>
