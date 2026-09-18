<script setup lang="ts">
/** 「设备检查」入口按钮(设备检查插件贡献到 toolbar 插槽) */
import { Smartphone } from 'lucide-vue-next'

const api = window.browserAPI

function open(): void {
  void api.showOverlay({ id: 'plugin:device-inspect:panel', payload: undefined, placement: 'full' })
}
</script>

<template>
  <button class="tool-btn no-drag" title="设备检查(调试手机 WebView / Chrome)" @click="open">
    <Smartphone :size="16" />
  </button>
</template>
