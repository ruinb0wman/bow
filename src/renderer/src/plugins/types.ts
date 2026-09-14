/** 渲染层插件 UI 契约(仅渲染层使用) */

import type { Component } from 'vue'
import type { OverlayPlacement } from '@shared/types'

export interface PluginOverlayContribution {
  /** 约定 `plugin:<pluginId>:<panelId>` */
  id: string
  component: Component
  placement: OverlayPlacement
}

/** host 提供的具名插槽锚点(同一个槽被多个插件占用时,左右顺序见 registry 的 SLOT_PLUGIN_ORDER) */
export type PluginSlot = 'addressbar-trailing' | 'toolbar'

export interface PluginUiContribution {
  id: string
  /**
   * 具名插槽:组件自行订阅 browserAPI 响应标签变化。
   * - `addressbar-trailing`:地址栏内的尾部区域(书签星标等)
   * - `toolbar`:工具栏按钮区(在地址栏与恢复标签按钮之间)
   */
  slots?: Partial<Record<PluginSlot, Component[]>>
  overlays?: PluginOverlayContribution[]
  /** 渲染在设置页(bow://settings)中该插件对应的分区内(宿主管侧栏导航与标题);为空则不显示侧栏入口 */
  settingsSections?: Component[]
}
