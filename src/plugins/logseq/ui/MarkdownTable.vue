<script setup lang="ts">
/**
 * 一张表格:`analyzeBlockLines()` 出来的**连续表格行** → 真 `<table>`。
 *
 * 为什么要有这个组件:表格行必须整组渲染成同一个 `<table>`(单个 `<tr>` 脱离表格上下文画不出对齐的列),
 * 所以 `BlockRow` 先用 `groupBlockLines()` 把渲染行分组,再把表格组整组交给这里。
 *
 * 三条约定:
 * - **分隔行不画**(`role === 'delim'`):它只提供每列的 `align`;
 * - 每行 `<tr>` 带 `data-line` / `data-base` / `data-end` —— `BlockRow.startEdit()` 的
 *   `target.closest('[data-line]')` 因此照旧命中,点单元格时光标落**该表格行的行尾**;
 * - 短行补空单元格、多出来的单元格**照画** —— 渲染不截断内容(文件本来就不该被这个组件改写)。
 */
import { computed } from 'vue'
import type { RenderedLine, TableCell } from '@plugins/logseq/shared'
import BlockText from './BlockText.vue'

defineOptions({ name: 'MarkdownTable' })

const props = defineProps<{ rows: RenderedLine[] }>()
const emit = defineEmits<{
  (e: 'open-page', name: string): void
  (e: 'open-url', url: string): void
}>()

const header = computed(() => props.rows.find((row) => row.mark.role === 'header') ?? null)
const delim = computed(() => props.rows.find((row) => row.mark.role === 'delim') ?? null)
const body = computed(() => props.rows.filter((row) => row.mark.role === 'row'))
/** 每列的对齐(分隔行说了算) */
const aligns = computed(() => (delim.value?.mark.cells ?? []).map((cell) => cell.align))

/** 列数 = 分隔行的列数;行里出现更多单元格时以后者为准(渲染不丢内容) */
const columns = computed(() => {
  const fromDelim = aligns.value.length
  const maxCells = props.rows.reduce((max, row) => Math.max(max, row.mark.cells?.length ?? 0), 0)
  return Math.max(fromDelim, maxCells)
})

function cells(row: RenderedLine): TableCell[] {
  const list = row.mark.cells ?? []
  if (list.length >= columns.value) return list
  const padAt = row.base + row.text.length
  const out = [...list]
  for (let i = list.length; i < columns.value; i++) {
    out.push({ text: '', srcStart: padAt, srcEnd: padAt, align: aligns.value[i] ?? null, tokens: [] })
  }
  return out
}
</script>

<template>
  <div class="md-table-wrap">
    <table class="md-table">
      <thead v-if="header">
        <tr
          :data-line="header.index"
          :data-base="header.base"
          :data-end="header.base + header.text.length"
        >
          <th
            v-for="(cell, ci) in cells(header)"
            :key="ci"
            :style="cell.align ? { textAlign: cell.align } : undefined"
          >
            <BlockText :tokens="cell.tokens" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in body"
          :key="row.index"
          :data-line="row.index"
          :data-base="row.base"
          :data-end="row.base + row.text.length"
        >
          <td
            v-for="(cell, ci) in cells(row)"
            :key="ci"
            :style="cell.align ? { textAlign: cell.align } : undefined"
          >
            <BlockText :tokens="cell.tokens" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.md-table-wrap {
  margin: 2px 0;
  overflow-x: auto;
}

.md-table {
  border-collapse: collapse;
  font-size: 0.95em;
}

.md-table th,
.md-table td {
  max-width: 32em;
  padding: 2px 8px;
  text-align: left;
  vertical-align: top;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid var(--border);
}

.md-table th {
  font-weight: 600;
  background: var(--bg2);
}
</style>
