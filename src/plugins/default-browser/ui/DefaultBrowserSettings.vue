<script setup lang="ts">
/**
 * 默认浏览器设置分区:状态徽标 + 逐项归属表 + 注册 / 撤销 / 刷新。
 *
 * 只通过 `api.plugins.invoke('default-browser', …)` 与主进程通信,不碰 fs / 注册表。
 */
import { onMounted, ref } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import { PLATFORM_LABELS, TARGET_STATE_LABELS, statusBadge, type DesktopActionResult, type DesktopStatus } from '../shared'

const api = window.browserAPI
const status = ref<DesktopStatus | null>(null)
const log = ref<string[]>([])
const busy = ref(false)
const showWhy = ref(false)

function apply(res: DesktopActionResult): void {
  status.value = res.status
  log.value = res.log
}

async function load(): Promise<void> {
  busy.value = true
  try {
    status.value = await api.plugins.invoke<DesktopStatus>('default-browser', 'status')
  } finally {
    busy.value = false
  }
}

async function act(method: 'register' | 'unregister'): Promise<void> {
  busy.value = true
  try {
    apply(await api.plugins.invoke<DesktopActionResult>('default-browser', method))
  } finally {
    busy.value = false
  }
}

/** 跳到系统「默认应用」设置页(Windows);打不开就把原因摆在日志里 */
async function openSettings(): Promise<void> {
  const res = await api.plugins.invoke<{ ok: boolean; message: string }>('default-browser', 'openSettings')
  log.value = [res.message]
}

onMounted(() => void load())
</script>

<template>
  <div class="set-row">
    <span class="set-label">当前状态</span>
    <span class="db-status">
      <span class="db-dot" :class="status ? statusBadge(status).tone : 'idle'" />
      <template v-if="status">{{ statusBadge(status).text }}</template>
      <template v-else>读取中…</template>
      <span v-if="status" class="db-badge">{{ PLATFORM_LABELS[status.platform] }}{{ status.mode === 'dev' ? ' · dev' : '' }}</span>
    </span>
  </div>

  <div v-if="status?.error" class="set-row set-col">
    <span class="set-label">不可用</span>
    <div class="db-error">{{ status.error }}</div>
  </div>

  <div v-if="status && !status.isDefault" class="set-row set-col">
    <span class="set-label">说明</span>
    <div class="pbm-tools hint">
      下面这张表读的是系统<b>当前</b>的默认记录(Windows 是 UserChoice 注册表,Linux 是 mimeapps.list)。
      点上面的「注册」只把 bow 变成<b>候选</b>;系统设置里能看到 bow、或 bow 出现在「按应用」列表里,
      都不等于它已经是默认 —— 以这张表的每一行为准,非默认的行下方直接给了改法。
    </div>
  </div>

  <div v-if="status && status.targets.length > 0" class="set-row set-col">
    <span class="set-label">各类归属</span>
    <div class="db-table">
      <div v-for="t in status.targets" :key="t.id" class="db-row" :title="t.source ?? ''">
        <span class="db-target">{{ t.label }}</span>
        <span class="db-current">
          {{ t.current ?? '—' }}
          <span v-if="t.currentLabel" class="db-current-label">{{ t.currentLabel }}</span>
        </span>
        <span
          v-if="t.effective"
          class="db-effective"
          :title="'系统实际会用它打开:' + (t.effectivePath ?? t.effective) + '\n(与注册表里的记录不一致时才显示)'"
        >
          实际 {{ t.effective }}
        </span>
        <span class="db-state" :class="t.state">{{ TARGET_STATE_LABELS[t.state] }}</span>
      </div>
    </div>
    <div v-if="status.targets.some((t) => t.state !== 'default')" class="db-fixes">
      <div v-for="t in status.targets.filter((x) => x.state !== 'default')" :key="'fix-' + t.id" class="db-fix">
        <b>{{ t.label }}</b>:{{ t.fix ?? '参考下方步骤把它改回 bow' }}
      </div>
    </div>
  </div>

  <div class="set-row">
    <span class="set-label">操作</span>
    <button class="btn" :disabled="busy || !status?.canRegister" @click="act('register')">
      {{ status?.registered ? '更新注册' : '注册为默认浏览器' }}
    </button>
    <button class="btn danger" :disabled="busy || !status?.registered" @click="act('unregister')">撤销注册</button>
    <button class="btn" :disabled="busy" title="重新读取状态" @click="load"><RefreshCw :size="13" /> 刷新</button>
    <button v-if="status?.platform === 'win32'" class="btn" :disabled="busy" title="跳到系统「默认应用」设置页逐项选择" @click="openSettings">
      打开系统设置
    </button>
  </div>

  <div v-if="status" class="set-row set-col">
    <span class="set-label">注册目标</span>
    <div class="db-exec">{{ status.exec }}</div>
  </div>

  <div v-if="status && status.notes.length > 0" class="set-row set-col">
    <span class="set-label">注意</span>
    <div class="db-notes">
      <div v-for="(n, i) in status.notes" :key="i" class="db-note">{{ n }}</div>
    </div>
  </div>

  <div v-if="status && status.manualSteps.length > 0" class="set-row set-col">
    <span class="set-label">还需你手动点一次</span>
    <ol class="db-steps">
      <li v-for="(s, i) in status.manualSteps" :key="i">{{ s }}</li>
    </ol>
  </div>

  <div v-if="log.length > 0" class="set-row set-col">
    <span class="set-label">本次操作</span>
    <div class="db-log">
      <div v-for="(line, i) in log" :key="i">{{ line }}</div>
    </div>
  </div>

  <div class="set-row set-col">
    <button class="db-why-toggle" @click="showWhy = !showWhy">
      {{ showWhy ? '▾' : '▸' }} 为什么注册了还要手动点一次?
    </button>
    <div v-if="showWhy" class="pbm-tools hint">
      <p>
        <b>Linux</b>:默认关联就是 <code>~/.config/mimeapps.list</code> 里的几行文本,bow
        自己写进去即刻生效(所以这里点一次「注册为默认浏览器」就够了)。用不着 xdg-utils ——
        Electron 自带的 <code>setAsDefaultProtocolClient()</code> 反而依赖它,精简系统上常常失效。
      </p>
      <p>
        <b>Windows</b>:从 Win10 起,默认应用由带哈希校验的 UserChoice 记录决定,<b>任何程序都无法代你设置</b>
        (这是系统策略,不是 bow 的缺陷)。所以 bow 只能把自己注册成候选,让它出现在
        「设置 → 默认应用」与右键「打开方式」里,最后由你点一次;之后就不会再问了。
      </p>
      <p>
        <b>停用插件 ≠ 撤销注册</b>:停用只是把这个界面收起来,系统里的关联仍在,要撤掉请点上面的
        「撤销注册」(Windows 上会删掉 bow 那 8 项注册表条目)。
      </p>
      <p>
        <b>dev 模式</b>:还没有稳定的 bow.exe,注册的是 <code>~/.local/bin/bow</code> 包装脚本(指向仓库里的
        electron);打包版会直接指向 bow 二进制,切换后点一次「更新注册」即可纠正。
      </p>
    </div>
  </div>
