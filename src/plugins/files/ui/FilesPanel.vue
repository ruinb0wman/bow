<script setup lang="ts">
/**
 * 文件管理面板(全屏浮层):在白名单内浏览 + 重命名 / 移动到… / 复制到… / 删除 / 打开 / 预览文本。
 *
 * 它只做两件事:调 `plugins.invoke('files', …)` 和渲染 ——
 * 「这个路径能不能动」「删是进回收站还是真删」全由主进程的 guard 判(与 AI 调 `browser_fs_*` 是同一套语义)。
 * 所以面板里没有第二份规则:失败文案也是主进程给的那句,原样显示。
 *
 * 删除在这里**多一步点击确认**(AI 那条路刻意没有确认框,因为会卡住自动化;人在这里点是另一回事)。
 */
import { computed, onMounted, ref, watch, type Component } from 'vue'
import {
  AlertTriangle,
  ArrowUp,
  Copy,
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  MoveRight,
  Pencil,
  RefreshCw,
  Trash2,
  X
} from 'lucide-vue-next'
import ModalShell from '@renderer/components/ModalShell.vue'
import { formatHistoryTime } from '@shared/history'
import {
  FILES_EVENT,
  PANEL_LIST_LIMIT,
  formatSize,
  type FilesDeleteManyResult,
  type FilesListResult,
  type FilesMoveResult,
  type FilesNewResult,
  type FilesReadResult,
  type FilesSettingsState,
  type FsEntry
} from '../shared'
import type { ChooserStatus } from '../chooser'

defineOptions({ inheritAttrs: false })

const props = defineProps<{ payload?: { mode?: string; tabId?: number; multiple?: boolean } }>()

const api = window.browserAPI
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

const settings = ref<FilesSettingsState | null>(null)
const cwd = ref('')
const listing = ref<FilesListResult | null>(null)
const checked = ref<Set<string>>(new Set())
const preview = ref<{ path: string; text: string; truncated: boolean; size: number; mtimeMs: number } | null>(null)
const error = ref('')
const notice = ref('')
const loading = ref(false)
const showHidden = ref(false)
const renaming = ref('')
const renameValue = ref('')
const newDir = ref(false)
const newDirName = ref('')
/** 「网页正等着选文件」那次请求(不是 null 就处于选择模式) */
const pick = ref<{ tabId: number; multiple: boolean } | null>(null)
/** 接管状态(主进程说了算) */
const chooser = ref<ChooserStatus | null>(null)
/** 本窗口当前标签是不是接管着(手动接管/取消用它) */
const activeTabId = ref<number | null>(null)
const deleteArmed = ref(false)
let noticeTimer: number | undefined
let chooserTimer: number | undefined

const entries = computed<FsEntry[]>(() => listing.value?.entries ?? [])
const checkedEntries = computed<FsEntry[]>(() => entries.value.filter((e) => checked.value.has(e.path)))
const onlyOne = computed(() => checkedEntries.value.length === 1)
const upTarget = computed(() => parentOf(cwd.value, rootOf(cwd.value)))
const crumbs = computed(() => (cwd.value ? crumbsOf(cwd.value, rootOf(cwd.value)) : []))

function rootOf(path: string): string {
  const roots = (settings.value?.roots ?? []).map((r) => r.path)
  return roots.find((r) => path === r || path.startsWith(r.endsWith('/') || r.endsWith('\\') ? r : r + sepOf(r))) ?? path
}
function sepOf(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}
function parentOf(path: string, root: string): string {
  if (!path || path === root) return ''
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (i <= 0) return ''
  const parent = path.slice(0, i)
  return parent.endsWith(':') ? parent + sepOf(root) : parent
}
function crumbsOf(path: string, root: string): Array<{ label: string; path: string }> {
  const sep = sepOf(root)
  const trimmedRoot = root.replace(/[\\/]+$/, '')
  const out = [{ label: trimmedRoot.split(/[\\/]+/).pop() || trimmedRoot, path: root }]
  const rest = path.slice(root.length).replace(/^[\\/]+/, '')
  if (!rest) return out
  let acc = trimmedRoot
  for (const part of rest.split(/[\\/]+/)) {
    acc = `${acc}${sep}${part}`
    out.push({ label: part, path: acc })
  }
  return out
}

function flash(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 3000)
}
function requestClose(): void {
  if (chooserTimer) {
    window.clearInterval(chooserTimer)
    chooserTimer = undefined
  }
  emit('overlay-event', 'close-request')
}
function onShellEvent(event: string, args?: unknown): void {
  emit('overlay-event', event, args)
}

