<script setup lang="ts">
/**
 * 一个**渲染行**:把 `analyzeBlockLines()` 出来的结构标记(标题 / 复选框 / 引用 / 列表 / 水平线 /
 * 围栏代码)画出来,剩余的文本交给 `BlockText` 做行内 token 渲染(双链可点)。
 *
 * 组件**不改数据**:复选框只 emit `toggle-task`,由 `BlockRow` → `JournalView` 换成编辑命令。
 * 标记行(`#` / `>` / `* [ ]` / ``` 围栏行)的原文不显示 —— 它们是结构,不是正文。
 */
import { computed } from 'vue'
import type { RenderedLine } from '@plugins/logseq/shared'
import BlockText from './BlockText.vue'

defineOptions({ name: 'MarkdownLine' })

const props = defineProps<{ line: RenderedLine; lineIndex: number }>()
const emit = defineEmits<{
  (e: 'open-page', name: string): void
  (e: 'open-url', url: string): void
  (e: 'toggle-task', lineIndex: number): void
}>()

const mark = computed(() => props.line.mark)
</script>

<template>
  <template v-if="mark.kind === 'fence'">
    <div v-if="mark.role === 'content'" class="md-code-line">
      <BlockText :tokens="line.tokens" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
    </div>
  </template>

  <div v-else-if="mark.kind === 'heading'" class="md-heading" :class="`md-h${mark.level ?? 1}`">
    <BlockText :tokens="line.tokens" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
  </div>

  <label v-else-if="mark.kind === 'task'" class="md-task" :class="{ done: mark.checked }">
    <input
      type="checkbox"
      :checked="mark.checked === true"
      :title="mark.checked ? '取消勾选' : '勾选'"
      @click.stop
      @change.stop="emit('toggle-task', lineIndex)"
    />
    <span class="md-task-text">
      <BlockText :tokens="line.tokens" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
    </span>
  </label>

  <blockquote
    v-else-if="mark.kind === 'quote'"
    class="md-quote"
    :style="{ marginLeft: `${((mark.depth ?? 1) - 1) * 12}px` }"
  >
    <BlockText :tokens="line.tokens" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
  </blockquote>

  <div v-else-if="mark.kind === 'bullet' || mark.kind === 'ordered'" class="md-li">
    <span class="md-marker">{{ mark.kind === 'ordered' ? mark.marker : '•' }}</span>
    <BlockText :tokens="line.tokens" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
  </div>

  <hr v-else-if="mark.kind === 'hr'" class="md-hr" />

  <BlockText v-else :tokens="line.tokens" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
</template>

<style scoped>
.md-heading {
  font-weight: 600;
  line-height: 1.35;
}

.md-h1 {
  font-size: 1.5em;
}

.md-h2 {
  font-size: 1.3em;
}

.md-h3 {
  font-size: 1.15em;
}

.md-task {
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
}

.md-task input {
  flex: none;
  margin: 4px 0 0;
  cursor: pointer;
}

.md-task.done .md-task-text {
  color: var(--fg-dim);
  text-decoration: line-through;
}

.md-quote {
  margin: 0;
  padding: 0 0 0 8px;
  color: var(--fg-dim);
  border-left: 3px solid var(--border);
}

.md-li {
  display: flex;
  gap: 6px;
}

.md-marker {
  flex: none;
  min-width: 1em;
  color: var(--fg-dim);
}

.md-hr {
  margin: 6px 0;
  border: none;
  border-top: 1px solid var(--border);
}

.md-code-line {
  padding: 0 4px;
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 0.92em;
  background: var(--bg3);
}
</style>
