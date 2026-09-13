/** 渲染层插件 UI 契约(仅渲染层使用) */

import type { Component } from 'vue'
import type { OverlayPlacement } from '@shared/types'

export interface PluginOverlayContribution {
  /** 约定 `plugin:<pluginId>:<panelId>` */
  id: string
  component: Component
  placement: OverlayPlacement
}

export interface PluginUiContribution {
  id: string
  /** 具名插槽:组件自行订阅 browserAPI 响应标签变化 */
  slots?: {
    /** 地址栏内的尾部区域(书签星标等) */
    'addressbar-trailing'?: Component[]
    /** 工具栏按钮区(在地址栏与恢复标签按钮之间) */
    toolbar?: Component[]
  }
  overlays?: PluginOverlayContribution[]
  /** 渲染在核心设置弹层内 */
  settingsSections?: Component[]
}
