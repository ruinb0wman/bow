/**
 * 编辑器插件的渲染层贡献:工具栏「用编辑器打开…」+ 设置分区。
 *
 * 页面主体不在这里 —— 编辑器就是终端页里的 nvim(`bow://terminal` 由终端插件承载),
 * 本插件不拥有任何内部页面(见 `.pi/plans/2026-10-14-editor-plugin/plan.md` §9)。
 */
import EditorButton from './ui/EditorButton.vue'
import EditorSettings from './ui/EditorSettings.vue'

export default {
  id: 'editor',
  slots: {
    toolbar: [EditorButton]
  },
  settingsSections: [EditorSettings]
}
