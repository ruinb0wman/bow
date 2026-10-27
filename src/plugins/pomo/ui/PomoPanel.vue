<script setup lang="ts">
/**
 * 番茄钟面板(below-chrome 锚定下拉,由工具栏按钮触发)。
 *
 * 定位与「分屏」菜单同款:`payload.rect` 是触发按钮在 chrome 视口里的矩形,
 * `bandTop` 是本浮层视图自己的坐标原点(主进程注入),据此把面板贴到按钮右下方。
 *
 * 只做两件事:调 `plugins.invoke('pomo', …)` 与渲染 —— 阶段 / 剩余时间 / 计数全在主进程。
 * 关闭:点面板外(backdrop)、× 或 Esc,统一发 `close-request`(主进程处理)。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Coffee, Pause, Play, RotateCcw, Settings2, SkipForward, Timer, X } from '@lucide/vue'
import {
  POMO_EVENT,
  PHASE_LABELS,
  durationMs,
  formatClock,
  remainingMsOf,
  roundLabel,
  type PomoSnapshot
} from '../shared'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const props = defineProps<{ payload?: { rect?: Rect }; bandTop?: number }>()
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

const api = window.browserAPI
const snapshot = ref<PomoSnapshot | null>(null)
const now = ref(Date.now())
const busy = ref(false)
const unsubs: Array<() => void> = []
let tick: number | undefined

const state = computed(() => snapshot.value?.state ?? null)
const settings = computed(() => snapshot.value?.settings ?? null)
const running = computed(() => state.value?.running === true)
const remaining = computed(() => (state.value ? remainingMsOf(state.value, now.value) : 0))
const clock = computed(() => formatClock(remaining.value))
const total = computed(() =>
  state.value && settings.value ? durationMs(state.value.phase, settings.value) : 0
)
const progress = computed(() => (total.value > 0 ? Math.min(1, Math.max(0, 1 - remaining.value / total.value)) : 0))
const phaseLabel = computed(() => (state.value ? PHASE_LABELS[state.value.phase] : '番茄钟'))
const round = computed(() => (state.value && settings.value ? roundLabel(state.value, settings.value) : ''))

/** 面板贴在按钮右下方(bandTop 是浮层视图自己的坐标原点,主进程注入) */
const box = computed(() => {
  const r = props.payload?.rect ?? { x: 0, y: 0, width: 0, height: 0 }
  const bandTop = props.bandTop ?? 0
  const right = Math.max(8, window.innerWidth - (r.x + r.width))
  const top = Math.max(2, r.y + r.height - bandTop + 2)
  return { top: `${top}px`, right: `${right}px` }
})

function close(): void {
  emit('overlay-event', 'close-request')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}

function syncTick(): void {
  now.value = Date.now()
  if (running.value && tick === undefined) {
    tick = window.setInterval(() => {
      now.value = Date.now()
    }, 250)
  } else if (!running.value && tick !== undefined) {
    window.clearInterval(tick)
    tick = undefined
  }
}

async function refresh(): Promise<void> {
  try {
    snapshot.value = await api.plugins.invoke<PomoSnapshot>('pomo', 'getState')
  } catch {
    snapshot.value = null
  }
  syncTick()
}

async function call(method: 'start' | 'pause' | 'skip' | 'reset'): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    snapshot.value = await api.plugins.invoke<PomoSnapshot>('pomo', method)
  } catch {
    /* 插件停用 / 出错:保持面板 */
  } finally {
    busy.value = false
  }
  syncTick()
}

function toggle(): void {
  void call(running.value ? 'pause' : 'start')
}

function openSettings(): void {
  void api.createTab('bow://settings', true)
  close()
}

onMounted(() => {
  void refresh()
  window.addEventListener('keydown', onKeydown)
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'pomo') return
      if (ev.event === POMO_EVENT.state) {
        snapshot.value = ev.args as PomoSnapshot
        syncTick()
      }
    })
  )
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unsubs.forEach((u) => u())
  if (tick !== undefined) window.clearInterval(tick)
})
</script>

<template>
  <!-- mousedown.prevent:焦点留在 chrome;backdrop 只在自身上关闭 -->
  <div class="pp-root" @mousedown.prevent>
    <div class="pp-backdrop" @mousedown.self="close"></div>
    <div class="pp-panel" :style="box">
      <div class="pp-head">
        <Coffee v-if="state && state.phase !== 'focus'" :size="14" />
        <Timer v-else :size="14" />
        <span class="pp-title">{{ phaseLabel }}</span>
        <button class="pp-icon" title="打开设置" @click="openSettings"><Settings2 :size="13" /></button>
        <button class="pp-icon" title="关闭" @click="close"><X :size="13" /></button>
      </div>

      <div class="pp-body">
        <div class="pp-clock">{{ clock }}</div>
        <div class="pp-bar"><i :style="{ width: `${Math.round(progress * 100)}%` }"></i></div>
        <div class="pp-meta">
          <span>{{ round }}</span>
          <span class="pp-dot">·</span>
          <span>今日 🍅 {{ state?.completedToday ?? 0 }}</span>
        </div>
      </div>

      <div class="pp-actions">
        <button class="pp-btn primary" :disabled="busy || !state" @click="toggle">
          <Pause v-if="running" :size="14" />
          <Play v-else :size="14" />
          {{ running ? '暂停' : '开始' }}
        </button>
        <button class="pp-btn" :disabled="busy || !state" @click="call('skip')">
          <SkipForward :size="14" />跳过
        </button>
        <button class="pp-btn" :disabled="busy || !state" @click="call('reset')">
          <RotateCcw :size="14" />重置
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pp-root {
  position: fixed;
  inset: 0;
  font-size: 13px;
}

.pp-backdrop {
  position: absolute;
  inset: 0;
}

.pp-panel {
  position: fixed;
  width: 260px;
  display: flex;
  flex-direction: column;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.pp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--fg-dim);
}

.pp-title {
  flex: 1;
  font-weight: 600;
  color: var(--fg);
}

.pp-icon {
  flex: none;
  color: var(--fg-dim);
  border-radius: var(--radius);
  padding: 2px 6px;
  display: inline-flex;
  align-items: center;
}

.pp-icon:hover {
  background: var(--bg3);
  color: var(--fg);
}

.pp-body {
  padding: 12px 14px 8px;
}

.pp-clock {
  font-size: 40px;
  line-height: 1.1;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -1px;
  text-align: center;
  color: var(--fg);
}

.pp-bar {
  margin: 10px 0 8px;
  height: 4px;
  border-radius: 2px;
  background: var(--bg3);
  overflow: hidden;
}

.pp-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.25s linear;
}

.pp-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--fg-dim);
  font-size: 12px;
}

.pp-dot {
  opacity: 0.5;
}

.pp-actions {
  display: flex;
  gap: 6px;
  padding: 8px 10px 10px;
}

.pp-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg3);
  color: var(--fg);
  font-size: 12px;
}

.pp-btn:hover:not(:disabled) {
  background: var(--bg);
}

.pp-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.pp-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
</style>
