<script setup lang="ts">
/**
 * 终端视图:xterm 实例 + 与终端插件主进程(xterm↔node-pty 会话)的接线。
 *
 * 只被 `renderer/src/terminal`(即 `bow://terminal` 页面)引用 —— 它不是插件插槽组件,
 * 所以不在 `ui.ts` 里注册。
 *
 * 生命周期要点:
 * - 会话按 tabId 绑定:先 `getSelfTabId()` 认领标签,再 `attach()`;
 * - 刷新/崩溃重建时同一个 tabId 会 attach 回**同一个** shell,并回放此前的输出;
 * - 卸载时只 `detach()`(会话留着),真正的回收由主进程在标签关闭时做。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_SCROLLBACK,
  TERMINAL_EVENTS,
  TERMINAL_THEME
} from '@plugins/terminal/shared'
import type { TerminalAttachResult, TerminalRenderSettings } from '@plugins/terminal/shared'

const api = window.browserAPI

const host = ref<HTMLElement | null>(null)
const status = ref<'connecting' | 'ready' | 'error'>('connecting')
const message = ref('')

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let tabId: number | null = null
let unsubs: Array<() => void> = []
let observer: ResizeObserver | null = null
let sizeTimer: number | null = null
let alive = true

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return api.plugins.invoke<T>('terminal', method, ...args)
}

function applyRender(render?: TerminalRenderSettings): void {
  if (!term || !render) return
  term.options.fontFamily = render.fontFamily || DEFAULT_FONT_FAMILY
  term.options.fontSize = render.fontSize || DEFAULT_FONT_SIZE
  term.options.scrollback = render.scrollback || DEFAULT_SCROLLBACK
}

function fail(text: string): void {
  status.value = 'error'
  message.value = text
}

/** 容器尺寸变化 → 重算 cols/rows → 告诉 shell(分屏切换、窗口缩放都会走到这里) */
function refit(): void {
  if (!term || !fitAddon || !alive) return
  try {
    fitAddon.fit()
  } catch {
    /* 容器还没有尺寸时 fit 会抛,忽略即可 */
  }
  if (sizeTimer != null) return
  sizeTimer = window.setTimeout(() => {
    sizeTimer = null
    if (tabId != null && term) void invoke('resize', tabId, term.cols, term.rows)
  }, 120)
}

/** xterm 的键盘钩子:只接管复制/粘贴,Ctrl+W / Ctrl+L 之类交给 shell(见 tabShortcuts 的放行) */
function onKey(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return true
  const mod = event.ctrlKey || event.metaKey
  if (!mod || !event.shiftKey) return true
  if (event.code === 'KeyC') {
    const selection = term?.getSelection() ?? ''
    if (selection) void api.writeClipboardText(selection)
    return false
  }
  if (event.code === 'KeyV') {
    void api.readClipboardText().then((text) => {
      if (text) term?.paste(text)
    })
    return false
  }
  return true
}

function subscribe(): void {
  unsubs.push(
    api.plugins.onEvent((payload) => {
      if (payload.id !== 'terminal') return
      const args = payload.args as Record<string, unknown> | undefined
      if (payload.event === TERMINAL_EVENTS.data) {
        if (args?.tabId === tabId && typeof args.chunk === 'string') term?.write(args.chunk)
        return
      }
      if (payload.event === TERMINAL_EVENTS.exit) {
        if (args?.tabId === tabId) fail(`shell 已退出(代码 ${String(args.code)})`)
        return
      }
      if (payload.event === TERMINAL_EVENTS.sessionClosed) {
        if (args?.tabId !== tabId) return
        fail(args.reason === 'plugin-disabled' ? '终端插件已被停用' : '会话已结束')
        return
      }
      if (payload.event === TERMINAL_EVENTS.settingsChanged) {
        applyRender(args as unknown as TerminalRenderSettings)
        refit()
      }
    })
  )
}

