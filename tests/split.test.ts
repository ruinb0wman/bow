/** 分屏纯逻辑:预设归一化、档位解析、两窗格几何 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPLIT_LEVEL,
  DEFAULT_SPLIT_PRESETS,
  SPLIT_GAP,
  SPLIT_MIN_PANE,
  SPLIT_PRESET_LIMIT,
  clampSplitValue,
  computeSplitBounds,
  emptySplitState,
  findSplitPreset,
  matchSplitPreset,
  nextSplitPresetId,
  normalizeSplitPresets,
  splitLevelOf,
  splitValueLabel
} from '../src/shared/split'

describe('clampSplitValue', () => {
  it('比例夹紧到 10..90 并取整', () => {
    expect(clampSplitValue('percent', 50.4)).toBe(50)
    expect(clampSplitValue('percent', 3)).toBe(10)
    expect(clampSplitValue('percent', 200)).toBe(90)
  })

  it('像素夹紧到 160..4000', () => {
    expect(clampSplitValue('px', 800.6)).toBe(801)
    expect(clampSplitValue('px', 1)).toBe(160)
    expect(clampSplitValue('px', 99999)).toBe(4000)
  })

  it('NaN / Infinity 落到兜底值', () => {
    expect(clampSplitValue('percent', Number.NaN)).toBe(DEFAULT_SPLIT_LEVEL.value)
    expect(clampSplitValue('px', Number.POSITIVE_INFINITY)).toBe(600)
  })
})

describe('normalizeSplitPresets', () => {
  it('非数组 → 空列表(设置文件被写坏时不炸)', () => {
    expect(normalizeSplitPresets(null)).toEqual([])
    expect(normalizeSplitPresets({ id: 'p1' })).toEqual([])
    expect(normalizeSplitPresets('p1')).toEqual([])
  })

  it('丢掉单位非法、数值非数字的项', () => {
    const out = normalizeSplitPresets([
      { id: 'a', label: 'A', value: 40, unit: 'percent' },
      { id: 'b', label: 'B', value: '40', unit: 'percent' }, // value 是字符串
      { id: 'c', label: 'C', value: 40, unit: 'em' },
      null,
      42
    ])
    expect(out.map((p) => p.id)).toEqual(['a'])
  })

  it('夹紧数值、补默认名、去重 id', () => {
    const out = normalizeSplitPresets([
      { id: 'x', value: 5, unit: 'percent' },
      { id: 'x', value: 3000, unit: 'px' },
      { label: '带名字', value: 70, unit: 'percent' }
    ])
    expect(out[0]).toEqual({ id: 'x', label: '左 10%', value: 10, unit: 'percent' })
    expect(out[1]).toEqual({ id: 'x_', label: '左 3000px', value: 3000, unit: 'px' })
    expect(out[2]).toEqual({ id: 'p3', label: '带名字', value: 70, unit: 'percent' })
  })

  it('截断到上限', () => {
    const many = Array.from({ length: SPLIT_PRESET_LIMIT + 5 }, (_, i) => ({
      id: `p${i}`,
      label: `${i}`,
      value: 50,
      unit: 'percent' as const
    }))
    expect(normalizeSplitPresets(many)).toHaveLength(SPLIT_PRESET_LIMIT)
  })

  it('默认预设自己过一遍归一化后不变(默认值必须是合法的)', () => {
    expect(normalizeSplitPresets(DEFAULT_SPLIT_PRESETS)).toEqual(DEFAULT_SPLIT_PRESETS)
  })

  it('产出新数组/新对象(不许把 DEFAULT_SPLIT_PRESETS 的引用漏出去)', () => {
    const out = normalizeSplitPresets(DEFAULT_SPLIT_PRESETS)
    expect(out[0]).not.toBe(DEFAULT_SPLIT_PRESETS[0])
  })
})

describe('nextSplitPresetId', () => {
  it('取未占用的最小序号', () => {
    expect(nextSplitPresetId([])).toBe('p1')
    expect(nextSplitPresetId(['p1', 'p3'])).toBe('p2')
    expect(nextSplitPresetId(['p1', 'p2', 'p3'])).toBe('p4')
  })
})

describe('resolveSplitLevel / findSplitPreset', () => {
  const presets = normalizeSplitPresets([
    { id: 'wide', label: '宽', value: 75, unit: 'percent' },
    { id: 'fixed', label: '定宽', value: 900, unit: 'px' }
  ])

  it('findSplitPreset 命中 / 未命中', () => {
    expect(findSplitPreset(presets, 'wide')?.value).toBe(75)
    expect(findSplitPreset(presets, '不存在')).toBeNull()
    expect(findSplitPreset(presets, null)).toBeNull()
  })

  it('splitLevelOf 取「值 + 单位」快照', () => {
    expect(splitLevelOf(presets[1])).toEqual({ value: 900, unit: 'px' })
  })

  it('splitValueLabel', () => {
    expect(splitValueLabel({ value: 33, unit: 'percent' })).toBe('33%')
    expect(splitValueLabel({ value: 900, unit: 'px' })).toBe('900px')
  })

  it('matchSplitPreset 按值+单位反查(单位不同不算命中)', () => {
    expect(matchSplitPreset(presets, { value: 75, unit: 'percent' })?.id).toBe('wide')
    expect(matchSplitPreset(presets, { value: 75, unit: 'px' })).toBeNull()
    expect(matchSplitPreset(presets, null)).toBeNull()
  })
})

describe('computeSplitBounds', () => {
  it('50% = 两半等宽(百分比按去掉间隔后的可用宽度算)', () => {
    const geo = computeSplitBounds({ totalWidth: 1004, level: { value: 50, unit: 'percent' } })
    expect(geo).toEqual({ totalWidth: 1004, leftWidth: 500, gap: SPLIT_GAP })
    // 左右各 500 + 间隔 4 = 1004
    expect(geo!.leftWidth + SPLIT_GAP + geo!.leftWidth).toBe(1004)
  })

  it('比例越界按 clampSplitValue 夹紧(不是按窗格最小值)', () => {
    // 90% 生效而 99% 被夹成 90%(此处 minPane 不限:1996*0.9=1796 < 1996-120)
    const geo = computeSplitBounds({ totalWidth: 2000, level: { value: 99, unit: 'percent' } })!
    expect(geo.leftWidth).toBe(Math.round((2000 - SPLIT_GAP) * 0.9))
  })

  it('像素档是固定宽', () => {
    expect(computeSplitBounds({ totalWidth: 1200, level: { value: 800, unit: 'px' } })!.leftWidth).toBe(800)
  })

  it('像素档大于可用宽度 → 夹紧到「右窗格还剩 minPane」', () => {
    const geo = computeSplitBounds({ totalWidth: 800, level: { value: 4000, unit: 'px' } })!
    expect(geo.leftWidth).toBe(800 - SPLIT_GAP - SPLIT_MIN_PANE)
  })

  it('比例档在小窗上也保证两窗各不小于 minPane', () => {
    const geo = computeSplitBounds({ totalWidth: 400, level: { value: 90, unit: 'percent' } })!
    expect(geo.leftWidth).toBe(400 - SPLIT_GAP - SPLIT_MIN_PANE)
  })

  it('放不下两个最小窗格 → null(调用方退化为单窗格)', () => {
    expect(computeSplitBounds({ totalWidth: 200, level: { value: 50, unit: 'percent' } })).toBeNull()
    // avail = 总宽 - gap,恰好 2*minPane 是能分屏的最窄情形
    expect(computeSplitBounds({ totalWidth: 2 * SPLIT_MIN_PANE + SPLIT_GAP - 1, level: { value: 50, unit: 'percent' } })).toBeNull()
    expect(computeSplitBounds({ totalWidth: 2 * SPLIT_MIN_PANE + SPLIT_GAP, level: { value: 50, unit: 'percent' } })).toEqual({
      totalWidth: 2 * SPLIT_MIN_PANE + SPLIT_GAP,
      leftWidth: SPLIT_MIN_PANE,
      gap: SPLIT_GAP
    })
  })

  it('非有限 / 零宽度 → null', () => {
    expect(computeSplitBounds({ totalWidth: Number.NaN, level: DEFAULT_SPLIT_LEVEL })).toBeNull()
    expect(computeSplitBounds({ totalWidth: 0, level: DEFAULT_SPLIT_LEVEL })).toBeNull()
  })

  it('自定义 gap/minPane 生效', () => {
    const geo = computeSplitBounds({
      totalWidth: 1000,
      level: { value: 50, unit: 'percent' },
      gap: 20,
      minPane: 100
    })!
    expect(geo.gap).toBe(20)
    expect(geo.leftWidth).toBe(490)
  })
})

describe('emptySplitState', () => {
  it('每次都是新对象且字段齐全', () => {
    const a = emptySplitState()
    const b = emptySplitState()
    expect(a).not.toBe(b)
    expect(a).toEqual({
      active: false,
      leftTabId: null,
      rightTabId: null,
      level: null,
      presetId: null,
      leftWidth: null,
      gap: null
    })
  })
})
