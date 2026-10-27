<script setup lang="ts">
/** 「新终端」入口按钮(终端插件贡献到 toolbar 插槽):每次点击开一个新标签 = 一个新会话 */
import { RButton } from '@ruinb0w/ui'
import { SquareTerminal } from '@lucide/vue'
import { TERMINAL_URL } from '@shared/internalPages'

const api = window.browserAPI

function open(): void {
  void api.createTab(TERMINAL_URL)
}
</script>

<template>
  <RButton text circle size="default" class="no-drag" title="新终端(本机 shell)" @click="open">
    <SquareTerminal :size="16" />
  </RButton>
</template>
