<script setup lang="ts">
/**
 * 一个块:圆点 + 折叠箭头 + 「渲染态 / 就地编辑态」。
 *
 * 交互(计划 §3.7):
 * - 渲染态点一下 → 就地进入编辑态,光标落到**点中的那个 token 的原文偏移**(token 上带 `data-src`,
 *   这就是手写 tokenizer 而不是用 markdown 库的第二个理由);
 * - 编辑态是一个 textarea,内容是块的**全部正文行**(多行内容也在里面),Enter/Tab/Backspace 全部
 *   交给上层换算成块操作;`Shift+Enter` 才真的换行;
 * - `[[` / `#[[` 输入中给出页面补全(数据源是上图索引,由上层注入 `suggest`);
 * - `Esc` 退出编辑态。
 *
 * 组件本身**不改数据**,只 emit 意图 —— 状态与保存策略全在 `JournalView` 里。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { blockLinesForDisplay, type BlockNode } from '@plugins/logseq/shared'
import type { PageHit } from '@plugins/logseq/graph'
import BlockText from './BlockText.vue'

const props = defineProps<{
  block: BlockNode
  depth: number
  unit: string
  /** 系统属性名(渲染时隐藏,文件里照旧保留) */
  hiddenProps: readonly string[]
  editing: boolean
  /** 进入编辑态时要落的 caret 偏移(null = 末尾) */
  caretIntent: number | null
  collapsed: boolean
  childCount: number
  /** 页面补全的数据源(上图索引) */
  suggest: (query: string) => Promise<PageHit[]>
}>()

const emit = defineEmits<{
  (e: 'action', payload: { type: string; key: string; lines?: string[]; offset?: number }): void
  (e: 'open-page', name: string): void
  (e: 'open-url', url: string): void
}>()

const area = ref<HTMLTextAreaElement | null>(null)
const draft = ref('')
const suggestions = ref<PageHit[]>([])
const suggestionIndex = ref(0)

