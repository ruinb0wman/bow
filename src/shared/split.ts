/**
 * 分屏布局的纯逻辑:**二叉嵌套树** + 几何 + 可存盘的「布局形状」。
 *
 * 一个标签组 = 一棵 `LayoutNode` 树:叶子是一个标签(一个窗格),`split` 节点是一次分屏。
 * `Ctrl+Shift+方向` 在聚焦的那个叶子上**每次都嵌套一层**(新窗格吃掉被分窗格一半);
 * `Alt+Shift+方向` 从叶子向上找第一个「轴匹配且能朝该方向扩张」的祖先,改它的 `ratio`。
 *
 * 几何只有这一处实现(`computeLayout`):主进程算完把**窗格 rect** 与**分隔条 rect**一起回传渲染层,
 * 渲染层只画不重算(坐标是窗口内容坐标 = chrome 渲染层的 CSS px)。
 *
 * 「布局预设」只存**结构**(轴 + 比例),不存 tabId —— `shapeOf()` / `instantiateShape()` 负责转换,
 * 存盘与归一化见 `normalizeLayoutPresets()`。单测在 `tests/split.test.ts`。
 */

/** 分屏轴:`row` = 左右并排(a 左 b 右);`column` = 上下堆叠(a 上 b 下) */
export type SplitAxis = 'row' | 'column'

/** 方向键语义:`left/up` 时新窗格在 a 侧,`right/down` 时在 b 侧;调整大小时箭头 = 聚焦窗格要扩张的方向 */
export type PaneDir = 'left' | 'right' | 'up' | 'down'

export type LayoutNode =
  | { kind: 'leaf'; tabId: number }
  | { kind: 'split'; axis: SplitAxis; ratio: number; a: LayoutNode; b: LayoutNode }

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface PaneBox {
  tabId: number
  rect: Rect
}

/** `computeLayout` 的结果;`panes` 只含**可见**叶子(太窄的层级只留聚焦那一支) */
export interface LayoutGeometry {
  panes: PaneBox[]
  dividers: Rect[]
}

/** 每个分隔条的厚度(px);露出的底层是 chrome 页面背景,渲染层在这条缝上画分隔条 */
export const SPLIT_GAP = 4
/** 单窗格最小宽/高(px):某个 split 节点放不下两个最小窗格时,它只渲染聚焦那一支 */
export const MIN_PANE = 120
/** `ratio` 的夹紧范围(再大/再小都由 `MIN_PANE` 在几何层兜底) */
export const RATIO_MIN = 0.1
export const RATIO_MAX = 0.9
/** `Alt+Shift+方向` 每次调整的比例步长 */
export const SPLIT_RESIZE_STEP = 0.05
/** 一个标签组最多几个窗格(每个窗格都是一个真 WebContentsView) */
export const MAX_GROUP_PANES = 8
/** 保存的布局条数上限(防止 split-layouts.json 被写爆) */
export const MAX_LAYOUT_PRESETS = 20

export function leaf(tabId: number): LayoutNode {
  return { kind: 'leaf', tabId }
}

/** 方向 → 轴 */
export function axisOfDir(dir: PaneDir): SplitAxis {
  return dir === 'left' || dir === 'right' ? 'row' : 'column'
}

/** 该方向是否「朝 b 侧扩张」(right/down);否则朝 a 侧(left/up) */
export function isLeadingDir(dir: PaneDir): boolean {
  return dir === 'right' || dir === 'down'
}

export function clampRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0.5
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio))
}

/** 窗格(叶子)总数 */
export function paneCount(node: LayoutNode): number {
  return node.kind === 'leaf' ? 1 : paneCount(node.a) + paneCount(node.b)
}

/** 先序遍历的叶子 tabId 表 = 阅读顺序 = 标签栏里窗格图标顺序 = 分隔条从左到右/从上到下 */
export function paneTabIds(node: LayoutNode): number[] {
  const out: number[] = []
  const walk = (n: LayoutNode): void => {
    if (n.kind === 'leaf') out.push(n.tabId)
    else {
      walk(n.a)
      walk(n.b)
    }
  }
  walk(node)
  return out
}

