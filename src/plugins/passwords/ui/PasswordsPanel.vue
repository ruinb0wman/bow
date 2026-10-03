<script setup lang="ts">
/**
 * 密码面板(全屏浮层):未创建 → 创建主密码;已锁定 → 解锁;已解锁 → 列表 / 搜索 / 编辑。
 *
 * 它只做两件事:调 `plugins.invoke('passwords', …)` 与渲染 ——
 * 解锁态、origin 匹配、剪贴板清除这些判据全在主进程侧(`main.ts`)。
 * 主进程不能直接开浮层,所以「快捷键触发但需要用户介入」时它发 `open-panel`,
 * 由工具栏按钮组件打开本面板(见 `PasswordsButton.vue`)。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ClipboardCopy,
  FilePlus2,
  KeyRound,
  Lock,
  LogIn,
  Pencil,
  Plus,
  Search,
  Trash2,
  Unlock
} from 'lucide-vue-next'
import ModalShell from '@renderer/components/ModalShell.vue'
import {
  draftFromEntry,
  draftFromFields,
  emptyDraft,
  type EntryDraft,
  type EntryListResult,
  type EntryMeta,
  type OkResult,
  type PasswordStatus,
  type ReadPageFieldsResult,
  type SingleEntryResult
} from '../shared'
import EntryEditor from './EntryEditor.vue'

const props = defineProps<{ payload?: { mode?: string; tabId?: number } }>()
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

const api = window.browserAPI
const status = ref<PasswordStatus | null>(null)
const entries = ref<EntryMeta[]>([])
const query = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const setupMaster = ref('')
const setupConfirm = ref('')
const unlockMaster = ref('')
const editing = ref<EntryDraft | null>(null)
const confirmRemove = ref<string | null>(null)
const unsubs: Array<() => void> = []
let noticeTimer: number | undefined

const unlocked = computed(() => !!status.value && status.value.initialized && !status.value.locked)
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return entries.value
  return entries.value.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      e.origin.toLowerCase().includes(q) ||
      e.username.toLowerCase().includes(q)
  )
})

function onShellEvent(event: string, args?: unknown): void {
  emit('overlay-event', event, args)
}

function flash(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 2600)
}

function fail(text?: string): void {
  error.value = text || '操作失败'
}

async function refreshStatus(): Promise<void> {
  status.value = await api.plugins.invoke<PasswordStatus>('passwords', 'status')
}

async function refreshList(): Promise<void> {
  const res = await api.plugins.invoke<EntryListResult>('passwords', 'list')
  entries.value = res.ok ? (res.entries ?? []) : []
}

async function reload(): Promise<void> {
  await refreshStatus()
  if (unlocked.value) await refreshList()
  else entries.value = []
}

async function doSetup(): Promise<void> {
  error.value = ''
  if (setupMaster.value !== setupConfirm.value) {
    fail('两次输入的主密码不一致')
    return
  }
  busy.value = true
  const res = await api.plugins.invoke<OkResult>('passwords', 'setup', setupMaster.value)
  busy.value = false
  if (!res.ok) {
    fail(res.error)
    return
  }
  setupMaster.value = ''
  setupConfirm.value = ''
  flash('主密码已创建')
  await reload()
}

async function doUnlock(): Promise<void> {
  error.value = ''
  busy.value = true
  const res = await api.plugins.invoke<OkResult>('passwords', 'unlock', unlockMaster.value)
  busy.value = false
  if (!res.ok) {
    fail(res.error)
    return
  }
  unlockMaster.value = ''
  await reload()
}

async function doLock(): Promise<void> {
  await api.plugins.invoke('passwords', 'lock')
  editing.value = null
  error.value = ''
  await reload()
}

async function copyField(id: string, field: 'username' | 'password'): Promise<void> {
  const res = await api.plugins.invoke<{ ok: boolean; error?: string; clearsIn?: number }>(
    'passwords',
    'copy',
    id,
    field
  )
  if (!res.ok) {
    fail(res.error)
    return
  }
  flash(field === 'password' && res.clearsIn ? `已复制密码,${res.clearsIn} 秒后清除剪贴板` : '已复制')
}

async function fill(id: string): Promise<void> {
  const res = await api.plugins.invoke<OkResult>('passwords', 'fillEntry', id)
  if (!res.ok) {
    fail(res.error)
    return
  }
  flash('已填入当前页面')
}

function startNew(): void {
  error.value = ''
  editing.value = emptyDraft()
}

async function startFromPage(): Promise<void> {
  error.value = ''
  const res = await api.plugins.invoke<ReadPageFieldsResult>('passwords', 'readPageFields')
  editing.value = res.ok ? draftFromFields(res) : emptyDraft()
  if (!res.ok) error.value = res.error || '读取当前页面失败,请手动填写'
}

async function startEdit(id: string): Promise<void> {
  const res = await api.plugins.invoke<SingleEntryResult>('passwords', 'getEntry', id)
  if (!res.ok || !res.entry) {
    fail(res.error)
    return
  }
  error.value = ''
  editing.value = draftFromEntry(res.entry)
}

async function saveDraft(draft: EntryDraft): Promise<void> {
  busy.value = true
  error.value = ''
  const res = await api.plugins.invoke<OkResult>('passwords', 'save', draft)
  busy.value = false
  if (!res.ok) {
    error.value = res.error || '保存失败'
    return
  }
  editing.value = null
  flash('已保存')
  await refreshList()
}

async function removeEntry(id: string): Promise<void> {
  const res = await api.plugins.invoke<OkResult>('passwords', 'remove', id)
  if (!res.ok) {
    fail(res.error)
    return
  }
  confirmRemove.value = null
  flash('已删除')
  await refreshList()
}

onMounted(async () => {
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'passwords') return
      if (ev.event === 'state-changed') void reload()
    })
  )
  await reload()
  if (props.payload?.mode === 'save' && unlocked.value) await startFromPage()
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (noticeTimer) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <ModalShell @overlay-event="onShellEvent">
    <div class="pw">
      <div class="modal-head">
        <span class="pw-title"><KeyRound :size="14" />密码</span>
        <div class="pw-head-actions">
          <span v-if="status" class="pw-state">
            {{ !status.initialized ? '未创建' : status.locked ? '已锁定' : `已解锁 · ${status.count} 条` }}
          </span>
          <button v-if="unlocked" class="btn" @click="doLock"><Lock :size="12" />立即锁定</button>
        </div>
      </div>

      <div v-if="!status" class="pw-empty">加载中…</div>

      <form v-else-if="!status.initialized" class="pw-form" @submit.prevent="doSetup">
        <p class="pw-hint">
          给密码库设一个主密码。它只存在于主进程内存里,明文不落盘;
          <strong>忘记主密码后密码库无法恢复</strong>(文件是 <code>passwords.json</code>,整份复制即备份)。
        </p>
        <label class="pw-field"><span>主密码</span><input v-model="setupMaster" type="password" autocomplete="new-password" /></label>
        <label class="pw-field"><span>再输一次</span><input v-model="setupConfirm" type="password" autocomplete="new-password" /></label>
        <div v-if="error" class="pw-error">{{ error }}</div>
        <div class="pw-form-actions">
          <button class="btn primary" type="submit" :disabled="busy">创建密码库</button>
        </div>
      </form>

      <form v-else-if="status.locked" class="pw-form" @submit.prevent="doUnlock">
        <p class="pw-hint">输入主密码解锁。自动锁定 {{ status.settings.autoLockMinutes === 0 ? '已关闭' : `${status.settings.autoLockMinutes} 分钟` }}。</p>
        <label class="pw-field"><span>主密码</span><input v-model="unlockMaster" type="password" autocomplete="current-password" /></label>
        <div v-if="error" class="pw-error">{{ error }}</div>
        <div class="pw-form-actions">
          <button class="btn primary" type="submit" :disabled="busy"><Unlock :size="12" />解锁</button>
        </div>
      </form>

      <template v-else>
        <EntryEditor
          v-if="editing"
          :draft="editing"
          :busy="busy"
          :error="error"
          @save="saveDraft"
          @cancel="editing = null"
        />
        <template v-else>
          <div class="pw-tools">
            <Search :size="13" class="pw-tools-icon" />
            <input v-model="query" class="pw-search" placeholder="搜索名称 / 站点 / 用户名" spellcheck="false" />
            <button class="btn" title="读取当前页面的账号密码并预填" @click="startFromPage">
              <FilePlus2 :size="12" />从当前页面保存
            </button>
            <button class="btn primary" @click="startNew"><Plus :size="12" />新增</button>
          </div>
          <div v-if="error" class="pw-error">{{ error }}</div>
          <div class="pw-list">
            <div v-if="filtered.length === 0" class="pw-empty">
              {{ query ? '没有匹配的条目' : '还没有条目。去登录页点「从当前页面保存」最快。' }}
            </div>
            <div v-for="item in filtered" :key="item.id" class="pw-row">
              <div class="pw-main">
                <div class="pw-name">{{ item.title }}</div>
                <div class="pw-sub">
                  {{ item.origin }}<span v-if="item.username"> · {{ item.username }}</span>
                </div>
              </div>
              <div class="pw-row-actions">
                <button class="tool-btn small" title="填入当前页面" @click="fill(item.id)"><LogIn :size="13" /></button>
                <button class="tool-btn small" title="复制用户名" @click="copyField(item.id, 'username')">
                  <ClipboardCopy :size="13" />
                </button>
                <button class="tool-btn small" title="复制密码" @click="copyField(item.id, 'password')">
                  <KeyRound :size="13" />
                </button>
                <button class="tool-btn small" title="编辑" @click="startEdit(item.id)"><Pencil :size="13" /></button>
                <template v-if="confirmRemove === item.id">
                  <button class="btn danger" @click="removeEntry(item.id)">确认删除</button>
                  <button class="btn" @click="confirmRemove = null">取消</button>
                </template>
                <button v-else class="tool-btn small" title="删除" @click="confirmRemove = item.id">
                  <Trash2 :size="13" />
                </button>
              </div>
            </div>
          </div>
        </template>
      </template>

      <div v-if="notice" class="pw-notice">{{ notice }}</div>
    </div>
  </ModalShell>
</template>

<style scoped>
.pw {
  width: min(720px, 94vw);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.pw-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pw-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.pw-state {
  color: var(--fg-dim);
  font-size: 12px;
  font-weight: 400;
}
.pw-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
}
.pw-field {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pw-field > span {
  flex: none;
  width: 72px;
  color: var(--fg-dim);
}
.pw-field input {
  flex: 1;
  min-width: 0;
}
.pw-form-actions {
  display: flex;
  justify-content: flex-end;
}
.pw-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
}
.pw-tools-icon {
  color: var(--fg-dim);
  flex: none;
}
.pw-search {
  flex: 1;
  min-width: 0;
}
.pw-list {
  overflow: auto;
  max-height: 56vh;
  padding: 0 6px 6px;
}
.pw-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius);
}
.pw-row:hover {
  background: var(--bg3);
}
.pw-main {
  flex: 1;
  min-width: 0;
}
.pw-name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pw-sub {
  color: var(--fg-dim);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pw-row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.pw-empty {
  padding: 18px 14px;
  color: var(--fg-dim);
  font-size: 13px;
  text-align: center;
}
.pw-error {
  padding: 0 14px 8px;
  color: var(--danger);
  font-size: 12px;
}
.pw-notice {
  padding: 8px 14px;
  color: var(--accent);
  font-size: 12px;
}
.pw-hint {
  margin: 0;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.6;
}
code {
  font-size: 12px;
}
</style>
