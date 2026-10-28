<script setup lang="ts">
/**
 * 密码插件设置分区:自动锁定 / 剪贴板清除 / 子域匹配 / 修改主密码 / 清空。
 * 「修改主密码」需要已解锁;「清空密码库」在锁定时也能用(它是唯一的逃生口)。
 */
import { RButton, RCheckbox, RFormRow } from '@ruinb0w/ui'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Download, Lock, Trash2, Upload } from '@lucide/vue'
import { useFlash } from '@renderer/lib/useFlash'
import {
  AUTO_LOCK_OPTIONS,
  CLIPBOARD_CLEAR_OPTIONS,
  normalizeSettings,
  type ExportBackupResult,
  type ImportBackupResult,
  type OkResult,
  type PasswordSettings,
  type PasswordStatus
} from '../shared'

const api = window.browserAPI
const settings = ref<PasswordSettings | null>(null)
const status = ref<PasswordStatus | null>(null)
const oldMaster = ref('')
const newMaster = ref('')
const confirmMaster = ref('')
const wipeArmed = ref(false)
const backupArmed = ref(false)
const importArmed = ref(false)
const backupPath = ref('')
const preimportPath = ref('')
const { notice, flash } = useFlash(2600)
const error = ref('')
const unsubs: Array<() => void> = []

async function refresh(): Promise<void> {
  settings.value = normalizeSettings(await api.plugins.invoke<PasswordSettings>('passwords', 'getSettings'))
  status.value = await api.plugins.invoke<PasswordStatus>('passwords', 'status')
}

async function save(patch: Partial<PasswordSettings>): Promise<void> {
  settings.value = await api.plugins.invoke<PasswordSettings>('passwords', 'setSettings', patch)
  flash('已保存')
}

async function lockNow(): Promise<void> {
  await api.plugins.invoke('passwords', 'lock')
  await refresh()
  flash('已锁定')
}

async function changeMaster(): Promise<void> {
  error.value = ''
  if (newMaster.value !== confirmMaster.value) {
    error.value = '两次输入的新主密码不一致'
    return
  }
  const res = await api.plugins.invoke<OkResult>(
    'passwords',
    'changeMaster',
    oldMaster.value,
    newMaster.value
  )
  if (!res.ok) {
    error.value = res.error || '修改失败'
    return
  }
  oldMaster.value = ''
  newMaster.value = ''
  confirmMaster.value = ''
  await refresh()
  flash('主密码已修改')
}

async function wipe(): Promise<void> {
  const res = await api.plugins.invoke<OkResult>('passwords', 'wipe')
  wipeArmed.value = false
  if (!res.ok) {
    error.value = res.error || '清空失败'
    return
  }
  await refresh()
  flash('密码库已清空')
}

/** 导出整库密文到 bow 下载目录;已初始化即可用(锁定时也行 —— 导出物不含明文) */
async function exportBackup(): Promise<void> {
  error.value = ''
  const res = await api.plugins.invoke<ExportBackupResult>('passwords', 'exportBackup')
  backupArmed.value = false
  if (!res.ok) {
    error.value = res.error || '导出失败'
    return
  }
  backupPath.value = res.path || ''
  flash('加密备份已导出')
}

/**
 * 导入加密备份:**整库替换**。
 * 主进程负责结构校验与「覆盖前先备份当前库」;这里只负责确认与把结果说清楚 ——
 * 导入后库是锁定的,要用**备份自己的主密码**解锁。
 */
async function importBackup(): Promise<void> {
  error.value = ''
  preimportPath.value = ''
  const res = await api.plugins.invoke<ImportBackupResult>('passwords', 'importBackup')
  importArmed.value = false
  // 用户取消文件选择框:不是错误,什么都不说
  if (res.canceled) return
  if (!res.ok) {
    error.value = res.error || '导入失败'
    return
  }
  backupPath.value = ''
  preimportPath.value = res.backupPath || ''
  await refresh()
  flash('加密备份已导入,请用该备份的主密码解锁')
}

onMounted(() => {
  void refresh()
  unsubs.push(
    api.plugins.onEvent((ev) => {
      if (ev.id === 'passwords' && (ev.event === 'state-changed' || ev.event === 'settings-changed')) {
        void refresh()
      }
    })
  )
})

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})
</script>

