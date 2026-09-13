/**
 * 广告/追踪拦截插件:网络规则 + 元素规则,支持编辑、导入导出与页面框选。
 *
 * - net:onBeforeRequest 按网络规则(block/allow)拦截子资源,不拦主文档;
 * - content:按页面 host 动态注入元素隐藏 CSS(dom-ready),规则变更后可 refresh 立即生效;
 * - ipc:渲染层设置面板的规则 CRUD / 文本规则 / 导入导出 / 框选入口;
 * - mcp:统计与规则管理工具;
 * - pages:调用内核页面执行 API 注入框选器,人类点选后生成元素规则。
 */

import { z } from 'zod'
import type { NetHookContext } from '@shared/plugins'
import {
  buildCosmeticCss,
  createCosmeticRule,
  createDefaultCosmeticRules,
  createDefaultNetworkRules,
  createNetworkRule,
  dedupeCosmeticRules,
  dedupeNetworkRules,
  isNetworkBlocked,
  migrateConfig,
  normalizeRuleDomain,
  parseRuleText,
  sameCosmeticRule,
  sameNetworkRule,
  serializeRuleText
} from '@shared/adblock'
import type { AdblockConfig, CosmeticRule, CosmeticRuleType, NetworkRule, NetworkRuleType } from '@shared/adblock'
import { hostOf } from '@shared/pluginMatch'
import { textContent } from '../../main/plugins/mcpResult'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import { PICKER_JS, PICKER_TEARDOWN_JS } from './picker'

/** 内容注入标记:便于页面侧/调试观察插件是否生效 */
export const MARK_ADS_JS = "document.documentElement.setAttribute('data-bow-adblock', '1')"

export interface AdblockState {
  enabled: boolean
  blockedCount: number
  networkRules: NetworkRule[]
  cosmeticRules: CosmeticRule[]
  stats: { network: number; cosmetic: number; user: number }
}

interface AddNetworkInput {
  type?: string
  pattern?: string
  enabled?: boolean
  note?: string
}

interface UpdateNetworkInput {
  id: string
  type?: string
  pattern?: string
  enabled?: boolean
  note?: string
}

interface AddCosmeticInput {
  type?: string
  domain?: string
  selector?: string
  enabled?: boolean
  note?: string
}

interface UpdateCosmeticInput {
  id: string
  type?: string
  domain?: string
  selector?: string
  enabled?: boolean
  note?: string
}

function statsOf(cfg: AdblockConfig): AdblockState['stats'] {
  const user =
    cfg.networkRules.filter((r) => r.source !== 'builtin').length +
    cfg.cosmeticRules.filter((r) => r.source !== 'builtin').length
  return { network: cfg.networkRules.length, cosmetic: cfg.cosmeticRules.length, user }
}

