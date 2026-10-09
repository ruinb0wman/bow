/**
 * 在**本地标签页**上跑一小段 CDP:把本地文件塞进网页的 `<input type=file>`。
 *
 * 为什么必须是核心而不是插件:插件拿不到 `webContents`(ARCHITECTURE §13 第 36 条),
 * 而 `DOM.setFileInputFiles` 只能通过 `wc.debugger` 发出去。所以核心出「窄能力」,
 * 文件管理插件只负责挑文件(过它自己的白名单)与决定往哪个标签页塞。
 *
 * 两条硬事实(都出自 `electron.d.ts` 的 Debugger 注释,踩过就知道疼):
 * 1. `attach()` 在 DevTools 已经占着这个 webContents 时**会抛错** —— 我们不抢,直接把原因报给调用方;
 * 2. DevTools 被唤起会**终止**我们的会话(`detach` 事件),所以「常挂调试器做接管」会静默失效,
 *    接管那条路(见 `fileChooser`)必须监听 `detach` 并把状态收干净。
 *
 * 与 `actions.ts` 的整页截图同源:自己是临时挂的就用完 detach,别人挂着的就复用(不动它)。
 */

import type { WebContents } from 'electron'

/** 一个文件输入框的现状(读回来的是页面**真的**看到了什么,不是我们塞了什么) */
export interface FileInputState {
  multiple: boolean
  accept: string
  files: Array<{ name: string; size: number; type: string }>
}

/** 页面里存在多个 `<input type=file>` 且调用方没给 selector 时,把这些候选报回去 */
export interface FileInputCandidate {
  index: number
  /** 有 id 才会给(否则没有可靠选择器 —— 让调用方用 browser_snapshot 拿) */
  id?: string
  name?: string
  accept?: string
  multiple: boolean
  disabled: boolean
}

export interface PageUploadResult {
  ok: boolean
  input?: FileInputState
  candidates?: FileInputCandidate[]
  error?: string
  /** 失败原因是「调试器被别人占着(DevTools 开着)」——与「页面里没有文件框」要分清 */
  debuggerBusy?: boolean
}

/** 文件输入框的兜底选择器 */
const FILE_INPUT_SELECTOR = 'input[type=file]'
const MAX_CANDIDATES = 10

interface DebuggerLease {
  ok: boolean
  dbg: WebContents['debugger'] | null
  error?: string
  busy?: boolean
  release: () => void
}

/**
 * 借标签页的调试器。**别人已经挂着的就复用、绝不 detach**(它可能是 DevTools 或整页截图自己挂的)。
 */
export function leaseDebugger(wc: WebContents): DebuggerLease {
  const dbg = wc.debugger
  if (!dbg) return { ok: false, dbg: null, error: '当前环境拿不到调试器', release: () => {} }
  if (dbg.isAttached()) return { ok: true, dbg, release: () => {} }
  try {
    dbg.attach('1.3')
  } catch (e) {
    return {
      ok: false,
      dbg: null,
      busy: true,
      error: `附加调试器失败(该标签是不是开着 DevTools?):${messageOf(e)}`,
      release: () => {}
    }
  }
  return {
    ok: true,
    dbg,
    release: () => {
      try {
        dbg.detach()
      } catch {
        // 已经断开了(DevTools 抢走 / 标签关了):不用管
      }
    }
  }
}

function messageOf(e: unknown): string {
  return String((e as Error)?.message ?? e)
}

/** 「不支持就算了」的命令(DOM.enable 之类):失败不影响主流程 */
async function bestEffort(dbg: WebContents['debugger'], method: string): Promise<void> {
  try {
    await dbg.sendCommand(method)
  } catch {
    // 老版本 / 域没开:忽略
  }
}

function attrOf(attributes: unknown, name: string): string | undefined {
  if (!Array.isArray(attributes)) return undefined
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    if (attributes[i] === name) return String(attributes[i + 1])
  }
  return undefined
}

