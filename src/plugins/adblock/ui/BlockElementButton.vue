<script setup lang="ts">
/** 元素框选入口(toolbar 插槽):点击后在当前页面进入 AdGuard 式点选模式 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TabInfo } from '@shared/types'
import { Ban, Loader2 } from 'lucide-vue-next'

const api = window.browserAPI
const active = ref<TabInfo | null>(null)
const picking = ref(false)
const message = ref('')
const unsubs: Array<() => void> = []
let msgTimer: ReturnType<typeof setTimeout> | null = null

const supported = computed(() => !!active.value && /^https?:/i.test(active.value.url))

const title = computed(() => {
  if (message.value) return message.value
  if (picking.value) return '框选中:点击页面元素屏蔽,Esc 取消'
  if (!supported.value) return '屏蔽元素(仅 http/https 页面可用)'
  return '屏蔽元素:框选页面中的广告并隐藏'
})

async function refresh(): Promise<void> {
  active.value = await api.getActiveTab()
}

function flash(msg: string): void {
  message.value = msg
  if (msgTimer) clearTimeout(msgTimer)
  msgTimer = setTimeout(() => {
    message.value = ''
  }, 3200)
}

async function pick(): Promise<void> {
  if (picking.value || !supported.value) return
  picking.value = true
  try {
    const res = await api.plugins.invoke<{ ok: boolean; cancelled?: boolean; error?: string }>(
      'adblock',
      'pickElement'
    )
    if (!res.ok && res.error) flash(res.error)
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e))
  } finally {
    picking.value = false
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
      if (ev.id !== 'adblock' || ev.event !== 'pick-done') return
      const args = ev.args as { ok?: boolean; error?: string } | undefined
      if (args?.ok) flash('已添加元素隐藏规则')
      else if (args?.error) flash(args.error)
      picking.value = false
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (msgTimer) clearTimeout(msgTimer)
})
</script>

<template>
  <button class="tool-btn no-drag" :title="title" :disabled="!supported || picking" @click="pick">
    <Loader2 v-if="picking" :size="16" class="adb-spin" />
    <Ban v-else :size="16" />
  </button>
</template>

<style scoped>
.adb-spin {
  animation: adb-spin 0.9s linear infinite;
}
@keyframes adb-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
