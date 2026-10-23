<script setup lang="ts">
/**
 * 远程终端视图:xterm ↔ 主进程 pty(经 WS)。
 *
 * 与 `bow://terminal` 页面的那个视图是**两份实现**,这是有意的 —— 那边用 preload 的
 * `plugins.invoke`,这里只能用 WS;而共用的东西(主题、默认字号、按键改写)都从
 * `@plugins/terminal/shared` 与 `./keys` 拿,不重复定义。
 *
 * 尺寸:远程会在 attach 时把自己的 cols/rows 推给 pty(「最后一个 resize 者胜」)。
 * 手机横竖屏切换要重新 fit 再 resize,否则 shell 会按旧宽度折行。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, DEFAULT_SCROLLBACK, TERMINAL_THEME } from '@plugins/terminal/shared'
import KeyBar from './KeyBar.vue'
import { applyModifiers } from './keys'
import type { RemoteSocket } from './ws'

const props = defineProps<{ sessionId: number; title: string; socket: RemoteSocket | null; replay: string }>()
const emit = defineEmits<{ back: [] }>()

const host = ref<HTMLElement | null>(null)
const ctrl = ref(false)
const alt = ref(false)
const status = ref('')

let term: Terminal | null = null
let fit: FitAddon | null = null
let observer: ResizeObserver | null = null
let sizeTimer: number | undefined

function sendInput(data: string): void {
  const withMods = applyModifiers(data, { ctrl: ctrl.value, alt: alt.value })
  // 修饰键只作用一次(与桌面终端的手感一致)
  if (ctrl.value || alt.value) {
    ctrl.value = false
    alt.value = false
  }
  props.socket?.send({ t: 'input', id: props.sessionId, data: withMods })
}

function sendRaw(data: string): void {
  props.socket?.send({ t: 'input', id: props.sessionId, data })
}

/** 容器尺寸变了 → 重新算格子 → 告诉 pty */
function refit(): void {
  if (!term || !fit) return
  try {
    fit.fit()
  } catch {
    /* 容器还没有尺寸 */
  }
  if (sizeTimer !== undefined) return
  sizeTimer = window.setTimeout(() => {
    sizeTimer = undefined
    if (!term) return
    props.socket?.send({ t: 'resize', id: props.sessionId, cols: term.cols, rows: term.rows })
  }, 120)
}

async function paste(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text) sendRaw(text)
  } catch {
    status.value = '浏览器不允许读剪贴板(需要 https 或手动粘贴)'
  }
}

onMounted(() => {
  if (!host.value) return
  term = new Terminal({
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
    scrollback: DEFAULT_SCROLLBACK,
    theme: TERMINAL_THEME,
    convertEol: false,
    cursorBlink: true
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host.value)
  term.onData(sendInput)
  refit()

  observer = new ResizeObserver(() => refit())
  observer.observe(host.value)
  window.addEventListener('orientationchange', refit)

  // 回放:attach 之前的历史(服务端在 attach 时一次性给)
  if (props.replay) term.write(props.replay)
  // 键盘弹出/收起会改视口高度,但不一定触发 ResizeObserver
  window.visualViewport?.addEventListener('resize', refit)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('orientationchange', refit)
  window.visualViewport?.removeEventListener('resize', refit)
  if (sizeTimer !== undefined) window.clearTimeout(sizeTimer)
  term?.dispose()
  term = null
  fit = null
})

/** 父组件把数据/退出塞进来 */
defineExpose({
  write: (chunk: string) => term?.write(chunk),
  exit: (code: number) => {
    status.value = `shell 已退出(代码 ${code})`
  }
})

// 标题变化时只需重排(无需重建)
watch(
  () => props.title,
  () => refit()
)
</script>

<template>
  <div class="term-wrap">
    <div class="term-head">
      <button class="back" title="返回会话列表" @click="emit('back')">‹ 列表</button>
      <span class="term-title">{{ title }}</span>
      <span v-if="status" class="term-status">{{ status }}</span>
    </div>
    <div ref="host" class="term-host" />
    <KeyBar
      :ctrl="ctrl"
      :alt="alt"
      @update:ctrl="ctrl = $event"
      @update:alt="alt = $event"
      @send="sendRaw"
      @paste="paste"
    />
  </div>
</template>

<style scoped>
.term-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.term-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid #33353f;
  background: #202127;
}
.back {
  min-height: 36px;
  padding: 0 10px;
}
.term-title {
  font-size: 13px;
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.term-status {
  margin-left: auto;
  font-size: 12px;
  color: var(--danger);
}
.term-host {
  flex: 1;
  min-height: 0;
  padding: 4px 6px;
  overflow: hidden;
}
</style>
