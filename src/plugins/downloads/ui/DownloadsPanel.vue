<script setup lang="ts">
/**
 * 下载面板(全屏浮层):记录列表 + 行内操作(暂停/继续/取消/重新下载/打开/文件夹/删除)。
 *
 * 它只做两件事:调 `plugins.invoke('downloads', …)` 和渲染 ——
 * 「这条记录现在能做什么」由主进程侧的 `shared.actionsFor()` 决定(与 MCP 看到的是同一套判据)。
 */
import { computed, onBeforeUnmount, onMounted, ref, type Component } from 'vue'
import {
  Download,
  ExternalLink,
  FolderOpen,
  Link2,
  Pause,
  Play,
  RotateCw,
  Trash2,
  X
} from 'lucide-vue-next'
import ModalShell from '@renderer/components/ModalShell.vue'
import { formatHistoryTime } from '@shared/history'
import {
  DOWNLOADS_EVENT,
  DOWNLOAD_STATE_LABELS,
  actionsFor,
  etaSeconds,
  formatBytes,
  formatEta,
  formatProgressBytes,
  formatSpeed,
  isTerminal,
  percentOf,
  type DownloadAction,
  type DownloadActionResult,
  type DownloadRecord,
  type DownloadState,
  type DownloadsListResult
} from '../shared'

defineOptions({ inheritAttrs: false })

const api = window.browserAPI
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

const state = ref<DownloadsListResult | null>(null)
const error = ref('')
const notice = ref('')
const busy = ref('')
const clearConfirm = ref(false)
const unsubs: Array<() => void> = []
let timer: number | undefined
let noticeTimer: number | undefined

const ACTION_LABEL: Record<DownloadAction, string> = {
  pause: '暂停',
  resume: '继续',
  cancel: '取消',
  retry: '重新下载',
  open: '打开',
  showInFolder: '显示文件夹',
  copyUrl: '复制链接',
  remove: '删除记录'
}
const ACTION_ICON: Record<DownloadAction, Component> = {
  pause: Pause,
  resume: Play,
  cancel: X,
  retry: RotateCw,
  open: ExternalLink,
  showInFolder: FolderOpen,
  copyUrl: Link2,
  remove: Trash2
}

const records = computed<DownloadRecord[]>(() => state.value?.records ?? [])
const live = computed(() => new Set(state.value?.live ?? []))
const activeCount = computed(() => records.value.filter((r) => !isTerminal(r.state)).length)
const finishedCount = computed(() => records.value.filter((r) => isTerminal(r.state)).length)
const summary = computed(() => {
  if (records.value.length === 0) return ''
  return activeCount.value > 0 ? `${activeCount.value} 项未完成 · 共 ${records.value.length} 项` : `共 ${records.value.length} 项`
})

function actions(r: DownloadRecord): DownloadAction[] {
  return actionsFor(r, live.value.has(r.id))
}
function stateLabel(s: DownloadState): string {
  return DOWNLOAD_STATE_LABELS[s]
}
function eta(r: DownloadRecord): number | null {
  return etaSeconds(r)
}
function showBar(r: DownloadRecord): boolean {
  return !isTerminal(r.state)
}
function hostOf(r: DownloadRecord): string {
  try {
    return new URL(r.url).hostname
  } catch {
    return r.url.slice(0, 40)
  }
}

function requestClose(): void {
  emit('overlay-event', 'close-request')
}
function onShellEvent(event: string, args?: unknown): void {
  emit('overlay-event', event, args)
}

function flash(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 3000)
}

function stopPolling(): void {
  if (timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
  }
}
function syncPolling(): void {
  if (activeCount.value > 0 && timer === undefined) {
    timer = window.setInterval(() => void refresh(), 500)
  } else if (activeCount.value === 0) {
    stopPolling()
  }
}

async function refresh(): Promise<void> {
  try {
    state.value = await api.plugins.invoke<DownloadsListResult>('downloads', 'list')
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    stopPolling()
  }
  syncPolling()
}

