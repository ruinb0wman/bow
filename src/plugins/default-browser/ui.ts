import DefaultBrowserSettings from './ui/DefaultBrowserSettings.vue'

export default {
  id: 'default-browser',
  // 只贡献设置页分区(不占工具栏):注册 / 撤销是低频动作,状态也在设置页里看
  settingsSections: [DefaultBrowserSettings]
}
