import { createApp } from 'vue'
import SettingsPage from './SettingsPage.vue'
import { isEditableTarget, splitHotkeyFromEvent } from '../lib/splitKeys'
import '@ruinb0w/ui/style.css'
import '../style.css'

createApp(SettingsPage).mount('#app')

// 分屏 / 调大小键:设置页不在主进程 `shouldTakeSplitHotkey()` 的白名单里(输入框要保住按词选择),
// 按键会正常送到页面 —— 于是由页面自己调 IPC 完成,与笔记页同一条路(见 lib/splitKeys.ts)。
const api = window.browserAPI
window.addEventListener('keydown', (e) => {
  // 输入框 / 文本域 / 下拉 / contenteditable 里不抢键
  if (isEditableTarget(e.target)) return
  const hk = splitHotkeyFromEvent(e)
  if (!hk) return
  // preventDefault 会同时阻止页面 keydown/keyup 与菜单快捷键(与主进程那侧同策略)
  e.preventDefault()
  if (hk.kind === 'split') void api.splitPane(hk.dir)
  else void api.resizePane(hk.dir)
})
