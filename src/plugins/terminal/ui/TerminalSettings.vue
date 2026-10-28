<script setup lang="ts">
/**
 * 终端设置分区(设置页 → 终端):外观(字体族 / 字号 / 滚动缓冲)+ shell 配置列表 + Pi 联动。
 * 全部即时保存,没有保存按钮 —— 与其它插件分区一致。
 *
 * `data-bridge-*` 是给 E2E(`scripts/e2e-agent-status.mjs`)用的钩子:靠文案选元素太脆。
 */
import { RButton } from '@ruinb0w/ui'
import { computed, onMounted, ref } from 'vue'
import { Plus, Trash2 } from '@lucide/vue'
import {
  FONT_SIZE_RANGE,
  SCROLLBACK_RANGE,
  formatArgsLine,
  newProfileId,
  parseArgsLine
} from '@plugins/terminal/shared'
import type { TerminalCandidate, TerminalProfile, TerminalSettings } from '@plugins/terminal/shared'

const api = window.browserAPI

const settings = ref<TerminalSettings | null>(null)
const candidates = ref<TerminalCandidate[]>([])
const choice = ref('')

const profiles = computed(() => settings.value?.profiles ?? [])
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
})

// ---------- Pi 联动(把扩展装进 pi:状态角标 / 通知 / 手机对话)----------
// 安装不在应用里做(那个扩展只是仓库里一个文件),这里只显示该跑哪条命令:
// 打包版里既没有 `scripts/` 也没有 node,写完也验证不了,不如把入口交给仓库脚本。
const PI_BRIDGE_COMMAND = 'npm run pi:install-status'

/** 渲染层的 navigator.clipboard 在内部页面可用(见 DeviceInspectPanel) */
const commandCopied = ref(false)
let commandCopiedTimer: number | undefined
async function copyBridgeCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText(PI_BRIDGE_COMMAND)
    commandCopied.value = true
    if (commandCopiedTimer) window.clearTimeout(commandCopiedTimer)
    commandCopiedTimer = window.setTimeout(() => {
      commandCopied.value = false
    }, 2000)
  } catch {
    /* 复制不了就算了：命令就显在旁边（`user-select: all`），点一下就全选 */
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
          <RButton size="small" type="danger" plain :disabled="profiles.length <= 1" :title="profiles.length <= 1 ? '至少保留一条配置' : '删除该配置'" @click="removeProfile(profile.id)">
            <Trash2 :size="13" />
          </RButton>
        </div>

        <div class="term-add">
          <select v-model="choice" class="pbm-input term-candidates" @change="addFromCandidate">
            <option value="">从预设添加…</option>
            <option v-for="(item, i) in candidates" :key="item.profile.id" :value="String(i)">
              {{ item.profile.name }} · {{ item.profile.shell }}{{ item.available ? '' : '(未找到)' }}
            </option>
          </select>
          <RButton size="small" title="添加一条自定义配置" @click="addCustom"><Plus :size="13" /></RButton>
        </div>

        <div class="pbm-tools hint">
          点左侧圆点选默认配置:新的终端标签用它启动。`shell` 是可执行文件路径或 PATH 里的名字
          (Windows 上要带 <code>.exe</code>);WSL 建议 `wsl.exe`,参数 `--cd ~`。
          改字号/字体会立刻作用到已打开的终端。
        </div>
      </div>
    </div>

    <div class="set-row set-col">
      <span class="set-label">AI 控制</span>
      <div class="term-mcp">
        <label class="set-check">
          <input
            type="checkbox"
            :checked="settings.mcpTools"
            data-term-mcp-tools
            @change="save({ mcpTools: ($event.target as HTMLInputElement).checked })"
          />
          <span>向 AI 暴露终端工具</span>
        </label>
        <div class="pbm-tools hint">
          <code>terminal_list_sessions</code> / <code>terminal_read</code> / <code>terminal_send</code> /
          <code>terminal_run</code> / <code>terminal_close</code>（MCP）。关掉后 AI 调一律报错，终端本身照用 ——
          终端插件属于核心插件、不能停用，这个开关就是「不让 AI 敲键盘」的出口。
        </div>
      </div>
    </div>

    <div class="set-row set-col">
      <span class="set-label">Pi 联动</span>
      <div class="term-bridge">
        <div class="pbm-tools hint">
          装一个 pi 扩展,拿到两样东西:终端标签上的<strong>状态角标 + 系统通知</strong>
          (正在执行 / 等你确认 / 已完成),以及手机上那个<strong>对话页</strong>。
        </div>
        <div class="term-bridge-cmd">
          <code data-bridge-command>{{ PI_BRIDGE_COMMAND }}</code>
          <RButton size="small" data-bridge-action="copy-command" title="复制这条命令" @click="copyBridgeCommand()">
            {{ commandCopied ? '已复制' : '复制' }}
          </RButton>
        </div>
        <div class="pbm-tools hint">
          在 <strong>跑 pi 的那个系统</strong>里、bow 仓库根目录跑它(pi 在 WSL2 就在 WSL2 的终端里跑——
          它写的是执行者的 <code>~/.pi/agent/extensions/bow-agent-state.ts</code>)。
          重复跑是更新,<code>--uninstall</code> 删除,<code>--dry-run</code> 只看会做什么。
          装完在 pi 里 <code>/reload</code> 或重开终端生效。不装也能用一半:pi 自己打开
          <code>terminal.showTerminalProgress</code> 只有「正在执行」角标,没有通知与手机对话。
        </div>
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

.term-mcp {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
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
