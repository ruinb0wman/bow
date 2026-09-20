<script setup lang="ts">
/**
 * `bow://logseq` 页面的主体:日志/页面的读写、块编辑命令、保存与冲突策略、反链面板。
 *
 * 分工(改代码前先读):
 * - 本组件持有**唯一一份可变状态**(`file` 的块树 + `meta`),所有编辑都走 `shared.ts` 的纯函数,
 *   保存统一走 `savePage`(`baseMtimeMs` 冲突检测);
 * - `BlockRow` 只 emit 意图,不碰数据;
 * - 视图状态(当前在哪一页)按 tabId 存在插件主进程里,所以**刷新标签会回到同一页**;
 * - `Ctrl+Z` 是自己实现的整篇快照撤销(Logseq 有逐块撤销,我们只承诺「回到上一个快照」),
 *   上限 50 步;快照只在「一次编辑会话的第一次改动」与结构操作前入栈。
 *
 * 未落盘窗口 = 400ms(防抖):`Ctrl+W` 由主进程在页面之前吃掉(见 `shared/shortcuts.ts`),
 * 页面拦不住它,所以只能把窗口压小 —— 这是 README 里写明的代价。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CalendarDays, ChevronLeft, ChevronRight, FolderOpen, RefreshCw, Search } from 'lucide-vue-next'
import { LOGSEQ_URL } from '@shared/internalPages'
import type { PaneDir } from '@shared/split'
import {
  blockLinesForDisplay,
  DEFAULT_HIDDEN_PROPERTIES,
  deleteBlock,
  detectIndentUnit,
  formatDayTitle,
  hasBlocks,
  indentBlock,
  insertFirstBlock,
  insertSiblingAfter,
  mergeWithPrevious,
  outdentBlock,
  parseLogseqFile,
  serializeLogseqFile,
  setBlockContentLines,
  shiftDay,
  splitBlock,
  todayDay,
  toggleTaskMarker,
  topBlocks,
  type BlockNode,
  type EditResult,
  type FileRead,
  type GraphState,
  type GraphSwitchResult,
  type LogseqView,
  type ParsedFile,
  type SaveResult
} from '@plugins/logseq/shared'
import type { Backlinks, PageHit } from '@plugins/logseq/graph'
import BlockRow from './BlockRow.vue'
import BacklinksPanel from './BacklinksPanel.vue'

const api = window.browserAPI

const SAVE_DEBOUNCE_MS = 400
const UNDO_LIMIT = 50
const ARROWS: Record<string, PaneDir> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

type Status = 'loading' | 'ready' | 'nograph' | 'error' | 'disabled'

const status = ref<Status>('loading')
const graphState = ref<GraphState | null>(null)
const message = ref('')
const tabId = ref<number | null>(null)
const view = ref<LogseqView>({ kind: 'journal', day: todayDay() })
const file = ref<ParsedFile | null>(null)
const unit = ref('  ')
const meta = ref<{
  path: string
  rel: string
  exists: boolean
  mtimeMs: number | null
  title: string
  fromTemplate?: string
} | null>(null)

const editingKey = ref<string | null>(null)
const caretIntent = ref<number | null>(null)
const collapsed = ref<Set<string>>(new Set())
const dirty = ref(false)
const saving = ref(false)
/** 正在换页/重载(期间不允许保存:那次 blur 带的是上一页的内容) */
const loadingView = ref(false)
const conflict = ref<{ diskRaw: string } | null>(null)
const externalChanged = ref(false)

const links = ref<Backlinks | null>(null)
const linksLoading = ref(false)
const searchDraft = ref('')
const searchHits = ref<PageHit[]>([])
const searchOpen = ref(false)
const dayDraft = ref(todayDay())

const undoStack = ref<string[]>([])
const redoStack = ref<string[]>([])
/** 最近发生的事(只在调试把手与 E2E 里读:排「为什么保存/重载了」这类问题时非常省事) */
const traceLog: string[] = []
function trace(event: string): void {
  traceLog.push(`${Date.now() % 100000} ${event}`)
  if (traceLog.length > 60) traceLog.shift()
}
/** 一次编辑会话里是否已经压过快照 */
let undoArmed = false
let saveTimer: number | null = null
let searchTimer: number | null = null
const unsubs: Array<() => void> = []

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return api.plugins.invoke<T>('logseq', method, ...args)
}

