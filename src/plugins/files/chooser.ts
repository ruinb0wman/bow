/**
 * 「接管网站的文件选择框」的决策层(插件侧)。
 *
 * 分工:核心(`main/pageUpload.ts` 的 `fileChooser`)持有调试器、下发 `Page.setInterceptFileChooserDialog`、
 * 把 `Page.fileChooserOpened` 事件送回来;这里只做**决策** ——
 *   挂不挂(设置开关 + 页面里有没有 file input)、挂哪个标签页、攒着的这次选择由谁应答、什么时候清理。
 * 与 `service.agent.report` / `service.mcpHttp` 同一个分层原则:资源在核心,插件只做决策。
 *
 * 三条状态纪律:
 * 1. **挂过的标签页要记账**(`armed`):关掉开关 / 标签页关闭时必须能全部收回,否则调试器会一直挂着;
 * 2. **一次只攒一个待应答请求**:同一个标签页连点两下上传按钮,后来者覆盖前者(前者的原生框本来就被抑制了,
 *    用户其实只看到最后一个);
 * 3. **超时就当没发生**:没人应答时(用户关了面板、AI 也没管)就让这次点击自然失效 ——
 *    这跟用户在原生对话框上按 Esc 是同一种结果,不会留下半截状态。
 */

import type { PluginPageApi } from '../../main/plugins/types'
import type { FileChooserOpenedInfo } from '../../main/pageUpload'

/** 攒着的那次文件选择请求 */
export interface PendingChooser {
  tabId: number
  backendNodeId: number
  mode: 'selectSingle' | 'selectMultiple'
  /** 单选(false)的框只能给一个文件 —— 由 Chromium 给的 mode 推出来 */
  multiple: boolean
  at: number
}

/** 面板要的接管状态(一次调用拿全,免得多轮往返) */
export interface ChooserStatus {
  enabled: boolean
  armedTabs: number[]
  pending: PendingChooser | null
}

export interface ChooserDeps {
  pages: PluginPageApi
  /** 页面里有没有 file input(注入 `HAS_FILE_INPUT_FN`) */
  probe(tabId: number): Promise<boolean>
  /** 校验并归一待上传的路径(过白名单)→ 绝对路径 */
  guardFiles(paths: unknown[]): Promise<{ ok: true; abs: string[] } | { ok: false; error: string }>
  /** 请工具栏按钮把面板打开(主进程不能直接开浮层) */
  openPanel(payload: { mode: 'pick-upload'; tabId: number; multiple: boolean }): void
  /** 这次选择结束了(应答完 / 取消 / 过期):让所有窗口收起「选文件」模式 */
  notifyResolved(tabId: number): void
  log(...args: unknown[]): void
  now?(): number
  /** 待应答请求的存活时间,默认 45s */
  ttlMs?: number
}

export interface ChooserController {
  status(): ChooserStatus
  /** 开关变了:关掉时把已挂的全部收回 */
  setEnabled(on: boolean): void
  /** 在某标签页里重新评估(导航完成 / 手动挂之后都走它) */
  evaluate(tabId: number): Promise<void>
  onClosed(tabId: number): void
  /** 手动接管(页面里的 file input 是点了按钮才创建的那种,探测不到) */
  armNow(tabId: number): Promise<{ ok: boolean; error?: string }>
  disarm(tabId: number): void
  /** 「这次调用该应答哪个请求」:给了 tabId 就找它那个,没给则只在全局唯一时才认 */
  pendingFor(tabId?: number): PendingChooser | null
  /** 应答;没有任何待处理请求时返回 null(调用方走「直接塞文件」那条路) */
  answer(
    paths: unknown[],
    tabId?: number
  ): Promise<{ ok: boolean; error?: string; input?: PendingChooser & { files?: unknown } } | null>
  cancel(): void
}

const DEFAULT_TTL_MS = 45_000

