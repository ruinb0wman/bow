<script setup lang="ts">
/**
 * 通用弹层外壳(供各 modal 浮层内容复用):全屏遮罩 + 居中面板 + Esc/点遮罩关闭。
 * 关闭统一通过发 'close-request' 事件,由宿主转给 chrome 侧决定。
 */
import { onBeforeUnmount, onMounted } from 'vue'

const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

function requestClose(): void {
  emit('overlay-event', 'close-request')
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') requestClose()
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="modal-mask" @click.self="requestClose">
    <div class="modal">
      <slot />
    </div>
  </div>
</template>