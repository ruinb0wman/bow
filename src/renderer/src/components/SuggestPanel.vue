<script setup lang="ts">
/**
 * 地址栏建议下拉面板(运行在顶层 Overlay 页面,浮在页面之上,不挤压页面)。
 * 键盘交互全部留在 chrome 侧地址栏(焦点不动),这里只处理鼠标;
 * 所有行为通过 'overlay-event' 回传 chrome:pick(选中行)/ hover(悬停)/ cancel(点击空白)。
 */
import { ref, watch } from 'vue'
import type { SuggestPayload } from '@shared/types'
import { Bookmark as BookmarkIcon, History as HistoryIcon, Search } from 'lucide-vue-next'

const props = defineProps<{ payload: SuggestPayload; bandTop: number }>()
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

// 面板定位:地址栏底边下方 2px;bandTop 是 overlay 视图自己的坐标原点(主进程注入)
const box = (): Record<string, string> => {
  const r = props.payload.rect
  const top = Math.max(0, r.y + r.height - props.bandTop + 2)
  return { top: `${top}px`, left: `${r.x}px`, width: `${r.width}px` }
}

const rowEls: HTMLElement[] = []
function setRowEl(el: unknown, i: number): void {
  if (el) rowEls[i] = el as HTMLElement
}

// activeIdx 变化(方向键/hover)时保证活动行可见
watch(
  () => props.payload.activeIdx,
  (idx) => {
    rowEls[idx]?.scrollIntoView({ block: 'nearest' })
  },
  { flush: 'post' }
)

function pick(i: number): void {
  emit('overlay-event', 'pick', i)
}
function hover(i: number): void {
  emit('overlay-event', 'hover', i)
}
function cancel(): void {
  emit('overlay-event', 'cancel')
}
</script>

<template>
  <!-- mousedown.prevent:焦点永驻 chrome 地址栏输入框,避免跨 webContents 的 blur 竞态 -->
  <div class="suggest-panel" :style="box()" @mousedown.prevent @mousedown.self="cancel">
    <div v-for="(row, i) in payload.rows" :key="i">
      <div
        :ref="(el) => setRowEl(el, i)"
        class="suggest-row"
        :class="{ active: i === payload.activeIdx }"
        @mouseenter="hover(i)"
        @mousedown="pick(i)"
      >
        <span class="s-icon">
          <Search v-if="row.kind === 'search'" :size="14" />
          <HistoryIcon v-else-if="row.kind === 'history'" :size="14" />
          <BookmarkIcon v-else :size="14" />
        </span>
        <span class="s-main">
          <span class="s-title">
            <template v-for="(seg, si) in row.segments" :key="si">
              <span v-if="seg.hl" class="hl">{{ seg.text }}</span>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
          <span class="s-sub">{{ row.sub }}</span>
        </span>
      </div>
    </div>
  </div>
</template>