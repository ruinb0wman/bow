<script setup lang="ts">
/**
 * `bow://logseq` 页面外壳。
 * 真正的内容在插件目录里的 `JournalView.vue`(与设置页的插件分区同源),
 * 这里留一层壳是为了以后放标题条 / 多窗口切换时不必动视图本身 —— 与 `bow://terminal` 同款结构。
 */
import JournalView from '@plugins/logseq/ui/JournalView.vue'
</script>

<template>
  <JournalView />
</template>
