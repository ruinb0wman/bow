import TerminalButton from './ui/TerminalButton.vue'
import HerdButton from './ui/HerdButton.vue'
import HerdPanel from './ui/HerdPanel.vue'
import TerminalSettings from './ui/TerminalSettings.vue'
import RemoteSettings from './ui/RemoteSettings.vue'

/**
 * 终端插件的渲染层贡献。
 *
 * 注意:`ui/TerminalView.vue`(bow://terminal 页面的主体)**不在这里注册** ——
 * 它是内部页面的视图,由 `renderer/src/terminal/main.ts` 直接挂载,不走插槽/浮层注册表。
 */
export default {
  id: 'terminal',
  slots: {
    // 「新终端」在前、「牧群」在后:前者的位置是用户肌肉记忆,不动
    toolbar: [TerminalButton, HerdButton]
  },
  overlays: [
    // 浮层 id 必须满足 `plugin:<pluginId>:<panelId>`(内核按这个正则把事件路由回插件)
    { id: 'plugin:terminal:herd', component: HerdPanel, placement: 'full' as const }
  ],
  // 两个分区:外观/shell 配置 + 远程控制(顺序就是设置页里的显示顺序)
  settingsSections: [TerminalSettings, RemoteSettings]
}
