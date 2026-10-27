<script setup lang="ts">
/**
 * 通用弹层外壳(供各 modal 浮层内容复用):全屏遮罩 + 居中面板 + Esc/点遮罩关闭。
 * 关闭统一通过发 'close-request' 事件,由宿主转给 chrome 侧决定。
 *
 * 层叠行为交给库的 `useOverlayLayer`(原来是自己维护的 modalStack):
 * 模块级浮层层栈保证 Esc 只关闭最上层弹窗,同时带来焦点进层 + Tab 循环 + 滚动锁,
 * z-index = --z-modal + 层号,所以「面板内嵌套弹窗」不用改 Overlay 宿主。
 */
import { ref } from 'vue'
import { useOverlayLayer } from '@ruinb0w/ui'

const props = withDefaults(defineProps<{ layer?: 'base' | 'nested' }>(), { layer: 'base' })

const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

const root = ref<HTMLElement>()
const visible = ref(true)

function requestClose(): void {
  emit('overlay-event', 'close-request')
}

const { zIndex } = useOverlayLayer({ visible, container: root, onEscape: requestClose })
</script>

<template>
  <div
    class="modal-mask"
    :class="{ nested: props.layer === 'nested' }"
    :style="{ zIndex }"
    @click.self="requestClose"
  >
    <div ref="root" class="modal">
      <slot />
    </div>
  </div>
</template>