function fail(text: string, kind: Status = 'error'): void {
  status.value = kind
  message.value = text
}

// ---------- 载入 ----------

function currentRaw(): string {
  return file.value ? serializeLogseqFile(file.value) : ''
}

function loadRaw(raw: string): void {
  let parsed = parseLogseqFile(raw)
  // 空文件/空日志:先给一个空块,否则界面没地方输入(不落盘 —— dirty 仍是 false)
  if (!hasBlocks(parsed)) parsed = insertFirstBlock(parsed).file
  file.value = parsed
  unit.value = detectIndentUnit(parsed)
  dirty.value = false
}

function loadResult(res: FileRead): void {
  view.value = res.view
  meta.value = {
    path: res.path,
    rel: res.rel,
    exists: res.exists,
    mtimeMs: res.mtimeMs,
    title: res.title,
    fromTemplate: res.fromTemplate
  }
  loadRaw(res.raw)
  editingKey.value = null
  caretIntent.value = null
  conflict.value = null
  externalChanged.value = false
  undoStack.value = []
  redoStack.value = []
  undoArmed = false
  dayDraft.value = res.view.kind === 'journal' ? res.view.day : dayDraft.value
  document.title = res.view.kind === 'journal' ? `笔记 — ${res.view.day}` : `笔记 — ${res.view.name}`
  if (tabId.value != null) void invoke('setView', tabId.value, res.view).catch(() => undefined)
  void loadBacklinks()
}

async function loadBacklinks(): Promise<void> {
  const name = meta.value?.title
  if (!name) return
  linksLoading.value = true
  try {
    links.value = await invoke<Backlinks>('backlinks', name)
  } catch {
    links.value = null
  } finally {
    linksLoading.value = false
  }
}

async function openView(next: LogseqView): Promise<void> {
  // 切页/重载之前先把待保存的排干:否则旧页的内容可能盖掉新页(而且旧基线早已失效)
  trace(`open:${next.kind}`)
  cancelPendingSave()
  loadingView.value = true
  status.value = status.value === 'ready' ? 'loading' : status.value
  try {
    const res =
      next.kind === 'journal'
        ? await invoke<FileRead>('readJournal', next.day)
        : await invoke<FileRead>('readPage', next.name)
    status.value = 'ready'
    loadResult(res)
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    if (text.includes('插件已停用')) fail('「笔记」插件已被停用(设置页 → 插件管理可以重新启用)', 'disabled')
    else fail(text)
  } finally {
    loadingView.value = false
  }
}

async function boot(): Promise<void> {
  try {
    tabId.value = await api.getSelfTabId()
    const state = await invoke<GraphState>('getState')
    graphState.value = state
    if (!state.ok) {
      status.value = 'nograph'
      message.value = state.error ?? '还没有选择图目录'
      return
    }
    const attached = await invoke<{ view: LogseqView }>('attach', tabId.value ?? 0)
    await openView(attached.view)
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    if (text.includes('插件已停用')) fail('「笔记」插件已被停用(设置页 → 插件管理可以重新启用)', 'disabled')
    else fail(text)
  }
}

async function refreshState(): Promise<void> {
  graphState.value = await invoke<GraphState>('getState')
}

// ---------- 保存 ----------

function scheduleSave(): void {
  // 冲突未解决时不再排保存 —— 否则「用磁盘版本重载」之后,编辑器失焦触发的那一次
  // 又会拿着旧基线把冲突重新弹回来(真机 E2E 里就是这样复现的)
  if (conflict.value) {
    trace('schedule:blocked-by-conflict')
    return
  }
  trace('schedule')
  if (saveTimer != null) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void doSave()
  }, SAVE_DEBOUNCE_MS)
}