const displayLines = computed(() => blockLinesForDisplay(props.block, props.unit))
/** 含围栏代码的块整块用等宽字体(多行内容里出现 ``` 就算) */
const fenced = computed(() => displayLines.value.slice(1).some((line) => /^\s*(```|~~~)/.test(line)))
const visibleProps = computed(() =>
  props.block.extra
    .filter((x) => x.kind === 'prop')
    .map((x) => x.line.text.trim())
    .filter((line) => !props.hiddenProps.some((h) => line.toLowerCase().startsWith(`${h.toLowerCase()}::`)))
)

function startEdit(event: MouseEvent): void {
  if (props.editing) return
  const target = event.target as HTMLElement | null
  const lineIndex = Number(target?.closest('[data-line]')?.getAttribute('data-line') ?? '0')
  // 只有第一行能精确映射到 textarea 的偏移;点后面的多行内容时落到第一行末尾
  if (lineIndex > 0) {
    emit('action', { type: 'start-edit', key: props.block.key })
    return
  }
  const raw = target?.closest('[data-src]')?.getAttribute('data-src')
  emit('action', { type: 'start-edit', key: props.block.key, offset: raw ? Number(raw) : undefined })
}

function onInput(): void {
  const lines = draft.value.split('\n')
  emit('action', { type: 'input', key: props.block.key, lines })
  void refreshSuggestions()
}

/** 光标前是不是 `[[` / `#[[` 开头的查询(补全只在行内、最多 40 字内找) */
function queryBeforeCaret(): { query: string; start: number } | null {
  const el = area.value
  if (!el) return null
  const caret = el.selectionStart ?? 0
  const before = draft.value.slice(0, caret)
  const m = /(?:^|[^[\]])(#?)\[\[([^[\]]{0,40})$/.exec(before)
  if (!m) return null
  return { query: m[2], start: caret - m[2].length }
}

async function refreshSuggestions(): Promise<void> {
  const found = queryBeforeCaret()
  if (!found) {
    suggestions.value = []
    return
  }
  suggestions.value = (await props.suggest(found.query)).slice(0, 8)
  suggestionIndex.value = 0
}

function applySuggestion(hit: PageHit): void {
  const found = queryBeforeCaret()
  if (!found || !area.value) return
  const caret = area.value.selectionStart ?? draft.value.length
  const needsBrackets = found.query.includes(' ') || /[()[\]{}#|]/.test(hit.name)
  const text = needsBrackets ? `[[${hit.name}]]` : hit.name
  const next = draft.value.slice(0, found.start) + text + ']]' + draft.value.slice(caret)
  draft.value = next
  suggestions.value = []
  emit('action', { type: 'input', key: props.block.key, lines: next.split('\n') })
  void nextTick(() => area.value?.setSelectionRange(found.start + text.length + 2, found.start + text.length + 2))
}

function onKeydown(event: KeyboardEvent): void {
  const el = area.value
  const caret = el?.selectionStart ?? 0

  if (suggestions.value.length > 0 && (event.key === 'Enter' || event.key === 'Tab')) {
    event.preventDefault()
    applySuggestion(suggestions.value[suggestionIndex.value] ?? suggestions.value[0])
    return
  }
  if (event.key === 'ArrowDown' && suggestions.value.length > 0) {
    event.preventDefault()
    suggestionIndex.value = (suggestionIndex.value + 1) % suggestions.value.length
    return
  }
  if (event.key === 'ArrowUp' && suggestions.value.length > 0) {
    event.preventDefault()
    suggestionIndex.value = (suggestionIndex.value - 1 + suggestions.value.length) % suggestions.value.length
    return
  }

  if (event.key === 'Escape') {
    event.preventDefault()
    if (suggestions.value.length > 0) {
      suggestions.value = []
      return
    }
    emit('action', { type: 'stop-edit', key: props.block.key })
    return
  }

  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    // 光标在整块末尾(最后一行行尾)→ 新兄弟块;否则在光标处劈开
    const atEnd = caret >= draft.value.length
    emit('action', atEnd ? { type: 'new-sibling', key: props.block.key } : { type: 'split', key: props.block.key, offset: caret })
    return
  }

  if (event.key === 'Enter' && event.shiftKey) {
    event.preventDefault()
    const before = draft.value.slice(0, caret)
    const after = draft.value.slice(caret)
    const next = `${before}\n${after}`
    draft.value = next
    emit('action', { type: 'input', key: props.block.key, lines: next.split('\n') })
    void nextTick(() => el?.setSelectionRange(caret + 1, caret + 1))
    return
  }

  if (event.key === 'Tab') {
    event.preventDefault()
    emit('action', { type: event.shiftKey ? 'outdent' : 'indent', key: props.block.key })
    return
  }

  if (event.key === 'Backspace' && caret === 0) {
    event.preventDefault()
    emit('action', { type: 'merge', key: props.block.key })
    return
  }

  if (event.key === 'ArrowUp' && caret === 0) {
    event.preventDefault()
    emit('action', { type: 'move', key: props.block.key, offset: -1 })
    return
  }

  if (event.key === 'ArrowDown' && caret >= draft.value.length) {
    event.preventDefault()
    emit('action', { type: 'move', key: props.block.key, offset: 1 })
  }
}

watch(
  () => props.editing,
  (editing) => {
    if (!editing) {
      suggestions.value = []
      return
    }
    draft.value = displayLines.value.join('\n')
    void nextTick(() => {
      const el = area.value
      if (!el) return
      el.focus()
      const at = props.caretIntent ?? draft.value.length
      const clamped = Math.max(0, Math.min(draft.value.length, at))
      el.setSelectionRange(clamped, clamped)
      autoGrow()
    })
  },
  { immediate: true }
)

// 编辑态里块被别的操作改过(缩进/合并)时,保持 textarea 跟数据一致
watch(displayLines, (next) => {
  if (!props.editing) return
  const text = next.join('\n')
  if (text !== draft.value) draft.value = text
})

function autoGrow(): void {
  const el = area.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function onFocus(): void {
  autoGrow()
}
</script>

<template>
  <div class="block-row" :class="{ editing }" :data-key="block.key" :data-depth="depth">
    <div class="block-gutter" :style="{ paddingLeft: `${depth * 18}px` }">
      <button
        v-if="childCount > 0"
        class="collapse"
        :title="collapsed ? `展开 ${childCount} 个子块` : '折叠'"
        @click.stop="emit('action', { type: 'toggle-collapse', key: block.key })"
      >
        {{ collapsed ? '▸' : '▾' }}
      </button>
      <span v-else class="collapse placeholder"></span>
      <span class="bullet" :class="{ collapsed }" @click.stop="emit('action', { type: 'toggle-collapse', key: block.key })"></span>
    </div>

    <div class="block-body">
      <textarea
        v-if="editing"
        ref="area"
        v-model="draft"
        class="block-input"
        rows="1"
        spellcheck="false"
        @input="onInput"
        @keydown="onKeydown"
        @blur="emit('action', { type: 'blur', key: block.key })"
      ></textarea>

      <template v-else>
        <div class="block-rendered" :class="{ codeish: fenced }" @click="startEdit">
          <template v-for="(line, index) in displayLines" :key="index">
            <div class="block-line" :data-line="index">
              <BlockText :text="line" @open-page="emit('open-page', $event)" @open-url="emit('open-url', $event)" />
            </div>
          </template>
          <div v-if="displayLines.every((l) => l === '')" class="block-empty">空白块(点这里输入)</div>
        </div>
        <div v-if="visibleProps.length > 0" class="block-props">
          <span v-for="(prop, index) in visibleProps" :key="index">{{ prop }}</span>
        </div>
      </template>

      <ul v-if="suggestions.length > 0" class="suggest">
        <li
          v-for="(hit, index) in suggestions"
          :key="hit.rel"
          :class="{ active: index === suggestionIndex }"
          @mousedown.prevent="applySuggestion(hit)"
        >
          <span class="suggest-name">{{ hit.name }}</span>
          <span v-if="hit.day" class="suggest-kind">日志</span>
          <span v-else class="suggest-kind">页面</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.block-row {
  display: flex;
  align-items: flex-start;
  padding: 1px 0;
}

.block-gutter {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-top: 3px;
  padding-right: 2px;
}

.collapse {
  width: 14px;
  font-size: 10px;
  line-height: 1;
  color: var(--fg-dim);
  background: none;
  border: none;
  cursor: pointer;
}

.collapse.placeholder {
  display: inline-block;
  cursor: default;
}

.bullet {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-dim);
  cursor: pointer;
}

.bullet.collapsed {
  background: var(--accent);
}

.block-body {
  position: relative;
  flex: 1;
  min-width: 0;
  padding: 2px 0 2px 4px;
}

.block-input {
  width: 100%;
  min-height: 22px;
  padding: 0;
  font: inherit;
  line-height: 1.6;
  color: inherit;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
  user-select: text;
}

.block-rendered {
  line-height: 1.6;
  cursor: text;
  white-space: pre-wrap;
  word-break: break-word;
}

.block-rendered.codeish {
  font-family: Consolas, 'Cascadia Mono', monospace;
  font-size: 0.92em;
}
.block-empty {
  color: var(--fg-dim);
  font-style: italic;
}

.block-props {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--fg-dim);
}

.suggest {
  position: absolute;
  z-index: 20;
  top: 100%;
  left: 0;
  min-width: 220px;
  max-height: 240px;
  margin: 2px 0 0;
  padding: 4px;
  overflow: auto;
  list-style: none;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
}

.suggest li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.suggest li.active {
  background: color-mix(in srgb, var(--accent) 25%, transparent);
}

.suggest-kind {
  color: var(--fg-dim);
  font-size: 11px;
}
</style>
