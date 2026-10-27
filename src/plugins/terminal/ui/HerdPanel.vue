<script setup lang="ts">
/**
 * 「牧群」面板(full 浮层):一张表看住全部终端会话 —— 谁在等用户、谁在跑、谁刚空下来。
 *
 * 数据只有一个来源:终端插件的台账(`listSessions` + `sessions-changed` 推送)。
 * 所以这里看到的与远程页 / MCP 工具看到的是**同一份**描述 —— 三个门脸、一份台账
 * (见 plans/2026-10-16-herder-remote 的防漂移点)。
 *
 * 为什么用 full 而不是 below-chrome:它是一张需要纵深的表;而且「点一行 = 跳进那个终端」
 * 本来就要把浮层关掉,锚定在按钮下方没有意义。
 *
 * 排序**不按开场顺序**,按注意力等级(`sortSessionsByAttention`):等用户的排最前 ——
 * 这是整个面板的意义所在,否则用户还得自己扫一遍。
 */
import { RButton } from '@ruinb0w/ui'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { AlertCircle, Boxes, RefreshCw, SquareTerminal, X } from '@lucide/vue'
import ModalShell from '@renderer/components/ModalShell.vue'
import { TERMINAL_EVENTS, attentionRank, formatAgo, lastActiveAt, shortPath, sortSessionsByAttention } from '../shared'
import type { SessionAgentState, SessionInfo } from '../shared'

// 浮层宿主会传 `payload` / `band-top`(见 OverlayApp);本面板不用它们,
// 不关掉继承就会以 DOM 属性落到 ModalShell 的根节点上
// (bookmarks / downloads 几个 full 浮层都这么做,保持一致)
defineOptions({ inheritAttrs: false })

const api = window.browserAPI

const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

const sessions = ref<SessionInfo[]>([])
const failed = ref(false)
const notice = ref('')
/** 相对时间需要一个会走的「现在」,否则面板开着不动时「最后活跃」会停在打开那一刻 */
const now = ref(Date.now())
let unsubscribe: (() => void) | null = null
let ticker: number | undefined
let noticeTimer: number | undefined

const rows = computed(() => sortSessionsByAttention(sessions.value))
const blockedCount = computed(() => sessions.value.filter((s) => s.agent?.state === 'blocked').length)

function requestClose(): void {
  emit('overlay-event', 'close-request')
}

function onShellEvent(event: string, args?: unknown): void {
  emit('overlay-event', event, args)
}

/** 一次性的提示条(操作失败时说人话,不用 window.alert —— 浮层里它会卡住整个视图) */
function flash(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 3000)
}

async function refresh(): Promise<void> {
  failed.value = false
  try {
    sessions.value = await api.plugins.invoke<SessionInfo[]>('terminal', 'listSessions')
  } catch {
    failed.value = true
  }
}

const STATE_LABEL: Record<string, string> = { working: '在跑', blocked: '等你', idle: '空闲' }

function stateLabel(agent: SessionAgentState | null): string {
  if (!agent) return '无代理'
  if (agent.state === 'idle' && agent.done) return '刚跑完'
  return STATE_LABEL[agent.state] ?? agent.state
}

function ago(info: SessionInfo): string {
  return formatAgo(now.value - lastActiveAt(info))
}

async function jump(info: SessionInfo): Promise<void> {
  try {
    const ok = await api.plugins.invoke<boolean>('terminal', 'focusSession', info.id)
    if (!ok) {
      flash(`标签 ${info.id} 已经不在了`)
      void refresh()
      return
    }
    requestClose()
  } catch {
    flash('跳转失败')
  }
}

async function kill(info: SessionInfo): Promise<void> {
  try {
    const ok = await api.plugins.invoke<boolean>('terminal', 'closeSession', info.id)
    if (!ok) flash(`标签 ${info.id} 已经不在了`)
  } catch {
    flash('关闭失败')
  }
}

/** 「新终端」:台账变化会经 sessions-changed 推回来,这里不用自己插行 */
async function createSession(): Promise<void> {
  try {
    const res = await api.plugins.invoke<{ ok: boolean; error?: string }>('terminal', 'createSession', {})
    if (!res?.ok) flash(res?.error ?? '开不了新终端')
    else requestClose()
  } catch {
    flash('开不了新终端')
  }
}

