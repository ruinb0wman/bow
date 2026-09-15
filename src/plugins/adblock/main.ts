/**
 * 广告/追踪拦截插件:网络规则 + 元素规则,支持编辑、文本导入导出、订阅与页面框选。
 *
 * - net:onBeforeRequest 按网络规则(模式 + `$` 选项)拦截子资源,不拦主文档;
 * - content:按页面 host 动态注入元素隐藏 CSS(dom-ready),规则变更后可 refresh 立即生效;
 * - ipc:渲染层设置面板的规则 CRUD(分页)、文本规则、订阅管理、导入导出、框选入口;
 * - mcp:统计、规则查询/增删、订阅管理与文本导入工具;
 * - pages:调用内核页面执行 API 注入框选器,人类点选后生成元素规则。
 */

import { z } from 'zod'
import type { NetHookContext } from '@shared/plugins'
import {
  buildCosmeticCssFromIndex,
  buildCosmeticIndex,
  buildNetworkIndex,
  cloneCosmeticRules,
  cloneNetworkRules,
  createCosmeticRule,
  createDefaultCosmeticRules,
  createDefaultNetworkRules,
  createNetworkRule,
  dedupeCosmeticFlags,
  dedupeCosmeticRules,
  dedupeNetworkRules,
  formatNetworkOptions,
  isNetworkBlocked,
  migrateConfig,
  newRuleId,
  normalizeRuleDomain,
  parseRuleText,
  patternInputError,
  removeBadfiltered,
  sameCosmeticRule,
  sameNetworkRule,
  serializeRuleText
} from '@shared/adblock'
import type {
  AdblockConfig,
  CosmeticFlagRule,
  CosmeticIndex,
  CosmeticRule,
  CosmeticRuleType,
  NetworkIndex,
  NetworkRule,
  NetworkRuleType,
  ParsedRules,
  Subscription
} from '@shared/adblock'
import { hostOf } from '@shared/pluginMatch'
import { textContent } from '../../main/plugins/mcpResult'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import { PICKER_JS, PICKER_TEARDOWN_JS } from './picker'

/** 内容注入标记:便于页面侧/调试观察插件是否生效 */
export const MARK_ADS_JS = "document.documentElement.setAttribute('data-bow-adblock', '1')"

/** 单条订阅最多吃进的规则条数(防御超大清单拖垮内存与渲染) */
const MAX_RULES_PER_LIST = 100_000
const SUBSCRIPTION_TIMEOUT_MS = 30_000
const RULE_PAGE_LIMIT = 1000
const RULE_PAGE_DEFAULT = 200

export interface AdblockState {
  enabled: boolean
  blockedCount: number
  cosmeticFlags: CosmeticFlagRule[]
  subscriptions: Subscription[]
  stats: { network: number; cosmetic: number; user: number; flags: number; subscriptions: number }
}

export interface RulePage {
  items: Array<NetworkRule | CosmeticRule>
  /** 该类型规则总数 */
  total: number
  /** 过滤后条数 */
  matched: number
  offset: number
  limit: number
}

