<script setup lang="ts">
/**
 * 终端设置分区(设置页 → 终端):外观(字体族 / 字号 / 滚动缓冲)+ shell 配置列表 + Pi 状态联动。
 * 全部即时保存,没有保存按钮 —— 与其它插件分区一致。
 *
 * `data-bridge-state` / `data-bridge-action` 是给 E2E(`scripts/e2e-agent-status.mjs`)用的钩子:
 * 一键接入是个「点一下真的会写文件到用户家目录」的动作,靠文案选按钮太脆。
 */
import { computed, onMounted, ref } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import {
  FONT_SIZE_RANGE,
  SCROLLBACK_RANGE,
  formatArgsLine,
  isWslShell,
  newProfileId,
  parseArgsLine
} from '@plugins/terminal/shared'
import type {
  PiBridgeResult,
  PiBridgeStatus,
  TerminalCandidate,
  TerminalProfile,
  TerminalSettings
} from '@plugins/terminal/shared'

const api = window.browserAPI

const settings = ref<TerminalSettings | null>(null)
const candidates = ref<TerminalCandidate[]>([])
const choice = ref('')

const profiles = computed(() => settings.value?.profiles ?? [])
/** 配了 WSL 的终端配置的名字(有它就说明用户会把 pi 跑在 WSL2 里 → 显示那条「装进 WSL2」的说明) */
const wslProfiles = computed(() =>
  profiles.value.filter((p) => isWslShell(p.shell ?? '')).map((p) => p.name)
)
const fontFamilyDraft = ref('')
const argsDraft = ref<Record<string, string>>({})

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return api.plugins.invoke<T>('terminal', method, ...args)
}

async function save(patch: Partial<TerminalSettings>): Promise<void> {
  settings.value = await invoke<TerminalSettings>('setSettings', patch)
  syncDrafts()
}

function syncDrafts(): void {
  const list = profiles.value
  fontFamilyDraft.value = settings.value?.fontFamily ?? ''
  argsDraft.value = Object.fromEntries(list.map((p) => [p.id, formatArgsLine(p.args)]))
}

function patchProfile(id: string, patch: Partial<TerminalProfile>): void {
  if (!settings.value) return
  void save({
    profiles: settings.value.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p))
  })
}

function commitFontFamily(): void {
  const value = fontFamilyDraft.value.trim()
  if (!value || value === settings.value?.fontFamily) {
    syncDrafts()
    return
  }
  void save({ fontFamily: value })
}

function commitArgs(profile: TerminalProfile): void {
  const line = argsDraft.value[profile.id] ?? ''
  const next = parseArgsLine(line)
  if (formatArgsLine(next) === formatArgsLine(profile.args)) return
  patchProfile(profile.id, { args: next })
}

function addProfile(profile: TerminalProfile): void {
  if (!settings.value) return
  void save({ profiles: [...settings.value.profiles, profile] })
}

function addFromCandidate(): void {
  const hit = candidates.value[Number(choice.value)]
  choice.value = ''
  if (!hit) return
  addProfile({ ...hit.profile, args: [...hit.profile.args], id: newProfileId(profiles.value.map((p) => p.id)) })
}

function addCustom(): void {
  const id = newProfileId(profiles.value.map((p) => p.id))
  addProfile({ id, name: '自定义', shell: '', args: [], cwd: '' })
}

function removeProfile(id: string): void {
  if (!settings.value || settings.value.profiles.length <= 1) return
  void save({ profiles: settings.value.profiles.filter((p) => p.id !== id) })
}

onMounted(async () => {
  settings.value = await invoke<TerminalSettings>('getSettings')
  syncDrafts()
  candidates.value = await invoke<TerminalCandidate[]>('listCandidates')
  await refreshBridge()
})

// ---------- Pi 状态联动(把状态桥扩展装进 pi)----------

const bridge = ref<PiBridgeStatus | null>(null)
const bridgeBusy = ref(false)
const bridgeMessage = ref('')

/** 界面上那句话:先报「能不能做」,再报「做没做过」 */
async function refreshBridge(): Promise<void> {
  bridge.value = await invoke<PiBridgeStatus>('piBridgeStatus')
}

function bridgeStateText(): string {
  const b = bridge.value
  if (!b) return '检查中…'
  if (!b.sourceAvailable) return '不可用:这个构建里没有扩展源码(打包漏配 build.files)'
  if (b.foreign) return '目标文件已存在且不是 bow 装的'
  if (!b.installed) return b.agentDirExists ? '未接入' : '未接入(没检测到 pi 的 agent 目录,也可以先装)'
  return b.upToDate ? '已接入(最新)' : '已接入,有新版本可更新'
}

function bridgeButtonText(): string {
  const b = bridge.value
  if (!b?.installed) return '安装'
  if (b.foreign) return '覆盖'
  return b.upToDate ? '重装' : '更新'
}

