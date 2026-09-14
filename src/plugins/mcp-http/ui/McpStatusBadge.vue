<script setup lang="ts">
/**
 * 工具栏里的 MCP 状态灯(由 mcp-http 插件贡献到 toolbar 插槽,位于书签按钮右侧)。
 *
 * 三态(优先级从高到低):
 * - 调用中(蓝 + 脉冲)—— 有在途的 MCP 工具调用;
 * - 就绪(白)—— HTTP 端点监听中、当前空闲;
 * - 已停用(灰)—— 端点未运行(点过停用 / 启动失败 / 依赖未就绪)。
 *
 * 点击在「停用 / 启用」之间切换端点;插件本身保持启用,设置页分区与工具声明都不受影响。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { McpHttpState } from '@plugins/mcp-http/shared'

const api = window.browserAPI
const state = ref<McpHttpState | null>(null)
const busy = ref(false)
const unsubs: Array<() => void> = []

type Phase = 'active' | 'idle' | 'off'

const phase = computed<Phase>(() => {
  if (!state.value) return 'idle' // 首帧还没拿到状态:默认按就绪渲染,避免闪一下灰
  if (state.value.activity.inFlight > 0) return 'active'
  if (!state.value.status.running) return 'off'
  return 'idle'
})

/** 环境变量强制开启的实例,插件停不掉:点击时给出明确反馈而不是静默无反应 */
const forced = computed(() => !!state.value?.status.forced)

const title = computed(() => {
  const s = state.value
  if (!s) return 'MCP 状态加载中…'
  const act = s.activity
  if (act.inFlight > 0) return `MCP 正在调用 ${act.lastTool ?? '工具'}(${act.inFlight} 个在途)`
  if (s.status.running) {
    const lines = [`MCP HTTP 端点运行中 · ${s.status.url ?? '监听中'}`]
    if (forced.value) {
      lines.push('由 MCP_HTTP 环境变量强制开启,插件开关管不了它')
    } else {
      lines.push('点击停用端点(仅本次运行,重启 bow 后恢复默认开启)')
      lines.push('要长期关闭请去 bow://settings → 插件管理')
    }
    if (act.calls > 0) lines.push(`累计调用 ${act.calls} 次`)
    return lines.join('\n')
  }
  if (!s.status.ready) return 'MCP 端点等待浏览器就绪'
  if (s.status.error) return `MCP 端点未运行:${s.status.error}\n点击启用(会按设置页的端口重试)`
  return 'MCP HTTP 端点已停用\n点击启用'
})

async function toggle(): Promise<void> {
  if (busy.value) return
  if (state.value?.status.running && forced.value) return
  busy.value = true
  try {
    state.value = await api.plugins.invoke<McpHttpState>('mcp-http', 'toggle')
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  state.value = await api.plugins.invoke<McpHttpState>('mcp-http', 'getState')
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id === 'mcp-http' && ev.event === 'changed') state.value = ev.args as McpHttpState
    })
  )
})
onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <button
    class="mcp-pill no-drag"
    :class="phase"
    :title="title"
    :aria-label="`MCP 状态:${phase === 'active' ? '调用中' : phase === 'idle' ? '就绪' : '已停用'}`"
    @click="toggle"
  >
    <span class="mcp-dot" />
    <span class="mcp-text">MCP</span>
  </button>
</template>

<style scoped>
.mcp-pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius, 6px);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  transition: background 0.15s ease;
}

/* 与同一排的 .tool-btn 一致:工具栏底色是 --bg2,悬停要用 --bg3 才看得见 */
.mcp-pill:hover {
  background: var(--bg3, #2e3038);
}

.mcp-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  transition: background 0.15s ease;
}

/* 就绪:白 */
.mcp-pill.idle {
  color: #fff;
}

.mcp-pill.idle .mcp-dot {
  background: #fff;
}

/* 调用中:蓝 + 脉冲 */
.mcp-pill.active {
  color: var(--accent, #4a8ef7);
}

.mcp-pill.active .mcp-dot {
  background: var(--accent, #4a8ef7);
  animation: mcp-pulse 1s ease-in-out infinite;
}

/* 已停用:灰 */
.mcp-pill.off {
  color: var(--fg-dim, #9aa0ad);
}

.mcp-pill.off .mcp-dot {
  background: var(--fg-dim, #9aa0ad);
}

@keyframes mcp-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.3;
    transform: scale(0.7);
  }
}
</style>
