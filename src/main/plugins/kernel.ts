/**
 * 插件内核:唯一拥有 Electron 权限的插件宿主。
 * 负责注册/启停编排、独立存储、IPC 路由与广播、事件总线、建议合并、
 * 以及把网络钩子 / 内容注入 / MCP 工具挂到对应宿主上。
 */

import type {
  ContentScriptSpec,
  NetHook,
  NetPhase,
  PluginInfo,
  SuggestItem,
  SuggestProvider,
  PluginTabApi
} from '@shared/plugins'
import type { WebContents } from 'electron'
import type { Suggestion, SuggestRow } from '@shared/types'
import { matchHotkey } from '@shared/shortcuts'
import type { HotkeySpec, KeyInputLike } from '@shared/shortcuts'
import { buildSuggestRows, mergeSuggestions } from '@shared/suggest'
import { SEARCH_ENGINES } from '@shared/url'
import { createStore, getSettingsStore } from '../stores'
import type { JsonStore } from '../stores'
import type { MCPDeps } from '../mcp'
import { mcpActivity } from '../mcpActivity'
import { log, logError } from '../logger'
import { PluginRegistry } from './core'
import { McpHost } from './mcpHost'
import { McpHttpHost, MCP_HTTP_READY_EVENT } from './mcpHttpHost'
import { NetHookHost } from './netHooks'
import { ContentHookHost } from './contentHooks'
import type { McpToolConfig, McpToolHandler, PluginContext, PluginMain, PluginPageApi, PluginServiceApi, PluginStorage } from './types'

const SUGGEST_LIMIT = 9

interface Route {
  fn: (...args: any[]) => unknown | Promise<unknown>
}

interface Subscriber {
  pluginId: string
  cb: (payload: any) => void
}

interface ProviderReg {
  pluginId: string
  provider: SuggestProvider
}

interface HotkeyReg {
  pluginId: string
  spec: HotkeySpec
  handler: () => void
}

export interface PluginUiHost {
  /** 当前浮层 id(可能为 null) */
  overlayId(): string | null
  /** 关闭当前浮层 */
  closeOverlay(): void
}

const EMPTY_TABS: PluginTabApi = { list: () => [], getActive: () => null }

const EMPTY_PAGE_API: PluginPageApi = {
  activeTabId: () => null,
  focus: () => {},
  execute: () => Promise.reject(new Error('页面执行 API 尚未就绪'))
}

export class PluginKernel {
  readonly registry = new PluginRegistry()
  readonly mcp = new McpHost()
  readonly mcpHttp = new McpHttpHost()
  readonly net = new NetHookHost()
  readonly content = new ContentHookHost()

  private stateStore: JsonStore<{ version: number; disabled: string[] }>
  private contexts = new Map<string, PluginContextImpl>()
  private routes = new Map<string, Map<string, Route>>()
  private subscribers = new Map<string, Set<Subscriber>>()
  private providers: ProviderReg[] = []
  private hotkeys: HotkeyReg[] = []
  private storageCache = new Map<string, JsonStore<any>>()
  private broadcaster: ((channel: string, payload: unknown) => void) | null = null
  private uiHost: PluginUiHost | null = null
  private tabProvider: () => PluginTabApi = () => EMPTY_TABS
  private pageApi: PluginPageApi = EMPTY_PAGE_API

  constructor() {
    this.stateStore = createStore<{ version: number; disabled: string[] }>('plugins.json', {
      version: 1,
      disabled: []
    })
  }

  // ---------- 注册与状态 ----------

  registerAll(modules: PluginMain[]): void {
    for (const m of modules) this.registry.register(m)
    const saved = this.stateStore.get().disabled ?? []
    this.registry.setDisabled(saved)
    log('插件注册完成', this.registry.ids().join(','))
  }

  list(): PluginInfo[] {
    return this.registry.list()
  }

  /** 预留核心 MCP 工具名,防止插件重名 */
  reserveMcpToolNames(names: string[]): void {
    this.mcp.reserve(names)
  }

  installHooks(): void {
    this.net.install()
    log('插件内容注入宿主已就绪(按标签页跟踪)')
  }

  setBroadcaster(fn: (channel: string, payload: unknown) => void): void {
    this.broadcaster = fn
  }

