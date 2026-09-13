<script setup lang="ts">
/** 元素全屏入口(toolbar 插槽):框选页面元素铺满网页视口,Ctrl+Shift+F / Esc 快捷操作 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TabInfo } from '@shared/types'
import { Loader2, Maximize, Minimize } from 'lucide-vue-next'

const api = window.browserAPI
const active = ref<TabInfo | null>(null)
const fullscreen = ref(false)
const picking = ref(false)
const message = ref('')
const unsubs: Array<() => void> = []
let msgTimer: ReturnType<typeof setTimeout> | null = null

const supported = computed(() => !!active.value && /^https?:/i.test(active.value.url))

const title = computed(() => {
  if (message.value) return message.value
  if (picking.value) return '框选中:点击页面元素全屏,Esc 取消'
  if (!supported.value) return '元素全屏(仅 http/https 页面可用)'
  if (fullscreen.value) return '退出元素全屏'
  return '元素全屏:框选视频/图片等元素铺满网页视口 (Ctrl+Shift+F)'
})

function flash(msg: string): void {
  message.value = msg
  if (msgTimer) clearTimeout(msgTimer)
  msgTimer = setTimeout(() => {
    message.value = ''
  }, 3200)
}

async function refresh(): Promise<void> {
  active.value = await api.getActiveTab()
  try {
    const st = await api.plugins.invoke<{ fullscreen: boolean; picking: boolean }>(
      'element-fullscreen',
      'getState'
    )
    fullscreen.value = !!st?.fullscreen
    picking.value = !!st?.picking
  } catch {
    fullscreen.value = false
    picking.value = false
  }
}

async function activate(): Promise<void> {
  if (picking.value || !supported.value) return
  if (fullscreen.value) {
    try {
      await api.plugins.invoke('element-fullscreen', 'exitFullscreen')
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e))
    }
    await refresh()
    return
  }
  picking.value = true
  try {
    const res = await api.plugins.invoke<{ ok: boolean; cancelled?: boolean; error?: string }>(
      'element-fullscreen',
      'pickAndFullscreen'
    )
    if (!res.ok && res.error) flash(res.error)
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e))
  } finally {
    picking.value = false
    await refresh()
  }
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.onTabUpdated((t) => {
      if (t.active) active.value = t
    }),
    api.onTabActivated(() => void refresh()),
    api.onTabsChanged(() => void refresh()),
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'element-fullscreen') return
      if (ev.event === 'pick-done') {
        const args = ev.args as { ok?: boolean; error?: string } | undefined
        if (args?.ok) flash('已进入元素全屏')
        else if (args?.error) flash(args.error)
      }
      void refresh()
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (msgTimer) clearTimeout(msgTimer)
})
</script>

<template>
  <button
    class="tool-btn no-drag"
    :class="{ 'fs-active': fullscreen }"
    :title="title"
    :disabled="!supported || picking"
    @click="activate"
  >
    <Loader2 v-if="picking" :size="16" class="fs-spin" />
    <Minimize v-else-if="fullscreen" :size="16" />
    <Maximize v-else :size="16" />
  </button>
</template>

<style scoped>
.fs-spin {
  animation: fs-spin 0.9s linear infinite;
}
@keyframes fs-spin {
  to {
    transform: rotate(360deg);
  }
}
.tool-btn.fs-active {
  color: #60a5fa;
}
</style>
