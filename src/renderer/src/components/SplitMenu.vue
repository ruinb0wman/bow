<script setup lang="ts">
/**
 * 分屏面板(核心 `below-chrome` 浮层,由工具栏「分屏」按钮触发)。
 *
 * 语义是**标签组**:当前组是一棵可任意嵌套的分屏树。面板做三件事:
 * - 列出当前组的窗格(点一行 = 聚焦那个窗格);
 * - 保存当前布局(只存结构:嵌套方向 + 比例);
 * - 套用已保存的布局(**在当前组后面新开一个标签组**)/ 删除布局;以及「取消分屏」。
 *
 * 数据全部来自 payload(chrome 侧组装),本组件不发 IPC,只回传 overlay-event:
 * focus / save / apply / delete / ungroup / cancel。
 */
import { computed } from 'vue'
import type { SplitMenuPayload } from '@shared/types'
import type { LayoutPreset } from '@shared/split'
import { shapePaneCount, shapeSummary } from '@shared/split'
import { faviconLetter } from '../lib/avatar'
import { Columns2, LayoutPanelTop, Plus, Trash2, X } from 'lucide-vue-next'

const props = defineProps<{ payload: SplitMenuPayload; bandTop: number }>()
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

/** 面板贴在触发按钮右下方(bandTop 是浮层视图自己的坐标原点,主进程注入) */
const box = computed(() => {
  const r = props.payload.rect
  const right = Math.max(8, window.innerWidth - (r.x + r.width))
  const top = Math.max(2, r.y + r.height - props.bandTop + 2)
  return { top: `${top}px`, right: `${right}px` }
})

/** 单窗格组没有结构可存,按钮直接禁用(主进程也会忽略) */
const canSave = computed(() => props.payload.panes.length > 1)

function layoutDetail(l: LayoutPreset): string {
  const summary = shapeSummary(l.shape)
  return summary ? `${shapePaneCount(l.shape)} 窗格 · ${summary}` : `${shapePaneCount(l.shape)} 窗格`
}

function focus(tabId: number): void {
  emit('overlay-event', 'focus', tabId)
}
function save(): void {
  emit('overlay-event', 'save')
}
function apply(id: string): void {
  emit('overlay-event', 'apply', id)
}
function remove(id: string): void {
  emit('overlay-event', 'delete', id)
}
function ungroup(): void {
  emit('overlay-event', 'ungroup')
}
function cancel(): void {
  emit('overlay-event', 'cancel')
}
</script>

<template>
  <!-- mousedown.prevent:焦点留在 chrome,同时避免跨 webContents 的焦点竞态 -->
  <div class="sm-root" @mousedown.prevent>
    <div class="sm-backdrop" @mousedown.self="cancel"></div>
    <div class="sm-panel" :style="box">
      <div class="sm-head">
        <Columns2 :size="14" />
        <span class="sm-title">分屏</span>
        <button v-if="payload.panes.length > 1" class="sm-quiet" @click="ungroup">取消分屏</button>
        <button class="sm-icon" title="关闭" @click="cancel"><X :size="13" /></button>
      </div>

      <div class="sm-section">当前布局</div>
      <div class="sm-panes">
        <button
          v-for="(p, i) in payload.panes"
          :key="p.tabId"
          class="sm-pane"
          :class="{ focused: p.tabId === payload.focusedTabId }"
          :title="p.url"
          @mousedown.prevent="focus(p.tabId)"
        >
          <span class="sm-pane-idx">{{ i + 1 }}</span>
          <span class="sm-letter">{{ faviconLetter(p.title) }}</span>
          <span class="sm-pane-title">{{ p.crashed ? '页面崩溃' : p.title || p.url }}</span>
        </button>
        <div v-if="payload.panes.length === 0" class="sm-empty">当前没有窗格</div>
      </div>
      <div class="sm-hint">
        `Ctrl+Shift+方向键` 在当前窗格上分屏(新窗格开空白标签并聚焦),`Alt+Shift+方向键` 调整当前窗格大小。
      </div>

      <button class="sm-new" :disabled="!canSave" @mousedown.prevent="save">
        <Plus :size="13" /> 保存当前布局
      </button>
      <div v-if="!canSave" class="sm-hint">先分屏(≥2 个窗格)才有结构可保存</div>

      <div class="sm-section">已保存的布局</div>
      <div class="sm-layouts">
        <div v-for="l in payload.layouts" :key="l.id" class="sm-layout">
          <button
            class="sm-layout-open"
            :title="`在新标签组里打开:${layoutDetail(l)}`"
            @mousedown.prevent="apply(l.id)"
          >
            <LayoutPanelTop :size="13" />
            <span class="sm-layout-name">{{ l.name }}</span>
            <span class="sm-layout-sub">{{ layoutDetail(l) }}</span>
          </button>
          <button class="sm-icon" title="删除这个布局" @mousedown.prevent="remove(l.id)">
            <Trash2 :size="12" />
          </button>
        </div>
        <div v-if="payload.layouts.length === 0" class="sm-empty">还没有保存的布局</div>
      </div>

      <div class="sm-foot">
        套用布局会在当前组后面**新开一个标签组**(N 个窗格 = N 个新标签),现有分屏不受影响。
        标签栏里的一项就是一个组,多窗格组只显示聚焦窗格的名字。
      </div>
    </div>
  </div>
