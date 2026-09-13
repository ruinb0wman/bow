import { describe, expect, it } from 'vitest'
import { BROWSER_NAME, bowUserAgent } from '../src/shared/ua'

const UA_LINUX =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) mcp-browser/0.1.0 Chrome/134.0.6998.165 Electron/36.9.5 Safari/537.36'
const UA_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) mcp-browser/0.1.0 Chrome/134.0.6998.165 Electron/36.9.5 Safari/537.36'

describe('bowUserAgent 网站签名', () => {
  it('Linux UA:→ bow,无 Electron 与 mcp-browser,保留引擎令牌', () => {
    expect(bowUserAgent(UA_LINUX, 'mcp-browser', '0.1.0')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) bow/0.1.0 Chrome/134.0.6998.165 Safari/537.36'
    )
  })

  it('macOS UA:平台段保留,无 Electron 泄漏,无连续空格', () => {
    const out = bowUserAgent(UA_MAC, 'mcp-browser', '0.1.0')
    expect(out).toContain('(Macintosh; Intel Mac OS X 10_15_7)')
    expect(out).toContain('bow/0.1.0')
    expect(out).not.toMatch(/Electron/)
    expect(out).not.toContain('mcp-browser')
    expect(out).toMatch(/Chrome\/[\d.]+/)
    expect(out).toMatch(/Safari\/[\d.]+/)
    expect(out).not.toMatch(/\s{2,}/)
  })

  it('版本号跟随 appVersion', () => {
    expect(bowUserAgent(UA_LINUX, 'mcp-browser', '1.2.3')).toContain('bow/1.2.3')
  })

  it('UA 中无 appName 令牌时(no-op 分支)仍正确删除 Electron', () => {
    const bare = UA_LINUX.replace(' mcp-browser/0.1.0', '')
    const out = bowUserAgent(bare, 'mcp-browser', '0.1.0')
    expect(out).not.toMatch(/Electron/)
    expect(out).not.toContain('mcp-browser')
    expect(out).not.toMatch(/\s{2,}/)
  })

  it('BROWSER_NAME 常量为 bow', () => {
    expect(BROWSER_NAME).toBe('bow')
  })
})