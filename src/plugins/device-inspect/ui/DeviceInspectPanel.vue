<script setup lang="ts">
/**
 * 设备检查面板(full 浮层):设备 → 套接字 → 可调试目标,一键把目标接进 DevTools 前端。
 *
 * 它只做两件事:调 `plugins.invoke('device-inspect', …)` 和渲染。所有解析/判定/文案都在插件
 * 主进程侧(见 `../shared.ts` 与 `../main.ts`)—— 这样「用户看到的提示」与「AI 看到的提示」是同一套。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, Copy, RefreshCw, Smartphone, Wifi, X } from 'lucide-vue-next'
import ModalShell from '@renderer/components/ModalShell.vue'
import {
  frontendNotice,
  socketLabel,
  targetTypeLabel,
  type FrontendNotice,
  type FrontendStrategy,
  type InspectSnapshot
} from '../shared'

defineOptions({ inheritAttrs: false })

const api = window.browserAPI
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

const state = ref<InspectSnapshot | null>(null)
const loading = ref(false)
const busyKey = ref('')
const notice = ref('')
const error = ref('')
const showSettings = ref(false)
const adbDraft = ref('')
const strategyDraft = ref<FrontendStrategy>('auto')
const wirelessAddress = ref('')
const wirelessCode = ref('')
const copied = ref('')

/** 复制按钮的两种目标:ws 地址、点「检查」会打开的 DevTools 前端地址 */
type CopyKind = 'ws' | 'frontend'

let timer: number | undefined
let noticeTimer: number | undefined
let copiedTimer: number | undefined

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
  }, 2500)
}

async function refresh(options: { silent?: boolean } = {}): Promise<void> {
  if (!options.silent) loading.value = true
  try {
    const snapshot = await api.plugins.invoke<InspectSnapshot>('device-inspect', 'list')
    state.value = snapshot
    error.value = ''
    if (adbDraft.value === '' && snapshot.adb.command) adbDraft.value = snapshot.adb.command
    strategyDraft.value = snapshot.strategy
    // adb 都没找到时不要继续轮询:每 8s 反复 spawn 一个失败的 adb 进程没有意义,等用户手动刷新
    if (!snapshot.adb.ok) stopPolling()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    stopPolling()
  } finally {
    loading.value = false
  }
}

function startPolling(): void {
  stopPolling()
  timer = window.setInterval(() => void refresh({ silent: true }), 8000)
}
function stopPolling(): void {
  if (timer) window.clearInterval(timer)
  timer = undefined
}

async function inspect(targetKey: string): Promise<void> {
  busyKey.value = targetKey
  try {
    const result = await api.plugins.invoke<{ ok: boolean; tabId?: number; error?: string }>(
      'device-inspect',
      'open',
      { targetKey }
    )
    if (!result.ok) error.value = result.error ?? '打开失败'
    else requestClose()
  } finally {
    busyKey.value = ''
  }
}

/** 勾选态按 `<kind>:<rowKey>` 记:两个复制按钮各自独立,不会被另一行/另一个按钮顶掉 */
const isCopied = (kind: CopyKind, key: string): boolean => copied.value === `${kind}:${key}`

async function copyText(kind: CopyKind, key: string, text: string, label: string): Promise<void> {
  try {
    // 走主进程剪贴板(与下载面板同一套):渲染层的 navigator.clipboard 依赖 secure context 与焦点
    await api.writeClipboardText(text)
    copied.value = `${kind}:${key}`
    if (copiedTimer) window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => {
      copied.value = ''
    }, 2000)
    flash(`已复制${label}`)
  } catch {
    flash('复制失败(剪贴板被拒绝)')
  }
}

async function saveSettings(): Promise<void> {
  await api.plugins.invoke('device-inspect', 'setSettings', { adbCommand: adbDraft.value.trim() })
  flash('adb 设置已保存,已回收旧转发')
  startPolling()
  await refresh()
}

async function switchStrategy(strategy: FrontendStrategy): Promise<void> {
  strategyDraft.value = strategy
  await api.plugins.invoke('device-inspect', 'setSettings', { strategy })
  flash(
    strategy === 'auto'
      ? '已切到「自动」(按设备版本挑前端)'
      : strategy === 'device-suggested'
        ? '已切到「设备指定前端」'
        : '已切到「bow 自带前端」'
  )
  await refresh()
}

async function checkAdb(): Promise<void> {
  loading.value = true
  try {
    const result = await api.plugins.invoke<{ ok: boolean; command: string; version?: string; error?: string }>(
      'device-inspect',
      'checkAdb',
      adbDraft.value.trim()
    )
    flash(result.ok ? `adb 可用:${result.version ?? result.command}` : `adb 不可用:${result.error ?? ''}`)
  } finally {
    loading.value = false
  }
}

