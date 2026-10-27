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
import type { TerminalRemoteSettings, TerminalRemoteStatus, TerminalTailscaleStatus } from '../shared'
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

/** 「异地访问(Tailscale)」自检结果:主进程读 CLI,这里只展示 + 给出可复制的命令 */
const tailscale = ref<TerminalTailscaleStatus | null>(null)
const checking = ref(false)
const serveUrl = computed(() => tailscale.value?.serve?.url ?? '')
const serveCommand = computed(() => `tailscale serve --bg ${remote.value?.port ?? ''}`)
const installCommand = computed(() => 'winget install --id Tailscale.Tailscale -e')

async function checkTailscale(): Promise<void> {
  checking.value = true
  try {
    tailscale.value = await api.plugins.invoke<TerminalTailscaleStatus>('terminal', 'tailscaleStatus')
  } finally {
    checking.value = false
  }
}

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
  if (settings.remote.enabled) void checkTailscale()
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
    // 端口变了 → 之前那条 serve 可能不再指向本服务
    if (saved.remote.enabled) void checkTailscale()
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

    <!-- 异地访问(Tailscale):只读自检 + 可复制命令。不代用户改系统状态(登录/up/serve 都不做) -->
    <div v-if="remote.enabled" class="ts">
      <div class="ts-head">
        <span class="ts-title">异地访问(Tailscale)</span>
        <button class="mini" :disabled="checking" @click="checkTailscale()">
          {{ checking ? '检查中…' : '重新检查' }}
        </button>
      </div>

      <template v-if="tailscale?.state === 'running'">
        <div class="ts-line">
          <span class="ok">节点在线</span>
          <code class="chip">{{ tailscale?.host || tailscale?.ip4 }}</code>
          <span class="tiny dim">另有 {{ tailscale?.peers }} 台设备,其中手机 {{ tailscale?.phones }} 台</span>
        </div>
        <div v-if="tailscale?.serve" class="url-row">
          <code>{{ serveUrl }}</code>
          <button class="mini" @click="copy(serveUrl)">复制</button>
        </div>
        <template v-else>
          <p class="tiny">serve 还没指向本端口 —— 在装 tailscale 的那台机器上执行一次:</p>
          <div class="url-row">
            <code>{{ serveCommand }}</code>
            <button class="mini" @click="copy(serveCommand)">复制</button>
          </div>
        </template>
      </template>

      <template v-else-if="tailscale?.state === 'missing'">
        <p class="warn">那台机器上没装 Tailscale。装一次:</p>
        <div class="url-row">
          <code>{{ installCommand }}</code>
          <button class="mini" @click="copy(installCommand)">复制</button>
        </div>
      </template>

      <p v-else-if="tailscale?.state === 'needs-login'" class="warn">
        装了但还没登录 —— 点托盘栏的 Tailscale 图标登录一次。
      </p>
      <p v-else-if="tailscale?.state === 'stopped'" class="warn">
        Tailscale 没在跑(服务停了或已退出登录)。
      </p>
      <p v-else-if="tailscale?.error" class="tiny">{{ tailscale.error }}</p>
      <p v-else class="tiny dim">检查中…</p>
    </div>

    <details v-if="remote.enabled" class="help">
      <summary>使用说明</summary>
      <div class="help-body">
        <p><strong>同一个 WiFi</strong>:手机直接开上面的 <code>http://192.168.x.x:端口</code>,输口令。</p>
        <p>
          <strong>在外面(4G / 别人家 WiFi)</strong>:两台设备先组进同一个 tailnet ——
          电脑装 Tailscale 并登录,手机装 Tailscale 并登录<strong>同一个账号</strong>;然后在电脑上
          <code>tailscale serve --bg 端口</code>,手机开 <code>https://机器名.tailnet.ts.net</code>。
          上面那张卡片会自动显示这条地址。
        </p>
        <p>
          <strong>安全</strong>:这个端口后面是一台机器的交互式 shell。口令要长;别用
          <code>tailscale funnel</code>(那会把端口公开到互联网);MCP 的 <strong>8765</strong> 端口永远不许往外开。
        </p>
        <p class="dim">完整步骤与排障:仓库 <code>docs/REMOTE-ACCESS.md</code>。</p>
      </div>
    </details>

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
.ts {
  border: 1px solid #3a3d48;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ts-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ts-title {
  font-weight: 600;
  opacity: 0.9;
}
.ts-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.chip {
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 8px;
  border-radius: 6px;
  font-family: var(--mono, monospace);
  user-select: all;
}
.help {
  font-size: 12px;
  line-height: 1.6;
  border-top: 1px solid #2f323c;
  padding-top: 10px;
}
.help summary {
  cursor: pointer;
  opacity: 0.75;
}
.help-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
}
.help-body p {
  margin: 0;
}
.help-body code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--mono, monospace);
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
