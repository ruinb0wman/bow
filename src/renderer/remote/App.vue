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
import { RModal } from '@ruinb0w/ui'
import { sortSessionsByAttention, formatAgo, lastActiveAt, shortPath } from '@plugins/terminal/shared'
import ChatView from './ChatView.vue'
import { DRAFTS_KEY, draftFor, parseDrafts, withDraft, withoutDraft } from './drafts'
import type { DraftStore } from './drafts'
import { connectRemote, wsUrlOf } from './ws'
import type { AskRequest, ChatCommand, ChatMessage, ChatStatus, RemoteSocket, ServerMessage, SessionInfo } from './ws'

const password = ref('')
const loginError = ref('')
const loggingIn = ref(false)
const authed = ref(false)

const sessions = ref<SessionInfo[]>([])
const state = ref<'connecting' | 'open' | 'closed' | 'refused'>('connecting')

/** 当前打开的会话(空 = 显示列表) */
const active = reactive<{ id: number | null; title: string; cwd: string }>({ id: null, title: '', cwd: '' })

// ---------- 新建:开一个 pi 到某个目录 ----------
// 收藏的目录存在**手机浏览器**的 localStorage 里(不占服务端):它就是「记几个常用项目路径」。
// shortcut: 只在这台手机的浏览器里,换端口/清站点数据会丢;要跳设备同步再挑到服务端设置。
const FAVS_KEY = 'bow.remote.favs'
const LAST_DIR_KEY = 'bow.remote.lastDir'
const MAX_FAVS = 20

function readStore(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式 / 配额满:收藏只是便利,存不上不能挡住新建 */
  }
}
function loadFavs(): string[] {
  try {
    const raw: unknown = JSON.parse(readStore(FAVS_KEY) || '[]')
    return Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, MAX_FAVS)
      : []
  } catch {
    return []
  }
}

const newOpen = ref(false)
const newPath = ref('')
const newError = ref('')
/** 这次 `created` 是手机自己发起的(才自动进对话页,别抢电脑上开出来的会话) */
let pendingCreate = false
const favs = ref<string[]>(loadFavs())

// ---------- 每个会话的未发送草稿 ----------
// 存在手机本地(`drafts.ts` 里有 cwd 守卫与上限):于是「切项目再回来字还在」与「切出去被杀页面也不丢」一并解决。
const drafts = ref<DraftStore>(loadDrafts())

function loadDrafts(): DraftStore {
  try {
    return parseDrafts(localStorage.getItem(DRAFTS_KEY))
  } catch {
    return {}
  }
}

let draftTimer: number | undefined

function flushDrafts(): void {
  if (draftTimer !== undefined) {
    window.clearTimeout(draftTimer)
    draftTimer = undefined
  }
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts.value))
  } catch {
    /* 隐私模式 / 配额满:草稿只是便利,存不上不能挡住打字 */
  }
}

/** 打字时别每键都序列化:攒 300ms 再写(切后台/关页面由 `flushDrafts` 兜住) */
function saveDrafts(): void {
  if (draftTimer !== undefined) return
  draftTimer = window.setTimeout(flushDrafts, 300)
}

function flushOnHide(): void {
  if (document.visibilityState === 'hidden') flushDrafts()
}

/** 对话快照(服务端缓存的那份镜像;手机不存历史) */
const chat = reactive<{
  messages: ChatMessage[]
  busy: boolean
  pending: number
  live: boolean
  asks: AskRequest[]
  commands: ChatCommand[]
  status: ChatStatus | null
}>({
  messages: [],
  busy: false,
  pending: 0,
  live: false,
  asks: [],
  commands: [],
  status: null
})
const chatError = reactive<{ text: string; at: number }>({ text: '', at: 0 })

let socket: RemoteSocket | null = null
let now = ref(Date.now())
let ticker: number | undefined

const rows = computed(() => sortSessionsByAttention(sessions.value))
/** 当前会话在台账里的样子(cwd / 有没有代理状态):列表刷新时跟着更新 */
const activeInfo = computed(() => sessions.value.find((s) => s.id === active.id) ?? null)
const activeSession = computed(() => sessions.value.find((s) => s.id === active.id) ?? null)

/** 当前会话的草稿:cwd 变了就当没有(bow 重启后 tabId 会复用,不认这一条就会串项目) */
const chatDraft = computed(() =>
  active.id === null ? '' : (draftFor(drafts.value, active.id, activeInfo.value?.cwd ?? active.cwd)?.text ?? '')
)

