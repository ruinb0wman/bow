/**
 * 取 a11y 树并渲染成文本快照(AX 通道的 CDP 驱动层)。
 *
 * 分工:`axTree.ts` 是纯变换(可单测),这里负责 CDP —— 调试器 attach/detach、
 * 逐 frame 取树、把 ref 解析回真实节点。真机实测过的关键事实(别再重新猜):
 * - `wc.debugger.attach('1.3')` + `sendCommand('Accessibility.getFullAXTree')` 在 Electron 可用(137 节点 / 8ms);
 * - **a11y 树不含 iframe 内容**,要 `Page.getFrameTree` 遍历后对每个 `frameId` 单独取;
 * - 调试器被 DevTools 占着时,第二次 attach 抛 **`Debugger is already attached to the target`**;
 * - `DOM.getBoxModel({backendNodeId})` / `DOM.resolveNode({backendNodeId})` 能用节点句柄反解回真实节点。
 *
 * ref 的语义**刻意做成会失效**:页面一变就解析不到,此时必须报错让人重新快照,
 * 绝不能回落到「按老路径再找一次」—— 那正是老 `:nth-of-type` 选择器静默打偏的成因。
 */

import type { WebContents } from 'electron'
import { renderAxTree, type AxRef, type AxNode } from './axTree'
import { DEBUGGER_BUSY_HINT, withDebugger, type SendCommand } from './debuggerSession'
import { logError } from './logger'

/** 一次快照建立的 ref 表(供后续 browser_click / browser_type 解析) */
interface AxSession {
  url: string
  /** 主框架的 loaderId:文档每次加载都会换,用来判断「这份 ref 表还算不算数」 */
  loaderId?: string
  refs: Map<string, AxRef>
  at: number
}

const sessions = new Map<number, AxSession>()

/** 单标签最多取多少个 frame 的树:iframes 极多的页面不值得为此把快照拖慢 */
const MAX_FRAMES = 10

export interface AxSnapshotData {
  url: string
  title: string
  /** 文本树(每行一个元素,缩进表达层级) */
  tree: string
  /** 本快照里可寻址的元素数(= ref 数) */
  elements: number
  truncated: boolean
  /** 实际取到树的 frame 数(>1 说明页面里有 iframe 内容被缝进来了) */
  frames: number
  /** 本次是收窄到哪棵子树 */
  target?: string
}

export type AxSnapshotResult = { ok: true; data: AxSnapshotData } | { ok: false; error: string }

/** 调试器 attach 失败(最常见的原因是用户开着 DevTools)时的统一文案 */
function attachFailedMessage(detail: string): string {
  return (
    '取无障碍树需要临时附加调试器,附加失败' +
    (detail.includes(DEBUGGER_BUSY_HINT)
      ? '(该标签的 DevTools 占着调试器 —— 关掉 DevTools 后重试)'
      : `:${detail}`) +
    '。也可以改用 format: "dom" 拿旧的元素清单。'
  )
}

interface FrameRef {
  id: string
  url: string
}

function collectFrames(tree: { frame?: FrameRef; childFrames?: unknown[] }): FrameRef[] {
  const out: FrameRef[] = []
  const walk = (node: { frame?: FrameRef; childFrames?: unknown[] }): void => {
    if (node.frame) out.push(node.frame)
    for (const child of (node.childFrames ?? []) as Array<{ frame?: FrameRef; childFrames?: unknown[] }>) walk(child)
  }
  walk(tree)
  return out
}

/** 把 ref 或 CSS 选择器解析成 backendNodeId(选择器那条要问 DOM 域) */
async function targetBackendId(
  send: (m: string, p?: Record<string, unknown>) => Promise<any>,
  tabId: number,
  target: string
): Promise<{ backendNodeId: number } | { error: string }> {
  if (/^e\d+$/.test(target)) {
    const session = sessions.get(tabId)
    const hit = session?.refs.get(target)
    if (!hit) {
      return { error: `快照里没有 ${target}(可能取过新快照,或 tabId 换了)。重新调 browser_snapshot。` }
    }
    return { backendNodeId: hit.backendDOMNodeId }
  }
  try {
    const doc = await send('DOM.getDocument', { depth: 0 })
    const found = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: target })
    if (!found?.nodeId) return { error: `页面里找不到选择器: ${target}` }
    const described = await send('DOM.describeNode', { nodeId: found.nodeId })
    const backendNodeId = described?.node?.backendNodeId
    if (backendNodeId == null) return { error: `选择器 ${target} 命中的节点没有可用句柄` }
    return { backendNodeId }
  } catch (e) {
    return { error: `选择器无法解析(${target}):${String((e as Error)?.message ?? e)}` }
  }
}

