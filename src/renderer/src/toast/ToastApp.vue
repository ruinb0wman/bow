<script setup lang="ts">
/**
 * 底部居中通知栈(第六个渲染入口,宿主见 `main/toasts.ts`)。
 *
 * 契约刻意做得很薄:主进程是通知栈的**唯一权威**(`main/agentNotify.ts` 归约、定时、路由),
 * 这里只做三件事 —— 画出来、把量到的高度回传、把点击回传。没有本地状态机,
 * 所以「通知该不该弹 / 什么时候消失」只有一处实现。
 *
 * ⚠️ 视图的 bounds 是主进程按**这里量出来的高度**精确设的(不能铺满窗口,`WebContentsView` 没有
 * 点击穿透,见 `main/toasts.ts` 顶部注释)。所以任何布局改动都要保证 `ResizeObserver` 仍然覆盖到
 * 真实高度,否则会出现「通知被裁掉」或「底部区域被一片透明视图挡住点不动页面」。
 */
import { onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import type { AgentToastItem } from '@shared/agentState'

const api = window.browserAPI

const items = ref<AgentToastItem[]>([])
const stack = ref<HTMLElement | null>(null)
const unsubs: Array<() => void> = []
let observer: ResizeObserver | null = null
let heightTimer: number | null = null

onMounted(() => {
  unsubs.push(
    api.toasts.onShow((msg) => {
      items.value = msg.items
    })
  )
  if (stack.value) {
    observer = new ResizeObserver(() => measure())
    observer.observe(stack.value)
  }
})

/** 量高度:等 Vue 把 DOM 更新完再量(否则量到的是上一帧) */
function measure(): void {
  if (heightTimer != null) window.clearTimeout(heightTimer)
  heightTimer = window.setTimeout(() => {
    heightTimer = null
    const el = stack.value
    if (!el) return
    void api.toasts.reportHeight(Math.ceil(el.getBoundingClientRect().height))
  }, 0)
}

function activate(item: AgentToastItem): void {
  void api.toasts.activate(item.id)
}

function dismiss(item: AgentToastItem, event: MouseEvent): void {
  event.stopPropagation()
  void api.toasts.dismiss(item.id)
}

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  observer?.disconnect()
  observer = null
  if (heightTimer != null) window.clearTimeout(heightTimer)
})

// 栈内容变化就重量一次(DOM 更新后再量);ResizeObserver 兼顾字体/换行导致的尺寸变化
watch(items, () => void nextTick(measure))
</script>

<template>
  <div ref="stack" class="toast-stack">
    <button
      v-for="item in items"
      :key="item.id"
      class="toast-card"
      :class="item.kind"
      type="button"
      :title="`点击进入对应标签(${item.title})`"
      @click="activate(item)"
    >
      <span class="toast-body">
        <span class="toast-title">{{ item.title }}</span>
        <span v-if="item.text" class="toast-text">{{ item.text }}</span>
        <span class="toast-hint">点击进入对应标签</span>
      </span>
      <span class="toast-close" role="button" title="关闭通知" @click="dismiss(item, $event)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </span>
    </button>
  </div>
</template>