function cancelPendingSave(): void {
  if (saveTimer != null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
}

async function saveNow(): Promise<void> {
  cancelPendingSave()
  await doSave()
}

async function doSave(): Promise<void> {
  trace(`save:dirty=${dirty.value},saving=${saving.value},conflict=${!!conflict.value},meta=${meta.value ? 'yes' : 'no'}`)
  if (!meta.value || !file.value || saving.value || !dirty.value) return
  if (conflict.value) return
  // 正在换页:此时 textarea 被卸下会触发 blur,那个 save 带的是**上一页**的内容与失效基线
  if (loadingView.value) {
    trace('save:blocked-by-loading')
    return
  }
  const raw = currentRaw()
  saving.value = true
  try {
    const res = await invoke<SaveResult>('savePage', {
      path: meta.value.path,
      raw,
      baseMtimeMs: meta.value.mtimeMs
    })
    if (res.conflict) {
      trace('conflict:detected')
      conflict.value = { diskRaw: res.diskRaw ?? '' }
      dirty.value = true
      return
    }
    if (!res.ok) {
      message.value = res.error ?? '保存失败'
      return
    }
    meta.value = { ...meta.value, exists: true, mtimeMs: res.mtimeMs ?? null }
    dirty.value = false
    externalChanged.value = false
    conflict.value = null
    message.value = ''
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

/** 冲突横幅的「用磁盘版本重载」:显式丢弃本地改动 */
async function takeDiskVersion(): Promise<void> {
  cancelPendingSave()
  conflict.value = null
  dirty.value = false
  await openView(view.value)
}

/** 冲突横幅的「强行覆盖」:清掉基线 mtime,再存一次(只影响这一个文件) */
async function overwriteDisk(): Promise<void> {
  if (!meta.value) return
  cancelPendingSave()
  conflict.value = null
  meta.value = { ...meta.value, mtimeMs: null }
  dirty.value = true
  await doSave()
}

async function reloadFromDisk(): Promise<void> {
  cancelPendingSave()
  dirty.value = false
  externalChanged.value = false
  await openView(view.value)
}

// ---------- 编辑 ----------

function pushUndo(): void {
  const raw = currentRaw()
  if (undoStack.value[undoStack.value.length - 1] === raw) return
  undoStack.value.push(raw)
  if (undoStack.value.length > UNDO_LIMIT) undoStack.value.shift()
  redoStack.value = []
}

function commit(result: EditResult): void {
  if (result.file === file.value) return
  pushUndo()
  file.value = result.file
  unit.value = detectIndentUnit(result.file)
  dirty.value = true
  scheduleSave()
  if (result.focusKey) {
    editingKey.value = result.focusKey
    caretIntent.value = null
  }
}

function undo(): void {
  const prev = undoStack.value.pop()
  if (prev === undefined) return
  redoStack.value.push(currentRaw())
  loadRaw(prev)
  dirty.value = true
  undoArmed = false
  scheduleSave()
}

function redo(): void {
  const next = redoStack.value.pop()
  if (next === undefined) return
  undoStack.value.push(currentRaw())
  loadRaw(next)
  dirty.value = true
  undoArmed = false
  scheduleSave()
}

interface BlockAction {
  type: string
  key: string
  lines?: string[]
  offset?: number
  lineIndex?: number
}

function onBlockAction(payload: BlockAction): void {
  const current = file.value
  if (!current) return
  switch (payload.type) {
    case 'start-edit':
      editingKey.value = payload.key
      caretIntent.value = payload.offset ?? null
      undoArmed = false
      return
    case 'stop-edit':
    case 'blur':
      trace(`action:${payload.type}`)
      if (editingKey.value === payload.key) editingKey.value = null
      void saveNow()
      return
    case 'input': {
      if (!payload.lines) return
      if (!undoArmed) {
        pushUndo()
        undoArmed = true
      }
      file.value = setBlockContentLines(current, payload.key, payload.lines)
      dirty.value = true
      scheduleSave()
      return
    }
    case 'split':
      commit(splitBlock(current, payload.key, payload.offset ?? 0, unit.value))
      return
    case 'toggle-task': {
      const next = toggleTaskMarker(current, payload.key, payload.lineIndex ?? 0)
      // no-op(行里没有 `[ ]` / `[x]`)时返回同一个对象:不推 undo、不标脏
      if (next === current) return
      commit({ file: next, focusKey: null })
      return
    }
    case 'new-sibling':
      commit(insertSiblingAfter(current, payload.key))
      return
    case 'indent':
      commit(indentBlock(current, payload.key))
      return
    case 'outdent':
      commit(outdentBlock(current, payload.key))
      return
    case 'merge':
      commit(mergeWithPrevious(current, payload.key))
      return
    case 'delete':
      commit(deleteBlock(current, payload.key))
      return
    case 'toggle-collapse': {
      const next = new Set(collapsed.value)
      if (next.has(payload.key)) next.delete(payload.key)
      else next.add(payload.key)
      collapsed.value = next
      return
    }
    case 'move': {
      const rows = visibleRows.value
      const index = rows.findIndex((row) => row.block.key === payload.key)
      const target = rows[index + (payload.offset ?? 0)]
      if (!target) return
      editingKey.value = target.block.key
      caretIntent.value = (payload.offset ?? 1) < 0 ? 0 : null
      return
    }
    default:
      return
  }
}

interface VisibleRow {
  block: BlockNode
  depth: number
  childCount: number
  collapsed: boolean
}

const visibleRows = computed<VisibleRow[]>(() => {
  const current = file.value
  if (!current) return []
  const rows: VisibleRow[] = []
  const walk = (blocks: BlockNode[], depth: number): void => {
    for (const block of blocks) {
      const isCollapsed = collapsed.value.has(block.key)
      rows.push({ block, depth, childCount: block.children.length, collapsed: isCollapsed })
      if (!isCollapsed) walk(block.children, depth + 1)
    }
  }
  walk(topBlocks(current), 0)
  return rows
})

/**
 * 渲染时隐藏的属性行:**系统属性(id:: / collapsed:: …)永远隐藏**,再加上用户在 `config.edn` 里
 * 用 `:block-hidden-properties` 追加的。文件里的这些行照旧保留 —— 只是不往界面上画。
 */
const hiddenProps = computed(() => [
  ...DEFAULT_HIDDEN_PROPERTIES,
  ...(graphState.value?.config.hiddenProperties ?? [])
])

function blockPreview(row: VisibleRow): string {
  return blockLinesForDisplay(row.block, unit.value)[0] ?? ''
}

// ---------- 导航 ----------

async function openPage(name: string, newPane = false): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) return
  await saveNow()
  if (newPane) {
    // 「在新窗格打开」:让主进程记住待打开的页 → 分屏 → 新窗格载入 bow://logseq
    // (`openIn:'pane'` 的内部页会顶替聚焦窗格,也就是刚分出来的那个)
    await invoke('openInNewPane', trimmed)
    await api.splitPane('right')
    await api.goUrl(LOGSEQ_URL)
    return
  }
  await openView({ kind: 'page', name: trimmed })
}

async function goDay(delta: number): Promise<void> {
  await saveNow()
  await openView({ kind: 'journal', day: shiftDay(view.value.kind === 'journal' ? view.value.day : todayDay(), delta) })
}

async function goToday(): Promise<void> {
  await saveNow()
  await openView({ kind: 'journal', day: todayDay() })
}

async function jumpDay(): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayDraft.value)) return
  await saveNow()
  await openView({ kind: 'journal', day: dayDraft.value })
}