function createAdblockPlugin(): PluginMain {
  let store: PluginStorage<AdblockConfig> | null = null
  let liveCount = 0
  const picking = new Set<number>()
  let cssCache = new Map<string, string>()

  return {
    manifest: {
      id: 'adblock',
      name: '广告/追踪拦截',
      description: '网络 + 元素规则拦截,规则可编辑,支持页面框选隐藏元素',
      version: '2.0.0'
    },
    capabilities: ['ui', 'net', 'content', 'mcp'],

    activate(ctx: PluginContext): void {
      // 默认值仅作占位:真实配置一律经 migrateConfig 生成,以正确识别 v1 旧数据
      const s = ctx.storage<AdblockConfig>({
        file: 'adblock.json',
        defaults: { version: 0 } as unknown as AdblockConfig
      })
      store = s
      const migrated = migrateConfig(s.get())
      s.setRaw(migrated)
      liveCount = migrated.blockedCount

      const clearCssCache = (): void => {
        cssCache = new Map()
      }

      const save = (patch: Partial<AdblockConfig>): void => {
        s.setRaw({ ...s.get(), ...patch })
      }

      const state = (): AdblockState => {
        const cfg = s.get()
        return {
          enabled: cfg.enabled,
          blockedCount: liveCount,
          networkRules: cfg.networkRules.map((r) => ({ ...r })),
          cosmeticRules: cfg.cosmeticRules.map((r) => ({ ...r })),
          stats: statsOf(cfg)
        }
      }

      const emitChanged = (): AdblockState => {
        const st = state()
        ctx.ipc.emit('changed', st)
        return st
      }

      // ---------- 规则操作(IPC 与 MCP 共用) ----------

      const addNetworkRule = (input: AddNetworkInput): NetworkRule => {
        const pattern = String(input.pattern ?? '').trim()
        if (!pattern) throw new Error('规则模式不能为空')
        const type: NetworkRuleType = input.type === 'allow' ? 'allow' : 'block'
        const cfg = s.get()
        const existing = cfg.networkRules.find((r) => sameNetworkRule(r, { type, pattern }))
        if (existing) return existing
        const rule = createNetworkRule(type, pattern, { enabled: input.enabled ?? true, note: input.note })
        save({ networkRules: [...cfg.networkRules, rule] })
        return rule
      }

      const addCosmeticRule = (input: AddCosmeticInput): CosmeticRule => {
        const selector = String(input.selector ?? '').trim()
        if (!selector) throw new Error('CSS 选择器不能为空')
        const domain = normalizeRuleDomain(String(input.domain ?? '*')) || '*'
        const type: CosmeticRuleType = input.type === 'unhide' ? 'unhide' : 'hide'
        const cfg = s.get()
        const existing = cfg.cosmeticRules.find((r) => sameCosmeticRule(r, { type, domain, selector }))
        if (existing) return existing
        const rule = createCosmeticRule(type, domain, selector, { enabled: input.enabled ?? true, note: input.note })
        save({ cosmeticRules: [...cfg.cosmeticRules, rule] })
        return rule
      }

      const updateNetworkRule = (input: UpdateNetworkInput): void => {
        const cfg = s.get()
        save({
          networkRules: dedupeNetworkRules(
            cfg.networkRules.map((r) => {
              if (r.id !== input.id) return r
              return {
                ...r,
                pattern:
                  typeof input.pattern === 'string' && input.pattern.trim() ? input.pattern.trim() : r.pattern,
                type: input.type === 'allow' ? 'allow' : input.type === 'block' ? 'block' : r.type,
                enabled: typeof input.enabled === 'boolean' ? input.enabled : r.enabled,
                note: typeof input.note === 'string' ? input.note : r.note
              }
            })
          )
        })
      }

      const updateCosmeticRule = (input: UpdateCosmeticInput): void => {
        const cfg = s.get()
        save({
          cosmeticRules: dedupeCosmeticRules(
            cfg.cosmeticRules.map((r) => {
              if (r.id !== input.id) return r
              return {
                ...r,
                selector:
                  typeof input.selector === 'string' && input.selector.trim() ? input.selector.trim() : r.selector,
                domain:
                  typeof input.domain === 'string' && input.domain.trim()
                    ? normalizeRuleDomain(input.domain) || '*'
                    : r.domain,
                type: input.type === 'unhide' ? 'unhide' : input.type === 'hide' ? 'hide' : r.type,
                enabled: typeof input.enabled === 'boolean' ? input.enabled : r.enabled,
                note: typeof input.note === 'string' ? input.note : r.note
              }
            })
          )
        })
      }

      // ---------- 网络钩子 ----------

      ctx.net.onBeforeRequest((c: NetHookContext) => {
        const cfg = s.get()
        if (!cfg.enabled) return
        if (c.resourceType === 'mainFrame') return // 不拦主文档,避免整页打不开
        if (!isNetworkBlocked(c.url, cfg.networkRules)) return
        liveCount += 1
        c.cancel()
      })

      // ---------- 内容注入(按 host 动态生成元素隐藏 CSS) ----------

      const cssFor = (url: string): string | undefined => {
        const cfg = s.get()
        if (!cfg.enabled) return undefined
        const host = hostOf(url)
        if (!host) return undefined
        const cached = cssCache.get(host)
        if (cached !== undefined) return cached || undefined
        const css = buildCosmeticCss(host, cfg.cosmeticRules)
        if (cssCache.size >= 64) cssCache.clear()
        cssCache.set(host, css)
        return css || undefined
      }

      ctx.content.inject({
        id: 'cosmetic',
        matches: ['<all_urls>'],
        runAt: 'dom-ready',
        css: (url) => cssFor(url)
      })
      ctx.content.inject({
        id: 'mark',
        matches: ['<all_urls>'],
        runAt: 'dom-ready',
        js: MARK_ADS_JS
      })

      // ---------- IPC ----------

      ctx.ipc.handle('getState', (): AdblockState => state())

      ctx.ipc.handle('setEnabled', (enabled: boolean): AdblockState => {
        save({ enabled: !!enabled })
        ctx.content.refresh()
        return emitChanged()
      })

      ctx.ipc.handle('resetCount', (): AdblockState => {
        liveCount = 0
        s.set({ blockedCount: 0 })
        return emitChanged()
      })

      ctx.ipc.handle('addNetworkRule', (input: AddNetworkInput = {}): AdblockState => {
        addNetworkRule(input)
        clearCssCache()
        return emitChanged()
      })

      ctx.ipc.handle('updateNetworkRule', (input: UpdateNetworkInput): AdblockState => {
        updateNetworkRule(input)
        clearCssCache()
        return emitChanged()
      })

      ctx.ipc.handle('removeNetworkRule', (input: { id: string }): AdblockState => {
        save({ networkRules: s.get().networkRules.filter((r) => r.id !== input.id) })
        clearCssCache()
        return emitChanged()
      })

      ctx.ipc.handle('addCosmeticRule', (input: AddCosmeticInput = {}): AdblockState => {
        addCosmeticRule(input)
        clearCssCache()
        ctx.content.refresh()
        return emitChanged()
      })

      ctx.ipc.handle('updateCosmeticRule', (input: UpdateCosmeticInput): AdblockState => {
        updateCosmeticRule(input)
        clearCssCache()
        ctx.content.refresh()
        return emitChanged()
      })

      ctx.ipc.handle('removeCosmeticRule', (input: { id: string }): AdblockState => {
        save({ cosmeticRules: s.get().cosmeticRules.filter((r) => r.id !== input.id) })
        clearCssCache()
        ctx.content.refresh()
        return emitChanged()
      })

      ctx.ipc.handle('replaceUserRules', (input: { text?: string } | string) => {
        const text = typeof input === 'string' ? input : String(input?.text ?? '')
        const parsed = parseRuleText(text)
        const cfg = s.get()
        save({
          networkRules: dedupeNetworkRules([
            ...cfg.networkRules.filter((r) => r.source === 'builtin'),
            ...parsed.networkRules
          ]),
          cosmeticRules: dedupeCosmeticRules([
            ...cfg.cosmeticRules.filter((r) => r.source === 'builtin'),
            ...parsed.cosmeticRules
          ])
        })
        clearCssCache()
        ctx.content.refresh()
        return { state: emitChanged(), summary: parsed.summary }
      })

      ctx.ipc.handle('importRules', (input: { text?: string; replace?: boolean } = {}) => {
        const parsed = parseRuleText(String(input.text ?? ''))
        const cfg = s.get()
        const replace = !!input.replace
        const baseNet = replace ? cfg.networkRules.filter((r) => r.source === 'builtin') : cfg.networkRules
        const baseCos = replace ? cfg.cosmeticRules.filter((r) => r.source === 'builtin') : cfg.cosmeticRules
        save({
          networkRules: dedupeNetworkRules([...baseNet, ...parsed.networkRules]),
          cosmeticRules: dedupeCosmeticRules([...baseCos, ...parsed.cosmeticRules])
        })
        clearCssCache()
        ctx.content.refresh()
        return { state: emitChanged(), summary: parsed.summary }
      })

      ctx.ipc.handle('exportRules', (): { text: string } => {
        const cfg = s.get()
        return { text: serializeRuleText(cfg.networkRules, cfg.cosmeticRules, { includeBuiltin: true }) }
      })

      ctx.ipc.handle('resetDefaults', (): AdblockState => {
        const cfg = s.get()
        const networkRules = [...cfg.networkRules]
        for (const d of createDefaultNetworkRules()) {
          if (!networkRules.some((r) => sameNetworkRule(r, d))) networkRules.push(d)
        }
        const cosmeticRules = [...cfg.cosmeticRules]
        for (const d of createDefaultCosmeticRules()) {
          if (!cosmeticRules.some((r) => sameCosmeticRule(r, d))) cosmeticRules.push(d)
        }
        save({
          networkRules: dedupeNetworkRules(networkRules),
          cosmeticRules: dedupeCosmeticRules(cosmeticRules)
        })
        clearCssCache()
        ctx.content.refresh()
        return emitChanged()
      })

      // ---------- 元素框选 ----------

      const cancelPick = (tabId: number): void => {
        if (!picking.has(tabId)) return
        void ctx.pages.execute(tabId, PICKER_TEARDOWN_JS, { timeoutMs: 2000 }).catch(() => {})
      }

      ctx.events.on('tab:navigated', (p: { tabId: number }) => {
        picking.delete(p.tabId)
      })
      ctx.events.on('tab:closed', (p: { id: number }) => {
        picking.delete(p.id)
      })
      ctx.events.on('tab:activated', (p: { id: number }) => {
        for (const id of [...picking]) {
          if (id !== p.id) cancelPick(id)
        }
      })

      ctx.ipc.handle('pickElement', async () => {
        const tab = ctx.tabs.getActive()
        if (!tab) return { ok: false, error: '没有活动标签页' }
        if (!/^https?:/i.test(tab.url)) return { ok: false, error: '当前页面不支持框选(仅 http/https)' }
        if (picking.has(tab.id)) return { ok: false, error: '该标签页已在框选中' }
        picking.add(tab.id)
        try {
          ctx.pages.focus(tab.id)
          const raw = await ctx.pages.execute(tab.id, PICKER_JS, { timeoutMs: 600_000 })
          const res = (raw ?? {}) as { selector?: unknown; cancelled?: unknown; tag?: unknown }
          if (res.cancelled) return { ok: false, cancelled: true }
          const selector = String(res.selector ?? '').trim()
          if (!selector) return { ok: false, error: '未生成有效选择器' }
          const domain = normalizeRuleDomain(hostOf(tab.url)) || '*'
          const cfg = s.get()
          let rule = cfg.cosmeticRules.find((r) => sameCosmeticRule(r, { type: 'hide', domain, selector }))
          if (!rule) {
            rule = createCosmeticRule('hide', domain, selector, { source: 'picker' })
            save({ cosmeticRules: [...cfg.cosmeticRules, rule] })
            clearCssCache()
          }
          ctx.content.refresh(tab.id)
          ctx.ipc.emit('changed', state())
          ctx.ipc.emit('pick-done', { ok: true, tabId: tab.id, rule })
          return { ok: true, rule }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          ctx.ipc.emit('pick-done', { ok: false, tabId: tab.id, error: msg })
          return { ok: false, error: msg }
        } finally {
          picking.delete(tab.id)
        }
      })

      // ---------- MCP ----------

      ctx.mcp.tool('adblock_stats', { description: '返回广告/追踪拦截统计' }, async () => {
        const cfg = s.get()
        return textContent({
          ok: true,
          enabled: cfg.enabled,
          blockedCount: liveCount,
          networkRuleCount: cfg.networkRules.length,
          cosmeticRuleCount: cfg.cosmeticRules.length
        })
      })

      ctx.mcp.tool(
        'adblock_list_rules',
        {
          description: '列出广告拦截规则(可按类型/关键字过滤)',
          inputSchema: {
            kind: z.enum(['network', 'cosmetic']).optional().describe('规则类型,缺省返回全部'),
            domain: z.string().optional().describe('按模式 / 域名关键字过滤')
          }
        },
        async (args) => {
          const kind = args.kind
          const keyword = typeof args.domain === 'string' ? args.domain.toLowerCase() : ''
          const cfg = s.get()
          const networkRules =
            kind === 'cosmetic'
              ? []
              : cfg.networkRules.filter((r) => !keyword || r.pattern.toLowerCase().includes(keyword))
          const cosmeticRules =
            kind === 'network'
              ? []
              : cfg.cosmeticRules.filter(
                  (r) => !keyword || r.domain.toLowerCase().includes(keyword) || r.selector.toLowerCase().includes(keyword)
                )
          return textContent({ ok: true, networkRules, cosmeticRules })
        }
      )

      ctx.mcp.tool(
        'adblock_add_rule',
        {
          description: '新增一条网络规则或元素隐藏规则',
          inputSchema: {
            kind: z.enum(['network', 'cosmetic']).describe('规则类型'),
            type: z
              .enum(['block', 'allow', 'hide', 'unhide'])
              .optional()
              .describe('网络规则为 block/allow,元素规则为 hide/unhide'),
            pattern: z.string().optional().describe('网络规则模式,如 ||ads.example.com^ 或 example.com'),
            domain: z.string().optional().describe('元素规则适用域,* 表示全站'),
            selector: z.string().optional().describe('元素规则的 CSS 选择器'),
            enabled: z.boolean().optional().describe('是否启用,默认 true')
          }
        },
        async (args) => {
          try {
            const cfg = s.get()
            if (args.kind === 'cosmetic') {
              const type: CosmeticRuleType = args.type === 'unhide' ? 'unhide' : 'hide'
              const domain = normalizeRuleDomain(String(args.domain ?? '*')) || '*'
              const selector = String(args.selector ?? '').trim()
              const existed = cfg.cosmeticRules.some((r) => sameCosmeticRule(r, { type, domain, selector }))
              const rule = addCosmeticRule(args as AddCosmeticInput)
              clearCssCache()
              ctx.content.refresh()
              ctx.ipc.emit('changed', state())
              return textContent({ ok: true, rule, created: !existed })
            }
            const existedNetwork = cfg.networkRules.some((r) =>
              sameNetworkRule(r, {
                type: args.type === 'allow' ? 'allow' : 'block',
                pattern: String(args.pattern ?? '')
              })
            )
            const rule = addNetworkRule(args as AddNetworkInput)
            clearCssCache()
            ctx.ipc.emit('changed', state())
            return textContent({ ok: true, rule, created: !existedNetwork })
          } catch (e) {
            return textContent({ ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        }
      )

      ctx.mcp.tool(
        'adblock_remove_rule',
        {
          description: '按 id 删除一条网络规则或元素规则',
          inputSchema: { id: z.string().describe('规则 id,可由 adblock_list_rules 获得') }
        },
        async (args) => {
          const id = String(args.id ?? '')
          const cfg = s.get()
          const before = cfg.networkRules.length + cfg.cosmeticRules.length
          save({
            networkRules: cfg.networkRules.filter((r) => r.id !== id),
            cosmeticRules: cfg.cosmeticRules.filter((r) => r.id !== id)
          })
          const after = s.get().networkRules.length + s.get().cosmeticRules.length
          clearCssCache()
          ctx.content.refresh()
          ctx.ipc.emit('changed', state())
          return textContent({ ok: true, removed: before !== after })
        }
      )

      ctx.mcp.tool(
        'adblock_set_enabled',
        {
          description: '开启或关闭广告拦截',
          inputSchema: { enabled: z.boolean().describe('是否启用') }
        },
        async (args) => {
          save({ enabled: !!args.enabled })
          ctx.content.refresh()
          ctx.ipc.emit('changed', state())
          return textContent({ ok: true, enabled: s.get().enabled })
        }
      )

      ctx.mcp.tool(
        'adblock_import_rules',
        {
          description: '按 AdGuard/EasyList 常用语法批量导入规则',
          inputSchema: {
            text: z.string().describe('规则文本,每行一条'),
            replace: z.boolean().optional().describe('true 时替换现有用户规则(保留内置)')
          }
        },
        async (args) => {
          const parsed = parseRuleText(String(args.text ?? ''))
          const cfg = s.get()
          const replace = !!args.replace
          const baseNet = replace ? cfg.networkRules.filter((r) => r.source === 'builtin') : cfg.networkRules
          const baseCos = replace ? cfg.cosmeticRules.filter((r) => r.source === 'builtin') : cfg.cosmeticRules
          save({
            networkRules: dedupeNetworkRules([...baseNet, ...parsed.networkRules]),
            cosmeticRules: dedupeCosmeticRules([...baseCos, ...parsed.cosmeticRules])
          })
          clearCssCache()
          ctx.content.refresh()
          ctx.ipc.emit('changed', state())
          return textContent({ ok: true, summary: parsed.summary })
        }
      )
    },

    deactivate(): void {
      if (store && store.get().blockedCount !== liveCount) store.set({ blockedCount: liveCount })
      picking.clear()
      cssCache = new Map()
    }
  }
}

export default createAdblockPlugin()
