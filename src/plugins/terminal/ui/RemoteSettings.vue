<script setup lang="ts">
/**
 * 设置页 → 终端 → 「远程控制」(局域网)。
 *
 * 界面只做四件事:开关 / 绑定哪张网卡(本机 or 局域网)/ 端口 / 口令。
 * 启动与失败原因都在主进程(`applyRemote`),这里只显示它给的状态 —— 端口被占、口令太短
 * 都必须在页面上说清楚,不能只进日志。
 *
 * 口令是**明文**存的(mcp-http 的 token 也一样):你需要把它拄到手机上,所以得看得见、能复制。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TerminalRemoteSettings, TerminalRemoteStatus } from '../shared'
import { REMOTE_MIN_PASSWORD, REMOTE_PORT_RANGE } from '../shared'

const api = window.browserAPI

const remote = ref<TerminalRemoteSettings | null>(null)
const status = ref<TerminalRemoteStatus | null>(null)
const notice = ref('')
const busy = ref(false)
let unsubscribe: (() => void) | null = null
let noticeTimer: number | undefined

const url = computed(() => status.value?.lanUrls[0] ?? status.value?.url ?? '')
const showPassword = ref(false)

function flash(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 2600)
}

async function refresh(): Promise<void> {
  const settings = await api.plugins.invoke<{ remote: TerminalRemoteSettings }>('terminal', 'getSettings')
  remote.value = settings.remote
  status.value = await api.plugins.invoke<TerminalRemoteStatus>('terminal', 'remoteStatus')
}

async function patch(next: Partial<TerminalRemoteSettings>): Promise<void> {
  if (!remote.value) return
  busy.value = true
  try {
    const saved = await api.plugins.invoke<{ remote: TerminalRemoteSettings }>('terminal', 'setSettings', {
      remote: { ...remote.value, ...next }
    })
    remote.value = saved.remote
    status.value = await api.plugins.invoke<TerminalRemoteStatus>('terminal', 'applyRemote')
    if (status.value?.error) flash(status.value.error)
  } finally {
    busy.value = false
  }
}

/** 随机口令:16 位、去掉了容易看错的 0/O/1/l */
function newPassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    flash('已复制')
  } catch {
    flash('复制失败,请手动选中')
  }
}

onMounted(() => {
  void refresh()
  // 主进程的启停/监听状态变化(端口被占、插件停用…)实时反映到这一页
  unsubscribe = api.plugins.onEvent((ev) => {
    if (ev.id !== 'terminal' || ev.event !== 'remote-changed') return
    status.value = ev.args as TerminalRemoteStatus
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  if (noticeTimer) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <div v-if="remote" class="remote-settings">
    <p class="lead">
      在局域网里的手机 / 平板上用浏览器看住这台机器上的所有终端里的 <strong>pi</strong>:会话列表 + 对话
      (用户 / pi 气泡、工具调用、发送 / 插话 / 停止)。开启后同网段任何设备都能<strong>尝试</strong>连接 ——
      口令是唯一那道门,请设长一点。
    </p>

    <label class="row switch">
      <input
        type="checkbox"
        :checked="remote.enabled"
        :disabled="busy"
        @change="patch({ enabled: ($event.target as HTMLInputElement).checked })"
      />
      <span>启用远程控制</span>
    </label>

    <div class="row">
      <span class="label">监听</span>
      <select
        :value="remote.bind"
        :disabled="busy || !remote.enabled"
        @change="patch({ bind: ($event.target as HTMLSelectElement).value as 'loopback' | 'lan' })"
      >
        <option value="loopback">仅本机(127.0.0.1)</option>
        <option value="lan">局域网(0.0.0.0)</option>
      </select>
    </div>

    <div class="row">
      <span class="label">端口</span>
      <input
        class="port"
        type="number"
        :min="REMOTE_PORT_RANGE.min"
        :max="REMOTE_PORT_RANGE.max"
        :value="remote.port"
        :disabled="busy || !remote.enabled"
        @change="patch({ port: Number(($event.target as HTMLInputElement).value) })"
      />
    </div>

    <div class="row">
      <span class="label">口令</span>
      <div class="pwd">
        <input
          :type="showPassword ? 'text' : 'password'"
          :value="remote.password"
          :disabled="busy || !remote.enabled"
          spellcheck="false"
          @change="patch({ password: ($event.target as HTMLInputElement).value })"
        />
        <button :disabled="busy || !remote.enabled" @click="showPassword = !showPassword">
          {{ showPassword ? '隐藏' : '显示' }}
        </button>
        <button
          :disabled="busy || !remote.enabled"
          title="生成一个 16 位随机口令"
          @click="patch({ password: newPassword() })"
        >
          随机
        </button>
        <button :disabled="!remote.password" title="复制口令" @click="copy(remote.password)">复制</button>
      </div>
    </div>

    <p v-if="remote.enabled && remote.password.length < REMOTE_MIN_PASSWORD" class="warn">
      口令至少 {{ REMOTE_MIN_PASSWORD }} 位,否则不会启动。
    </p>

    <!-- 运行状态 -->
    <div v-if="remote.enabled" class="status" :class="{ bad: !status?.running }">
      <template v-if="status?.running">
        <div class="ok">正在运行</div>
        <div v-if="url" class="url-row">
          <code>{{ url }}</code>
          <button class="mini" @click="copy(url)">复制</button>
        </div>
        <div v-for="extra in status.lanUrls.slice(1)" :key="extra" class="url-row">
          <code>{{ extra }}</code>
          <button class="mini" @click="copy(extra)">复制</button>
        </div>
        <p class="tiny">
          在手机浏览器里打开上面的地址,输口令即可。手机要连同一个 WiFi。
          本次改动之前就开着的终端没有控制通道,重开一下终端即可。
        </p>
      </template>
      <template v-else>
        <div class="err">没有在运行</div>
        <p v-if="status?.error" class="tiny">{{ status.error }}</p>
      </template>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>

    <p class="tiny dim">
      局域网是 http,口令在链路上是<strong>明文</strong> —— 只在自己信得过的网络里开。公共 WiFi 请关掉。
    </p>
  </div>
</template>

<style scoped>
.remote-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
  max-width: 640px;
}
.lead {
  margin: 0;
  line-height: 1.6;
  opacity: 0.85;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.row.switch {
  gap: 8px;
}
.label {
  width: 56px;
  flex: none;
  opacity: 0.7;
}
input[type='checkbox'] {
  width: 16px;
  height: 16px;
}
select,
input[type='number'],
input[type='text'],
input[type='password'] {
  background: var(--bg, #1e1f24);
  color: inherit;
  border: 1px solid #3a3d48;
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
}
.port {
  width: 110px;
}
.pwd {
  display: flex;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.pwd input {
  flex: 1;
  min-width: 0;
  font-family: var(--mono, monospace);
}
.status {
  border: 1px solid #3a3d48;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.status.bad {
  border-color: #7a3b38;
}
.ok {
  color: #7ec96a;
  font-weight: 600;
}
.err {
  color: #e5534b;
  font-weight: 600;
}
.url-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.url-row code {
  background: rgba(255, 255, 255, 0.06);
  padding: 4px 8px;
  border-radius: 6px;
  font-family: var(--mono, monospace);
  user-select: all;
}
.mini {
  padding: 2px 8px;
  font-size: 12px;
}
.warn {
  color: #e2b93d;
  margin: 0;
}
.notice {
  margin: 0;
  color: #4a8ef7;
}
.tiny {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.dim {
  opacity: 0.6;
}
</style>
