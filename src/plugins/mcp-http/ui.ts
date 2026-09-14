import McpHttpSettings from './ui/McpHttpSettings.vue'
import McpStatusBadge from './ui/McpStatusBadge.vue'

export default {
  id: 'mcp-http',
  slots: {
    // 状态灯放在工具栏(搜索栏外、书签按钮右侧),不再挤占地址栏内部空间
    toolbar: [McpStatusBadge]
  },
  settingsSections: [McpHttpSettings]
}