function onSearchInput(): void {
  if (searchTimer != null) clearTimeout(searchTimer)
  searchTimer = window.setTimeout(async () => {
    searchTimer = null
    try {
      searchHits.value = await invoke<PageHit[]>('listPages', searchDraft.value)
    } catch {
      searchHits.value = []
    }
  }, 150)
}

async function runSearch(): Promise<void> {
  const first = searchHits.value[0]
  if (first) {
    searchOpen.value = false
    searchDraft.value = ''
    await (first.day ? openView({ kind: 'journal', day: first.day }) : openView({ kind: 'page', name: first.name }))
    return
  }
  const typed = searchDraft.value.trim()
  if (!typed) return
  await openPage(typed)
}

async function suggestPages(query: string): Promise<PageHit[]> {
  try {
    return await invoke<PageHit[]>('listPages', query)
  } catch {
    return []
  }
}

// ---------- 选图 / 切图 ----------

async function pickGraph(): Promise<void> {
  try {
    const res = await invoke<GraphSwitchResult>('pickGraph')
    graphState.value = res.state
    if (!res.ok) {
      message.value = res.error ?? '选择图目录失败'
      return
    }
    status.value = 'ready'
    await openView({ kind: 'journal', day: todayDay() })
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  }
}

async function switchGraph(path: string): Promise<void> {
  try {
    const res = await invoke<GraphSwitchResult>('setGraph', path)
    graphState.value = res.state
    if (!res.ok) {
      message.value = res.error ?? '切换图失败'
      return
    }
    status.value = 'ready'
    await openView({ kind: 'journal', day: todayDay() })
  } catch (e) {
    message.value = e instanceof Error ? e.message : String(e)
  }
}