async function cleanupForwards(): Promise<void> {
  await api.plugins.invoke('device-inspect', 'cleanupForwards')
  flash('已回收全部端口转发')
  await refresh()
}

async function wireless(kind: 'pair' | 'connect'): Promise<void> {
  const address = wirelessAddress.value.trim()
  if (!address) {
    flash('先填手机地址(形如 192.168.1.5:5555)')
    return
  }
  loading.value = true
  try {
    const result = await api.plugins.invoke<{ ok: boolean; message?: string; error?: string }>(
      'device-inspect',
      kind,
      kind === 'pair' ? { address, code: wirelessCode.value.trim() } : address
    )
    flash(result.ok ? `${kind === 'pair' ? '配对' : '连接'}成功` : `失败:${result.error ?? ''}`)
    if (result.ok) {
      startPolling()
      await refresh()
    }
  } finally {
    loading.value = false
  }
}

const strategyLabel = (strategy: FrontendStrategy): string =>
  strategy === 'auto' ? '自动' : strategy === 'device-suggested' ? '设备指定' : 'bow 自带'

/** 解释文案只写在这里;判定逻辑在 shared.frontendNotice(纯函数、有单测) */
const FRONTEND_NOTICE_TEXT: Record<FrontendNotice, (browser: string) => string> = {
  'auto-switched-to-device': (browser) =>
    `设备是 ${browser}:bow 自带前端(Chromium 152)在这种老设备上取不到 storage key → Application 面板的 Local Storage / IndexedDB 会是空的,已自动改用设备指定的前端(与设备版本一致,chrome://inspect 用的就是它)`,
  'auto-fallback-to-electron': (browser) =>
    `设备是 ${browser},但它给的前端地址打不开(设备没打包前端资源且 appspot 上的那份取不到),已回退 bow 自带 —— 这种组合下 Application 面板的存储节点会是空的`,
  'forced-device-unavailable': () =>
    '设备给的前端地址打不开(设备没打包前端资源且 appspot 上的那份取不到),已回退到 bow 自带前端',
  'electron-incompatible': (browser) =>
    `设备是 ${browser}(低于 Chromium 146),bow 自带前端取不到 storage key → Application 面板的 Local Storage / IndexedDB 会是空的;建议把前端来源改成「设备指定」`
}

/**
 * 实际生效的前端与设置不一致(或虽一致但设备版本对不上)时给一行解释。
 * 最典型的场景:设备 Chromium 太老,bow 自带前端取不到 storage key → Application 面板的
 * Local Storage / IndexedDB 会静默空白,所以自动切到与设备版本一致的设备自带前端。
 */
const frontendNotes = computed(() => {
  const snapshot = state.value
  if (!snapshot) return []
  const out: Array<{ key: string; scope: string; text: string }> = []
  for (const group of snapshot.devices) {
    for (const socket of group.sockets) {
      if (!socket.frontendStrategy) continue
      const notice = frontendNotice(snapshot.strategy, {
        browser: socket.browser,
        effective: socket.frontendStrategy
      })
      if (!notice) continue
      const scope = `${group.device.serial} · ${socketLabel(socket.socket, socket.package)}`
      out.push({
        key: `${scope}|${notice}`,
        scope,
        text: FRONTEND_NOTICE_TEXT[notice](socket.browser ?? '未知版本')
      })
    }
  }
  return out
})

/** 摊平成「目标 + 所属上下文」的行模型,便于在模板里一层 v-for 渲染 */
const rows = computed(() => {
  const out: Array<{
    key: string
    device: string
    deviceState: string
    model: string
    socket: string
    socketLabel: string
    package?: string
    browser: string
    type: string
    title: string
    url: string
    wsUrl: string
    frontendUrl: string
  }> = []
  for (const group of state.value?.devices ?? []) {
    for (const socket of group.sockets) {
      for (const target of socket.targets) {
        out.push({
          key: target.key,
          device: group.device.serial,
          deviceState: group.device.state,
          model: group.device.model ?? '',
          socket: socket.socket.name,
          socketLabel: socketLabel(socket.socket, socket.package),
          package: socket.package,
          browser: socket.browser ?? '',
          type: targetTypeLabel(target.type),
          title: target.title || '(无标题)',
          url: target.url,
          wsUrl: target.wsUrl,
          frontendUrl: target.frontendUrl
        })
      }
    }
  }
  return out
})

const socketProblems = computed(() =>
  (state.value?.devices ?? []).flatMap((group) =>
    group.sockets
      .filter((socket) => socket.problem)
      .map((socket) => ({
        scope: `${group.device.serial} · ${socket.socket.name}`,
        title: socket.problem === 'no-targets' ? '没有可调试页面' : '连接失败',
        detail: socket.detail ?? ''
      }))
  )
)

