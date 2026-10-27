<script setup lang="ts">
/**
 * 「用编辑器打开…」工具栏按钮:白名单之外的文件(比如 .html、无扩展名)的唯一入口
 * —— 不做全局 `*\shell` 右键菜单的代价就靠它补回来。
 * 选完文件由主进程开编辑器标签(`plugins.invoke('editor','pickFile')`);这里只把结果反馈到 title。
 */
import { RButton } from '@ruinb0w/ui'
import { ref } from 'vue'
import { FileCode2 } from '@lucide/vue'

const api = window.browserAPI
const LABEL = '用编辑器打开…'
const title = ref(LABEL)
let timer: number | undefined

async function open(): Promise<void> {
  const res = await api.plugins.invoke<{ ok: boolean; canceled?: boolean; opened?: number; error?: string }>(
    'editor',
    'pickFile'
  )
  if (res?.error) title.value = `打不开:${res.error}`
  else if (res?.opened) title.value = `已打开 ${res.opened} 个文件`
  else return // 取消:不动 title
  if (timer) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    title.value = LABEL
  }, 3000)
}
</script>

<template>
  <RButton text circle size="default" class="no-drag" :title="title" @click="open">
    <FileCode2 :size="16" />
  </RButton>
</template>
