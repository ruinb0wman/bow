<script setup lang="ts">
/**
 * 夸克网盘面板(全屏浮层)。
 *
 * 流程:读页面文件列表 → 勾选 → 推送到 aria2 RPC。
 * 下载进度不在本插件里维护 —— 下载由 aria2 自己管,这里只负责把直链与请求头递过去。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Cloud, RefreshCw, Send } from 'lucide-vue-next'
import ModalShell from '@renderer/components/ModalShell.vue'
import { formatBytes, type QuarkDiagnostics, type QuarkFile } from '../shared'

defineOptions({ inheritAttrs: false })

const api = window.browserAPI
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

interface ListFilesResult {
  ok: boolean
  error?: string
  url?: string
  folderName?: string
  files?: QuarkFile[]
  selected?: string[]
  diagnostics?: QuarkDiagnostics
}
interface Aria2Result {
  ok: boolean
  error?: string
  raw?: string
  hosts?: Array<{ host: string; count: number }>
  results?: Array<{ fid: string; name: string; ok: boolean; error?: string }>
}

const loading = ref(false)
const busy = ref('')
const error = ref('')
const rawResponse = ref('')
const notice = ref('')
const list = ref<ListFilesResult | null>(null)
const checked = ref<Set<string>>(new Set())
/** 设置里的 Cookie 白名单(诊断区展示用) */
const cookieHosts = ref<string[]>([])
/** 最近一次取到的直链域名聚合 */
const lastHosts = ref<Array<{ host: string; count: number }>>([])
const showDiag = ref(false)
let noticeTimer: number | undefined

const files = computed<QuarkFile[]>(() => (list.value?.files ?? []).filter((f) => f.isFile))
const chosen = computed<QuarkFile[]>(() => files.value.filter((f) => checked.value.has(f.fid)))
const allChecked = computed(() => files.value.length > 0 && chosen.value.length === files.value.length)

function flash(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 2400)
}

function fail(message: string, raw?: string): void {
  error.value = message
  rawResponse.value = raw ?? ''
}

function toggle(fid: string): void {
  const next = new Set(checked.value)
  if (next.has(fid)) next.delete(fid)
  else next.add(fid)
  checked.value = next
}

