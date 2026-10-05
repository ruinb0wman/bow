<script setup lang="ts">
/**
 * 关系图谱浮层(`bow://logseq` 页内全屏层):把索引里的页面/日志画成力导向网络。
 *
 * 分工:
 * - **数据**由父组件经 IPC `graph` 取来(`GraphData`),这里只做「全图 / 本页邻域」子集与过滤;
 * - **布局 + 渲染 + 命中/交互**交给 `force-graph`(Canvas + d3-force)。这里只负责:
 *   按我们的主题/标签规则喂绘制回调、把节点点击转成 `open-page`、以及容器尺寸;
 * - 这里**绝不写盘**:点击节点只是 `emit('open-page')`,由父组件走正常的打开页面路径。
 *
 * 为什么不再自己画/自己测命中(2026-10-05 换库的原因):
 * - 旧版自写积分器从 `alpha = 1` 衰减,用户要盯着收敛抖几秒 → 现在 `warmupTicks` 在首帧前把布局跑完;
 * - 旧版 `LayoutNode` 漏拷 `title`,标签全画成 `undefined` → 现在直接用 `ForceNode.title`;
 * - 旧版命中区只有圆点周围一个隐形 halo、与圆点对不齐、点名字框落空 → 现在命中用库的
 *   shadow canvas(与绘制同源),并能通过 `nodePointerAreaPaint` 把标签框一起纳入。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Network, RotateCcw, Search, X } from 'lucide-vue-next'
import ForceGraph from 'force-graph'
import { localGraph, type GraphData, type GraphNode } from '@plugins/logseq/graph'
import {
  labelBox,
  labelFont,
  nodeRadius,
  nodeValue,
  shouldShowLabel,
  toForceGraph,
  withAlpha,
  type ForceLink,
  type ForceNode
} from '@plugins/logseq/graphForce'

const props = defineProps<{
  data: GraphData
  /** 当前编辑的文件相对路径(`journals/…` / `pages/…`);新页还没落盘时是 null */
  centerId: string | null
  centerTitle: string
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-page', node: GraphNode): void
}>()

const hostRef = ref<HTMLElement | null>(null)

const mode = ref<'global' | 'local'>('global')
const depth = ref(1)
const showJournals = ref(true)
const hideOrphans = ref(false)
const query = ref('')
const hoverId = ref<string | null>(null)

const colors = ref({ bg: '#1b1b1f', fg: '#e6e6e6', dim: '#8b8b93', accent: '#4c8bf5', border: '#33333a', journal: '#c9a24a' })

let graph: ForceGraph<ForceNode, ForceLink> | null = null
/** 跨刷新复用同一批节点对象 —— force-graph/d3-force 把位置写在对象上,换新对象=整图重排 */
const nodeCache = new Map<string, ForceNode>()
/** 第一次(以及「重新排布」)之后要把整张图装进视口;之后过滤/刷新都不抢用户的视角 */
let needsFit = true
/** 布局是否已经跑过至少一帧 tick —— 在那之前 `node.x/y` 还是 NaN */
let layoutReady = false

// ---------- 数据:全图 / 本页邻域 + 过滤 ----------

const source = computed<GraphData>(() =>
  mode.value === 'local' && props.centerId ? localGraph(props.data, props.centerId, depth.value) : props.data
)

const filtered = computed<GraphData>(() => {
  const q = query.value.trim().toLowerCase()
  const nodes = source.value.nodes.filter((node) => {
    if (!showJournals.value && node.day !== null) return false
    if (hideOrphans.value && node.degree === 0) return false
    if (q && !node.title.toLowerCase().includes(q)) return false
    return true
  })
  const ids = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    links: source.value.links.filter((link) => ids.has(link.source) && ids.has(link.target)),
    missingRefs: source.value.missingRefs,
    tooLarge: source.value.tooLarge
  }
})

const nodeById = computed(() => new Map(filtered.value.nodes.map((node) => [node.id, node])))

