import { describe, expect, it } from 'vitest'
import {
  INTERNAL_PAGES,
  LOGSEQ_URL,
  SETTINGS_URL,
  TERMINAL_URL,
  internalPageTitle,
  internalPageUrl,
  isInternalUrl,
  opensInPane,
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

  it('终端页也登记为内部页面(入口名与 id 同名)', () => {
    expect(parseInternalUrl(TERMINAL_URL)).toBe('terminal')
    expect(internalPageUrl('terminal')).toBe(TERMINAL_URL)
    expect(internalPageTitle('terminal')).toBe('终端')
    expect(INTERNAL_PAGES.terminal.entry).toBe('terminal')
  })

  it('笔记页也登记为内部页面(入口名与 id 同名)', () => {
    expect(parseInternalUrl(LOGSEQ_URL)).toBe('logseq')
    expect(internalPageUrl('logseq')).toBe(LOGSEQ_URL)
    expect(internalPageTitle('logseq')).toBe('笔记')
    expect(INTERNAL_PAGES.logseq.entry).toBe('logseq')
  })

  it('笔记页与终端同轴:可多开 + 顶替聚焦窗格(每个窗格一个编辑器实例)', () => {
    expect(INTERNAL_PAGES.logseq.singleton).toBe(false)
    expect(INTERNAL_PAGES.logseq.openIn).toBe('pane')
    expect(opensInPane('logseq')).toBe(true)
  })

  it('singleton 决定 openInternal 的语义:设置页单例、终端可多开', () => {
    expect(INTERNAL_PAGES.settings.singleton).toBe(true)
    expect(INTERNAL_PAGES.terminal.singleton).toBe(false)
  })

  it('openIn 决定地址栏通路:终端顶替聚焦窗格、设置页新标签', () => {
    expect(INTERNAL_PAGES.terminal.openIn).toBe('pane')
    expect(INTERNAL_PAGES.settings.openIn).toBe('tab')
    expect(opensInPane('terminal')).toBe(true)
    expect(opensInPane('settings')).toBe(false)
  })

  it('每个内部页面都有渲染入口名', () => {
    for (const page of Object.values(INTERNAL_PAGES)) {
      expect(page.entry.length).toBeGreaterThan(0)
      expect(page.title.length).toBeGreaterThan(0)
    }
    // 入口名必须与 `RendererEntryName` / vite 的 rollupOptions.input 一一对应(entry 就是文件名)
    expect(Object.values(INTERNAL_PAGES).map((p) => p.entry)).toEqual(['settings', 'terminal', 'logseq'])
  })
})
