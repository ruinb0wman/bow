<script setup lang="ts">
/**
 * 工具栏:一条服务一个图标。
 *
 * 三种点击,互不重叠:
 * - 左键:服务没起就先起(按钮转圈),起了以后**配了浮窗的服务开浮窗、其余开/聚焦标签**;
 * - Ctrl/⌘ + 左键:**强制开标签**(忽略浮窗配置)—— 要长期用一个页面时走这条;
 * - 右键:只把配置里的地址复制到剪贴板,**不 ensure**(只想拿地址,不该顺手把 dev server 拉起来)。
 *
 * 为什么不做成「一个入口 + 下拉面板」:那样点和找是两步。超过 5 条服务工具栏会挤,
 * 那时再换成 `pomo` 那种 below-chrome 浮层(套路现成),现在不提前做。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Check } from '@lucide/vue'
import { RButton } from '@ruinb0w/ui'
import {
  SERVICES_EVENT,
  serviceUrlMatches,
  type EnsureResult,
  type ServiceConfig,
  type ServicesState
} from '../shared'
import { serviceIcon } from './icons'

const api = window.browserAPI
const snapshot = ref<ServicesState | null>(null)
const pending = ref<string[]>([])
/** 点完之后的一句话反馈(报错):只放在 title 里,不弹窗 */
const messages = ref<Record<string, string>>({})
/** 浮窗正在显示哪个 URL(主进程回灌)—— 配了浮窗的服务靠它点亮图标 */
const floatUrl = ref<string | null>(null)
/** 刚复制过地址的服务:图标临时换成对勾,比只在 title 里写「已复制」更省得去 hover */
const copiedId = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | undefined

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return api.plugins.invoke<T>('services', method, ...args)
}

const PHASE_LABELS: Record<string, string> = {
  stopped: '未启动(点击启动)',
  starting: '正在启动…',
  running: '运行中',
  error: '出错'
}

function titleOf(service: ServiceConfig): string {
  if (copiedId.value === service.id) return `已复制 ${service.url}`
  const status = snapshot.value?.statuses.find((s) => s.id === service.id)
  const base = messages.value[service.id] ?? service.name
  const phase = PHASE_LABELS[status?.phase ?? 'stopped']
  const hint = service.float ? ' · 点击开浮窗' : ''
  return `${base}${hint} · ${phase}`
}

/** 配了浮窗:亮 = 浮窗正开着;没配:亮 = 服务在跑(原来的语义) */
function isActive(service: ServiceConfig): boolean {
  if (service.float) return floatUrl.value != null && serviceUrlMatches(floatUrl.value, service.url)
  return snapshot.value?.statuses.find((s) => s.id === service.id && s.phase === 'running') !== undefined
}

async function openTab(url: string): Promise<void> {
  const existing = (await api.listTabs()).find((tab) => serviceUrlMatches(tab.url, url))
  if (existing) await api.activateTab(existing.id)
  else await api.createTab(url)
}

async function open(service: ServiceConfig, e: MouseEvent): Promise<void> {
  if (pending.value.includes(service.id)) return
  pending.value = [...pending.value, service.id]
  try {
    const res = await invoke<EnsureResult>('ensure', service.id)
    if (!res.url) {
      messages.value = { ...messages.value, [service.id]: res.error ?? '没起来' }
      return
    }
    messages.value = { ...messages.value, [service.id]: '' }
    const url = res.url
    const forceTab = e.ctrlKey || e.metaKey
    if (service.float && !forceTab) {
      // 同一条服务再点一次 = 关掉(toggle 的判定在主进程,与 Esc 关闭共用一份状态)
      // ⚠️ 必须摊平成普通对象:`service.float` 是 Vue 的深层 Proxy,V8 序列化直接拒收
      // ("could not be cloned"),整条请求根本到不了主进程 —— 与设置页 save() 里同一条坑。
      const prefs = { ...service.float }
      floatUrl.value = (await api.float.toggle({ url, prefs })).url
      return
    }
    await openTab(url)
  } catch (err) {
    messages.value = { ...messages.value, [service.id]: err instanceof Error ? err.message : String(err) }
  } finally {
    pending.value = pending.value.filter((item) => item !== service.id)
  }
}

async function copyUrl(service: ServiceConfig, e: MouseEvent): Promise<void> {
  e.preventDefault()
  await api.writeClipboardText(service.url)
  copiedId.value = service.id
  if (copiedTimer !== undefined) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copiedId.value = ''
    copiedTimer = undefined
  }, 1500)
}

let unsubscribe: (() => void) | null = null
let unsubscribeFloat: (() => void) | null = null

onMounted(() => {
  unsubscribe = api.plugins.onEvent((ev) => {
    if (ev.id !== 'services' || ev.event !== SERVICES_EVENT.changed) return
    snapshot.value = ev.args as ServicesState
  })
  void invoke<ServicesState>('getState').then((state) => {
    snapshot.value = state
  })
  // Esc 关浮窗、崩溃重建都不经过点击路径,所以状态以主进程推送的为准
  unsubscribeFloat = api.float.onState((state) => {
    floatUrl.value = state.url
  })
  void api.float.state().then((state) => {
    floatUrl.value = state.url
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
  unsubscribeFloat?.()
  unsubscribeFloat = null
  if (copiedTimer !== undefined) clearTimeout(copiedTimer)
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
    :active="isActive(service)"
    :title="titleOf(service)"
    @click="open(service, $event)"
    @contextmenu="copyUrl(service, $event)"
  >
    <component :is="copiedId === service.id ? Check : serviceIcon(service.icon)" :size="16" />
  </RButton>
</template>
