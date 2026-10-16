<script setup lang="ts">
/**
 * 「牧群」入口按钮(toolbar 插槽):一眼看住全部终端会话,并弹出面板。
 *
 * 与「新终端」按钮的区别:那个是**开**一个会话,这个是**看**所有会话。
 * 按钮自己带状态 —— 有代理在等用户时亮起并显示数量(角标只在那个标签上,切到别的标签就看不见了),
 * 这正是面板存在的理由:不用逐个标签去翻。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Boxes } from 'lucide-vue-next'
import { TERMINAL_EVENTS, sortSessionsByAttention } from '../shared'
import type { SessionInfo } from '../shared'

const api = window.browserAPI

const sessions = ref<SessionInfo[]>([])
let unsubscribe: (() => void) | null = null

const blocked = computed(() => sessions.value.filter((s) => s.agent?.state === 'blocked').length)
const working = computed(() => sessions.value.filter((s) => s.agent?.state === 'working').length)

const title = computed(() => {
  if (sessions.value.length === 0) return '牧群:还没有终端会话(点击打开面板)'
  const parts = [`共 ${sessions.value.length} 个终端`]
  if (blocked.value > 0) parts.push(`${blocked.value} 个在等你`)
  else if (working.value > 0) parts.push(`${working.value} 个在跑`)
  return `牧群:${parts.join(' · ')}(点击打开面板)`
})

/** 拉一次全量台账(面板/按钮两条路都要,抽出来避免两处各写一遍过滤逻辑) */
async function refresh(): Promise<void> {
  try {
    sessions.value = await api.plugins.invoke<SessionInfo[]>('terminal', 'listSessions')
  } catch {
    sessions.value = [] // 插件停用 / 内核未就绪:安静下来,别在工具栏上弹错误
  }
}

function openPanel(): void {
  void api.showOverlay({ id: 'plugin:terminal:herd', placement: 'full', payload: undefined })
}

onMounted(() => {
  void refresh()
  unsubscribe = api.plugins.onEvent((ev) => {
    if (ev.id !== 'terminal' || ev.event !== TERMINAL_EVENTS.sessionsChanged) return
    sessions.value = (ev.args as SessionInfo[]) ?? []
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>

<template>
  <button
    class="tool-btn no-drag herd-btn"
    :class="{ blocked: blocked > 0, working: blocked === 0 && working > 0 }"
    :title="title"
    @click="openPanel"
  >
    <Boxes :size="16" />
    <span v-if="blocked > 0" class="herd-count">{{ blocked }}</span>
    <span v-else-if="sessions.length > 0" class="herd-count muted">{{ sessions.length }}</span>
  </button>
</template>

<style scoped>
.herd-btn {
  width: auto;
  min-width: 30px;
  padding: 0 6px;
  gap: 3px;
}
.herd-count {
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.herd-count.muted {
  opacity: 0.55;
}
/* 有代理在等用户:必须显眼(与标签角标的 blocked 同一档语义) */
.herd-btn.blocked {
  color: #fff;
  background: var(--accent);
}
.herd-btn.working {
  color: var(--accent);
}
</style>
