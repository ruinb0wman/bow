<script setup lang="ts">
/**
 * 通用弹层外壳(供各 modal 浮层内容复用):全屏遮罩 + 居中面板 + Esc/点遮罩关闭。
 * 关闭统一通过发 'close-request' 事件,由宿主转给 chrome 侧决定。
 *
 * 支持同页嵌套(layer='nested'):模块级弹层栈保证 Esc 只关闭最上层弹窗,
 * 内层遮罩更浅、层级更高,从而「面板内嵌套弹窗」无需改动 Overlay 宿主。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { MODAL_STACK, isTopmost } from '../lib/modalStack'

const props = withDefaults(defineProps<{ layer?: 'base' | 'nested' }>(), { layer: 'base' })

const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

const self = Symbol('modal')

function requestClose(): void {
  emit('overlay-event', 'close-request')
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (!isTopmost(MODAL_STACK, self)) return
  e.preventDefault()
  requestClose()
}

onMounted(() => {
  MODAL_STACK.push(self)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  const i = MODAL_STACK.lastIndexOf(self)
  if (i >= 0) MODAL_STACK.splice(i, 1)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="modal-mask" :class="{ nested: props.layer === 'nested' }" @click.self="requestClose">
    <div class="modal">
      <slot />
    </div>
  </div>
</template>