</template>

<style scoped>
.sm-root {
  position: fixed;
  inset: 0;
  font-size: 13px;
}

.sm-backdrop {
  position: absolute;
  inset: 0;
}

.sm-panel {
  position: fixed;
  width: 300px;
  max-height: calc(100% - 12px);
  display: flex;
  flex-direction: column;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.sm-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.sm-title {
  flex: 1;
  font-weight: 600;
}

.sm-quiet,
.sm-icon {
  flex: none;
  color: var(--fg-dim);
  border-radius: var(--radius);
  padding: 2px 6px;
  display: inline-flex;
  align-items: center;
}

.sm-quiet {
  font-size: 12px;
}

.sm-quiet:hover,
.sm-icon:hover {
  background: var(--bg3);
  color: var(--fg);
}

.sm-section {
  padding: 8px 10px 4px;
  color: var(--fg-dim);
  font-size: 11px;
  letter-spacing: 0.06em;
}

.sm-panes {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 6px;
  max-height: 200px;
  overflow-y: auto;
}

.sm-pane {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: var(--radius);
  text-align: left;
  color: var(--fg-dim);
}

.sm-pane:hover {
  background: var(--bg3);
}

/* 聚焦的窗格:地址栏 / 前进后退 / Ctrl+W 都朝着它 */
.sm-pane.focused {
  background: color-mix(in srgb, var(--accent) 20%, transparent);
  color: var(--fg);
}

.sm-pane-idx {
  flex: none;
  width: 14px;
  color: var(--fg-dim);
  font-size: 10px;
  text-align: right;
}

.sm-letter {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  background: var(--bg3);
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}

.sm-pane-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sm-hint {
  padding: 4px 10px 2px;
  color: var(--fg-dim);
  font-size: 11px;
  line-height: 1.5;
}

.sm-new {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 10px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg-dim);
  font-size: 12px;
}

.sm-new:hover:not(:disabled) {
  background: var(--bg3);
  color: var(--fg);
}

.sm-new:disabled {
  opacity: 0.5;
  cursor: default;
}

.sm-layouts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 6px 4px;
  max-height: 220px;
  overflow-y: auto;
}

.sm-layout {
  display: flex;
  align-items: center;
  gap: 2px;
}

.sm-layout-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border-radius: var(--radius);
  text-align: left;
}

.sm-layout-open:hover {
  background: var(--bg3);
}

.sm-layout-name {
  flex: none;
  max-width: 110px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sm-layout-sub {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--fg-dim);
  font-size: 11px;
  text-align: right;
}

.sm-empty {
  padding: 6px;
  color: var(--fg-dim);
  font-size: 12px;
}

.sm-foot {
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  color: var(--fg-dim);
  font-size: 11px;
  line-height: 1.5;
}
</style>
