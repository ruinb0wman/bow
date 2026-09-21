/** 快捷键纯逻辑(三端安全,无 Electron/DOM 依赖):用于主进程识别 DevTools 快捷键 */

import type { InternalPageId } from './internalPages'
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
   * Ctrl/Cmd+Shift+E:在**当前聚焦窗格**里开一个终端(顶替窗格,与地址栏输 `bow://terminal` 同一条路)。
   * 同样必须独立成 action:① `releasesToTerminal` 按 action 放行,共用 action 会被一起让给 shell;
   * ② 用户在终端里按它时要能被浏览器吃掉(已是终端 = 空操作,绝不能漏给 shell)。
   */
  | { action: 'terminal' }
  /**
   * `Ctrl+←`(后退)/ `Ctrl+→`(前进):作用于**按键来源的那个窗格**的历史(与 close 同口径)。
   * 这两个 action 只认 **Ctrl**(不认 ⌘):macOS 上 ⌘+←/→ 是「行首/行尾」,而 Ctrl+←/→ 常被系统
   * (Mission Control / 切换桌面)先吃掉 —— 主进程再用 `historyHotkeyEnabled()` 挡一层平台闸门。
   * 终端页里会经 `releasesToTerminal` 让给 shell(readline 的按词移动)。
   */
  | { action: 'back' }
  | { action: 'forward' }
  /**
   * `Ctrl/Cmd+R`:刷新**聚焦窗格**。原先只在渲染层(chrome 聚焦时)承接 ⇒ 页面聚焦时按它是死键,
   * 现在与其它 tab 热键一起由主进程全局拦截(见 `src/main/tabShortcuts.ts` 的 reload 分支)。
   * 终端页里让给 shell(`Ctrl+R` = 反向历史搜索,见 `releasesToTerminal`)。
   */
  | { action: 'reload' }

/** 方向键 code/key → 方向(`matchTabHotkey` 的历史导航与 `matchSplitHotkey` 共用) */
const ARROW_DIRS: Record<string, PaneDir> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

/**
 * 标签快捷键识别:Ctrl/Cmd+T(新建)、Ctrl/Cmd+Shift+T(恢复)、
 * Ctrl/Cmd+W(关闭)、Ctrl/Cmd+1..9(切换,9=最后一个标签)、Ctrl/Cmd+,(打开设置)、
 * Ctrl/Cmd+L(聚焦地址栏,页面内也生效)、Ctrl/Cmd+Shift+L(聚焦地址栏,**终端里也不例外**)、
 * Ctrl/Cmd+Shift+E(在聚焦窗格开终端)、Ctrl/Cmd+R(刷新聚焦窗格)、
 * Ctrl+←/→(历史后退/前进,**只认 Ctrl**)。
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
    // 在聚焦窗格开终端(Ctrl/Cmd+Shift+E):shell 与常见网页都不用这个组合,抢来不亏
    if (key === 'e' || input.code === 'KeyE') return { action: 'terminal' }
    return null // Ctrl+Shift+数字 等不作为标签切换
  }
  // Ctrl+←/→ = 历史后退/前进。只认 control(**不认 meta**),所以 mac 上 ⌘+←/→(行首/行尾)
  // 与本函数无关;Alt 也已由上面的兜底挡掉。是否启用还看主进程的 historyHotkeyEnabled()。
  // 小键盘排除与数字切换一致(Numpad4/6 的 key 也是 ArrowLeft/Right)。
  const code = input.code ?? ''
  const arrowDir = ARROW_DIRS[code] ?? (code.startsWith('Numpad') ? undefined : ARROW_DIRS[input.key])
  if (input.control && !input.meta && arrowDir) {
    if (arrowDir === 'left') return { action: 'back' }
    if (arrowDir === 'right') return { action: 'forward' }
    return null // Ctrl+↑/↓ 不接管
  }
  if (key === 't' || input.code === 'KeyT') return { action: 'new' }
  if (key === 'w' || input.code === 'KeyW') return { action: 'close' }
  if (key === 'l' || input.code === 'KeyL') return { action: 'focus-address' }
  if (key === 'r' || input.code === 'KeyR') return { action: 'reload' }
  if (key === ',' || input.code === 'Comma') return { action: 'settings' }
  // 数字优先物理按键行的 code(Digit1..9):AZERTY 等非 QWERTY 布局下 key 可能是符号
  const codeMatch = /^Digit([1-9])$/.exec(input.code ?? '')
  if (codeMatch) return { action: 'switch', digit: Number(codeMatch[1]) }
  if ((input.code ?? '').startsWith('Numpad')) return null // 小键盘不参与
  if (/^[1-9]$/.test(key)) return { action: 'switch', digit: Number(key) }
  return null
}

/**
 * 当前(按键来源的)标签是终端页(`bow://terminal`)时,必须还给 shell 的组合:
 * - `Ctrl+L` = 清屏 —— shell 的高频键,且没有替代品;
 * - `Ctrl+R` = 反向历史搜索(reverse-i-search)—— 同样是 shell 高频键,没有替代品;
 * - `Ctrl+←/→` = 按词移动(readline 的 backward/forward-word)—— 2026-09-21 用户拍板放行
 *   (终端页本来也没有可回退的浏览历史,让给 shell 零损失);
 * - (曾是 `Ctrl+W` = 删除前一个词)**2026-09-19 用户拍板改为归浏览器**:终端里也要能用 `Ctrl+W` 关掉
 *   聚焦窗格;代价是 shell 的「删词」让位(README 里写明了)。
 * 其余(新建/恢复/切换/设置/数字/开终端)在 shell 里没有对应语义,保持浏览器行为。
 *
 * ⚠️ `focus-address-anywhere`(`Ctrl/Cmd+Shift+L`)与 `terminal`(`Ctrl/Cmd+Shift+E`)刻意**不在这里** ——
 * 前者就是为「终端里也能跳去地址栏」加的,后者在终端里是空操作、更不能漏给 shell。
 */
