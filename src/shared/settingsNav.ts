/**
 * 设置页侧栏导航模型(纯函数,可单测):
 * 固定顺序 = [常规, 插件管理] + 「已启用且贡献了设置分区」的插件各一项(保持注册顺序)。
 * 渲染层负责把 PLUGIN_UI 注册表 + PluginInfo 映射成输入项,本模块只做分组/过滤/排序。
 */

export const SETTINGS_GENERAL_ID = 'general'
export const SETTINGS_PLUGINS_ID = 'plugins'

/** 插件设置分区 id 约定:与插件浮层 id 同风格 */
export function settingsSectionId(pluginId: string): string {
  return `plugin:${pluginId}`
}

export interface SettingsNavInput {
  id: string
  name: string
  enabled: boolean
  /** 关闭后会影响核心功能(插件管理页展示提示) */
  core?: boolean
  /** 该插件是否贡献了 settingsSections */
  hasSections: boolean
}

export type SettingsNavItem =
  | { id: typeof SETTINGS_GENERAL_ID; label: '常规'; kind: 'general' }
  | { id: typeof SETTINGS_PLUGINS_ID; label: '插件管理'; kind: 'manage' }
  | { id: string; label: string; kind: 'plugin'; pluginId: string; core: boolean }

/** 侧栏分组:「插件设置」小节里展示的全部是插件项 */
export function buildSettingsNav(items: SettingsNavInput[]): SettingsNavItem[] {
  const nav: SettingsNavItem[] = [
    { id: SETTINGS_GENERAL_ID, label: '常规', kind: 'general' },
    { id: SETTINGS_PLUGINS_ID, label: '插件管理', kind: 'manage' }
  ]
  for (const it of items) {
    if (!it.enabled || !it.hasSections) continue
    nav.push({
      id: settingsSectionId(it.id),
      label: it.name,
      kind: 'plugin',
      pluginId: it.id,
      core: !!it.core
    })
  }
  return nav
}
