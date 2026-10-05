/**
 * `force-graph` 胶水的用例(vitest 是 node 环境,所以这一层必须不碰 DOM / 不 import force-graph)。
 *
 * 最要紧的一条:`title` 必须进节点对象 —— 旧版 `graphLayout.ts` 的 `LayoutNode` 漏了它,
 * 绘制回调读 `node.title` 拿到 `undefined`,整张图的标签全写成 "undefined"(见 2026-10-05 的修复)。
 */

import { describe, expect, it } from 'vitest'
import {
  LABEL_FONT_PX,
  labelBox,
  labelFont,
  nodeRadius,
  nodeValue,
  shouldShowLabel,
  toForceGraph,
  withAlpha,
  type ForceNode
} from '../src/plugins/logseq/graphForce'
import type { GraphData } from '../src/plugins/logseq/graph'

function data(nodes: Array<[string, string, number, string | null]>): GraphData {
  return {
    nodes: nodes.map(([id, title, degree, day]) => ({ id, title, day, degree })),
    links: [],
    missingRefs: 0,
    tooLarge: false
  }
}

describe('GraphData → force-graph', () => {
  it('title / day / degree 全部带进节点(绘制标签读的是 title,不能再漏)', () => {
    const cache = new Map<string, ForceNode>()
    const out = toForceGraph(data([['journals/2026_09_20.md', '2026-09-20', 3, '2026-09-20']]), cache)
    expect(out.nodes).toHaveLength(1)
    expect(out.nodes[0]).toMatchObject({ id: 'journals/2026_09_20.md', title: '2026-09-20', day: '2026-09-20', degree: 3 })
  })

  it('同 id 复用同一个节点对象:位置(x/y/fx/fy)不会因为过滤/刷新而丢', () => {
    const cache = new Map<string, ForceNode>()
    const first = toForceGraph(data([['a.md', 'A', 1, null]]), cache)
    first.nodes[0].x = 12
    first.nodes[0].y = 34
    first.nodes[0].fx = 12
    const second = toForceGraph(data([['a.md', 'A2', 5, null]]), cache)
    expect(second.nodes[0]).toBe(first.nodes[0]) // 同一引用
    expect(second.nodes[0]).toMatchObject({ x: 12, y: 34, fx: 12 })
    // 内容刷新还是要跟上
    expect(second.nodes[0]).toMatchObject({ title: 'A2', degree: 5 })
  })

  it('被过滤掉的节点留在 cache 里:再出现时位置还在', () => {
    const cache = new Map<string, ForceNode>()
    const full = toForceGraph(data([['a.md', 'A', 1, null], ['b.md', 'B', 2, null]]), cache)
    full.nodes[0].x = 7
    full.nodes[0].y = 8
    const filtered = toForceGraph(data([['b.md', 'B', 2, null]]), cache)
    expect(filtered.nodes).toHaveLength(1)
    const back = toForceGraph(data([['a.md', 'A', 1, null], ['b.md', 'B', 2, null]]), cache)
    expect(back.nodes[0]).toBe(full.nodes[0])
    expect(back.nodes[0]).toMatchObject({ x: 7, y: 8 })
  })

  it('边只保留两端都在节点集合里的,且每次都是新对象(躲开 d3-force 就地改写 source/target)', () => {
    const cache = new Map<string, ForceNode>()
    const withDangling: GraphData = {
      nodes: [
        { id: 'a.md', title: 'A', day: null, degree: 1 },
        { id: 'b.md', title: 'B', day: null, degree: 1 }
      ],
      links: [
        { source: 'a.md', target: 'b.md', weight: 2 },
        { source: 'a.md', target: 'gone.md', weight: 1 }
      ],
      missingRefs: 1,
      tooLarge: false
    }
    const first = toForceGraph(withDangling, cache)
    const second = toForceGraph(withDangling, cache)
    expect(first.links).toEqual([{ source: 'a.md', target: 'b.md', weight: 2 }])
    expect(second.links[0]).not.toBe(first.links[0])
    expect(second.nodes[0]).toBe(first.nodes[0]) // 节点复用,边不复用
  })

  it('空图不炸', () => {
    const out = toForceGraph({ nodes: [], links: [], missingRefs: 0, tooLarge: false }, new Map())
    expect(out).toEqual({ nodes: [], links: [] })
  })
})

describe('半径 / 标签 / 颜色', () => {
  it('nodeVal 与 nodeRadius 同口径(链接端点收缩与 zoomToFit 包围盒才不会和画出来的圆打架)', () => {
    for (const degree of [0, 1, 5, 40]) {
      expect(Math.sqrt(nodeValue({ degree }))).toBeCloseTo(nodeRadius(degree), 10)
    }
  })

  it('标签可见性:悬停节点与邻居必画;放大且度数够大才画', () => {
    expect(shouldShowLabel(0, { focused: true, neighbor: false, globalScale: 0.3 })).toBe(true)
    expect(shouldShowLabel(0, { focused: false, neighbor: true, globalScale: 0.3 })).toBe(true)
    expect(shouldShowLabel(3, { focused: false, neighbor: false, globalScale: 1.5 })).toBe(false)
    expect(shouldShowLabel(3, { focused: false, neighbor: false, globalScale: 2 })).toBe(true)
    expect(shouldShowLabel(0, { focused: false, neighbor: false, globalScale: 2 })).toBe(false)
  })

  it('标签盒子:在节点右侧、垂直居中,字号除以缩放保持屏幕恒定', () => {
    const node = { x: 100, y: 50 }
    const radius = 4
    const at1 = labelBox(node, radius, 30, 1)
    expect(at1.x).toBeCloseTo(100 + radius + 3, 10)
    expect(at1.h).toBeCloseTo(16, 10)
    expect(at1.y + at1.h / 2).toBeCloseTo(50, 10)
    // 放大 2 倍:图坐标里的盒子等比缩小,屏幕上一样大
    const at2 = labelBox(node, radius, 15, 2)
    expect(at2.h).toBeCloseTo(at1.h / 2, 10)
    expect(labelFont(2)).toContain(`${LABEL_FONT_PX / 2}px`)
    // 缺 x/y(还没被 d3 初始化)也不出 NaN
    expect(labelBox({}, 4, 10, 1).x).toBeCloseTo(7, 10)
  })

  it('withAlpha 只认 #rgb / #rrggbb,认不出来原样返回(宁可不压暗也不画坏颜色)', () => {
    expect(withAlpha('#4c8bf5', 0.5)).toBe('rgba(76, 139, 245, 0.5)')
    expect(withAlpha('#fff', 0.12)).toBe('rgba(255, 255, 255, 0.12)')
    expect(withAlpha('rgb(1,2,3)', 0.5)).toBe('rgb(1,2,3)')
    expect(withAlpha('var(--accent)', 0.5)).toBe('var(--accent)')
  })
})