  setUiHost(host: PluginUiHost): void {
    this.uiHost = host
  }

  setTabProvider(fn: () => PluginTabApi): void {
    this.tabProvider = fn
  }

  /** 注入 MCP HTTP 服务所需的内核运行时依赖(窗口/标签就绪后调用) */
  attachMcpHttpDeps(deps: MCPDeps): void {
    this.mcpHttp.attach(deps)
  }

  /**
   * 唤醒等待中的服务插件。调用方需在本调用之前发起强制启动(若有),
   * 这样环境变量路径会先占住宿主,优先级确定、无竞态。
   */
  notifyMcpHttpReady(): void {
    this.emitEvent(MCP_HTTP_READY_EVENT)
  }

  /** 注入页面执行 API(标签视图创建后由 index.ts 接线) */
  setPageApi(api: PluginPageApi): void {
    this.pageApi = api
  }

  /** 由 TabManager 登记标签页 webContents,使其可获得内容注入 */
  trackPage(wc: WebContents): void {
    this.content.track(wc)
  }

  // ---------- 生命周期 ----------

  async activateEnabled(): Promise<void> {
    for (const id of this.registry.enabledIds()) {
      await this.activate(id)
    }
  }

  async activate(id: string): Promise<void> {
    const record = this.registry.get(id)
    if (!record || record.active) return
    const ctx = new PluginContextImpl(this, id)
    try {
      await record.module.activate(ctx)
      this.contexts.set(id, ctx)
      this.registry.setActive(id, true)
      log('插件已激活', id)
    } catch (e) {
      ctx.dispose()
      logError('插件激活失败', id, e)
    }
  }