const emptyHint = computed<string | null>(() => {
  if (mode.value === 'local' && !props.centerId) return '当前页还没落盘,先写一个字;或切回「全图」。'
  if (filtered.value.nodes.length === 0) return '没有匹配的节点。'
  return null
})

const adjacency = computed(() => {
  const map = new Map<string, Set<string>>()
  for (const link of filtered.value.links) {
    const from = map.get(link.source)
    if (from) from.add(link.target)
    else map.set(link.source, new Set([link.target]))
    const to = map.get(link.target)
    if (to) to.add(link.source)
    else map.set(link.target, new Set([link.source]))
  }
  return map
})

// ---------- 主题 ----------

function readColors(): void {
  const css = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  colors.value = {
    bg: get('--bg', '#1b1b1f'),
    fg: get('--fg', '#e6e6e6'),
    dim: get('--fg-dim', '#8b8b93'),
    accent: get('--accent', '#4c8bf5'),
    border: get('--border', '#33333a'),
    journal: '#c9a24a'
  }
}

function nodeFill(node: ForceNode, focused: boolean): string {
  if (focused) return colors.value.fg
  return node.day ? colors.value.journal : colors.value.accent
}

/** 当前聚焦的节点(悬停优先)与它的邻居集合 */
function focus(): { id: string; neighbors: Set<string> | undefined } | null {
  const id = hoverId.value
  if (!id) return null
  return { id, neighbors: adjacency.value.get(id) }
}

// ---------- 绘制 / 命中(都交给 force-graph,这里只给回调) ----------

/** 与 `nodePointerAreaPaint` 共用:标签盒子的文字宽度 */
function measureLabel(ctx: CanvasRenderingContext2D, node: ForceNode, scale: number): number {
  ctx.font = labelFont(scale)
  return ctx.measureText(node.title).width
}

function paintNode(node: ForceNode, ctx: CanvasRenderingContext2D, scale: number): void {
  const at = focus()
  const isFocus = at?.id === node.id
  const isNeighbor = at?.neighbors?.has(node.id) ?? false
  if (at && !isFocus && !isNeighbor) ctx.globalAlpha = 0.15

  const radius = nodeRadius(node.degree)
  ctx.beginPath()
  ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, Math.PI * 2)
  ctx.fillStyle = nodeFill(node, isFocus)
  ctx.fill()
  if (isFocus) {
    ctx.lineWidth = 2 / scale
    ctx.strokeStyle = colors.value.fg
    ctx.stroke()
  }

  if (shouldShowLabel(node.degree, { focused: isFocus, neighbor: isNeighbor, globalScale: scale })) {
    const width = measureLabel(ctx, node, scale)
    const box = labelBox(node, radius, width, scale)
    ctx.globalAlpha = 0.9
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.fillRect(box.x, box.y, box.w, box.h)
    ctx.fillStyle = colors.value.fg
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(node.title, box.x + 3 / scale, node.y ?? 0)
  }
  ctx.globalAlpha = 1
}

/**
 * 命中区(库画在 shadow canvas 上做像素查色,所以这里画到哪就能点到哪)。
 * 圆点保证至少 ~9 屏幕像素;标签框用**和绘制完全同一份** `labelBox` —— 点名字也要能点中。
 */
function paintPointerArea(node: ForceNode, color: string, ctx: CanvasRenderingContext2D, scale: number): void {
  const radius = nodeRadius(node.degree)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(node.x ?? 0, node.y ?? 0, Math.max(radius, 9 / scale), 0, Math.PI * 2)
  ctx.fill()
  const width = measureLabel(ctx, node, scale)
  const box = labelBox(node, radius, width, scale)
  ctx.fillRect(box.x, box.y, box.w, box.h)
}

/** 画边时 `source`/`target` 已被 d3-force 就地改写成节点对象,不再是 id */
function endpointId(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'id' in value) return String((value as { id: unknown }).id)
  return ''
}

