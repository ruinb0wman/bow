/**
 * 密码插件的渲染层贡献:工具栏按钮 + 全窗面板 + 设置分区。
 * 浮层 id 必须满足 `plugin:<pluginId>:<panelId>`(内核按这个正则把事件路由回插件)。
 */
import PasswordsButton from './ui/PasswordsButton.vue'
import PasswordsPanel from './ui/PasswordsPanel.vue'
import PasswordsSettings from './ui/PasswordsSettings.vue'

export default {
  id: 'passwords',
  slots: {
    toolbar: [PasswordsButton]
  },
  overlays: [
    {
      id: 'plugin:passwords:panel',
      component: PasswordsPanel,
      placement: 'full' as const
    }
  ],
  settingsSections: [PasswordsSettings]
}
