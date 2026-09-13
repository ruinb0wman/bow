import { describe, expect, it } from 'vitest'
import {
  SETTINGS_GENERAL_ID,
  SETTINGS_PLUGINS_ID,
  buildSettingsNav,
  settingsSectionId
} from '../src/shared/settingsNav'
import type { SettingsNavInput } from '../src/shared/settingsNav'

function item(patch: Partial<SettingsNavInput> & { id: string }): SettingsNavInput {
  return { name: patch.id, enabled: true, hasSections: true, ...patch }
}

describe('设置页侧栏导航', () => {
  it('固定以「常规 / 插件管理」开头', () => {
    const nav = buildSettingsNav([])
    expect(nav.map((i) => i.id)).toEqual([SETTINGS_GENERAL_ID, SETTINGS_PLUGINS_ID])
    expect(nav.map((i) => i.label)).toEqual(['常规', '插件管理'])
  })

  it('仅保留启用且贡献了分区的插件,并保持传入顺序', () => {
    const nav = buildSettingsNav([
      item({ id: 'bookmarks', hasSections: false }),
      item({ id: 'history', name: '浏览历史', core: true }),
      item({ id: 'cors', name: 'CORS 放行' }),
      item({ id: 'adblock', name: '广告/追踪拦截', enabled: false })
    ])
    expect(nav.map((i) => i.id)).toEqual([
      SETTINGS_GENERAL_ID,
      SETTINGS_PLUGINS_ID,
      settingsSectionId('history'),
      settingsSectionId('cors')
    ])
    expect(nav.map((i) => i.label)).toEqual(['常规', '插件管理', '浏览历史', 'CORS 放行'])
  })

  it('插件项携带 pluginId 与 core 标记', () => {
    const nav = buildSettingsNav([item({ id: 'history', name: '浏览历史', core: true })])
    const pluginItem = nav[2]
    expect(pluginItem.kind).toBe('plugin')
    if (pluginItem.kind !== 'plugin') throw new Error('应为插件项')
    expect(pluginItem.pluginId).toBe('history')
    expect(pluginItem.core).toBe(true)
  })

  it('没有可配置插件时只有两个核心项', () => {
    const nav = buildSettingsNav([item({ id: 'a', enabled: false }), item({ id: 'b', hasSections: false })])
    expect(nav).toHaveLength(2)
  })
})
