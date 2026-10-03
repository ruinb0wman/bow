<script setup lang="ts">
/**
 * 番茄钟入口按钮(toolbar 插槽):运行时显示 `mm:ss`,点击在按钮下方弹锚定下拉面板
 * (`below-chrome`,定位几何交给面板,与「分屏」菜单同一套路)。
 *
 * 倒计时显示**本地插值**(拿主进程的 `endsAt` 与自己时钟比),所以主进程不必逐秒 IPC;
 * 阶段结束的 `phase-end` 事件触发闪烁 + 一声 WebAudio 提示音
 * (AudioContext 在本组件被点击时解锁 —— 从未点过按钮则提示音静默失败,系统通知仍在)。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Coffee, Timer } from 'lucide-vue-next'
import { POMO_EVENT, durationMs, formatClock, remainingMsOf, type PomoSnapshot } from '../shared'

const api = window.browserAPI
const buttonEl = ref<HTMLButtonElement | null>(null)
const snapshot = ref<PomoSnapshot | null>(null)
const now = ref(Date.now())
const blinking = ref(false)
const unsubs: Array<() => void> = []
let tick: number | undefined
let blinkTimer: number | undefined

const state = computed(() => snapshot.value?.state ?? null)
const running = computed(() => state.value?.running === true)
const phase = computed(() => state.value?.phase ?? 'focus')
const remaining = computed(() => (state.value ? remainingMsOf(state.value, now.value) : 0))
const clock = computed(() => formatClock(remaining.value))

/** 是否显示时间:空闲且满时长、且还没做过任何事 → 只显示图标 */
const showClock = computed(() => {
  const s = state.value
  const cfg = snapshot.value?.settings
  if (!s || !cfg) return false
  if (s.running) return true
  if (s.phase !== 'focus' || s.cycleIndex > 0 || s.completedToday > 0) return true
  return s.remainingMs < durationMs('focus', cfg)
})

const title = computed(() => {
  const s = state.value
  if (!s) return '番茄钟'
  const label = phase.value === 'focus' ? '专注' : phase.value === 'short-break' ? '短休息' : '长休息'
  return `番茄钟:${label} ${clock.value} ${s.running ? '进行中' : '已暂停'}(点击打开面板)`
})

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
    snapshot.value = null // 插件停用 / 内核未就绪:按钮安静下来
  }
  syncTick()
}

// ---------- 提示音(WebAudio,无音频资源) ----------

let audio: AudioContext | null = null

/** 在用户手势里解锁 AudioContext(浏览器自动播放策略) */
function ensureAudio(): void {
  try {
    if (!audio) audio = new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
  } catch {
    audio = null
  }
}

function beep(): void {
  if (!snapshot.value?.settings.sound) return
  const ctx = audio
  if (!ctx || ctx.state !== 'running') return
  try {
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, t)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.5)
  } catch {
    /* 音频不可用就算了 */
  }
}

function blink(): void {
  blinking.value = true
  if (blinkTimer !== undefined) window.clearTimeout(blinkTimer)
  blinkTimer = window.setTimeout(() => {
    blinking.value = false
  }, 5000)
}

function openPanel(): void {
  ensureAudio()
  const r = buttonEl.value?.getBoundingClientRect()
  void api.showOverlay({
    id: 'plugin:pomo:panel',
    placement: 'below-chrome',
    payload: {
      rect: { x: r?.x ?? 0, y: r?.y ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 }
    }
  })
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'pomo') return
      if (ev.event === POMO_EVENT.state) {
        snapshot.value = ev.args as PomoSnapshot
        syncTick()
      } else if (ev.event === POMO_EVENT.phaseEnd) {
        blink()
        beep()
      }
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (tick !== undefined) window.clearInterval(tick)
  if (blinkTimer !== undefined) window.clearTimeout(blinkTimer)
  void audio?.close()
})
</script>

<template>
  <button
    ref="buttonEl"
    class="tool-btn no-drag pomo-btn"
    :class="{ on: running, blink: blinking }"
    :title="title"
    @click="openPanel"
  >
    <Coffee v-if="phase !== 'focus'" :size="15" />
    <Timer v-else :size="15" />
    <span v-if="showClock" class="pomo-clock">{{ clock }}</span>
  </button>
</template>

<style scoped>
.pomo-btn {
  width: auto;
  min-width: 30px;
  padding: 0 6px;
  gap: 4px;
}
.pomo-clock {
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.2px;
}
.pomo-btn.blink {
  animation: pomo-blink 0.9s ease-in-out 5;
}
@keyframes pomo-blink {
  0%,
  100% {
    background: transparent;
    color: var(--fg);
  }
  50% {
    background: var(--accent);
    color: #fff;
  }
}
</style>
