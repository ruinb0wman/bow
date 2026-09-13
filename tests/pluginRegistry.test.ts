import { describe, expect, it, vi } from 'vitest'
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { PluginRegistry } from '../src/main/plugins/core'
import { McpHost } from '../src/main/plugins/mcpHost'
import type { PluginMain } from '../src/main/plugins/types'

function mod(id: string, capabilities: PluginMain['capabilities'] = []): PluginMain {
  return {
    manifest: { id, name: id, description: `${id} 描述`, version: '1.0.0' },
    capabilities,
    activate: () => {}
  }
}

describe('PluginRegistry', () => {
  it('按注册顺序列出,默认全部启用', () => {
    const r = new PluginRegistry()
    r.register(mod('b'))
    r.register(mod('a'))
    expect(r.ids()).toEqual(['b', 'a'])
    expect(r.enabledIds()).toEqual(['b', 'a'])
    expect(r.list().map((p) => p.id)).toEqual(['b', 'a'])
    expect(r.list().every((p) => p.enabled && p.builtin)).toBe(true)
  })

  it('id 非法或重复时抛错', () => {
    const r = new PluginRegistry()
    expect(() => r.register(mod('Bad_Id'))).toThrow(/非法/)
    r.register(mod('ok'))
    expect(() => r.register(mod('ok'))).toThrow(/重复/)
  })

  it('setDisabled 忽略未知 id,并投影到 list/enabledIds', () => {
    const r = new PluginRegistry()
    r.register(mod('a'))
    r.register(mod('b'))
    r.setDisabled(['b', 'ghost'])
    expect(r.enabledIds()).toEqual(['a'])
    expect(r.disabledIds()).toEqual(['b'])
    expect(r.list().find((p) => p.id === 'b')?.enabled).toBe(false)
  })

  it('setEnabledState 切换并保留顺序', () => {
    const r = new PluginRegistry()
    r.register(mod('a'))
    r.register(mod('b'))
    r.setEnabledState('a', false)
    r.setEnabledState('b', false)
    expect(r.disabledIds()).toEqual(['a', 'b'])
    r.setEnabledState('a', true)
    expect(r.disabledIds()).toEqual(['b'])
  })

  it('激活状态独立于启用状态', () => {
    const r = new PluginRegistry()
    r.register(mod('a'))
    expect(r.isActive('a')).toBe(false)
    r.setActive('a', true)
    expect(r.isActive('a')).toBe(true)
    expect(r.isEnabled('a')).toBe(true)
  })

  it('capabilities 拷贝隔离,manifest 字段被投影', () => {
    const r = new PluginRegistry()
    r.register(mod('a', ['ui', 'suggest']))
    const info = r.list()[0]
    expect(info.capabilities).toEqual(['ui', 'suggest'])
    expect(info.description).toBe('a 描述')
  })
})

describe('McpHost', () => {
  const spec = (pluginId: string, name: string) => ({
    pluginId,
    name,
    config: { description: name },
    handler: async () => ({ content: [] })
  })

  it('重名与核心保留名在注册时抛错', () => {
    const h = new McpHost()
    h.reserve(['browser_navigate'])
    expect(() => h.registerTool(spec('p', 'browser_navigate'))).toThrow(/核心冲突/)
    h.registerTool(spec('p', 'adblock_stats'))
    expect(() => h.registerTool(spec('q', 'adblock_stats'))).toThrow(/重复/)
    expect(h.names()).toEqual(['adblock_stats'])
  })

  it('attach 前缓冲、attach 时补注册,之后即时注册', () => {
    const h = new McpHost()
    const registered: string[] = []
    const make = (name: string): RegisteredTool => {
      registered.push(name)
      return { remove: vi.fn() } as unknown as RegisteredTool
    }
    h.registerTool(spec('p', 'one'))
    expect(registered).toEqual([])
    h.attach((s) => make(s.name))
    expect(registered).toEqual(['one'])
    h.registerTool(spec('q', 'two'))
    expect(registered).toEqual(['one', 'two'])
  })

  it('removeByPlugin 只移除该插件的工具并调用 handle.remove', () => {
    const h = new McpHost()
    const removed: string[] = []
    h.attach((s) => ({ remove: () => removed.push(s.name) }) as unknown as RegisteredTool)
    h.registerTool(spec('p', 'one'))
    h.registerTool(spec('p', 'two'))
    h.registerTool(spec('q', 'three'))
    h.removeByPlugin('p')
    expect(h.names()).toEqual(['three'])
    expect(removed.sort()).toEqual(['one', 'two'])
  })
})
