<script setup lang="ts">
/**
 * 设置分区「本地服务」:一行一条服务的增删改 + 状态 / 启停 / 日志尾巴。
 *
 * 保存策略:**输入框失焦即存**(`@change`),没有草稿/应用按钮 —— 改配置不会重启服务,
 * 半截命令留在磁盘上也无害(下次点图标才用到)。只有**命令或地址**变了,主进程才会把
 * 已经跑起来的旧进程停掉(它跑的已经不是这条配置了)。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronDown, ChevronUp, Plus, Square, Trash2 } from '@lucide/vue'
import {
  MAX_SERVICES,
  SERVICES_EVENT,
  serviceUrlMatches,
  type EnsureResult,
  type ServiceConfig,
  type ServicesState,
  type ServiceStatus
} from '../shared'
import { DEFAULT_FLOAT, FLOAT_PLACEMENTS } from '@shared/floatWindow'
import { SERVICE_ICON_NAMES, serviceIcon } from './icons'

const api = window.browserAPI
const rows = ref<ServiceConfig[]>([])
const statuses = ref<ServiceStatus[]>([])
const openLogs = ref<string[]>([])
const logs = ref<Record<string, string>>({})
const message = ref('')
const busy = ref(false)

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return api.plugins.invoke<T>('services', method, ...args)
}

const PHASE_LABELS: Record<ServicesState['statuses'][number]['phase'], string> = {
  stopped: '未启动',
  starting: '正在启动…',
  running: '运行中',
  error: '出错'
}

function statusOf(id: string): ServiceStatus | undefined {
  return statuses.value.find((status) => status.id === id)
}

async function reload(): Promise<void> {
  const state = await invoke<ServicesState>('getState')
  rows.value = state.settings.services.map((service) => ({ ...service }))
  statuses.value = state.statuses
}

/** 落盘:主进程返回归一后的设置(补 id、补协议),所以用它覆盖本地行 */
async function save(): Promise<void> {
  busy.value = true
  message.value = ''
  try {
    // 必须摊平成普通对象:`rows.value` 是 Vue 的深层 Proxy,V8 序列化直接拒收
    // ("could not be cloned"),那样整条设置根本到不了主进程,磁盘上一直是空的。
    const state = await invoke<ServicesState>('setSettings', {
      services: rows.value.map((service) => ({ ...service }))
    })
    rows.value = state.settings.services.map((service) => ({ ...service }))
    statuses.value = state.statuses
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function add(): Promise<void> {
  if (rows.value.length >= MAX_SERVICES) return
  // 预填地址:空行会被归一化丢掉(命令和地址都空 = 没意义的一行)
  rows.value = [
    ...rows.value,
    {
      id: '',
      name: '',
      icon: 'Play',
      command: '',
      url: 'http://127.0.0.1:8080',
      check: '',
      autoStart: false
    }
  ]
  await save()
}

async function remove(index: number): Promise<void> {
  rows.value = rows.value.filter((_, i) => i !== index)
  await save()
}

async function move(index: number, delta: number): Promise<void> {
  const next = index + delta
  if (next < 0 || next >= rows.value.length) return
  const list = [...rows.value]
  const [moved] = list.splice(index, 1)
  list.splice(next, 0, moved)
  rows.value = list
  await save()
}

/**
 * 「用浮窗打开」开关:打开时写入默认 center/800x600(之后可改),关掉时**删掉**这个字段 ——
 * 没有 `float` = 点图标照旧开标签(与从没配过的老服务完全等价)。
 */
async function toggleFloat(service: ServiceConfig, on: boolean): Promise<void> {
  service.float = on ? { ...DEFAULT_FLOAT } : undefined
  await save()
}

/** 启动并打开:与工具栏点击同一个语义(设置页里点完就能看到效果) */
async function start(service: ServiceConfig): Promise<void> {
  busy.value = true
  message.value = ''
  try {
    const res = await invoke<EnsureResult>('ensure', service.id)
    if (!res.url) {
      message.value = res.error ?? '没起来'
      return
    }
    const url = res.url
    const existing = (await api.listTabs()).find((tab) => serviceUrlMatches(tab.url, url))
    if (existing) await api.activateTab(existing.id)
    else await api.createTab(url)
    const state = await invoke<ServicesState>('getState')
    statuses.value = state.statuses
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function stop(id: string): Promise<void> {
  busy.value = true
  try {
    const state = await invoke<ServicesState>('stop', id)
    statuses.value = state.statuses
  } finally {
    busy.value = false
  }
}

async function toggleLog(id: string): Promise<void> {
  if (openLogs.value.includes(id)) {
    openLogs.value = openLogs.value.filter((item) => item !== id)
    return
  }
  openLogs.value = [...openLogs.value, id]
  logs.value = { ...logs.value, [id]: await invoke<string>('logs', id) }
}

let unsubscribe: (() => void) | null = null

onMounted(() => {
  void reload()
  // 只同步运行状态:行内容归设置页自己所有,不然用户打字打到一半会被广播覆盖
  unsubscribe = api.plugins.onEvent((ev) => {
    if (ev.id !== 'services' || ev.event !== SERVICES_EVENT.changed) return
    statuses.value = (ev.args as ServicesState).statuses
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
})
</script>

<template>
  <section class="svc-settings">
    <h3 class="section-title">服务</h3>
    <p class="hint">
      一行一条:命令经你的登录 shell 执行(`bun` / `ok` 装在 `~/.bun/bin`,GUI 的 PATH 里没有),
      所以可以写 <code>cd ~/Workspace/exp1 && bun dev</code>;Windows 上命令跑在 WSL 里。
      工具栏每条服务一个图标:没起就起、起了就打开它的前端地址;Ctrl+点击强制开标签,
      右键复制地址。勾了「用浮窗打开」的服务改走窗口内的浮窗(默认居中 800×600,再点一次关掉,
      浮窗里按 Esc 也能关)。bow 退出时会停掉它自己起的进程,你在终端里手动起的它不碰。
    </p>

    <p v-if="message" class="hint warn">{{ message }}</p>

    <div v-for="(service, index) in rows" :key="service.id || `new-${index}`" class="svc">
      <div class="svc-head">
        <select v-model="service.icon" class="icon-select" title="工具栏图标" @change="save">
          <option v-for="name in SERVICE_ICON_NAMES" :key="name" :value="name">{{ name }}</option>
        </select>
        <component :is="serviceIcon(service.icon)" :size="16" class="preview" />
        <input v-model="service.name" class="name-input" placeholder="名字(工具栏 tooltip)" @change="save" />
        <span class="phase" :class="statusOf(service.id)?.phase ?? 'stopped'">
          {{ PHASE_LABELS[statusOf(service.id)?.phase ?? 'stopped'] }}
        </span>
        <button
          v-if="statusOf(service.id)?.owned"
          class="ghost"
          :disabled="busy"
          @click="stop(service.id)"
        >
          <Square :size="13" /> 停止
        </button>
        <button v-else class="ghost" :disabled="busy" @click="start(service)">
          <Plus :size="13" /> 启动
        </button>
        <button class="ghost" @click="toggleLog(service.id)">日志</button>
        <button class="ghost icon-only" :disabled="index === 0" title="上移" @click="move(index, -1)">
          <ChevronUp :size="13" />
        </button>
        <button
          class="ghost icon-only"
          :disabled="index === rows.length - 1"
          title="下移"
          @click="move(index, 1)"
        >
          <ChevronDown :size="13" />
        </button>
        <button class="ghost icon-only" title="删除" @click="remove(index)">
          <Trash2 :size="13" />
        </button>
      </div>

      <input
        v-model="service.command"
        class="mono"
        spellcheck="false"
        placeholder="cd ~/Workspace/exp1 && bun dev"
        @change="save"
      />
      <div class="svc-row">
        <input
          v-model="service.url"
          class="mono grow"
          spellcheck="false"
          placeholder="http://127.0.0.1:1420"
          @change="save"
        />
        <input
          v-model="service.check"
          class="mono grow"
          spellcheck="false"
          placeholder="可选:响应里必须出现的字串(端口撞车时用来认服务)"
          @change="save"
        />
      </div>
      <label class="check">
        <input v-model="service.autoStart" type="checkbox" @change="save" />
        bow 启动就把这条拉起来
      </label>
      <div class="svc-row float-row">
        <label class="check no-top">
          <input
            type="checkbox"
            :checked="service.float !== undefined"
            @change="toggleFloat(service, ($event.target as HTMLInputElement).checked)"
          />
          用浮窗打开(不勾 = 照旧开标签)
        </label>
        <template v-if="service.float">
          <select v-model="service.float.placement" class="icon-select" title="浮窗位置" @change="save">
            <option v-for="placement in FLOAT_PLACEMENTS" :key="placement" :value="placement">
              {{ placement }}
            </option>
          </select>
          <input
            v-model.number="service.float.width"
            class="icon-select num"
            type="number"
            min="320"
            step="20"
            title="浮窗宽(px)"
            @change="save"
          />
          <input
            v-model.number="service.float.height"
            class="icon-select num"
            type="number"
            min="200"
            step="20"
            title="浮窗高(px)"
            @change="save"
          />
        </template>
      </div>
      <p v-if="statusOf(service.id)?.error" class="hint warn">{{ statusOf(service.id)?.error }}</p>
      <pre v-if="openLogs.includes(service.id)" class="log">{{ logs[service.id] || '(还没有输出)' }}</pre>
    </div>

    <p v-if="rows.length === 0" class="hint">还没有服务:点下面「新增服务」加一条。</p>
    <p class="row">
      <button class="ghost" :disabled="busy || rows.length >= MAX_SERVICES" @click="add">
        <Plus :size="13" /> 新增服务
      </button>
      <span v-if="rows.length >= MAX_SERVICES" class="hint">
        最多 {{ MAX_SERVICES }} 条(工具栏就一行,再多请改用聚合面板)
      </span>
    </p>
    <p class="hint">
      改命令或地址会停掉已经跑起来的旧进程(它跑的已经不是这条配置了);改名字/图标/`check`
      不影响正在跑的服务。日志只有最后 4KB,要完整的就在命令后面自己加 <code>| tee /tmp/x.log</code>。
    </p>
  </section>
</template>

<style scoped>
.svc-settings {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 14px 20px;
  font-size: 13px;
}

.section-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
  text-transform: uppercase;
}

.svc {
  padding: 8px 10px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg2);
}

.svc-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.icon-select {
  padding: 2px 4px;
  font-size: 12px;
  color: var(--fg);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.preview {
  color: var(--fg-dim);
}

.name-input,
.mono {
  min-width: 0;
  padding: 3px 8px;
  font-family: var(--mono, monospace);
  font-size: 12px;
  color: var(--fg);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.name-input {
  flex: 1;
  font-family: inherit;
  font-size: 13px;
}

/* 单行的命令输入:占满整行(它是 .svc 的直接子元素,不在 flex 容器里) */
.svc > .mono {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 6px;
}

.svc-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.grow {
  flex: 1;
  min-width: 0;
}

.float-row {
  flex-wrap: wrap;
  align-items: center;
}

.no-top {
  margin-top: 0;
}

.num {
  width: 72px;
}

.check {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
  cursor: pointer;
}

.phase {
  font-size: 12px;
  color: var(--fg-dim);
}

.phase.running {
  color: var(--ok, #4caf7d);
}

.phase.error {
  color: var(--warning, #e0a030);
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

.icon-only {
  padding: 3px 5px;
}

.log {
  max-height: 180px;
  padding: 6px 8px;
  margin: 6px 0 0;
  overflow: auto;
  font-family: var(--mono, monospace);
  font-size: 11px;
  white-space: pre-wrap;
  color: var(--fg-dim);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 0 0 8px;
}

.hint {
  margin: 0 0 8px;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.6;
}

.hint.warn {
  color: var(--warning, #e0a030);
  white-space: pre-wrap;
}

.hint code {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  background: var(--bg3);
  border-radius: 4px;
  padding: 1px 4px;
}
</style>
