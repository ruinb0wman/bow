<script setup lang="ts">
/**
 * 单个插件的设置弹窗(嵌套在设置面板之上的独立弹窗)。
 * 外壳(标题 / 关闭 / 滚动)由宿主提供,内容为插件 ui.ts 贡献的 settingsSections;
 * 插件设置组件保持「即时保存」语义,故此处只需「关闭」。
 */
import type { Component } from 'vue'
import { X } from 'lucide-vue-next'
import ModalShell from './ModalShell.vue'

defineProps<{ title: string; sections: Component[] }>()
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

function requestClose(): void {
  emit('overlay-event', 'close-request')
}
function onShellEvent(event: string, args?: unknown): void {
  emit('overlay-event', event, args)
}
</script>

<template>
  <ModalShell layer="nested" @overlay-event="onShellEvent">
    <div class="panel-plugin-settings">
      <div class="modal-head">
        <span>{{ title }} · 设置</span>
        <button class="win-btn" title="关闭" @click="requestClose"><X :size="13" /></button>
      </div>
      <div class="plugin-settings-body">
        <component v-for="(C, i) in sections" :is="C" :key="`ps-${i}`" />
      </div>
      <div class="set-actions">
        <button class="btn" @click="requestClose">关闭</button>
      </div>
    </div>
  </ModalShell>
</template>
