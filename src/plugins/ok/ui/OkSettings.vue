<script setup lang="ts">
/**
 * OpenKnowledge 设置分区:项目目录(唯一一个)/ 自启开关 / 运行状态 / 停止。
 *
 * 目录必须是已经 `ok init` 过的 OK 项目;选一个空目录时,先点「初始化」再打开。
 * 服务用的是**你自己装的 `ok`**(不是 bow 内置的):`runtimeVersion` 读自它的启动横幅,
 * 所以永远与你终端里那份一致;Windows 上服务在 WSL 里,`pid` 那边没有可展示的东西。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { FolderOpen, RefreshCw, Square } from '@lucide/vue'
import { OK_EVENT, type OkState } from '@plugins/ok/shared'

const api = window.browserAPI
const state = ref<OkState | null>(null)
/** 输入框里的草稿:改完点「应用」才落盘(边打边重启服务会把人弄疯) */
const draft = ref('')
const busy = ref(false)
const message = ref('')
let unsubscribe: (() => void) | null = null

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return api.plugins.invoke<T>('ok', method, ...args)
}

async function refresh(): Promise<void> {
  state.value = await invoke<OkState>('getState')
  draft.value = state.value.settings.projectPath
}

/** 直接把路径写进设置 —— WSL 里的目录只能用 Linux 路径填进来,文件对话框选不到 */
async function applyPath(): Promise<void> {
  const projectPath = draft.value.trim()
  if (!projectPath) return
  busy.value = true
  message.value = ''
  try {
    state.value = await invoke<OkState>('setSettings', { projectPath })
    draft.value = state.value.settings.projectPath
    message.value = state.value.error ?? ''
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function pick(): Promise<void> {
  busy.value = true
  message.value = ''
  try {
    state.value = await invoke<OkState>('pickProject')
    draft.value = state.value.settings.projectPath
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
      <input
        v-model="draft"
        class="path-input"
        spellcheck="false"
        placeholder="/home/… (WSL 里的目录直接填)"
        @keyup.enter="applyPath"
      />
      <button class="ghost" :disabled="busy" @click="pick"><FolderOpen :size="13" /> 选择…</button>
      <button class="ghost" :disabled="busy || !draft.trim() || draft.trim() === state?.settings.projectPath" @click="applyPath">
        应用
      </button>
      <button class="ghost" :disabled="busy || !state?.settings.projectPath" @click="init">
        <RefreshCw :size="13" /> 初始化
      </button>
    </p>
    <p class="hint">
      OK 一个项目一个服务,这里固定一个目录(必须已经 `ok init` 过)。换目录会先停掉旧服务。
      服务用的是**你自己装的 `ok`**(`npm i -g @inkeep/open-knowledge`);Windows 上它跑在 WSL 里
      (pi 也在那一侧),目录必须是 **Linux 路径**:填 `/home/…` 最快(`/mnt/c/…` 走 9p,慢一截);
      「选择…」里手敲 `\\wsl.localhost\<发行版>\home\…` 也行,会自动换算。
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
      服务用的是你自己装的 <code>ok</code>(空闲 30 分钟、没有标签连着时它会自己退出,下次点工具栏按钮再起)。
      Windows 上它在 WSL 里跑:终端里用 <code>cd &lt;项目&gt; && ok ps</code> 看,进程名是
      <code>open-knowledge-server</code>,不是你敲的那个 <code>ok</code>。
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

.path-input {
  flex: 1;
  min-width: 180px;
  padding: 3px 8px;
  font-family: var(--mono, monospace);
  font-size: 12px;
  color: var(--fg);
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 4px;
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
