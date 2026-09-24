<script setup lang="ts">
/**
 * 夸克网盘入口按钮(toolbar 插槽)。
 *
 * 只在「当前活动标签是夸克个人网盘页」时可点 —— 因为取直链要读该页的 React 状态。
 * 别的页面上置灰并说明原因。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TabInfo } from '@shared/types'
import { Cloud } from 'lucide-vue-next'
import { isQuarkHomeUrl } from '../shared'

const api = window.browserAPI
const active = ref<TabInfo | null>(null)
const unsubs: Array<() => void> = []

const supported = computed(() => !!active.value && isQuarkHomeUrl(active.value.url))
const title = computed(() =>
  supported.value ? '夸克网盘:取直链并推送到 aria2' : '夸克网盘:仅在夸克个人网盘页(pan.quark.cn)可用'
)

async function refresh(): Promise<void> {
  active.value = await api.getActiveTab()
}

function open(): void {
  if (!supported.value) return
  void api.showOverlay({ id: 'plugin:quark:panel', payload: undefined, placement: 'full' })
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.onTabUpdated((t) => {
      if (t.active) active.value = t
    }),
    api.onTabActivated(() => void refresh()),
    api.onTabsChanged(() => void refresh())
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <button class="tool-btn no-drag qk-btn" :class="{ disabled: !supported }" :title="title" @click="open">
    <Cloud :size="16" />
  </button>
</template>

<style scoped>
.qk-btn.disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
