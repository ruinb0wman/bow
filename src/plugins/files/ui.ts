/**
 * 文件管理插件的渲染层贡献:工具栏入口按钮 + 全屏面板 + 设置页分区。
 * 浮层 id 必须满足 `plugin:<pluginId>:<panelId>`(内核按这个正则把事件路由回插件)。
 */
import FilesButton from './ui/FilesButton.vue'
import FilesPanel from './ui/FilesPanel.vue'
import FilesSettings from './ui/FilesSettings.vue'

export default {
  id: 'files',
  slots: {
    toolbar: [FilesButton]
  },
  overlays: [
    {
      id: 'plugin:files:panel',
      component: FilesPanel,
      placement: 'full' as const
    }
  ],
  settingsSections: [FilesSettings]
}