async function runBridge(kind: 'install' | 'uninstall'): Promise<void> {
  if (bridgeBusy.value) return
  bridgeBusy.value = true
  bridgeMessage.value = ''
  try {
    // 覆盖「不是 bow 装的」同名文件需要显式 force —— 界面上那个按钮写明了「覆盖」
    const force = bridge.value?.foreign === true
    const method = kind === 'install' ? 'piBridgeInstall' : 'piBridgeUninstall'
    const result = await invoke<PiBridgeResult>(method, { force })
    bridge.value = result.status
    bridgeMessage.value = result.ok ? result.message : (result.status.error ?? result.message)
  } finally {
    bridgeBusy.value = false
  }
}

/** 「WSL2 请执行这条命令」里的命令复制(渲染层的 navigator.clipboard 在内部页面可用,见 DeviceInspectPanel) */
const wslCopied = ref(false)
let wslCopiedTimer: number | undefined
async function copyWslCommand(): Promise<void> {
  const command = bridge.value?.wsl?.command
  if (!command) return
  try {
    await navigator.clipboard.writeText(command)
    wslCopied.value = true
    if (wslCopiedTimer) window.clearTimeout(wslCopiedTimer)
    wslCopiedTimer = window.setTimeout(() => {
      wslCopied.value = false
    }, 2000)
  } catch {
    bridgeMessage.value = '复制失败,请手动选中上面的命令'
  }
}
</script>

<template>
  <template v-if="settings">
    <div class="set-row">
      <span class="set-label">字体</span>
      <input
        v-model="fontFamilyDraft"
        class="pbm-input term-font"
        list="term-font-choices"
        placeholder="Cascadia Mono, Consolas, monospace"
        @change="commitFontFamily"
        @blur="commitFontFamily"
        @keydown.enter.prevent="commitFontFamily"
      />
      <datalist id="term-font-choices">
        <option value="Cascadia Mono, Consolas, monospace" />
        <option value="Consolas, &quot;Cascadia Mono&quot;, &quot;Microsoft YaHei&quot;, monospace" />
        <option value="&quot;JetBrains Mono&quot;, Consolas, monospace" />
        <option value="&quot;Fira Code&quot;, Consolas, monospace" />
        <option value="Menlo, Monaco, &quot;Courier New&quot;, monospace" />
      </datalist>
    </div>

    <div class="set-row">
      <span class="set-label">字号</span>
      <input
        class="term-range"
        type="range"
        :min="FONT_SIZE_RANGE.min"
        :max="FONT_SIZE_RANGE.max"
        :value="settings.fontSize"
        @change="save({ fontSize: Number(($event.target as HTMLInputElement).value) })"
      />
      <span class="term-value">{{ settings.fontSize }} px</span>
    </div>

    <div class="set-row">
      <span class="set-label">滚动缓冲</span>
      <input
        class="term-range"
        type="range"
        :min="SCROLLBACK_RANGE.min"
        :max="SCROLLBACK_RANGE.max"
        step="500"
        :value="settings.scrollback"
        @change="save({ scrollback: Number(($event.target as HTMLInputElement).value) })"
      />
      <span class="term-value">{{ settings.scrollback }} 行</span>
    </div>

    <div class="set-row set-col">
      <span class="set-label">shell 配置</span>
      <div class="term-profiles">
        <div
          v-for="profile in profiles"
          :key="profile.id"
          class="term-profile"
          :class="{ default: profile.id === settings.defaultProfileId }"
        >
          <label class="term-radio" :title="profile.id === settings.defaultProfileId ? '默认配置' : '设为默认'">
            <input
              type="radio"
              name="term-default-profile"
              :checked="profile.id === settings.defaultProfileId"
              @change="save({ defaultProfileId: profile.id })"
            />
          </label>
          <div class="term-profile-fields">
            <input
              class="pbm-input term-name"
              :value="profile.name"
              placeholder="名称"
              @change="patchProfile(profile.id, { name: ($event.target as HTMLInputElement).value })"
            />
            <input
              class="pbm-input term-shell"
              :value="profile.shell"
              placeholder="可执行文件,如 wsl.exe"
              spellcheck="false"
              @change="patchProfile(profile.id, { shell: ($event.target as HTMLInputElement).value })"
            />
            <input
              class="pbm-input term-args"
              :value="argsDraft[profile.id] ?? ''"
              placeholder="参数(可留空),如 --cd &quot;~&quot;"
              spellcheck="false"
              @input="argsDraft[profile.id] = ($event.target as HTMLInputElement).value"
              @change="commitArgs(profile)"
              @blur="commitArgs(profile)"
            />
            <input
              class="pbm-input term-cwd"
              :value="profile.cwd"
              placeholder="工作目录(留空 = 用户主目录)"
              spellcheck="false"
              @change="patchProfile(profile.id, { cwd: ($event.target as HTMLInputElement).value })"
            />
          </div>
          <button
            class="btn danger"
            :disabled="profiles.length <= 1"
            :title="profiles.length <= 1 ? '至少保留一条配置' : '删除该配置'"
            @click="removeProfile(profile.id)"
          >
            <Trash2 :size="13" />
          </button>
        </div>

        <div class="term-add">
          <select v-model="choice" class="pbm-input term-candidates" @change="addFromCandidate">
            <option value="">从预设添加…</option>
            <option v-for="(item, i) in candidates" :key="item.profile.id" :value="String(i)">
              {{ item.profile.name }} · {{ item.profile.shell }}{{ item.available ? '' : '(未找到)' }}
            </option>
          </select>
          <button class="btn" title="添加一条自定义配置" @click="addCustom"><Plus :size="13" /></button>
        </div>

        <div class="pbm-tools hint">
          点左侧圆点选默认配置:新的终端标签用它启动。`shell` 是可执行文件路径或 PATH 里的名字
          (Windows 上要带 <code>.exe</code>);WSL 建议 `wsl.exe`,参数 `--cd ~`。
          改字号/字体会立刻作用到已打开的终端。
        </div>
      </div>
    </div>

    <div class="set-row set-col">
      <span class="set-label">Pi 状态联动</span>
      <div class="term-bridge">
        <div class="pbm-tools hint">
          终端里的 <strong>pi</strong> 会把「正在执行 / 等待你确认 / 已完成」显示成标签角标与窗口底部居中通知
          (点通知直接进入对应标签)。为此需要把 bow 的状态桥扩展装进 pi 的扩展目录 ——
          点下面这个按钮就行,装完在 pi 里重开或 <code>/reload</code> 生效。
          不装也有一半:pi 自己在设置里打开 <code>terminal.showTerminalProgress</code> 就只有「正在执行」角标。
        </div>
        <div class="term-bridge-row">
          <span
            class="term-bridge-state"
            data-bridge-state
            :class="{ ok: bridge?.upToDate, warn: !!bridge && !bridge.upToDate }"
          >
            {{ bridgeStateText() }}
          </span>
          <button
            class="btn"
            data-bridge-action="install"
            :disabled="bridgeBusy || !bridge?.sourceAvailable"
            :title="bridge?.foreign ? '目标文件不是 bow 装的,点击会覆盖它' : '把状态桥扩展写进 pi 的扩展目录'"
            @click="runBridge('install')"
          >
            {{ bridgeButtonText() }}
          </button>
          <button
            v-if="bridge?.installed"
            class="btn danger"
            data-bridge-action="uninstall"
            :disabled="bridgeBusy"
            title="删除 bow 装的那个扩展文件(不动别的扩展)"
            @click="runBridge('uninstall')"
          >
            卸载
          </button>
        </div>
        <div v-if="bridge" class="term-bridge-path">{{ bridge.target }}</div>
        <div v-if="bridge?.wsl && wslProfiles.length" class="term-bridge-wsl" data-bridge-wsl>
          <div class="pbm-tools hint">
            <strong>如果使用 WSL2,请执行以下命令将扩展安装到 WSL2 中</strong>
            —— 上面的按钮装进的是 bow 这个系统里的家目录(<code>{{ bridge.agentDir }}</code>),
            而跑在 WSL2 里的 pi 读的是发行版的家目录,它看不到刚装的那份
            (检测到你的终端配置 <code>{{ wslProfiles.join(' / ') }}</code> 用的是 <code>wsl.exe</code>)。
            复制下面这条命令,到 WSL2 的终端里执行:
          </div>
          <div class="term-bridge-cmd">
            <code data-bridge-wsl-command>{{ bridge.wsl.command }}</code>
            <button
              class="btn"
              data-bridge-action="copy-wsl"
              title="复制这条命令,粘到 WSL2 终端里执行"
              @click="copyWslCommand()"
            >
              {{ wslCopied ? '已复制' : '复制' }}
            </button>
          </div>
          <div class="pbm-tools hint">装完在 WSL2 里的 pi 中重开或 <code>/reload</code> 生效。</div>
        </div>
        <div v-if="bridgeMessage || bridge?.error" class="pbm-tools hint">{{ bridgeMessage || bridge?.error }}</div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.term-font {
  flex: 1;
  min-width: 0;
}

