<script setup lang="ts">
/**
 * MCP HTTP 服务设置分区。
 *
 * 插件的启停由「插件管理」的开关负责(停用即关闭端点),这里只管监听参数与状态:
 * 端口 / 令牌改动即时保存并重启服务;环境变量强制开启的实例会明确标出「插件开关管不了它」。
 */
import { RButton, RFormRow } from '@ruinb0w/ui'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RefreshCw } from '@lucide/vue'
import type { McpHttpState } from '../shared'

const api = window.browserAPI
const state = ref<McpHttpState | null>(null)
const portDraft = ref('')
const busy = ref(false)
const unsubs: Array<() => void> = []

function apply(next: McpHttpState): void {
  state.value = next
  portDraft.value = String(next.settings.port)
}

async function save(patch: { port?: number; token?: string }): Promise<void> {
  busy.value = true
  try {
    apply(await api.plugins.invoke<McpHttpState>('mcp-http', 'setSettings', patch))
  } finally {
    busy.value = false
  }
}

function savePort(): void {
  void save({ port: Number.parseInt(portDraft.value, 10) })
}

async function restart(): Promise<void> {
  busy.value = true
  try {
    apply(await api.plugins.invoke<McpHttpState>('mcp-http', 'restart'))
  } finally {
    busy.value = false
  }
}

function saveToken(e: Event): void {
  void save({ token: (e.target as HTMLInputElement).value })
}

onMounted(async () => {
  apply(await api.plugins.invoke<McpHttpState>('mcp-http', 'getState'))
  unsubs.push(api.plugins.onEvent((ev) => {
    if (ev.id === 'mcp-http' && ev.event === 'changed') apply(ev.args as McpHttpState)
  }))
})
onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <RFormRow label="运行状态">
    <span class="mcp-status">
      <span v-if="state?.status.running" class="mcp-dot on" />
      <span v-else class="mcp-dot" />
      <template v-if="state?.status.running">
        监听中 · {{ state.status.url }}
      </template>
      <template v-else-if="!state?.status.ready">等待浏览器就绪</template>
      <template v-else>未运行(已停用或启动失败)</template>
      <span v-if="state?.status.forced" class="mcp-badge" title="由 MCP_HTTP 环境变量强制开启">强制</span>
    </span>
  </RFormRow>
  <RFormRow v-if="state?.status.error" label="启动失败" align="start">
    <div class="mcp-error">{{ state.status.error }}</div>
  </RFormRow>
  <RFormRow label="端口">
    <input
      v-model="portDraft"
      class="pbm-input mcp-port"
      inputmode="numeric"
      @keydown.enter.prevent="savePort"
      @blur="savePort"
    />
    <RButton size="small" :disabled="busy" title="按当前端口与令牌重启服务" @click="restart">
      <RefreshCw :size="13" /> 重启
    </RButton>
  </RFormRow>
  <RFormRow label="Bearer 令牌">
    <input
      :value="state?.settings.token ?? ''"
      class="pbm-input mcp-token"
      placeholder="留空表示不需要令牌(仅回环地址)"
      @keydown.enter.prevent="saveToken($event)"
      @blur="saveToken"
    />
  </RFormRow>
  <RFormRow align="start">
    <div class="pbm-tools hint">
      端点默认开启:bow 启动后插件会自动监听上面的地址,AI 工具直接连
      <code>http://127.0.0.1:{{ state?.settings.port ?? state?.defaultPort }}/mcp</code> 即可,
      不需要先跑 <code>npm run mcp:http</code>。想彻底关闭就停用「MCP HTTP 服务」插件,
      或直接点地址栏右侧工具栏里的 MCP 状态灯(白=就绪、蓝=正在被调用、灰=已停用)。
      令牌非空时所有请求都必须带 <code>Authorization: Bearer &lt;令牌&gt;</code>。
    </div>
  </RFormRow>
  <RFormRow align="start">
    <div class="pbm-tools hint">
      接进 pi:在 bow 仓库跑 <code>npm run mcp:install -- --http --direct-core</code> ——
      它写 <code>~/.pi/agent/mcp.json</code> 的 <code>browser</code> 条目(核心 6 个工具为原生工具,其余走 codemode),
      并把 <code>bow-browser</code> skill 装到 <code>~/.pi/agent/skills/</code>(工具怎么用、怎么选看那份 skill)。
      只改配置不装 skill 就加 <code>--no-skill</code>;要删干净用 <code>--remove</code>。
      端口或令牌变了要重跑一次,再重启 pi 才会用新配置。
    </div>
  </RFormRow>
</template>

<style scoped>
.mcp-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-dim, #888);
}
.mcp-status code {
  font-size: 11px;
}
.mcp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-dim, #888);
  flex: none;
}
.mcp-dot.on {
  background: #35c46a;
}
.mcp-badge {
  padding: 0 5px;
  border: 1px solid var(--border, #444);
  border-radius: 3px;
  font-size: 10px;
}
.mcp-error {
  font-size: 12px;
  color: var(--danger, #e05a5a);
  word-break: break-all;
}
.mcp-port {
  width: 90px;
}
.mcp-token {
  width: 260px;
}
</style>
