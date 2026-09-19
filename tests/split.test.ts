/** 分屏布局纯逻辑:二叉嵌套树操作、几何(窗格/分隔条 rect)、布局形状与预设归一化 */

import { describe, expect, it } from 'vitest'
import {
  MAX_GROUP_PANES,
  MAX_LAYOUT_PRESETS,
  MIN_PANE,
  RATIO_MAX,
  RATIO_MIN,
  SPLIT_GAP,
  axisOfDir,
  clampRatio,
  computeLayout,
  hasPane,
  instantiateShape,
  isLeadingDir,
  leaf,
  nextLayoutName,
  nextLayoutPresetId,
  normalizeLayoutPresets,
  paneCount,
  paneTabIds,
  removePane,
  resizePane,
  shapeOf,
  shapePaneCount,
  shapeSummary,
  splitPane
} from '../src/shared/split'
import type { LayoutNode, LayoutShape } from '../src/shared/split'

const row = (a: LayoutNode, b: LayoutNode, ratio = 0.5): LayoutNode => ({ kind: 'split', axis: 'row', ratio, a, b })
const col = (a: LayoutNode, b: LayoutNode, ratio = 0.5): LayoutNode => ({
  kind: 'split',
  axis: 'column',
  ratio,
  a,
  b
})

describe('方向 → 轴 / 扩张侧', () => {
  it('左右是 row,上下是 column', () => {
    expect(axisOfDir('left')).toBe('row')
    expect(axisOfDir('right')).toBe('row')
    expect(axisOfDir('up')).toBe('column')
    expect(axisOfDir('down')).toBe('column')
  })

  it('right/down 朝 b 侧扩张', () => {
    expect(isLeadingDir('right')).toBe(true)
    expect(isLeadingDir('down')).toBe(true)
    expect(isLeadingDir('left')).toBe(false)
    expect(isLeadingDir('up')).toBe(false)
  })
})

describe('clampRatio', () => {
  it('夹到 10%~90%', () => {
    expect(clampRatio(0.5)).toBe(0.5)
    expect(clampRatio(0.03)).toBe(RATIO_MIN)
    expect(clampRatio(0.97)).toBe(RATIO_MAX)
  })

  it('非有限值落到 0.5', () => {
    expect(clampRatio(Number.NaN)).toBe(0.5)
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(RATIO_MAX)
    expect(clampRatio(Number.NEGATIVE_INFINITY)).toBe(RATIO_MIN)
  })
})

describe('paneCount / paneTabIds / hasPane', () => {
  it('先序遍历 = 阅读顺序', () => {
    const tree = row(leaf(1), col(leaf(2), leaf(3)))
    expect(paneCount(tree)).toBe(3)
    expect(paneTabIds(tree)).toEqual([1, 2, 3])
    expect(hasPane(tree, 2)).toBe(true)
    expect(hasPane(tree, 9)).toBe(false)
    expect(paneTabIds(leaf(7))).toEqual([7])
  })
})

describe('splitPane', () => {
  it('→ / ↓ 新窗格在 b 侧(右边 / 下边)', () => {
    expect(splitPane(leaf(1), 1, 'right', 2)).toEqual(row(leaf(1), leaf(2)))
    expect(splitPane(leaf(1), 1, 'down', 2)).toEqual(col(leaf(1), leaf(2)))
  })

  it('← / ↑ 新窗格在 a 侧(左边 / 上边)', () => {
    expect(splitPane(leaf(1), 1, 'left', 2)).toEqual(row(leaf(2), leaf(1)))
    expect(splitPane(leaf(1), 1, 'up', 2)).toEqual(col(leaf(2), leaf(1)))
  })

  it('每次都在当前窗格外**嵌套一层**(比例恒 0.5)', () => {
    const once = splitPane(leaf(1), 1, 'right', 2)
    const twice = splitPane(once, 2, 'right', 3)
    expect(twice).toEqual(row(leaf(1), row(leaf(2), leaf(3))))
    expect(paneTabIds(twice)).toEqual([1, 2, 3])
    expect(paneCount(twice)).toBe(3)
  })

  it('在深处窗格上分屏:替换的是那个叶子,别的分支不动', () => {
    const tree = col(row(leaf(1), leaf(2)), leaf(3))
    const next = splitPane(tree, 2, 'down', 9)
    expect(next).toEqual(col(row(leaf(1), col(leaf(2), leaf(9))), leaf(3)))
    expect(paneTabIds(next)).toEqual([1, 2, 9, 3])
  })

  it('tabId 不在树里 → 原样返回(引用不变)', () => {
    const tree = row(leaf(1), leaf(2))
    expect(splitPane(tree, 99, 'right', 3)).toBe(tree)
  })
})

