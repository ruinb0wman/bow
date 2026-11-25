<script setup lang="ts">
/**
 * 密码插件设置分区:自动锁定 / 剪贴板清除 / 子域匹配 / 修改主密码 / 清空。
 * 「修改主密码」需要已解锁;「清空密码库」在锁定时也能用(它是唯一的逃生口)。
 *
 * 原先的「导出/导入加密备份」已并入设置页的核心「备份」分区(整包备份/还原)——
 * 密文本来就在 `passwords.json` 里,整包备份原样带走。
 */
import { RButton, RCheckbox, RFormRow } from '@ruinb0w/ui'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Lock, Trash2 } from '@lucide/vue'
import { useFlash } from '@renderer/lib/useFlash'
import {
  AUTO_LOCK_OPTIONS,
  CLIPBOARD_CLEAR_OPTIONS,
  normalizeSettings,
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
      密码库是 <code>passwords.json</code>(密文,salt 与 KDF 参数为明文),存放在浏览器数据目录。
      换机器 / 换库用<b>设置页 → 备份</b>的统一备份与还原(整包;还原后需用<b>该备份自己的主密码</b>解锁)。
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
