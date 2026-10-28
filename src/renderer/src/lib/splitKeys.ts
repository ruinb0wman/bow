/**
 * 设置页(`bow://settings`)自己的分屏键处理。
 *
 * 为什么是「页面自己处理」而不是主进程接管:设置页里有主密码 / 首页 / 各插件设置等一堆输入框,
 * 主进程**无法同步得知当前焦点是不是可编辑元素**,一刀切接管会把 `Ctrl+Shift+←/→` 的「按词选择」
 * 从所有输入框手里拿走。所以主进程的 `shouldTakeSplitHotkey()` 继续对设置页放行,
 * 按键照常送到页面,由这里自己判断。
 *
 * 判据复用主进程那一套 `matchSplitHotkey()`,于是「分屏忽略自动重复、resize 允许自动重复、
 * 输入法组合中不接管」这些语义与主进程逐条一致,不会出现「设置页里长按方向键开出一屏窗格」。
 */

import { matchSplitHotkey, type KeyInputLike, type SplitHotkey } from '@shared/shortcuts'

/**
 * 焦点是否落在可编辑元素上(是则**不接管**,把按键留给「按词选择」/ 下拉原生行为)。
 * 与 `src/main/pageScripts.ts` 的 `isEditable` 同一套判据(那里给页面操作执行器用)。
 */
export function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as (HTMLElement & { tagName?: unknown }) | null
  if (!node || typeof node.tagName !== 'string') return false
  if (node.isContentEditable) return true
  const tag = node.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

/** DOM 的 `KeyboardEvent` → 共享层的 `KeyInputLike`(字段一一对应,`repeat`/`isComposing` 换了名字) */
export function keyInputFromEvent(e: KeyboardEvent): KeyInputLike {
  return {
    type: 'keyDown',
    key: e.key,
    code: e.code,
    control: e.ctrlKey,
    meta: e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
    isAutoRepeat: e.repeat,
    isComposing: e.isComposing
  }
}

/** 一次键盘事件是否该分屏 / 调大小(不接管时返回 null) */
export function splitHotkeyFromEvent(e: KeyboardEvent): SplitHotkey | null {
  return matchSplitHotkey(keyInputFromEvent(e))
}