onMounted(async () => {
  await refresh()
  if (state.value?.adb.ok) startPolling()
})
onBeforeUnmount(() => {
  stopPolling()
  if (noticeTimer) window.clearTimeout(noticeTimer)
  if (copiedTimer) window.clearTimeout(copiedTimer)
})
</script>

<template>
  <ModalShell @overlay-event="onShellEvent">
    <div class="dvi-panel">
      <div class="dvi-head">
        <Smartphone :size="16" />
        <span class="dvi-title">设备检查</span>
        <span v-if="state" class="dvi-badge" :class="{ ok: state.targetCount > 0 }">
          {{ state.targetCount }} 个可调试目标
        </span>
        <span class="dvi-spacer" />
        <button class="btn" :disabled="loading" @click="refresh()">
          <RefreshCw :size="13" :class="{ spin: loading }" /> 刷新
        </button>
        <button class="btn" @click="showSettings = !showSettings">设置</button>
        <button class="win-btn" title="关闭" @click="requestClose"><X :size="13" /></button>
      </div>

      <div v-if="state" class="dvi-status">
        <span class="dvi-kv">adb:</span>
        <code class="dvi-code">{{ state.adb.command || 'adb' }}</code>
        <span v-if="state.adb.configured" class="dvi-tag">手动指定</span>
        <span v-else class="dvi-tag">自动探测</span>
        <span class="dvi-kv">前端:</span>
        <span class="dvi-tag">{{ strategyLabel(state.strategy) }}</span>
        <span v-if="state.forwards.length" class="dvi-kv">已转发 {{ state.forwards.length }} 个端口</span>
      </div>

      <div v-if="showSettings" class="dvi-settings">
        <label class="dvi-field">
          <span class="dvi-kv">adb 命令</span>
          <input
            v-model="adbDraft"
            class="pbm-input wide"
            spellcheck="false"
            placeholder="留空自动探测(Windows 上依次试 adb、wsl adb)"
          />
        </label>
        <div class="dvi-row">
          <button class="btn" :disabled="loading" @click="checkAdb">自检</button>
          <button class="btn primary" @click="saveSettings">保存</button>
          <button class="btn danger" @click="cleanupForwards">回收全部转发</button>
        </div>
        <div class="dvi-field">
          <span class="dvi-kv">DevTools 前端</span>
          <div class="dvi-row">
            <button
              class="btn"
              :class="{ primary: strategyDraft === 'auto' }"
              @click="switchStrategy('auto')"
            >
              自动(推荐)
            </button>
            <button
              class="btn"
              :class="{ primary: strategyDraft === 'device-suggested' }"
              @click="switchStrategy('device-suggested')"
            >
              设备指定
            </button>
            <button
              class="btn"
              :class="{ primary: strategyDraft === 'electron-bundled' }"
              @click="switchStrategy('electron-bundled')"
            >
              bow 自带
            </button>
          </div>
        </div>
        <p class="dvi-hint">
          前端必须与设备 Chromium 版本对得上:版本差异会让 Application 面板(IndexedDB / Local storage)
          静默空白。自动模式 = 设备是 Chromium 146 以下时用「设备指定的前端」(设备自带的,或它指定 revision 的
          appspot 那份),否则用 bow 自带;设备给的前端打不开时自动回退 bow 自带。
        </p>
        <p class="dvi-hint">
          手机侧 adb 在 WSL 里时填 <code class="dvi-code">wsl adb</code>;端口转发建在 WSL 中,
          Windows 侧要能访问 <code class="dvi-code">127.0.0.1</code> 需 WSL2 镜像网络
          (<code class="dvi-code">.wslconfig</code> 的 <code class="dvi-code">networkingMode=Mirrored</code>)。
        </p>
      </div>

      <div class="dvi-wireless">
        <Wifi :size="14" />
        <input v-model="wirelessAddress" class="pbm-input" spellcheck="false" placeholder="无线调试地址,如 192.168.1.5:5555" />
        <input v-model="wirelessCode" class="pbm-input dvi-code-input" spellcheck="false" placeholder="配对码(仅配对需要)" />
        <button class="btn" :disabled="loading" @click="wireless('pair')">配对</button>
        <button class="btn" :disabled="loading" @click="wireless('connect')">连接</button>
      </div>

      <div v-if="notice || error" class="dvi-notice">{{ notice || error }}</div>

      <div class="dvi-body">
        <div v-if="!state" class="dvi-empty">正在检查…</div>
        <template v-else>
          <div v-for="item in state.notices" :key="`${item.problem}-${item.scope}`" class="dvi-alert" :class="{ fatal: item.fatal }">
            <div class="dvi-alert-title">{{ item.title }}<span class="dvi-kv"> · {{ item.scope }}</span></div>
            <div class="dvi-alert-detail">{{ item.detail }}</div>
          </div>

          <div v-for="item in socketProblems" :key="`sp-${item.scope}`" class="dvi-alert">
            <div class="dvi-alert-title">{{ item.title }}<span class="dvi-kv"> · {{ item.scope }}</span></div>
            <div class="dvi-alert-detail">{{ item.detail }}</div>
          </div>

          <div v-for="item in frontendNotes" :key="`fe-${item.key}`" class="dvi-alert info">
            <div class="dvi-alert-title">前端来源<span class="dvi-kv"> · {{ item.scope }}</span></div>
            <div class="dvi-alert-detail">{{ item.text }}</div>
          </div>

          <div v-if="rows.length === 0 && state.notices.length === 0" class="dvi-empty">
            没有发现可调试的 WebView / Chrome。常见原因:应用是 release 包且没有调用
            <code class="dvi-code">WebView.setWebContentsDebuggingEnabled(true)</code>;或页面还没加载过。
          </div>

          <div v-for="row in rows" :key="row.key" class="dvi-target">
            <div class="dvi-target-main">
              <div class="dvi-target-title">
                <span class="dvi-type">{{ row.type }}</span>
                <span class="dvi-name">{{ row.title }}</span>
              </div>
              <div class="dvi-target-url" :title="row.url">{{ row.url }}</div>
              <div class="dvi-target-meta">
                {{ row.device }}<template v-if="row.model"> · {{ row.model }}</template> · {{ row.socketLabel }}
                <template v-if="row.browser"> · {{ row.browser }}</template>
              </div>
            </div>
            <div class="dvi-target-actions">
              <button
                class="btn"
                :title="`复制 WebSocket 地址:${row.wsUrl}`"
                @click="copyText('ws', row.key, row.wsUrl, ' WebSocket 地址')"
              >
                <Check v-if="isCopied('ws', row.key)" :size="13" />
                <Copy v-else :size="13" />
                复制 ws
              </button>
              <button
                class="btn"
                :title="`复制检查地址(DevTools 前端):${row.frontendUrl}`"
                @click="copyText('frontend', row.key, row.frontendUrl, '检查地址')"
              >
                <Check v-if="isCopied('frontend', row.key)" :size="13" />
                <Copy v-else :size="13" />
                复制地址
              </button>
              <button class="btn primary" :disabled="busyKey === row.key" @click="inspect(row.key)">检查</button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.dvi-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(880px, 86vw);
  max-height: 78vh;
  min-height: 320px;
  /* 全局 .modal 只画边框圆角、内边距归各面板自己:不给我们这里就是列表顶到弹窗边框 */
  padding: 12px 14px;
}

