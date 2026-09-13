<script setup lang="ts">
/** 设置弹层(运行在顶层 Overlay 页面中):核心设置 + 插件管理(插件设置走嵌套弹窗) */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import type { Settings } from '@shared/types'
import type { PluginCapability, PluginInfo } from '@shared/plugins'
import { PLUGIN_CAPABILITY_LABELS } from '@shared/plugins'
import { SEARCH_ENGINES } from '@shared/url'
import { Settings as SettingsIcon, X } from 'lucide-vue-next'
import ModalShell from './ModalShell.vue'
import PluginSettingsModal from './PluginSettingsModal.vue'
import { PLUGIN_UI } from '../plugins/registry'

defineOptions({ inheritAttrs: false })

const api = window.browserAPI
const emit = defineEmits<{ 'overlay-event': [event: string, args?: unknown] }>()

function requestClose(): void {
  emit('overlay-event', 'close-request')
}
function onShellEvent(event: string, args?: unknown): void {
  emit('overlay-event', event, args)
}

const settingsDraft = ref<Settings>({
  searchEngine: 'google',
  homepage: '',
  corsBypassEnabled: true,
  corsWhitelist: []
})
const plugins = ref<PluginInfo[]>([])
const unsubs: Array<() => void> = []

// ---------- 插件设置弹窗(面板内嵌套) ----------
const openSettingsId = ref<string | null>(null)

function sectionsOf(id: string): Component[] {
  return PLUGIN_UI.find((ui) => ui.id === id)?.settingsSections ?? []
}
/** 仅「已启用且提供设置分区」的插件显示设置入口 */
function canConfigure(p: PluginInfo): boolean {
  return p.enabled && sectionsOf(p.id).length > 0
}
const activePlugin = computed(() => plugins.value.find((p) => p.id === openSettingsId.value) ?? null)
const activeSections = computed(() => (openSettingsId.value ? sectionsOf(openSettingsId.value) : []))

function openPluginSettings(p: PluginInfo): void {
  openSettingsId.value = p.id
}
function closePluginSettings(): void {
  openSettingsId.value = null
}
function onPluginSettingsEvent(event: string): void {
  if (event === 'close-request') closePluginSettings()
}

function capLabel(c: PluginCapability): string {
  return PLUGIN_CAPABILITY_LABELS[c] ?? c
}

onMounted(async () => {
  settingsDraft.value = { ...(await api.getSettings()) }
  plugins.value = await api.plugins.list()
  unsubs.push(
    api.plugins.onChanged((list) => {
      plugins.value = list
    })
  )
})
onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
})

// 弹窗所属插件被停用/移除或不再有设置分区时自动关闭
watch([plugins, openSettingsId], () => {
  const id = openSettingsId.value
  if (!id) return
  const p = plugins.value.find((x) => x.id === id)
  if (!p || !p.enabled || sectionsOf(id).length === 0) openSettingsId.value = null
})

async function togglePlugin(p: PluginInfo, enabled: boolean): Promise<void> {
  plugins.value = await api.plugins.setEnabled(p.id, enabled)
}

async function saveSettings(): Promise<void> {
  const h = settingsDraft.value.homepage.trim()
  await api.setSettings({
    searchEngine: settingsDraft.value.searchEngine,
    homepage: h || 'https://www.google.com'
  })
  requestClose()
}
</script>

<template>
  <ModalShell @overlay-event="onShellEvent">
    <div class="panel-settings">
      <div class="modal-head">
        <span>设置</span>
        <button class="win-btn" title="关闭" @click="requestClose"><X :size="13" /></button>
      </div>
      <div class="set-row">
        <span class="set-label">默认搜索引擎</span>
        <div class="set-engines">
          <label v-for="(v, key) in SEARCH_ENGINES" :key="key" class="set-engine">
            <input v-model="settingsDraft.searchEngine" type="radio" :value="key" />
            {{ v.label }}
          </label>
        </div>
      </div>
      <div class="set-row">
        <span class="set-label">主页</span>
        <input v-model="settingsDraft.homepage" class="pbm-input wide" placeholder="https://www.google.com" />
      </div>

      <!-- 插件管理:描述换行到第二行,设置入口打开嵌套弹窗 -->
      <div class="set-row set-col">
        <span class="set-label">插件</span>
        <div class="plugin-list">
          <div v-for="p in plugins" :key="p.id" class="plugin-row">
            <label class="set-check plugin-toggle">
              <input
                type="checkbox"
                :checked="p.enabled"
                @change="togglePlugin(p, ($event.target as HTMLInputElement).checked)"
              />
              <span class="plugin-name">{{ p.name }}</span>
            </label>
            <span class="plugin-meta">
              <span v-for="c in p.capabilities" :key="c" class="plugin-cap">{{ capLabel(c) }}</span>
              <span v-if="p.core" class="plugin-core" title="关闭后会影响核心功能">核心</span>
            </span>
            <button
              v-if="canConfigure(p)"
              class="btn plugin-config"
              title="打开插件设置"
              @click="openPluginSettings(p)"
            >
              <SettingsIcon :size="13" /> 设置
            </button>
            <span class="plugin-desc">{{ p.description }}</span>
          </div>
        </div>
      </div>

      <div class="set-actions">
        <button class="btn primary" @click="saveSettings">保存</button>
        <button class="btn" @click="requestClose">取消</button>
      </div>
    </div>

    <!-- 插件设置弹窗:叠加在设置面板之上,关闭只作用于内层 -->
    <PluginSettingsModal
      v-if="activePlugin"
      :title="activePlugin.name"
      :sections="activeSections"
      @overlay-event="onPluginSettingsEvent"
    />
  </ModalShell>
</template>

<style scoped>
.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.plugin-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  grid-template-areas:
    'name meta action'
    'desc desc desc';
  align-items: center;
  gap: 4px 10px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
}
.plugin-toggle {
  grid-area: name;
  min-width: 0;
  white-space: nowrap;
}
.plugin-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-meta {
  grid-area: meta;
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: flex-end;
}
.plugin-config {
  grid-area: action;
  white-space: nowrap;
}
.plugin-desc {
  grid-area: desc;
  opacity: 0.7;
  font-size: 12px;
  line-height: 1.5;
  white-space: normal;
  overflow-wrap: anywhere;
}
.plugin-cap,
.plugin-core {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  white-space: nowrap;
}
.plugin-core {
  background: rgba(255, 170, 60, 0.22);
}
</style>