describe('removePane', () => {
  it('摘掉中间叶子:容器塌缩,层级少一层', () => {
    const tree = row(leaf(1), col(leaf(2), leaf(3)))
    const res = removePane(tree, 2)
    expect(res.root).toEqual(row(leaf(1), leaf(3)))
    expect(res.nextFocusTabId).toBe(3) // 阅读顺序里的下一个
  })

  it('摘掉最后一个叶子:焦点回落到前一个', () => {
    const res = removePane(row(leaf(1), leaf(2)), 2)
    expect(res.root).toEqual(leaf(1))
    expect(res.nextFocusTabId).toBe(1)
  })

  it('只剩两个叶子时摘掉任意一个 → 根节点直接变成另一个叶子(引用复用)', () => {
    const kept = leaf(2)
    const res = removePane(row(leaf(1), kept), 1)
    expect(res.root).toBe(kept)
  })

  it('塌缩保留深层结构(整支顶替)', () => {
    const inner = row(leaf(1), leaf(2))
    const res = removePane(col(inner, leaf(3)), 3)
    expect(res.root).toBe(inner)
  })

  it('摘掉唯一的叶子 → 树空', () => {
    expect(removePane(leaf(5), 5)).toEqual({ root: null, nextFocusTabId: null })
  })

  it('tabId 不在树里 → 原样返回', () => {
    const tree = row(leaf(1), leaf(2))
    const res = removePane(tree, 99)
    expect(res.root).toBe(tree)
    expect(res.nextFocusTabId).toBeNull()
  })

  it('深层摘除后阅读顺序的邻居优先取下一个', () => {
    const res = removePane(row(leaf(1), col(leaf(2), leaf(3))), 1)
    expect(res.root).toEqual(col(leaf(2), leaf(3)))
    expect(res.nextFocusTabId).toBe(2)
  })
})

describe('resizePane', () => {
  const simple = row(leaf(1), leaf(2))

  it('→ 在左半:ratio 增大(左窗格变宽)', () => {
    expect(resizePane(simple, 1, 'right', 0.05)).toEqual(row(leaf(1), leaf(2), 0.55))
  })

  it('← 在右半:ratio 减小(右窗格变宽)', () => {
    expect(resizePane(simple, 2, 'left', 0.05)).toEqual(row(leaf(1), leaf(2), 0.45))
  })

  it('贴边方向不动:→ 在右半 / ← 在左半 → 原样(引用不变)', () => {
    expect(resizePane(simple, 2, 'right', 0.05)).toBe(simple)
    expect(resizePane(simple, 1, 'left', 0.05)).toBe(simple)
  })

  it('轴不匹配的方向不动', () => {
    expect(resizePane(simple, 1, 'down', 0.05)).toBe(simple)
    const vertical = col(leaf(1), leaf(2))
    expect(resizePane(vertical, 1, 'right', 0.05)).toBe(vertical)
    expect(resizePane(vertical, 1, 'down', 0.05)).toEqual(col(leaf(1), leaf(2), 0.55))
  })

  it('优先动**最靠近叶子**的那一层', () => {
    const tree = row(leaf(1), col(leaf(2), leaf(3)))
    const next = resizePane(tree, 2, 'down', 0.05)
    expect(next).toEqual(row(leaf(1), col(leaf(2), leaf(3), 0.55)))
    // 外层 row 的 ratio 不能被顺手改掉
    expect(next.kind === 'split' && next.ratio).toBe(0.5)
  })

  it('里层动不了时向上一层找可扩张的祖先', () => {
    // 2 是内层 row 的右半(→ 动不了内层),但整个内层是外层的 a ⇒ 外层能向右扩
    const tree = row(row(leaf(1), leaf(2)), leaf(3))
    const next = resizePane(tree, 2, 'right', 0.05)
    expect(next).toEqual(row(row(leaf(1), leaf(2)), leaf(3), 0.55))
  })

  it('ratio 夹在 10%~90%', () => {
    expect(resizePane(row(leaf(1), leaf(2), 0.88), 1, 'right', 0.05)).toEqual(
      row(leaf(1), leaf(2), RATIO_MAX)
    )
    expect(resizePane(row(leaf(1), leaf(2), 0.12), 2, 'left', 0.05)).toEqual(
      row(leaf(1), leaf(2), RATIO_MIN)
    )
  })

  it('tabId 不在树里 / 到顶都动不了 → 原样', () => {
    expect(resizePane(simple, 99, 'right', 0.05)).toBe(simple)
    const nested = col(row(leaf(1), leaf(2)), leaf(3))
    expect(resizePane(nested, 2, 'up', 0.05)).toBe(nested)
  })
})

