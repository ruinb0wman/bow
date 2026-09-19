/** 快捷键纯逻辑(三端安全,无 Electron/DOM 依赖):用于主进程识别 DevTools 快捷键 */

import type { PaneDir } from './split'

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

/** 标签快捷键识别结果 */
export type TabHotkey =
  | { action: 'new' }
  | { action: 'restore' }
  | { action: 'close' }
  | { action: 'switch'; digit: number }
  | { action: 'settings' }
  /** Ctrl/Cmd+L:普通页聚焦地址栏;**终端页让给 shell**(清屏,见 releasesToTerminal) */
  | { action: 'focus-address' }
  /**
   * Ctrl/Cmd+Shift+L:任何焦点下都聚焦地址栏,**含终端页**。
   * 刻意独立成一个 action(而不是并进 focus-address):releasesToTerminal 是**按 action** 放行的,
   * 共用 action 会让它在终端里被一起让给 shell —— 而「终端里也能用」正是这个快捷键要解决的问题。
   */
  | { action: 'focus-address-anywhere' }

/**
 * 标签快捷键识别:Ctrl/Cmd+T(新建)、Ctrl/Cmd+Shift+T(恢复)、
 * Ctrl/Cmd+W(关闭)、Ctrl/Cmd+1..9(切换,9=最后一个标签)、Ctrl/Cmd+,(打开设置)、
 * Ctrl/Cmd+L(聚焦地址栏,页面内也生效)、Ctrl/Cmd+Shift+L(聚焦地址栏,**终端里也不例外**)。
 * 与 isDevToolsHotkey 同风格:忽略自动重复与输入法组合;alt 修饰不参与。
 */
export function matchTabHotkey(input: KeyInputLike): TabHotkey | null {
  if (input.type !== 'keyDown') return null
  // 长按自动重复 / 输入法组合中的按键交给页面或 IME
  if (input.isAutoRepeat || input.isComposing) return null
  if (!(input.control || input.meta) || input.alt) return null
  const key = input.key.toLowerCase()
  if (input.shift) {
    if (key === 't' || input.code === 'KeyT') return { action: 'restore' }
    // 与 Ctrl+L 同族,但**不**让给终端:readline/shell 没有 Ctrl+Shift+L 绑定,抢来不亏
    if (key === 'l' || input.code === 'KeyL') return { action: 'focus-address-anywhere' }
    return null // Ctrl+Shift+数字 等不作为标签切换
  }
  if (key === 't' || input.code === 'KeyT') return { action: 'new' }
  if (key === 'w' || input.code === 'KeyW') return { action: 'close' }
  if (key === 'l' || input.code === 'KeyL') return { action: 'focus-address' }
  if (key === ',' || input.code === 'Comma') return { action: 'settings' }
  // 数字优先物理按键行的 code(Digit1..9):AZERTY 等非 QWERTY 布局下 key 可能是符号
  const codeMatch = /^Digit([1-9])$/.exec(input.code ?? '')
  if (codeMatch) return { action: 'switch', digit: Number(codeMatch[1]) }
  if ((input.code ?? '').startsWith('Numpad')) return null // 小键盘不参与
  if (/^[1-9]$/.test(key)) return { action: 'switch', digit: Number(key) }
  return null
}

/**
 * 当前活动标签是终端页(`bow://terminal`)时,这两个快捷键必须还给 shell:
 * - `Ctrl+W` = 删除前一个词 —— 误拦会直接关掉终端标签、丢掉会话;
 * - `Ctrl+L` = 清屏。
 * 其余(新建/恢复/切换/设置/数字)在 shell 里没有对应语义,保持浏览器行为。
 *
 * ⚠️ `focus-address-anywhere`(`Ctrl/Cmd+Shift+L`)刻意**不在这里** —— 它就是为「终端里也能跳去地址栏」加的。
 */
export function releasesToTerminal(hotkey: TabHotkey): boolean {
  return hotkey.action === 'close' || hotkey.action === 'focus-address'
}

/** 分屏快捷键:`split` = Ctrl/Cmd+Shift+方向(在聚焦窗格上分屏);`resize` = Alt+Shift+方向(向该方向扩张) */
export interface SplitHotkey {
  kind: 'split' | 'resize'
  dir: PaneDir
}

const ARROW_DIRS: Record<string, PaneDir> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

/**
 * 分屏快捷键识别:`Ctrl/Cmd+Shift+方向`(分屏)与 `Alt+Shift+方向`(调整大小)。
 *
 * 与 `matchTabHotkey` 的两处**刻意不同**:
 * - split **忽略自动重复**(长按方向键不会一口气开出一屏窗格);
 * - resize **允许自动重复**(按住不放连续调整大小)。
 *
 * 调用方还必须保证只在「聚焦的 webContents 是普通网页标签」时接管 —— 地址栏/设置页/终端/DevTools
 * 前端里的 `Ctrl+Shift+方向`(按词选择、xterm 选择扩展)要原样留给它们。
 */
export function matchSplitHotkey(input: KeyInputLike): SplitHotkey | null {
  if (input.type !== 'keyDown') return null
  if (input.isComposing) return null
  const dir = ARROW_DIRS[input.code ?? ''] ?? ARROW_DIRS[input.key]
  if (!dir) return null
  const ctrl = input.control || input.meta
  if (ctrl && input.shift && !input.alt) {
    return input.isAutoRepeat ? null : { kind: 'split', dir }
  }
  if (input.alt && input.shift && !ctrl) return { kind: 'resize', dir }
  return null
}

/**
 * 插件热键规格:由插件通过 PluginContext.shortcuts 注册,主进程统一匹配。
 * 声明式描述便于单测与避免插件接触 Electron 输入事件。
 */
export interface HotkeySpec {
  /** 主键(小写,如 'f'),匹配 input.key */
  key: string
  /** 可选物理键 code(非 QWERTY 布局兼容,如 'KeyF');提供时优先按 code 匹配 */
  code?: string
  /** 是否需要 Ctrl(macOS 上 Cmd 等价) */
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

/** 插件热键匹配:keyDown、非自动重复、非输入法组合,修饰键需精确一致 */
export function matchHotkey(input: KeyInputLike, spec: HotkeySpec): boolean {
  if (input.type !== 'keyDown') return false
  if (input.isAutoRepeat || input.isComposing) return false
  const ctrl = input.control || input.meta
  if (!!spec.ctrl !== ctrl) return false
  if (!!spec.shift !== input.shift) return false
  if (!!spec.alt !== input.alt) return false
  if (spec.code && input.code === spec.code) return true
  return input.key.toLowerCase() === spec.key.toLowerCase()
}

/**
 * 第 digit 项 → 下标:1..8 取第 digit 项;9 取最后一项(Chrome 惯例);越界/空列表返回 null。
 * 注意这里传的是**标签栏项数**(= 标签组数,一个分屏组只算一项),不是标签页数。
 */
export function switchIndexForDigit(digit: number, itemCount: number): number | null {
  if (itemCount <= 0) return null
  if (digit === 9) return itemCount - 1
  if (digit >= 1 && digit <= 8 && digit - 1 < itemCount) return digit - 1
  return null
}
