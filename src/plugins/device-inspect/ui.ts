import DeviceInspectButton from './ui/DeviceInspectButton.vue'
import DeviceInspectPanel from './ui/DeviceInspectPanel.vue'

export default {
  id: 'device-inspect',
  slots: {
    toolbar: [DeviceInspectButton]
  },
  overlays: [
    {
      id: 'plugin:device-inspect:panel',
      component: DeviceInspectPanel,
      placement: 'full' as const
    }
  ]
}