function toggleAll(): void {
  checked.value = allChecked.value ? new Set() : new Set(files.value.map((f) => f.fid))
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  rawResponse.value = ''
  try {
    const res = await api.plugins.invoke<ListFilesResult>('quark', 'listFiles')
    list.value = res
    if (!res.ok) {
      fail(res.error ?? '读取文件列表失败')
      return
    }
    // 预勾选页面里已经选中的文件;没选中任何文件时不自动全选(避免误推整个目录)
    const pageSelected = new Set((res.selected ?? []).filter((fid) => files.value.some((f) => f.fid === fid)))
    checked.value = pageSelected.size > 0 ? pageSelected : new Set()
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}

async function pushAria2(): Promise<void> {
  const target = chosen.value
  if (target.length === 0) return flash('先勾选文件')
  busy.value = 'aria2rpc'
  error.value = ''
  rawResponse.value = ''
  try {
    const res = await api.plugins.invoke<Aria2Result>('quark', 'pushAria2', { fids: target.map((f) => f.fid) })
    if (res.hosts) lastHosts.value = res.hosts
    if (res.error) return fail(res.error, res.raw)
    const ok = (res.results ?? []).filter((r) => r.ok).length
    const failed = (res.results ?? []).filter((r) => !r.ok)
    if (ok > 0) flash(`已推送 ${ok} 个到 aria2`)
    if (failed.length > 0) fail(failed.map((f) => `${f.name}:${f.error ?? '失败'}`).join('\n'))
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = ''
  }
}

function requestClose(): void {
  emit('overlay-event', 'close-request')
}
function onShellEvent(event: string, args?: unknown): void {
  emit('overlay-event', event, args)
}

onMounted(() => {
  void refresh()
  void api.plugins
    .invoke<{ cookieHosts: string[] }>('quark', 'getSettings')
    .then((s) => {
      cookieHosts.value = s.cookieHosts ?? []
    })
    .catch(() => {})
})

onBeforeUnmount(() => {
  if (noticeTimer) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <ModalShell @overlay-event="onShellEvent">
    <div class="qk-panel">
      <div class="qk-head">
        <Cloud :size="16" />
        <span class="qk-title">夸克网盘</span>
        <span class="qk-sub">{{ list?.folderName || '当前目录' }} · {{ files.length }} 个文件</span>
        <span class="qk-spacer" />
        <button class="btn" :disabled="loading" @click="refresh">
          <RefreshCw :size="13" :class="{ spin: loading }" />刷新
        </button>
      </div>

      <div v-if="notice" class="qk-notice">{{ notice }}</div>
      <div v-if="error" class="qk-error">
        <div class="qk-error-text">{{ error }}</div>
        <details v-if="rawResponse" class="qk-raw">
          <summary>服务器原始响应</summary>
          <pre>{{ rawResponse }}</pre>
        </details>
      </div>

      <div v-if="files.length === 0 && !loading" class="qk-empty">
        当前目录里没有读到文件。请先在夸克页面里进入一个文件夹,再点「刷新」。
      </div>

      <div v-else class="qk-list">
        <label class="qk-row qk-row-head">
          <input type="checkbox" :checked="allChecked" @change="toggleAll" />
          <span class="qk-name">文件名</span>
          <span class="qk-size">大小</span>
        </label>
        <div v-for="f in files" :key="f.fid" class="qk-row">
          <input type="checkbox" :checked="checked.has(f.fid)" @change="toggle(f.fid)" />
          <span class="qk-name" :title="f.name">{{ f.name }}</span>
          <span class="qk-size">{{ formatBytes(f.size) }}</span>
        </div>
      </div>

      <div class="qk-foot">
        <button class="btn primary" :disabled="busy === 'aria2rpc' || chosen.length === 0" @click="pushAria2">
          <Send :size="13" />推送 aria2({{ chosen.length }})
        </button>
        <span class="qk-spacer" />
        <button class="btn" @click="showDiag = !showDiag">诊断</button>
      </div>

      <div v-if="showDiag" class="qk-diag">
        <div>页面:<code>{{ list?.url || '—' }}</code></div>
        <div>
          选择器 <code>{{ list?.diagnostics?.selector || '—' }}</code> · fiber 键
          <code>{{ list?.diagnostics?.fiberKeyPrefix || '—' }}</code> · 阶段
          <code>{{ list?.diagnostics?.stage || '—' }}</code>
        </div>
        <div>顶层 props:<code>{{ (list?.diagnostics?.propKeys ?? []).slice(0, 16).join(', ') || '—' }}</code></div>
        <div>
          Cookie 白名单:<code>{{ cookieHosts.join(', ') || '(空 —— 不会传给 aria2)' }}</code> · 最近一次直链域名:
          <code>{{ lastHosts.length ? lastHosts.map((h) => `${h.host}×${h.count}`).join(', ') : '—' }}</code>
        </div>
        <div class="qk-diag-note">
          直链域名不在白名单内时不会把 Cookie 交给 aria2;若 aria2 报 403,可到「设置 → 夸克网盘」把该域名加进白名单。
        </div>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.qk-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(860px, 88vw);
  max-height: 78vh;
  min-height: 260px;
}
.qk-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.qk-title {
  font-weight: 600;
}
.qk-sub {
  color: var(--text-dim, #9aa0a6);
  font-size: 12px;
}
.qk-spacer {
  flex: 1;
}
.qk-notice {
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.12);
  font-size: 12px;
}
.qk-error {
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(220, 38, 38, 0.12);
  font-size: 12px;
  white-space: pre-wrap;
}
.qk-raw pre {
  max-height: 140px;
  overflow: auto;
  margin: 6px 0 0;
  font-size: 11px;
}
.qk-empty {
  padding: 24px 8px;
  color: var(--text-dim, #9aa0a6);
  font-size: 13px;
  text-align: center;
}
.qk-list {
  flex: 1;
  overflow: auto;
  border: 1px solid var(--border, #2a2d33);
  border-radius: 8px;
}
.qk-row {
  display: grid;
  grid-template-columns: 28px 1fr 90px;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border, #2a2d33);
  font-size: 13px;
}
.qk-row:last-child {
  border-bottom: none;
}
.qk-row-head {
  position: sticky;
  top: 0;
  background: var(--surface, #1b1d21);
  font-size: 12px;
  color: var(--text-dim, #9aa0a6);
}
.qk-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qk-size {
  color: var(--text-dim, #9aa0a6);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.qk-foot {
  display: flex;
  align-items: center;
  gap: 6px;
}
.qk-diag {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  font-size: 11px;
  color: var(--text-dim, #9aa0a6);
  word-break: break-all;
}
.qk-diag code {
  color: var(--text, #e6e6e6);
}
.qk-diag-note {
  opacity: 0.8;
}
.spin {
  animation: qk-spin 1s linear infinite;
}
@keyframes qk-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
