<script setup lang="ts">
/**
 * 工具栏:一条服务一个图标。
 *
 * 点击语义就是用户要的那句 —— 服务没起就先起(按钮转圈),起了就直接开/聚焦它的标签。
 * 走**普通 http 标签**(`api.createTab`),不做内部页:服务跑的是它自己的 web 前端。
 *
 * 为什么不做成「一个入口 + 下拉面板」:那样点和找是两步。超过 5 条服务工具栏会挤,
 * 那时再换成 `pomo` 那种 below-chrome 浮层(套路现成),现在不提前做。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RButton } from '@ruinb0w/ui'
import { SERVICES_EVENT, serviceUrlMatches, type EnsureResult, type ServicesState } from '../shared'
import { serviceIcon } from './icons'

const api = window.browserAPI
const snapshot = ref<ServicesState | null>(null)
const pending = ref<string[]>([])
/** 点完之后的一句话反馈(报错):只放在 title 里,不弹窗 */
const messages = ref<Record<string, string>>({})

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return api.plugins.invoke<T>('services', method, ...args)
}

const PHASE_LABELS: Record<string, string> = {
  stopped: '未启动(点击启动)',
  starting: '正在启动…',
  running: '运行中',
  error: '出错'
}

function titleOf(id: string, name: string): string {
  const status = snapshot.value?.statuses.find((s) => s.id === id)
  const base = messages.value[id] ?? name
  const phase = PHASE_LABELS[status?.phase ?? 'stopped']
  return `${base} · ${phase}`
}

async function open(id: string): Promise<void> {
  if (pending.value.includes(id)) return
  pending.value = [...pending.value, id]
  try {
    const res = await invoke<EnsureResult>('ensure', id)
    if (!res.url) {
      messages.value = { ...messages.value, [id]: res.error ?? '没起来' }
      return
    }
    messages.value = { ...messages.value, [id]: '' }
    const url = res.url
    const existing = (await api.listTabs()).find((tab) => serviceUrlMatches(tab.url, url))
    if (existing) await api.activateTab(existing.id)
    else await api.createTab(url)
  } catch (e) {
    messages.value = { ...messages.value, [id]: e instanceof Error ? e.message : String(e) }
  } finally {
    pending.value = pending.value.filter((item) => item !== id)
  }
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = api.plugins.onEvent((ev) => {
    if (ev.id !== 'services' || ev.event !== SERVICES_EVENT.changed) return
    snapshot.value = ev.args as ServicesState
  })
  void invoke<ServicesState>('getState').then((state) => {
    snapshot.value = state
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <RButton
    v-for="service in snapshot?.settings.services ?? []"
    :key="service.id"
    text
    circle
    size="default"
    class="no-drag"
    :loading="pending.includes(service.id)"
    :active="snapshot?.statuses.find((s) => s.id === service.id && s.phase === 'running') !== undefined"
    :title="titleOf(service.id, service.name)"
    @click="open(service.id)"
  >
    <component :is="serviceIcon(service.icon)" :size="16" />
  </RButton>
</template>
