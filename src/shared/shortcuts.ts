/** 快捷键纯逻辑(三端安全,无 Electron/DOM 依赖):用于主进程识别 DevTools 快捷键 */

/** Electron `Input`(webContents before-input-event)与本接口结构化兼容 */
export interface KeyInputLike {
  type: string
  key: string
  code: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
  isAutoRepeat: boolean
  isComposing: boolean
}

/** 是否为"打开/关闭 DevTools"快捷键:Ctrl/Cmd+Shift+I 或 F12 */
export function isDevToolsHotkey(input: KeyInputLike): boolean {
  if (input.type !== 'keyDown') return false
  // 长按自动重复会反复切换,输入法组合中的按键交给 IME
  if (input.isAutoRepeat || input.isComposing) return false
  if (input.key === 'F12') return true
  if (!(input.control || input.meta) || !input.shift || input.alt) return false
  // code 兼容非 QWERTY 布局;key 兼容大小写
  return input.code === 'KeyI' || input.key.toLowerCase() === 'i'
}