describe('computeLayout', () => {
  const area = { x: 0, y: 0, width: 1004, height: 400 }

  it('两窗格 50%:左右各 500 + 间隔 4 = 1004', () => {
    const geo = computeLayout(row(leaf(1), leaf(2)), area, { focusedTabId: 1 })
    expect(geo.panes).toEqual([
      { tabId: 1, rect: { x: 0, y: 0, width: 500, height: 400 } },
      { tabId: 2, rect: { x: 504, y: 0, width: 500, height: 400 } }
    ])
    expect(geo.dividers).toEqual([{ x: 500, y: 0, width: SPLIT_GAP, height: 400 }])
  })

  it('上下分屏按高度切', () => {
    const geo = computeLayout(col(leaf(1), leaf(2)), { x: 0, y: 30, width: 300, height: 800 }, {
      focusedTabId: 2
    })
    expect(geo.panes).toEqual([
      { tabId: 1, rect: { x: 0, y: 30, width: 300, height: 398 } },
      { tabId: 2, rect: { x: 0, y: 432, width: 300, height: 398 } }
    ])
    expect(geo.dividers).toEqual([{ x: 0, y: 428, width: 300, height: SPLIT_GAP }])
  })

  it('嵌套:每层各扣一个 gap,坐标与阅读顺序一致', () => {
    const geo = computeLayout(row(leaf(1), row(leaf(2), leaf(3))), area, { focusedTabId: 1 })
    expect(geo.panes).toEqual([
      { tabId: 1, rect: { x: 0, y: 0, width: 500, height: 400 } },
      { tabId: 2, rect: { x: 504, y: 0, width: 248, height: 400 } },
      { tabId: 3, rect: { x: 756, y: 0, width: 248, height: 400 } }
    ])
    expect(geo.dividers).toEqual([
      { x: 500, y: 0, width: SPLIT_GAP, height: 400 },
      { x: 752, y: 0, width: SPLIT_GAP, height: 400 }
    ])
  })

  it('窗格 rect 互不重叠', () => {
    const geo = computeLayout(row(leaf(1), col(leaf(2), row(leaf(3), leaf(4)))), area, {
      focusedTabId: 3
    })
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    for (let i = 0; i < geo.panes.length; i += 1) {
      for (let j = i + 1; j < geo.panes.length; j += 1) {
        expect(overlap(geo.panes[i].rect, geo.panes[j].rect)).toBe(false)
      }
    }
  })

  it('ratio 越大左窗格越宽,并按 MIN_PANE 夹紧', () => {
    const geo = computeLayout(row(leaf(1), leaf(2), 0.9), { x: 0, y: 0, width: 300, height: 200 }, {
      focusedTabId: 1
    })
    // avail = 296,0.9 → 266,但右窗格至少要 120 ⇒ 左 176、右 120
    expect(geo.panes[0].rect.width).toBe(296 - MIN_PANE)
    expect(geo.panes[1].rect.width).toBe(MIN_PANE)
  })

  it('放不下两个最小窗格 → 只渲染聚焦那一支,本层不出分隔条', () => {
    const narrow = { x: 0, y: 0, width: 2 * MIN_PANE + SPLIT_GAP - 1, height: 300 }
    const left = computeLayout(row(leaf(1), leaf(2)), narrow, { focusedTabId: 1 })
    expect(left.panes).toEqual([{ tabId: 1, rect: narrow }])
    expect(left.dividers).toEqual([])
    const right = computeLayout(row(leaf(1), leaf(2)), narrow, { focusedTabId: 2 })
    expect(right.panes).toEqual([{ tabId: 2, rect: narrow }])
  })

  it('恰好放得下两个最小窗格 → 正常分屏', () => {
    const exact = { x: 0, y: 0, width: 2 * MIN_PANE + SPLIT_GAP, height: 300 }
    const geo = computeLayout(row(leaf(1), leaf(2)), exact, { focusedTabId: 1 })
    expect(geo.panes.map((p) => p.rect.width)).toEqual([MIN_PANE, MIN_PANE])
    expect(geo.dividers).toHaveLength(1)
  })

  it('退化只发生在放不下的那一层,别的层照常', () => {
    // 外层够宽、内层不够:外层正常分屏,内层只留聚焦支
    const geo = computeLayout(row(leaf(1), row(leaf(2), leaf(3))), { x: 0, y: 0, width: 404, height: 200 }, {
      focusedTabId: 3
    })
    expect(geo.panes.map((p) => p.tabId)).toEqual([1, 3])
    expect(geo.dividers).toHaveLength(1)
    expect(geo.panes[1].rect).toEqual({ x: 204, y: 0, width: 200, height: 200 })
  })

  it('focusedTabId 为 null / 不在树里 → 保留 a 侧(防御)', () => {
    const narrow = { x: 0, y: 0, width: 200, height: 200 }
    expect(computeLayout(row(leaf(1), leaf(2)), narrow, { focusedTabId: null }).panes.map((p) => p.tabId)).toEqual([1])
    expect(computeLayout(row(leaf(1), leaf(2)), narrow, { focusedTabId: 99 }).panes.map((p) => p.tabId)).toEqual([1])
  })

  it('自定义 gap / minPane 生效', () => {
    const geo = computeLayout(row(leaf(1), leaf(2)), { x: 0, y: 0, width: 1000, height: 100 }, {
      focusedTabId: 1,
      gap: 20,
      minPane: 100
    })
    expect(geo.panes[0].rect.width).toBe(490)
    expect(geo.dividers[0]).toEqual({ x: 490, y: 0, width: 20, height: 100 })
  })
})

