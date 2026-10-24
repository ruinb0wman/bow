<script setup lang="ts">
/**
 * 远程页:登录 → 会话列表 → 对话。
 *
 * 这一层只做四件事:登录拿 cookie、连 WS、把消息分派给列表或对话、发话/停止。
 * 手机不再渲染 xterm(原因见 `ChatView.vue` 的头注释):读写都走 pi 的结构化接口,
 * 对话快照缓存在服务端,所以切会话/断线重连都不用手机自己存历史。
 * 会话排序复用主进程那套「注意力等级」(`sortSessionsByAttention`)—— 与牧群面板同一份逻辑。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { sortSessionsByAttention, formatAgo, lastActiveAt, shortPath } from '@plugins/terminal/shared'
import ChatView from './ChatView.vue'
import { connectRemote, wsUrlOf } from './ws'
import type { AskRequest, ChatMessage, RemoteSocket, ServerMessage, SessionInfo } from './ws'

const password = ref('')
const loginError = ref('')
const loggingIn = ref(false)
const authed = ref(false)

const sessions = ref<SessionInfo[]>([])
const state = ref<'connecting' | 'open' | 'closed' | 'refused'>('connecting')

/** 当前打开的会话(空 = 显示列表) */
const active = reactive<{ id: number | null; title: string }>({ id: null, title: '' })

/** 对话快照(服务端缓存的那份镜像;手机不存历史) */
const chat = reactive<{ messages: ChatMessage[]; busy: boolean; pending: number; live: boolean; asks: AskRequest[] }>({
  messages: [],
  busy: false,
  pending: 0,
  live: false,
  asks: []
})
const chatError = ref('')

let socket: RemoteSocket | null = null
let now = ref(Date.now())
let ticker: number | undefined

const rows = computed(() => sortSessionsByAttention(sessions.value))
const activeSession = computed(() => sessions.value.find((s) => s.id === active.id) ?? null)

const STATE_LABEL: Record<string, string> = { working: '在跑', blocked: '等你', idle: '空闲' }
function stateLabel(info: SessionInfo): string {
  if (!info.agent) return '无代理'
  if (info.agent.state === 'idle' && info.agent.done) return '刚跑完'
  return STATE_LABEL[info.agent.state] ?? info.agent.state
}
function ago(info: SessionInfo): string {
  return formatAgo(now.value - lastActiveAt(info))
}

async function login(): Promise<void> {
  loggingIn.value = true
  loginError.value = ''
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value })
    })
    if (res.status === 204) {
      authed.value = true
      password.value = ''
      connect()
      return
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    loginError.value =
      res.status === 429 ? '尝试太频繁,请稍后再试' : body.error ?? '登录失败'
  } catch {
    loginError.value = '连不上 bow(它还在跑吗?)'
  } finally {
    loggingIn.value = false
  }
}

function connect(): void {
  socket?.close()
  socket = connectRemote(wsUrlOf(window.location), {
    onState(next) {
      state.value = next
      // 重连成功后重新拉一次快照(服务端有缓存,不用手机自己存)
      if (next === 'open' && active.id != null) requestChat(active.id)
    },
    onMessage(msg) {
      handle(msg)
    }
  })
}

