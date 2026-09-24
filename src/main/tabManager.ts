/** 标签管理:每个标签一个 WebContentsView,主进程统一创建/销毁/激活/布局 */

import { BrowserWindow, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { TabGroupInfo, TabInfo } from '@shared/types'
import { MAX_GROUP_PANES, MIN_PANE, SPLIT_GAP, computeLayout, hasPane, instantiateShape, paneCount, resizePane, shapePaneCount } from '@shared/split'
import type { LayoutGeometry, LayoutNode, LayoutShape, PaneDir, Rect } from '@shared/split'
import {
  findGroupOfTab,
  focusTab,
  focusedTabId,
  groupTabIds,
  insertIndexAfterGroup,
  neighborGroupIdAfterRemoval,
  newTabGroup,
  removeTabFromGroups,
  replaceTabInGroups,
  splitGroup,
  ungroup
} from '@shared/groups'
import type { TabGroup } from '@shared/groups'
import { INTERNAL_PAGES, internalPageUrl, opensInPane, parseInternalUrl } from '@shared/internalPages'
import type { InternalPageId } from '@shared/internalPages'
import { isDevToolsFrontendUrl } from '@shared/devtools'
import { loadRendererEntry } from './rendererEntry'
import { log, logError } from './logger'

export interface TabEvents {
  'tab-updated': (tab: TabInfo) => void
  'tabs-changed': () => void
  'tab-created': (tab: TabInfo) => void
  'tab-closed': (tab: TabInfo) => void
  'tab-activated': (tab: TabInfo) => void
  /** 标签组变化(建组/拆组/换成员/聚焦成员变化/宽度档位变化/窗口缩放) */
  'groups-changed': (groups: TabGroupInfo[]) => void
  /** 主框架导航完成(普通网页与内部页面的逻辑 URL),供插件记录历史等 */
  'tab-navigated': (payload: { tabId: number; url: string; title: string }) => void
  /**
   * 某个标签页视图拿到了**键盘焦点**(chrome 的地址栏/浮层在这一刻起已不是键盘焦点所有者)。
   * chrome 用它收起自己的瞬态面板(地址栏建议下拉 / 分屏面板)——
   * 这些面板原先靠 DOM blur 观测焦点,而跨 WebContentsView 的焦点切换不保证派发 DOM blur。
   */
  'view-focused': (tabId: number) => void
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

export interface TabRecord {
  view: WebContentsView
  info: TabInfo
  kind: TabKind
  /** 内部页面 id(bow://settings 等);kind==='internal' 时非空 */
  internalId: InternalPageId | null
}

/**
 * 标签/标签组 id 分配器。多窗口下由 `WindowManager` 提供**进程级**计数器,
 * 保证 tabId 全局唯一(MCP 的 `tabId` 参数因此不会在窗口间撞号);groupId 同样全局唯一,
 * 免得插件从 `ctx.tabs.list()` 里看到两个窗口的同号组。
 */
export interface TabIdAllocator {
  allocTabId(): number
  allocGroupId(): number
}

/** `https://host/path` → `https://host`;非 http(s)(含 `devtools://`)或者解析不出来 → null */
function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

export class TabManager extends EventEmitter {
  readonly window: BrowserWindow
  private views = new Map<number, TabRecord>()
  private activeId: number | null = null
  private chromeHeight = 0
  private closedStack: TabInfo[] = [] // 供 Ctrl+Shift+T 恢复(简单实现最近关闭)
  private pageTracker: PageTracker | null = null
  /** 最近处于激活状态的「普通网页标签」(内部页面标签不计入),供插件页面 API 与设置页跳转使用 */
  private lastBrowsingId: number | null = null
  /**
   * 标签组列表;顺序 = 标签栏顺序。**标签栏里的每一项就是一个组** —— 普通组 1 个窗格,
   * 分屏组 2..`MAX_GROUP_PANES` 个。活动组由 `activeId` 推出(不另存 `activeGroupId`,省得两边不同步)。
   * 状态只在内存,重启不恢复;记账规则见 `@shared/groups`,树操作见 `@shared/split`。
   */
  private groups: TabGroup[] = []

  constructor(
    window: BrowserWindow,
    private readonly ids: TabIdAllocator
  ) {
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
    return hit ? this.decorate(hit.info) : null
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
      out.push(this.decorate(v.info))
    }
    out.sort((a, b) => a.id - b.id)
    return out
  }

  /** 对外暴露的 TabInfo:补上所属组 id(MCP/插件据此看出哪两个标签是一对) */
  private decorate(info: TabInfo): TabInfo {
    const group = findGroupOfTab(this.groups, info.id)
    return group ? { ...info, groupId: group.id } : { ...info }
  }

  getView(id: number): TabRecord | null {
    return this.views.get(id) ?? null
  }

  /**
   * 由 webContents 反查标签 id(内部页面的 `tab:self` 用它认领自己 —— 终端页据此把会话绑到 tabId 上)。
   * 不是标签页的 webContents(chrome / overlay)返回 null。
   */
  findTabIdByWebContents(wc: WebContents): number | null {
    for (const [id, rec] of this.views) {
      if (rec.view.webContents === wc) return id
    }
    return null
  }

  getActiveView(): TabRecord | null {
    return this.getActiveRecord()
  }

  create(url?: string, activate = true): TabInfo {
    const { id, info } = this.spawn(url)
    // 新标签 = 新组(插在活动组后面)—— **绝不拆已有的分屏组**
    this.insertNewGroup(id)
    if (activate) this.activate(id, true)
    this.publishGroups()
    this.emit('tabs-changed')
    this.layout()
    this.emit('tab-created', this.decorate({ ...info, active: activate }))
    log('创建标签', id, url ?? '(blank)')
    return this.decorate({ ...info, active: activate })
  }

  /**
   * 建标签视图并接线(**不碰标签组、不 activate、不发标签事件**):
   * `create()` / `splitFocused()` / `applyLayout()` 共用。
   * 返回的 `info` 是活的 TabInfo(标题/URL 变化会就地更新),对外给快照前先 `decorate()`。
   */
  private spawn(url?: string): { id: number; info: TabInfo } {
    const internalId = url ? parseInternalUrl(url) : null
    // create() 只造 page / internal;第三种(inspector)有自己的入口,见 createInspectorTab()
    const kind: TabKind = internalId ? 'internal' : 'page'
    const id = this.ids.allocTabId()
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
    // 主框架导航 → 发布 tab-navigated 事件(历史由插件订阅);SPA 内 hash 变化不发布。
    // 内部页面也记一条访问(2026-09-19):它的**真实** URL 是 file://…(或 dev server 地址),
    // 对外一律用逻辑 URL `bow://<id>`,历史/地址栏建议里也只认这个 ——
    // 这样「终端」就能从历史里一键回来(不必再手打整串 bow://terminal)。
    wc.on('did-navigate', (_e, url) => {
      if (kind === 'page') {
        this.emit('tab-navigated', { tabId: id, url, title: wc.getTitle() || url })
      } else if (kind === 'internal' && internalId != null) {
        this.emit('tab-navigated', { tabId: id, url: internalPageUrl(internalId), title: info.title })
      }
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
    if (kind === 'internal') loadRendererEntry(wc, INTERNAL_PAGES[internalId!].entry)
    else if (kind === 'page' && url) this.navigate(id, url)
    return { id, info }
  }

  /**
   * 打开一个「远程调试」标签页:把某个 CDP 目标(手机上的 WebView / Chrome 页面)接进 DevTools 前端。
   *
   * 参数是**已经拼好的前端地址**(由调用方拼,见 `PluginPageApi.openDevToolsTab` 的注释):
   * 既可能是 bow 自带的 `devtools://devtools/bundled/devtools_app.html?ws=…`,
   * 也可能是设备自己指定的 `https://chrome-devtools-frontend.appspot.com/serve_rev/<rev>/inspector.html?ws=…`
   * (设备检查插件的 `device-suggested` 策略;那份前端与设备版本一致,Application 面板才有数据)。
   *
   * 与 create() 的差别都是刻意的:
   * - **不给 preload** —— 前端不是我们的页面,`window.browserAPI` 绝不能出现在里面;
   * - 不登记内容注入、不发布 `tab-navigated`(否则历史里会冒出 devtools:// 条目);
   * - `info.internal = true` → 不进「最近浏览标签」记忆、不被 MCP 页面工具当成操作目标;
   * - 标题不被页面 `<title>` 覆盖(前端固定叫 DevTools,会盖掉「[检查] 商品详情」这种更有用的信息);
   * - 只允许前端自己的导航(`devtools://` 或与入口同源的地址,例如它自己去取某个模块/刷新),其它一律拦掉。
   */
  createInspectorTab(frontend: string, title?: string, activate = true): TabInfo {
    const allowedOrigin = originOf(frontend)
    const id = this.ids.allocTabId()
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
    // DevTools 前端标签同样自成一组(不让它挤进当前正在分屏的组)
    this.insertNewGroup(id)
    this.wireLifecycle(wc, id, info, 'DevTools 前端标签')
    // 前端加载失败不会抛到我们这里(loadURL 的 rejection 只给一部分错误),
    // 单独记一条带错误码的日志:排查「白屏」时 browser.log 是第一现场
    wc.on('did-fail-load', (_e, code, description, validatedUrl) => {
      logError('DevTools 前端加载失败', id, code, description, validatedUrl)
    })
    wc.on('will-navigate', (e, target) => {
      if (isDevToolsFrontendUrl(target) || (allowedOrigin !== null && originOf(target) === allowedOrigin)) return
      e.preventDefault()
      log('DevTools 前端标签阻止导航', id, target)
    })

    this.window.contentView.addChildView(view)
    if (activate) this.activate(id, true)
    void wc.loadURL(frontend).catch((e) => {
      logError('DevTools 前端加载失败', id, frontend, String(e))
    })
    this.publishGroups()
    this.emit('tabs-changed')
    this.layout()
    this.emit('tab-created', this.decorate({ ...info, active: activate }))
    log('创建 DevTools 前端标签', id, frontend)
    return this.decorate({ ...info, active: activate })
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
    // 分屏:点到/敲到活动组的另一个窗格就切过去(地址栏、前进后退、Ctrl+L 都跟随聚焦的那个窗格)。
    // 两个触发源:`focus` 是常规路径;`input-event` 兜底 —— 鼠标点击/滚轮/键盘都会先经过它,
    // 即使某个平台/版本不发 focus 也不会出现「看着这个窗格却在操作那个」。
    // 非活动组的视图是隐藏的,收不到输入,所以只需判「是不是活动组的窗格」。
    // `activate()` 的 `activeId === id` 早退保证不会递归。
    const activatePaneIfGroupMember = (): void => {
      const group = this.activeGroup()
      if (!group || paneCount(group.tree) < 2) return
      if (this.activeId === id) return
      if (!hasPane(group.tree, id)) return
      this.activate(id)
    }
    wc.on('focus', activatePaneIfGroupMember)
    // 键盘焦点落到页面视图 = chrome 侧(地址栏/浮层)失去了键盘焦点。
    // 必须由主进程广播:跨 WebContentsView 的焦点切换没有可靠的 DOM 侧信号
    // (不保证派发 blur,`document.activeElement` 也可能原地不动)。
    wc.on('focus', () => {
      log('键盘焦点交给页面视图', id)
      this.emit('view-focused', id)
    })
    wc.on('input-event', activatePaneIfGroupMember)
    wc.on('destroyed', () => {
      this.views.delete(id)
      if (this.lastBrowsingId === id) this.lastBrowsingId = null
      // 从组里摘掉(组空了就整组消失并切到邻组);先于 activeId 回落,否则会被
      // activateLastVisible() 的「id 最大」抢走焦点
      this.unregisterTab(id)
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
    this.emit('tab-updated', this.decorate(hit.info))
  }

  activate(id: number, silent = false): void {
    const hit = this.views.get(id)
    if (!hit) return
    // 窗口销毁中:没有可显示的目标,且后续的 send/layout 都会撞在已销毁对象上
    // (触发路径:窗口关闭 → 各标签 webContents 依次 destroyed → activateLastVisible)
    if (this.window.isDestroyed()) return
    if (this.activeId === id) return
    // 切标签 = 切到它所在的组(活动组由 activeId 推出);**不拆任何组** ——
    // 这就是「新建 tab3 不再弄丢 tab1|tab2 的分屏」的关键。
    this.activeId = id
    // 内部页面标签不参与「最近浏览标签」记忆
    if (!hit.info.internal) this.lastBrowsingId = id
    // 组内的聚焦成员跟着切(标签栏里高亮哪半、地址栏跟着谁,都看它)
    this.groups = focusTab(this.groups, id)
    for (const [vid, v] of this.views) {
      if (vid === id) {
        v.info.active = true
        v.view.webContents.focus()
      } else {
        v.info.active = false
      }
    }
    // 可见性由 layout() 统一决定(不再在这里 setVisible):分屏时两半都可见
    this.layout()
    this.window.webContents.send('tab:activated', id)
    this.emit('tab-activated', { ...hit.info, active: true })
    if (!silent) {
      for (const [, v] of this.views) this.publish(v.info.id)
      this.emit('tabs-changed')
    }
    // 组内聚焦成员变了 → 标签栏要重画哪半高亮
    this.publishGroups()
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
    // 关掉组里的一个标签:组降级为单标签(剩下的那半独占整窗);组空了就整个项消失
    const closing = this.decorate(hit.info)
    this.unregisterTab(id)
    // DevTools 前端标签不进恢复栈:它的意义随目标(可能已消失)与转发(已回收)一起失效
    if (hit.kind !== 'inspector') {
      this.closedStack.push({ ...hit.info })
      if (this.closedStack.length > 10) this.closedStack.shift()
    }
    if (this.lastBrowsingId === id) this.lastBrowsingId = null
    this.emit('tab-closed', closing)
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

  /**
   * 打开/聚焦内部页面标签。`singleton`(由 `@shared/internalPages` 的登记表声明)决定语义:
   * - true(设置页):已存在则仅激活,不堆出第二个;
   * - false(终端页):**每次新建** —— 每个终端标签一个独立 shell 会话。
   *
   * 注:`openIn:'pane'` 的页面(终端)走地址栏时先试 `openInternalInPane()`(顶替聚焦窗格),
   * 只有**没有活动窗格**时才回落到这里开新标签。
   */
  openInternal(page: InternalPageId): TabInfo {
    if (INTERNAL_PAGES[page].singleton) {
      for (const rec of this.views.values()) {
        if (rec.kind !== 'internal' || rec.internalId !== page) continue
        this.activate(rec.info.id)
        return { ...rec.info, active: true }
      }
    }
    return this.create(internalPageUrl(page), true)
  }

  /**
   * 在**当前聚焦窗格**就地打开内部页面(地址栏输入 `bow://terminal` 的通路):
   * 不新建标签、也不自己造分屏 —— 新建一个带应用 preload 的内部页面视图**顶替**原窗格的叶子
   * (树结构与几何不变,`replaceTabInGroups`),再把旧标签 `close()` 掉(进关闭栈,`Ctrl+Shift+T` 可找回)。
   *
   * 为什么必须换视图而不是 `navigate()`:内部页面依赖应用 preload,而 preload 只在 `WebContentsView`
   * 创建时给(`spawn()`),普通标签的 webContents 永远变不成内部页面 —— 见 `navigate()` 的跨边界拒绝。
   *
   * 聚焦窗格**已经是**该内部页面 → 什么都不做(返回 null,调用方保持现状)。
   */
  openInternalInPane(page: InternalPageId): TabInfo | null {
    const group = this.activeGroup()
    const oldId = group ? focusedTabId(group) : null
    if (group == null || oldId == null) return null
    const old = this.views.get(oldId)
    // 焦点 id 漂移(理论上不该发生):宁可不动,也不造一个不在任何组里的孤儿视图
    if (!old) return null
    if (old.internalId === page) return null
    const { id, info } = this.spawn(internalPageUrl(page))
    this.groups = replaceTabInGroups(this.groups, oldId, id)
    // 先激活:新 id 已在树里,layout() 立刻把它摆到原窗格的 rect 上
    this.activate(id)
    // 再关旧标签:此时 activeId 已是 id,close() 不会把焦点清空
    this.close(oldId)
    this.emit('tab-created', this.decorate({ ...info, active: true }))
    log('聚焦窗格内打开', page, oldId, '→', id)
    return this.getActiveTabInfo()
  }

  /**
   * 统一导航入口(地址栏 / 书签 / 建议 / MCP 共用):
   * - 「顶替窗格」型内部页面(终端)→ 就地顶替聚焦窗格(已是它则不动);
   * - 其它内部页面 URL → 打开或聚焦对应内部页面标签;
   * - 其它 URL → 活动标签可承载则就地导航,否则新建标签(活动标签是内部页面)。
   */
  openUrl(url: string, activate = true): TabInfo {
    const internal = parseInternalUrl(url)
    if (internal) {
      if (opensInPane(internal)) {
        // 顶替成功→新终端;已是终端→当前标签(不生效);没有活动窗格→回落到新标签
        return this.openInternalInPane(internal) ?? this.getActiveTabInfo() ?? this.openInternal(internal)
      }
      return this.openInternal(internal)
    }
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

  // ---------- 标签组(标签栏的一项 = 一个组;分屏组两个标签) ----------

  /**
   * 标签组快照(渲染层标签栏与分屏面板的唯一数据源)。
   * 几何只给**当前显示的那个组**算(其它组根本没显示);每次现算,窗口缩放 / chrome 高度变化后
   * 渲染层才拿得到新值。
   */
  listGroups(): TabGroupInfo[] {
    const active = this.activeGroup()
    const geo = active ? this.geometryOf(active) : null
    const isActive = (g: TabGroup): boolean => active != null && g.id === active.id
    return this.groups.map((g) => ({
      id: g.id,
      tabIds: groupTabIds(g),
      focus: g.focus,
      panes: geo && isActive(g) ? geo.panes.map((p) => ({ tabId: p.tabId, rect: { ...p.rect } })) : [],
      dividers: geo && isActive(g) ? geo.dividers.map((d) => ({ ...d })) : []
    }))
  }

  /** 活动组的窗格与分隔条几何(窗口内容坐标:页面区从 chromeHeight 起)。几何只有这一处实现 */
  private geometryOf(group: TabGroup): LayoutGeometry {
    const [w, h] = this.window.isDestroyed() ? [0, 0] : this.window.getContentSize()
    const top = this.chromeHeight
    return computeLayout(group.tree, { x: 0, y: top, width: w, height: Math.max(0, h - top) }, {
      gap: SPLIT_GAP,
      minPane: MIN_PANE,
      focusedTabId: this.activeId
    })
  }

  /** 活动组 = 含 `activeId` 的那个(不另存 activeGroupId,省得两边不同步) */
  private activeGroup(): TabGroup | null {
    return this.activeId == null ? null : findGroupOfTab(this.groups, this.activeId)
  }

  private publishGroups(): void {
    this.emit('groups-changed', this.listGroups())
  }

  /** 新标签 → 新组,插在活动组后面(新标签**绝不**拆已有的组) */
  private insertNewGroup(tabId: number): TabGroup {
    const group = newTabGroup(this.ids.allocGroupId(), tabId)
    const at = insertIndexAfterGroup(this.groups, this.activeGroup()?.id ?? null)
    this.groups = [...this.groups.slice(0, at), group, ...this.groups.slice(at)]
    return group
  }

  /**
   * 把一个窗格从组里摘掉(`close()` 与 `destroyed` 共用)。
   * - 组还剩窗格 → 容器塌缩,焦点交给阅读顺序里的下一个(它接着占那块地方);
   * - 组空了 → 整组移除,活动组换到**最近的邻组**;
   * - 被摘掉的标签本来就是活动标签时,`activeId` 会落到新选中的那个上。
   * 反复调用是幂等的(标签不在任何组里就什么都不做)。
   */
  private unregisterTab(id: number): void {
    const before = this.groups
    const res = removeTabFromGroups(this.groups, id)
    this.groups = res.groups
    const wasActive = this.activeId === id
    if (wasActive) this.activeId = null
    if (wasActive && res.focusTabId != null) {
      // 组还在:焦点交给幸存的那半(activate 内部会 layout + 通知)
      this.activate(res.focusTabId)
    } else if (wasActive && res.removedGroupId != null) {
      // 整个组没了:切到最近的邻组
      const nextGroupId = neighborGroupIdAfterRemoval(before, [res.removedGroupId])
      const next = nextGroupId != null ? this.groups.find((g) => g.id === nextGroupId) ?? null : null
      const focus = next ? focusedTabId(next) : null
      if (focus != null) this.activate(focus)
      else this.activateLastVisible()
    }
    this.publishGroups()
  }

  /**
   * 在**当前聚焦窗格**上分屏:新标签开一个空白页,按 `dir` 嵌到那个窗格旁边(→ 右、← 左、↑ 上、↓ 下),
   * 并立即聚焦它(可以接着在地址栏里输网址)。组里窗格数到 `MAX_GROUP_PANES` 就不再响应。
   */
  splitFocused(dir: PaneDir): boolean {
    const active = this.activeGroup()
    if (!active) return false
    if (paneCount(active.tree) >= MAX_GROUP_PANES) {
      log('分屏已达窗格上限', active.id, MAX_GROUP_PANES)
      return false
    }
    const focusId = focusedTabId(active)
    if (focusId == null) return false
    const { id, info } = this.spawn('about:blank')
    this.groups = splitGroup(this.groups, active.id, focusId, dir, id)
    // activate 内部会 layout + publishGroups + 发 tabs-changed
    this.activate(id)
    this.emit('tab-created', this.decorate({ ...info, active: true }))
    log('分屏', dir, id)
    return true
  }

  /**
   * 调整聚焦窗格的大小(箭头 = 把**最内层那条同轴分隔条**朝该方向推)。
   * 没有同轴祖先、或那条已夹到 `RATIO_MIN/MAX` ⇒ 不动(返回 false,也不发事件)。
   */
  resizeFocused(dir: PaneDir): boolean {
    const active = this.activeGroup()
    if (!active) return false
    const focusId = focusedTabId(active)
    if (focusId == null) return false
    const tree = resizePane(active.tree, focusId, dir)
    if (tree === active.tree) return false
    this.groups = this.groups.map((g) => (g.id === active.id ? { ...g, tree } : g))
    this.layout()
    this.publishGroups()
    return true
  }

  /** 活动组的布局树(保存布局用;没有活动组返回 null) */
  activeGroupTree(): LayoutNode | null {
    return this.activeGroup()?.tree ?? null
  }

  /**
   * 套用一个保存的布局:建 N 个空白标签,按形状摆成一棵新树,**在活动组后面**插一个新的标签栏项
   * 并切过去(现有分屏不被动)。形状与窗格数对不上时不做任何事。
   */
  applyLayout(shape: LayoutShape): TabGroupInfo[] {
    const count = shapePaneCount(shape)
    if (count < 2) return this.listGroups()
    const ids: number[] = []
    for (let i = 0; i < count; i += 1) ids.push(this.spawn('about:blank').id)
    const tree = instantiateShape(shape, ids)
    if (!tree) {
      logError('套用布局失败:窗格数与形状不一致', count)
      return this.listGroups()
    }
    const group: TabGroup = { id: this.ids.allocGroupId(), tree, focus: ids[0] }
    const at = insertIndexAfterGroup(this.groups, this.activeGroup()?.id ?? null)
    this.groups = [...this.groups.slice(0, at), group, ...this.groups.slice(at)]
    for (const id of ids) {
      const rec = this.views.get(id)
      if (rec) this.emit('tab-created', this.decorate({ ...rec.info, active: id === ids[0] }))
    }
    this.activate(ids[0])
    log('套用布局', group.id, count)
    return this.listGroups()
  }

  /**
   * 取消分屏:把当前组的 N 个窗格拆成**相邻的 N 个单标签组**(顺序 = 阅读顺序,标签都不销毁)。
   * 活动标签不变 ⇒ 它所在的那个新组仍是活动组。
   */
  ungroupActive(): TabGroupInfo[] {
    const active = this.activeGroup()
    if (!active) return this.listGroups()
    const count = paneCount(active.tree)
    if (count < 2) return this.listGroups()
    const ids = Array.from({ length: count - 1 }, () => this.ids.allocGroupId())
    this.groups = ungroup(this.groups, active.id, ids)
    this.layout()
    this.publishGroups()
    return this.listGroups()
  }

  /** 激活某个组(默认聚焦它记住的那一半)—— Ctrl+数字用 */
  activateGroup(groupId: number): TabInfo | null {
    const group = this.groups.find((g) => g.id === groupId)
    const focus = group ? focusedTabId(group) : null
    if (focus == null) return null
    this.activate(focus)
    return this.getActiveTabInfo()
  }

  /**
   * 布局:可见集合 = **活动组的可见窗格**(树里因为太窄而被退化的分支不显示)。
   * 也是**可见性的唯一来源** —— 别的组的窗格一律 hide。
   * 旧实现把 `setVisible` 放在 `activate()` 里,导致 `create(url, activate=false)` 的后台标签视图
   * (View 默认可见)盖在当前页上。
   */
  layout(): void {
    // 窗口销毁过程中各标签 view 的 webContents 会依次 `destroyed`,`wireLifecycle` 的处理器
    // 仍会走到 activateLastVisible() → 这里 —— 对已销毁的窗口取尺寸会抛
    // `Object has been destroyed`(每个标签一条)。见 docs/ARCHITECTURE.md §10。
    if (this.window.isDestroyed()) return
    const active = this.activeGroup()
    const geo = active ? this.geometryOf(active) : null
    const boxes = new Map<number, Rect>()
    for (const pane of geo?.panes ?? []) boxes.set(pane.tabId, pane.rect)
    for (const [id, v] of this.views) {
      const rect = boxes.get(id)
      if (rect) {
        v.view.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        v.view.setVisible(true)
      } else {
        v.view.setVisible(false)
      }
    }
    // 分屏几何(比例 / 窗口缩放 / chrome 高度)变了 → 渲染层重画分隔条
    if (active && paneCount(active.tree) > 1) this.publishGroups()
  }
}