/** 标签管理:每个标签一个 WebContentsView,主进程统一创建/销毁/激活/布局 */

import { BrowserWindow, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { TabInfo } from '@shared/types'
import { INTERNAL_PAGES, internalPageUrl, parseInternalUrl } from '@shared/internalPages'
import type { InternalPageId } from '@shared/internalPages'
import { devtoolsFrontendUrl, isDevToolsFrontendUrl } from '@shared/devtools'
import { loadRendererEntry } from './rendererEntry'
import { log, logError } from './logger'

export interface TabEvents {
  'tab-updated': (tab: TabInfo) => void
  'tabs-changed': () => void
  'tab-created': (tab: TabInfo) => void
  'tab-closed': (tab: TabInfo) => void
  'tab-activated': (tab: TabInfo) => void
  /** 主框架导航完成(http(s) 主文档),供插件记录历史等 */
  'tab-navigated': (payload: { tabId: number; url: string; title: string }) => void
}

/** 标签页 webContents 登记口(内容注入用):Electron 44 的 WebContentsView 无法靠 getType 区分 */
export interface PageTracker {
  track(wc: WebContents): void
}

/**
 * 标签种类。三种互斥 —— 不能只靠 `info.internal` 一个布尔值表达,因为三者的约束不一样:
 * - `page`:普通网页/本地文件,参与历史、内容注入与 MCP 页面操作;
 * - `internal`:`bow://` 内部页面(设置页),**持有应用 preload**,只允许载入同一个内部 URL;
 * - `inspector`:远程调试的 DevTools 前端(`devtools://…`),**不给 preload、不进历史、不被 MCP 操作**,
 *   URL 由主进程按 CDP 目标拼出来(见 createInspectorTab)。
 */
export type TabKind = 'page' | 'internal' | 'inspector'

interface TabRecord {
  view: WebContentsView
  info: TabInfo
  kind: TabKind
  /** 内部页面 id(bow://settings 等);kind==='internal' 时非空 */
  internalId: InternalPageId | null
}

export class TabManager extends EventEmitter {
  readonly window: BrowserWindow
  private views = new Map<number, TabRecord>()
  private activeId: number | null = null
  private nextId = 1
  private chromeHeight = 0
  private closedStack: TabInfo[] = [] // 供 Ctrl+Shift+T 恢复(简单实现最近关闭)
  private pageTracker: PageTracker | null = null
  /** 最近处于激活状态的「普通网页标签」(内部页面标签不计入),供插件页面 API 与设置页跳转使用 */
  private lastBrowsingId: number | null = null

  constructor(window: BrowserWindow) {
    super()
    this.window = window
  }

  /** 注入标签页登记口(内核内容注入宿主) */
  setPageTracker(tracker: PageTracker): void {
    this.pageTracker = tracker
  }

  emit<K extends keyof TabEvents>(event: K, ...args: Parameters<TabEvents[K]>): boolean {
    return super.emit(event, ...args)
  }

  on<K extends keyof TabEvents>(event: K, listener: TabEvents[K]): this {
    return super.on(event, listener)
  }

  setChromeHeight(h: number): void {
    this.chromeHeight = h
    this.layout()
  }

  /** 当前 chrome UI 实测高度(页面视图的顶部偏移量,Overlay 条带也据此定位) */
  getChromeHeight(): number {
    return this.chromeHeight
  }

  getActiveTabInfo(): TabInfo | null {
    if (this.activeId == null) return null
    const hit = this.views.get(this.activeId)
    return hit ? { ...hit.info } : null
  }

  /** 活动标签(可能是内部页面标签) */
  private getActiveRecord(): TabRecord | null {
    return this.activeId != null ? this.views.get(this.activeId) ?? null : null
  }

  /** 最近激活的普通网页标签;若已被关闭则回退为 id 最大的普通标签 */
  getLastBrowsingView(): TabRecord | null {
    const remembered = this.lastBrowsingId != null ? this.views.get(this.lastBrowsingId) : null
    if (remembered && !remembered.info.internal) return remembered
    const ids = [...this.views.keys()].sort((a, b) => b - a)
    for (const id of ids) {
      const rec = this.views.get(id)
      if (rec && !rec.info.internal) return rec
    }
    return null
  }

  /** 活动标签优先(仅当它不是内部页面),否则退到最近浏览的网页标签 */
  getActiveBrowsingView(): TabRecord | null {
    const active = this.getActiveRecord()
    if (active && !active.info.internal) return active
    return this.getLastBrowsingView()
  }

  /** 激活最近浏览的网页标签(设置页的「屏蔽元素」等需要回到真实页面执行) */
  activateLastBrowsing(): TabInfo | null {
    const hit = this.getLastBrowsingView()
    if (!hit) return null
    this.activate(hit.info.id)
    return { ...hit.info, active: true }
  }

  /** 向内部页面标签(如设置页)广播消息:普通网页标签没有 preload,不参与广播 */
  broadcastToInternal(channel: string, payload: unknown): void {
    for (const rec of this.views.values()) {
      if (!rec.info.internal) continue
      if (!rec.view.webContents.isDestroyed()) rec.view.webContents.send(channel, payload)
    }
  }

  listTabs(): TabInfo[] {
    const out: TabInfo[] = []
    for (const [, v] of this.views) {
      out.push({ ...v.info })
    }
    out.sort((a, b) => a.id - b.id)
    return out
  }

  getView(id: number): TabRecord | null {
    return this.views.get(id) ?? null
  }

  getActiveView(): TabRecord | null {
    return this.getActiveRecord()
  }

  create(url?: string, activate = true): TabInfo {
    const internalId = url ? parseInternalUrl(url) : null
    // create() 只造 page / internal;第三种(inspector)有自己的入口,见 createInspectorTab()
    const kind: TabKind = internalId ? 'internal' : 'page'
    const id = this.nextId++
    const view = new WebContentsView({
      webPreferences: {
        // 内部页面(如设置)需要 window.browserAPI;普通网页标签坚决不给 preload
        ...(internalId ? { preload: join(__dirname, '../preload/index.js') } : {}),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: true,
        webSecurity: true
      }
    })
    const wc = view.webContents
    // 只有普通网页标签登记内容注入(内部页面与 DevTools 前端都不该被插件规则注入)
    if (kind === 'page') this.pageTracker?.track(wc)
    const info: TabInfo = {
      id,
      url: internalId ? internalPageUrl(internalId) : 'about:blank',
      title: internalId ? INTERNAL_PAGES[internalId].title : '新标签页',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      active: false,
      crashed: false,
      ...(internalId ? { internal: true } : {})
    }
    this.views.set(id, { view, info, kind, internalId })

    wc.on('page-title-updated', (_e, title) => {
      info.title = title || (internalId ? INTERNAL_PAGES[internalId].title : '新标签页')
      this.publish(id)
    })
    this.wireLifecycle(wc, id, info, '标签页')
    const onNavigate = (): void => {
      this.syncNavigation(id)
      this.publish(id)
    }
    // 主框架导航 → 发布 tab-navigated 事件(历史由插件订阅);SPA 内 hash 变化不发布
    // 内部页面使用 file:// 或 dev server URL,不对外暴露为可记录的历史
    wc.on('did-navigate', (_e, url) => {
      if (kind === 'page') this.emit('tab-navigated', { tabId: id, url, title: wc.getTitle() || url })
      onNavigate()
    })
    wc.on('did-navigate-in-page', onNavigate)
    if (kind === 'internal') {
      // 内部页面标签只允许载入内部 URL(否则 preload 会曝露给任意站点)
      wc.on('will-navigate', (e, target) => {
        if (parseInternalUrl(target) === internalId) return
        e.preventDefault()
        log('内部页面标签阻止导航', id, target)
      })
    }

    this.window.contentView.addChildView(view)
    if (activate) this.activate(id, true)
    if (kind === 'internal') loadRendererEntry(wc, INTERNAL_PAGES[internalId!].entry)
    else if (kind === 'page' && url) this.navigate(id, url)
    this.emit('tabs-changed')
    this.layout()
    this.emit('tab-created', { ...info, active: activate })
    log('创建标签', id, url ?? '(blank)')
    return { ...info, active: activate }
  }

  /**
   * 打开一个「远程调试」标签页:把某个 CDP 目标(手机上的 WebView / Chrome 页面)接进 DevTools 前端。
   *
   * 与 create() 的差别都是刻意的:
   * - **不给 preload** —— 前端不是我们的页面,`window.browserAPI` 绝不能出现在里面;
   * - 不登记内容注入、不发布 `tab-navigated`(否则历史里会冒出 devtools:// 条目);
   * - `info.internal = true` → 不进「最近浏览标签」记忆、不被 MCP 页面工具当成操作目标;
   * - 标题不被页面 `<title>` 覆盖(前端固定叫 DevTools,会盖掉「[检查] 商品详情」这种更有用的信息);
   * - 只允许 `devtools://` 内部导航(前端自身刷新),其它地址一律拦掉。
   */
  createInspectorTab(wsUrl: string, title?: string, activate = true): TabInfo {
    const frontend = devtoolsFrontendUrl(wsUrl)
    const id = this.nextId++
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: true,
        webSecurity: true
      }
    })
    const wc = view.webContents
    const info: TabInfo = {
      id,
      url: frontend,
      title: title?.trim() || 'DevTools',
      loading: true,
      canGoBack: false,
      canGoForward: false,
      active: false,
      crashed: false,
      internal: true,
      inspector: true
    }
    this.views.set(id, { view, info, kind: 'inspector', internalId: null })
    this.wireLifecycle(wc, id, info, 'DevTools 前端标签')
    // 前端加载失败不会抛到我们这里(loadURL 的 rejection 只给一部分错误),
    // 单独记一条带错误码的日志:排查「白屏」时 browser.log 是第一现场
    wc.on('did-fail-load', (_e, code, description, validatedUrl) => {
      logError('DevTools 前端加载失败', id, code, description, validatedUrl)
    })
    wc.on('will-navigate', (e, target) => {
      if (isDevToolsFrontendUrl(target)) return
      e.preventDefault()
      log('DevTools 前端标签阻止导航', id, target)
    })

    this.window.contentView.addChildView(view)
    if (activate) this.activate(id, true)
    void wc.loadURL(frontend).catch((e) => {
      logError('DevTools 前端加载失败', id, frontend, String(e))
    })
    this.emit('tabs-changed')
    this.layout()
    this.emit('tab-created', { ...info, active: activate })
    log('创建 DevTools 前端标签', id, wsUrl)
    return { ...info, active: activate }
  }

  /**
   * 三种标签共用的生命周期接线:加载态、崩溃态、销毁后的簿记。
   * create() 与 createInspectorTab() 都必须接这一套 —— 漏了就会出现「标签关了还占着 activeId」。
   */
  private wireLifecycle(wc: WebContents, id: number, info: TabInfo, label: string): void {
    wc.on('did-start-loading', () => {
      info.loading = true
      this.publish(id)
    })
    wc.on('did-stop-loading', () => {
      info.loading = false
      this.publish(id)
    })
    wc.on('render-process-gone', (_e, details) => {
      info.crashed = true
      info.loading = false
      this.publish(id)
      logError(`${label}崩溃`, id, details.reason)
    })
    wc.on('destroyed', () => {
      this.views.delete(id)
      if (this.lastBrowsingId === id) this.lastBrowsingId = null
      if (this.activeId === id) {
        this.activeId = null
        this.activateLastVisible()
      }
      this.emit('tabs-changed')
      this.layout()
    })
  }

  /** 刷新 info 中的 URL / 前进后退能力(内部页面固定为对外 URL,且不可后退) */
  private syncNavigation(id: number): void {
    const hit = this.views.get(id)
    if (!hit) return
    const { info, kind, internalId } = hit
    // DevTools 前端标签的 URL 由主进程设置(devtools://…),不做同步也不可前进后退
    if (kind === 'inspector') {
      info.canGoBack = false
      info.canGoForward = false
      return
    }
    if (internalId) {
      info.url = internalPageUrl(internalId)
      info.canGoBack = false
      info.canGoForward = false
      return
    }
    const wc = hit.view.webContents
    info.url = wc.getURL() || 'about:blank'
    const hist = wc.navigationHistory
    info.canGoBack = hist.canGoBack()
    info.canGoForward = hist.canGoForward()
  }

  private publish(id: number): void {
    const hit = this.views.get(id)
    if (!hit) return
    hit.info.active = id === this.activeId
    this.emit('tab-updated', { ...hit.info })
  }

  activate(id: number, silent = false): void {
    const hit = this.views.get(id)
    if (!hit) return
    if (this.activeId === id) return
    this.activeId = id
    // 内部页面标签不参与「最近浏览标签」记忆
    if (!hit.info.internal) this.lastBrowsingId = id
    for (const [vid, v] of this.views) {
      v.view.setVisible(vid === id)
      if (vid === id) {
        v.info.active = true
        v.view.webContents.focus()
      } else {
        v.info.active = false
      }
    }
    this.layout()
    this.window.webContents.send('tab:activated', id)
    this.emit('tab-activated', { ...hit.info, active: true })
    if (!silent) {
      for (const [, v] of this.views) this.publish(v.info.id)
      this.emit('tabs-changed')
    }
  }

  private activateLastVisible(): void {
    const ids = [...this.views.keys()].sort((a, b) => b - a)
    if (ids.length > 0) this.activate(ids[0], true)
    else {
      // 没有标签了?保持窗口为空 UI,由渲染层或 MCP 主动创建
    }
  }

  close(id: number): { ok: boolean } {
    const hit = this.views.get(id)
    if (!hit) return { ok: false }
    // DevTools 前端标签不进恢复栈:它的意义随目标(可能已消失)与转发(已回收)一起失效
    if (hit.kind !== 'inspector') {
      this.closedStack.push({ ...hit.info })
      if (this.closedStack.length > 10) this.closedStack.shift()
    }
    if (this.lastBrowsingId === id) this.lastBrowsingId = null
    this.emit('tab-closed', { ...hit.info })
    this.emit('tabs-changed')
    this.window.contentView.removeChildView(hit.view)
    hit.view.webContents.close()
    return { ok: true }
  }

  restoreLastClosed(): TabInfo | null {
    const popped = this.closedStack.pop()
    if (!popped) return null
    return this.create(popped.url)
  }

  /** 保证存在活动标签;返回其信息 */
  ensureActive(): TabInfo {
    const active = this.getActiveView()
    if (active) return { ...active.info }
    return this.create(undefined, true)
  }

  /**
   * 就地导航。跨「内部页面 ↔ 普通网页」边界时一律拒绝(返回 false):
   * 内部页面标签持有应用 preload,绝不能载入远程内容;普通标签也不应载入内部页面。
   * 跨界打开请用 openUrl()。
   */
  navigate(id: number, url: string): boolean {
    const hit = this.views.get(id)
    if (!hit) return false
    // DevTools 前端标签是「钉死」的:地址栏输入不会把调试器本身导航走(见 openUrl 会另开标签)
    if (hit.kind === 'inspector') return false
    const internal = parseInternalUrl(url)
    if (hit.internalId) {
      if (internal !== hit.internalId) return false
      return true // 已是该内部页面:不重复加载
    }
    if (internal) return false
    hit.view.webContents.loadURL(url).catch((e) => {
      logError('加载失败', id, url, String(e))
    })
    return true
  }

  /** 打开/聚焦内部页面标签(单例:已存在则仅激活) */
  openInternal(page: InternalPageId): TabInfo {
    for (const rec of this.views.values()) {
      if (rec.kind !== 'internal' || rec.internalId !== page) continue
      this.activate(rec.info.id)
      return { ...rec.info, active: true }
    }
    return this.create(internalPageUrl(page), true)
  }

  /**
   * 统一导航入口(地址栏 / 书签 / 建议 / MCP 共用):
   * - 内部页面 URL → 打开或聚焦对应内部页面标签;
   * - 其它 URL → 活动标签可承载则就地导航,否则新建标签(活动标签是内部页面)。
   */
  openUrl(url: string, activate = true): TabInfo {
    const internal = parseInternalUrl(url)
    if (internal) return this.openInternal(internal)
    const active = this.getActiveRecord()
    if (active && !active.info.internal) {
      this.navigate(active.info.id, url)
      return { ...active.info, active: true }
    }
    return this.create(url, activate)
  }

  back(id: number): boolean {
    const hit = this.views.get(id)
    if (!hit || !hit.view.webContents.navigationHistory.canGoBack()) return false
    hit.view.webContents.navigationHistory.goBack()
    return true
  }

  forward(id: number): boolean {
    const hit = this.views.get(id)
    if (!hit || !hit.view.webContents.navigationHistory.canGoForward()) return false
    hit.view.webContents.navigationHistory.goForward()
    return true
  }

  reload(id: number): void {
    const hit = this.views.get(id)
    if (!hit) return
    if (hit.info.crashed) {
      hit.view.webContents.reload()
      hit.info.crashed = false
      return
    }
    hit.view.webContents.reload()
  }

  stop(id: number): void {
    const hit = this.views.get(id)
    if (hit) hit.view.webContents.stop()
  }

  layout(): void {
    const [w, h] = this.window.getContentSize()
    const top = this.chromeHeight
    const viewH = Math.max(0, h - top)
    for (const [, v] of this.views) {
      v.view.setBounds({ x: 0, y: top, width: w, height: viewH })
    }
  }
}