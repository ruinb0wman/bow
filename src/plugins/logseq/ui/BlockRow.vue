<script setup lang="ts">
/**
 * 一个块:圆点 + 折叠箭头 + 「渲染态 / 就地编辑态」。
 *
 * 交互(计划 §3.7):
 * - 渲染态点一下 → 就地进入编辑态,光标落到**被点那一行的行尾**(多行块 = 那一行,不是整块);
 *   行尾偏移由 `analyzeBlockLines` 给每行算出的 `base + text.length`(`data-end`)提供;
 *   表格行的 `data-end` 在 `<tr>` 上(见 `MarkdownTable.vue`),所以点单元格也是「落该行行尾」;
 * - **拖选文本不会进编辑态**:鼠标拖选后浏览器仍会派发 click,这里的守卫把那次 click 让给选区;
 * - 编辑态是一个 textarea,内容是块的**全部正文行**(多行内容也在里面),Enter/Tab/Backspace 全部
 *   交给上层换算成块操作;`Ctrl/Cmd+Enter`(以及 `Shift+Enter`)才是块内换行;
 * - `[[` / `#[[` 输入中给出页面补全(数据源是上图索引,由上层注入 `suggest`);
 * - `Esc` 退出编辑态;
 * - 左侧圆点/折叠区按下鼠标 = 「从圆点拖选多个块」的起点(拖选逻辑全在 `JournalView`,这里只报意图)。
 *
 * 组件本身**不改数据**,只 emit 意图 —— 状态与保存策略全在 `JournalView` 里。
 */
import { computed, nextTick, ref, watch } from 'vue'
import {
  analyzeBlockLines,
  blockLinesForDisplay,
  groupBlockLines,
  type BlockNode
} from '@plugins/logseq/shared'
import type { PageHit } from '@plugins/logseq/graph'
import MarkdownLine from './MarkdownLine.vue'
import MarkdownTable from './MarkdownTable.vue'

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
  /** 是否在多块选区里(拖选圆点选中;选中态的视觉与键位都在 JournalView) */
  selected: boolean
  /** 页面补全的数据源(上图索引) */
  suggest: (query: string) => Promise<PageHit[]>
}>()

const emit = defineEmits<{
  (e: 'action', payload: { type: string; key: string; lines?: string[]; offset?: number; lineIndex?: number }): void
  (e: 'open-page', name: string): void
  (e: 'open-url', url: string): void
}>()

const area = ref<HTMLTextAreaElement | null>(null)
const draft = ref('')
const suggestions = ref<PageHit[]>([])
const suggestionIndex = ref(0)

const displayLines = computed(() => blockLinesForDisplay(props.block, props.unit))
/** 行级渲染数据:结构标记 + 带全局偏移的行内 token(点哪落哪靠它) */
const renderLines = computed(() => analyzeBlockLines(displayLines.value))
/** 分组:普通行各一组,连续的表格行合成一组(整组交给 `MarkdownTable`,否则画不出真 `<table>`) */
const renderGroups = computed(() => groupBlockLines(renderLines.value))
const visibleProps = computed(() =>
  props.block.extra
    .filter((x) => x.kind === 'prop')
    .map((x) => x.line.text.trim())
    .filter((line) => !props.hiddenProps.some((h) => line.toLowerCase().startsWith(`${h.toLowerCase()}::`)))
)

function startEdit(event: MouseEvent): void {
  if (props.editing) return
  // 拖选文本后浏览器仍会派发 click(此时选区还是非折叠的)。不拦的话每次拖选都会立刻进编辑态、选区被丢
  if (!window.getSelection()?.isCollapsed) return
  const target = event.target as HTMLElement | null
  // 光标落在**被点那一行的行尾**(行内偏移 `data-end` = 该行 display 文本在 textarea 全文里的结束偏移)
  // —— 点空白 / 引用边框 / 被隐藏的标记行时退到整块末尾(offset 为 undefined)。
  // 链接/标签/复选框的点击各自 `stopPropagation`,到不了这里。
  const end = target?.closest('[data-line]')?.getAttribute('data-end')
  emit('action', { type: 'start-edit', key: props.block.key, offset: end != null ? Number(end) : undefined })
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
  // 输入法组合中的按键一律交给 IME:中文「上屏」用的回车不能被当成建新块(否则会在候选未落字前劈块)
  if (event.isComposing || event.keyCode === 229) return

  const el = area.value
  const start = el?.selectionStart ?? 0
  const end = el?.selectionEnd ?? start
  const caret = start
  /** 有选区时不能把按键当成「块首」去合并/跳块 —— 全选后按 Backspace 会把整块并进上一行(见下方) */
  const hasSelection = start !== end

  // `Ctrl/Cmd+Enter` 不在这里被吞:补全下拉只吃「裸 Enter / Tab」
  if (suggestions.value.length > 0 && (event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.metaKey) {
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

  // 块内换行:`Shift+Enter` 与 `Ctrl/Cmd+Enter` 等价。
  // 主推 Ctrl+Enter —— 中文输入法常把单按 Shift 当「中/英切换」吃掉,`Shift+Enter` 到达页面时
  // `shiftKey` 已经是 false、变成普通 Enter 去建新块了(这时页面侧拿不到任何补救信息)。
  if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey)) {
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

  // 块首 Backspace 才合并。**必须排除有选区的情况**:全选后 `selectionStart === 0`,
  // 若在这里 preventDefault 并走 merge,删不掉内容,反而会把整块文本接到上一行末尾。
  if (event.key === 'Backspace' && caret === 0 && !hasSelection) {
    event.preventDefault()
    emit('action', { type: 'merge', key: props.block.key })
    return
  }

  if (event.key === 'ArrowUp' && caret === 0 && !hasSelection) {
    event.preventDefault()
    emit('action', { type: 'move', key: props.block.key, offset: -1 })
    return
  }

  if (event.key === 'ArrowDown' && caret >= draft.value.length && !hasSelection) {
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
  <div class="block-row" :class="{ editing, selected }" :data-key="block.key" :data-depth="depth">
    <div
      class="block-gutter"
      :style="{ paddingLeft: `${depth * 18}px` }"
      @mousedown.left="emit('action', { type: 'select-start', key: block.key })"
    >
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
        <div class="block-rendered" @click="startEdit">
          <template v-for="(group, gi) in renderGroups" :key="gi">
            <div
              v-if="group.kind === 'line'"
              class="block-line"
              :data-line="group.line.index"
              :data-base="group.line.base"
              :data-end="group.line.base + group.line.text.length"
            >
              <MarkdownLine
                :line="group.line"
                :line-index="group.line.index"
                @open-page="emit('open-page', $event)"
                @open-url="emit('open-url', $event)"
                @toggle-task="(i: number) => emit('action', { type: 'toggle-task', key: block.key, lineIndex: i })"
              />
            </div>
            <MarkdownTable
              v-else
              :rows="group.rows"
              @open-page="emit('open-page', $event)"
              @open-url="emit('open-url', $event)"
            />
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

/* 多块选区(从圆点拖选):在 JournalView 里维护,这里只负责画 */
.block-row.selected {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  border-radius: 3px;
}

.block-gutter {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-top: 3px;
  padding-right: 2px;
  /* 从圆点拖选多个块:拖动期间不要顺手把旁边的文字选中 */
  user-select: none;
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
