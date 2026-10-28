/**
 * tabId 徽标浮层的几何:它直接决定 Overlay 那块透明视图的 bounds ——
 * `WebContentsView` 没有点击穿透,算错的表现只有真机肉眼看得出来
 * (徽标被裁掉 / 页面上一大片点不动),所以几何必须有单测。
 */

import { describe, expect, it } from 'vitest'
import { TAB_ID_BADGE_PADDING, TAB_ID_BADGE_SIZE, tabIdBadgeLayout } from '../src/shared/tabIdBadge'
import type { TabIdBadgeCenter } from '../src/shared/tabIdBadge'

const W = 1280
const H = 800
const HALF_W = TAB_ID_BADGE_SIZE.width / 2
const HALF_H = TAB_ID_BADGE_SIZE.height / 2

function insideWindow(payload: { bounds: { x: number; y: number; width: number; height: number } }): boolean {
  const { x, y, width, height } = payload.bounds
  return x >= 0 && y >= 0 && width >= 1 && height >= 1 && x + width <= W && y + height <= H
}

describe('tabIdBadgeLayout 徽标浮层几何', () => {
  it('没有窗格 → null', () => {
    expect(tabIdBadgeLayout([], W, H)).toBe(null)
  })

  it('单个中心(不分屏):bounds 恰好包住徽标 + padding,徽标本地坐标 = 中心 − 原点', () => {
    const c: TabIdBadgeCenter = { tabId: 3, x: 640, y: 470 }
    const out = tabIdBadgeLayout([c], W, H)!
    expect(out.bounds).toEqual({
      x: 640 - HALF_W - TAB_ID_BADGE_PADDING,
      y: 470 - HALF_H - TAB_ID_BADGE_PADDING,
      width: TAB_ID_BADGE_SIZE.width + TAB_ID_BADGE_PADDING * 2,
      height: TAB_ID_BADGE_SIZE.height + TAB_ID_BADGE_PADDING * 2
    })
    expect(out.badges).toEqual([{ tabId: 3, x: 640 - out.bounds.x, y: 470 - out.bounds.y }])
  })

  it('左右分屏:两个中心并成中间一条窄横带(上下仍可点)', () => {
    const out = tabIdBadgeLayout(
      [
        { tabId: 3, x: 320, y: 470 },
        { tabId: 5, x: 960, y: 470 }
      ],
      W,
      H
    )!
    expect(out.bounds.x).toBe(320 - HALF_W - TAB_ID_BADGE_PADDING)
    expect(out.bounds.y).toBe(470 - HALF_H - TAB_ID_BADGE_PADDING)
    expect(out.bounds.width).toBe(960 - 320 + TAB_ID_BADGE_SIZE.width + TAB_ID_BADGE_PADDING * 2)
    expect(out.bounds.height).toBe(TAB_ID_BADGE_SIZE.height + TAB_ID_BADGE_PADDING * 2)
    expect(out.badges.map((b) => b.tabId)).toEqual([3, 5])
    expect(insideWindow(out)).toBe(true)
  })

  it('2×2 分屏:并集盒盖住中间区域,四角仍在 bounds 之外', () => {
    const out = tabIdBadgeLayout(
      [
        { tabId: 1, x: 320, y: 235 },
        { tabId: 2, x: 960, y: 235 },
        { tabId: 3, x: 320, y: 700 },
        { tabId: 4, x: 960, y: 700 }
      ],
      W,
      H
    )!
    expect(out.bounds.x).toBeGreaterThan(0)
    expect(out.bounds.y).toBeGreaterThan(0)
    expect(out.bounds.x + out.bounds.width).toBeLessThan(W)
    expect(out.bounds.y + out.bounds.height).toBeLessThan(H)
    expect(out.badges.map((b) => b.tabId)).toEqual([1, 2, 3, 4])
    // 每个徽标中心都落在浮层视图内(否则会被裁掉)
    for (const b of out.badges) {
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.x).toBeLessThanOrEqual(out.bounds.width)
      expect(b.y).toBeLessThanOrEqual(out.bounds.height)
    }
  })

  it('贴窗口边 / 角时 bounds 被夹进窗口(绝不产出界外视图)', () => {
    for (const centers of [
      [{ tabId: 1, x: 10, y: 10 }],
      [{ tabId: 1, x: W - 10, y: H - 10 }],
      [
        { tabId: 1, x: 0, y: 0 },
        { tabId: 2, x: W, y: H }
      ]
    ]) {
      const out = tabIdBadgeLayout(centers, W, H)!
      expect(insideWindow(out)).toBe(true)
    }
  })

  it('窗口极小时仍产出至少 1px 的视图且不越界', () => {
    const out = tabIdBadgeLayout([{ tabId: 7, x: 5, y: 5 }], 20, 12)!
    expect(insideWindow(out)).toBe(true)
  })

  it('终端的 label 原样进徽标(徽标宽度/高度按 TAB_ID_BADGE_SIZE 估,与 CSS 接近即可)', () => {
    const out = tabIdBadgeLayout([{ tabId: 9, x: 400, y: 300, label: '终端 — …/Workspace/bow' }], W, H)!
    expect(out.badges[0]?.label).toBe('终端 — …/Workspace/bow')
    expect(insideWindow(out)).toBe(true)
    // 没有 label 的窗格不带这个键(渲染层据此决定一行还是两行)
    const plain = tabIdBadgeLayout([{ tabId: 3, x: 400, y: 300 }], W, H)!
    expect('label' in plain.badges[0]!).toBe(false)
  })

  it('同一组中心的顺序被保留(徽标与窗格一一对应)', () => {
    const centers: TabIdBadgeCenter[] = [
      { tabId: 11, x: 100, y: 100 },
      { tabId: 12, x: 120, y: 100 },
      { tabId: 13, x: 140, y: 100 }
    ]
    expect(tabIdBadgeLayout(centers, W, H)!.badges.map((b) => b.tabId)).toEqual([11, 12, 13])
  })
})
