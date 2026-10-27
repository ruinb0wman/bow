import { createApp } from 'vue'
import App from './App.vue'
import '@xterm/xterm/css/xterm.css'
import { trackKeyboardInset } from './keyboardInset'
import '@ruinb0w/ui/style.css'
import './style.css'

createApp(App).mount('#app')

// 软键盘:让输入框始终在键盘上方(见 keyboardInset.ts 的注释)
trackKeyboardInset()