export function releasesToTerminal(hotkey: TabHotkey): boolean {
  return (
    hotkey.action === 'focus-address' ||
    hotkey.action === 'reload' ||
    hotkey.action === 'back' ||
    hotkey.action === 'forward'
  )
}

/**
 * `Ctrl+←/→`(历史后退/前进)是否在本平台启用。
 *
 * macOS 上 `Ctrl+←/→` 常被系统(Mission Control / 切换桌面)先吃掉,而 `⌘+←/→` 是「行首/行尾」——
 * 两个都不能动,所以 2026-09-21 用户拍板:**mac 不启用**。
 * `matchTabHotkey` 里箭头只认 `control`(不认 `meta`),这里再挡一层,保证 mac 上是「按键不接管」
 * (原样留给系统/页面),而不是「接管之后什么都不做」。
 */
export function historyHotkeyEnabled(platform: string): boolean {
  return platform !== 'darwin'
}

/** 分屏快捷键:`split` = Ctrl/Cmd+Shift+方向(在聚焦窗格上分屏);`resize` = Alt+Shift+方向(把最内层那条同轴分隔条朝该方向推) */
export interface SplitHotkey {
  kind: 'split' | 'resize'
  dir: PaneDir
}

/** 聚焦视图的「够用」形状(`TabRecord` 的子集,便于单测时不必造假 TabManager) */
export interface SplitHotkeyTarget {
  /** 是否为内部页面(`TabInfo.internal`) */
  internal: boolean
  /** 内部页面 id(`bow://` 页面才有,非内部页面为 null) */
  internalPageId: InternalPageId | null
}

/**
 * 分屏快捷键(`Ctrl+Shift+方向` / `Alt+Shift+方向`)该由浏览器接管吗?
 * - 普通网页标签:接管(代价是网页 `<input>` 也拿不到,见 README);
 * - 终端页(`bow://terminal`):**接管** —— 终端窗格也是「要分屏 / 要调大小」的地方,
 *   而 xterm 只会把这两个组合当输入送进 pty,不拦就等于按键没反应;
 * - 设置页、DevTools 前端标签(inspector):不接管(它们自己的文本选择 / 前端快捷键要留着);
 * - `null`(地址栏 / 浮层 / 别的窗口的 webContents):不接管。
 */
export function shouldTakeSplitHotkey(target: SplitHotkeyTarget | null): boolean {
  if (!target) return false
  return !target.internal || target.internalPageId === 'terminal'
}

/**
 * 分屏快捷键识别:`Ctrl/Cmd+Shift+方向`(分屏)与 `Alt+Shift+方向`(调整大小)。
 *
 * 与 `matchTabHotkey` 的两处**刻意不同**:
 * - split **忽略自动重复**(长按方向键不会一口气开出一屏窗格);
 * - resize **允许自动重复**(按住不放连续调整大小)。
 *
 * 调用方用 `shouldTakeSplitHotkey()` 决定是否接管:普通网页标签与**终端页**都接管
 * (终端里 xterm 会把组合编成 CSI 序列送进 pty,不拦就永远分不了屏 / 调不了大小),
 * 地址栏 / 设置页 / DevTools 前端里的这些组合原样留给它们。
 *
 * ⚠️ 顺带更正一句老注释:终端页里 `Ctrl+Shift+方向` **不是**「xterm 的选择扩展」——
 * xterm 的 `SelectionService.shouldForceSelection()` 只看鼠标事件,键盘上是 `evaluateKeyboardEvent()`
 * 把带修饰的方向键编成 `\e[1;<modifier+1>{A,B,C,D}` 直接发进 pty。所以放行 = 纯丢键,不是「留着力气」。
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
