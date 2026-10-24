<script setup lang="ts">
/**
 * 远程页的对话视图(取代了原来的 xterm 镜像)。
 *
 * 为什么不再渲染终端:pi 的 TUI 是「光标移动 + 局部重绘」,`working` 动画每一帧都会
 * 留在字节流里;而宽度一变,pi 按新宽度重排、历史还是旧宽度画的 —— 手机上怎么渲染都是乱的。
 * 这里显示的是 pi 的消息对象(正文 / 工具单行),宽度只影响换行,不影响内容。
 *
 * 队列不自己造:忙的时候发出去的消息由 pi 自己排队(bow 侧用 `deliverAs:'followUp'`),
 * 这里只读「忙 / 有排队」两个状态。
 */
import { computed, nextTick, ref, watch } from 'vue'
import type { AskRequest, ChatMessage, ChatStatus, RemoteSocket } from './ws'

const props = defineProps<{
  sessionId: number
  title: string
  cwd: string
  messages: ChatMessage[]
  busy: boolean
  pending: number
  live: boolean
  asks: AskRequest[]
  /** pi 的状态栏数字(模型 / 上下文 / 输入输出);旧版扩展不发就是 null,整行不显示 */
  status: ChatStatus | null
  /** WS 是否连着(断线时给一条横幅,别让人以为发出去了) */
  connected: boolean
  /** 台账里这个会话有没有代理状态(有 = 终端里确有 pi,只是控制通道没连上) */
  hasAgent: boolean
  /** 上一次发送失败的原因(用来把草稿还回去) */
  lastError: string
  /** 失败的时刻:同一个原因重复出现时也要触发 watch */
  errorAt: number
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'send', payload: { text: string; deliverAs?: 'steer' | 'followUp' }): void
  (e: 'abort'): void
  (e: 'answer', payload: { requestId: string; value: boolean | string }): void
}>()

const draft = ref('')
const expanded = ref<Set<string>>(new Set())
const scroller = ref<HTMLElement | null>(null)
const nearBottom = ref(true)

/** 工具的展示行:名字 + 参数摘要;点开看完整参数/结果 */
function toolLine(msg: ChatMessage): string {
  const args = (msg.toolArgs ?? '').replace(/\s+/g, ' ').slice(0, 70)
  const name = msg.toolName || 'tool'
  return args ? `${name}(${args})` : name
}

function toolOpen(msg: ChatMessage): boolean {
  return expanded.value.has(msg.id)
}

function toggleTool(msg: ChatMessage): void {
  const next = new Set(expanded.value)
  if (next.has(msg.id)) next.delete(msg.id)
  else next.add(msg.id)
  expanded.value = next
}

/** 键盘弹出后:输入框进视野 + 列表回底(等动画结束再动,不然算出的是旧高度) */
function onFocus(): void {
  window.setTimeout(() => {
    const el = document.activeElement as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
    scrollToBottom(true)
  }, 320)
}

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  nearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function scrollToBottom(force = false): void {
  const el = scroller.value
  if (!el) return
  if (!force && !nearBottom.value) return
  el.scrollTop = el.scrollHeight
  nearBottom.value = true
}

// 新消息只在「本来就在底部」时拽视口:翻历史时新输出不该把眼睛带走
watch(
  () => props.messages.length,
  () => void nextTick(() => scrollToBottom())
)
watch(
  () => props.sessionId,
  () => {
    expanded.value = new Set()
    void nextTick(() => scrollToBottom(true))
  }
)

const lastSent = ref('')

function send(): void {
  const text = draft.value.trim()
  if (!text) return
  lastSent.value = text
  draft.value = ''
  emit('send', { text })
  void nextTick(() => scrollToBottom(true))
}

// 发失败了就把刚发的那句还回输入框(草稿不能凭空消失)
watch(
  () => props.errorAt,
  () => {
    if (!props.lastError || !lastSent.value) return
    if (!draft.value.trim()) draft.value = lastSent.value
    lastSent.value = ''
  }
)

/** 插话:agent 正在跑时立刻说(而不是等这一轮结束) */
function steer(): void {
  const text = draft.value.trim()
  if (!text) return
  draft.value = ''
  emit('send', { text, deliverAs: 'steer' })
  void nextTick(() => scrollToBottom(true))
}

