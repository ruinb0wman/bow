<script setup lang="ts">
/**
 * 下载插件设置分区:保存位置 / 是否询问 / 记录上限 / 清空记录。
 * 所有设置即时保存(没有保存按钮的只有「记录上限」—— 那个需要先校验输入)。
 */
import { RBadge, RButton, RCheckbox, RFormRow } from '@ruinb0w/ui'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { FolderOpen, Save, Trash2 } from '@lucide/vue'
import { useFlash } from '@renderer/lib/useFlash'
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
const { notice, flash } = useFlash(2200)
const clearConfirm = ref(false)
const unsubs: Array<() => void> = []

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

async function toggleAsk(checked: boolean): Promise<void> {
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
})
</script>

<template>
  <section class="downloads-settings">
    <div class="section-title">保存位置</div>
    <RFormRow label="保存到">
      <code class="ds-dir" :title="state?.dir">{{ state?.dir ?? '读取中…' }}</code>
      <RBadge v-if="state?.dirIsDefault">系统默认</RBadge>
      <RButton size="small" @click="pick"><FolderOpen :size="13" />选择目录</RButton>
      <RButton size="small" @click="reveal">打开目录</RButton>
    </RFormRow>
    <RFormRow>
      <RCheckbox
        :model-value="state?.settings.askWhereToSave ?? true"
        label="下载前询问保存位置"
        @change="toggleAsk"
      />
    </RFormRow>
    <div class="ds-hint">
      关掉询问后,下载直接保存到上面的目录;同名文件会自动加 <code>(1)</code>,不会覆盖已有文件。
      另外 <code>browser_download</code>(AI 发起的下载)一律不弹对话框,只落到这里或它指定的目录;
      它指定的 <code>saveDir</code> 必须在<b>白名单工作目录</b>里 —— 也就是 bow 的下载目录或
      <code>&lt;userData&gt;/files-settings.json</code> 的 <code>roots</code>(下载目录总在里面,不用额外配)。
    </div>

    <div class="section-title">记录</div>
    <RFormRow label="保留条数">
      <input
        v-model="capInput"
        class="pbm-input ds-cap"
        type="number"
        :min="MAX_RECORDS_MIN"
        :max="MAX_RECORDS_MAX"
        @keyup.enter="saveCap"
      />
      <span class="ds-unit">条</span>
      <RButton size="small" type="primary" @click="saveCap"><Save :size="13" />保存</RButton>
      <span class="set-hcount">当前 {{ count }} 条(进行中的下载永不裁剪)</span>
    </RFormRow>
    <div v-if="capError" class="ds-error">{{ capError }}</div>
    <RFormRow label="清空记录">
      <template v-if="!clearConfirm">
        <RButton size="small" type="danger" plain :disabled="count === 0" @click="clearAll">
          <Trash2 :size="13" />清空全部记录
        </RButton>
      </template>
      <template v-else>
        <span class="ds-confirm">确认清空全部 {{ count }} 条?</span>
        <RButton size="small" type="danger" plain @click="clearAll">确认清空</RButton>
        <RButton size="small" @click="clearConfirm = false">取消</RButton>
      </template>
      <span v-if="notice" class="ds-notice">{{ notice }}</span>
    </RFormRow>
    <div class="ds-hint">删除记录只移除列表项,磁盘上的文件不会被动。</div>
  </section>
</template>

<style scoped>
/* 长列表在自己框内滚,不带动整页 */
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