function updateDraft(text: string): void {
  if (active.id === null) return
  drafts.value = withDraft(drafts.value, active.id, activeInfo.value?.cwd ?? active.cwd, text)
  saveDrafts()
}

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
    case 'sessions': {
      // 收得到 hello 就说明 cookie 还有效(服务端会拒掉没登录的握手)—— 刷新页面不该再问一次口令
      authed.value = true
      sessions.value = msg.sessions
      // 当前会话被别人关掉了:退回列表
      if (active.id != null && !msg.sessions.some((s) => s.id === active.id)) {
        active.id = null
      }
      // 会话没了 = 它的草稿也没人要了(否则本地越攒越多,上限也就白设了)
      const live = new Set(msg.sessions.map((s) => s.id))
      for (const key of Object.keys(drafts.value)) {
        if (!live.has(Number(key))) drafts.value = withoutDraft(drafts.value, Number(key))
      }
      break
    }
    case 'chat':
      if (msg.id !== active.id) break
      chat.messages = msg.messages
      chat.busy = msg.busy
      chat.pending = msg.pending
      chat.live = msg.live
      chat.asks = msg.asks ?? []
      chat.commands = msg.commands ?? []
      chat.status = msg.status ?? null
      chatError.text = ''
      break
    case 'chat-status':
      if (msg.id !== active.id) break
      chat.status = msg.status
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
    case 'created':
      // 只接管手机自己开的那个:电脑上开出来的会话不该把手机顶进对话页
      if (!pendingCreate) break
      pendingCreate = false
      writeStore(LAST_DIR_KEY, newPath.value.trim())
      newOpen.value = false
      attach(msg.id, newPath.value.trim())
      break
    case 'exit':
      if (msg.id === active.id) chat.live = false
      break
    case 'closed':
      if (msg.id === active.id) active.id = null
      break
    case 'error':
      if (!authed.value) loginError.value = msg.message
      else if (pendingCreate) {
        // 目录不存在这类错要停在新建面板里说,别甩到对话页(那里根本没有会话)
        pendingCreate = false
        newError.value = msg.message
      } else {
        // `at` 每次变:同一条错误重复出现时,页面那侧的 watch 仍然会触发(草稿要还回去)
        chatError.text = msg.message
        chatError.at = Date.now()
      }
      break
    default:
      break
  }
}

// ---------- 新建面板 ----------

