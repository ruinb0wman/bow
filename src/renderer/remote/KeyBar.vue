<script setup lang="ts">
/**
 * 手机按键条:软键盘发不出来的那些键。
 *
 * 两种用法:
 * - **快捷键**(Esc/Tab/方向/Ctrl+C…):直接发固定序列 —— 手机上最常用,一下就是一下;
 * - **粘滞修饰键**(Ctrl / Alt):点亮后,**下一个进来的字符**被改写(`keys.ts` 的 applyModifiers),
 *   于是「Ctrl 亮着 + 在终端里敲 c」也能得到 `\x03`,不必给 26 个字母各排一个键。
 *
 * 状态由父组件持有(它与 xterm 的 onData 出口在一起),这里只负责显示与点击。
 */
import { QUICK_KEYS } from './keys'

defineProps<{ ctrl: boolean; alt: boolean }>()
const emit = defineEmits<{ 'update:ctrl': [boolean]; 'update:alt': [boolean]; send: [string]; paste: [] }>()
</script>

<template>
  <div class="keybar">
    <button
      class="key mod"
      :class="{ on: ctrl }"
      title="粘滞 Ctrl:点亮后下一个字符按 Ctrl 组合发送"
      @click="emit('update:ctrl', !ctrl)"
    >
      Ctrl
    </button>
    <button
      class="key mod"
      :class="{ on: alt }"
      title="粘滞 Alt:点亮后下一个字符带上 ESC 前缀"
      @click="emit('update:alt', !alt)"
    >
      Alt
    </button>
    <button v-for="key in QUICK_KEYS" :key="key.label" class="key" :title="key.title" @click="emit('send', key.data)">
      {{ key.label }}
    </button>
    <button class="key" title="从剪贴板粘贴(需要一次点击授权)" @click="emit('paste')">粘贴</button>
  </div>
</template>

<style scoped>
.keybar {
  display: flex;
  gap: 6px;
  padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
  overflow-x: auto;
  background: #202127;
  border-top: 1px solid #33353f;
  touch-action: pan-x;
}
.key {
  flex: none;
  min-width: 44px;
  padding: 0 10px;
  font-family: var(--mono);
  font-size: 13px;
  background: #2c2e36;
}
.key.mod.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
</style>
