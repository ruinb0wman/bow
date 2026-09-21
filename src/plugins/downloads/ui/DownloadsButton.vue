<script setup lang="ts">
/**
 * 「下载」入口按钮(下载插件贡献到 toolbar 插槽)。
 * 进行中时显示百分比 + 高亮,点击打开面板;面板本身在 `DownloadsPanel.vue`。
 *
 * 轮询策略:只在「有非终态记录」时 500ms 轮询一次(下载进度没有推送),
 * 状态迁移靠主进程的 `changed` 广播立刻刷新 —— 面板关闭时也不额外打扰主进程。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Download } from 'lucide-vue-next'
import { DOWNLOADS_EVENT, percentOf, type DownloadRecord, type DownloadsListResult } from '../shared'

const api = window.browserAPI
const state = ref<DownloadsListResult | null>(null)
const unsubs: Array<() => void> = []
let timer: number | undefined

const active = computed<DownloadRecord[]>(() =>
  (state.value?.records ?? []).filter((r) => r.state === 'progressing' || r.state === 'paused')
)
const running = computed<DownloadRecord[]>(() => active.value.filter((r) => r.state === 'progressing'))
const percent = computed<number | null>(() => {
  const first = running.value[0]
  return first ? percentOf(first) : null
})

const title = computed(() => {
  const n = active.value.length
  if (n === 0) return '下载'
  const first = running.value[0] ?? active.value[0]
  const detail = first ? `${first.filename} ${percentOf(first)}%` : ''
  return `下载:${n} 项未完成${detail ? `(${detail})` : ''}`
})

function stopPolling(): void {
  if (timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
  }
}

function syncPolling(): void {
  if (active.value.length > 0 && timer === undefined) {
    timer = window.setInterval(() => void refresh(), 500)
  } else if (active.value.length === 0) {
    stopPolling()
  }
}

async function refresh(): Promise<void> {
  try {
    state.value = await api.plugins.invoke<DownloadsListResult>('downloads', 'list')
  } catch {
    state.value = null // 插件停用 / 内核未就绪:按钮安静下来即可
  }
  syncPolling()
}

function open(): void {
  void api.showOverlay({ id: 'plugin:downloads:panel', payload: undefined, placement: 'full' })
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id === 'downloads' && ev.event === DOWNLOADS_EVENT.changed) void refresh()
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  stopPolling()
})
</script>

<template>
  <button class="tool-btn no-drag db-btn" :class="{ busy: active.length > 0 }" :title="title" @click="open">
    <Download :size="16" />
    <span v-if="percent !== null" class="db-pct">{{ percent }}%</span>
    <span v-if="active.length > 1" class="db-count">{{ active.length }}</span>
  </button>
</template>

<style scoped>
.db-btn {
  position: relative;
  gap: 3px;
}
.db-btn.busy {
  color: var(--accent);
}
.db-pct {
  font-size: 10px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.db-count {
  position: absolute;
  top: -3px;
  right: -4px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font-size: 9px;
  line-height: 13px;
  text-align: center;
}
</style>
