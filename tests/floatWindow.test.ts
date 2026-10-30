/**
 * 浮窗几何与设置归一:五个档位的位置、窗口小于默认尺寸时的夹取、脏配置的回落。
 *
 * 这几条都是「看起来对、实际错位」的判据:bounds 算错一格就是浮窗压住工具栏或糊出窗口;
 * 归一写松了会让「没配浮窗」的服务也冒出浮窗,写紧了会把用户配的尺寸吞掉。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FLOAT,
  FLOAT_GAP,
  FLOAT_MIN_HEIGHT,
  FLOAT_MIN_WIDTH,
  floatRect,
  normalizeFloatPrefs
} from '../src/shared/floatWindow'

const window = { windowWidth: 1280, windowHeight: 820, chromeHeight: 88 }
/** 页面区 = 820 - 88 = 732,居中时的 y */
const centeredY = 88 + (732 - 600) / 2

describe('浮窗几何', () => {
  it('默认居中 800x600,只落在页面区(chrome 之下)', () => {
    expect(floatRect({ ...window, placement: 'center', width: 800, height: 600 })).toEqual({
      x: 240,
      y: centeredY,
      width: 800,
      height: 600
    })
  })

  it('left / right 贴两侧、垂直居中', () => {
    expect(floatRect({ ...window, placement: 'left', width: 800, height: 600 })).toEqual({
      x: FLOAT_GAP,
      y: centeredY,
      width: 800,
      height: 600
    })
    expect(floatRect({ ...window, placement: 'right', width: 800, height: 600 })).toEqual({
      x: 1280 - 800 - FLOAT_GAP,
      y: centeredY,
      width: 800,
      height: 600
    })
  })

  it('top / bottom 水平居中、贴页面区上下边', () => {
    expect(floatRect({ ...window, placement: 'top', width: 800, height: 600 })).toEqual({
      x: 240,
      y: 88 + FLOAT_GAP,
      width: 800,
      height: 600
    })
    expect(floatRect({ ...window, placement: 'bottom', width: 800, height: 600 })).toEqual({
      x: 240,
      y: 820 - 600 - FLOAT_GAP,
      width: 800,
      height: 600
    })
  })

  it('窗口比请求的尺寸还小时按可用面积夹住,不溢出', () => {
    // 700 - 12*2 = 676;820 换 500:页面区 412,再留两边 gap = 388
    expect(floatRect({ placement: 'center', width: 800, height: 600, windowWidth: 700, windowHeight: 500, chromeHeight: 88 })).toEqual({
      x: 12,
      y: 88 + 12,
      width: 676,
      height: 388
    })
  })

  it('取整:setBounds 只吃整数', () => {
    const rect = floatRect({ placement: 'center', width: 801, height: 601, windowWidth: 1281, windowHeight: 821, chromeHeight: 87 })
    for (const value of Object.values(rect)) expect(Number.isInteger(value)).toBe(true)
  })
})

describe('浮窗设置归一', () => {
  it('没有配置 = 不用浮窗(null),不是默认值', () => {
    for (const raw of [undefined, null, 0, '', 'center', []]) expect(normalizeFloatPrefs(raw)).toBeNull()
  })

  it('配了但字段脏:回落默认(用户表达了要浮窗,别静默退化成选项卡)', () => {
    expect(normalizeFloatPrefs({})).toEqual(DEFAULT_FLOAT)
    expect(normalizeFloatPrefs({ placement: 'nope', width: 'abc', height: Number.NaN })).toEqual(DEFAULT_FLOAT)
  })

  it('合法值原样保留,越界夹进可用范围', () => {
    expect(normalizeFloatPrefs({ placement: 'left', width: 640, height: 480 })).toEqual({
      placement: 'left',
      width: 640,
      height: 480
    })
    expect(normalizeFloatPrefs({ placement: 'bottom', width: 10, height: 99999 })).toEqual({
      placement: 'bottom',
      width: FLOAT_MIN_WIDTH,
      height: 4000
    })
    expect(normalizeFloatPrefs({ width: 640 }).height).toBe(DEFAULT_FLOAT.height)
    expect(normalizeFloatPrefs({ height: 300 }).width).toBe(DEFAULT_FLOAT.width)
    expect(normalizeFloatPrefs({ width: 640 }).placement).toBe(DEFAULT_FLOAT.placement)
    expect(normalizeFloatPrefs({ width: 640, height: 100 }).height).toBe(FLOAT_MIN_HEIGHT)
  })
})
