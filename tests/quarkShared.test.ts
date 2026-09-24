/**
 * 夸克插件纯逻辑用例。
 *
 * 这些判据错的表现都是「面板上看不出来但推送就是不行」:
 * URL 判定错 → 按钮在错误的页面可用;body/headers 错 → 接口 403;
 * 响应解析错 → 把风控页当成功;aria2 请求构造错 → aria2 拿不到链接或下载 403。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QUARK_SETTINGS,
  QUARK_CODE,
  QUARK_UA_DEFAULT,
  aria2RpcUrl,
  buildApiHeaders,
  buildAria2Headers,
  buildAria2RpcBody,
  buildDownloadBody,
  chunk,
  cookieHeaderFrom,
  describeLinkHosts,
  extractFidFromMessage,
  formatBytes,
  isCookieHostAllowed,
  isQuarkHomeUrl,
  normalizeHostList,
  normalizePageSnapshot,
  normalizePort,
  normalizeQuarkSettings,
  parseDownloadResponse,
  pickFiles,
  sanitizeFilename,
  type QuarkSettings
} from '../src/plugins/quark/shared'

const FID = 'a'.repeat(32)

describe('夸克:URL 判定', () => {
  it('个人网盘页命中', () => {
    expect(isQuarkHomeUrl('https://pan.quark.cn/list#/list/all')).toBe(true)
    expect(isQuarkHomeUrl('https://pan.quark.cn/')).toBe(true)
    expect(isQuarkHomeUrl('https://pan.quark.cn/list#/list/all?pdir_fid=abc')).toBe(true)
    expect(isQuarkHomeUrl('https://drive.quark.cn/list#/list/all')).toBe(true)
    expect(isQuarkHomeUrl('http://pan.quark.cn/list')).toBe(true)
  })

  it('分享页明确排除(本次范围外)', () => {
    expect(isQuarkHomeUrl('https://pan.quark.cn/s/abcdef123456')).toBe(false)
    expect(isQuarkHomeUrl('https://pan.quark.cn/share/abcdef123456')).toBe(false)
    expect(isQuarkHomeUrl('https://pan.quark.cn/embed/abcdef')).toBe(false)
  })

  it('非夸克 / 坏输入一律 false', () => {
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'not a url',
      'file:///etc/passwd',
      'https://pan.quark.cn.evil.com/list',
      'https://notquark.cn/list',
      'https://quark.com/list',
      'https://drive-pc.quark.cn/list'
    ]) {
      expect(isQuarkHomeUrl(bad as unknown), String(bad)).toBe(false)
    }
  })
})

describe('夸克:Cookie 域名白名单', () => {
  const hosts = ['quark.cn', 'uc.cn']

  it('命中域本身与子域', () => {
    expect(isCookieHostAllowed('cdn-1.quark.cn', hosts)).toBe(true)
    expect(isCookieHostAllowed('quark.cn', hosts)).toBe(true)
    expect(isCookieHostAllowed('pds.uc.cn', hosts)).toBe(true)
  })

  it('后缀欺骗与第三方一律不命中', () => {
    expect(isCookieHostAllowed('quark.cn.evil.com', hosts)).toBe(false)
    expect(isCookieHostAllowed('bucket.aliyuncs.com', hosts)).toBe(false)
    expect(isCookieHostAllowed('notquark.cn', hosts)).toBe(false)
  })

  it('空白名单恒 false', () => {
    expect(isCookieHostAllowed('quark.cn', [])).toBe(false)
    expect(isCookieHostAllowed('quark.cn', ['', '  '])).toBe(false)
  })
})

describe('夸克:请求构造', () => {
  it('cookieHeaderFrom 拼装与容错', () => {
    expect(cookieHeaderFrom([{ name: 'a', value: '1' }, { name: 'b', value: '2' }])).toBe('a=1; b=2')
    expect(cookieHeaderFrom([])).toBe('')
    expect(cookieHeaderFrom(null)).toBe('')
    expect(cookieHeaderFrom([{ name: '', value: 'x' }, { name: 'ok', value: undefined }])).toBe('ok=')
    expect(cookieHeaderFrom([{ name: 1, value: 'x' }] as unknown as Array<{ name: string }>)).toBe('')
  })

  it('buildApiHeaders:伪装 UA + JSON + Referer;有 cookie 才带 Cookie;绝不带 Origin', () => {
    const noCookie = buildApiHeaders({ ua: 'UA' })
    expect(noCookie['User-Agent']).toBe('UA')
    expect(noCookie['Content-Type']).toBe('application/json')
    expect(noCookie.Referer).toBe('https://pan.quark.cn/')
    expect(noCookie).not.toHaveProperty('Cookie')
    // 实测:net.fetch 带 Origin 必定 net::ERR_FAILED(它是 fetch 的 forbidden header)
    expect(noCookie).not.toHaveProperty('Origin')

    const withCookie = buildApiHeaders({ ua: 'UA', cookie: 'a=1' })
    expect(withCookie.Cookie).toBe('a=1')
  })

  it('buildAria2Headers:只给 UA + Referer;Cookie 由调用方按白名单补', () => {
    const h = buildAria2Headers({ ua: 'UA' })
    expect(h).toEqual({ 'User-Agent': 'UA', Referer: 'https://pan.quark.cn/' })
    expect(h).not.toHaveProperty('Cookie')
  })

  it('buildDownloadBody:个人网盘页只要 fids', () => {
    expect(buildDownloadBody(['x', 'y'])).toEqual({ fids: ['x', 'y'] })
    expect(Object.keys(buildDownloadBody([FID]))).toEqual(['fids'])
  })
})

describe('夸克:响应解析', () => {
  it('code=0 正常返回,并算出 host', () => {
    const r = parseDownloadResponse({
      code: 0,
      data: [
        { fid: FID, file_name: 'a.mkv', size: 123, download_url: 'https://cdn-1.quark.cn/f/a.mkv?sig=x' },
        { fid: 'b'.repeat(32), file_name: 'no-url.bin', size: 1 }
      ]
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.links).toHaveLength(2)
    expect(r.links[0]).toMatchObject({ fid: FID, name: 'a.mkv', size: 123, host: 'cdn-1.quark.cn' })
    // 缺 download_url 的条目保留(url 为空),让面板能显示「这个没拿到链接」
    expect(r.links[1]).toMatchObject({ name: 'no-url.bin', url: '', host: '' })
  })

  it('31001 → 未登录', () => {
    const r = parseDownloadResponse({ code: 31001, message: 'require login' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('not-logged-in')
    expect(r.code).toBe(QUARK_CODE.notLoggedIn)
  })

  it('23018 → 游客超限,并从 message 抠出 fid', () => {
    const r = parseDownloadResponse({ code: 23018, message: `guest size limit exceeded [${FID}]` })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('guest-size-limit')
    expect(r.fid).toBe(FID)
  })

  it('extractFidFromMessage:大小写 hex 都认,取不到返回 undefined', () => {
    expect(extractFidFromMessage(`[${FID}]`)).toBe(FID)
    expect(extractFidFromMessage(`[${'AB12'.repeat(8)}]`)).toBe('AB12'.repeat(8))
    expect(extractFidFromMessage('no fid here')).toBeUndefined()
    expect(extractFidFromMessage('[tooshort]')).toBeUndefined()
  })

  it('其它非 0 code → api-error,保留 code 与 message', () => {
    const r = parseDownloadResponse({ code: 99999, message: 'boom' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('api-error')
    expect(r.code).toBe(99999)
    expect(r.message).toBe('boom')
  })

  it('结构不对 → malformed(不能把风控页当成功)', () => {
    for (const bad of [undefined, null, 'html', [], {}, { code: 0 }, { code: 0, data: {} }, { message: 'x' }]) {
      const r = parseDownloadResponse(bad)
      expect(r.ok, JSON.stringify(bad)).toBe(false)
      if (!r.ok) expect(r.reason).toBe('malformed')
    }
  })
})

describe('夸克:分批', () => {
  it('按 15 切,边界正确', () => {
    expect(chunk([], 15)).toEqual([])
    expect(chunk(['a'], 15)).toEqual([['a']])
    expect(chunk(Array.from({ length: 15 }, (_, i) => i), 15)).toHaveLength(1)
    expect(chunk(Array.from({ length: 16 }, (_, i) => i), 15).map((c) => c.length)).toEqual([15, 1])
    expect(chunk(Array.from({ length: 31 }, (_, i) => i), 15).map((c) => c.length)).toEqual([15, 15, 1])
  })

  it('非法 size 退化为 1(不丢数据,只是慢)', () => {
    expect(chunk(['a', 'b'], 0).map((c) => c.length)).toEqual([1, 1])
    expect(chunk(['a', 'b'], -3).map((c) => c.length)).toEqual([1, 1])
    expect(chunk(['a', 'b'], NaN).map((c) => c.length)).toEqual([1, 1])
  })
})

describe('夸克:页面快照归一', () => {
  const good = {
    ok: true,
    url: 'https://pan.quark.cn/list',
    folderName: '我的资源',
    files: [
      { fid: FID, name: 'a.mkv', size: 10, isFile: true },
      { fid: 'd'.repeat(32), name: 'dir', size: 0, isFile: false }
    ],
    selected: [FID, 42],
    diagnostics: { selector: '.file-list', classList: 'file-list x', fiberKeyPrefix: '__reactFiber$', listLength: 2, propKeys: ['list', 'stoken'], stage: 'done' }
  }

  it('合法快照原样归一,selected 过滤非字符串', () => {
    const r = normalizePageSnapshot(good)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.snapshot.files).toHaveLength(2)
    expect(r.snapshot.selected).toEqual([FID])
    expect(r.snapshot.diagnostics.propKeys).toEqual(['list', 'stoken'])
  })

  it('ok:false 时把诊断信息带出来(排查结构漂移全靠它)', () => {
    const r = normalizePageSnapshot({ ok: false, error: '没找到文件列表容器', diagnostics: good.diagnostics })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('没找到文件列表容器')
    expect(r.diagnostics?.selector).toBe('.file-list')
  })

  it('空列表 / 坏输入都算失败,不返回空快照', () => {
    expect(normalizePageSnapshot({ ok: true, files: [] }).ok).toBe(false)
    expect(normalizePageSnapshot(undefined).ok).toBe(false)
    expect(normalizePageSnapshot('x').ok).toBe(false)
  })

  it('缺 fid 的条目被丢掉,缺字段用兜底值', () => {
    const r = normalizePageSnapshot({ ok: true, files: [{ fid: '  ' }, { fid: FID }] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.snapshot.files).toEqual([{ fid: FID, name: FID, size: 0, isFile: true }])
  })

  it('pickFiles 只留文件', () => {
    const r = normalizePageSnapshot(good)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(pickFiles(r.snapshot.files).map((f) => f.name)).toEqual(['a.mkv'])
  })
})

describe('夸克:文件名与 aria2 请求构造', () => {
  it('sanitizeFilename 去掉文件系统非法字符与首尾点空白', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j.mkv')).toBe('a_b_c_d_e_f_g_h_i_j.mkv')
    expect(sanitizeFilename('  ..name..  ')).toBe('name')
    expect(sanitizeFilename('a\u0000b')).toBe('a_b')
    expect(sanitizeFilename('')).toBe('download')
    expect(sanitizeFilename('   ')).toBe('download')
    expect(sanitizeFilename('正常文件名 中文.mkv')).toBe('正常文件名 中文.mkv')
  })

  it('buildAria2RpcBody:token 前缀与 header 数组,dir 为空则不传', () => {
    const settings = { ...DEFAULT_QUARK_SETTINGS.aria2, token: 'secret', dir: '' }
    const body = buildAria2RpcBody({ url: 'https://x/a', filename: 'a.mkv', headers: { 'User-Agent': 'ua' }, settings, id: 1 })
    expect(body).toMatchObject({ id: 1, jsonrpc: '2.0', method: 'aria2.addUri' })
    const params = body.params as unknown[]
    expect(params[0]).toBe('token:secret')
    expect(params[1]).toEqual(['https://x/a'])
    expect(params[2]).toEqual({ out: 'a.mkv', header: ['User-Agent:ua'] })

    const withDir = buildAria2RpcBody({
      url: 'https://x/a',
      filename: 'a.mkv',
      headers: {},
      settings: { ...settings, dir: '/downloads' }
    })
    expect((withDir.params as unknown[])[2]).toMatchObject({ dir: '/downloads' })
  })

  it('aria2RpcUrl 拼接与容错', () => {
    expect(aria2RpcUrl(DEFAULT_QUARK_SETTINGS.aria2)).toBe('http://localhost:16800/jsonrpc')
    expect(aria2RpcUrl({ ...DEFAULT_QUARK_SETTINGS.aria2, domain: 'http://127.0.0.1/', path: 'jsonrpc' })).toBe(
      'http://127.0.0.1:16800/jsonrpc'
    )
    expect(aria2RpcUrl({ ...DEFAULT_QUARK_SETTINGS.aria2, path: '' })).toBe('http://localhost:16800/jsonrpc')
  })
})

describe('夸克:设置归一', () => {
  const prev: QuarkSettings = DEFAULT_QUARK_SETTINGS

  it('坏输入一律回退 prev(不跳默认值)', () => {
    const s = normalizeQuarkSettings({ userAgent: '', cookieHosts: 42, aria2: 'nope' }, prev)
    expect(s.userAgent).toBe(prev.userAgent)
    expect(s.cookieHosts).toEqual(prev.cookieHosts)
    expect(s.aria2).toEqual(prev.aria2)
  })

  it('userAgent 去空白;空串不覆盖', () => {
    expect(normalizeQuarkSettings({ userAgent: '  UA/9.9  ' }, prev).userAgent).toBe('UA/9.9')
    expect(normalizeQuarkSettings({ userAgent: '   ' }, prev).userAgent).toBe(prev.userAgent)
  })

  it('cookieHosts 接受数组或逗号分隔字符串,去重去空、剥协议与路径', () => {
    expect(normalizeQuarkSettings({ cookieHosts: ['quark.cn', 'quark.cn', ' uc.cn '] }, prev).cookieHosts).toEqual([
      'quark.cn',
      'uc.cn'
    ])
    expect(normalizeQuarkSettings({ cookieHosts: 'quark.cn, https://cdn.x.com/path' }, prev).cookieHosts).toEqual([
      'quark.cn',
      'cdn.x.com'
    ])
    // 全空 → 回退默认,不允许出现「空白名单」这种静默失效
    expect(normalizeQuarkSettings({ cookieHosts: [] }, prev).cookieHosts).toEqual(prev.cookieHosts)
    expect(normalizeQuarkSettings({ cookieHosts: ['', '  '] }, prev).cookieHosts).toEqual(prev.cookieHosts)
  })

  it('normalizePort 夹紧', () => {
    expect(normalizePort('16800', '1')).toBe('16800')
    expect(normalizePort(6800, '1')).toBe('6800')
    expect(normalizePort('0', '999')).toBe('999')
    expect(normalizePort('70000', '999')).toBe('999')
    expect(normalizePort('abc', '999')).toBe('999')
    expect(normalizePort('', '999')).toBe('999')
    expect(normalizePort('12.5', '999')).toBe('999')
  })

  it('normalizeHostList 兜底', () => {
    expect(normalizeHostList(undefined, ['d'])).toEqual(['d'])
    expect(normalizeHostList(null, ['d'])).toEqual(['d'])
    expect(normalizeHostList('', ['d'])).toEqual(['d'])
  })

  it('formatBytes 复用 downloads 的实现', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
  })
})

describe('夸克:诊断摘要', () => {
  it('按域名聚合计数,降序', () => {
    const links = [
      { fid: '1', name: 'a', size: 0, url: 'https://cdn-1.quark.cn/a', host: 'cdn-1.quark.cn' },
      { fid: '2', name: 'b', size: 0, url: 'https://cdn-1.quark.cn/b', host: 'cdn-1.quark.cn' },
      { fid: '3', name: 'c', size: 0, url: '', host: '' }
    ]
    expect(describeLinkHosts(links)).toEqual([
      { host: 'cdn-1.quark.cn', count: 2 },
      { host: '(无链接)', count: 1 }
    ])
  })
})

describe('夸克:UA 默认值', () => {
  it('默认 UA 是夸克 PC 客户端形态(接口与 CDN 都靠它)', () => {
    expect(QUARK_UA_DEFAULT).toContain('quark-cloud-drive/')
    expect(QUARK_UA_DEFAULT).toContain('Electron/')
    expect(DEFAULT_QUARK_SETTINGS.userAgent).toBe(QUARK_UA_DEFAULT)
  })
})