.term-range {
  flex: 1;
  min-width: 0;
  accent-color: var(--accent);
}

.term-value {
  flex: none;
  min-width: 56px;
  color: var(--fg-dim);
  font-size: 12px;
}

.term-profiles {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.term-profile {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg2);
}

.term-profile.default {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
}

.term-radio {
  padding-top: 6px;
}

.term-radio input {
  accent-color: var(--accent);
}

.term-profile-fields {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  gap: 6px;
}

.term-shell,
.term-cwd,
.term-args {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}

.term-add {
  display: flex;
  gap: 6px;
}

.term-candidates {
  flex: 1;
  min-width: 0;
}

.term-bridge {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.term-bridge-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.term-bridge-state {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-dim);
}

/* 状态色与标签角标一致:已接入=绿、待处理=黄(见 src/renderer/src/style.css 的 .tab-agent) */
.term-bridge-state.ok {
  color: #7ec96a;
}

.term-bridge-state.warn {
  color: #e2b93d;
}

.term-bridge-path {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}

.term-bridge-wsl {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 命令要能一眼看清并整行选中:横向可滚,不折行打断路径 */
.term-bridge-cmd {
  display: flex;
  align-items: center;
  gap: 8px;
}

.term-bridge-cmd > code {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg2);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--fg);
  overflow-x: auto;
  white-space: pre;
  user-select: all;
}
</style>
