/**
 * 「长按 Shift 显示的 tabId 徽标」的几何纯函数(三端安全:main / renderer / 测试都可用,不 import electron / vue)。
 *
 * 为什么单独拎出来:徽标要给 Overlay 用一块**盖在页面之上**的透明 `WebContentsView`,而
 * `WebContentsView` **没有点击穿透**(见 `docs/ARCHITECTURE.md` §3)—— 铺满窗口就会把整页的点击吃掉。
 * 所以这里算的是「恰好包住所有徽标」的那块矩形(`page-top-right` 的 `@shared/find` 是同一个套路),
 * 算错的表现只有真机肉眼能看出来:徽标被裁掉、或者页面上一大片点不动。
 *
 * 坐标口径:
 * - 输入中心点是**窗口内容坐标**(与 `shared/types.ts` 的 `PaneBox.rect` / `TabManager.geometryOf` 同系);
 * - 输出的 `bounds` 也是窗口内容坐标(直接交给 `WebContentsView.setBounds`);
 * - 输出的 `badges` 是**浮层视图本地坐标**(= 窗口坐标 − bounds 原点),渲染层直接绝对定位。
 */

import type { Rect } from './split'

/** 徽标盒的估算尺寸(px):只用来算 bounds,真实大小由 CSS 决定(两者接近即可) */
export const TAB_ID_BADGE_SIZE = { width: 220, height: 50 }
/** bounds 四周留白(px):给徽标阴影留一点空间,同时不贴着页面内容 */
export const TAB_ID_BADGE_PADDING = 6

/** 徽标中心(窗口内容坐标) */
export interface TabIdBadgeCenter {
  tabId: number
  x: number
  y: number
  /** 第二行文字(终端窗格 = 带 cwd 的标题);没有就只显示 tabId */
  label?: string
}

/** 浮层视图本地坐标里的徽标中心 */
export interface TabIdBadge {
  tabId: number
  x: number
  y: number
  label?: string
}

/** `tab-ids` 浮层的 payload(OverlayManager 直接用 `bounds` 设视图大小) */
export interface TabIdsPayload {
  /** 浮层视图的 bounds(窗口内容坐标;已夹进窗口内) */
  bounds: Rect
  /** 徽标中心(浮层视图本地坐标) */
  badges: TabIdBadge[]
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/**
 * 中心点集合 → 浮层 bounds + 本地坐标。空集合返回 `null`(没有窗格就没有徽标)。
 *
 * 取所有「中心 ± `TAB_ID_BADGE_SIZE/2`」的并集,四周各加 `TAB_ID_BADGE_PADDING`,再夹进窗口。
 * 所以不分屏时只有页面正中央的一小块被接管;分屏时是被各徽标撑开的并集矩形
 * (左右分屏 ≈ 中间一条窄横带;2×2 分屏 ≈ 中间区域,四个角仍可点)。
 */
export function tabIdBadgeLayout(
  centers: TabIdBadgeCenter[],
  windowWidth: number,
  windowHeight: number
): TabIdsPayload | null {
  if (centers.length === 0) return null
  const halfW = TAB_ID_BADGE_SIZE.width / 2
  const halfH = TAB_ID_BADGE_SIZE.height / 2
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const c of centers) {
    left = Math.min(left, c.x - halfW)
    right = Math.max(right, c.x + halfW)
    top = Math.min(top, c.y - halfH)
    bottom = Math.max(bottom, c.y + halfH)
  }
  // 窗口尺寸一律当整数处理(至少 1px,避免 width/height = 0 的视图)
  const w = Math.max(1, Math.floor(windowWidth))
  const h = Math.max(1, Math.floor(windowHeight))
  const x = clamp(Math.floor(left - TAB_ID_BADGE_PADDING), 0, w - 1)
  const y = clamp(Math.floor(top - TAB_ID_BADGE_PADDING), 0, h - 1)
  const width = clamp(Math.ceil(right + TAB_ID_BADGE_PADDING) - x, 1, w - x)
  const height = clamp(Math.ceil(bottom + TAB_ID_BADGE_PADDING) - y, 1, h - y)
  return {
    bounds: { x, y, width, height },
    badges: centers.map((c) => ({
      tabId: c.tabId,
      x: Math.round(c.x - x),
      y: Math.round(c.y - y),
      // 只带 label 有值时这个键才存在(包大小仍按最长那种算,见 TAB_ID_BADGE_SIZE)
      ...(c.label ? { label: c.label } : {})
    }))
  }
}
