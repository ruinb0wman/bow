<script setup lang="ts">
/** 广告/追踪拦截参考插件的设置分区 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RotateCcw } from 'lucide-vue-next'

interface AdblockState {
  enabled: boolean
  blockedCount: number
  rules: string[]
}

const api = window.browserAPI
const state = ref<AdblockState>({ enabled: true, blockedCount: 0, rules: [] })
const unsubs: Array<() => void> = []

async function refresh(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'getState')
}

async function toggle(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'setEnabled', state.value.enabled)
}

async function reset(): Promise<void> {
  state.value = await api.plugins.invoke<AdblockState>('adblock', 'resetCount')
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id === 'adblock' && ev.event === 'changed') void refresh()
    })
  )
})
onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <div class="set-row">
    <span class="set-label">广告拦截</span>
    <label class="set-check">
      <input v-model="state.enabled" type="checkbox" @change="toggle" />
      拦截清单内主机的请求并隐藏常见广告位
    </label>
  </div>
  <div class="set-row">
    <span class="set-label">拦截统计</span>
    <span class="set-hcount">{{ state.blockedCount }} 次命中 / {{ state.rules.length }} 条规则</span>
    <button class="btn" title="清零计数" @click="reset"><RotateCcw :size="13" />清零</button>
  </div>
  <div class="set-row set-col">
    <span class="set-label">规则清单</span>
    <div class="pbm-tools hint adb-rules">{{ state.rules.join('、') }}</div>
  </div>
</template>

<style scoped>
.adb-rules {
  max-height: 120px;
  overflow-y: auto;
  line-height: 1.6;
}
</style>