function handle(msg: ServerMessage): void {
  switch (msg.t) {
    case 'hello':
    case 'sessions':
      sessions.value = msg.sessions
      // 当前会话被别人关掉了:退回列表
      if (active.id != null && !msg.sessions.some((s) => s.id === active.id)) {
        active.id = null
      }
      break
    case 'chat':
      if (msg.id !== active.id) break
      chat.messages = msg.messages
      chat.busy = msg.busy
      chat.pending = msg.pending
      chat.live = msg.live
      chat.asks = msg.asks ?? []
      chatError.value = ''
      break
    case 'ask':
      if (msg.id !== active.id) break
      if (!chat.asks.some((ask) => ask.requestId === msg.ask.requestId)) chat.asks.push(msg.ask)
      break
    case 'ask-done':
      if (msg.id !== active.id) break
      chat.asks = chat.asks.filter((ask) => ask.requestId !== msg.requestId)
      break
    case 'chat-message':
      if (msg.id !== active.id) break
      {
        // 同一条工具调用会被「调用 + 结果」更新两次:按 id 就地替换
        const index = chat.messages.findIndex((m) => m.id === msg.message.id && m.role === msg.message.role)
        if (index >= 0) chat.messages.splice(index, 1, msg.message)
        else chat.messages.push(msg.message)
      }
      break
    case 'chat-state':
      if (msg.id !== active.id) break
      chat.busy = msg.busy
      chat.pending = msg.pending
      chat.live = msg.live
      break
    case 'exit':
      if (msg.id === active.id) chat.live = false
      break
    case 'closed':
      if (msg.id === active.id) active.id = null
      break
    case 'error':
      if (!authed.value) loginError.value = msg.message
      else chatError.value = msg.message
      break
    default:
      break
  }
}

/** 拉一次对话快照(打开的会话 / 重连后 / 刚切过来) */
function requestChat(id: number): void {
  chat.messages = []
  chat.busy = false
  chat.pending = 0
  chat.live = false
  chat.asks = []
  chatError.value = ''
  socket?.send({ t: 'chat', id })
}

function attach(id: number): void {
  const info = sessions.value.find((s) => s.id === id)
  active.id = id
  active.title = info?.title ?? ''
  requestChat(id)
}

function open(info: SessionInfo): void {
  attach(info.id)
}

function back(): void {
  active.id = null
}

function note(payload: Record<string, unknown>): void {
  const seam = (window as unknown as { __bowRemote?: { sent: Array<Record<string, unknown>> } }).__bowRemote
  seam?.sent.push(payload)
}

function send(payload: { text: string; deliverAs?: 'steer' | 'followUp' }): void {
  if (active.id == null) return
  const frame = { t: 'prompt', id: active.id, ...payload }
  note(frame)
  socket?.send(frame as never)
}

function abort(): void {
  if (active.id == null) return
  const frame = { t: 'abort', id: active.id }
  note(frame)
  socket?.send(frame as never)
}

/** 回答 pi 的提问(终端里那个框会跟着关掉) */
function answer(payload: { requestId: string; value: boolean | string }): void {
  if (active.id == null) return
  const frame = { t: 'answer', id: active.id, ...payload }
  note(frame)
  socket?.send(frame as never)
  // 本地先收卡片:点了就该立刻有反馈,不等服务端回执(echo 的 ask-done 是幂等的)
  chat.asks = chat.asks.filter((ask) => ask.requestId !== payload.requestId)
}

/**
 * 测试缝(与 `window.__bowRemoteTerm` 同一套路):e2e 直接喂一条服务端消息,
 * 并检查页面发出的帧 —— 手机上那些卡片只有真 DOM 才验得到。
 */
function installTestSeam(): void {
  const seam = {
    handle,
    chat,
    sent: [] as Array<Record<string, unknown>>
  }
  ;(window as unknown as Record<string, unknown>).__bowRemote = seam
}

onMounted(() => {
  installTestSeam()
  // 已经有 cookie(上次登录过)就直接连;握手失败会落到 refused,那时显示登录框
  connect()
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 10_000)
})

onBeforeUnmount(() => {
  if (ticker !== undefined) window.clearInterval(ticker)
  socket?.close()
})

// 握手被拒(没登录/口令过期)= 回到登录框
const needsLogin = computed(() => !authed.value || state.value === 'refused')
</script>

