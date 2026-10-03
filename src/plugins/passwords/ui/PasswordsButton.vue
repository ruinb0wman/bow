<script setup lang="ts">
/**
 * 密码入口按钮(toolbar 插槽)。
 *
 * 点击走主进程的 `beginFill`:能填就直接填(多条匹配时弹页内下拉);
 * 需要用户介入的结局(未创建 / 已锁定 / 当前页没表单 / 没有匹配)会返回一个 mode,
 * 由本组件打开密码面板。`Ctrl+Shift+P` 走同一套流程 —— 但快捷键在主进程,
 * 它发 `open-panel` 事件,同样由本组件负责开浮层(主进程不能直接开 overlay)。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { KeyRound } from 'lucide-vue-next'
import type { BeginFillResult } from '../shared'

const api = window.browserAPI
const unsubs: Array<() => void> = []

/** 这些结局需要把面板打开,人才能在面板里继续 */
const OPEN_MODES = new Set(['setup', 'unlock', 'save', 'no-form', 'no-match'])

function openPanel(mode?: string, tabId?: number): void {
  void api.showOverlay({
    id: 'plugin:passwords:panel',
    payload: { mode, tabId },
    placement: 'full'
  })
}

async function onClick(): Promise<void> {
  const res = await api.plugins.invoke<BeginFillResult>('passwords', 'beginFill')
  if (res?.mode && OPEN_MODES.has(res.mode)) openPanel(res.mode)
}

onMounted(() => {
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'passwords' || ev.event !== 'open-panel') return
      const args = ev.args as { mode?: string; tabId?: number } | undefined
      openPanel(args?.mode, args?.tabId)
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <button
    class="tool-btn no-drag"
    title="密码:填充当前页 / 打开密码库(Ctrl+Shift+P)"
    @click="onClick"
  >
    <KeyRound :size="16" />
  </button>
</template>
