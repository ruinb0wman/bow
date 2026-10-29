<script setup lang="ts">
/**
 * 设置页(浏览器内部标签页 bow://settings):
 * 左侧导航 = 常规 + 网络 + 工具栏 + 快捷键 + 插件管理 + 每个「已启用且贡献了设置分区」的插件一项;
 * 右侧内容全宽渲染,插件设置内联展示(不再嵌套弹窗),所有设置即时保存。
 */
import { RSettingsNav } from '@ruinb0w/ui'
import type { SettingsNavItem as RSettingsNavItem } from '@ruinb0w/ui'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import type { PluginInfo } from '@shared/plugins'
import {
  SETTINGS_GENERAL_ID,
  SETTINGS_NETWORK_ID,
  SETTINGS_PLUGINS_ID,
  SETTINGS_SHORTCUTS_ID,
  SETTINGS_TOOLBAR_ID,
  buildSettingsNav,
  settingsSectionId
} from '@shared/settingsNav'
import { PLUGIN_UI } from '../plugins/registry'
import GeneralSettings from './GeneralSettings.vue'
import NetworkSettings from './NetworkSettings.vue'
import PluginManager from './PluginManager.vue'
import ShortcutsHelp from './ShortcutsHelp.vue'
import ToolbarSettings from './ToolbarSettings.vue'

const api = window.browserAPI

const plugins = ref<PluginInfo[]>([])
const activeId = ref<string>(SETTINGS_GENERAL_ID)
const unsubs: Array<() => void> = []

/** 某插件贡献的设置分区组件 */
function sectionsOf(id: string): Component[] {
  return PLUGIN_UI.find((ui) => ui.id === id)?.settingsSections ?? []
}

const nav = computed(() =>
  buildSettingsNav(
    PLUGIN_UI.map((ui) => {
      const info = plugins.value.find((p) => p.id === ui.id)
      return {
        id: ui.id,
        name: info?.name ?? ui.id,
        enabled: !!info?.enabled,
        core: !!info?.core,
        hasSections: (ui.settingsSections?.length ?? 0) > 0
      }
    })
  )
)

/** RSettingsNav 的模型:插件项归到「插件设置」分组,核心标记走 badge */
const navItems = computed<RSettingsNavItem[]>(() =>
  nav.value.map((i) =>
    i.kind === 'plugin'
      ? { id: i.id, label: i.label, group: '插件设置', badge: i.core ? '核心' : undefined }
      : { id: i.id, label: i.label }
  )
)

const activePluginId = computed(() => {
  const hit = nav.value.find((i) => i.kind === 'plugin' && i.id === activeId.value)
  return hit && hit.kind === 'plugin' ? hit.pluginId : null
})
const activePluginName = computed(() => nav.value.find((i) => i.id === activeId.value)?.label ?? '')
const activeSections = computed<Component[]>(() =>
  activePluginId.value ? sectionsOf(activePluginId.value) : []
)

/** 当前分区是否有效(插件被停用/移除/失去分区后回落到「插件管理」) */
const validActive = computed(() => nav.value.some((i) => i.id === activeId.value))
watch(validActive, (ok) => {
  if (!ok) activeId.value = SETTINGS_PLUGINS_ID
})

function select(id: string): void {
  activeId.value = id
}

function configurePlugin(pluginId: string): void {
  const id = settingsSectionId(pluginId)
  if (nav.value.some((i) => i.id === id)) activeId.value = id
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
  <div class="settings-page">
    <RSettingsNav
      :items="navItems"
      :model-value="activeId"
      title="设置"
      :width="208"
      @update:model-value="select"
    />

    <main class="settings-content">
      <header class="settings-head">
        <h1 class="settings-title">
          <template v-if="activeId === SETTINGS_GENERAL_ID">常规</template>
          <template v-else-if="activeId === SETTINGS_NETWORK_ID">网络</template>
          <template v-else-if="activeId === SETTINGS_TOOLBAR_ID">工具栏</template>
          <template v-else-if="activeId === SETTINGS_SHORTCUTS_ID">快捷键</template>
          <template v-else-if="activeId === SETTINGS_PLUGINS_ID">插件管理</template>
          <template v-else>{{ activePluginName }}</template>
        </h1>
        <span class="settings-hint">设置即时保存</span>
      </header>

      <div class="settings-body">
        <GeneralSettings v-if="activeId === SETTINGS_GENERAL_ID" />
        <NetworkSettings v-else-if="activeId === SETTINGS_NETWORK_ID" />
        <ToolbarSettings v-else-if="activeId === SETTINGS_TOOLBAR_ID" />
        <ShortcutsHelp v-else-if="activeId === SETTINGS_SHORTCUTS_ID" />
        <PluginManager v-else-if="activeId === SETTINGS_PLUGINS_ID" @configure="configurePlugin" />
        <template v-else>
          <component v-for="(C, i) in activeSections" :is="C" :key="`section-${i}`" />
        </template>
      </div>
    </main>
  </div>
</template>

<style scoped>
.settings-page {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}

/* ---------- 内容区 ---------- */
.settings-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.settings-head {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border);
}

.settings-title {
  font-size: 16px;
  font-weight: 600;
}

.settings-hint {
  color: var(--fg-dim);
  font-size: 12px;
}

.settings-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding-bottom: 16px;
}
</style>
