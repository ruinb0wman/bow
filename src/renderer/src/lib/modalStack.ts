/**
 * 弹层栈(底部 → 顶部):供 ModalShell 判断 Esc 是否应作用于自己,
 * 从而支持「面板内嵌套弹窗」——只有最上层弹窗响应 Esc。
 *
 * 必须是模块级状态:<script setup> 的顶层代码每个实例都会执行一次。
 */
export const MODAL_STACK: symbol[] = []

/** 是否为栈顶弹层(Esc 只应由栈顶响应) */
export function isTopmost(stack: symbol[], self: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === self
}
