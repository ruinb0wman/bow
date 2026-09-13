import { describe, expect, it } from 'vitest'
import {
  INTERNAL_PAGES,
  SETTINGS_URL,
  internalPageTitle,
  internalPageUrl,
  isInternalUrl,
  parseInternalUrl
} from '../src/shared/internalPages'

describe('内部页面 URL 解析', () => {
  it('识别 bow://settings 与带尾斜杠形式', () => {
    expect(parseInternalUrl(SETTINGS_URL)).toBe('settings')
    expect(parseInternalUrl('bow://settings/')).toBe('settings')
    expect(parseInternalUrl('  bow://settings  ')).toBe('settings')
  })

  it('scheme 与 host 大小写不敏感', () => {
    expect(parseInternalUrl('BOW://Settings')).toBe('settings')
    expect(parseInternalUrl('BoW://SETTINGS/')).toBe('settings')
  })

  it('忽略查询串与 hash', () => {
    expect(parseInternalUrl('bow://settings?x=1')).toBe('settings')
    expect(parseInternalUrl('bow://settings/#/plugins')).toBe('settings')
  })

  it('未知 host / 非 // 形式 / 其它 scheme 均不识别', () => {
    expect(parseInternalUrl('bow://other')).toBe(null)
    expect(parseInternalUrl('bow:settings')).toBe(null)
    expect(parseInternalUrl('bow://settings/extra')).toBe(null)
    expect(parseInternalUrl('https://example.com')).toBe(null)
    expect(parseInternalUrl('about:blank')).toBe(null)
    expect(parseInternalUrl('')).toBe(null)
  })

  it('http(s) 站点里出现的 bow:// 字符串不被误判', () => {
    expect(parseInternalUrl('https://example.com/?next=bow://settings')).toBe(null)
  })

  it('isInternalUrl 与 parseInternalUrl 一致', () => {
    expect(isInternalUrl(SETTINGS_URL)).toBe(true)
    expect(isInternalUrl('https://example.com')).toBe(false)
  })
})

describe('内部页面登记', () => {
  it('id → URL / 标题 / 入口 往返一致', () => {
    expect(internalPageUrl('settings')).toBe(SETTINGS_URL)
    expect(internalPageTitle('settings')).toBe('设置')
    expect(INTERNAL_PAGES.settings.entry).toBe('settings')
  })
})
