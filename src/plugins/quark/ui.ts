/**
 * 夸克网盘插件的渲染层贡献:工具栏按钮 + 全屏面板 + 设置分区。
 * 浮层 id 必须满足 `plugin:<pluginId>:<panelId>`(内核按这个正则把事件路由回插件)。
 */
import QuarkButton from './ui/QuarkButton.vue'
import QuarkPanel from './ui/QuarkPanel.vue'
import QuarkSettings from './ui/QuarkSettings.vue'

export default {
  id: 'quark',
  slots: {
    toolbar: [QuarkButton]
  },
  overlays: [
    {
      id: 'plugin:quark:panel',
      component: QuarkPanel,
      placement: 'full' as const
    }
  ],
  settingsSections: [QuarkSettings]
}
