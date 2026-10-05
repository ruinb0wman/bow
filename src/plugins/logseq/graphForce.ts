/**
 * 关系图谱 → `force-graph` 的**纯逻辑胶水**(不 import force-graph、不碰 DOM,可在 vitest 的 node 环境直跑)。
 *
 * 为什么单独一层:力导向与渲染都交给库了,但有件事**只有调用方知道** ——
 * `force-graph`/`d3-force-3d` 把一个节点的位置(`x/y/vx/vy/fx/fy`)**就地写在传入的节点对象上**,
 * 对没有 `x/y` 的新对象一律按初始螺旋重新撒点。所以「过滤条件一变整张图重排」这个坑,
 * 只能靠**跨刷新复用同一批节点对象**来躲(见 `toForceGraph` 的 `cache`)。
 *
 * 另一半是「画到哪就能点到哪」:标签盒子的几何给 `nodeCanvasObject`(画)与
 * `nodePointerAreaPaint`(命中)共用一份,否则又会退回旧版「看得见名字框、点它却落空」的毛病。
 */
import type { GraphData } from './graph'

/** 传给 force-graph 的节点。字段是我们自己的(库只额外写 x/y/vx/vy/fx/fy/index)。 */
export interface ForceNode {
  id: string
  /** 显示名(`title::` 优先,否则文件名解码;日志是 `YYYY-MM-DD`)—— 绘制标签读的就是它 */
  title: string
  day: string | null
  degree: number
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number
  fy?: number
}

export interface ForceLink {
  source: string
  target: string
  weight: number
}

export interface ForceGraphData {
  nodes: ForceNode[]
  links: ForceLink[]
}

export interface LabelBox {
  x: number
  y: number
  w: number
  h: number
}

/** 标签字号(屏幕像素):绘制时除以 `globalScale` 保持大小恒定 */
export const LABEL_FONT_PX = 11
/** 标签盒子相对文字的留白(屏幕像素) */
const LABEL_PAD_X = 3
const LABEL_PAD_Y = 5
const LABEL_BOX_H = 16

/** 节点圆半径(**图坐标**,与缩放无关);度数越大越大 */
export function nodeRadius(degree: number): number {
  return 3 + Math.sqrt(Math.max(0, degree)) * 1.7
}

/**
 * 给 force-graph 的 `nodeVal`:`半径 = sqrt(nodeVal) * nodeRelSize`,所以取 `nodeRelSize = 1` 时
 * `nodeVal = 半径²` 就与 `nodeRadius` 完全同口径 —— 边上端点收缩 / `zoomToFit` 包围盒才和画出来的圆一致。
 */
export function nodeValue(node: Pick<ForceNode, 'degree'>): number {
  const r = nodeRadius(node.degree)
  return r * r
}

/**
 * `GraphData` → force-graph 数据。**按 id 复用 `cache` 里的节点对象**(新节点才建),
 * 于是过滤/切邻域/图谱刷新都不会把已收敛的位置丢掉。
 */
export function toForceGraph(data: GraphData, cache: Map<string, ForceNode>): ForceGraphData {
  const nodes = data.nodes.map((node) => {
    const cached = cache.get(node.id)
    if (cached) {
      // 数据刷新时标题/度数可能变,但对象引用必须保留(位置挂在它上面)
      cached.title = node.title
      cached.day = node.day
      cached.degree = node.degree
      return cached
    }
    const fresh: ForceNode = { id: node.id, title: node.title, day: node.day, degree: node.degree }
    cache.set(node.id, fresh)
    return fresh
  })
  // 边不带位置状态,每次重建新的即可 —— 顺带躲开 d3-force 把 link.source 就地改写成节点对象的副作用
  const ids = new Set(nodes.map((node) => node.id))
  const links = data.links
    .filter((link) => ids.has(link.source) && ids.has(link.target))
    .map((link) => ({ source: link.source, target: link.target, weight: link.weight }))
  return { nodes, links }
}

/**
 * 标签要不要画。与旧版同一取舍:悬停节点及其邻居必画;放大到一定倍数只给「有连接」的节点画,
 * 免得小图时糊成一团。
 */
export function shouldShowLabel(
  degree: number,
  opts: { focused: boolean; neighbor: boolean; globalScale: number }
): boolean {
  if (opts.focused || opts.neighbor) return true
  return opts.globalScale >= 1.8 && degree >= 2
}

/**
 * 标签盒子(图坐标)。`textWidth` 由调用方先量好(需要 canvas context,所以量这一步留在组件里),
 * 这里只做几何 —— 绘制与命中共用。
 */
export function labelBox(
  node: { x?: number; y?: number },
  radius: number,
  textWidth: number,
  globalScale: number
): LabelBox {
  const scale = Math.max(0.01, globalScale)
  const h = LABEL_BOX_H / scale
  return {
    x: (node.x ?? 0) + radius + LABEL_PAD_X / scale,
    y: (node.y ?? 0) - h / 2,
    w: textWidth + (LABEL_PAD_X * 2) / scale,
    h
  }
}

/** 标签/节点的字号(图坐标):除以缩放后屏幕上是恒定 `LABEL_FONT_PX` */
export function labelFont(globalScale: number): string {
  return `${LABEL_FONT_PX / Math.max(0.01, globalScale)}px system-ui, -apple-system, "Segoe UI", sans-serif`
}

/**
 * 给颜色加透明度(用于「悬停时把无关的节点/边压暗」)。只认 `#rgb` / `#rrggbb`;
 * 认不出来(命名色 / `rgb()` / CSS 变量没取到)就原样返回 —— 宁可不压暗也不要画出坏颜色。
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex)
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  const parts = short
    ? [short[1] + short[1], short[2] + short[2], short[3] + short[3]]
    : long
      ? [long[1], long[2], long[3]]
      : null
  if (!parts) return color
  const [r, g, b] = parts.map((p) => parseInt(p, 16))
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`
}
