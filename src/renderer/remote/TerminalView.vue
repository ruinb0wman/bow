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
/** 视口是否停在「历史」里(不在底部) */
const scrolledBack = ref(false)
/** 翻着历史时又来了新输出:提示「↓ 新输出」,但**不**把视口拽走 */
const pendingOutput = ref(false)

let term: Terminal | null = null
let fit: FitAddon | null = null
let observer: ResizeObserver | null = null
let sizeTimer: number | undefined

/**
 * 把焦点还给终端。按键条上的任何操作之后都要调 —— 手机上一旦失焦,软键盘就收起,
 * 后面敲的字也进不了终端。
 */
function refocus(): void {
  term?.focus()
}

/** 回看/回底不是「一个字符」:顺手把粘滞修饰键熄灭,免得滚动后第一下打字变成 Ctrl+C */
function clearModifiers(): void {
  ctrl.value = false
  alt.value = false
}

/** 本地回看(不往 shell 发任何字节):上和下各一屏 */
function scrollPage(dir: -1 | 1): void {
  clearModifiers()
  term?.scrollPages(dir)
  syncScroll()
  refocus()
}

function toBottom(): void {
  clearModifiers()
  term?.scrollToBottom()
  pendingOutput.value = false
  syncScroll()
  refocus()
}

/** 同步「是否停在历史里」。xterm 的 viewportY < baseY 就表示视口在底部之上 */
function syncScroll(): void {
  const buffer = term?.buffer.active
  const atHistory = !!buffer && buffer.viewportY < buffer.baseY
  scrolledBack.value = atHistory
  if (!atHistory) pendingOutput.value = false
}

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
  refocus()
}

/** KeyBar 的粘滞修饰键切换:点完立刻把焦点还给终端,不然软键盘已经收起来了 */
function setCtrl(next: boolean): void {
  ctrl.value = next
  refocus()
}
function setAlt(next: boolean): void {
  alt.value = next
  refocus()
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
  // 测试缝(与 bow://terminal 页的 `__bowTerminal` 同一个套路):e2e 要断言「真的翻到了历史里」,
  // 而 xterm 6 的可滚动 DOM 不是 `.xterm-viewport` 一个简单元素 —— 直接读它的 buffer 才可靠。
  ;(window as unknown as Record<string, unknown>).__bowRemoteTerm = term
  refit()

  observer = new ResizeObserver(() => refit())
  observer.observe(host.value)
  window.addEventListener('orientationchange', refit)
  // 「谁刚碰过,尺寸归谁」:手机这边一碰也重新 fit,把 pty 挣回手机宽度
  // (电脑那边在 focus/pointerdown/keydown 时做同样的事,两边互相抢得回来)
  window.addEventListener('pointerdown', refit, true)

  // 回放:attach 之前的历史(服务端在 attach 时一次性给)
  if (props.replay) term.write(props.replay)
  // 拖动/翻页后 xterm 自己不会通知,靠这两个事件跟上
  term.onScroll(syncScroll)
  // 键盘弹出/收起会改视口高度,但不一定触发 ResizeObserver
  window.visualViewport?.addEventListener('resize', refit)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('orientationchange', refit)
  window.visualViewport?.removeEventListener('resize', refit)
  window.removeEventListener('pointerdown', refit, true)
  if (sizeTimer !== undefined) window.clearTimeout(sizeTimer)
  if ((window as unknown as Record<string, unknown>).__bowRemoteTerm) {
    delete (window as unknown as Record<string, unknown>).__bowRemoteTerm
  }
  term?.dispose()
  term = null
  fit = null
})

/** 父组件把数据/退出塞进来 */
defineExpose({
  write: (chunk: string) => {
    term?.write(chunk)
    // 翻着历史时:只做提示,不把视口拽回底部(否则一有输出就没法看历史)
    if (scrolledBack.value) pendingOutput.value = true
    syncScroll()
  },
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
    <!--
      本地回看:浮动按钮,不做手势。手机上是唯一能看历史的入口
      (xterm 的可滚动层在 canvas 下面,手指根本落不到它上面,原生滑动永远不生效)。
    -->
    <div class="scroll-pad">
      <button class="sc" tabindex="-1" title="向上看一屏(本地回看,不发给 shell)" @pointerdown.prevent @click="scrollPage(-1)">
        ▲
      </button>
      <button
        v-if="scrolledBack"
        class="sc"
        tabindex="-1"
        title="向下看一屏"
        @pointerdown.prevent
        @click="scrollPage(1)"
      >
        ▼
      </button>
      <button
        v-if="scrolledBack"
        class="sc sc-bottom"
        tabindex="-1"
        :title="pendingOutput ? '有新输出,点这里回到最新' : '回到最新'"
        @pointerdown.prevent
        @click="toBottom"
      >
        {{ pendingOutput ? '新输出' : '最新' }}
      </button>
    </div>
    <KeyBar :ctrl="ctrl" :alt="alt" @update:ctrl="setCtrl" @update:alt="setAlt" @send="sendRaw" @paste="paste" />
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

/* 浮动回看按钮:贴在按键条上方右侧,半透明,不挡正文中间那块 */
.scroll-pad {
  position: absolute;
  right: 8px;
  bottom: 64px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 5;
}
.sc {
  width: 44px;
  min-height: 40px;
  padding: 0;
  border-radius: 22px;
  background: rgba(44, 46, 54, 0.82);
  border-color: rgba(255, 255, 255, 0.12);
  font-size: 14px;
  opacity: 0.85;
}
.sc-bottom {
  width: 54px;
  font-size: 12px;
}
.term-wrap {
  position: relative;
}
</style>
