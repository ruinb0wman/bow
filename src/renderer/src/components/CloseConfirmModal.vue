<script setup lang="ts">
/**
 * 关闭窗口确认(核心 full 浮层):主进程在窗口 close 时拦下并打开它,见 main/closeConfirm.ts。
 *
 * 只负责两件事:
 * - 「关闭窗口」→ 回传 'confirm'(主进程置位后放行 close);
 * - 「取消」/ Esc / 点遮罩 → 回传 'close-request'(现有通用分支关闭浮层,窗口不关)。
 */
import { onMounted, ref } from 'vue'
import type { CloseConfirmPayload } from '@shared/types'
import ModalShell from '@renderer/components/ModalShell.vue'

const props = defineProps<{ payload: CloseConfirmPayload }>()
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()
// 宿主(OverlayApp)无条件传 band-top;本弹层是 full placement,bandTop 恒为 0,别让它落到根元素上
defineOptions({ inheritAttrs: false })

const cancelBtn = ref<HTMLButtonElement | null>(null)

function onShellEvent(event: string, args?: unknown): void {
  emit('overlay-event', event, args)
}
function cancel(): void {
  emit('overlay-event', 'close-request')
}
function confirm(): void {
  emit('overlay-event', 'confirm')
}

// 默认焦点给「取消」:回车不该顺手把窗口(和全部标签页)关掉
onMounted(() => cancelBtn.value?.focus())
</script>

<template>
  <ModalShell @overlay-event="onShellEvent">
    <div class="modal-head">关闭窗口?</div>
    <div class="cc-body">
      当前有 <strong>{{ props.payload.tabCount }}</strong> 个标签页,关闭后会一并关闭;bow
      不保存会话,重启后不会恢复。
    </div>
    <div class="cc-actions">
      <button ref="cancelBtn" class="btn" @click="cancel">取消</button>
      <button class="btn primary" @click="confirm">关闭窗口</button>
    </div>
  </ModalShell>
</template>

<style scoped>
.cc-body {
  max-width: 340px;
  padding: 12px 14px;
  color: var(--fg);
  font-size: 13px;
  line-height: 1.6;
}

.cc-body strong {
  color: var(--accent);
}

.cc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 14px 14px;
}
</style>
