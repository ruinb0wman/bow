<script setup lang="ts">
/**
 * OpenKnowledge 设置分区:项目目录(唯一一个)/ 自启开关 / 运行状态 / 停止。
 *
 * 目录必须是已经 `ok init` 过的 OK 项目;选一个空目录时,先点「初始化」再打开。
 * 服务是 bow 用 Electron 自带的 Node 拉起来的,所以这里显示 `runtimeVersion` ——
 * 它由 bow 里装的 OK 版本决定,可能和你在终端里用的全局 `ok` 不是同一版。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { FolderOpen, RefreshCw, Square } from '@lucide/vue'
import { OK_EVENT, type OkState } from '@plugins/ok/shared'

const api = window.browserAPI
const state = ref<OkState | null>(null)
const busy = ref(false)
const message = ref('')
let unsubscribe: (() => void) | null = null

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return api.plugins.invoke<T>('ok', method, ...args)
}

async function refresh(): Promise<void> {
  state.value = await invoke<OkState>('getState')
}

async function pick(): Promise<void> {
  busy.value = true
  message.value = ''
  try {
    state.value = await invoke<OkState>('pickProject')
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function init(): Promise<void> {
  busy.value = true
  message.value = ''
  try {
    const res = await invoke<{ ok: boolean; error?: string }>('initProject')
    message.value = res.ok ? '已初始化,可以打开了' : (res.error ?? '初始化失败')
    state.value = await invoke<OkState>('ensure')
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function stop(): Promise<void> {
  busy.value = true
  try {
    state.value = await invoke<OkState>('stop')
  } finally {
    busy.value = false
  }
}

async function setAutoStart(event: Event): Promise<void> {
  const autoStart = (event.target as HTMLInputElement).checked
  state.value = await invoke<OkState>('setSettings', { autoStart })
}

const PHASE_LABELS: Record<OkState['phase'], string> = {
  stopped: '未启动',
  starting: '正在启动…',
  running: '运行中',
  error: '出错'
}

onMounted(() => {
  void refresh()
  unsubscribe = api.plugins.onEvent((ev) => {
    if (ev.id !== 'ok' || ev.event !== OK_EVENT.changed) return
    state.value = ev.args as OkState
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <section class="ok-settings">
    <h3 class="section-title">项目目录</h3>
    <p class="row">
      <code class="path">{{ state?.settings.projectPath || '(还没选)' }}</code>
      <button class="ghost" :disabled="busy" @click="pick"><FolderOpen :size="13" /> 选择…</button>
      <button class="ghost" :disabled="busy || !state?.settings.projectPath" @click="init">
        <RefreshCw :size="13" /> 初始化
      </button>
    </p>
    <p class="hint">
      OK 一个项目一个服务,这里固定一个目录(必须已经 `ok init` 过)。换目录会先停掉旧服务。
    </p>

    <h3 class="section-title">行为</h3>
    <p class="row">
      <label class="check">
        <input type="checkbox" :checked="state?.settings.autoStart ?? true" @change="setAutoStart" />
        bow 启动就把服务拉起来
      </label>
    </p>

    <h3 class="section-title">状态</h3>
    <p class="row">
      <span class="phase">{{ state ? PHASE_LABELS[state.phase] : '—' }}</span>
      <code v-if="state?.url" class="path">{{ state.url }}</code>
      <span v-if="state?.pid" class="meta">pid {{ state.pid }}</span>
      <span v-if="state?.runtimeVersion" class="meta">v{{ state.runtimeVersion }}</span>
      <button v-if="state?.phase === 'running'" class="ghost" :disabled="busy" @click="stop">
        <Square :size="13" /> 停止
      </button>
    </p>
    <p v-if="state?.error" class="hint warn">{{ state.error }}</p>
    <p v-if="message" class="hint">{{ message }}</p>

    <p class="hint">
      服务跑在 Electron 自带的 Node 里(不是终端里的 <code>ok</code> 命令)。空闲 30 分钟、没有标签连着时它会自己退出,
      下次点工具栏按钮再起。版本由 bow 决定,可能和你全局装的 `ok` 不同。
    </p>
  </section>
</template>

<style scoped>
.ok-settings {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 14px 20px;
  font-size: 13px;
}

.section-title {
  margin: 18px 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
  text-transform: uppercase;
}

.section-title:first-child {
  margin-top: 0;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 0 0 8px;
}

.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.phase {
  color: var(--fg);
}

.meta {
  color: var(--fg-dim);
  font-size: 12px;
}

.check {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  cursor: pointer;
}

.ghost {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--fg);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}

.ghost:disabled {
  opacity: 0.5;
  cursor: default;
}

.hint {
  margin: 0 0 8px;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.6;
}

.hint.warn {
  color: var(--warning, #e0a030);
}

.hint code {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  background: var(--bg3);
  border-radius: 4px;
  padding: 1px 4px;
}
</style>