<template>
  <div class="app">
    <!-- 登录 -->
    <div v-if="needsLogin" class="login">
      <div class="login-box">
        <h1>bow</h1>
        <p class="hint">输入 bow 设置页里「远程控制」显示的口令</p>
        <form @submit.prevent="login">
          <input
            v-model="password"
            type="password"
            inputmode="text"
            autocomplete="current-password"
            placeholder="口令"
            autofocus
          />
          <button class="primary" type="submit" :disabled="loggingIn || !password">
            {{ loggingIn ? '登录中…' : '登录' }}
          </button>
        </form>
        <p v-if="loginError" class="err">{{ loginError }}</p>
        <p class="tiny">
          {{ state === 'connecting' ? '正在连接…' : state === 'refused' ? '未登录或服务已关闭' : '' }}
        </p>
      </div>
    </div>

    <!-- 对话 -->
    <div v-else-if="active.id != null" class="chat-wrap">
      <p v-if="chatError" class="err-bar" @click="chatError = ''">{{ chatError }}</p>
      <ChatView
        :key="active.id"
        :session-id="active.id"
        :title="active.title"
        :messages="chat.messages"
        :busy="chat.busy"
        :pending="chat.pending"
        :live="chat.live"
        :asks="chat.asks"
        @back="back"
        @send="send"
        @abort="abort"
        @answer="answer"
      />
    </div>

    <!-- 会话列表 -->
    <div v-else class="list">
      <header class="list-head">
        <span class="brand">bow · 会话</span>
        <span class="count">{{ sessions.length }} 个会话</span>
        <span class="conn" :class="state">{{ state === 'open' ? '已连接' : state === 'connecting' ? '连接中…' : '已断开' }}</span>
      </header>

      <div v-if="sessions.length === 0" class="empty">
        <p>还没有终端会话。</p>
        <p>在电脑上开一个终端并在里面跑 <code>pi</code>,它就会出现在这里。</p>
      </div>

      <ul v-else class="rows">
        <li
          v-for="info in rows"
          :key="info.id"
          class="row"
          :class="{ waiting: info.agent?.state === 'blocked' }"
          @click="open(info)"
        >
          <span class="dot" :class="info.agent ? `dot-${info.agent.state}` : 'dot-none'" />
          <span class="main">
            <span class="name">{{ info.title }}</span>
            <span class="badge">{{ stateLabel(info) }}</span>
            <span v-if="info.agent?.title" class="ask">{{ info.agent.title }}</span>
            <span v-else-if="info.agent?.text" class="ask">{{ info.agent.text }}</span>
          </span>
          <span class="cwd">{{ shortPath(info.cwd, 22) }}</span>
          <span class="ago">{{ ago(info) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.err-bar {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  color: #f0a8a3;
  background: rgba(229, 83, 75, 0.12);
  border-bottom: 1px solid rgba(229, 83, 75, 0.3);
}
.chat-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 登录 */
.login {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 20px;
}
.login-box {
  width: min(340px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
h1 {
  font-size: 20px;
  margin: 0;
}
.hint {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}
.primary:disabled {
  opacity: 0.5;
}
.err {
  color: var(--danger);
  font-size: 13px;
  margin: 0;
}
.tiny {
  color: var(--muted);
  font-size: 12px;
  margin: 0;
  min-height: 16px;
}

/* 列表 */
.list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.list-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid #33353f;
  background: #202127;
}
.brand {
  font-weight: 600;
}
.count,
.conn {
  font-size: 12px;
  color: var(--muted);
}
.conn {
  margin-left: auto;
}
.conn.open {
  color: var(--ok);
}
.conn.refused,
.conn.closed {
  color: var(--danger);
}
.empty {
  padding: 28px 16px;
  color: var(--muted);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: flex-start;
}
.empty p {
  margin: 0;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid #2b2d35;
  font-size: 14px;
}
.row:active {
  background: #2a2c34;
}
.row.waiting {
  background: rgba(74, 142, 247, 0.12);
  box-shadow: inset 3px 0 0 var(--accent);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
  background: #6b7280;
}
.dot-working {
  background: #4a8ef7;
  box-shadow: 0 0 0 3px rgba(74, 142, 247, 0.2);
}
.dot-blocked {
  background: #e5534b;
  box-shadow: 0 0 0 3px rgba(229, 83, 75, 0.22);
}
.dot-idle {
  background: #7ec96a;
}
.main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  flex: none;
}
.ask {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cwd,
.ago {
  font-size: 11px;
  color: var(--muted);
  flex: none;
}
.cwd {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