export interface AxSnapshotOptions {
  maxElements?: number
  /** 只渲染这棵子树:ref(e12)或 CSS 选择器 */
  target?: string
}

/**
 * 取当前标签的 a11y 树并渲染。
 *
 * 调试器的生命周期交给 `debuggerSession.withDebugger`(它只 detach 自己附加的那次 ——
 * bow 的「接管文件选择框」会长期挂着同一个标签的调试器,不能把它摘掉)。
 */
export async function captureAxSnapshot(
  wc: WebContents,
  tabId: number,
  opts: AxSnapshotOptions = {}
): Promise<AxSnapshotResult> {
  const res = await withDebugger(wc, async (send): Promise<AxSnapshotResult> => {
    // 域按需开:Accessibility 取树、DOM 解析选择器/句柄。Page 只为 getFrameTree。
    await send('Accessibility.enable')
    await send('DOM.enable')
    await send('Page.enable')

    let target: { backendNodeId: number } | undefined
    if (opts.target) {
      const resolved = await targetBackendId(send, tabId, opts.target)
      if ('error' in resolved) return { ok: false, error: resolved.error }
      target = resolved
    }

    const frameTree = await send('Page.getFrameTree')
    const frames = collectFrames(frameTree.frameTree).slice(0, MAX_FRAMES)
    const loaderId: string | undefined = frameTree?.frameTree?.frame?.loaderId

    const nodes: AxNode[] = []
    const frameOf = new Map<string, string>()
    let framesRead = 0
    for (const frame of frames) {
      try {
        const frameAx = await send('Accessibility.getFullAXTree', { frameId: frame.id })
        const list = (frameAx?.nodes ?? []) as AxNode[]
        if (!list.length) continue
        framesRead++
        for (const node of list) {
          nodes.push(node)
          frameOf.set(node.nodeId, frame.id)
        }
      } catch (e) {
        // 跨源 iframe(OOPIF)不在本 target 的树里:跳过并继续,不要让整次快照失败
        logError('取 frame 的无障碍树失败', frame.url, e)
      }
    }
    if (!nodes.length) return { ok: false, error: '这一页没有可用的无障碍树(页面可能还在加载)' }

    // target 收窄:在已取到的树里按 backendNodeId 找那个节点
    let rootNodeId: string | undefined
    if (target) {
      rootNodeId = nodes.find((n) => n.backendDOMNodeId === target.backendNodeId)?.nodeId
      if (!rootNodeId) {
        return {
          ok: false,
          error: `快照里没有 ${opts.target} 对应的节点(页面可能已变化,或它是个不可见容器)。重新调 browser_snapshot。`
        }
      }
    }

    const rendered = renderAxTree(nodes, { maxElements: opts.maxElements, rootNodeId })

    const refs = new Map<string, AxRef>()
    for (const ref of rendered.refs) refs.set(ref.ref, { ...ref, frameId: frameOf.get(ref.nodeId) })
    const url = wc.getURL()
    sessions.set(tabId, { url, loaderId, refs, at: Date.now() })

    return {
      ok: true,
      data: {
        url,
        title: wc.getTitle(),
        tree: rendered.text,
        elements: rendered.refs.length,
        truncated: rendered.truncated,
        frames: framesRead,
        ...(opts.target ? { target: opts.target } : {})
      }
    }
  })

  if (res.ok) return res.value
  if (res.busy) return { ok: false, error: attachFailedMessage(res.detail) }
  logError('取无障碍树失败', res.error)
  return { ok: false, error: `取无障碍树失败:${String((res.error as Error)?.message ?? res.error)}` }
}

