/**
 * 自定义本地服务的渲染层贡献:工具栏图标(一条服务一个)+ 设置分区。
 *
 * 没有浮层、没有地址栏建议、没有 MCP 工具 —— 内容全在各服务自己的 web 前端里(普通 http 标签)。
 */
import ServicesToolbar from './ui/ServicesToolbar.vue'
import ServicesSettings from './ui/ServicesSettings.vue'

export default {
  id: 'services',
  slots: {
    toolbar: [ServicesToolbar]
  },
  settingsSections: [ServicesSettings]
}