/** 头部徽标文字(注意:不叫 `status` —— 那是状态栏 prop,别遮) */
const statusLabel = computed(() => {
  if (!props.live) return '没有控制通道'
  if (props.busy) return '在跑'
  return '空闲'
})

// ---------- 状态条:与 pi 桌面 footer 同一套数字和缩写(↑输入 ↓输出, R/W 缓存不上手机) ----------

/** 与 pi footer 的 `formatTokens` 同规则:手机上一行要放得下 */
function fmt(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

/** 上下文百分比;compact 刚做完时 pi 自己也不知道 token 数 → null(显示「?」而不是 0%) */
const ctxPercent = computed(() => {
  const s = props.status
  if (!s || !s.contextWindow || s.contextTokens === null) return null
  return Math.round((s.contextTokens / s.contextWindow) * 1000) / 10
})

const ctxText = computed(() => {
  const s = props.status
  if (!s) return ''
  const window = s.contextWindow ? `/${fmt(s.contextWindow)}` : ''
  return ctxPercent.value === null ? `?${window}` : `${ctxPercent.value.toFixed(1)}%${window}`
})

const ctxClass = computed(() => {
  const percent = ctxPercent.value
  if (percent === null) return ''
  if (percent > 90) return 'error'
  if (percent > 70) return 'warn'
  return ''
})

/**
 * 为什么没有控制通道 —— 两种原因能分开,就不用让人猜:
 * 台账里有代理状态 = 终端里的 pi 确实装了扩展(它同时在发 OSC 状态),那问题在控制通道本身;
 * 台账里也没有 = 这个终端里没检测到 pi,或者 pi 没装扩展。
 */
const deadReason = computed(() => {
  if (props.live) return ''
  if (props.hasAgent) {
    return 'pi 在跑,但手机没连上它的控制通道 —— 重开这个终端(让它拿到 BOW_* 变量),或在 pi 里 /reload 升级扩展。'
  }
  return '这个终端里没检测到 pi(或者 pi 没装扩展:设置页 → 终端 → Pi 联动 装一下)。'
})

// ---------- pi 的提问(手机也能答;终端里那个框同时还在,谁先答要谁) ----------

/** 每个输入型提问的草稿(requestId → 文本) */
const answerDraft = ref<Record<string, string>>({})

draftDefaults()
function draftDefaults(): void {
  for (const ask of props.asks) {
    if (answerDraft.value[ask.requestId] !== undefined) continue
    if (ask.kind === 'input' || ask.kind === 'editor') answerDraft.value[ask.requestId] = ask.prefill ?? ''
  }
}
watch(() => props.asks.map((a) => a.requestId).join(','), draftDefaults)

function answerText(ask: AskRequest): void {
  const text = (answerDraft.value[ask.requestId] ?? '').trim()
  if (!text) return
  emit('answer', { requestId: ask.requestId, value: text })
}

function answerChoice(ask: AskRequest, value: boolean | string): void {
  emit('answer', { requestId: ask.requestId, value })
}

/** 手机上不想答:卡片先收起来(pi 那边等终端;它自己被答掉时也会消失) */
const hiddenAsks = ref<Set<string>>(new Set())
function hideAsk(ask: AskRequest): void {
  const next = new Set(hiddenAsks.value)
  next.add(ask.requestId)
  hiddenAsks.value = next
}
const visibleAsks = computed(() => props.asks.filter((ask) => !hiddenAsks.value.has(ask.requestId)))
</script>

<template>
  <div class="chat">
    <header class="head">
      <button class="back" title="返回会话列表" @click="emit('back')">←</button>
      <span class="name">{{ title }}</span>
      <span v-if="cwd" class="cwd">{{ cwd }}</span>
      <span class="badge" :class="{ busy, dead: !live }">{{ statusLabel }}</span>
      <span v-if="pending > 0" class="badge queue">有排队</span>
      <button v-if="busy && live" class="stop" title="停止当前这一轮" @click="emit('abort')">停止</button>
    </header>

    <!-- pi 的状态栏:模型 · 输入输出 · 上下文(数字与桌面 footer 一致) -->
    <div v-if="status" class="stats" data-chat-stats>
      <span v-if="status.model" class="stat-model" data-chat-model>
        {{ status.model }}{{ status.thinking && status.thinking !== 'off' ? ` · ${status.thinking}` : '' }}
      </span>
      <span class="stat" data-chat-tokens>↑{{ fmt(status.input) }} ↓{{ fmt(status.output) }}</span>
      <span class="stat" :class="ctxClass" data-chat-ctx>{{ ctxText }}</span>
    </div>

    <p v-if="!connected" class="banner" data-chat-banner>连接断了,正在重连……(没接上的话,消息不会发出去)</p>

    <div ref="scroller" class="msgs" @scroll="onScroll">
      <p v-if="!live" class="hint" data-chat-hint>{{ deadReason }}</p>
      <p v-if="messages.length === 0" class="hint">还没有对话。下面输入第一句。</p>

      <template v-for="msg in messages" :key="msg.id">
        <div v-if="msg.role === 'user'" class="row me">
          <div class="bubble me">{{ msg.text }}</div>
        </div>

        <div v-else-if="msg.role === 'assistant'" class="row pi">
          <div class="bubble pi">{{ msg.text }}</div>
        </div>

        <div v-else-if="msg.role === 'notice'" class="row">
          <div class="notice">{{ msg.text }}</div>
        </div>

        <div v-else class="row">
          <button class="tool" :class="{ err: msg.toolError }" @click="toggleTool(msg)">
            <span class="caret">{{ toolOpen(msg) ? '▾' : '▸' }}</span>
            <span class="tool-name">{{ toolLine(msg) }}</span>
            <span v-if="msg.toolError" class="fail">失败</span>
          </button>
          <pre v-if="toolOpen(msg)" class="tool-body">{{ msg.toolArgs || '' }}{{ msg.toolResult ? `\n\n${msg.toolResult}` : '' }}</pre>
        </div>
      </template>
    </div>

    <!-- pi 在等回答:卡片贴在输入框上方(终端里那个框同时还在,谁先答要谁) -->
    <div v-if="visibleAsks.length" class="asks">
      <div v-for="ask in visibleAsks" :key="ask.requestId" class="ask" data-ask>
        <div class="ask-head">
          <span class="ask-kind">{{ ask.kind === 'confirm' ? '需要确认' : ask.kind === 'select' ? '请选择' : '需要输入' }}</span>
          <button class="ask-x" title="先不管(在电脑上答)" @click="hideAsk(ask)">×</button>
        </div>
        <div class="ask-title" data-ask-title>{{ ask.title }}</div>
        <div v-if="ask.message" class="ask-msg">{{ ask.message }}</div>

        <div v-if="ask.kind === 'confirm'" class="ask-actions">
          <button class="primary" data-ask-answer="yes" @click="answerChoice(ask, true)">允许</button>
          <button class="danger" data-ask-answer="no" @click="answerChoice(ask, false)">拒绝</button>
        </div>

        <div v-else-if="ask.kind === 'select'" class="ask-actions wrap">
          <button
            v-for="option in ask.options ?? []"
            :key="option"
            data-ask-answer="option"
            @click="answerChoice(ask, option)"
          >
            {{ option }}
          </button>
        </div>

        <template v-else>
          <textarea
            v-model="answerDraft[ask.requestId]"
            class="ask-input"
            :rows="ask.kind === 'editor' ? 4 : 1"
            :placeholder="ask.placeholder || (ask.kind === 'editor' ? '在这里写…' : '输入…')"
            @focus="onFocus"
            @keydown.enter.exact.prevent="answerText(ask)"
          />
          <div class="ask-actions">
            <button
              class="primary"
              data-ask-answer="text"
              :disabled="!(answerDraft[ask.requestId] ?? '').trim()"
              @click="answerText(ask)"
            >
              提交
            </button>
          </div>
        </template>
      </div>
    </div>

    <div class="composer">
      <textarea
        v-model="draft"
        rows="1"
        inputmode="text"
        placeholder="说点什么…"
        :disabled="!live"
        @focus="onFocus"
        @keydown.enter.exact.prevent="send"
      />
      <button class="primary" :disabled="!live || !draft.trim()" @click="send">发送</button>
      <button v-if="busy && live" class="ghost" :disabled="!draft.trim()" title="不等这一轮结束,立刻插话" @click="steer">
        插话
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid #33353f;
  background: #202127;
}
.back {
  min-width: 40px;
  padding: 0 10px;
}
.name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.cwd {
  font-size: 11px;
  color: var(--muted);
  font-family: var(--mono);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: none;
}
/* 贴着 header 的第二行:同一块底色,不另加分隔线 */
.stats {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 5px;
  background: #202127;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
}
.stat {
  flex: none;
}
.stat-model {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #c8ccd6;
}
.stat.warn {
  color: #e5c07b;
}
.stat.error {
  color: var(--danger);
}
.banner {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  color: #e5c07b;
  background: rgba(229, 192, 123, 0.12);
  border-bottom: 1px solid rgba(229, 192, 123, 0.3);
}
.badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--muted);
  flex: none;
}
.badge.busy {
  color: #9dc0ff;
  background: rgba(74, 142, 247, 0.16);
}
.badge.dead {
  color: var(--danger);
  background: rgba(229, 83, 75, 0.14);
}
.badge.queue {
  color: #e5c07b;
  background: rgba(229, 192, 123, 0.14);
}
.stop {
  flex: none;
  color: var(--danger);
  border-color: rgba(229, 83, 75, 0.5);
}