interface ListRulesInput {
  kind?: 'network' | 'cosmetic'
  keyword?: string
  offset?: number
  limit?: number
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

interface AddSubscriptionInput {
  url?: string
  title?: string
  enabled?: boolean
}

function statsOf(cfg: AdblockConfig): AdblockState['stats'] {
  const user =
    cfg.networkRules.filter((r) => r.source !== 'builtin').length +
    cfg.cosmeticRules.filter((r) => r.source !== 'builtin').length
  return {
    network: cfg.networkRules.length,
    cosmetic: cfg.cosmeticRules.length,
    user,
    flags: cfg.cosmeticFlags.length,
    subscriptions: cfg.subscriptions.length
  }
}

/** 订阅拉取:超时 + 非 2xx 一律当失败(不写进规则表) */
async function fetchFilterList(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUBSCRIPTION_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'bow-adblock/3.0' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function tagRules(parsed: ParsedRules, subscriptionId: string): {
  networkRules: NetworkRule[]
  cosmeticRules: CosmeticRule[]
  cosmeticFlags: CosmeticFlagRule[]
  badfilters: NetworkRule[]
} {
  const cap = (arr: NetworkRule[] | CosmeticRule[]): typeof arr => arr.slice(0, MAX_RULES_PER_LIST)
  return {
    networkRules: cap(parsed.networkRules).map((r) => ({
      ...r,
      source: 'subscription' as const,
      subscriptionId
    })) as NetworkRule[],
    cosmeticRules: cap(parsed.cosmeticRules).map((r) => ({
      ...r,
      source: 'subscription' as const,
      subscriptionId
    })) as CosmeticRule[],
    cosmeticFlags: parsed.cosmeticFlags.map((f) => ({
      ...f,
      source: 'subscription' as const,
      subscriptionId
    })),
    badfilters: parsed.badfilters
  }
}

function createAdblockPlugin(): PluginMain {
  let store: PluginStorage<AdblockConfig> | null = null
  let liveCount = 0
  const picking = new Set<number>()
  let cssCache = new Map<string, string>()
  let index: NetworkIndex = buildNetworkIndex([])
  let cosmeticIndex: CosmeticIndex = buildCosmeticIndex([])

  return {
    manifest: {
      id: 'adblock',
      name: '广告/追踪拦截',
      description: '网络 + 元素规则拦截,支持 EasyList/AdGuard 子集与订阅,规则可编辑,支持页面框选隐藏元素',
      version: '3.0.0'
    },
    capabilities: ['ui', 'net', 'content', 'mcp'],

    activate(ctx: PluginContext): void {
      // 默认值仅作占位:真实配置一律经 migrateConfig 生成,以正确识别旧版本数据
      // compact:规则表可能有几万条,单行 JSON 写入比 pretty-print 快得多
      const s = ctx.storage<AdblockConfig>({
        file: 'adblock.json',
        defaults: { version: 0 } as unknown as AdblockConfig,
        compact: true
      })
      store = s
      const migrated = migrateConfig(s.get())
      s.setRaw(migrated)
      liveCount = migrated.blockedCount
      index = buildNetworkIndex(migrated.networkRules)
      cosmeticIndex = buildCosmeticIndex(migrated.cosmeticRules)

      const clearCssCache = (): void => {
        cssCache = new Map()
      }

      /** 每次规则/开关变更后重建索引并清 CSS 缓存 */
      const reindex = (): void => {
        const cfg = s.get()
        index = buildNetworkIndex(cfg.networkRules)
        cosmeticIndex = buildCosmeticIndex(cfg.cosmeticRules)
        clearCssCache()
      }

      const save = (patch: Partial<AdblockConfig>): void => {
        s.setRaw({ ...s.get(), ...patch })
      }

      const state = (): AdblockState => {
        const cfg = s.get()
        return {
          enabled: cfg.enabled,
          blockedCount: liveCount,
          cosmeticFlags: cfg.cosmeticFlags.map((f) => ({ ...f })),
          subscriptions: cfg.subscriptions.map((x) => ({ ...x })),
          stats: statsOf(cfg)
        }
      }

      const emitChanged = (): AdblockState => {
        const st = state()
        ctx.ipc.emit('changed', st)
        return st
      }

      // ---------- 规则查询(分页:全量规则不再走 IPC 快照) ----------

      const listRules = (input: ListRulesInput = {}): RulePage => {
        const cfg = s.get()
        const kind = input.kind === 'cosmetic' ? 'cosmetic' : 'network'
        const kw = String(input.keyword ?? '').trim().toLowerCase()
        const offset = Math.max(0, Math.floor(input.offset ?? 0))
        const limit = Math.min(RULE_PAGE_LIMIT, Math.max(1, Math.floor(input.limit ?? RULE_PAGE_DEFAULT)))
        if (kind === 'cosmetic') {
          const source = cfg.cosmeticRules
          const matched = source.filter(
            (r) =>
              !kw ||
              r.domain.toLowerCase().includes(kw) ||
              r.selector.toLowerCase().includes(kw) ||
              (r.excludeDomains ?? []).join(',').toLowerCase().includes(kw)
          )
          return {
            items: cloneCosmeticRules(matched.slice(offset, offset + limit)),
            total: source.length,
            matched: matched.length,
            offset,
            limit
          }
        }
        const source = cfg.networkRules
        const matched = source.filter(
          (r) =>
            !kw ||
            r.pattern.toLowerCase().includes(kw) ||
            formatNetworkOptions(r.options).toLowerCase().includes(kw) ||
            (r.note ?? '').toLowerCase().includes(kw)
        )
        return {
          items: cloneNetworkRules(matched.slice(offset, offset + limit)),
          total: source.length,
          matched: matched.length,
          offset,
          limit
        }
      }

      // ---------- 规则操作(IPC 与 MCP 共用) ----------

      const addNetworkRule = (input: AddNetworkInput): NetworkRule => {
        const pattern = String(input.pattern ?? '').trim()
        const invalid = patternInputError(pattern)
        if (invalid) throw new Error(invalid)
        const type: NetworkRuleType = input.type === 'allow' ? 'allow' : 'block'
        const cfg = s.get()
        const existing = cfg.networkRules.find((r) => sameNetworkRule(r, { type, pattern }))
        if (existing) return existing
        const rule = createNetworkRule(type, pattern, { enabled: input.enabled ?? true, note: input.note })
        save({ networkRules: [...cfg.networkRules, rule] })
        reindex()
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
        reindex()
        return rule
      }

      const updateNetworkRule = (input: UpdateNetworkInput): void => {
        const cfg = s.get()
        const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : ''
        if (pattern) {
          const invalid = patternInputError(pattern)
          if (invalid) throw new Error(invalid)
        }
        save({
          networkRules: dedupeNetworkRules(
            cfg.networkRules.map((r) => {
              if (r.id !== input.id) return r
              return {
                ...r,
                pattern: pattern || r.pattern,
                type: input.type === 'allow' ? 'allow' : input.type === 'block' ? 'block' : r.type,
                enabled: typeof input.enabled === 'boolean' ? input.enabled : r.enabled,
                note: typeof input.note === 'string' ? input.note : r.note
              }
            })
          )
        })
        reindex()
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
        reindex()
      }

      /** 合并文本规则(导入 / 文本页应用):replace 时只保留内置与订阅规则,替换的仅是用户规则 */
      const keepOnReplace = (source: string): boolean => source === 'builtin' || source === 'subscription'
      const mergeParsedRules = (parsed: ParsedRules, replace: boolean) => {
        const cfg = s.get()
        const baseNet = replace ? cfg.networkRules.filter((r) => keepOnReplace(r.source)) : cfg.networkRules
        const baseCos = replace ? cfg.cosmeticRules.filter((r) => keepOnReplace(r.source)) : cfg.cosmeticRules
        const baseFlags = replace ? cfg.cosmeticFlags.filter((f) => keepOnReplace(f.source)) : cfg.cosmeticFlags
        save({
          networkRules: removeBadfiltered(
            dedupeNetworkRules([...baseNet, ...parsed.networkRules]),
            parsed.badfilters
          ),
          cosmeticRules: dedupeCosmeticRules([...baseCos, ...parsed.cosmeticRules]),
          cosmeticFlags: dedupeCosmeticFlags([...baseFlags, ...parsed.cosmeticFlags])
        })
        reindex()
        ctx.content.refresh()
      }

      // ---------- 网络钩子 ----------

      ctx.net.onBeforeRequest((c: NetHookContext) => {
        const cfg = s.get()
        if (!cfg.enabled) return
        if (c.resourceType === 'mainFrame') return // 不拦主文档,避免整页打不开
        if (!isNetworkBlocked(c.url, index, { resourceType: c.resourceType, pageUrl: c.pageUrl })) return
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
        const css = buildCosmeticCssFromIndex(cosmeticIndex, host, cfg.cosmeticFlags)
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

      // ---------- 订阅 ----------

      const refreshSubscriptions = async (
        ids?: string[]
      ): Promise<{ updated: number; failed: number; errors: Array<{ url: string; error: string }> }> => {
        const targets = s
          .get()
          .subscriptions.filter((x) => x.enabled && (!ids || ids.includes(x.id)))
        let updated = 0
        const errors: Array<{ url: string; error: string }> = []

        for (const sub of targets) {
          try {
            const text = await fetchFilterList(sub.url)
            const parsed = parseRuleText(text)
            const tagged = tagRules(parsed, sub.id)
            const cur = s.get()
            save({
              networkRules: removeBadfiltered(
                dedupeNetworkRules([
                  ...cur.networkRules.filter((r) => r.subscriptionId !== sub.id),
                  ...tagged.networkRules
                ]),
                // 订阅里的 badfilter 也能关掉其它来源的规则
                [...tagged.badfilters]
              ),
              cosmeticRules: dedupeCosmeticRules([
                ...cur.cosmeticRules.filter((r) => r.subscriptionId !== sub.id),
                ...tagged.cosmeticRules
              ]),
              cosmeticFlags: dedupeCosmeticFlags([
                ...cur.cosmeticFlags.filter((f) => f.subscriptionId !== sub.id),
                ...tagged.cosmeticFlags
              ]),
              subscriptions: cur.subscriptions.map((x) =>
                x.id === sub.id
                  ? { ...x, updatedAt: Date.now(), error: undefined, ruleCount: tagged.networkRules.length + tagged.cosmeticRules.length }
                  : x
              )
            })
            updated += 1
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            const cur = s.get()
            save({
              subscriptions: cur.subscriptions.map((x) => (x.id === sub.id ? { ...x, error: msg } : x))
            })
            errors.push({ url: sub.url, error: msg })
          }
        }

        if (updated > 0) {
          reindex()
          ctx.content.refresh()
        }
        emitChanged()
        return { updated, failed: errors.length, errors }
      }

      const addSubscription = (input: AddSubscriptionInput): Subscription => {
        const url = String(input.url ?? '').trim()
        if (!/^https?:\/\//i.test(url)) throw new Error('订阅地址必须以 http(s):// 开头')
        const cfg = s.get()
        const existing = cfg.subscriptions.find((x) => x.url === url)
        if (existing) return existing
        const sub: Subscription = {
          id: newRuleId('s'),
          url,
          title: String(input.title ?? '').trim() || undefined,
          enabled: input.enabled ?? true,
          updatedAt: 0
        }
        save({ subscriptions: [...cfg.subscriptions, sub] })
        return sub
      }

      // ---------- IPC ----------

      ctx.ipc.handle('getState', (): AdblockState => state())
      ctx.ipc.handle('listRules', (input: ListRulesInput = {}): RulePage => listRules(input))

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
        return emitChanged()
      })

      ctx.ipc.handle('updateNetworkRule', (input: UpdateNetworkInput): AdblockState => {
        updateNetworkRule(input)
        return emitChanged()
      })

      ctx.ipc.handle('removeNetworkRule', (input: { id: string }): AdblockState => {
        save({ networkRules: s.get().networkRules.filter((r) => r.id !== input.id) })
        reindex()
        return emitChanged()
      })

      ctx.ipc.handle('addCosmeticRule', (input: AddCosmeticInput = {}): AdblockState => {
        addCosmeticRule(input)
        ctx.content.refresh()
        return emitChanged()
      })

      ctx.ipc.handle('updateCosmeticRule', (input: UpdateCosmeticInput): AdblockState => {
        updateCosmeticRule(input)
        ctx.content.refresh()
        return emitChanged()
      })

      ctx.ipc.handle('removeCosmeticRule', (input: { id: string }): AdblockState => {
        save({ cosmeticRules: s.get().cosmeticRules.filter((r) => r.id !== input.id) })
        reindex()
        ctx.content.refresh()
        return emitChanged()
      })

      ctx.ipc.handle('removeCosmeticFlag', (input: { id: string }): AdblockState => {
        save({ cosmeticFlags: s.get().cosmeticFlags.filter((f) => f.id !== input.id) })
        clearCssCache()
        ctx.content.refresh()
        return emitChanged()
      })

      ctx.ipc.handle('replaceUserRules', (input: { text?: string } | string) => {
        const text = typeof input === 'string' ? input : String(input?.text ?? '')
        const parsed = parseRuleText(text)
        mergeParsedRules(parsed, true)
        return { state: emitChanged(), summary: parsed.summary }
      })

      ctx.ipc.handle('importRules', (input: { text?: string; replace?: boolean } = {}) => {
        const parsed = parseRuleText(String(input.text ?? ''))
        mergeParsedRules(parsed, !!input.replace)
        return { state: emitChanged(), summary: parsed.summary }
      })

      ctx.ipc.handle('exportRules', (input: { includeBuiltin?: boolean } = {}): { text: string } => {
        const cfg = s.get()
        return {
          text: serializeRuleText(cfg.networkRules, cfg.cosmeticRules, {
            includeBuiltin: input?.includeBuiltin ?? true,
            cosmeticFlags: cfg.cosmeticFlags
          })
        }
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
        reindex()
        ctx.content.refresh()
        return emitChanged()
      })

      // ---------- 订阅 IPC ----------

      ctx.ipc.handle('addSubscription', async (input: AddSubscriptionInput = {}) => {
        const sub = addSubscription(input)
        const res = await refreshSubscriptions([sub.id])
        const fresh = s.get().subscriptions.find((x) => x.id === sub.id) ?? sub
        return { subscription: fresh, ...res }
      })

      ctx.ipc.handle('removeSubscription', (input: { id: string }): AdblockState => {
        const id = String(input?.id ?? '')
        const cfg = s.get()
        save({
          subscriptions: cfg.subscriptions.filter((x) => x.id !== id),
          networkRules: cfg.networkRules.filter((r) => r.subscriptionId !== id),
          cosmeticRules: cfg.cosmeticRules.filter((r) => r.subscriptionId !== id),
          cosmeticFlags: cfg.cosmeticFlags.filter((f) => f.subscriptionId !== id)
        })
        reindex()
        ctx.content.refresh()
        return emitChanged()
      })

      ctx.ipc.handle('setSubscriptionEnabled', async (input: { id: string; enabled: boolean }) => {
        const id = String(input?.id ?? '')
        const cfg = s.get()
        save({
          subscriptions: cfg.subscriptions.map((x) =>
            x.id === id ? { ...x, enabled: !!input.enabled } : x
          )
        })
        if (input.enabled) {
          // 重新启用时立即拉取,否则会停在「启用但零规则」的状态
          await refreshSubscriptions([id])
        } else {
          const cur = s.get()
          save({
            networkRules: cur.networkRules.filter((r) => r.subscriptionId !== id),
            cosmeticRules: cur.cosmeticRules.filter((r) => r.subscriptionId !== id),
            cosmeticFlags: cur.cosmeticFlags.filter((f) => f.subscriptionId !== id)
          })
          reindex()
          ctx.content.refresh()
        }
        return emitChanged()
      })

      ctx.ipc.handle('refreshSubscriptions', async (input: { id?: string } = {}) => {
        const res = await refreshSubscriptions(input?.id ? [String(input.id)] : undefined)
        return { ...res, state: state() }
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
            reindex()
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
          cosmeticRuleCount: cfg.cosmeticRules.length,
          cosmeticFlagCount: cfg.cosmeticFlags.length,
          subscriptions: cfg.subscriptions.map((x) => ({
            url: x.url,
            enabled: x.enabled,
            ruleCount: x.ruleCount ?? 0,
            updatedAt: x.updatedAt,
            error: x.error
          }))
        })
      })

      ctx.mcp.tool(
        'adblock_list_rules',
        {
          description: '分页列出广告拦截规则(可按类型/关键字过滤)',
          inputSchema: {
            kind: z.enum(['network', 'cosmetic']).optional().describe('规则类型,缺省为 network'),
            domain: z.string().optional().describe('按模式 / 域名 / 选择器关键字过滤'),
            offset: z.number().int().min(0).optional().describe('起始下标,默认 0'),
            limit: z.number().int().min(1).max(RULE_PAGE_LIMIT).optional().describe('返回条数,默认 200')
          }
        },
        async (args) => {
          const page = listRules({
            kind: args.kind === 'cosmetic' ? 'cosmetic' : 'network',
            keyword: typeof args.domain === 'string' ? args.domain : '',
            offset: typeof args.offset === 'number' ? args.offset : 0,
            limit: typeof args.limit === 'number' ? args.limit : RULE_PAGE_DEFAULT
          })
          return textContent({ ok: true, ...page })
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
            pattern: z
              .string()
              .optional()
              .describe('网络规则模式,如 ||ads.example.com^ 或 example.com(不支持 $ 选项)'),
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
          reindex()
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
          description:
            '按 EasyList/AdGuard 子集批量导入规则(支持 ||host^、host、*.host、* 通配、@@ 例外、$third-party/$domain=/$important 等选项、##/#@#、~domain 排除域、$generichide/$elemhide);不支持的写法会跳过并在 summary 里汇总',
          inputSchema: {
            text: z.string().describe('规则文本,每行一条'),
            replace: z.boolean().optional().describe('true 时替换现有用户规则(保留内置与订阅规则)')
          }
        },
        async (args) => {
          const parsed = parseRuleText(String(args.text ?? ''))
          mergeParsedRules(parsed, !!args.replace)
          ctx.ipc.emit('changed', state())
          return textContent({ ok: true, summary: parsed.summary })
        }
      )

      ctx.mcp.tool(
        'adblock_subscribe',
        {
          description: '新增一条规则订阅(EasyList/AdGuard 的 .txt 地址)并立即拉取',
          inputSchema: {
            url: z.string().describe('订阅地址,http(s):// 开头'),
            title: z.string().optional().describe('备注名')
          }
        },
        async (args) => {
          try {
            const sub = addSubscription({ url: String(args.url ?? ''), title: String(args.title ?? '') })
            const res = await refreshSubscriptions([sub.id])
            const fresh = s.get().subscriptions.find((x) => x.id === sub.id) ?? sub
            return textContent({ ok: true, subscription: fresh, updated: res.updated, failed: res.failed })
          } catch (e) {
            return textContent({ ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        }
      )

      ctx.mcp.tool(
        'adblock_refresh_subscriptions',
        {
          description: '更新规则订阅(省略 id 表示更新全部启用的订阅)',
          inputSchema: { id: z.string().optional().describe('订阅 id,省略则更新全部启用订阅') }
        },
        async (args) => {
          const res = await refreshSubscriptions(args.id ? [String(args.id)] : undefined)
          return textContent({ ok: res.failed === 0, ...res, subscriptions: s.get().subscriptions })
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
