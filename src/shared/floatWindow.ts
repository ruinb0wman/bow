/**
 * 浮动窗口(工具栏「本地服务」的小窗)的纯逻辑:**位置 + 尺寸**。不碰 electron / DOM,可单测。
 *
 * 只有显式配了 `float` 的服务才走浮窗(见 `@plugins/services/shared` 的 `ServiceConfig`)——
 * 没配 = 点图标照旧开标签,所以这里没有「默认给所有人开浮窗」这种事,`DEFAULT_FLOAT`
 * 只在设置里打开那个开关时被写进去一次。
 */

export type FloatPlacement = 'center' | 'left' | 'right' | 'top' | 'bottom'

export interface FloatPrefs {
  placement: FloatPlacement
  width: number
  height: number
}

/** 打开浮窗的请求(渲染层 → 主进程):URL + 位置尺寸 */
export interface FloatRequest {
  url: string
  prefs: FloatPrefs
}

/** 浮窗状态(主进程 → 渲染层):工具栏据此点亮图标 */
export interface FloatState {
  open: boolean
  url: string | null
}

export const FLOAT_PLACEMENTS: readonly FloatPlacement[] = ['center', 'left', 'right', 'top', 'bottom']

export const DEFAULT_FLOAT: FloatPrefs = { placement: 'center', width: 800, height: 600 }

/**
 * 与窗口边缘 / 工具栏的留白。贴边就不像"浮"的了,而是停靠 —— 这个数决定左右/上下档位的位置。
 */
export const FLOAT_GAP = 12

/** 最小可用尺寸:再小就看不出是张页面了(也顺手挡住 `0` / 负数) */
export const FLOAT_MIN_WIDTH = 320
export const FLOAT_MIN_HEIGHT = 200
const FLOAT_MAX = 4000

export function isFloatPlacement(value: unknown): value is FloatPlacement {
  return typeof value === 'string' && (FLOAT_PLACEMENTS as readonly string[]).includes(value)
}

/**
 * 设置归一。**两段的语义不同,别合并**:
 * - 根本没有 `float`(老配置 / 用户关掉了开关)→ `null` = 不用浮窗;
 * - 有 `float` 但字段写脏了 → 回落默认值 —— 用户表达了「要浮窗」,静默退化成选项卡更莫名其妙。
 */
export function normalizeFloatPrefs(raw: unknown): FloatPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const clamp = (value: unknown, min: number, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
    return Math.min(FLOAT_MAX, Math.max(min, n))
  }
  return {
    placement: isFloatPlacement(obj.placement) ? obj.placement : DEFAULT_FLOAT.placement,
    width: clamp(obj.width, FLOAT_MIN_WIDTH, DEFAULT_FLOAT.width),
    height: clamp(obj.height, FLOAT_MIN_HEIGHT, DEFAULT_FLOAT.height)
  }
}

export interface FloatRectInput {
  placement: FloatPlacement
  width: number
  height: number
  windowWidth: number
  windowHeight: number
  /** chrome UI(标签栏 + 工具栏)的高度:浮窗只占页面区,不上盖工具栏 */
  chromeHeight: number
  gap?: number
}

export interface FloatRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 浮窗在窗口内容区里的矩形。`setBounds` 只吃整数,所以所有值都取整。
 *
 * 窗口比请求的尺寸还小时按可用面积夹住(不溢出、不滚动):宁可小一点,也不能糊住整块页面。
 */
export function floatRect(input: FloatRectInput): FloatRect {
  const gap = Math.max(0, Math.round(input.gap ?? FLOAT_GAP))
  const windowWidth = Math.max(0, Math.round(input.windowWidth))
  const windowHeight = Math.max(0, Math.round(input.windowHeight))
  const pageTop = Math.max(0, Math.round(input.chromeHeight))
  const pageHeight = Math.max(0, windowHeight - pageTop)

  const width = Math.max(0, Math.min(Math.round(input.width), windowWidth - gap * 2))
  const height = Math.max(0, Math.min(Math.round(input.height), pageHeight - gap * 2))
  const centeredX = Math.round((windowWidth - width) / 2)
  const centeredY = pageTop + Math.round((pageHeight - height) / 2)

  switch (input.placement) {
    case 'left':
      return { x: gap, y: centeredY, width, height }
    case 'right':
      return { x: Math.max(gap, windowWidth - width - gap), y: centeredY, width, height }
    case 'top':
      return { x: centeredX, y: pageTop + gap, width, height }
    case 'bottom':
      return { x: centeredX, y: Math.max(pageTop + gap, windowHeight - height - gap), width, height }
    default:
      return { x: centeredX, y: centeredY, width, height }
  }
}