  async deactivate(id: string): Promise<void> {
    const record = this.registry.get(id)
    const ctx = this.contexts.get(id)
    if (!record) return
    if (ctx) {
      try {
        await record.module.deactivate?.(ctx)
      } catch (e) {
        logError('插件停用回调失败', id, e)
      }
      ctx.dispose()
      this.contexts.delete(id)
    }
    this.registry.setActive(id, false)
    log('插件已停用', id)
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo[]> {
    if (!this.registry.has(id)) return this.list()
    if (enabled === this.registry.isEnabled(id)) return this.list()
    if (enabled) {
      this.registry.setEnabledState(id, true)
      await this.activate(id)
    } else {
      await this.deactivate(id)
      this.registry.setEnabledState(id, false)
      this.maybeCloseOverlay(id)
    }
    this.stateStore.set({ disabled: this.registry.disabledIds() })
    this.broadcast('plugins:changed', this.list())
    return this.list()
  }

  private maybeCloseOverlay(pluginId: string): void {
    const current = this.uiHost?.overlayId()
    if (current && current.startsWith(`plugin:${pluginId}:`)) this.uiHost?.closeOverlay()
  }

  // ---------- 渲染层调用面 ----------

  async invoke(id: string, method: string, args: unknown[]): Promise<unknown> {
    if (!this.registry.has(id)) throw new Error(`插件不存在:${id}`)
    if (!this.registry.isEnabled(id)) throw new Error(`插件已停用:${id}`)
    const route = this.routes.get(id)?.get(method)
    if (!route) throw new Error(`插件方法不存在:${id}.${method}`)
    return await route.fn(...args)
  }

  /** overlay → 插件 main:约定插件注册 `overlay-event(overlayId, event, args)` 方法 */
  async routeOverlayEvent(overlayId: string, event: string, args: unknown): Promise<boolean> {
    const m = /^plugin:([^:]+):/.exec(overlayId)
    if (!m) return false
    const pluginId = m[1]
    const route = this.routes.get(pluginId)?.get('overlay-event')
    if (!route) return false
    await route.fn(overlayId, event, args)
    return true
  }

  suggest(input: string): { rows: SuggestRow[]; suggestions: Suggestion[] } {
    const query = input.trim()
    const inputs = this.providers.map((p) => ({
      priority: p.provider.priority,
      items: this.safeProvide(p, query, SUGGEST_LIMIT)
    }))
    const suggestions = mergeSuggestions(query, inputs, { limit: SUGGEST_LIMIT })
    const engine = getSettingsStore().get().searchEngine
    const rows = buildSuggestRows(suggestions, query, { searchLabel: SEARCH_ENGINES[engine]?.label })
    return { rows, suggestions: suggestions.map((s) => ({ ...s })) }
  }

  private safeProvide(reg: ProviderReg, query: string, limit: number): SuggestItem[] {
    try {
      return reg.provider.provide(query, limit)
    } catch (e) {
      logError('插件建议源失败', reg.pluginId, reg.provider.id, e)
      return []
    }
  }

  // ---------- 内核设施(供 PluginContextImpl 使用) ----------

  addRoute(pluginId: string, method: string, fn: Route['fn']): () => void {
    let map = this.routes.get(pluginId)
    if (!map) {
      map = new Map()
      this.routes.set(pluginId, map)
    }
    if (map.has(method)) throw new Error(`插件方法重复注册:${pluginId}.${method}`)
    map.set(method, { fn })
    return () => {
      const m = this.routes.get(pluginId)
      if (!m) return
      m.delete(method)
      if (m.size === 0) this.routes.delete(pluginId)
    }
  }

  removeRoutes(pluginId: string): void {
    this.routes.delete(pluginId)
  }

  addSubscriber(pluginId: string, name: string, cb: (payload: any) => void): () => void {
    let set = this.subscribers.get(name)
    if (!set) {
      set = new Set()
      this.subscribers.set(name, set)
    }
    const sub: Subscriber = { pluginId, cb }
    set.add(sub)
    return () => {
      const s = this.subscribers.get(name)
      if (!s) return
      s.delete(sub)
      if (s.size === 0) this.subscribers.delete(name)
    }
  }

  emitEvent(name: string, payload?: unknown): void {
    const set = this.subscribers.get(name)
    if (!set) return
    for (const sub of [...set]) {
      try {
        sub.cb(payload)
      } catch (e) {
        logError('插件事件处理失败', sub.pluginId, name, e)
      }
    }
  }

  addProvider(pluginId: string, provider: SuggestProvider): () => void {
    const reg: ProviderReg = { pluginId, provider }
    this.providers.push(reg)
    return () => {
      const i = this.providers.indexOf(reg)
      if (i >= 0) this.providers.splice(i, 1)
    }
  }

  addHotkey(pluginId: string, spec: HotkeySpec, handler: () => void): () => void {
    const reg: HotkeyReg = { pluginId, spec, handler }
    this.hotkeys.push(reg)
    return () => {
      const i = this.hotkeys.indexOf(reg)
      if (i >= 0) this.hotkeys.splice(i, 1)
    }
  }

  /**
   * 按注册顺序匹配插件热键,命中则同步调用处理器并返回 true。
   * 由主进程 before-input-event 在核心快捷键未命中后调用。
   */
  handleHotkey(input: KeyInputLike): boolean {
    for (const reg of [...this.hotkeys]) {
      if (!matchHotkey(input, reg.spec)) continue
      try {
        reg.handler()
      } catch (e) {
        logError('插件热键处理失败', reg.pluginId, e)
      }
      return true
    }
    return false
  }

  storageFor<T>(opts: { file: string; defaults: T }): PluginStorage<T> {
    let store = this.storageCache.get(opts.file)
    if (!store) {
      store = createStore<T>(opts.file, opts.defaults)
      this.storageCache.set(opts.file, store)
    }
    return store as PluginStorage<T>
  }

  addNetHook(pluginId: string, phase: NetPhase, hook: NetHook): () => void {
    return this.net.add(pluginId, phase, hook)
  }

  addContentScript(pluginId: string, spec: ContentScriptSpec): () => void {
    return this.content.add(pluginId, spec)
  }

  refreshContent(tabId?: number): void {
    this.content.refresh(tabId)
  }

  addMcpTool(pluginId: string, name: string, config: McpToolConfig, handler: McpToolHandler): void {
    this.mcp.registerTool({ pluginId, name, config, handler })
  }

  broadcastPluginEvent(pluginId: string, event: string, payload?: unknown): void {
    this.broadcast('plugin:event', { id: pluginId, event, args: payload })
  }

  get tabs(): PluginTabApi {
    return this.tabProvider()
  }

  get pages(): PluginPageApi {
    return this.pageApi
  }

  private broadcast(channel: string, payload: unknown): void {
    if (this.broadcaster) this.broadcaster(channel, payload)
  }
}

/** 每个插件一份上下文:登记所有 disposer,停用时逆序回收 */
class PluginContextImpl implements PluginContext {
  readonly id: string
  private disposers: Array<() => void> = []