describe('布局形状(shapeOf / instantiateShape)', () => {
  it('shapeOf 去掉 tabId,instantiateShape 按先序装回去', () => {
    const tree = row(leaf(1), col(leaf(2), leaf(3)))
    const shape = shapeOf(tree)
    expect(shape).toEqual({
      kind: 'split',
      axis: 'row',
      ratio: 0.5,
      a: { kind: 'leaf' },
      b: { kind: 'split', axis: 'column', ratio: 0.5, a: { kind: 'leaf' }, b: { kind: 'leaf' } }
    })
    expect(instantiateShape(shape, [7, 8, 9])).toEqual(row(leaf(7), col(leaf(8), leaf(9))))
  })

  it('比例原样往返', () => {
    const tree = col(leaf(1), row(leaf(2), leaf(3), 0.35), 0.7)
    const round = instantiateShape(shapeOf(tree), [1, 2, 3])
    expect(round).toEqual(tree)
  })

  it('tabIds 数量对不上 → null', () => {
    const shape = shapeOf(row(leaf(1), leaf(2)))
    expect(instantiateShape(shape, [1])).toBeNull()
    expect(instantiateShape(shape, [1, 2, 3])).toBeNull()
  })

  it('shapePaneCount / shapeSummary', () => {
    expect(shapePaneCount(shapeOf(row(leaf(1), col(leaf(2), leaf(3)))))).toBe(3)
    expect(shapeSummary(shapeOf(row(leaf(1), col(leaf(2), leaf(3)))))).toBe('左右 1 · 上下 1')
    expect(shapeSummary(shapeOf(row(leaf(1), row(leaf(2), leaf(3)))))).toBe('左右 2')
    expect(shapeSummary(shapeOf(leaf(1)))).toBe('')
  })
})

