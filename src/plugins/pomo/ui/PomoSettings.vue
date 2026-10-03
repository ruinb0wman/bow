<script setup lang="ts">
/**
 * 番茄钟设置分区:各阶段时长 / 长休轮数 / 自动开始 / 通知与提示音。
 * 所有设置即时保存(`setSettings` 返回夹紧后的值,直接回填)。
 *
 * 时长改动只影响**之后**开始的阶段:正在跑的阶段用它的 `endsAt`,不会被改短或拉长。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { POMO_EVENT, MAX_MINUTES, MAX_ROUNDS, MIN_MINUTES, MIN_ROUNDS, type PomoSettings, type PomoSnapshot } from '../shared'

const api = window.browserAPI
const settings = ref<PomoSettings | null>(null)
const notice = ref('')
const unsubs: Array<() => void> = []
let noticeTimer: number | undefined

function flash(text: string): void {
  notice.value = text
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 2000)
}

async function load(): Promise<void> {
  const snap = await api.plugins.invoke<PomoSnapshot>('pomo', 'getState')
  settings.value = snap.settings
}

async function patch(p: Partial<PomoSettings>): Promise<void> {
  const next = await api.plugins.invoke<PomoSettings>('pomo', 'setSettings', p)
  settings.value = next
}

function onNumber(key: 'focusMinutes' | 'shortBreakMinutes' | 'longBreakMinutes' | 'roundsBeforeLongBreak', e: Event): void {
  const value = Number((e.target as HTMLInputElement).value)
  void patch({ [key]: value } as Partial<PomoSettings>).then(() => {
    if (key === 'roundsBeforeLongBreak') flash('已保存')
  })
}

function onToggle(key: 'autoStartNext' | 'notify' | 'sound', e: Event): void {
  const checked = (e.target as HTMLInputElement).checked
  void patch({ [key]: checked } as Partial<PomoSettings>)
}

onMounted(() => {
  void load()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'pomo' || ev.event !== POMO_EVENT.state) return
      // 别的入口(面板 / MCP / 热键)改了设置时同步回来
      settings.value = (ev.args as PomoSnapshot).settings
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <section class="pomo-settings">
    <div class="section-title">时长</div>
    <div class="set-row">
      <span class="set-label">专注时长</span>
      <input
        class="pbm-input ps-num"
        type="number"
        :min="MIN_MINUTES"
        :max="MAX_MINUTES"
        :value="settings?.focusMinutes ?? 25"
        @change="onNumber('focusMinutes', $event)"
      />
      <span class="ps-unit">分钟</span>
    </div>
    <div class="set-row">
      <span class="set-label">短休息</span>
      <input
        class="pbm-input ps-num"
        type="number"
        :min="MIN_MINUTES"
        :max="MAX_MINUTES"
        :value="settings?.shortBreakMinutes ?? 5"
        @change="onNumber('shortBreakMinutes', $event)"
      />
      <span class="ps-unit">分钟</span>
    </div>
    <div class="set-row">
      <span class="set-label">长休息</span>
      <input
        class="pbm-input ps-num"
        type="number"
        :min="MIN_MINUTES"
        :max="MAX_MINUTES"
        :value="settings?.longBreakMinutes ?? 15"
        @change="onNumber('longBreakMinutes', $event)"
      />
      <span class="ps-unit">分钟</span>
    </div>
    <div class="set-row">
      <span class="set-label">长休间隔</span>
      <input
        class="pbm-input ps-num"
        type="number"
        :min="MIN_ROUNDS"
        :max="MAX_ROUNDS"
        :value="settings?.roundsBeforeLongBreak ?? 4"
        @change="onNumber('roundsBeforeLongBreak', $event)"
      />
      <span class="ps-unit">个专注后长休</span>
      <span v-if="notice" class="ps-notice">{{ notice }}</span>
    </div>

    <div class="section-title">行为</div>
    <div class="set-row">
      <label class="set-check">
        <input
          type="checkbox"
          :checked="settings?.autoStartNext ?? false"
          @change="onToggle('autoStartNext', $event)"
        />
        阶段结束后自动开始下一阶段
      </label>
    </div>

    <div class="section-title">提醒</div>
    <div class="set-row">
      <label class="set-check">
        <input type="checkbox" :checked="settings?.notify ?? true" @change="onToggle('notify', $event)" />
        阶段结束时弹系统通知
      </label>
    </div>
    <div class="set-row">
      <label class="set-check">
        <input type="checkbox" :checked="settings?.sound ?? true" @change="onToggle('sound', $event)" />
        阶段结束时响提示音
      </label>
    </div>
    <div class="ps-hint">
      提示音由浏览器界面播放,所以要在你点过工具栏的番茄按钮之后才会响(系统通知不受影响,但静音)。
      时长改动只影响之后开始的阶段 —— 正在跑的阶段保持原时长。
    </div>
    <div class="ps-hint">
      快捷键 <code>Ctrl/Cmd+Shift+O</code> 可以随时开始 / 暂停;AI 可通过 MCP 的
      <code>browser_pomo_status</code> / <code>browser_pomo_start</code> / <code>browser_pomo_pause</code> /
      <code>browser_pomo_skip</code> 查询与控制。
    </div>
  </section>
</template>

<style scoped>
/* 父层 `.settings-body-plugin` 是 overflow:hidden,这一节必须自己滚 */
.pomo-settings {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 14px 20px;
  font-size: 13px;
}
.section-title {
  margin: 18px 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-dim);
}
.pomo-settings .section-title:first-child {
  margin-top: 8px;
}
.ps-num {
  flex: none;
  width: 96px;
}
.ps-unit {
  flex: none;
  color: var(--fg-dim);
  font-size: 12px;
}
.ps-notice {
  color: var(--fg-dim);
  font-size: 12px;
}
.ps-hint {
  padding: 6px 14px 0 110px;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.6;
}
.ps-hint code {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  background: var(--bg3);
  border-radius: 4px;
  padding: 1px 4px;
}
</style>
