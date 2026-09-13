/**
 * 广告/追踪拦截参考插件:验证四类扩展点中的网络、内容与 MCP 钩子。
 * - net:onBeforeRequest 命中静态主机清单即取消(不拦主文档);
 * - content:dom-ready 注入 CSS 隐藏常见广告位 + JS 标记;
 * - mcp:adblock_stats 暴露拦截统计;
 * - ui:设置分区(开关 / 命中数 / 清单)。
 */

import type { NetHookContext } from '@shared/plugins'
import { textContent } from '../../main/plugins/mcpResult'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import { DEFAULT_BLOCKLIST, HIDE_ADS_CSS, isBlockedUrl, MARK_ADS_JS } from './rules'

export interface AdblockState {
  enabled: boolean
  blockedCount: number
  rules: string[]
}

function createAdblockPlugin(): PluginMain {
  let store: PluginStorage<AdblockState> | null = null
  // 计数在内存中累加,避免每个被拦请求都写盘
  let liveCount = 0

  const flush = (): void => {
    if (store && store.get().blockedCount !== liveCount) store.set({ blockedCount: liveCount })
  }

  return {
    manifest: {
      id: 'adblock',
      name: '广告/追踪拦截(参考)',
      description: '静态主机清单拦截 + 常见广告位隐藏,演示网络/内容/MCP 扩展点',
      version: '1.0.0'
    },
    capabilities: ['ui', 'net', 'content', 'mcp'],

    activate(ctx: PluginContext): void {
      const s = ctx.storage<AdblockState>({
        file: 'adblock.json',
        defaults: { enabled: true, blockedCount: 0, rules: DEFAULT_BLOCKLIST }
      })
      store = s
      liveCount = s.get().blockedCount

      ctx.net.onBeforeRequest((c: NetHookContext) => {
        if (!s.get().enabled) return
        if (c.resourceType === 'mainFrame') return // 不拦主文档,避免整页打不开
        if (!isBlockedUrl(c.url, s.get().rules)) return
        liveCount += 1
        c.cancel()
      })

      ctx.content.inject({
        id: 'hide-ads',
        matches: ['<all_urls>'],
        runAt: 'dom-ready',
        css: HIDE_ADS_CSS,
        js: MARK_ADS_JS
      })

      const state = (): AdblockState => ({ ...s.get(), blockedCount: liveCount })

      ctx.ipc.handle('getState', (): AdblockState => state())
      ctx.ipc.handle('setEnabled', (enabled: boolean): AdblockState => {
        s.set({ enabled: !!enabled })
        ctx.ipc.emit('changed', state())
        return state()
      })
      ctx.ipc.handle('resetCount', (): AdblockState => {
        liveCount = 0
        s.set({ blockedCount: 0 })
        ctx.ipc.emit('changed', state())
        return state()
      })

      ctx.mcp.tool('adblock_stats', { description: '返回广告/追踪拦截统计' }, async () =>
        textContent({
          ok: true,
          enabled: s.get().enabled,
          blockedCount: liveCount,
          ruleCount: s.get().rules.length,
          rules: s.get().rules
        })
      )
    },

    deactivate(): void {
      flush()
    }
  }
}

export default createAdblockPlugin()
