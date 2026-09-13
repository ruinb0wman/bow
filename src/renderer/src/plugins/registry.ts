/**
 * 渲染层插件 UI 注册表:静态收集各插件 ui.ts 的贡献,
 * host(App.vue / OverlayApp.vue / 设置页 SettingsPage.vue)按「已启用插件」过滤后渲染。
 * 新增插件 UI = 新建 src/plugins/<id>/ui.ts 并在此登记一行,host 代码零改动。
 */

import type { PluginUiContribution } from './types'
import bookmarksUi from '@plugins/bookmarks/ui'
import historyUi from '@plugins/history/ui'
import corsUi from '@plugins/cors/ui'
import adblockUi from '@plugins/adblock/ui'
import elementFullscreenUi from '@plugins/element-fullscreen/ui'

export const PLUGIN_UI: PluginUiContribution[] = [
  bookmarksUi,
  historyUi,
  corsUi,
  adblockUi,
  elementFullscreenUi
]

export function pluginUi(id: string): PluginUiContribution | undefined {
  return PLUGIN_UI.find((p) => p.id === id)
}
