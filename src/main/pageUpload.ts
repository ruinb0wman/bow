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
