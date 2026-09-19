import TerminalButton from './ui/TerminalButton.vue'
import TerminalSettings from './ui/TerminalSettings.vue'

/**
 * 终端插件的渲染层贡献。
 *
 * 注意:`ui/TerminalView.vue`(bow://terminal 页面的主体)**不在这里注册** ——
 * 它是内部页面的视图,由 `renderer/src/terminal/main.ts` 直接挂载,不走插槽/浮层注册表。
 */
export default {
  id: 'terminal',
  slots: {
    toolbar: [TerminalButton]
  },
  settingsSections: [TerminalSettings]
}