function linkPaint(link: ForceLink): { color: string; width: number } {
  const at = focus()
  const active = at !== null && (endpointId(link.source) === at.id || endpointId(link.target) === at.id)
  const alpha = at ? (active ? 0.85 : 0.12) : 0.5
  return {
    color: withAlpha(active ? colors.value.accent : colors.value.border, alpha),
    width: active ? 2 : 1 + Math.log2(Math.max(1, link.weight)) * 0.5
  }
}

// ---------- 建图 ----------

function createGraph(host: HTMLElement): ForceGraph<ForceNode, ForceLink> {
  return new ForceGraph<ForceNode, ForceLink>(host)
    .nodeId('id')
    .backgroundColor(colors.value.bg)
    .nodeLabel((node) => node.title)
    .nodeVal(nodeValue)
    .nodeRelSize(1)
    .nodeCanvasObjectMode(() => 'replace')
    .nodeCanvasObject(paintNode)
    .nodePointerAreaPaint(paintPointerArea)
    .linkColor((link) => linkPaint(link).color)
    .linkWidth((link) => linkPaint(link).width)
    .warmupTicks(200)
    .cooldownTicks(Infinity)
    .cooldownTime(8000)
    // 引擎冻结后仍然每帧重绘:本组件按 hoverId 压暗别的节点,靠库的 needsRedraw 是刷不出来的
    .autoPauseRedraw(false)
    .onNodeHover((node) => {
      hoverId.value = node?.id ?? null
    })
    .onEngineTick(() => {
      layoutReady = true
      applyFit()
    })
    .onNodeClick((node) => {
      const hit = nodeById.value.get(node.id)
      if (hit) emit('open-page', hit)
    })
}

function fitNow(): void {
  if (!graph || filtered.value.nodes.length === 0) return
  resize() // fit 要按当前容器尺寸算
  graph.zoomToFit(0, 40)
}

/**
 * 把整张图装进视口。**必须等 d3-force 把位置算出来之后**:
 * `force-graph`/`kapsule` 的布局(含 `warmupTicks`)跑在一个 debounce(1ms) 的 update 里,
 * 而 `onEngineTick` 才是「布局已经跑起来」的信号 —— 抢在它前面调 `zoomToFit`
 * 会拿还没有 `x/y` 的节点算出 NaN 的缩放/平移,之后整张图都画不出来
 * (实测:节点不可见、悬停与点击全部落空)。
 */
function applyFit(): void {
  if (!needsFit || !layoutReady) return
  needsFit = false
  fitNow()
}

function syncGraphData(): void {
  if (!graph) return
  graph.graphData(toForceGraph(filtered.value, nodeCache))
  applyFit()
}

function resize(): void {
  const el = hostRef.value
  if (!graph || !el) return
  graph.width(el.clientWidth).height(el.clientHeight)
}

function reflow(): void {
  if (!graph) return
  // 释放被拖拽钉住的节点,再重新加热一次模拟
  for (const node of nodeCache.values()) {
    node.fx = undefined
    node.fy = undefined
  }
  graph.d3ReheatSimulation()
  needsFit = true
  applyFit()
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key === '0' || event.key.toLowerCase() === 'f') {
    event.preventDefault()
    needsFit = true
    applyFit()
  }
}

// ---------- 生命周期 ----------

let observer: ResizeObserver | null = null

onMounted(() => {
  readColors()
  const host = hostRef.value
  if (!host) return
  graph = createGraph(host)
  resize()
  syncGraphData()
  window.addEventListener('keydown', onKeyDown, true)
  observer = new ResizeObserver(() => resize())
  observer.observe(host)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown, true)
  observer?.disconnect()
  observer = null
  // 必须停:force-graph 自带 rAF,不停会一直画(浮层每次开关都漏一个循环)
  graph?.pauseAnimation()
  graph = null
})

watch(
  () => [mode.value, depth.value, showJournals.value, hideOrphans.value, query.value, props.centerId, props.data] as const,
  () => syncGraphData()
)
</script>

