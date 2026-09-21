<script setup lang="ts">
/**
 * 下载插件设置分区:保存位置 / 是否询问 / 记录上限 / 清空记录。
 * 所有设置即时保存(没有保存按钮的只有「记录上限」—— 那个需要先校验输入)。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { FolderOpen, Save, Trash2 } from 'lucide-vue-next'
import {
  DEFAULT_DOWNLOAD_SETTINGS,
  DOWNLOADS_EVENT,
  MAX_RECORDS_MAX,
  MAX_RECORDS_MIN,
  type DownloadsListResult,
  type DownloadsSettingsState
} from '../shared'

const api = window.browserAPI
const state = ref<DownloadsSettingsState | null>(null)
const capInput = ref(String(DEFAULT_DOWNLOAD_SETTINGS.maxRecords))
const count = ref(0)
const capError = ref('')
const notice = ref('')
const clearConfirm = ref(false)
const unsubs: Array<() => void> = []
let noticeTimer: number | undefined

function flash(text: string): void {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = ''
  }, 2200)
}

async function refresh(): Promise<void> {
  const result = await api.plugins.invoke<DownloadsListResult>('downloads', 'list')
  state.value = { settings: result.settings, dir: result.dir, dirIsDefault: result.dirIsDefault }
  count.value = result.records.length
  capInput.value = String(result.settings.maxRecords)
}

async function pick(): Promise<void> {
  const next = await api.plugins.invoke<DownloadsSettingsState & { canceled?: boolean }>(
    'downloads',
    'pickDirectory'
  )
  if (next.canceled) return
  state.value = { settings: next.settings, dir: next.dir, dirIsDefault: next.dirIsDefault }
  flash('保存目录已更新')
}

async function reveal(): Promise<void> {
  const res = await api.plugins.invoke<{ ok: boolean; error?: string }>('downloads', 'revealDir')
  if (res && res.ok === false) flash(res.error ?? '打不开目录')
}

async function toggleAsk(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked
  const next = await api.plugins.invoke<DownloadsSettingsState>('downloads', 'setSettings', {
    askWhereToSave: checked
  })
  state.value = next
}

async function saveCap(): Promise<void> {
  const n = Number(capInput.value)
  if (!Number.isInteger(n) || n < MAX_RECORDS_MIN || n > MAX_RECORDS_MAX) {
    capError.value = `请输入 ${MAX_RECORDS_MIN}–${MAX_RECORDS_MAX} 之间的整数`
    return
  }
  capError.value = ''
  const next = await api.plugins.invoke<DownloadsSettingsState>('downloads', 'setSettings', { maxRecords: n })
  state.value = next
  capInput.value = String(next.settings.maxRecords)
  flash(`已保留最近 ${next.settings.maxRecords} 条记录`)
}

async function clearAll(): Promise<void> {
  if (!clearConfirm.value) {
    clearConfirm.value = true
    return
  }
  clearConfirm.value = false
  await api.plugins.invoke('downloads', 'clear', false)
  await refresh()
  flash('已清空全部下载记录(文件不会被删除)')
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id !== 'downloads' || ev.event !== DOWNLOADS_EVENT.changed) return
      void api.plugins
        .invoke<DownloadsListResult>('downloads', 'list')
        .then((r) => {
          count.value = r.records.length
        })
        .catch(() => {})
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  if (noticeTimer) window.clearTimeout(noticeTimer)
})
</script>

<template>
  <section class="downloads-settings">
    <div class="section-title">保存位置</div>
    <div class="set-row ds-dir-row">
      <span class="set-label">保存到</span>
      <code class="ds-dir" :title="state?.dir">{{ state?.dir ?? '读取中…' }}</code>
      <span v-if="state?.dirIsDefault" class="ds-tag">系统默认</span>
      <button class="btn" @click="pick"><FolderOpen :size="13" />选择目录</button>
      <button class="btn" @click="reveal">打开目录</button>
    </div>
    <div class="set-row">
      <label class="set-check">
        <input
          type="checkbox"
          :checked="state?.settings.askWhereToSave ?? true"
          @change="toggleAsk"
        />
        下载前询问保存位置
      </label>
    </div>
    <div class="ds-hint">
      关掉询问后,下载直接保存到上面的目录;同名文件会自动加 <code>(1)</code>,不会覆盖已有文件。
      另外 <code>browser_download</code>(AI 发起的下载)一律不弹对话框,只落到这里或它指定的目录。
    </div>

    <div class="section-title">记录</div>
    <div class="set-row">
      <span class="set-label">保留条数</span>
      <input
        v-model="capInput"
        class="pbm-input ds-cap"
        type="number"
        :min="MAX_RECORDS_MIN"
        :max="MAX_RECORDS_MAX"
        @keyup.enter="saveCap"
      />
      <span class="ds-unit">条</span>
      <button class="btn primary" @click="saveCap"><Save :size="13" />保存</button>
      <span class="set-hcount">当前 {{ count }} 条(进行中的下载永不裁剪)</span>
    </div>
    <div v-if="capError" class="ds-error">{{ capError }}</div>
    <div class="set-row">
      <span class="set-label">清空记录</span>
      <template v-if="!clearConfirm">
        <button class="btn danger" :disabled="count === 0" @click="clearAll">
          <Trash2 :size="13" />清空全部记录
        </button>
      </template>
      <template v-else>
        <span class="ds-confirm">确认清空全部 {{ count }} 条?</span>
        <button class="btn danger" @click="clearAll">确认清空</button>
        <button class="btn" @click="clearConfirm = false">取消</button>
      </template>
      <span v-if="notice" class="ds-notice">{{ notice }}</span>
    </div>
    <div class="ds-hint">删除记录只移除列表项,磁盘上的文件不会被动。</div>
  </section>
</template>

<style scoped>
/* 父层 `.settings-body-plugin` 是 overflow:hidden,这一节必须自己滚(约定见 ARCHITECTURE §7.3) */
.downloads-settings {
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
.downloads-settings .section-title:first-child {
  margin-top: 8px;
}
.ds-dir-row {
  gap: 8px;
  flex-wrap: wrap;
}
.ds-dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--fg);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 4px 8px;
}
.ds-tag {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--fg-dim);
}
.ds-hint {
  padding: 0 14px 6px 110px;
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.6;
}
.ds-cap {
  flex: none;
  width: 96px;
}
.ds-unit {
  flex: none;
  color: var(--fg-dim);
  font-size: 12px;
}
.ds-error {
  padding: 0 14px 8px 122px;
  color: var(--danger);
  font-size: 12px;
}
.ds-confirm {
  color: var(--danger);
  font-size: 12px;
}
.ds-notice {
  color: var(--fg-dim);
  font-size: 12px;
}
</style>
