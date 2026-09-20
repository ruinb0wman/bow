import LogseqButton from './ui/LogseqButton.vue'
import LogseqSettings from './ui/LogseqSettings.vue'

/**
 * 笔记插件的渲染层贡献。
 *
 * 注意:`ui/JournalView.vue`(`bow://logseq` 页面的主体)**不在这里注册** ——
 * 它是内部页面的视图,由 `renderer/src/logseq/main.ts` 直接挂载,不走插槽/浮层注册表
 * (与终端插件的 `ui/TerminalView.vue` 同款)。
 */
export default {
  id: 'logseq',
  slots: {
    toolbar: [LogseqButton]
  },
  settingsSections: [LogseqSettings]
}
