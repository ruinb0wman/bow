/**
 * 「临时借用调试器」的唯一实现。
 *
 * 为什么值得单独一个文件:这条不变式现在有三个使用方(整页截图、取无障碍树、按 ref 操作节点),
 * 而它有个**容易写错且错了很隐蔽**的细节 —— **只 detach 自己附加的**。
 * bow 的「接管网站文件选择框」会按用户开关长期挂着某个标签的调试器;那时 `isAttached()` 为真,
 * 我们借用后如果无条件 detach,就会把别人的会话摘掉(表现为「接管突然失灵」)。
 * 同一个不变式写三遍必然漂移,所以只留这一份。
 *
 * 另一条:**不去抢**。调试器已被 DevTools 占着时 attach 会抛
 * `Debugger is already attached to the target` —— 这时如实返回失败,由调用方给出可读文案
 * (通常还要告诉用户「关掉 DevTools,或用不带调试器的那条路」)。
 */

import type { WebContents } from 'electron'
import { logError } from './logger'

export type SendCommand = (method: string, params?: Record<string, unknown>) => Promise<any>

export type WithDebuggerResult<T> =
  /** 附加失败:多半是 DevTools 占着(调用方可据此给出「关掉 DevTools」的文案) */
  | { ok: false; busy: true; detail: string }
  /** 附加成功但里面的工作失败 */
  | { ok: false; busy: false; error: unknown }
  | { ok: true; value: T }

/** attach 失败的报错里含这句,是「已被别人占着」的确切标识(真机实测) */
export const DEBUGGER_BUSY_HINT = 'already attached'

export async function withDebugger<T>(
  wc: WebContents,
  fn: (send: SendCommand) => Promise<T>
): Promise<WithDebuggerResult<T>> {
  const dbg = wc.debugger
  if (!dbg) return { ok: false, busy: true, detail: '当前环境拿不到调试器' }

  let attachedByUs = false
  if (!dbg.isAttached()) {
    try {
      dbg.attach('1.3')
      attachedByUs = true
    } catch (e) {
      return { ok: false, busy: true, detail: String((e as Error)?.message ?? e) }
    }
  }

  try {
    const value = await fn((method, params) => dbg.sendCommand(method, params as never))
    return { ok: true, value }
  } catch (e) {
    return { ok: false, busy: false, error: e }
  } finally {
    if (attachedByUs) {
      try {
        dbg.detach()
      } catch (e) {
        logError('调试器 detach 失败', e)
      }
    }
  }
}