.dvi-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dvi-title {
  font-size: 14px;
  font-weight: 600;
}

.dvi-spacer {
  flex: 1;
}

.dvi-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #3a3d46;
  color: #c9ccd4;
}

.dvi-badge.ok {
  background: #234a2c;
  color: #9fe0ad;
}

.dvi-status,
.dvi-wireless,
.dvi-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dvi-kv {
  font-size: 11px;
  color: #9aa0ad;
}

.dvi-code {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  background: #2b2d34;
  border-radius: 4px;
  padding: 1px 4px;
}

.dvi-code-input {
  width: 170px;
}

.dvi-tag {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: #33363e;
  color: #b9bec9;
}

.dvi-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid #383b44;
  border-radius: 8px;
  background: #26282e;
}

.dvi-field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dvi-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: #8d94a1;
}

.dvi-notice {
  font-size: 12px;
  color: #d7c07a;
}

.dvi-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
  padding-right: 2px;
}

.dvi-empty {
  font-size: 12px;
  line-height: 1.7;
  color: #9aa0ad;
  padding: 12px 2px;
}

.dvi-alert {
  border-left: 3px solid #b58a3a;
  background: #2c2a24;
  border-radius: 4px;
  padding: 8px 10px;
}

.dvi-alert.fatal {
  border-left-color: #b5523a;
  background: #2e2724;
}

.dvi-alert.info {
  border-left-color: #3a6ea5;
  background: #242a2e;
}

.dvi-alert-title {
  font-size: 12px;
  font-weight: 600;
}

.dvi-alert-detail {
  font-size: 11px;
  line-height: 1.7;
  color: #a9aeb9;
  white-space: pre-line;
}

.dvi-target {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid #353841;
  border-radius: 6px;
  background: #26282e;
}

.dvi-target:hover {
  border-color: #4a4f5c;
}

.dvi-target-main {
  flex: 1;
  min-width: 0;
}

.dvi-target-title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dvi-type {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: #3a3d46;
  color: #c9ccd4;
}

.dvi-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dvi-target-url {
  font-size: 11px;
  color: #8d94a1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dvi-target-meta {
  font-size: 10px;
  color: #6f7581;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dvi-target-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.spin {
  animation: dvi-spin 0.9s linear infinite;
}

@keyframes dvi-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