export function hasPane(node: LayoutNode, tabId: number): boolean {
  return node.kind === 'leaf' ? node.tabId === tabId : hasPane(node.a, tabId) || hasPane(node.b, tabId)
}

/**
 * 把 `tabId` 那个叶子替换成一次分屏(新标签 `newTabId`):
 * ← / ↑ 新窗格在 a 侧,→ / ↓ 在 b 侧 —— **每次都嵌套一层**,不做同轴兄弟合并。
 * 树里没有 `tabId` 时原样返回(引用不变)。
 */
export function splitPane(root: LayoutNode, tabId: number, dir: PaneDir, newTabId: number): LayoutNode {
  const axis = axisOfDir(dir)
  const leading = isLeadingDir(dir)
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') {
      if (node.tabId !== tabId) return node
      const made: LayoutNode = leaf(newTabId)
      return leading
        ? { kind: 'split', axis, ratio: 0.5, a: node, b: made }
        : { kind: 'split', axis, ratio: 0.5, a: made, b: node }
    }
    const a = walk(node.a)
    if (a !== node.a) return { ...node, a }
    const b = walk(node.b)
    return b === node.b ? node : { ...node, b }
  }
  return walk(root)
}

/**
 * 把一个叶子**原地换成另一个标签 id**(树结构与几何都不变):终端「顶替当前聚焦窗格」靠它,
 * 比 split+remove 的往返更直接(那条路会先嵌一层再塌缩)。
 * 树里没有 `tabId` 时原样返回(引用不变);路径外的子树引用也保持不变。
 */
export function replacePane(root: LayoutNode, tabId: number, newTabId: number): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') return node.tabId === tabId ? leaf(newTabId) : node
    const a = walk(node.a)
    const b = walk(node.b)
    return a === node.a && b === node.b ? node : { ...node, a, b }
  }
  return walk(root)
}

/**
 * 摘掉一个叶子:容器只剩一个孩子时**塌缩**(用那个孩子顶替本节点);树空了返回 `root: null`。
 * `nextFocusTabId` = 阅读顺序里的**下一个**叶子,没有就上一个(关窗格后的焦点回落)。
 */
export function removePane(
  root: LayoutNode,
  tabId: number
): { root: LayoutNode | null; nextFocusTabId: number | null } {
  const order = paneTabIds(root)
  const i = order.indexOf(tabId)
  const nextFocusTabId = i < 0 ? null : order[i + 1] ?? order[i - 1] ?? null
  const drop = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === 'leaf') return node.tabId === tabId ? null : node
    const a = drop(node.a)
    if (a == null) return drop(node.b) // a 没了:b 顶替本节点(塌缩)
    const b = drop(node.b)
    if (b == null) return a
    return a === node.a && b === node.b ? node : { ...node, a, b }
  }
  return { root: drop(root), nextFocusTabId }
}

/**
 * 调整聚焦窗格的大小:从叶子**由内向外**找第一个「轴与箭头一致,且聚焦子树在可扩张侧」的祖先,改它的 `ratio`。
 *
 * - `→` / `↓`:聚焦子树在 a 侧时把 a 撑大(`ratio + step`);
 * - `←` / `↑`:聚焦子树在 b 侧时把 b 撑大(`ratio - step`);
 * - 聚焦窗格已经贴在该层边界上(子树在 b 而箭头朝 b、或在 a 而箭头朝 a)→ 继续向上找
 *   (它的边界就等于父容器里那一支的边界);
 * - 一路到顶都没有可扩张的祖先 → 整棵树原样返回(引用不变)。
 */
