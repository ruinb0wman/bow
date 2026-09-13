<script setup lang="ts">
/**
 * 插件管理:启停(立即生效并持久化)、能力标签、核心提示与描述;
 * 贡献了设置分区的插件可直接跳转到其设置分区(在设置页内切换,不再是嵌套弹窗)。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PluginCapability, PluginInfo } from '@shared/plugins'
import { PLUGIN_CAPABILITY_LABELS } from '@shared/plugins'
import { Settings as SettingsIcon } from 'lucide-vue-next'
import { PLUGIN_UI } from '../plugins/registry'

const api = window.browserAPI
const emit = defineEmits<{ configure: [pluginId: string] }>()

const plugins = ref<PluginInfo[]>([])
const unsubs: Array<() => void> = []

/** 插件 id → 设置分区数量(无分区的插件不显示「设置」入口) */
const sectionCounts = computed<Record<string, number>>(() =>
  Object.fromEntries(PLUGIN_UI.map((ui) => [ui.id, ui.settingsSections?.length ?? 0]))
)

function capLabel(c: PluginCapability): string {
  return PLUGIN_CAPABILITY_LABELS[c] ?? c
}

function hasSections(id: string): boolean {
  return (sectionCounts.value[id] ?? 0) > 0
}

async function togglePlugin(p: PluginInfo, enabled: boolean): Promise<void> {
  plugins.value = await api.plugins.setEnabled(p.id, enabled)
}

onMounted(async () => {
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
</script>

<template>
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
        v-if="p.enabled && hasSections(p.id)"
        class="btn plugin-config"
        title="打开该插件的设置"
        @click="emit('configure', p.id)"
      >
        <SettingsIcon :size="13" /> 设置
      </button>
      <span class="plugin-desc">{{ p.description }}</span>
    </div>
  </div>
</template>

<style scoped>
.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 20px;
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
  padding: 10px 12px;
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
