<script setup lang="ts">
/** 设置弹层(运行在顶层 Overlay 页面中):核心设置 + 插件管理 + 插件设置分区 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Settings } from '@shared/types'
import type { PluginCapability, PluginInfo } from '@shared/plugins'
import { PLUGIN_CAPABILITY_LABELS } from '@shared/plugins'
import { SEARCH_ENGINES } from '@shared/url'
import { X } from 'lucide-vue-next'
import ModalShell from './ModalShell.vue'
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

const enabledIds = computed(() => new Set(plugins.value.filter((p) => p.enabled).map((p) => p.id)))
const settingsSections = computed(() =>
  PLUGIN_UI.filter((ui) => enabledIds.value.has(ui.id)).flatMap((ui) => ui.settingsSections ?? [])
)

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

      <!-- 插件管理 -->
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
            <span class="plugin-desc">{{ p.description }}</span>
            <span class="plugin-meta">
              <span v-for="c in p.capabilities" :key="c" class="plugin-cap">{{ capLabel(c) }}</span>
              <span v-if="p.core" class="plugin-core" title="关闭后会影响核心功能">核心</span>
            </span>
          </div>
        </div>
      </div>

      <!-- 插件设置分区 -->
      <component v-for="(C, i) in settingsSections" :is="C" :key="`ps-${i}`" />

      <div class="set-actions">
        <button class="btn primary" @click="saveSettings">保存</button>
        <button class="btn" @click="requestClose">取消</button>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plugin-row {
  display: grid;
  grid-template-columns: minmax(120px, auto) 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
}
.plugin-toggle {
  white-space: nowrap;
}
.plugin-name {
  font-weight: 500;
}
.plugin-desc {
  opacity: 0.7;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-meta {
  display: flex;
  align-items: center;
  gap: 4px;
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
