<script setup lang="ts">
/**
 * 终端设置分区(设置页 → 终端):外观(字体族 / 字号 / 滚动缓冲)+ shell 配置列表。
 * 全部即时保存,没有保存按钮 —— 与其它插件分区一致。
 */
import { computed, onMounted, ref } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
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
</style>