<template>
  <section class="pw-settings">
    <div class="section-title">密码库</div>
    <RFormRow label="状态">
      <span class="pw-settings-state">
        {{ !status ? '…' : !status.initialized ? '尚未创建' : status.locked ? `已锁定(共 ${status.count} 条)` : `已解锁(共 ${status.count} 条)` }}
      </span>
      <RButton size="small" v-if="status && !status.locked" @click="lockNow"><Lock :size="12" />立即锁定</RButton>
    </RFormRow>

    <RFormRow label="自动锁定">
      <select
        :value="settings?.autoLockMinutes ?? 5"
        @change="save({ autoLockMinutes: Number(($event.target as HTMLSelectElement).value) })"
      >
        <option v-for="v in AUTO_LOCK_OPTIONS" :key="v" :value="v">{{ v === 0 ? '不自动锁定' : `${v} 分钟` }}</option>
      </select>
    </RFormRow>

    <RFormRow label="清剪贴板">
      <select
        :value="settings?.clipboardClearSeconds ?? 30"
        @change="save({ clipboardClearSeconds: Number(($event.target as HTMLSelectElement).value) })"
      >
        <option v-for="v in CLIPBOARD_CLEAR_OPTIONS" :key="v" :value="v">
          {{ v === 0 ? '不清除' : `${v} 秒后` }}
        </option>
      </select>
      <span class="pw-settings-hint">只清除「还是那条密码」的剪贴板;你已经复制了别的东西就不动它。</span>
    </RFormRow>

    <RFormRow label="子域匹配">
      <RCheckbox
        :model-value="settings?.matchSubdomains ?? true"
        @change="(v: boolean) => save({ matchSubdomains: v })"
      >
        让 <code>accounts.example.com</code> 命中条目里的 <code>example.com</code>
      </RCheckbox>
    </RFormRow>

    <div class="section-title">修改主密码</div>
    <RFormRow label="旧主密码">
      <input v-model="oldMaster" type="password" autocomplete="current-password" />
      <span class="set-label">新主密码</span>
      <input v-model="newMaster" type="password" autocomplete="new-password" />
      <span class="set-label">再输一次</span>
      <input v-model="confirmMaster" type="password" autocomplete="new-password" />
      <RButton size="small" :disabled="status?.locked ?? true" @click="changeMaster">修改</RButton>
    </RFormRow>
    <div v-if="status?.locked" class="pw-settings-hint">密码库已锁定,先解锁才能修改主密码。</div>

    <div class="section-title">备份</div>
    <RFormRow label="导出加密备份">
      <template v-if="backupArmed">
        <span class="pw-settings-hint">
          导出的是整库密文(与 passwords.json 内容一致),不会泄露明文;恢复仍需主密码。
        </span>
        <RButton size="small" type="primary" @click="exportBackup"><Download :size="12" />确认导出</RButton>
        <RButton size="small" @click="backupArmed = false">取消</RButton>
      </template>
      <RButton size="small" v-else :disabled="!status?.initialized" @click="backupArmed = true">
        <Download :size="12" />导出…
      </RButton>
    </RFormRow>
    <div v-if="backupPath" class="pw-settings-hint">已导出:<code>{{ backupPath }}</code></div>

    <RFormRow label="导入加密备份">
      <template v-if="importArmed">
        <span class="pw-settings-hint">
          会<strong>整库替换</strong>当前密码库{{ status?.initialized ? '(已初始化时会先把当前库导出一份到 bow 下载目录)' : '' }};
          导入后需要<strong>该备份自己的主密码</strong>才能解锁。
        </span>
        <RButton size="small" type="danger" plain @click="importBackup"><Upload :size="12" />确认导入</RButton>
        <RButton size="small" @click="importArmed = false">取消</RButton>
      </template>
      <RButton size="small" v-else @click="importArmed = true"><Upload :size="12" />导入…</RButton>
    </RFormRow>
    <div v-if="preimportPath" class="pw-settings-hint">
      导入前的当前库已备份到:<code>{{ preimportPath }}</code>
    </div>

    <div class="section-title">危险操作</div>
    <RFormRow label="清空密码库">
      <template v-if="wipeArmed">
        <span class="pw-settings-hint">真的要删掉全部条目并重置主密码?这一步不可撤销。</span>
        <RButton size="small" type="danger" plain @click="wipe"><Trash2 :size="12" />确认清空</RButton>
        <RButton size="small" @click="wipeArmed = false">取消</RButton>
      </template>
      <RButton size="small" type="danger" plain v-else @click="wipeArmed = true"><Trash2 :size="12" />清空…</RButton>
    </RFormRow>

    <div v-if="error" class="pw-settings-error">{{ error }}</div>
    <div class="pw-settings-hint">
      密码库是 <code>passwords.json</code>(密文,salt 与 KDF 参数为明文),存放在浏览器数据目录;
      用上面的「导出加密备份」把整库密文写进 bow 下载目录,手工整份复制也可以;
      换机器 / 换库用「导入加密备份」(整库替换,导入后需用备份自己的主密码解锁)。
      <strong>主密码忘记后无法恢复。</strong>
    </div>
    <div v-if="notice" class="pw-settings-notice">{{ notice }}</div>
  </section>
</template>

<style scoped>
.pw-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pw-settings-state {
  color: var(--fg-dim);
  font-size: 13px;
}
.pw-settings-hint {
  color: var(--fg-dim);
  font-size: 12px;
  line-height: 1.6;
}
.pw-settings-error {
  padding: 0 14px;
  color: var(--danger);
  font-size: 12px;
}
.pw-settings-notice {
  padding: 0 14px;
  color: var(--accent);
  font-size: 12px;
}
code {
  font-size: 12px;
}
</style>
