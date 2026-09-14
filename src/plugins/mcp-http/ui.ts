import McpHttpSettings from './ui/McpHttpSettings.vue'
import McpStatusBadge from './ui/McpStatusBadge.vue'

export default {
  id: 'mcp-http',
  slots: {
    'addressbar-trailing': [McpStatusBadge]
  },
  settingsSections: [McpHttpSettings]
}