onMounted(() => {
  void refresh()
  unsubscribe = api.plugins.onEvent((ev) => {
    if (ev.id !== 'terminal' || ev.event !== TERMINAL_EVENTS.sessionsChanged) return
    sessions.value = (ev.args as SessionInfo[]) ?? []
    failed.value = false
  })
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 10_000)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  if (ticker !== undefined) window.clearInterval(ticker)
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <ModalShell @overlay-event="onShellEvent">
    <div class="herd-panel">
      <div class="herd-head">
        <Boxes :size="15" />
        <span class="herd-title">牧群</span>
        <span class="herd-sub">
          {{ sessions.length }} 个终端<template v-if="blockedCount > 0"> · {{ blockedCount }} 个在等你</template>
        </span>
        <button class="win-btn" title="刷新" @click="refresh"><RefreshCw :size="13" /></button>
        <button class="win-btn" title="关闭" @click="requestClose"><X :size="13" /></button>
      </div>

      <div v-if="notice" class="herd-notice"><AlertCircle :size="13" />{{ notice }}</div>

      <div class="herd-body">
        <div v-if="failed" class="herd-empty">
          读不到会话台账(终端插件可能被停用)。在 <code>bow://settings</code> 的「插件管理」里检查。
        </div>
        <div v-else-if="rows.length === 0" class="herd-empty">
          还没有终端会话。点右上角或工具栏的终端按钮开一个。
        </div>
        <ul v-else class="herd-list">
          <li
            v-for="info in rows"
            :key="info.id"
            class="herd-row"
            :class="[
              `rank-${attentionRank(info)}`,
              { waiting: info.agent?.state === 'blocked' }
            ]"
            :title="`${info.title}#${info.id} · ${info.cwd}`"
            @click="jump(info)"
          >
            <span class="herd-dot" :class="info.agent ? `dot-${info.agent.state}` : 'dot-none'" />
            <span class="herd-main">
              <span class="herd-name">{{ info.title }}</span>
              <span class="herd-state">{{ stateLabel(info.agent) }}</span>
              <!-- 等用户的那种:标题/正文是 pi 给的,就是「它在问什么」 -->
              <span v-if="info.agent?.title" class="herd-ask">{{ info.agent.title }}</span>
              <span v-else-if="info.agent?.text" class="herd-ask">{{ info.agent.text }}</span>
            </span>
            <span class="herd-cwd">{{ shortPath(info.cwd) }}</span>
            <span class="herd-meta">{{ info.cols }}×{{ info.rows }} · pid {{ info.pid }}</span>
            <span class="herd-ago">{{ ago(info) }}</span>
            <button class="win-btn herd-kill" title="结束会话并关闭终端" @click.stop="kill(info)">
              <X :size="13" />
            </button>
          </li>
        </ul>
      </div>

      <div class="herd-foot">
        <RButton size="small" @click="createSession"><SquareTerminal :size="13" /> 新终端</RButton>
        <span class="herd-hint">点一行 = 跳到那个终端</span>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.herd-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(860px, 92vw);
  max-height: 80vh;
  text-align: left;
}
.herd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--fg);
}
.herd-title {
  font-weight: 600;
}
.herd-sub {
  flex: 1;
  font-size: 12px;
  opacity: 0.6;
}
.herd-body {
  flex: 1;
  min-height: 120px;
  overflow-y: auto;
}
.herd-empty {
  padding: 28px 4px;
  font-size: 13px;
  opacity: 0.65;
}
.herd-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.herd-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.herd-row:hover {
  background: rgba(255, 255, 255, 0.06);
}
/* 等用户的排最前,并且给一条左边线 —— 排序 + 视觉双保险 */
.herd-row.waiting {
  background: rgba(74, 142, 247, 0.12);
  box-shadow: inset 2px 0 0 var(--accent);
}
.herd-dot {
  width: 8px;
  height: 8px;
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
.herd-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.herd-name {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.herd-state {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  flex: none;
}
.herd-ask {
  font-size: 12px;
  opacity: 0.75;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.herd-cwd {
  font-size: 12px;
  opacity: 0.7;
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: none;
}
.herd-meta,
.herd-ago {
  font-size: 11px;
  opacity: 0.5;
  flex: none;
  font-variant-numeric: tabular-nums;
}
.herd-ago {
  min-width: 52px;
  text-align: right;
}
.herd-kill {
  opacity: 0;
  flex: none;
}
.herd-row:hover .herd-kill {
  opacity: 0.7;
}
.herd-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(229, 83, 75, 0.16);
}
.herd-foot {
  display: flex;
  align-items: center;
  gap: 10px;
}
.herd-hint {
  font-size: 11px;
  opacity: 0.5;
}
code {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