export function resizePane(
  root: LayoutNode,
  tabId: number,
  dir: PaneDir,
  step = SPLIT_RESIZE_STEP
): LayoutNode {
  const axis = axisOfDir(dir)
  const leading = isLeadingDir(dir)
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') return node
    const inA = hasPane(node.a, tabId)
    const inB = !inA && hasPane(node.b, tabId)
    if (!inA && !inB) return node
    // 先往下走:命中的是**最靠近叶子的**那一层,外层只有在里层动不了时才轮得到
    const child = inA ? walk(node.a) : walk(node.b)
    if (child !== (inA ? node.a : node.b)) {
      return inA ? { ...node, a: child } : { ...node, b: child }
    }
    if (node.axis !== axis) return node
    if (inA && leading) return { ...node, ratio: clampRatio(node.ratio + step) }
    if (inB && !leading) return { ...node, ratio: clampRatio(node.ratio - step) }
    return node
  }
  return walk(root)
}

export interface LayoutOptions {
  gap?: number
  minPane?: number
  /** 聚焦窗格:某个节点放不下两个最小窗格时,只渲染含它的那一支 */
  focusedTabId: number | null
}

/**
 * 把树铺进 `area`:每层沿自己的轴扣掉一个 `gap`,`ratio` 换成像素后再按 `minPane` 夹紧。
 * 某个节点放不下两个最小窗格时**只渲染聚焦那一支**(铺满本节点、本层不出分隔条)——
 * 树本身不拆,窗口变大后自动恢复(与旧 `computeSplitBounds` 返回 null 的退化同义)。
 */
export function computeLayout(root: LayoutNode, area: Rect, opts: LayoutOptions): LayoutGeometry {
  const gap = opts.gap ?? SPLIT_GAP
  const minPane = opts.minPane ?? MIN_PANE
  const focus = opts.focusedTabId
  const panes: PaneBox[] = []
  const dividers: Rect[] = []
  const walk = (node: LayoutNode, rect: Rect): void => {
    if (node.kind === 'leaf') {
      panes.push({ tabId: node.tabId, rect })
      return
    }
    const horizontal = node.axis === 'row'
    const extent = horizontal ? rect.width : rect.height
    const avail = extent - gap
    if (avail < minPane * 2) {
      const keep = focus != null && hasPane(node.b, focus) ? node.b : node.a
      walk(keep, rect)
      return
    }
    const sizeA = Math.min(Math.max(Math.round(avail * clampRatio(node.ratio)), minPane), avail - minPane)
    const sizeB = avail - sizeA
    if (horizontal) {
      // 分隔条在递归之前 push:顺序 = 先序序(由外向内、从左到右),便于断言与调试
      dividers.push({ x: rect.x + sizeA, y: rect.y, width: gap, height: rect.height })
      walk(node.a, { x: rect.x, y: rect.y, width: sizeA, height: rect.height })
      walk(node.b, { x: rect.x + sizeA + gap, y: rect.y, width: sizeB, height: rect.height })
    } else {
      dividers.push({ x: rect.x, y: rect.y + sizeA, width: rect.width, height: gap })
      walk(node.a, { x: rect.x, y: rect.y, width: rect.width, height: sizeA })
      walk(node.b, { x: rect.x, y: rect.y + sizeA + gap, width: rect.width, height: sizeB })
    }
  }
  walk(root, area)
  return { panes, dividers }
}

// ---------- 布局形状(存盘用:只存结构,不存 tabId) ----------

export type LayoutShape =
  | { kind: 'leaf' }
  | { kind: 'split'; axis: SplitAxis; ratio: number; a: LayoutShape; b: LayoutShape }

export interface LayoutPreset {
  id: string
  name: string
  shape: LayoutShape
}

