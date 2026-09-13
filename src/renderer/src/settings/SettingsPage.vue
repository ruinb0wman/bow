<script setup lang="ts">
/**
 * 设置页(浏览器内部标签页 bow://settings):
 * 左侧导航 = 常规 + 插件管理 + 每个「已启用且贡献了设置分区」的插件一项;
 * 右侧内容全宽渲染,插件设置内联展示(不再嵌套弹窗),所有设置即时保存。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Component } from 'vue'
import type { PluginInfo } from '@shared/plugins'
import {
  SETTINGS_GENERAL_ID,
  SETTINGS_PLUGINS_ID,
  buildSettingsNav,
  settingsSectionId
} from '@shared/settingsNav'
import { PLUGIN_UI } from '../plugins/registry'
import GeneralSettings from './GeneralSettings.vue'
import PluginManager from './PluginManager.vue'

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

const coreNav = computed(() => nav.value.filter((i) => i.kind !== 'plugin'))
const pluginNav = computed(() => nav.value.filter((i) => i.kind === 'plugin'))

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
    <aside class="settings-sidebar">
      <div class="settings-brand">设置</div>
      <nav class="settings-nav">
        <button
          v-for="item in coreNav"
          :key="item.id"
          class="settings-nav-item"
          :class="{ on: activeId === item.id }"
          @click="select(item.id)"
        >
          {{ item.label }}
        </button>
        <template v-if="pluginNav.length > 0">
          <div class="settings-nav-group">插件设置</div>
          <button
            v-for="item in pluginNav"
            :key="item.id"
            class="settings-nav-item"
            :class="{ on: activeId === item.id }"
            @click="select(item.id)"
          >
            <span class="settings-nav-label">{{ item.label }}</span>
            <span v-if="item.core" class="settings-nav-core" title="关闭后会影响核心功能">核心</span>
          </button>
        </template>
      </nav>
    </aside>

    <main class="settings-content">
      <header class="settings-head">
        <h1 class="settings-title">
          <template v-if="activeId === SETTINGS_GENERAL_ID">常规</template>
          <template v-else-if="activeId === SETTINGS_PLUGINS_ID">插件管理</template>
          <template v-else>{{ activePluginName }}</template>
        </h1>
        <span class="settings-hint">设置即时保存</span>
      </header>

      <div class="settings-body" :class="{ 'settings-body-plugin': !!activePluginId }">
        <GeneralSettings v-if="activeId === SETTINGS_GENERAL_ID" />
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

/* ---------- 侧栏 ---------- */
.settings-sidebar {
  flex: none;
  width: 208px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 10px;
  overflow-y: auto;
  background: var(--bg2);
  border-right: 1px solid var(--border);
}

.settings-brand {
  padding: 0 8px 10px;
  font-size: 15px;
  font-weight: 700;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--radius);
  color: var(--fg-dim);
  font-size: 13px;
  text-align: left;
}

.settings-nav-item:hover {
  background: var(--bg3);
  color: var(--fg);
}

.settings-nav-item.on {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--fg);
}

.settings-nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-nav-core {
  flex: none;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(255, 170, 60, 0.22);
}

.settings-nav-group {
  padding: 14px 10px 4px;
  color: var(--fg-dim);
  font-size: 11px;
  letter-spacing: 0.06em;
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

/* 插件分区:占满剩余高度,让历史/广告等长列表用足空间 */
.settings-body-plugin {
  overflow: hidden;
  padding-bottom: 0;
}
</style>