async function loadSettings(): Promise<void> {
  try {
    settings.value = await api.plugins.invoke<FilesSettingsState>('files', 'getSettings')
  } catch {
    error.value = '插件未就绪或已停用'
  }
}

async function load(dir: string): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await api.plugins.invoke<FilesListResult>('files', 'list', dir, {
      showHidden: showHidden.value,
      limit: PANEL_LIST_LIMIT
    })
    listing.value = result
    if (result.ok) {
      cwd.value = result.path ?? dir
      checked.value = new Set()
      deleteArmed.value = false
      renaming.value = ''
      preview.value = null
    } else {
      error.value = result.error ?? '列目录失败'
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function refresh(): Promise<void> {
  if (cwd.value) await load(cwd.value)
}

function toggle(entry: FsEntry): void {
  const next = new Set(checked.value)
  if (next.has(entry.path)) {
    next.delete(entry.path)
  } else {
    // 网页要的是单选(没有 multiple)时,勾第二个就把前一个顶掉
    if (pick.value && !pick.value.multiple) next.clear()
    next.add(entry.path)
  }
  checked.value = next
  deleteArmed.value = false
}
function toggleAll(): void {
  checked.value =
    checked.value.size === entries.value.length ? new Set() : new Set(entries.value.map((e) => e.path))
  deleteArmed.value = false
}

async function openEntry(entry: FsEntry): Promise<void> {
  if (entry.type === 'dir') {
    await load(entry.path)
    return
  }
  const result = await api.plugins.invoke<FilesReadResult>('files', 'readText', entry.path)
  if (!result.ok) {
    error.value = result.error ?? '读不出来'
    return
  }
  error.value = ''
  preview.value = {
    path: result.path ?? entry.path,
    text: result.text ?? '',
    truncated: result.truncated === true,
    size: result.size ?? 0,
    mtimeMs: result.mtimeMs ?? 0
  }
}

async function createDir(): Promise<void> {
  const name = newDirName.value.trim()
  if (!name || !cwd.value) return
  const result = await api.plugins.invoke<FilesNewResult>('files', 'mkdir', `${cwd.value}${sepOf(cwd.value)}${name}`)
  if (!result.ok) {
    error.value = result.error ?? '新建目录失败'
    return
  }
  newDir.value = false
  newDirName.value = ''
  flash(result.created ? '已新建目录' : '目录已存在')
  await refresh()
}

function startRename(): void {
  const target = checkedEntries.value[0]
  if (!target) return
  renaming.value = target.path
  renameValue.value = target.name
}

async function commitRename(): Promise<void> {
  const path = renaming.value
  if (!path) return
  const name = renameValue.value.trim()
  renaming.value = ''
  const current = entries.value.find((e) => e.path === path)
  if (!name || !current || name === current.name) return
  const result = await api.plugins.invoke<FilesMoveResult>('files', 'rename', path, name)
  if (!result.ok) {
    error.value = result.error ?? '重命名失败'
    return
  }
  flash('已重命名')
  await refresh()
}

async function moveOrCopy(kind: 'move' | 'copy'): Promise<void> {
  const target = checkedEntries.value
  if (target.length === 0) return
  const picked = await api.plugins.invoke<{ canceled?: boolean; path?: string }>('files', 'pickDirectory', cwd.value)
  if (picked.canceled || !picked.path) return
  const failed: string[] = []
  for (const entry of target) {
    const result = await api.plugins.invoke<FilesMoveResult>('files', kind, entry.path, picked.path)
    if (!result.ok) failed.push(`${entry.name}: ${result.error}`)
  }
  await refresh()
  if (failed.length > 0) error.value = failed.join(';')
  else flash(`${kind === 'move' ? '移动' : '复制'}了 ${target.length} 项`)
}

async function removeChecked(): Promise<void> {
  const target = checkedEntries.value
  if (target.length === 0) return
  if (!deleteArmed.value) {
    deleteArmed.value = true
    return
  }
  deleteArmed.value = false
  const result = await api.plugins.invoke<FilesDeleteManyResult>(
    'files',
    'remove',
    target.map((e) => e.path)
  )
  await refresh()
  if (result.failed.length > 0) {
    error.value = result.failed.map((f) => `${f.path.split(/[\\/]/).pop()}: ${f.error}`).join(';')
  } else {
    flash(`已移入回收站:${result.deleted.length} 项`)
  }
}

async function openExternally(): Promise<void> {
  const target = checkedEntries.value[0]
  if (!target) return
  const result = await api.plugins.invoke<{ ok: boolean; error?: string }>('files', 'openPath', target.path)
  if (result && result.ok === false) error.value = result.error ?? '打不开'
}

async function reveal(): Promise<void> {
  const target = checkedEntries.value[0]
  if (!target) return
  const result = await api.plugins.invoke<{ ok: boolean; error?: string }>('files', 'showInFolder', target.path)
  if (result && result.ok === false) error.value = result.error ?? '找不到这个位置'
}

function iconOf(entry: FsEntry): Component {
  if (entry.type === 'dir') return Folder
  if (entry.type === 'symlink') return Link2
  return isTextish(entry.name) ? FileText : File
}
function isTextish(name: string): boolean {
  return /\.(md|markdown|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|log|csv|tsv|ts|tsx|js|jsx|mjs|cjs|css|scss|html?|xml|svg|sh|bash|zsh|py|rs|go|java|kt|c|h|cpp|hpp|sql|vue|svelte)$/i.test(
    name
  )
}

async function refreshChooser(): Promise<void> {
  try {
    chooser.value = await api.plugins.invoke<ChooserStatus>('files', 'chooserStatus')
    activeTabId.value = (await api.getActiveTab())?.id ?? null
  } catch {
    chooser.value = null
  }
  // 选择模式里没人应答(面板被关掉 / 超时)时,主进程会把请求清掉 —— 这里跟着退出
  if (pick.value && !chooser.value?.pending) {
    pick.value = null
    checked.value = new Set()
  }
}

function enterPick(payload: { tabId?: number; multiple?: boolean } | undefined): void {
  if (!payload || typeof payload.tabId !== 'number') return
  pick.value = { tabId: payload.tabId, multiple: payload.multiple !== false }
  checked.value = new Set()
  void refreshChooser()
}

async function submitPick(): Promise<void> {
  const target = pick.value
  if (!target) return
  const paths = checkedEntries.value.map((e) => e.path)
  if (paths.length === 0) {
    error.value = '先勾选要上传的文件'
    return
  }
  const result = await api.plugins.invoke<{ ok: boolean; error?: string }>('files', 'answerChooser', paths)
  if (!result.ok) {
    error.value = result.error ?? '上传失败'
    return
  }
  pick.value = null
  checked.value = new Set()
  flash(`已交给网页 ${paths.length} 个文件`)
  void refreshChooser()
}

async function cancelPick(): Promise<void> {
  await api.plugins.invoke('files', 'cancelChooser')
  pick.value = null
  checked.value = new Set()
  flash('已取消这次文件选择')
  void refreshChooser()
}

async function toggleArm(): Promise<void> {
  const tabId = activeTabId.value
  if (tabId === null) return
  const armed = (chooser.value?.armedTabs ?? []).includes(tabId)
  const result = await api.plugins.invoke<{ ok: boolean; error?: string }>(
    'files',
    armed ? 'disarmTab' : 'armTab',
    tabId
  )
  if (!result.ok) error.value = result.error ?? '操作失败'
  await refreshChooser()
}

function onToggleHidden(event: Event): void {
  showHidden.value = (event.target as HTMLInputElement).checked
  void refresh()
}

watch(
  () => props.payload,
  (payload) => {
    if (payload?.mode === 'pick-upload') enterPick(payload)
  }
)

onMounted(async () => {
  await loadSettings()
  const first = settings.value?.roots[0]?.path ?? ''
  if (first) await load(first)
  if (props.payload?.mode === 'pick-upload') enterPick(props.payload)
  await refreshChooser()
  // 选择模式里轮询一下:主进程会惰性清掉超时的请求,这里跟着退出(= 用户在原生框上按 Esc 的效果)
  chooserTimer = window.setInterval(() => void refreshChooser(), 3000)
  api.plugins.onEvent((ev) => {
    if (ev.id !== 'files') return
    if (ev.event === FILES_EVENT.changed) settings.value = ev.args as FilesSettingsState
    if (ev.event === FILES_EVENT.chooserResolved) {
      const args = ev.args as { tabId?: number } | undefined
      if (!pick.value || args?.tabId === pick.value.tabId) {
        pick.value = null
        checked.value = new Set()
      }
    }
  })
})
</script>

<template>
  <ModalShell @overlay-event="onShellEvent">
    <div class="fs-panel">
      <div class="fs-head">
        <Folder :size="16" />
        <span class="fs-title">文件</span>
        <select class="fs-roots" :value="cwd" @change="load(($event.target as HTMLSelectElement).value)">
          <option v-for="root in settings?.roots ?? []" :key="root.path" :value="root.path">
            {{ root.path }}{{ root.isDefault ? '(默认)' : '' }}{{ root.exists ? '' : '(不存在)' }}
          </option>
        </select>
        <label class="fs-check fs-hidden">
          <input type="checkbox" :checked="showHidden" @change="onToggleHidden" />
          显示隐藏项
        </label>
        <span class="fs-spacer" />
        <button
          v-if="activeTabId !== null"
          class="btn"
          :class="{ primary: (chooser?.armedTabs ?? []).includes(activeTabId) }"
          :title="
            (chooser?.armedTabs ?? []).includes(activeTabId)
              ? '本窗口当前标签页正在接管文件选择(点击取消)'
              : '接管本窗口当前标签页的文件选择(页面点了按钮才出现输入框时用它)'
          "
          @click="toggleArm"
        >
          {{ (chooser?.armedTabs ?? []).includes(activeTabId) ? '文件选择:接管中' : '接管文件选择' }}
        </button>
        <button class="win-btn" title="关闭" @click="requestClose"><X :size="13" /></button>
      </div>

      <div class="fs-crumbs">
        <button class="fs-up" :disabled="!upTarget" title="上一层" @click="load(upTarget)">
          <ArrowUp :size="13" />
        </button>
        <template v-for="(crumb, i) in crumbs" :key="crumb.path">
          <span v-if="i > 0" class="fs-crumb-sep">/</span>
          <button class="fs-crumb" :title="crumb.path" @click="load(crumb.path)">{{ crumb.label }}</button>
        </template>
        <span class="fs-spacer" />
        <button class="btn" :disabled="loading" @click="refresh"><RefreshCw :size="12" />刷新</button>
      </div>

      <div v-if="pick" class="fs-alert pick">
        <Link2 :size="13" />
        网页(标签 {{ pick.tabId }})正在请求选择文件{{ pick.multiple ? '(可多选)' : '(只能选 1 个)' }}:
        勾选下面的文件,再点「上传选中的」。
      </div>
      <div v-if="error" class="fs-alert err">{{ error }}</div>
      <div v-else-if="notice" class="fs-alert">{{ notice }}</div>

      <div class="fs-body">
        <div class="fs-list">
          <div v-if="newDir" class="fs-row fs-newdir">
            <FolderPlus :size="14" class="fs-icon" />
            <input
              v-model="newDirName"
              class="fs-input"
              placeholder="新目录名"
              autofocus
              @keyup.enter="createDir"
              @keyup.escape="newDir = false"
            />
            <button class="btn primary" @click="createDir">建</button>
            <button class="btn" @click="newDir = false">取消</button>
          </div>

          <div v-if="entries.length === 0 && !loading" class="fs-empty">
            这个目录是空的(隐藏项默认不列)。
          </div>

          <div
            v-for="entry in entries"
            :key="entry.path"
            class="fs-row"
            :class="{ on: checked.has(entry.path) }"
          >
            <input
              class="fs-tick"
              type="checkbox"
              :checked="checked.has(entry.path)"
              @change="toggle(entry)"
            />
            <component :is="iconOf(entry)" :size="14" class="fs-icon" :class="entry.type" />
            <template v-if="renaming === entry.path">
              <input
                v-model="renameValue"
                class="fs-input"
                @keyup.enter="commitRename"
                @keyup.escape="renaming = ''"
              />
              <button class="btn primary" @click="commitRename">改</button>
              <button class="btn" @click="renaming = ''">取消</button>
            </template>
            <template v-else>
              <button class="fs-name" :title="entry.path" @click="openEntry(entry)">{{ entry.name }}</button>
              <span class="fs-size">{{ entry.type === 'dir' ? '' : formatSize(entry.size) }}</span>
              <span class="fs-time">{{ entry.mtimeMs ? formatHistoryTime(entry.mtimeMs) : '' }}</span>
            </template>
          </div>
        </div>

        <div v-if="preview" class="fs-preview">
          <div class="fs-preview-head">
            <span class="fs-preview-name" :title="preview.path">{{ preview.path.split(/[\\/]/).pop() }}</span>
            <span class="fs-size">{{ formatSize(preview.size) }}</span>
            <span class="fs-spacer" />
            <button class="win-btn" title="关闭预览" @click="preview = null"><X :size="12" /></button>
          </div>
          <div v-if="preview.truncated" class="fs-preview-note">只显示前 64 KiB</div>
          <pre class="fs-preview-body">{{ preview.text }}</pre>
        </div>
      </div>

      <div class="fs-foot">
        <button class="btn" @click="newDir = true"><FolderPlus :size="13" />新建目录</button>
        <button class="btn" :disabled="!onlyOne" @click="startRename"><Pencil :size="13" />重命名</button>
        <button class="btn" :disabled="checked.size === 0" @click="moveOrCopy('move')">
          <MoveRight :size="13" />移动到…
        </button>
        <button class="btn" :disabled="checked.size === 0" @click="moveOrCopy('copy')">
          <Copy :size="13" />复制到…
        </button>
        <button class="btn" :disabled="!onlyOne" @click="openExternally">
          <ExternalLink :size="13" />打开
        </button>
        <button class="btn" :disabled="!onlyOne" @click="reveal">显示位置</button>
        <span class="fs-spacer" />
        <template v-if="pick">
          <button class="btn" @click="cancelPick">取消这次选择</button>
          <button class="btn primary" :disabled="checked.size === 0" @click="submitPick">
            上传选中的 {{ checked.size }} 个文件
          </button>
        </template>
        <span v-if="checked.size > 0" class="fs-count">已选 {{ checked.size }} 项</span>
        <template v-if="deleteArmed">
          <span class="fs-danger"><AlertTriangle :size="12" />删除 {{ checked.size }} 项?</span>
          <button class="btn danger" @click="removeChecked">确认删除</button>
          <button class="btn" @click="deleteArmed = false">取消</button>
        </template>
        <button v-else class="btn danger" :disabled="checked.size === 0" @click="removeChecked">
          <Trash2 :size="13" />删除
        </button>
      </div>

      <div class="fs-hint">
        只能在这些工作目录里操作(与 AI 共用同一份白名单)。删除默认移入<b>系统回收站</b>(可恢复);
        覆盖已有文件在面板里不会发生 —— 重命名撞名会被拒绝。
        <template v-if="chooser && !chooser.enabled">
          网站文件选择接管已关闭(可在「设置 → 文件管理」打开;开着时网页的上传按钮改由本面板选文件)。
        </template>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.fs-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(960px, 92vw);
  height: min(640px, 82vh);
}
.fs-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.fs-title {
  font-size: 14px;
  font-weight: 600;
}
.fs-roots {
  flex: 0 1 380px;
  min-width: 0;
  padding: 3px 6px;
  font-size: 12px;
  color: var(--fg);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.fs-check {
  font-size: 12px;
  color: var(--fg-dim);
}
.fs-hidden {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.fs-spacer {
  flex: 1;
}
.fs-crumbs {
  display: flex;
  align-items: center;
  gap: 3px;
  min-height: 24px;
}
.fs-up {
  display: inline-flex;
  align-items: center;
  padding: 3px 5px;
  border-radius: var(--radius);
  color: var(--fg-dim);
}
.fs-up:hover:not(:disabled) {
  background: var(--bg3);
  color: var(--fg);
}
.fs-up:disabled {
  opacity: 0.35;
}
.fs-crumb {
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 5px;
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--fg-dim);
}
.fs-crumb:hover {
  background: var(--bg3);
  color: var(--fg);
}
.fs-crumb-sep {
  color: var(--fg-dim);
  font-size: 11px;
}
.fs-alert {
  font-size: 12px;
  color: var(--fg-dim);
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg3);
  word-break: break-all;
}
.fs-alert.err {
  color: var(--danger);
}
.fs-alert.pick {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.fs-body {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 8px;
}
.fs-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.fs-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
}
.fs-row:hover {
  background: var(--bg2);
}
.fs-row.on {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.fs-tick {
  flex: none;
  margin: 0;
}
.fs-icon {
  flex: none;
  color: var(--fg-dim);
}
.fs-icon.dir {
  color: var(--accent);
}
.fs-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  color: var(--fg);
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
}
.fs-name:hover {
  color: var(--accent);
}
.fs-input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  font-size: 12px;
  color: var(--fg);
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
}
.fs-size,
.fs-time {
  flex: none;
  color: var(--fg-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.fs-size {
  width: 62px;
  text-align: right;
}
.fs-time {
  width: 76px;
  text-align: right;
}
.fs-empty {
  padding: 28px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--fg-dim);
}
.fs-newdir {
  background: var(--bg2);
}
.fs-preview {
  display: flex;
  flex-direction: column;
  flex: 0 0 42%;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.fs-preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg2);
}
.fs-preview-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.fs-preview-note {
  padding: 3px 8px;
  font-size: 11px;
  color: var(--fg-dim);
}
.fs-preview-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 8px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.fs-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.fs-count {
  font-size: 11px;
  color: var(--fg-dim);
}
.fs-danger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--danger);
}
.fs-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--fg-dim);
}
</style>