describe('normalizeLayoutPresets', () => {
  const good = { id: 'l1', name: '布局 1', shape: shapeOf(row(leaf(1), leaf(2))) }

  it('非数组 → 空列表(文件被写坏时不炸)', () => {
    expect(normalizeLayoutPresets(null)).toEqual([])
    expect(normalizeLayoutPresets({ id: 'l1' })).toEqual([])
    expect(normalizeLayoutPresets('l1')).toEqual([])
  })

  it('丢掉坏形状:非对象 / 坏 kind / 坏轴 / 单叶子', () => {
    const out = normalizeLayoutPresets([
      good,
      { id: 'x', shape: null },
      { id: 'y', shape: { kind: 'weird' } },
      { id: 'z', shape: { kind: 'split', axis: 'diagonal', a: { kind: 'leaf' }, b: { kind: 'leaf' } } },
      { id: 'w', shape: { kind: 'leaf' } },
      { id: 'v', shape: { kind: 'split', axis: 'row', a: { kind: 'leaf' }, b: null } }
    ])
    expect(out.map((p) => p.id)).toEqual(['l1'])
  })

  it('夹紧比例、补默认名、去重 id', () => {
    const out = normalizeLayoutPresets([
      { id: 'a', shape: { kind: 'split', axis: 'row', ratio: 0.95, a: { kind: 'leaf' }, b: { kind: 'leaf' } } },
      { id: 'a', name: '  我的布局  ', shape: { kind: 'split', axis: 'row', a: { kind: 'leaf' }, b: { kind: 'leaf' } } },
      { shape: { kind: 'split', axis: 'row', ratio: Number.NaN, a: { kind: 'leaf' }, b: { kind: 'leaf' } } }
    ])
    expect(out[0].shape.kind === 'split' && out[0].shape.ratio).toBe(0.9)
    expect(out[0].name).toBe('布局 1')
    expect(out[1].id).toBe('a_')
    expect(out[1].name).toBe('我的布局')
    expect(out[2].id).toBe('l3')
  })

  it('叶子数超过 MAX_GROUP_PANES 的形状丢掉', () => {
    let shape: LayoutShape = { kind: 'leaf' }
    for (let i = 1; i < MAX_GROUP_PANES + 1; i += 1) {
      shape = { kind: 'split', axis: 'row', ratio: 0.5, a: { kind: 'leaf' }, b: shape }
    }
    expect(shapePaneCount(shape)).toBe(MAX_GROUP_PANES + 1)
    expect(normalizeLayoutPresets([{ id: 'big', shape }])).toEqual([])
  })

  it('截断到上限,产出新数组 / 新对象', () => {
    const many = Array.from({ length: MAX_LAYOUT_PRESETS + 5 }, (_, i) => ({
      id: `p${i}`,
      name: `${i}`,
      shape: shapeOf(row(leaf(1), leaf(2)))
    }))
    const out = normalizeLayoutPresets(many)
    expect(out).toHaveLength(MAX_LAYOUT_PRESETS)
    const once = normalizeLayoutPresets([good])
    expect(once[0]).not.toBe(good)
    expect(once[0].shape).not.toBe(good.shape)
  })
})

describe('nextLayoutPresetId / nextLayoutName', () => {
  it('取未占用的最小序号', () => {
    expect(nextLayoutPresetId([])).toBe('l1')
    expect(nextLayoutPresetId(['l1', 'l3'])).toBe('l2')
  })

  it('名字按「布局 N」递增,忽略非默认名', () => {
    expect(nextLayoutName([])).toBe('布局 1')
    expect(nextLayoutName([{ id: 'a', name: '布局 1', shape: shapeOf(leaf(1)) }])).toBe('布局 2')
    expect(
      nextLayoutName([
        { id: 'a', name: '布局 3', shape: shapeOf(leaf(1)) },
        { id: 'b', name: '我的布局', shape: shapeOf(leaf(1)) }
      ])
    ).toBe('布局 4')
  })
})
