<script setup lang="ts">
/**
 * 工具栏「知识库」按钮:服务没起就先起(首次约 1s,按钮转圈),然后开或聚焦它的标签。
 *
 * 走**普通 http 标签**(`api.createTab`),不做内部页:OK 跑的是它自己的 web 前端,
 * 内部页的 preload 只在 `WebContentsView` 创建时给,拿不到。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RButton } from '@ruinb0w/ui'
import { BookOpen } from '@lucide/vue'
import { OK_EVENT, type OkState } from '@plugins/ok/shared'

const api = window.browserAPI
const busy = ref(false)
const hint = ref('知识库(OpenKnowledge)')

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return api.plugins.invoke<T>('ok', method, ...args)
}

async function open(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const snapshot = await invoke<OkState>('ensure')
    if (!snapshot.url) {
      hint.value = snapshot.error ?? 'OpenKnowledge 没起来'
      return
    }
    hint.value = '知识库(OpenKnowledge)'
    const url = snapshot.url
    const existing = (await api.listTabs()).find((tab) => tab.url.startsWith(url))
    if (existing) await api.activateTab(existing.id)
    else await api.createTab(url)
  } catch (e) {
    hint.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  // 自启起来 / 服务自己退了,都把提示跟状态对齐
  unsubscribe = api.plugins.onEvent((ev) => {
    if (ev.id !== 'ok' || ev.event !== OK_EVENT.changed) return
    const snapshot = ev.args as OkState
    busy.value = snapshot.phase === 'starting'
    if (snapshot.phase === 'running') hint.value = '知识库(OpenKnowledge)'
    else if (snapshot.phase === 'error') hint.value = snapshot.error ?? 'OpenKnowledge 启动失败'
  })
  void invoke<OkState>('getState').then((snapshot) => {
    busy.value = snapshot.phase === 'starting'
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <RButton text circle size="default" class="no-drag" :loading="busy" :title="hint" @click="open">
    <BookOpen :size="16" />
  </RButton>
</template>
