<script setup lang="ts">
/**
 * Overlay 通用宿主:根据主进程下发的内容 id 渲染注册表组件,并回传泛型事件。
 * 注册表 = 核心浮层(地址栏建议下拉)+ 已启用插件贡献的浮层。
 * (设置等浏览器自有页面已改为内部标签页 bow://settings,不再占用浮层。)
 */
import { computed, markRaw, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Component } from 'vue'
import type { OverlayShowMessage } from '@shared/types'
import SuggestPanel from '@renderer/components/SuggestPanel.vue'
import { PLUGIN_UI } from '../plugins/registry'

const api = window.browserAPI

const CORE: Record<string, Component> = {
  suggest: markRaw(SuggestPanel)
}

const content = ref<OverlayShowMessage | null>(null)
const enabled = ref<Set<string>>(new Set())
const unsubs: Array<() => void> = []

const registry = computed<Map<string, Component>>(() => {
  const m = new Map<string, Component>(Object.entries(CORE))
  for (const ui of PLUGIN_UI) {
    if (!enabled.value.has(ui.id)) continue
    for (const o of ui.overlays ?? []) m.set(o.id, markRaw(o.component))
  }
  return m
})

const current = computed<Component | null>(() => (content.value ? registry.value.get(content.value.id) ?? null : null))

function emitEvent(event: string, args?: unknown): void {
  if (content.value) void api.overlayEmit(content.value.id, event, args)
}

onMounted(async () => {
  const list = await api.plugins.list()
  enabled.value = new Set(list.filter((p) => p.enabled).map((p) => p.id))
  unsubs.push(
    api.onOverlayShow((msg) => {
      content.value = msg
    }),
    api.plugins.onChanged((l) => {
      enabled.value = new Set(l.filter((p) => p.enabled).map((p) => p.id))
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <component
    :is="current"
    :payload="content?.payload"
    :band-top="content?.meta.bandTop ?? 0"
    @overlay-event="emitEvent"
  />
</template>