/** 读回页面侧 `input.files` 的真实内容 —— 这才是「到底塞进去了没有」的判据 */
async function readInputState(dbg: WebContents['debugger'], selector: string): Promise<FileInputState | null> {
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el || el.tagName !== 'INPUT') return null
    return {
      multiple: !!el.multiple,
      accept: el.accept || '',
      files: [...(el.files || [])].map((f) => ({ name: String(f.name || ''), size: Number(f.size || 0), type: String(f.type || '') }))
    }
  })()`
  try {
    const res = await dbg.sendCommand('Runtime.evaluate', { expression, returnByValue: true })
    if (res?.exceptionDetails) return null
    const value = res?.result?.value
    return value && typeof value === 'object' ? (value as FileInputState) : null
  } catch {
    return null
  }
}

/** 把一个 CDP 节点描述成候选(不建树、不取名,只给能分辨身份的几个属性) */
function candidateOf(index: number, node: Record<string, unknown>): FileInputCandidate {
  const attrs = node?.attributes
  return {
    index,
    ...(attrOf(attrs, 'id') ? { id: attrOf(attrs, 'id') } : {}),
    ...(attrOf(attrs, 'name') ? { name: attrOf(attrs, 'name') } : {}),
    ...(attrOf(attrs, 'accept') ? { accept: attrOf(attrs, 'accept') } : {}),
    multiple: attrOf(attrs, 'multiple') !== undefined,
    disabled: attrOf(attrs, 'disabled') !== undefined
  }
}

interface ResolvedInput {
  nodeId: number
  selector: string
  multiple: boolean
  accept: string
}

/**
 * 找到要操作的那个输入框:
 * 1. 给了 `selector` → 就它;
 * 2. 没给 → 页面里**恰好一个** `input[type=file]` 才自动采用(多个就报候选,让调用方挑)。
 */
async function resolveInput(
  dbg: WebContents['debugger'],
  selector: string
): Promise<{ ok: true; input: ResolvedInput } | { ok: false; error: string; candidates?: FileInputCandidate[] }> {
  const doc = await dbg.sendCommand('DOM.getDocument', { depth: 1 })
  const rootId = Number(doc?.root?.nodeId)
  if (!rootId) return { ok: false, error: '拿不到页面文档根节点' }

  if (selector) {
    let nodeId = 0
    try {
      const found = await dbg.sendCommand('DOM.querySelector', { nodeId: rootId, selector })
      nodeId = Number(found?.nodeId) || 0
    } catch (e) {
      return { ok: false, error: `选择器 ${selector} 在页面里无法匹配:${messageOf(e)}` }
    }
    if (!nodeId) return { ok: false, error: `页面上找不到选择器匹配的元素:${selector}` }
    const described = await dbg.sendCommand('DOM.describeNode', { nodeId, depth: 0 })
    return {
      ok: true,
      input: {
        nodeId,
        selector,
        multiple: attrOf(described?.node?.attributes, 'multiple') !== undefined,
        accept: attrOf(described?.node?.attributes, 'accept') ?? ''
      }
    }
  }

  let nodeIds: number[] = []
  try {
    const all = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: rootId, selector: FILE_INPUT_SELECTOR })
    nodeIds = Array.isArray(all?.nodeIds) ? all.nodeIds.map((n: unknown) => Number(n) || 0).filter(Boolean) : []
  } catch (e) {
    return { ok: false, error: `页面上找不到 ${FILE_INPUT_SELECTOR}:${messageOf(e)}` }
  }
  if (nodeIds.length === 0) {
    return {
      ok: false,
      error: `页面上没有 ${FILE_INPUT_SELECTOR}:若上传框是点了按钮才出现的,先 browser_click 那个按钮再重试`
    }
  }
  if (nodeIds.length > 1) {
    const candidates: FileInputCandidate[] = []
    for (const [index, nodeId] of nodeIds.slice(0, MAX_CANDIDATES).entries()) {
      try {
        const described = await dbg.sendCommand('DOM.describeNode', { nodeId, depth: 0 })
        candidates.push(candidateOf(index, described?.node ?? {}))
      } catch {
        candidates.push({ index, multiple: false, disabled: false })
      }
    }
    return {
      ok: false,
      error: `页面上有 ${nodeIds.length} 个文件输入框,请用 browser_snapshot 拿到其中一个的选择器后传 selector`,
      candidates
    }
  }
  const nodeId = nodeIds[0] as number
  const described = await dbg.sendCommand('DOM.describeNode', { nodeId, depth: 0 })
  return {
    ok: true,
    input: {
      nodeId,
      selector: FILE_INPUT_SELECTOR,
      multiple: attrOf(described?.node?.attributes, 'multiple') !== undefined,
      accept: attrOf(described?.node?.attributes, 'accept') ?? ''
    }
  }
}

/**
 * 把 `files`(绝对路径)塞进页面里那个文件输入框。
 * **不弹任何对话框**,也不需要用户手势 —— 这正是 AI 需要的语义(人那条路见 `fileChooser`)。
 */
export async function uploadFilesToPage(
  wc: WebContents,
  opts: { files: string[]; selector?: string }
): Promise<PageUploadResult> {
  const files = (opts.files ?? []).filter((f) => typeof f === 'string' && f.trim() !== '')
  if (files.length === 0) return { ok: false, error: '没有要上传的文件' }
  if (wc.isDestroyed()) return { ok: false, error: '标签页已关闭' }

  const lease = leaseDebugger(wc)
  if (!lease.ok || !lease.dbg) {
    return { ok: false, error: lease.error ?? '拿不到调试器', ...(lease.busy ? { debuggerBusy: true } : {}) }
  }
  const dbg = lease.dbg
  try {
    await bestEffort(dbg, 'DOM.enable')
    const resolved = await resolveInput(dbg, (opts.selector ?? '').trim())
    if (!resolved.ok) {
      return { ok: false, error: resolved.error, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) }
    }
    const { nodeId, selector, multiple } = resolved.input
    if (!multiple && files.length > 1) {
      return {
        ok: false,
        error: `这个输入框不支持多选(multiple),只能传 1 个文件;传了 ${files.length} 个`
      }
    }
    await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files })
    const state = await readInputState(dbg, selector)
    if (!state) return { ok: false, error: '文件已经设置,但读不回输入框状态(页面可能把它移走了)' }
    if (state.files.length === 0) {
      return {
        ok: false,
        input: state,
        error: 'CDP 已下发但输入框里仍然是空的(页面可能在 change 里立刻清空了它)'
      }
    }
    return { ok: true, input: state }
  } catch (e) {
    return { ok: false, error: messageOf(e) }
  } finally {
    lease.release()
  }
}

// ---------- 接管网站的文件选择框(点击上传按钮时,不弹原生框,改由 bow 面板选文件) ----------

/**
 * `Page.fileChooserOpened` 的参数(`frameId` 只在能拿到时才带)。
 * `mode` 是 Chromium 给的两个值之一(单/多选),`backendNodeId` 是那个 file input 的节点 id。
 */
export interface FileChooserOpenedInfo {
  mode: 'selectSingle' | 'selectMultiple'
  backendNodeId: number
  frameId?: string
}

export interface FileChooserHooks {
  onOpened(info: FileChooserOpenedInfo): void
  /** 接管掉了(DevTools 抢走 / 标签被关):调用方必须把状态收干净 */
  onLost(reason: string): void
}

export type ArmResult = { ok: true; already: boolean } | { ok: false; error: string }

interface ArmedSession {
  dbg: WebContents['debugger']
  hooks: FileChooserHooks
  onMessage: (event: unknown, method: string, params: unknown) => void
  onDetach: (event: unknown, reason: string) => void
  release: () => void
}

/** 已接管的会话(按 webContents.id);`armed()` / `disarm()` / `answer()` 都查它 */
const ARMED = new Map<number, ArmedSession>()

/**
 * 接管某个标签页的文件选择框:`Page.setInterceptFileChooserDialog {enabled,cancel}` 会**抑制原生框**
 * 并把控制权交给协议层(事件 `Page.fileChooserOpened`)。调试器要**一直挂着**,所以:
 * - DevTools 被唤起会终止本会话(`detach`)→ 我们收状态并回调 `onLost`,**不偷偷重挂**(会和 DevTools 打架);
 * - 自己挂的才在 disarm 时 detach;别人(整页截图)挂着的复用。
 */
export async function armFileChooser(wc: WebContents, hooks: FileChooserHooks): Promise<ArmResult> {
  if (wc.isDestroyed()) return { ok: false, error: '标签页已关闭' }
  const existing = ARMED.get(wc.id)
  if (existing) {
    existing.hooks = hooks // 重新挂同一标签:只换回调,不重复下发
    return { ok: true, already: true }
  }

  const lease = leaseDebugger(wc)
  if (!lease.ok || !lease.dbg) return { ok: false, error: lease.error ?? '拿不到调试器' }
  const dbg = lease.dbg
  try {
    await bestEffort(dbg, 'Page.enable')
    await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true })
  } catch (e) {
    lease.release()
    return { ok: false, error: `开启文件选择器接管失败:${messageOf(e)}` }
  }

  const onMessage = (_event: unknown, method: string, params: unknown): void => {
    if (method !== 'Page.fileChooserOpened') return
    const raw = params as { mode?: unknown; backendNodeId?: unknown; frameId?: unknown } | null
    const backendNodeId = Number(raw?.backendNodeId) || 0
    if (!backendNodeId) return
    const info: FileChooserOpenedInfo = {
      mode: raw?.mode === 'selectMultiple' ? 'selectMultiple' : 'selectSingle',
      backendNodeId,
      ...(typeof raw?.frameId === 'string' ? { frameId: raw.frameId } : {})
    }
    try {
      ARMED.get(wc.id)?.hooks.onOpened(info)
    } catch (e) {
      // 回调抛错不能把 CDP 事件处理拖垮(而且这里是同步栈,抛出去没人接)
      console.error('[pageUpload] onOpened 回调抛错', e)
    }
  }
  const onDetach = (_event: unknown, reason: string): void => {
    const session = ARMED.get(wc.id)
    ARMED.delete(wc.id)
    try {
      session?.hooks.onLost(String(reason ?? 'unknown'))
    } catch {
      // 同上
    }
  }
  dbg.on('message', onMessage)
  dbg.on('detach', onDetach)
  // 标签被关时不保证还有 detach,自己兜一层,别把会话留在表里
  wc.once('destroyed', () => {
    ARMED.delete(wc.id)
  })

  ARMED.set(wc.id, { dbg, hooks, onMessage, onDetach, release: lease.release })
  return { ok: true, already: false }
}

/** 取消接管;返回它本来是不是接管着的 */
export function disarmFileChooser(wc: WebContents): boolean {
  const session = ARMED.get(wc.id)
  if (!session) return false
  ARMED.delete(wc.id)
  try {
    session.dbg.off('message', session.onMessage)
    session.dbg.off('detach', session.onDetach)
  } catch {
    // 已经断开:忽略
  }
  session.release()
  return true
}

export function isFileChooserArmed(wc: WebContents): boolean {
  return ARMED.has(wc.id)
}

/** 用 `backendNodeId` 读回那个输入框的现状(接管路径没有选择器可用) */
async function readInputStateByNode(
  dbg: WebContents['debugger'],
  backendNodeId: number
): Promise<FileInputState | null> {
  try {
    const resolved = await dbg.sendCommand('DOM.resolveNode', { backendNodeId })
    const objectId = resolved?.object?.objectId
    if (typeof objectId !== 'string' || !objectId) return null
    const called = await dbg.sendCommand('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        return {
          multiple: !!this.multiple,
          accept: this.accept || '',
          files: [...(this.files || [])].map((f) => ({ name: String(f.name || ''), size: Number(f.size || 0), type: String(f.type || '') }))
        }
      }`
    })
    if (called?.exceptionDetails) return null
    const value = called?.result?.value
    return value && typeof value === 'object' ? (value as FileInputState) : null
  } catch {
    return null
  }
}