.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 12px 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  -webkit-overflow-scrolling: touch;
}
.hint {
  color: var(--muted);
  font-size: 13px;
  margin: 4px 2px;
  line-height: 1.5;
}
.row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.row.me {
  align-items: flex-end;
}
.bubble {
  max-width: 88%;
  padding: 8px 11px;
  border-radius: 12px;
  font-size: 15px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble.pi {
  background: #272932;
  border: 1px solid #33353f;
  border-bottom-left-radius: 4px;
}
.bubble.me {
  background: var(--accent);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.notice {
  font-size: 12px;
  color: var(--danger);
  background: rgba(229, 83, 75, 0.1);
  border-radius: 8px;
  padding: 6px 10px;
}
.tool {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 6px 10px;
  min-height: 34px;
  background: #1b1c21;
  border-color: #2f313a;
  border-radius: 8px;
  font-size: 12px;
  font-family: var(--mono);
  color: var(--muted);
  text-align: left;
}
.tool.err {
  color: #f0a8a3;
  border-color: rgba(229, 83, 75, 0.4);
}
.tool-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fail {
  color: var(--danger);
  flex: none;
}
.tool-body {
  margin: 6px 0 0;
  padding: 8px 10px;
  max-width: 100%;
  max-height: 260px;
  overflow: auto;
  background: #16171b;
  border: 1px solid #2b2d35;
  border-radius: 8px;
  font-family: var(--mono);
  font-size: 12px;
  color: #c8ccd6;
  white-space: pre-wrap;
  word-break: break-word;
}

:global(.kb-open) .composer {
  /* 键盘把 home indicator 那条安全区顶掉了,再加就是白留一截 */
  padding-bottom: 8px;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
  border-top: 1px solid #33353f;
  background: #202127;
}
textarea {
  flex: 1;
  font: inherit;
  /* ≥16px:否则 iOS 聚焦时会放大整个页面 */
  font-size: 16px;
  color: inherit;
  background: #16171b;
  border: 1px solid #383a44;
  border-radius: 10px;
  padding: 9px 11px;
  resize: none;
  max-height: 120px;
  line-height: 1.4;
}
.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
  flex: none;
}
.primary:disabled {
  opacity: 0.5;
}
.ghost {
  flex: none;
  color: #9dc0ff;
  border-color: rgba(74, 142, 247, 0.45);
}

/* pi 的提问卡片:贴在输入框上方,一眼能看见 */
.asks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid rgba(229, 192, 123, 0.35);
  background: rgba(229, 192, 123, 0.07);
}
.ask {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid rgba(229, 192, 123, 0.4);
  border-radius: 10px;
  background: #22232a;
}
.ask-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ask-kind {
  font-size: 11px;
  color: #e5c07b;
  letter-spacing: 0.04em;
}
.ask-x {
  min-height: 28px;
  min-width: 28px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
}
.ask-title {
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
.ask-msg {
  font-size: 13px;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow: auto;
}
.ask-actions {
  display: flex;
  gap: 8px;
}
.ask-actions.wrap {
  flex-wrap: wrap;
}
.ask-actions > button {
  flex: 1;
  min-width: 90px;
  min-height: 40px;
}
.ask-input {
  font: inherit;
  font-size: 16px;
  color: inherit;
  background: #16171b;
  border: 1px solid #383a44;
  border-radius: 8px;
  padding: 8px 10px;
  resize: none;
  max-height: 140px;
}
button.danger {
  color: var(--danger);
  border-color: rgba(229, 83, 75, 0.5);
}
</style>