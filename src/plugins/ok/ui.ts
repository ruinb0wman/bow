/**
 * OpenKnowledge 渲染层贡献:工具栏入口按钮 + 设置分区。
 *
 * 没有浮层、没有地址栏建议、没有 MCP 工具 —— 这是一次性的服务入口,
 * 内容全在 OK 自己的 web 前端里(普通 http 标签)。
 */
import OkButton from './ui/OkButton.vue'
import OkSettings from './ui/OkSettings.vue'

export default {
  id: 'ok',
  slots: {
    toolbar: [OkButton]
  },
  settingsSections: [OkSettings]
}