async function run(action: DownloadAction, r: DownloadRecord): Promise<void> {
  if (action === 'copyUrl') {
    await api.writeClipboardText(r.url)
    flash('已复制下载链接')
    return
  }
  busy.value = `${r.id}:${action}`
  error.value = ''
  try {
    const res = await api.plugins.invoke<DownloadActionResult>('downloads', action, r.id)
    if (res && res.ok === false) {
      error.value = res.error ?? '操作失败'
    } else if (action === 'remove') {
      flash('已删除记录(文件不会被删除)')
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
    await refresh()
  }
}

async function clearFinished(): Promise<void> {
  if (!clearConfirm.value) {
    clearConfirm.value = true
    return
  }
  clearConfirm.value = false
  await api.plugins.invoke('downloads', 'clear', true)
  flash('已清空已完成记录(文件不会被删除)')
  await refresh()
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id === 'downloads' && ev.event === DOWNLOADS_EVENT.changed) void refresh()
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  stopPolling()
  if (noticeTimer) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <ModalShell @overlay-event="onShellEvent">
    <div class="dl-panel">
      <div class="dl-head">
        <Download :size="16" />
        <span class="dl-title">下载</span>
        <span v-if="summary" class="dl-summary">{{ summary }}</span>
        <span class="dl-spacer" />
        <template v-if="finishedCount > 0 && clearConfirm">
          <span class="dl-confirm">清空 {{ finishedCount }} 条已完成的记录?</span>
          <button class="btn danger" @click="clearFinished">确认</button>
          <button class="btn" @click="clearConfirm = false">取消</button>
        </template>
        <button v-else class="btn" :disabled="finishedCount === 0" @click="clearFinished">
          <Trash2 :size="13" />清空已完成
        </button>
        <button class="win-btn" title="关闭" @click="requestClose"><X :size="13" /></button>
      </div>

      <div v-if="error" class="dl-alert err">{{ error }}</div>
      <div v-else-if="notice" class="dl-alert">{{ notice }}</div>

      <div class="dl-list">
        <div v-if="records.length === 0" class="dl-empty">
          还没有下载记录。在页面里点下载链接,或让 AI 用 <code>browser_download</code> 下一个文件。
        </div>
        <template v-else>
          <div v-for="r in records" :key="r.id" class="dl-item">
            <div class="dl-line">
              <span class="dl-name" :title="r.savePath || r.filename">{{ r.filename }}</span>
              <span class="dl-state" :class="r.state">{{ stateLabel(r.state) }}</span>
              <span class="dl-pct">{{ percentOf(r) }}%</span>
              <span class="dl-spacer" />
              <span class="dl-time">{{ formatHistoryTime(r.endedAt ?? r.startedAt) }}</span>
            </div>

            <div v-if="showBar(r)" class="dl-bar">
              <div class="dl-bar-fill" :class="r.state" :style="{ width: `${percentOf(r)}%` }" />
            </div>

            <div class="dl-meta">
              <span class="dl-host">{{ hostOf(r) }}</span>
              <span v-if="showBar(r)">{{ formatProgressBytes(r) }}</span>
              <span v-else-if="r.totalBytes > 0">{{ formatBytes(r.totalBytes) }}</span>
              <span v-if="r.state === 'progressing'">{{ formatSpeed(r.bytesPerSecond) }}</span>
              <span v-if="r.state === 'progressing' && eta(r) !== null">剩 {{ formatEta(eta(r)) }}</span>
              <span v-if="r.state === 'completed' && r.fileExists === false" class="dl-warn">文件已不在</span>
              <span v-if="r.restarted" class="dl-warn">服务器不支持续传,已从头开始</span>
              <span v-if="r.error && r.state !== 'completed'" class="dl-warn">{{ r.error }}</span>
              <span v-if="r.savePath" class="dl-path" :title="r.savePath">{{ r.savePath }}</span>
            </div>

            <div class="dl-actions">
              <button
                v-for="a in actions(r)"
                :key="a"
                class="btn dl-act"
                :class="{ danger: a === 'cancel' || a === 'remove' }"
                :disabled="busy === `${r.id}:${a}`"
                :title="ACTION_LABEL[a]"
                @click="run(a, r)"
              >
                <component :is="ACTION_ICON[a]" :size="13" />
                <span>{{ ACTION_LABEL[a] }}</span>
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.dl-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(760px, 86vw);
  max-height: 78vh;
  min-height: 260px;
}
.dl-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dl-title {
  font-size: 14px;
  font-weight: 600;
}
.dl-summary {
  font-size: 11px;
  color: var(--fg-dim);
}
.dl-spacer {
  flex: 1;
}
.dl-confirm {
  font-size: 12px;
  color: var(--danger);
}
.dl-alert {
  font-size: 12px;
  color: var(--fg-dim);
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg3);
}
.dl-alert.err {
  color: var(--danger);
}
.dl-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.dl-empty {
  padding: 28px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--fg-dim);
}
.dl-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.dl-item:last-child {
  border-bottom: none;
}
.dl-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dl-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 52%;
}
.dl-state {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--fg-dim);
}
.dl-state.progressing {
  background: rgba(74, 142, 247, 0.22);
  color: #9dc4ff;
}
.dl-state.completed {
  background: rgba(60, 160, 90, 0.22);
  color: #9fe0ad;
}
.dl-state.cancelled,
.dl-state.interrupted {
  background: rgba(229, 83, 75, 0.2);
  color: #f0a9a5;
}
.dl-pct {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim);
}
.dl-time {
  flex: none;
  font-size: 11px;
  color: var(--fg-dim);
}
.dl-bar {
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.dl-bar-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s linear;
}
.dl-bar-fill.paused,
.dl-bar-fill.interrupted {
  background: var(--fg-dim);
}
.dl-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--fg-dim);
}
.dl-host {
  color: var(--fg);
  opacity: 0.75;
}
.dl-warn {
  color: var(--danger);
}
.dl-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.dl-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.dl-act {
  font-size: 11px;
  padding: 2px 8px;
}
</style>
