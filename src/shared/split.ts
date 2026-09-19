/**
 * 左右分屏(标签组)的纯逻辑:预设模型 + 两窗格几何。
 *
 * 组的记账在 `@shared/groups`(标签栏一项 = 一个组);这里只管「宽度档位」与「按档位算几何」:
 * 主进程用 `computeSplitBounds()` 算 `WebContentsView` 的 bounds,渲染层拿回传的 `leftWidth` 画分隔条
 * —— 几何只有这一处实现。
 */

export type SplitUnit = 'percent' | 'px'

export interface SplitPreset {
  /** 面板高亮与「套用哪个预设」的唯一键;设置页增删改时要保持稳定 */
  id: string
  label: string
  /** percent = 左窗格占**可用宽度**(总宽减间隔)的百分比;px = 左窗格固定像素宽 */
  value: number
  unit: SplitUnit
}

/** 当前生效的左窗格宽度(是预设的快照,预设被删掉后仍能继续用) */
export interface SplitLevel {
  value: number
  unit: SplitUnit
}

/** `computeSplitBounds` 的结果:渲染层只需要 leftWidth/gap */
export interface SplitGeometry {
  totalWidth: number
  leftWidth: number
  gap: number
}

/** 两窗格之间的空隙(px)。空隙露出的是底层(chrome 页面背景),视觉上就是分隔带 */
export const SPLIT_GAP = 4
/** 单窗格最小宽度(px):窄于此就不分屏,退化为单窗格铺满 */
export const SPLIT_MIN_PANE = 120
/** 比例预设的取值范围(%) */
export const SPLIT_PERCENT_RANGE = [10, 90] as const
/** 像素预设的取值范围(px) */
export const SPLIT_PX_RANGE = [160, 4000] as const
/** 预设条数上限(设置页与归一化共用;防止 settings.json 被写爆) */
export const SPLIT_PRESET_LIMIT = 12
/** 没传预设 / 预设列表为空时的兜底宽度 */
export const DEFAULT_SPLIT_LEVEL: SplitLevel = { value: 50, unit: 'percent' }

/**
 * 默认预设。⚠️ 这个数组会作为 `DEFAULT_SETTINGS` 的一部分交给 `JsonStore`(文件缺失时直接引用它),
 * 所以**任何人都不许原地修改它** —— 归一化/设置页一律产出新数组。
 */
export const DEFAULT_SPLIT_PRESETS: SplitPreset[] = [
  { id: 'p25', label: '左 1/4', value: 25, unit: 'percent' },
  { id: 'p33', label: '左 1/3', value: 33, unit: 'percent' },
  { id: 'p50', label: '对半', value: 50, unit: 'percent' },
  { id: 'p67', label: '左 2/3', value: 67, unit: 'percent' },
  { id: 'p75', label: '左 3/4', value: 75, unit: 'percent' }
]

/** 按单位取整 + 夹紧;非法数值给该单位的中位兜底 */
export function clampSplitValue(unit: SplitUnit, value: number): number {
  const n = Math.round(value)
  if (!Number.isFinite(n)) return unit === 'percent' ? DEFAULT_SPLIT_LEVEL.value : 600
  if (unit === 'percent') {
    return Math.min(SPLIT_PERCENT_RANGE[1], Math.max(SPLIT_PERCENT_RANGE[0], n))
  }
  return Math.min(SPLIT_PX_RANGE[1], Math.max(SPLIT_PX_RANGE[0], n))
}

/** 面板/设置页用的「值 + 单位」文案 */
export function splitValueLabel(level: SplitLevel): string {
  return level.unit === 'percent' ? `${level.value}%` : `${level.value}px`
}

/**
 * 把任意来源(settings.json、IPC、旧版本数据)的预设列表归一化成可用列表:
 * 丢掉非对象/单位非法/数值非有限的项,夹紧数值,补默认名,去重 id,截断到 `SPLIT_PRESET_LIMIT`。
 * 返回的永远是**新数组 + 新对象**。
 */
export function normalizeSplitPresets(raw: unknown): SplitPreset[] {
  if (!Array.isArray(raw)) return []
  const out: SplitPreset[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= SPLIT_PRESET_LIMIT) break
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const unit: SplitUnit | null = rec.unit === 'percent' ? 'percent' : rec.unit === 'px' ? 'px' : null
    if (!unit || typeof rec.value !== 'number' || !Number.isFinite(rec.value)) continue
    const value = clampSplitValue(unit, rec.value)
    const rawLabel = typeof rec.label === 'string' ? rec.label.trim().slice(0, 24) : ''
    const label = rawLabel || (unit === 'percent' ? `左 ${value}%` : `左 ${value}px`)
    const rawId = typeof rec.id === 'string' ? rec.id.trim().slice(0, 40) : ''
    let id = rawId || `p${out.length + 1}`
    while (seen.has(id)) id = `${id}_`
    seen.add(id)
    out.push({ id, label, value, unit })
  }
  return out
}

/** 生成一个未被占用的预设 id(`p1`、`p2`…;设置页「添加预设」用) */
export function nextSplitPresetId(ids: string[]): string {
  const taken = new Set(ids)
  for (let n = 1; n <= SPLIT_PRESET_LIMIT + 1; n += 1) {
    const id = `p${n}`
    if (!taken.has(id)) return id
  }
  return `p${ids.length + 1}_`
}

export function findSplitPreset(presets: SplitPreset[], id: string | null | undefined): SplitPreset | null {
  if (!id) return null
  return presets.find((p) => p.id === id) ?? null
}

export function splitLevelOf(preset: SplitPreset): SplitLevel {
  return { value: preset.value, unit: preset.unit }
}

/**
 * 按「值 + 单位」反查预设(面板高亮当前档位用):
 * 比如本次会话是第一回分屏且沿用默认 50%,`presetId` 还是 null,但预设表里那项该被高亮。
 */
export function matchSplitPreset(presets: SplitPreset[], level: SplitLevel | null): SplitPreset | null {
  if (!level) return null
  return presets.find((p) => p.unit === level.unit && p.value === level.value) ?? null
}

/**
 * 两窗格几何。`percent` 按**可用宽度**(`totalWidth - gap`)算,所以 50% 就是两半等宽。
 * 左窗格夹紧到 `[minPane, avail - minPane]`;可用宽度放不下两个最小窗格时返回 `null`
 * (调用方的约定:退化为单窗格铺满,但**不清空**分屏状态,窗口变宽后自动恢复)。
 */
export function computeSplitBounds(input: {
  totalWidth: number
  level: SplitLevel
  gap?: number
  minPane?: number
}): SplitGeometry | null {
  const gap = input.gap ?? SPLIT_GAP
  const minPane = input.minPane ?? SPLIT_MIN_PANE
  const total = Math.floor(input.totalWidth)
  if (!Number.isFinite(total)) return null
  const avail = total - gap
  if (avail < minPane * 2) return null
  const { unit, value } = input.level
  const v = clampSplitValue(unit, value)
  const raw = unit === 'percent' ? Math.round((avail * v) / 100) : v
  const leftWidth = Math.min(Math.max(raw, minPane), avail - minPane)
  return { totalWidth: total, leftWidth, gap }
}