<template>
  <div class="graph-overlay">
    <header class="graph-head">
      <Network :size="16" class="graph-icon" />
      <span class="graph-title">关系图谱</span>
      <span class="graph-counts">{{ filtered.nodes.length }} 节点 · {{ filtered.links.length }} 边</span>
      <span
        v-if="filtered.missingRefs > 0"
        class="graph-chip"
        :title="`${filtered.missingRefs} 个页面被引用但还没创建(不建节点)`"
      >
        未创建 {{ filtered.missingRefs }}
      </span>
      <span v-if="filtered.tooLarge" class="graph-chip warn">索引不完整,图谱可能不全</span>
      <span class="graph-spacer"></span>
      <button class="graph-btn" title="重新排布(释放拖拽钉住的节点)" @click="reflow">
        <RotateCcw :size="14" />
      </button>
      <button class="graph-btn" title="关闭(Esc)" @click="emit('close')">
        <X :size="16" />
      </button>
    </header>

    <div class="graph-controls">
      <div class="graph-seg">
        <button :class="{ on: mode === 'global' }" @click="mode = 'global'">全图</button>
        <button
          :class="{ on: mode === 'local' }"
          :disabled="!centerId"
          :title="centerId ? `只看「${centerTitle}」的邻居` : '当前页还没落盘'"
          @click="mode = 'local'"
        >
          本页邻域
        </button>
      </div>
      <select v-if="mode === 'local'" v-model.number="depth" class="graph-select">
        <option :value="1">1 跳</option>
        <option :value="2">2 跳</option>
        <option :value="3">3 跳</option>
      </select>
      <label class="graph-check"><input v-model="showJournals" type="checkbox" /> 日志</label>
      <label class="graph-check"><input v-model="hideOrphans" type="checkbox" /> 隐藏孤立页</label>
      <span class="graph-search">
        <Search :size="13" />
        <input v-model="query" class="graph-search-input" placeholder="过滤节点" />
      </span>
    </div>

    <div ref="hostRef" class="graph-host"></div>

    <p v-if="emptyHint" class="graph-empty">{{ emptyHint }}</p>
  </div>
</template>

<style scoped>
.graph-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.graph-head {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 16px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
}

.graph-icon {
  color: var(--accent);
}

.graph-title {
  font-size: 14px;
  font-weight: 600;
}

.graph-counts {
  font-size: 12px;
  color: var(--fg-dim);
}

.graph-chip {
  padding: 1px 6px;
  font-size: 11px;
  color: var(--fg-dim);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 3px;
}

.graph-chip.warn {
  color: #e2b93d;
  border-color: color-mix(in srgb, #e2b93d 45%, var(--border));
}

.graph-spacer {
  flex: 1;
}

.graph-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px;
  color: var(--fg-dim);
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.graph-btn:hover {
  color: var(--fg);
  background: var(--bg3);
}

.graph-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px 16px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.graph-seg {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.graph-seg button {
  padding: 3px 10px;
  font-size: 12px;
  color: var(--fg-dim);
  background: var(--bg3);
  border: none;
  cursor: pointer;
}

.graph-seg button.on {
  color: #fff;
  background: var(--accent);
}

.graph-seg button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.graph-select {
  padding: 3px 6px;
  font-size: 12px;
  color: var(--fg);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.graph-check {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-size: 12px;
  color: var(--fg-dim);
  cursor: pointer;
}

.graph-search {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 3px 8px;
  color: var(--fg-dim);
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.graph-search-input {
  width: 160px;
  font: inherit;
  font-size: 12px;
  color: var(--fg);
  background: transparent;
  border: none;
  outline: none;
}

.graph-host {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 背景可拖动/平移;`.clickable` / `.grabbable` 由 force-graph 自带的样式覆盖 */
.graph-host :deep(canvas) {
  cursor: grab;
}

.graph-empty {
  position: absolute;
  top: 50%;
  left: 50%;
  margin: 0;
  font-size: 13px;
  color: var(--fg-dim);
  transform: translate(-50%, -50%);
}
</style>
