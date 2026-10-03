/**
 * 番茄钟渲染层贡献:工具栏倒计时按钮 + 「below-chrome」锚定下拉面板 + 设置分区。
 * 浮层 id 必须满足 `plugin:<pluginId>:<panelId>`(内核按这个正则把事件路由回插件)。
 */
import PomoButton from './ui/PomoButton.vue'
import PomoPanel from './ui/PomoPanel.vue'
import PomoSettings from './ui/PomoSettings.vue'

export default {
  id: 'pomo',
  slots: {
    toolbar: [PomoButton]
  },
  overlays: [
    {
      id: 'plugin:pomo:panel',
      component: PomoPanel,
      placement: 'below-chrome' as const
    }
  ],
  settingsSections: [PomoSettings]
}
