/** 标签管理:每个标签一个 WebContentsView,主进程统一创建/销毁/激活/布局 */

import { BrowserWindow, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import type { TabInfo } from '@shared/types'
import { log, logError } from './logger'
import { recordVisit } from './history'

export interface TabEvents {
  'tab-updated': (tab: TabInfo) => void
  'tabs-changed': () => void
}

export class TabManager extends EventEmitter {
  readonly window: BrowserWindow
  private views = new Map<number, { view: WebContentsView; info: TabInfo }>()
  private activeId: number | null = null
  private nextId = 1
  private chromeHeight = 0
  private closedStack: TabInfo[] = [] // 供 Ctrl+Shift+T 恢复(简单实现最近关闭)

  constructor(window: BrowserWindow) {
    super()
    this.window = window
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

  private makeInfo(id: number, wc: WebContents, active: boolean): TabInfo {
    const hist = wc.navigationHistory
    return {
      id,
      url: wc.getURL() || 'about:blank',
      title: wc.getTitle() || '新标签页',
      loading: wc.isLoading(),
      canGoBack: hist.canGoBack(),
      canGoForward: hist.canGoForward(),
      active,
      crashed: false
    }
  }

  getActiveTabInfo(): TabInfo | null {
    if (this.activeId == null) return null
    const hit = this.views.get(this.activeId)
    return hit ? { ...hit.info } : null
  }

  listTabs(): TabInfo[] {
    const out: TabInfo[] = []
    for (const [, v] of this.views) {
      out.push({ ...v.info })
    }
    out.sort((a, b) => a.id - b.id)
    return out
  }

  getView(id: number): { view: WebContentsView; info: TabInfo } | null {
    return this.views.get(id) ?? null
  }

  getActiveView(): { view: WebContentsView; info: TabInfo } | null {
    return this.activeId != null ? this.views.get(this.activeId) ?? null : null
  }

  create(url?: string, activate = true): TabInfo {
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
      url: 'about:blank',
      title: '新标签页',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      active: false,
      crashed: false
    }
    this.views.set(id, { view, info })

    wc.on('page-title-updated', (_e, title) => {
      info.title = title || '新标签页'
      this.publish(id)
    })
    wc.on('did-start-loading', () => {
      info.loading = true
      this.publish(id)
    })
    wc.on('did-stop-loading', () => {
      info.loading = false
      this.publish(id)
    })
    const onNavigate = (): void => {
      info.url = wc.getURL()
      const hist = wc.navigationHistory
      info.canGoBack = hist.canGoBack()
      info.canGoForward = hist.canGoForward()
      this.publish(id)
    }
    // 主框架导航 → 记入浏览历史;SPA 内 hash 变化(did-navigate-in-page)不记录
    wc.on('did-navigate', (_e, url) => {
      recordVisit({ title: wc.getTitle() || url, url })
      onNavigate()
    })
    wc.on('did-navigate-in-page', onNavigate)
    wc.on('render-process-gone', (_e, details) => {
      info.crashed = true
      info.loading = false
      this.publish(id)
      logError('标签页崩溃', id, details.reason)
    })
    wc.on('destroyed', () => {
      this.views.delete(id)
      if (this.activeId === id) {
        this.activeId = null
        this.activateLastVisible()
      }
      this.emit('tabs-changed')
      this.layout()
    })

    this.window.contentView.addChildView(view)
    if (activate) this.activate(id, true)
    if (url) this.navigate(id, url)
    this.emit('tabs-changed')
    this.layout()
    log('创建标签', id, url ?? '(blank)')
    return { ...info, active: activate }
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
    this.closedStack.push({ ...hit.info })
    if (this.closedStack.length > 10) this.closedStack.shift()
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

  navigate(id: number, url: string): boolean {
    const hit = this.views.get(id)
    if (!hit) return false
    hit.view.webContents.loadURL(url).catch((e) => {
      logError('加载失败', id, url, String(e))
    })
    return true
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