/** 现有会话的工作目录去重 = 「最近」,不用另存一份历史 */
const recentDirs = computed(() => {
  const seen = new Set(favs.value)
  const out: string[] = []
  for (const info of sessions.value) {
    const dir = info.cwd?.trim()
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out.slice(0, 6)
})
const isFav = computed(() => favs.value.includes(newPath.value.trim()))

function openNew(): void {
  newPath.value =
    readStore(LAST_DIR_KEY) || sessions.value.find((info) => info.cwd?.trim())?.cwd || ''
  newError.value = ''
  pendingCreate = false
  newOpen.value = true
}

function toggleFav(): void {
  const dir = newPath.value.trim()
  if (!dir) return
  favs.value = favs.value.includes(dir)
    ? favs.value.filter((f) => f !== dir)
    : [...favs.value, dir].slice(-MAX_FAVS)
  writeStore(FAVS_KEY, JSON.stringify(favs.value))
}

function removeFav(dir: string): void {
  favs.value = favs.value.filter((f) => f !== dir)
  writeStore(FAVS_KEY, JSON.stringify(favs.value))
}

/** 开一个 pi 在指定目录(留空 = 主目录)。**不带 `command` 的 create 主进程会忽略 cwd**,所以这里只有这一种 */
function createPi(): void {
  const cwd = newPath.value.trim()
  const frame = { t: 'create', command: 'pi', ...(cwd ? { cwd } : {}) }
  note(frame)
  socket?.send(frame as never)
  pendingCreate = true
  newError.value = ''
}

/** 拉一次对话快照(打开的会话 / 重连后 / 刚切过来) */
function requestChat(id: number): void {
  chat.messages = []
  chat.busy = false
  chat.pending = 0
  chat.live = false
  chat.asks = []
  chat.commands = []
  chat.status = null
  chatError.text = ''
  socket?.send({ t: 'chat', id })
}

function attach(id: number, fallbackCwd = ''): void {
  const info = sessions.value.find((s) => s.id === id)
  active.id = id
  active.title = info?.title ?? ''
  active.cwd = info?.cwd ?? fallbackCwd
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

/** 关掉这个 pi(帧是现成的:与桌面标签上的 × 同义,pty 一起收 → 服务端回 `closed` → 回列表) */
function closePi(): void {
  if (active.id == null) return
  const frame = { t: 'close', id: active.id }
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
  // 手机上不一定有「关页面」:切后台就可能再也回不来,所以两个时机都存一次
  window.addEventListener('pagehide', flushDrafts)
  document.addEventListener('visibilitychange', flushOnHide)
})

onBeforeUnmount(() => {
  if (ticker !== undefined) window.clearInterval(ticker)
  window.removeEventListener('pagehide', flushDrafts)
  document.removeEventListener('visibilitychange', flushOnHide)
  flushDrafts()
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
      <p v-if="chatError.text" class="err-bar" @click="chatError.text = ''">{{ chatError.text }}</p>
      <ChatView
        :key="active.id"
        :session-id="active.id"
        :title="active.title"
        :cwd="activeInfo?.cwd ?? active.cwd"
        :messages="chat.messages"
        :busy="chat.busy"
        :pending="chat.pending"
        :live="chat.live"
        :asks="chat.asks"
        :commands="chat.commands"
        :status="chat.status"
        :connected="state === 'open'"
        :has-agent="activeInfo?.agent != null"
        :last-error="chatError.text"
        :error-at="chatError.at"
        :draft="chatDraft"
        @back="back"
        @send="send"
        @abort="abort"
        @answer="answer"
        @update:draft="updateDraft"
        @close="closePi"
      />
    </div>

    <!-- 会话列表 -->
    <div v-else class="list">
      <header class="list-head">
        <span class="brand">bow · 会话</span>
        <span class="count">{{ sessions.length }} 个会话</span>
        <span class="conn" :class="state">{{ state === 'open' ? '已连接' : state === 'connecting' ? '连接中…' : '已断开' }}</span>
        <button class="new" data-new-open title="新建 pi" @click="openNew">＋</button>
      </header>

      <div v-if="sessions.length === 0" class="empty">
        <p>还没有终端会话。</p>
        <p>在电脑上开一个终端并在里面跑 <code>pi</code>,它就会出现在这里。</p>
        <button class="primary" data-new-empty @click="openNew">新建 pi</button>
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

      <!-- 新建:只选目录。面板壳交给库的 RModal(滚动锁 / 安全区 / 遮罩点击关闭 / 拖动条都是白送的) -->
      <RModal :visible="newOpen" direction="bottom" title="新建到目录" max-height="70vh" @close="newOpen = false">
        <div class="new-sheet" data-new-sheet>
          <div class="path-row">
            <input
              v-model="newPath"
              class="new-path"
              data-new-path
              type="text"
              inputmode="text"
              autocomplete="off"
              placeholder="留空 = 主目录"
            />
            <button class="star" :class="{ on: isFav }" data-new-fav :disabled="!newPath.trim()" @click="toggleFav">
              {{ isFav ? '★' : '☆' }}
            </button>
          </div>

          <!-- 收藏一个一行、占满整宽:路径不再缩写(一行放不下就换行) -->
          <div v-if="favs.length" class="favs">
            <span class="chips-label">收藏</span>
            <button
              v-for="dir in favs"
              :key="dir"
              class="fav-row"
              :class="{ on: newPath.trim() === dir }"
              data-new-chip
              @click="newPath = dir"
            >
              <span class="fav-path">{{ dir }}</span>
              <span class="chip-x" data-new-unfav @click.stop="removeFav(dir)">×</span>
            </button>
          </div>
          <div v-if="recentDirs.length" class="chips">
            <span class="chips-label">最近</span>
            <button v-for="dir in recentDirs" :key="dir" class="chip" @click="newPath = dir">
              {{ shortPath(dir, 24) }}
            </button>
          </div>

          <div class="acts">
            <button class="primary" data-new-pi :disabled="state !== 'open'" @click="createPi">新建 pi</button>
          </div>
          <p v-if="newError" class="err" data-new-error>{{ newError }}</p>
        </div>
      </RModal>
    </div>
  </div>
</template>

<style scoped>
.app {
  /* 扣掉软键盘占的高度(--kb-inset 由 keyboardInset.ts 写入,**键盘没开时就是 0**;iOS 上 `resizes-content` 不生效) */
  height: calc(100% - var(--kb-inset, 0px));
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
.new {
  min-width: 40px;
  padding: 0 10px;
  font-size: 16px;
}

/* 新建面板的内容:壳(背景/圆角/padding/最大高度/滚动)已经由 RModal 提供 */
.new-sheet {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.path-row {
  display: flex;
  gap: 8px;
}
.new-path {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 16px;
}
.star {
  flex: none;
  min-width: 44px;
  padding: 0 10px;
  font-size: 16px;
  color: var(--muted);
}
.star.on {
  color: #e8c14a;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
/* 收藏:一条一行、整宽 */
.favs {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fav-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 6px 10px;
  font-family: var(--mono);
  font-size: 12px;
  text-align: left;
}
.fav-row.on {
  border-color: var(--accent);
}
.fav-path {
  flex: 1;
  min-width: 0;
  /* 整行给够了宽度,就别再缩写:长路径换行显示 */
  word-break: break-all;
}
.chips-label {
  flex: none;
  font-size: 11px;
  color: var(--muted);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 4px 10px;
  font-family: var(--mono);
  font-size: 12px;
}
.chip-x {
  flex: none;
  color: var(--muted);
  padding: 0 6px;
  font-size: 16px;
}
.acts {
  display: flex;
  gap: 8px;
}
.acts button {
  flex: 1;
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
