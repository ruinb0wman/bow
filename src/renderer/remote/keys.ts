/**
 * 按键条的纯逻辑(可单测):快捷序列表 + 「粘滞 Ctrl/Alt + 一个字符」的改写。
 *
 * 为什么需要改写:浏览器不允许网页合成键盘事件到输入框之外,手机上也根本发不出 `Ctrl+C`。
 * xterm 的 `onData` 是唯一出口,所以修饰键只能在**已经拿到字符之后**再改写 —— 这也是
 * 桌面终端做的事(它拿的是 keydown,我们只有字符)。
 */

export interface QuickKey {
  label: string
  data: string
  title: string
}

export const QUICK_KEYS: QuickKey[] = [
  { label: 'Esc', data: '\x1b', title: 'Escape' },
  { label: 'Tab', data: '\t', title: 'Tab' },
  // 手机输入法把 / 压到第二页,而路径几乎每行都要打
  { label: '/', data: '/', title: '斜杠(路径)' },
  { label: '↑', data: '\x1b[A', title: '上' },
  { label: '↓', data: '\x1b[B', title: '下' },
  { label: '→', data: '\x1b[C', title: '右' },
  { label: '←', data: '\x1b[D', title: '左' },
  { label: 'C-c', data: '\x03', title: '中断(Ctrl+C)' },
  { label: 'C-d', data: '\x04', title: 'EOF(Ctrl+D)' },
  { label: 'C-l', data: '\x0c', title: '清屏(Ctrl+L)' },
  { label: 'C-r', data: '\x12', title: '反向搜索(Ctrl+R)' },
  // 全屏程序(vim / less / tmux)自己管屏幕:本地回看对它们没意义,要把翻页键**发给**它们
  { label: 'PgUp', data: '\x1b[5~', title: 'PageUp(发给程序)' },
  { label: 'PgDn', data: '\x1b[6~', title: 'PageDown(发给程序)' }
]

/**
 * 把「粘滞修饰 + 一个字符」翻成实际字节。没有修饰、或输入不是**单个字符**(粘贴的一大段)
 * 都原样返回 —— 否则一次粘贴会被整体改写成控制码。
 */
export function applyModifiers(data: string, mods: { ctrl: boolean; alt: boolean }): string {
  if (!mods.ctrl && !mods.alt) return data
  if ([...data].length !== 1) return data
  let out = data
  if (mods.ctrl) {
    const code = data.toUpperCase().charCodeAt(0)
    // Ctrl+A..Ctrl+Z → 0x01..0x1a;Ctrl+[ \ ] → 0x1b..0x1d
    if (code >= 0x40 && code <= 0x5d) out = String.fromCharCode(code - 0x40)
  }
  if (mods.alt) out = `\x1b${out}`
  return out
}
