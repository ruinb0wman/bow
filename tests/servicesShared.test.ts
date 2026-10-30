/**
 * 本地服务插件纯逻辑用例:设置归一、check 判定、标签页归属。
 *
 * 这几条都是「静默出错」的判据:归一写松了会把配置吞掉,`check` 写错了会在端口撞车时
 * 打开另一个项目的页面,标签页匹配写错了会叠出一堆重复标签。
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_SERVICES,
  checkMatches,
  commandChanged,
  normalizeSettings,
  serviceUrlMatches,
  type ServiceConfig
} from '../src/plugins/services/shared'

function make(raw: Partial<ServiceConfig> = {}): Record<string, unknown> {
  return {
    command: 'cd ~/Workspace/exp1 && bun dev',
    url: 'http://127.0.0.1:1420',
    ...raw
  }
}

describe('服务设置归一', () => {
  it('丢掉完全空的一行,保留只填了一半的', () => {
    const settings = normalizeSettings({
      services: [{ command: '', url: '' }, { command: 'bun dev', url: '' }, { command: '', url: '8080' }]
    })
    expect(settings.services).toHaveLength(2)
    expect(settings.services[0].command).toBe('bun dev')
    expect(settings.services[1].url).toBe('http://8080')
  })

  it('没写协议就补 http://', () => {
    expect(normalizeSettings({ services: [make({ url: '127.0.0.1:8080' })] }).services[0].url).toBe(
      'http://127.0.0.1:8080'
    )
  })

  it('浮窗:没配就不写这个键;配了原样保留;写脏了回落默认', () => {
    expect('float' in normalizeSettings({ services: [make()] }).services[0]).toBe(false)
    expect(
      normalizeSettings({ services: [make({ float: { placement: 'left', width: 640, height: 480 } })] }).services[0]
        .float
    ).toEqual({ placement: 'left', width: 640, height: 480 })
    // 配了但值不可用 = 用户要浮窗,回落默认而不是当成没配
    expect(normalizeSettings({ services: [make({ float: { placement: 'nope' } })] }).services[0].float).toEqual({
      placement: 'center',
      width: 800,
      height: 600
    })
    // 关掉开关的写法:键还在但值是 undefined → 等价于没配
    expect('float' in normalizeSettings({ services: [make({ float: undefined })] }).services[0]).toBe(false)
  })

  it('非 http(s) 的地址归一成空:行还在,起来时由 start() 报原因', () => {
    const settings = normalizeSettings({ services: [make({ url: 'ftp://x' }), make({ url: 'http://a' })] })
    expect(settings.services).toHaveLength(2)
    expect(settings.services[0].url).toBe('')
    expect(settings.services[1].url).toBe('http://a')
  })

  it('缺 id / id 重复都重新分配,且不与已用的撞车', () => {
    const settings = normalizeSettings({
      services: [make({ id: 'a' }), make({ id: 'a' }), make({ id: '有中文' })]
    })
    const ids = settings.services.map((s) => s.id)
    expect(ids[0]).toBe('a')
    expect(new Set(ids).size).toBe(3)
    expect(ids[2]).toMatch(/^s\d+$/)
  })

  it('autoStart 默认关(error 为零值时不能误判成开)', () => {
    const settings = normalizeSettings({ services: [make(), make({ autoStart: true })] })
    expect(settings.services[0].autoStart).toBe(false)
    expect(settings.services[1].autoStart).toBe(true)
  })

  it('名字缺失时用地址兜底,图标名不合法回落 Play', () => {
    const settings = normalizeSettings({ services: [make({ icon: '不是 合法 $ 名字' })] })
    expect(settings.services[0].name).toBe('127.0.0.1:1420')
    expect(settings.services[0].icon).toBe('Play')
  })

  it('条数封顶,不是设置页那种软限制', () => {
    const many = Array.from({ length: MAX_SERVICES + 3 }, (_, i) => make({ id: `s${i}` }))
    expect(normalizeSettings({ services: many }).services).toHaveLength(MAX_SERVICES)
  })

  it('输入不是对象也不抛', () => {
    expect(normalizeSettings(null).services).toEqual([])
    expect(normalizeSettings('nope').services).toEqual([])
    expect(normalizeSettings({ services: 'x' }).services).toEqual([])
  })
})

describe('check 判定', () => {
  it('没填 check = 通了就算', () => {
    expect(checkMatches('<html>随便什么</html>', '')).toBe(true)
    expect(checkMatches('', '   ')).toBe(true)
  })

  it('填了就要求真的出现', () => {
    expect(checkMatches('<title>exp1</title>', 'exp1')).toBe(true)
    expect(checkMatches('<title>aict1</title>', 'exp1')).toBe(false)
  })
})

describe('标签页归属', () => {
  it('尾斜杠不影响判定', () => {
    expect(serviceUrlMatches('http://127.0.0.1:8080/', 'http://127.0.0.1:8080')).toBe(true)
    expect(serviceUrlMatches('http://127.0.0.1:8080', 'http://127.0.0.1:8080/')).toBe(true)
  })

  it('子路径算同一条服务,不同端口/前缀相似的地址不算', () => {
    expect(serviceUrlMatches('http://127.0.0.1:8080/docs', 'http://127.0.0.1:8080')).toBe(true)
    expect(serviceUrlMatches('http://127.0.0.1:80800', 'http://127.0.0.1:8080')).toBe(false)
    expect(serviceUrlMatches('http://127.0.0.1:8081', 'http://127.0.0.1:8080')).toBe(false)
  })

  it('空地址不匹配任何标签页', () => {
    expect(serviceUrlMatches('http://127.0.0.1:8080', '')).toBe(false)
  })
})

describe('改动是否影响正在跑的进程', () => {
  const base: ServiceConfig = {
    id: 'a',
    name: 'a',
    icon: 'Play',
    command: 'bun dev',
    url: 'http://127.0.0.1:1420',
    check: '',
    autoStart: false
  }

  it('改名字/图标/check 不算,改命令或地址算', () => {
    expect(commandChanged(base, { ...base, name: 'b' })).toBe(false)
    expect(commandChanged(base, { ...base, icon: 'Globe' })).toBe(false)
    expect(commandChanged(base, { ...base, check: 'exp1' })).toBe(false)
    expect(commandChanged(base, { ...base, command: 'bun dev --port 1421' })).toBe(true)
    expect(commandChanged(base, { ...base, url: 'http://127.0.0.1:1421' })).toBe(true)
  })
})