/** 布局条数上限内的默认名,形如「布局 3」 */
export function nextLayoutName(presets: readonly LayoutPreset[]): string {
  let max = 0
  for (const p of presets) {
    const m = /^布局 (\d+)$/.exec(p.name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `布局 ${max + 1}`
}

/** 生成一个未被占用的布局 id(`l1`、`l2`…) */
export function nextLayoutPresetId(ids: readonly string[]): string {
  const taken = new Set(ids)
  for (let n = 1; n <= MAX_LAYOUT_PRESETS + 1; n += 1) {
    const id = `l${n}`
    if (!taken.has(id)) return id
  }
  return `l${ids.length + 1}_`
}

export function shapePaneCount(shape: LayoutShape): number {
  return shape.kind === 'leaf' ? 1 : shapePaneCount(shape.a) + shapePaneCount(shape.b)
}

/** 形状的可读摘要(面板列表的副标题),如「左右 2 · 上下 1」 */
export function shapeSummary(shape: LayoutShape): string {
  let rows = 0
  let columns = 0
  const walk = (s: LayoutShape): void => {
    if (s.kind === 'leaf') return
    if (s.axis === 'row') rows += 1
    else columns += 1
    walk(s.a)
    walk(s.b)
  }
  walk(shape)
  const parts: string[] = []
  if (rows > 0) parts.push(`左右 ${rows}`)
  if (columns > 0) parts.push(`上下 ${columns}`)
  return parts.join(' · ')
}

/** 树 → 形状(去掉 tabId) */
export function shapeOf(node: LayoutNode): LayoutShape {
  return node.kind === 'leaf'
    ? { kind: 'leaf' }
    : { kind: 'split', axis: node.axis, ratio: node.ratio, a: shapeOf(node.a), b: shapeOf(node.b) }
}

/**
 * 形状 → 树:`tabIds` 按**先序**发给叶子。
 * 数量对不上(文件被写坏 / 调用方算错窗格数)返回 `null`,不产出带 `undefined` 的树。
 */
export function instantiateShape(shape: LayoutShape, tabIds: readonly number[]): LayoutNode | null {
  if (shapePaneCount(shape) !== tabIds.length) return null
  let i = 0
  const build = (s: LayoutShape): LayoutNode => {
    if (s.kind === 'leaf') return leaf(tabIds[i++])
    return { kind: 'split', axis: s.axis, ratio: s.ratio, a: build(s.a), b: build(s.b) }
  }
  return build(shape)
}

/** 单个形状的归一化:非法轴/比例丢掉,深度与叶子数都夹在 `MAX_GROUP_PANES` 内,叶子数 <2 视为不可用 */
function normalizeShape(raw: unknown, depth = 0): LayoutShape | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  if (rec.kind === 'leaf') return { kind: 'leaf' }
  if (rec.kind !== 'split') return null
  if (depth + 1 > MAX_GROUP_PANES) return null
  const axis: SplitAxis | null = rec.axis === 'row' ? 'row' : rec.axis === 'column' ? 'column' : null
  if (!axis) return null
  const ratio = typeof rec.ratio === 'number' && Number.isFinite(rec.ratio) ? clampRatio(rec.ratio) : 0.5
  const a = normalizeShape(rec.a, depth + 1)
  const b = normalizeShape(rec.b, depth + 1)
  if (!a || !b) return null
  const shape: LayoutShape = { kind: 'split', axis, ratio, a, b }
  return shapePaneCount(shape) <= MAX_GROUP_PANES ? shape : null
}

/**
 * 把任意来源(split-layouts.json、旧版本数据、IPC)的预设列表归一化成可用列表:
 * 丢掉非对象 / 坏形状 / 叶子数 <2 的项,补 id 与默认名,去重 id,截断到 `MAX_LAYOUT_PRESETS`。
 * 返回的永远是**新数组 + 新对象**。
 */
export function normalizeLayoutPresets(raw: unknown): LayoutPreset[] {
  if (!Array.isArray(raw)) return []
  const out: LayoutPreset[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_LAYOUT_PRESETS) break
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const shape = normalizeShape(rec.shape)
    if (!shape || shapePaneCount(shape) < 2) continue
    const rawId = typeof rec.id === 'string' ? rec.id.trim().slice(0, 40) : ''
    let id = rawId || `l${out.length + 1}`
    while (seen.has(id)) id = `${id}_`
    seen.add(id)
    const rawName = typeof rec.name === 'string' ? rec.name.trim().slice(0, 24) : ''
    out.push({ id, name: rawName || `布局 ${out.length + 1}`, shape })
  }
  return out
}
