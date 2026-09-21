/**
 * 下载插件的渲染层贡献:工具栏入口按钮 + 全屏面板 + 设置页分区。
 * 浮层 id 必须满足 `plugin:<pluginId>:<panelId>`(内核按这个正则把事件路由回插件)。
 */
import DownloadsButton from './ui/DownloadsButton.vue'
import DownloadsPanel from './ui/DownloadsPanel.vue'
import DownloadsSettings from './ui/DownloadsSettings.vue'

export default {
  id: 'downloads',
  slots: {
    toolbar: [DownloadsButton]
  },
  overlays: [
    {
      id: 'plugin:downloads:panel',
      component: DownloadsPanel,
      placement: 'full' as const
    }
  ],
  settingsSections: [DownloadsSettings]
}