async function createTerminal(): Promise<void> {
  if (!host.value) return
  term = new Terminal({
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
    scrollback: DEFAULT_SCROLLBACK,
    theme: TERMINAL_THEME,
    cursorBlink: true,
    // 中文/日文宽字符的连字与图形不受干扰;关掉自定义字形缓存更省心
    customGlyphs: true,
    allowProposedApi: false
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(host.value)
  term.attachCustomKeyEventHandler(onKey)
  fitAddon.fit()
  term.onData((data) => {
    if (tabId != null) void invoke('write', tabId, data)
  })
  term.focus()
}

async function boot(): Promise<void> {
  status.value = 'connecting'
  message.value = ''
  if (!host.value) return

  const self = await api.getSelfTabId()
  if (typeof self !== 'number') {
    fail('无法确定当前标签页(内部页面的 tab:self 不可用)')
    return
  }
  tabId = self

  await createTerminal()
  subscribe()
  const result = await invoke<TerminalAttachResult>('attach', {
    tabId,
    cols: term?.cols ?? 80,
    rows: term?.rows ?? 24
  })
  if (!alive) return
  if (!result.ok) {
    fail(result.error ?? '无法启动终端')
    return
  }
  applyRender(result.render)
  refit()
  if (result.replay) term?.write(result.replay)
  status.value = 'ready'
  document.title = result.profileName ? `终端 — ${result.profileName}` : '终端'
  term?.focus()
  // 等字体真正就绪再量一次:等宽字体的第一帧测量在字体回退时可能偏
  void document.fonts?.ready.then(() => refit())
}

async function retry(): Promise<void> {
  if (tabId != null) await invoke('detach', tabId).catch(() => undefined)
  term?.dispose()
  term = null
  fitAddon = null
  status.value = 'connecting'
  await boot()
}

/** E2E / 调试用的把手(内部页面,无外部站点可访问此对象) */
function exposeDebugHandle(): void {
  ;(window as unknown as Record<string, unknown>).__bowTerminal = {
    get term() {
      return term
    },
    get tabId() {
      return tabId
    },
    get status() {
      return status.value
    },
    send: (data: string) => (tabId != null ? invoke('write', tabId, data) : Promise.resolve(false)),
    bufferText: (): string => {
      if (!term) return ''
      const buffer = term.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buffer.length; i++) {
        lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
      }
      return lines.join('\n')
    }
  }
}

onMounted(async () => {
  exposeDebugHandle()
  await boot()
  if (host.value) {
    observer = new ResizeObserver(() => refit())
    observer.observe(host.value)
  }
  window.addEventListener('resize', refit)
})

onBeforeUnmount(() => {
  alive = false
  unsubs.forEach((u) => u())
  unsubs = []
  window.removeEventListener('resize', refit)
  observer?.disconnect()
  observer = null
  if (sizeTimer != null) {
    clearTimeout(sizeTimer)
    sizeTimer = null
  }
  if (tabId != null) void invoke('detach', tabId).catch(() => undefined)
  delete (window as unknown as Record<string, unknown>).__bowTerminal
  term?.dispose()
  term = null
  fitAddon = null
})
</script>

<template>
  <div class="terminal-page">
    <div v-if="status !== 'ready'" class="terminal-notice" :class="status">
      <span class="terminal-notice-text">
        {{ status === 'connecting' ? '正在连接终端…' : message }}
      </span>
      <button v-if="status === 'error'" class="terminal-retry" @click="retry">重试</button>
    </div>
    <div ref="host" class="terminal-host"></div>
  </div>
</template>

<style scoped>
.terminal-page {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.terminal-host {
  flex: 1;
  min-height: 0;
  padding: 6px 4px 4px 8px;
}

.terminal-host :deep(.xterm) {
  height: 100%;
}

.terminal-notice {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  font-size: 12px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  color: var(--fg-dim);
}

.terminal-notice.error {
  color: var(--fg);
  background: color-mix(in srgb, var(--danger) 18%, var(--bg2));
}

.terminal-notice-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.terminal-retry {
  flex: none;
  padding: 3px 10px;
  border-radius: var(--radius);
  background: var(--bg3);
  color: var(--fg);
  font-size: 12px;
}

.terminal-retry:hover {
  background: color-mix(in srgb, var(--accent) 30%, var(--bg3));
}
</style>
