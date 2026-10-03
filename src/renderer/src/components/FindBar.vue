<script setup lang="ts">
/**
 * 页内查找条(overlay 组件,复用 `page-top-right` 小尺寸 placement)。
 *
 * 契约与其它 overlay 组件一致:`payload` prop + `band-top` prop + `overlay-event` emit。
 * 结果**不走 payload**,而是订阅主进程的 `find:state`(见 `main/findBar.ts` 顶部注释)——
 * 组件自己订阅即可,不必经 OverlayApp 透传。
 *
 * 焦点细节:点按钮一律 `@mousedown.prevent` **并在动作后手动把焦点还给输入框**,
 * 否则点一下 `Aa` 输入框就失焦、`Esc` / Enter 会失效(与 `SplitMenu.vue` 保持 chrome 焦点同理,
 * 差别是这里要保持**本** webContents 的输入焦点)。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-vue-next'
import type { FindPayload, FindStateMessage } from '@shared/types'

const props = defineProps<{ payload: FindPayload; bandTop: number }>()
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

const api = window.browserAPI

const inputEl = ref<HTMLInputElement | null>(null)
const text = ref(props.payload.query)
const matchCase = ref(props.payload.matchCase)
const matches = ref(0)
const active = ref(0)
/** 是否发起过查询(空输入时不显示计数) */
const queried = ref(false)

let debounce: ReturnType<typeof setTimeout> | null = null
let unsubscribe: (() => void) | null = null

function emitQuery(): void {
  queried.value = text.value.length > 0
  if (!queried.value) {
    matches.value = 0
    active.value = 0
  }
  emit('overlay-event', 'query', { text: text.value, matchCase: matchCase.value })
}

function onInput(): void {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    emitQuery()
  }, 80)
}

function toggleCase(): void {
  matchCase.value = !matchCase.value
  if (debounce) {
    clearTimeout(debounce)
    debounce = null
  }
  emitQuery()
  focusInput()
}

function step(forward: boolean): void {
  if (!text.value) return
  emit('overlay-event', 'next', { forward })
  focusInput()
}

function close(): void {
  emit('overlay-event', 'close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    step(!e.shiftKey)
    return
  }
  if (e.key === 'Escape' || e.key === 'Esc') {
    e.preventDefault()
    close()
  }
}

function focusInput(): void {
  inputEl.value?.focus()
  inputEl.value?.select()
}

const countText = computed(() => {
  if (!queried.value) return ''
  if (matches.value === 0) return '无结果'
  return `${active.value}/${matches.value}`
})

onMounted(() => {
  focusInput()
  unsubscribe = api.onFindState((msg: FindStateMessage) => {
    // Ctrl+F 再次按下:重新聚焦 + 全选,沿用当前查询
    if (msg.refocus) {
      focusInput()
      return
    }
    if (typeof msg.matches === 'number') matches.value = msg.matches
    if (typeof msg.activeMatchOrdinal === 'number') active.value = msg.activeMatchOrdinal
  })
})

onBeforeUnmount(() => {
  if (debounce) clearTimeout(debounce)
  unsubscribe?.()
})
</script>

<template>
  <div class="fb-root">
    <Search class="fb-icon" :size="14" />
    <input
      ref="inputEl"
      v-model="text"
      class="fb-input"
      type="text"
      spellcheck="false"
      placeholder="在页面中查找"
      @input="onInput"
      @keydown="onKeydown"
    />
    <span class="fb-count" :class="{ none: queried && matches === 0 }">{{ countText }}</span>
    <button
      class="fb-btn fb-case"
      :class="{ on: matchCase }"
      title="区分大小写"
      @mousedown.prevent
      @click="toggleCase"
    >
      Aa
    </button>
    <button class="fb-btn" title="上一个 (Shift+Enter)" @mousedown.prevent @click="step(false)">
      <ChevronUp :size="15" />
    </button>
    <button class="fb-btn" title="下一个 (Enter)" @mousedown.prevent @click="step(true)">
      <ChevronDown :size="15" />
    </button>
    <button class="fb-btn" title="关闭 (Esc)" @mousedown.prevent @click="close">
      <X :size="15" />
    </button>
  </div>
</template>

<style scoped>
.fb-root {
  display: flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  height: 100%;
  padding: 0 7px 0 9px;
  color: var(--fg);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}

.fb-icon {
  flex: none;
  color: var(--fg-dim);
}

.fb-input {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 4px;
  background: transparent;
  border: none;
  outline: none;
  color: inherit;
  font: inherit;
  font-size: 13px;
}

.fb-count {
  flex: none;
  min-width: 52px;
  text-align: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim);
  white-space: nowrap;
}

.fb-count.none {
  color: #f9b44e;
}

.fb-btn {
  flex: none;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius);
  color: var(--fg-dim);
  cursor: pointer;
}

.fb-btn:hover {
  background: var(--bg2, rgba(255, 255, 255, 0.08));
  color: inherit;
}

.fb-case {
  width: 28px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}

.fb-case.on {
  color: var(--accent);
  background: var(--bg2, rgba(255, 255, 255, 0.08));
}
</style>