// ---------- 键位 ----------

function onWindowKeydown(event: KeyboardEvent): void {
  const mod = event.ctrlKey || event.metaKey
  if (mod && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  const dir = ARROWS[event.key]
  if (!dir) return
  // 分屏 / 调大小:本页不在 `shouldTakeSplitHotkey` 的白名单里(核心零改动),按键会正常送到页面,
  // 于是由页面自己调 IPC 完成 —— 与终端页必须由主进程接管的情形正好相反。
  if (mod && event.shiftKey) {
    event.preventDefault()
    void api.splitPane(dir)
    return
  }
  if (event.altKey && event.shiftKey) {
    event.preventDefault()
    void api.resizePane(dir)
  }
}

function subscribe(): void {
  unsubs.push(
    api.plugins.onEvent((payload) => {
      if (payload.id !== 'logseq' || payload.event !== 'graph-changed') return
      if (!meta.value) return
      const args = payload.args as { paths?: string[] } | undefined
      const paths = args?.paths ?? []
      // 空字符串 = 目录级事件(拿不到文件名):保守当作「可能相关」
      const related = paths.some((path) => !path || path === meta.value?.rel)
      if (!related) return
      if (dirty.value) {
        externalChanged.value = true
        return
      }
      void reloadFromDisk()
    })
  )
}

// ---------- E2E / 调试把手(内部页面,没有外部站点能碰到它) ----------

function exposeDebugHandle(): void {
  /** Vue 的响应式对象是 Proxy,CDP 的 returnByValue 会把它们序列化成 `{}` —— 一律转成普通对象再暴露 */
  const plain = <T>(value: T): T => (value == null ? value : (JSON.parse(JSON.stringify(value)) as T))
  ;(window as unknown as Record<string, unknown>).__bowLogseq = {
    get status() {
      return status.value
    },
    get message() {
      return message.value
    },
    get view() {
      return plain(view.value)
    },
    get raw() {
      return currentRaw()
    },
    get meta() {
      return plain(meta.value)
    },
    get dirty() {
      return dirty.value
    },
    get conflict() {
      return plain(conflict.value)
    },
    get externalChanged() {
      return externalChanged.value
    },
    get links() {
      return plain(links.value)
    },
    get rows() {
      return visibleRows.value.map((row) => ({ key: row.block.key, depth: row.depth, text: blockPreview(row) }))
    },    openPage,
    goDay,
    goToday,
    save: doSave,
    get trace() {
      return [...traceLog]
    },
    search: async (query: string) => await invoke<PageHit[]>('listPages', query),
    backlinks: async (name: string) => await invoke<Backlinks>('backlinks', name)
  }
}

onMounted(async () => {
  exposeDebugHandle()
  subscribe()
  window.addEventListener('keydown', onWindowKeydown, true)
  await boot()
})

onBeforeUnmount(() => {
  unsubs.forEach((unsub) => unsub())
  unsubs.length = 0
  window.removeEventListener('keydown', onWindowKeydown, true)
  if (saveTimer != null) clearTimeout(saveTimer)
  if (searchTimer != null) clearTimeout(searchTimer)
  delete (window as unknown as Record<string, unknown>).__bowLogseq
})

watch(
  () => [view.value, meta.value?.rel],
  () => {
    searchHits.value = []
  }
)
</script>

<template>
  <div class="logseq-page">
    <!-- 没选图 / 插件停用 / 出错 -->
    <div v-if="status === 'nograph' || status === 'disabled' || status === 'error'" class="notice">
      <h1 class="notice-title">{{ status === 'disabled' ? '插件已停用' : '笔记' }}</h1>
      <p class="notice-text">{{ message }}</p>
      <div v-if="status === 'nograph'" class="notice-actions">
        <button class="primary" @click="pickGraph"><FolderOpen :size="14" /> 选择 Logseq 图目录</button>
      </div>
      <div v-if="graphState && graphState.recentGraphs.length > 0" class="notice-recent">
        <span class="notice-recent-title">最近的图:</span>
        <button v-for="path in graphState.recentGraphs" :key="path" class="recent" :title="path" @click="switchGraph(path)">
          {{ path }}
        </button>
      </div>
      <p class="notice-hint">
        只支持 Logseq 的**文件图**(`journals/` + `pages/`);DB 图(`logseq/db`)不支持。
      </p>
    </div>

    <!-- 正常 -->
    <template v-else>
      <header class="head">
        <div class="head-main">
          <button class="icon" title="前一天" @click="goDay(-1)"><ChevronLeft :size="16" /></button>
          <h1 class="head-title">
            {{ view.kind === 'journal' ? formatDayTitle(view.day) : view.name }}
            <span v-if="view.kind === 'journal'" class="head-kind">日志</span>
          </h1>
          <button class="icon" title="后一天" @click="goDay(1)"><ChevronRight :size="16" /></button>
          <button class="ghost" @click="goToday">今天</button>
          <span class="date-jump">
            <CalendarDays :size="13" />
            <input v-model="dayDraft" type="date" class="date-input" @change="jumpDay" />
          </span>
        </div>

        <div class="head-side">
          <span class="search">
            <Search :size="13" />
            <input
              v-model="searchDraft"
              class="search-input"
              placeholder="搜索页面 / 输入页面名后回车新建"
              @input="onSearchInput"
              @focus="searchOpen = true"
              @blur="searchOpen = false"
              @keydown.enter.prevent="runSearch"
              @keydown.esc="searchOpen = false"
            />
            <ul v-if="searchOpen && searchHits.length > 0" class="search-hits">
              <li
                v-for="hit in searchHits.slice(0, 8)"
                :key="hit.rel"
                @mousedown.prevent="hit.day ? openView({ kind: 'journal', day: hit.day }) : openView({ kind: 'page', name: hit.name })"
              >
                <span>{{ hit.name }}</span>
                <span class="hit-kind">{{ hit.day ? '日志' : '页面' }}</span>
              </li>
            </ul>
          </span>
          <button class="icon" :title="`图目录:${graphState?.graphPath ?? ''}`" @click="pickGraph">
            <FolderOpen :size="15" />
          </button>
          <button class="icon" title="重新载入(丢弃未保存改动)" @click="reloadFromDisk">
            <RefreshCw :size="15" />
          </button>
        </div>
      </header>

      <div class="meta">
        <span v-if="meta && !meta.exists" class="chip">尚未创建文件(第一次编辑时创建)</span>
        <span v-if="meta?.fromTemplate" class="chip">来自模板 {{ meta.fromTemplate }}</span>
        <span v-if="saving" class="chip">保存中…</span>
        <span v-else-if="dirty" class="chip warn">未保存</span>
        <span v-if="externalChanged" class="chip warn">外部已改动</span>
        <span v-if="graphState?.index?.tooLarge" class="chip warn">
          图文件数超过 {{ graphState.index.files }} 上限,反链可能不全
        </span>
        <span v-if="graphState && graphState.dateFormat.ok === false" class="chip warn">
          `:journal/file-name-format` 用了不认识的 token({{ graphState.dateFormat.unsupported }}),新建日志按
          {{ graphState.dateFormat.format }}
        </span>
        <span v-if="message" class="chip error">{{ message }}</span>
      </div>

      <div v-if="conflict" class="conflict">
        <span class="conflict-text">磁盘上的文件在你编辑期间被改过(可能是 Logseq 自己写的)。</span>
        <button class="ghost" @click="takeDiskVersion">用磁盘版本重载(丢弃本地改动)</button>
        <button class="primary" @click="overwriteDisk">强行覆盖磁盘</button>
      </div>

      <div v-if="status === 'loading'" class="loading">正在载入…</div>

      <main v-else class="blocks">
        <BlockRow
          v-for="row in visibleRows"
          :key="row.block.key"
          :block="row.block"
          :depth="row.depth"
          :unit="unit"
          :hidden-props="hiddenProps"
          :editing="editingKey === row.block.key"
          :caret-intent="editingKey === row.block.key ? caretIntent : null"
          :collapsed="row.collapsed"
          :child-count="row.childCount"
          :suggest="suggestPages"
          @action="onBlockAction"
          @open-page="openPage"
          @open-url="(url: string) => api.createTab(url)"
        />

        <BacklinksPanel :links="links" :loading="linksLoading" @open-page="openPage" />
      </main>
    </template>
  </div>
</template>

<style>
/* 全站样式里 body 是 user-select:none(浏览器 UI 不该被选中),笔记页要能选文本 */
body {
  user-select: text;
}
</style>

<style scoped>
.logseq-page {
  position: fixed;
  inset: 0;
  overflow: auto;
  background: var(--bg);
}

.notice {
  max-width: 560px;
  margin: 12vh auto 0;
  padding: 0 24px;
  text-align: left;
}

.notice-title {
  margin: 0 0 10px;
  font-size: 20px;
}

.notice-text {
  margin: 0 0 16px;
  color: var(--fg-dim);
}

.notice-actions {
  margin-bottom: 18px;
}

.notice-recent {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 18px;
}

.notice-recent-title {
  font-size: 12px;
  color: var(--fg-dim);
}

.recent {
  padding: 4px 8px;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}

.recent:hover {
  border-color: var(--accent);
}

.notice-hint {
  padding-top: 12px;
  font-size: 12px;
  color: var(--fg-dim);
  border-top: 1px solid var(--border);
}

.head {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
}

.head-main,
.head-side {
  display: flex;
  gap: 6px;
  align-items: center;
}

.head-title {
  margin: 0 4px;
  font-size: 16px;
  font-weight: 600;
}

.head-kind {
  margin-left: 6px;
  padding: 1px 5px;
  font-size: 10px;
  font-weight: 400;
  color: var(--fg-dim);
  background: var(--bg3);
  border-radius: 3px;
}

.icon {
  display: inline-flex;
  align-items: center;
  padding: 4px;
  color: var(--fg-dim);
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.icon:hover {
  color: var(--fg);
  background: var(--bg3);
}

.ghost,
.primary {
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
}

.ghost {
  color: var(--fg);
  background: var(--bg3);
}

.primary {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}

.date-jump,
.search {
  position: relative;
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 3px 8px;
  color: var(--fg-dim);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.date-input,
.search-input {
  font: inherit;
  font-size: 12px;
  color: var(--fg);
  background: transparent;
  border: none;
  outline: none;
}

.search-input {
  width: 220px;
}

.search-hits {
  position: absolute;
  top: 100%;
  right: 0;
  left: 0;
  z-index: 30;
  max-height: 260px;
  margin: 4px 0 0;
  padding: 4px;
  overflow: auto;
  list-style: none;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.search-hits li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.search-hits li:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

.hit-kind {
  font-size: 11px;
  color: var(--fg-dim);
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 20px 0;
}

.chip {
  padding: 1px 6px;
  font-size: 11px;
  color: var(--fg-dim);
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 3px;
}

.chip.warn {
  color: #e2b93d;
  border-color: color-mix(in srgb, #e2b93d 45%, var(--border));
}

.chip.error {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
}

.conflict {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 8px 20px 0;
  padding: 8px 12px;
  font-size: 12px;
  background: color-mix(in srgb, var(--danger) 12%, var(--bg2));
  border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
  border-radius: 6px;
}

.loading {
  padding: 24px 20px;
  color: var(--fg-dim);
}

.blocks {
  max-width: 940px;
  padding: 14px 20px 20vh;
  margin: 0 auto;
}
</style>