</template>

<style scoped>
.db-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-dim, #888);
}
.db-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-dim, #888);
  flex: none;
}
.db-dot.ok {
  background: #35c46a;
}
.db-dot.warn {
  background: #d9a32b;
}
.db-dot.bad {
  background: var(--danger, #e05a5a);
}
.db-badge {
  padding: 0 5px;
  border: 1px solid var(--border, #444);
  border-radius: 3px;
  font-size: 10px;
}
.db-table {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
}
.db-row {
  display: grid;
  grid-template-columns: 120px 1fr auto 64px;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}
.db-target {
  color: var(--fg-dim, #888);
}
.db-current {
  color: var(--fg, #ddd);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.db-state {
  font-size: 11px;
  text-align: right;
  color: var(--fg-dim, #888);
}
.db-state.default {
  color: #35c46a;
}
.db-state.other {
  color: #d9a32b;
}
.db-exec,
.db-log {
  font-size: 11px;
  color: var(--fg-dim, #888);
  word-break: break-all;
  font-family: var(--mono, monospace);
}
.db-current-label {
  margin-left: 4px;
  padding: 0 4px;
  border: 1px solid var(--border, #444);
  border-radius: 3px;
  font-size: 10px;
  color: var(--fg-dim, #888);
}
.db-effective {
  padding: 0 4px;
  border: 1px solid var(--border, #444);
  border-radius: 3px;
  font-size: 10px;
  color: #d9a32b;
}
.db-fixes {
  margin-top: 4px;
  font-size: 11px;
  color: var(--fg-dim, #888);
}
.db-fix {
  margin-bottom: 2px;
}
.db-error {
  font-size: 12px;
  color: var(--danger, #e05a5a);
  word-break: break-all;
}
.db-notes {
  font-size: 12px;
  color: var(--fg-dim, #888);
}
.db-note {
  margin-bottom: 2px;
}
.db-steps {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--fg-dim, #888);
}
.db-why-toggle {
  align-self: flex-start;
  background: none;
  border: none;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  opacity: 0.8;
}
.db-why-toggle:hover {
  opacity: 1;
}
</style>
