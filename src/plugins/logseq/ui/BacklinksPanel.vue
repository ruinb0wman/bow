<script setup lang="ts">
/**
 * 反链面板(「Linked References」):哪些文件里的哪些块引用了当前页。
 *
 * 刻意与 Logseq 保持一致的取舍:**不显示文件自己的引用**(自引用单列在 Logseq 里是另一种语义),
 * 日志(days)排在前面按日期倒序,页面按标题排序;点一条 = 跳到那个文件。
 */
import type { Backlinks } from '@plugins/logseq/graph'

defineProps<{ links: Backlinks | null; loading: boolean }>()
const emit = defineEmits<{ (e: 'open-page', name: string): void }>()
</script>

<template>
  <section class="backlinks">
    <header class="backlinks-head">
      <span class="backlinks-title">反向链接</span>
      <span class="backlinks-count">{{ loading ? '…' : (links?.total ?? 0) }}</span>
    </header>

    <p v-if="!loading && (links?.total ?? 0) === 0" class="backlinks-empty">
      还没有别的块引用这一页。在别的块里写 <code>[[{{ '页面名' }}]]</code> 或 <code>#标签</code> 就会出现在这里。
    </p>

    <div v-for="group in links?.groups ?? []" :key="group.rel" class="backlinks-group">
      <button class="backlinks-source" :title="group.rel" @click="emit('open-page', group.title)">
        {{ group.title }}
        <span v-if="group.day" class="backlinks-kind">日志</span>
      </button>
      <ul class="backlinks-blocks">
        <li v-for="block in group.blocks" :key="`${group.rel}:${block.line}`">
          <span class="backlinks-bullet"></span>
          <span class="backlinks-text">{{ block.text }}</span>
          <span class="backlinks-line">L{{ block.line }}</span>
        </li>
      </ul>
    </div>

    <p v-if="links && links.total > (links.groups.flatMap((g) => g.blocks).length ?? 0)" class="backlinks-more">
      只显示了前 {{ links.groups.flatMap((g) => g.blocks).length }} 条,共 {{ links.total }} 条
    </p>
  </section>
</template>

<style scoped>
.backlinks {
  margin-top: 28px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.backlinks-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.backlinks-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
  text-transform: uppercase;
}

.backlinks-count {
  font-size: 11px;
  color: var(--fg-dim);
}

.backlinks-empty {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
}

.backlinks-group + .backlinks-group {
  margin-top: 10px;
}

.backlinks-source {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
}

.backlinks-kind {
  padding: 0 4px;
  font-size: 10px;
  font-weight: 400;
  color: var(--fg-dim);
  background: var(--bg3);
  border-radius: 3px;
}

.backlinks-blocks {
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}

.backlinks-blocks li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 1px 0 1px 12px;
  font-size: 12.5px;
  color: var(--fg);
}

.backlinks-bullet {
  flex: none;
  width: 5px;
  height: 5px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--fg-dim);
}

.backlinks-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backlinks-line {
  flex: none;
  font-size: 10px;
  color: var(--fg-dim);
}

.backlinks-more {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--fg-dim);
}

code {
  padding: 1px 4px;
  background: var(--bg3);
  border-radius: 3px;
}
</style>