export function createChooserController(deps: ChooserDeps): ChooserController {
  /** 我们挂过接管的标签页(核心侧另有真正的会话表,这里是为了「全部收回」与 UI) */
  const armed = new Set<number>()
  let enabled = false
  let pending: PendingChooser | null = null
  const now = (): number => deps.now?.() ?? Date.now()
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS

  function dropPending(reason: string, tabId?: number): boolean {
    if (!pending) return false
    if (tabId !== undefined && pending.tabId !== tabId) return false
    const gone = pending
    pending = null
    deps.log('放弃这次文件选择', reason, 'tab=' + gone.tabId)
    deps.notifyResolved(gone.tabId)
    return true
  }

  /** 过期的请求按「没发生」处理(lazy:每次读状态时顺手清) */
  function expireIfStale(): void {
    if (pending && now() - pending.at > ttlMs) dropPending('超时')
  }

  const controller: ChooserController = {
    status(): ChooserStatus {
      expireIfStale()
      return { enabled, armedTabs: [...armed], pending }
    },

    setEnabled(on: boolean): void {
      enabled = on
      if (!on) {
        for (const tabId of [...armed]) controller.disarm(tabId)
        dropPending('开关被关掉')
      }
    },

    async evaluate(tabId: number): Promise<void> {
      if (!enabled) return
      const has = await deps.probe(tabId)
      if (has) {
        if (armed.has(tabId)) return
        const result = await deps.pages.fileChooser.arm(tabId, {
          onOpened: (info: FileChooserOpenedInfo) => {
            pending = {
              tabId,
              backendNodeId: info.backendNodeId,
              mode: info.mode,
              multiple: info.mode === 'selectMultiple',
              at: now()
            }
            deps.log('页面请求选文件,交给面板', 'tab=' + tabId, info.mode)
            deps.openPanel({ mode: 'pick-upload', tabId, multiple: pending.multiple })
          },
          onLost: (reason: string) => {
            // DevTools 抢走调试器 / 标签被关:收干净,不自动重挂
            armed.delete(tabId)
            dropPending('接管被终止:' + reason, tabId)
            deps.log('接管被终止', 'tab=' + tabId, reason)
          }
        })
        if (result.ok) armed.add(tabId)
        else deps.log('挂接管失败', 'tab=' + tabId, result.error)
        return
      }
      // 页面里没有 file input 了:把之前挂的收回来(否则调试器一直占着)
      if (armed.has(tabId)) controller.disarm(tabId)
    },

    onClosed(tabId: number): void {
      armed.delete(tabId)
      dropPending('标签页关闭', tabId)
    },

    async armNow(tabId: number) {
      // 注:**不**翻 `enabled` —— 手动接管只针对这一个标签页(设置开关管的是「自动挂」)
      const result = await deps.pages.fileChooser.arm(tabId, {
        onOpened: (info) => {
          pending = {
            tabId,
            backendNodeId: info.backendNodeId,
            mode: info.mode,
            multiple: info.mode === 'selectMultiple',
            at: now()
          }
          deps.openPanel({ mode: 'pick-upload', tabId, multiple: pending.multiple })
        },
        onLost: (reason) => {
          armed.delete(tabId)
          dropPending('接管被终止:' + reason, tabId)
        }
      })
      if (result.ok) armed.add(tabId)
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    },

    disarm(tabId: number): void {
      if (!armed.delete(tabId)) return
      deps.pages.fileChooser.disarm(tabId)
      dropPending('接管被取消', tabId)
    },

    pendingFor(tabId?: number): PendingChooser | null {
      expireIfStale()
      if (!pending) return null
      if (tabId !== undefined) return pending.tabId === tabId ? pending : null
      // 没给 tabId:全局只剩一个时才敢认(插件拿不到「MCP 专属窗口」,不做更多猜测)
      return pending
    },

    async answer(paths: unknown[], tabId?: number) {
      const target = controller.pendingFor(tabId)
      if (!target) return null
      const guarded = await deps.guardFiles(paths)
      if (!guarded.ok) return { ok: false, error: guarded.error }
      const result = await deps.pages.fileChooser.answer(target.tabId, {
        backendNodeId: target.backendNodeId,
        files: guarded.abs
      })
      if (!result.ok) {
        // **失败时留着这次请求**:选择框还处于被接管状态,用户可以重试;
        // 真的没得救了(onLost)那条路已经把 pending 清掉了
        return { ok: false, error: result.error }
      }
      pending = null
      deps.notifyResolved(target.tabId)
      return { ok: true, input: { ...target } }
    },

    cancel(): void {
      dropPending('用户取消')
    }
  }

  return controller
}
