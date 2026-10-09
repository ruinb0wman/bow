<script setup lang="ts">
/**
 * 文件管理设置分区:AI 能读写的「工作目录」(白名单)。
 *
 * 这一节只配**策略**,不做文件浏览 —— 浏览面板是独立的一步(见 `.pi/plans/2026-10-09-file-manager-plugin/plan.md` 步骤 3)。
 * 所有判定都在主进程:这里连「这个路径合不合法」都不自己判,只负责把用户的选择送过去、
 * 把主进程返回的**生效状态**渲染出来(`denyList` 也在返回体里,用来解释为什么某个目录被拒)。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { FolderOpen, FolderPlus, Trash2 } from 'lucide-vue-next'
import { FILES_EVENT, type FilesSettingsState } from '../shared'

const api = window.browserAPI
const state = ref<FilesSettingsState | null>(null)
const notice = ref('')
const unsubs: Array<() => void> = []
let noticeTimer: number | undefined

function flash(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 3200)
}

async function refresh(): Promise<void> {
  state.value = await api.plugins.invoke<FilesSettingsState>('files', 'getSettings')
}

async function addRoots(): Promise<void> {
  const next = await api.plugins.invoke<FilesSettingsState & { canceled?: boolean; rejected?: string[] }>(
    'files',
    'pickRoots'
  )
  if (next.canceled) return
  state.value = next
  if (next.rejected?.length) {
    flash(`已忽略 ${next.rejected.length} 个目录(bow 自身的数据目录不在允许范围内)`)
  } else {
    flash('已添加工作目录')
  }
}

async function removeRoot(path: string): Promise<void> {
  state.value = await api.plugins.invoke<FilesSettingsState>('files', 'removeRoot', path)
  flash('已移除(工作目录为空时会回退到下载目录)')
}

async function openRoot(path: string): Promise<void> {
  const res = await api.plugins.invoke<{ ok: boolean; error?: string }>('files', 'openRoot', path)
  if (res && res.ok === false) flash(res.error ?? '打不开目录')
}

async function togglePermanent(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked
  state.value = await api.plugins.invoke<FilesSettingsState>('files', 'setSettings', {
    allowPermanentDelete: checked
  })
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'files' || ev.event !== FILES_EVENT.changed) return
      state.value = ev.args as FilesSettingsState
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (noticeTimer) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <section class="files-settings">
    <div class="section-title">AI 可读写的工作目录</div>
    <div class="fs-list">
      <div v-for="root in state?.roots ?? []" :key="root.path" class="fs-item">
        <FolderOpen :size="14" class="fs-icon" />
        <code class="fs-path" :title="root.path">{{ root.path }}</code>
        <span v-if="root.isDefault" class="fs-tag">默认</span>
        <span v-if="!root.exists" class="fs-tag fs-warn">不存在</span>
        <button class="btn" @click="openRoot(root.path)">打开</button>
        <button v-if="!root.isDefault" class="btn danger" @click="removeRoot(root.path)">
          <Trash2 :size="12" />移除
        </button>
      </div>
      <div v-if="!state" class="fs-empty">读取中…</div>
    </div>
    <div class="set-row">
      <button class="btn primary" @click="addRoots"><FolderPlus :size="13" />添加目录</button>
      <span v-if="notice" class="fs-notice">{{ notice }}</span>
    </div>
    <div class="fs-hint">
      AI 只能在这些目录之内操作文件(<code>browser_fs_*</code> 那组工具)。路径按<b>真实路径</b>判定,所以目录里指向外部的符号链接同样会被拒。
      一个都不配 = 只用 bow 的下载目录(<code>{{ state?.downloadsDir ?? '…' }}</code>),<b>不是</b>放开到全盘。
      bow 自身的数据目录(密码库 / 书签 / 插件设置)永远不可操作。
    </div>

    <div class="section-title">删除</div>
    <div class="set-row">
      <label class="set-check">
        <input
          type="checkbox"
          :checked="state?.settings.allowPermanentDelete ?? false"
          @change="togglePermanent"
        />
        允许永久删除(不经过系统回收站)
      </label>
    </div>
    <div class="fs-hint">
      关着的时候 <code>browser_fs_delete</code> 一律把文件移进系统回收站(可恢复);打开之后 AI 才能传
      <code>permanent:true</code> 真删 —— 那是不可恢复的。覆盖已有文件是另一回事:必须显式
      <code>overwrite:true</code>,与这个开关无关。
    </div>
  </section>
</template>

<style scoped>
/* 父层 `.settings-body-plugin` 是 overflow:hidden,这一节必须自己滚(约定见 ARCHITECTURE §7.3) */
.files-settings {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 14px 20px;
  font-size: 13px;
}
.section-title {
  margin: 18px 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg-dim);
}
.files-settings .section-title:first-child {
  margin-top: 8px;
}
.fs-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fs-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.fs-icon {
  flex: none;
  color: var(--fg-dim);
}
.fs-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.fs-tag {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--fg-dim);
}
.fs-warn {
  background: rgba(255, 170, 60, 0.18);
  color: var(--warning, #ffaa3c);
}
.fs-empty {
  padding: 6px 4px;
  color: var(--fg-dim);
  font-size: 12px;
}
.fs-notice {
  color: var(--fg-dim);
  font-size: 12px;
}
.fs-hint {
  padding: 0 14px 6px;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.7;
}
</style>
