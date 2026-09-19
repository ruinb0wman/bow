<script setup lang="ts">
/**
 * 分屏下拉面板(核心 `below-chrome` 浮层,由工具栏「分屏」按钮触发)。
 *
 * 数据全部来自 payload(chrome 侧组装),本组件不发 IPC,只回传 overlay-event:
 * enter(选右窗格)/ enter-new(新建标签再分屏)/ apply(套用预设)/ exit / cancel。
 * chrome 才是面板状态的 owner(与地址栏建议面板同一套做法),面板自己不关心分屏怎么实现。
 */
import { computed } from 'vue'
import type { SplitMenuPayload } from '@shared/types'
import type { SplitPreset } from '@shared/split'
import { matchSplitPreset, splitValueLabel } from '@shared/split'
import { faviconLetter } from '../lib/avatar'
import { Columns2, Plus, X } from 'lucide-vue-next'

const props = defineProps<{ payload: SplitMenuPayload; bandTop: number }>()
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

/** 面板贴在触发按钮右下方(bandTop 是浮层视图自己的坐标原点,主进程注入) */
const box = computed(() => {
  const r = props.payload.rect
  const right = Math.max(8, window.innerWidth - (r.x + r.width))
  const top = Math.max(2, r.y + r.height - props.bandTop + 2)
  return { top: `${top}px`, right: `${right}px` }
})

function titleOf(id: number | null): string {
  if (id == null) return '—'
  const tab = props.payload.tabs.find((t) => t.id === id)
  if (!tab) return `标签 ${id}`
  return tab.crashed ? '页面崩溃' : tab.title || tab.url
}

const leftTitle = computed(() => titleOf(props.payload.leftTabId))
const rightTitle = computed(() => titleOf(props.payload.split.rightTabId))

/** 当前高亮的预设:优先用主进程记的 presetId;首次分屏(还没点过预设)则按「值+单位」反查 */
const activePresetId = computed(
  () => props.payload.split.presetId ?? matchSplitPreset(props.payload.presets, props.payload.split.level)?.id ?? null
)

/** 候选 = 全部标签去掉左窗格(将成为左窗格的那个)与当前右窗格 */
const candidates = computed(() => {
  const left = props.payload.leftTabId
  const right = props.payload.split.rightTabId
  return props.payload.tabs.filter((t) => t.id !== left && t.id !== right)
})

/** 预设小示意图里左侧色块的宽度(像素档按当前窗口宽度折算) */
function miniLeft(p: SplitPreset): string {
  const pct =
    p.unit === 'percent' ? p.value : Math.round((p.value / Math.max(1, window.innerWidth)) * 100)
  return `${Math.min(88, Math.max(12, pct))}%`
}

function pick(id: number): void {
  emit('overlay-event', 'enter', id)
}
function newAndSplit(): void {
  emit('overlay-event', 'enter-new')
}
function applyPreset(id: string): void {
  emit('overlay-event', 'apply', id)
}
function exitSplit(): void {
  emit('overlay-event', 'exit')
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
        <button v-if="payload.split.active" class="sm-quiet" @click="exitSplit">关闭分屏</button>
        <button class="sm-icon" title="关闭" @click="cancel"><X :size="13" /></button>
      </div>

      <div v-if="payload.split.active" class="sm-pair">
        <div class="sm-pane"><span class="sm-pane-tag">左</span>{{ leftTitle }}</div>
        <div class="sm-pane"><span class="sm-pane-tag">右</span>{{ rightTitle }}</div>
      </div>

      <template v-if="payload.split.active">
        <div class="sm-section">宽度预设</div>
        <div class="sm-presets">
          <button
            v-for="p in payload.presets"
            :key="p.id"
            class="sm-preset"
            :class="{ on: p.id === activePresetId }"
            :title="`${p.label} · ${splitValueLabel(p)}`"
            @mousedown.prevent="applyPreset(p.id)"
          >
            <span class="sm-mini"><i :style="{ width: miniLeft(p) }"></i></span>
            <span class="sm-preset-text">{{ p.label }}</span>
            <span class="sm-preset-sub">{{ splitValueLabel(p) }}</span>
          </button>
          <div v-if="payload.presets.length === 0" class="sm-empty">
            还没有预设 —— 去「设置 → 常规 → 分屏宽度预设」里添加
          </div>
        </div>
      </template>

      <div class="sm-section">{{ payload.split.active ? '更换右侧标签' : '在右侧打开' }}</div>
      <div class="sm-tabs">
        <button
          v-for="t in candidates"
          :key="t.id"
          class="sm-tab"
          :title="t.url"
          @mousedown.prevent="pick(t.id)"
        >
          <span class="sm-letter">{{ faviconLetter(t.title) }}</span>
          <span class="sm-tab-title">{{ t.title || t.url }}</span>
        </button>
        <div v-if="candidates.length === 0" class="sm-empty">没有其它标签了</div>
      </div>

      <button class="sm-new" @mousedown.prevent="newAndSplit">
        <Plus :size="13" /> 新建空白标签并在右侧分屏
      </button>
      <div class="sm-foot">分屏只保留两个标签;点其它标签、或关掉其中任何一个,都会退出分屏。</div>
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

.sm-pair {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--fg-dim);
  font-size: 12px;
}

.sm-pane {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sm-pane-tag {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  background: var(--bg3);
  color: var(--accent);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}

.sm-section {
  padding: 8px 10px 4px;
  color: var(--fg-dim);
  font-size: 11px;
  letter-spacing: 0.06em;
}

.sm-presets {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 6px 4px;
}

.sm-preset {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--radius);
  text-align: left;
}

.sm-preset:hover {
  background: var(--bg3);
}

.sm-preset.on {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

.sm-mini {
  flex: none;
  width: 34px;
  height: 18px;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg);
}

.sm-mini i {
  display: block;
  background: color-mix(in srgb, var(--accent) 65%, transparent);
}

.sm-preset-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sm-preset-sub {
  flex: none;
  color: var(--fg-dim);
  font-size: 11px;
}

.sm-tabs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 6px;
  overflow-y: auto;
  max-height: 220px;
}

.sm-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: var(--radius);
  text-align: left;
}

.sm-tab:hover {
  background: var(--bg3);
}

.sm-letter {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: var(--bg3);
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
}

.sm-tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sm-empty {
  padding: 6px;
  color: var(--fg-dim);
  font-size: 12px;
}

.sm-new {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 10px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--fg-dim);
  font-size: 12px;
}

.sm-new:hover {
  background: var(--bg3);
  color: var(--fg);
}

.sm-foot {
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  color: var(--fg-dim);
  font-size: 11px;
  line-height: 1.5;
}
</style>
