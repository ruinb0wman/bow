/**
 * 修 xterm.js 在 Windows 上的 AltGr 误判:`Ctrl+Alt+<可打印键>` 到不了 pty。
 *
 * 症状:焦点在 `bow://terminal` 里按 `Ctrl+Alt+P`(pi / pi-agents 切 plan·build 模式的快捷键)
 * 完全没反应;Windows Terminal 里同一个键却正常。
 *
 * 取证(xterm 6.0.0,`src/browser/CoreBrowserTerminal.ts`):
 *
 * ```ts
 * private _isThirdLevelShift(browser: IBrowser, ev: KeyboardEvent): boolean {
 *   const thirdLevelKey =
 *     (browser.isMac && ...) ||
 *     (browser.isWindows && ev.altKey && ev.ctrlKey && !ev.metaKey) ||   // ← 只要 alt+ctrl 就算 AltGr
 *     (browser.isWindows && ev.getModifierState('AltGraph'));
 *   ...
 * }
 * ```
 *
 * 而 `_keyDown()` 的顺序是「先算字节 → 查第三级 shift → 第三级就直接 `return true`」:
 * `evaluateKeyboardEvent()` 早就算出了该发的 `ESC + 控制字符`(Ctrl+Alt+P → `\x1b\x10`),
 * 却在 `this.coreService.triggerDataEvent(result.key, true)` **之前**被丢掉 ⇒ 纯丢键。
 *
 * 关键点:Chromium 其实给了区分的信号 —— `getModifierState('AltGraph')` 只在这套布局能把该组合
 * 变成字符时才置上(`ui/events/keycodes/platform_key_map_win.cc` 的 `ReplaceControlAndAltWithAltGraph`)。
 * xterm 2021 年为死键问题补了第三条判据(PR #3432),却把「只要 alt+ctrl」的老判据留在原地。
 *
 * 修法(与上游 orca 为同一 bug 的做法一致,PR #8810):运行时把那条判据**包一层**,
 * 只在「真的是 Ctrl+Alt 组合」(见 `isGenuineCtrlAltChord`)时把它削弱成 `false`,
 * 让按键继续走 xterm **自己的编码器** —— 字节因此仍是 `ESC + 控制字符`,
 * 以后 xterm 支持 kitty / win32-input-mode 时也自动跟着正确。
 * 刻意**不在这里自己拼字节**:那要复刻编码器(kitty 协议、数字/符号、`Ctrl+Alt+Shift`、
 * 按 `code` 取键在 Dvorak 上错位、丢掉 xterm 的 `stopPropagation`),差一处就是新的错字节。
 *
 * 失败模式:拿不到 xterm 的内部判据(升级后改名/换结构)就返回 `false` 什么都不做 ——
 * 行为退回今天(丢键),**绝不会发出错误的字节**。调试把手 `__bowTerminal.ctrlAltRepaired`
 * 与 E2E 都会断言这个返回值,退化时能被发现。
 *
 * 为什么必须包判据、而不是在 `attachCustomKeyEventHandler` 里拦:见上面「刻意不在这里自己拼字节」。
 *
 * 不覆盖:macOS 的 `Ctrl+Option+字母`(在 mac 分支的 `evaluateKeyboardEvent` 里就已经没有 key 了,
 * 是另一处原因);AltGr 布局(德语/法语/波兰语…)里 Chromium 会给 Ctrl+Alt 组合置上 `AltGraph`,
 * 真组合仍分不出来(维持现状)。
 */

import type { Terminal } from '@xterm/xterm'
import { isGenuineCtrlAltChord } from '@plugins/terminal/shared'
import type { CtrlAltChordLike } from '@plugins/terminal/shared'

/** 我们真正依赖的 xterm 内部形状(`CoreBrowserTerminal` 上那条私有判据 + 平台标志) */
interface ThirdLevelShiftCore {
  browser?: { isWindows?: boolean }
  _isThirdLevelShift?(browser: unknown, ev: KeyboardEvent): boolean
}

/**
 * 给 xterm core 的 `_isThirdLevelShift` 包一层,返回是否装上。
 * `false` = 这台 xterm 没有那个接缝(行为退化成现状,不会出错)。
 */
export function installWindowsCtrlAltChordRepair(term: Terminal): boolean {
  const core = (term as unknown as { _core?: ThirdLevelShiftCore })._core
  const original = core?._isThirdLevelShift
  if (!core || typeof original !== 'function') return false
  core._isThirdLevelShift = function (browser: unknown, ev: KeyboardEvent): boolean {
    const isWindows = (browser as { isWindows?: boolean } | undefined)?.isWindows === true
    if (isWindows && isGenuineCtrlAltChord(chordOf(ev))) return false
    return original.call(this, browser, ev)
  }
  return true
}

/** 从 DOM 事件里取判据需要的字段(`getModifierState` 独立成函数,便于在非浏览器环境传假事件) */
function chordOf(ev: KeyboardEvent): CtrlAltChordLike {
  return {
    type: ev.type,
    ctrlKey: ev.ctrlKey,
    altKey: ev.altKey,
    metaKey: ev.metaKey,
    isComposing: ev.isComposing,
    altGraph: typeof ev.getModifierState === 'function' ? ev.getModifierState('AltGraph') : false
  }
}
