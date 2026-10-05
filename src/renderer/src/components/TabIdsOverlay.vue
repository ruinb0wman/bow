<script setup lang="ts">
/**
 * 长按 Shift 显示的 tabId 徽标(overlay 组件,placement `panes`,由**主进程**直接打开/关闭)。
 *
 * 为什么必须走 Overlay:页面(WebContentsView)永远画在 chrome 之上,想浮在页面中央只能交给 Overlay。
 * 宿主给这块视图的 bounds 已经**紧包所有徽标**(几何见 `@shared/tabIdBadge`),所以这里只管把每个徽标
 * 用绝对定位摆到本地坐标上 —— 除了徽标那几小块,页面其余部分照常可点。
 *
 * 契约与其它 overlay 组件一致:`payload` prop + `band-top` prop + `overlay-event` emit
 * (本组件不用 emit:复制就在这里做完,不打扰 chrome)。
 *
 * ⚠️ 输入法 / 焦点:本浮层**不接管键盘焦点**(`OverlayManager.show()` 只给 full / find 聚焦),
 * 所以按住 Shift 时打字、终端输入照常进页面。
 */
import { onBeforeUnmount, ref } from 'vue'
import type { TabIdsPayload } from '@shared/tabIdBadge'

defineProps<{ payload: TabIdsPayload }>()
defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

const api = window.browserAPI

/** 刚复制成功的 id(徽标短暂显示「已复制」) */
const copiedId = ref<number | null>(null)
/** 写失败 / 读回不一致的 id(Windows 上 `clipboard.writeText` 失败是静默的,必须读回核对) */
const failedId = ref<number | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null

async function copy(tabId: number): Promise<void> {
  const text = String(tabId)
  await api.writeClipboardText(text)
  const back = await api.readClipboardText()
  const ok = back === text
  copiedId.value = ok ? tabId : null
  failedId.value = ok ? null : tabId
  if (noticeTimer != null) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    copiedId.value = null
    failedId.value = null
    noticeTimer = null
  }, 1200)
}

onBeforeUnmount(() => {
  if (noticeTimer != null) clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="tab-ids">
    <button
      v-for="b in payload.badges"
      :key="b.tabId"
      class="tab-id-badge"
      :class="{ ok: copiedId === b.tabId, err: failedId === b.tabId }"
      :style="{ left: `${b.x}px`, top: `${b.y}px` }"
      :title="`复制 tabId ${b.tabId}`"
      @click="copy(b.tabId)"
    >
      {{ failedId === b.tabId ? '复制失败' : copiedId === b.tabId ? '已复制' : `tabId ${b.tabId}` }}
    </button>
  </div>
</template>

<style scoped>
/* 根铺满浮层视图(视图本身已经只剩徽标那一小块) */
.tab-ids {
  position: fixed;
  inset: 0;
}

/* 徽标:深色胶囊 + 等宽数字,一眼区别于页面内容 */
.tab-id-badge {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  color: var(--fg);
  font-family: ui-monospace, monospace;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: copy;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
}

.tab-id-badge:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.tab-id-badge.ok {
  border-color: var(--accent);
  color: var(--accent);
}

.tab-id-badge.err {
  border-color: var(--danger);
  color: var(--danger);
}
</style>