  constructor(
    private readonly kernel: PluginKernel,
    id: string
  ) {
    this.id = id
  }

  log(...args: unknown[]): void {
    log(`[plugin:${this.id}]`, ...args)
  }

  logError(...args: unknown[]): void {
    logError(`[plugin:${this.id}]`, ...args)
  }

  storage<T>(opts: { file: string; defaults: T }): PluginStorage<T> {
    return this.kernel.storageFor(opts)
  }

  readonly ipc = {
    handle: (method: string, fn: (...args: any[]) => unknown | Promise<unknown>): void => {
      this.disposers.push(this.kernel.addRoute(this.id, method, fn))
    },
    emit: (event: string, payload?: unknown): void => {
      this.kernel.broadcastPluginEvent(this.id, event, payload)
    }
  }

  readonly events = {
    on: (name: string, cb: (payload: any) => void): void => {
      this.disposers.push(this.kernel.addSubscriber(this.id, name, cb))
    },
    emit: (name: string, payload?: unknown): void => {
      this.kernel.emitEvent(name, payload)
    }
  }

  readonly suggest = {
    register: (provider: SuggestProvider): void => {
      this.disposers.push(this.kernel.addProvider(this.id, provider))
    }
  }

  readonly mcp = {
    tool: (name: string, config: McpToolConfig, handler: McpToolHandler): void => {
      this.kernel.addMcpTool(this.id, name, config, handler)
    }
  }

  readonly net = {
    onBeforeRequest: (hook: NetHook): void => {
      this.disposers.push(this.kernel.addNetHook(this.id, 'onBeforeRequest', hook))
    },
    onBeforeSendHeaders: (hook: NetHook): void => {
      this.disposers.push(this.kernel.addNetHook(this.id, 'onBeforeSendHeaders', hook))
    },
    onHeadersReceived: (hook: NetHook): void => {
      this.disposers.push(this.kernel.addNetHook(this.id, 'onHeadersReceived', hook))
    }
  }

  readonly content = {
    inject: (spec: ContentScriptSpec): void => {
      this.disposers.push(this.kernel.addContentScript(this.id, spec))
    },
    refresh: (tabId?: number): void => {
      this.kernel.refreshContent(tabId)
    }
  }

  readonly pages: PluginPageApi = {
    activeTabId: () => this.kernel.pages.activeTabId(),
    focus: (tabId) => this.kernel.pages.focus(tabId),
    execute: (tabId, code, opts) => this.kernel.pages.execute(tabId, code, opts)
  }

  readonly tabs: PluginTabApi = {
    list: () => this.kernel.tabs.list(),
    getActive: () => this.kernel.tabs.getActive()
  }

  readonly service: PluginServiceApi = {
    onMcpHttpReady: (cb: () => void): void => {
      this.disposers.push(this.kernel.addSubscriber(this.id, MCP_HTTP_READY_EVENT, cb))
    },
    mcpHttp: {
      status: () => this.kernel.mcpHttp.status(),
      start: (opts) => this.kernel.mcpHttp.start(opts),
      stop: () => this.kernel.mcpHttp.stop({ source: 'plugin' }),
      restart: (opts) => this.kernel.mcpHttp.restart({ ...opts, source: 'plugin' })
    },
    activity: {
      snapshot: () => mcpActivity.snapshot(),
      onChange: (cb) => {
        const off = mcpActivity.onChange(cb)
        this.disposers.push(off)
        return off
      }
    }
  }

  readonly shortcuts = {
    register: (spec: HotkeySpec, handler: () => void): void => {
      this.disposers.push(this.kernel.addHotkey(this.id, spec, handler))
    }
  }

  dispose(): void {
    for (const d of [...this.disposers].reverse()) {
      try {
        d()
      } catch (e) {
        logError('插件资源回收失败', this.id, e)
      }
    }
    this.disposers = []
    this.kernel.removeRoutes(this.id)
    this.kernel.mcp.removeByPlugin(this.id)
  }
}