export type OnRefResult = { ok: true; value: unknown } | { ok: false; error: string }

/** 内部信号:文档换了 / 节点没了。都直接映射成可读文案,不做任何兜底 */
const DOC_CHANGED = 'AX_DOC_CHANGED'
const NODE_GONE = 'AX_NODE_GONE'

/**
 * 在某个 ref 指向的**真实节点**上执行一段函数。
 *
 * 三道保险,全部为了「宁可不做,不能做错」:
 * 1. **地址变了 → 整表作废**(最便宜的早期判断);
 * 2. **文档身份变了 → 整表作废**。只比地址是不够的:原地重新加载(url 根本没变)
 *    或 SPA 重建文档时,`backendNodeId` 可能落到**另一个元素**上 —— 那就是老选择器静默打偏的翻版。
 *    所以快照时记下主框架的 `loaderId`,执行前再读一次;
 * 3. **解析不到就直接失败**,绝不回落到用旧路径再找一次。
 */
export async function runOnAxRef(
  wc: WebContents,
  tabId: number,
  ref: string,
  run: (objectId: string, send: SendCommand) => Promise<Record<string, unknown>>
): Promise<OnRefResult> {
  const session = sessions.get(tabId)
  if (!session) {
    return { ok: false, error: `这个标签还没有快照,拿不到 ${ref}。先调 browser_snapshot。` }
  }
  if (wc.getURL() !== session.url) {
    sessions.delete(tabId)
    return {
      ok: false,
      error: `页面已经从 ${session.url} 变到 ${wc.getURL()},${ref} 所在的快照已失效。重新调 browser_snapshot。`
    }
  }
  const hit = session.refs.get(ref)
  if (!hit) {
    return { ok: false, error: `快照里没有 ${ref}(页面重排会让旧 ref 失效)。重新调 browser_snapshot 拿新 ref。` }
  }

  const res = await withDebugger(wc, async (send) => {
    await send('Page.enable')
    await send('DOM.enable')
    await send('Runtime.enable')
    const tree = await send('Page.getFrameTree')
    const loaderId: string | undefined = tree?.frameTree?.frame?.loaderId
    if (session.loaderId && loaderId && loaderId !== session.loaderId) throw new Error(DOC_CHANGED)
    const resolved = await send('DOM.resolveNode', { backendNodeId: hit.backendDOMNodeId })
    const objectId = resolved?.object?.objectId as string | undefined
    if (!objectId) throw new Error(NODE_GONE)
    return await run(objectId, send)
  })

  if (res.ok) {
    const out = res.value
    // 注入函数把失败放在返回值里(与页面脚本同一约定),这里提升为顶层失败
    if (out && typeof out.error === 'string') return { ok: false, error: out.error }
    return { ok: true, value: out }
  }
  if (res.busy) {
    return {
      ok: false,
      error:
        '需要临时附加调试器,附加失败' +
        (res.detail.includes(DEBUGGER_BUSY_HINT)
          ? '(该标签的 DevTools 占着调试器 —— 关掉 DevTools 后重试,或改用 selector 定位)'
          : `:${res.detail}`)
    }
  }
  const message = String((res.error as Error)?.message ?? res.error)
  if (message === DOC_CHANGED) {
    sessions.delete(tabId)
    return { ok: false, error: `页面在这期间重新加载了,${ref} 已失效。重新调 browser_snapshot 拿新 ref。` }
  }
  if (message === NODE_GONE) {
    return { ok: false, error: `${ref} 指向的节点已经不在了(页面变了),重新调 browser_snapshot。` }
  }
  return { ok: false, error: `操作 ${ref} 失败:${message}` }
}

/** 标签关闭 / 导航时丢弃该标签的 ref 表(避免内存里留着无意义的句柄) */
export function forgetAxSession(tabId: number): void {
  sessions.delete(tabId)
}

/** 仅测试与诊断用:当前有哪些标签持有 ref 表 */
export function axSessionTabs(): number[] {
  return [...sessions.keys()]
}
