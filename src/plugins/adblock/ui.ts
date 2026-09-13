import AdblockSettings from './ui/AdblockSettings.vue'
import BlockElementButton from './ui/BlockElementButton.vue'

export default {
  id: 'adblock',
  slots: {
    toolbar: [BlockElementButton]
  },
  settingsSections: [AdblockSettings]
}
