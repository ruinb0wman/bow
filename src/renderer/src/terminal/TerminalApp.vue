<script setup lang="ts">
/**
 * `bow://terminal` 页面外壳。
 * 真正的内容在插件目录里的 `TerminalView.vue`(与设置页的插件分区同源),
 * 这里留一层壳是为了以后放标题条 / 多会话切换时不必动视图本身。
 */
import TerminalView from '@plugins/terminal/ui/TerminalView.vue'
</script>

<template>
  <TerminalView />
</template>
