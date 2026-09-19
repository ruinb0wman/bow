<script setup lang="ts">
/** 常规设置:默认搜索引擎 + 主页 + 分屏宽度预设。改动即时保存(无保存/取消按钮)。 */
import { onMounted, ref } from 'vue'
import type { Settings } from '@shared/types'
import { SEARCH_ENGINES } from '@shared/url'
import type { SplitPreset } from '@shared/split'
import { DEFAULT_SPLIT_PRESETS, clampSplitValue, nextSplitPresetId, normalizeSplitPresets } from '@shared/split'
import { Plus, RotateCcw, Trash2 } from 'lucide-vue-next'

const api = window.browserAPI
const DEFAULT_HOMEPAGE = 'https://www.google.com'

const searchEngine = ref<Settings['searchEngine']>('google')
const homepage = ref('')
let savedHomepage = ''
/** 分屏宽度预设(工具栠「分屏」面板按顺序展示) */
const splitPresets = ref<SplitPreset[]>([])
const presetError = ref('')

async function load(): Promise<void> {
  const s = await api.getSettings()
  searchEngine.value = s.searchEngine
  homepage.value = s.homepage
  savedHomepage = s.homepage
  splitPresets.value = normalizeSplitPresets(s.splitPresets)
}

async function saveSearchEngine(): Promise<void> {
  const s = await api.setSettings({ searchEngine: searchEngine.value })
  searchEngine.value = s.searchEngine
}

/** 主页:失焦/回车才写入;留空视为放弃修改,回填已存值 */
async function saveHomepage(e?: Event): Promise<void> {
  const el = e?.target as HTMLInputElement | undefined
  const next = (el?.value ?? homepage.value).trim()
  if (!next) {
    homepage.value = savedHomepage
    return
  }
  const s = await api.setSettings({ homepage: next })
  savedHomepage = s.homepage
  homepage.value = s.homepage
}

// ---------- 分屏宽度预设 ----------

/** 整表规范化后写回:非法项(比例超范围 / 像素超范围 / 单位写错)直接丢弃并提示 */
async function savePresets(): Promise<void> {
  const next = normalizeSplitPresets(splitPresets.value)
  presetError.value =
    next.length === splitPresets.value.length ? '' : '有非法项被丢弃:比例需在 10~90%、像素需在 160~4000 之间'
  splitPresets.value = next
  const s = await api.setSettings({ splitPresets: next.map((p) => ({ ...p })) })
  splitPresets.value = normalizeSplitPresets(s.splitPresets)
}

function addPreset(): void {
  splitPresets.value = [
    ...splitPresets.value,
    {
      id: nextSplitPresetId(splitPresets.value.map((p) => p.id)),
      label: `预设 ${splitPresets.value.length + 1}`,
      value: 50,
      unit: 'percent'
    }
  ]
  void savePresets()
}

function removePreset(index: number): void {
  splitPresets.value = splitPresets.value.filter((_, i) => i !== index)
  void savePresets()
}

function resetPresets(): void {
  splitPresets.value = normalizeSplitPresets(DEFAULT_SPLIT_PRESETS)
  void savePresets()
}

/** 换单位后按新单位夹紧(50% 与 50px 完全不是一回事) */
function onUnitChange(preset: SplitPreset): void {
  preset.value = clampSplitValue(preset.unit, preset.value)
  void savePresets()
}

onMounted(() => void load())
</script>

<template>
  <div class="set-row">
    <span class="set-label">默认搜索引擎</span>
    <div class="set-engines">
      <label v-for="(v, key) in SEARCH_ENGINES" :key="key" class="set-engine">        <input v-model="searchEngine" type="radio" :value="key" @change="saveSearchEngine" />
        {{ v.label }}
      </label>
    </div>
  </div>
  <div class="set-row">
    <span class="set-label">主页</span>
    <input
      v-model="homepage"
      class="pbm-input wide"
      spellcheck="false"
      :placeholder="DEFAULT_HOMEPAGE"
      @change="saveHomepage"
      @keydown.enter.prevent="saveHomepage"
    />
  </div>
  <div class="pbm-tools hint">
    主页在启动时打开新窗口的首页标签;地址栏输入内容按所选搜索引擎搜索。
  </div>

  <div class="set-row set-col">
    <span class="set-label">分屏预设</span>
    <div class="split-presets">
      <div v-for="(p, i) in splitPresets" :key="p.id" class="split-preset-row">
        <input
          v-model="p.label"
          class="pbm-input"
          spellcheck="false"
          maxlength="24"
          placeholder="名称"
          @change="savePresets"
        />
        <input v-model.number="p.value" class="split-preset-num" type="number" @change="savePresets" />
        <select v-model="p.unit" title="百分比 = 左窗格占可用宽度的比例;像素 = 固定宽度" @change="onUnitChange(p)">
          <option value="percent">%</option>
          <option value="px">px</option>
        </select>
        <button class="btn danger" title="删除该预设" @click="removePreset(i)"><Trash2 :size="13" /></button>
      </div>
      <div v-if="splitPresets.length === 0" class="split-preset-empty">
        没有预设 —— 分屏时只能用默认的 50%。点下面「添加预设」或「恢复默认」。
      </div>
      <div class="split-preset-actions">
        <button class="btn" @click="addPreset"><Plus :size="13" /> 添加预设</button>
        <button class="btn" @click="resetPresets"><RotateCcw :size="13" /> 恢复默认</button>
      </div>
      <div v-if="presetError" class="cors-error">{{ presetError }}</div>
      <div class="pbm-tools hint">
        工具栠「分屏」按钮里按顺序展示这些预设:比例按可用宽度(%)算,像素档为固定宽度
        (窗口太窄时会自动收窄,保证两窗都能显示)。
      </div>
    </div>
  </div>
</template>

<style scoped>
.split-presets {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.split-preset-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.split-preset-num {
  flex: none;
  width: 84px;
}

.split-preset-empty {
  color: var(--fg-dim);
  font-size: 12px;
}

.split-preset-actions {
  display: flex;
  gap: 8px;
}
</style>