/** 应答一次被接管的选择请求(把文件塞给当时被点的那个输入框) */
export async function answerFileChooser(
  wc: WebContents,
  opts: { backendNodeId: number; files: string[] }
): Promise<PageUploadResult> {
  const files = (opts.files ?? []).filter((f) => typeof f === 'string' && f.trim() !== '')
  if (files.length === 0) return { ok: false, error: '没有要上传的文件' }
  const backendNodeId = Number(opts.backendNodeId) || 0
  if (!backendNodeId) return { ok: false, error: '没有待应答的文件选择请求' }
  const session = ARMED.get(wc.id)
  if (!session) {
    return { ok: false, error: '这个标签页现在没有处于接管状态(可能开着 DevTools,或接管已被取消)' }
  }
  try {
    await bestEffort(session.dbg, 'DOM.enable')
    await session.dbg.sendCommand('DOM.setFileInputFiles', { backendNodeId, files })
    const state = await readInputStateByNode(session.dbg, backendNodeId)
    if (!state) return { ok: true } // 塞是塞进去了,只是读不回来(节点已从文档移除之类)
    if (state.files.length === 0) {
      return { ok: false, input: state, error: '文件已下发但输入框里仍然是空的(页面可能在 change 里立刻清空了它)' }
    }
    return { ok: true, input: state }
  } catch (e) {
    return { ok: false, error: messageOf(e) }
  }
}
