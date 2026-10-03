/**
 * 页内查找(`Ctrl+F`)的几何纯函数(三端安全:main / renderer / 测试都可用,不 import electron / vue)。
 *
 * 为什么单独拎出来:查找条复用 Overlay 的小尺寸 placement(`page-top-right`),而
 * `WebContentsView` **没有点击穿透**(见 `main/toasts.ts` 顶部)—— bounds 算错的表现是
 * 「查找条被裁掉」或「页面右上角一片透明视图把点击吃掉」,两者只能靠真机肉眼发现。
 * 所以几何只有这一处实现,并由 `tests/find.test.ts` 钉住(与 `shared/split.ts` 的 `focusRingBars` 同一思路)。
 */

import type { Rect } from './split'

/** 查找条宽度上限(CSS px) */
export const FIND_BAR_WIDTH = 420
/** 查找条高度:固定值,内容(输入框 + 计数 + 4 个按钮)必须放进这个高度 */
export const FIND_BAR_HEIGHT = 44
/** 距页面区上边 / 右边的留白 */
export const FIND_BAR_MARGIN = 10
/** 窗口很窄时的最小可用宽度,防止控件挤成一团 */
export const FIND_BAR_MIN_WIDTH = 220

/**
 * 查找条在**窗口内容坐标**里的矩形:贴页面区右上角(页面区从 `chromeHeight` 起),
 * 窗口太窄 / 太矮时夹住不越界。宽度按窗口宽度收缩,但不会小于 `FIND_BAR_MIN_WIDTH`。
 */
export function findBarRect(o: {
  windowWidth: number
  windowHeight: number
  chromeHeight: number
}): Rect {
  const margin = FIND_BAR_MARGIN
  const width = Math.max(FIND_BAR_MIN_WIDTH, Math.min(FIND_BAR_WIDTH, o.windowWidth - margin * 2))
  const x = Math.max(margin, o.windowWidth - width - margin)
  const maxY = Math.max(0, o.windowHeight - FIND_BAR_HEIGHT - margin)
  const y = Math.max(0, Math.min(o.chromeHeight + margin, maxY))
  return { x, y, width, height: FIND_BAR_HEIGHT }
}
