/**
 * 通用顶层 Overlay 浮层宿主:常驻 contentView 最顶层的透明 WebContentsView,
 * 按内容 id 切换渲染(chrome 侧通过注册表组件呈现书签/设置弹层、建议下拉等)。
 *
 * 布局位(placement):
 * - full:铺满整个窗口(modal 弹层,遮罩盖住 chrome + 页面);
 * - below-chrome:页面区条带(地址栏建议下拉),不遮工具栏/标签栏,始终可点。
 */

import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'node:path'
import type { OverlayContent, OverlayContentId, OverlayPlacement, OverlayShowMessage, SuggestPayload } from '@shared/types'
import { log, logError } from './logger'
import type { TabManager } from './tabManager'

const isDev = !!process.env['ELECTRON_RENDERER_URL']

export class OverlayManager {
  private view: WebContentsView | null = null
  private current: OverlayContent | null = null

  constructor(
    private window: BrowserWindow,
    private tabs: TabManager
  ) {
    window.on('resize', () => this.layout())
    window.on('closed', () => this.destroy())
  }

  /** 当前是否有任何浮层打开 */
  get isOpen(): boolean {
    return this.current != null
  }

  get currentId(): OverlayContentId | null {
    return this.current?.id ?? null
  }

  /** 显示(或更新)/隐藏浮层;null 表示关闭 */
  show(content: OverlayContent | null): void {
    if (content == null) {
      if (this.current == null) return
      // modal 关闭后焦点还给活动标签页;suggest 场景焦点本就在 chrome(地址栏),不动
      const refocusTab = this.current.placement === 'full'
      this.current = null
      if (this.view && !this.view.webContents.isDestroyed()) {
        // 视图只是隐藏、并不销毁,需顺手关掉它的 DevTools 窗口,避免留下孤立窗口
        this.view.webContents.closeDevTools()
        this.view.setVisible(false)
        this.send('overlay:show', null)
      }
      if (refocusTab) {
        const active = this.tabs.getActiveView()
        if (active) active.view.webContents.focus()
      }
      log('Overlay 隐藏')
      return
    }

    // 互斥:modal 打开期间不受理 suggest(实际不可达,防御)
    if (content.id === 'suggest' && this.current?.placement === 'full') {
      log('Overlay 忽略 suggest:modal 已打开')
      return
    }

    this.current = content
    const first = this.view == null
    if (first) this.ensureView()
    this.raise()
    this.view!.setVisible(true)
    this.layout()
    // 首次打开时页面可能还在加载,发送由 did-finish-load 兜底重放
    if (!first) this.send('overlay:show', this.showMessage())
    // modal 弹层需要接管键盘/输入焦点;suggest 则保留 chrome 地址栏焦点
    if (content.placement === 'full') this.view!.webContents.focus()
    log('Overlay 显示', content.id)
  }

  /** 重排到 contentView 最顶层(文档保证:已存在的子视图重新 add 会置顶) */
  raise(): void {
    if (this.view == null) return
    this.window.contentView.addChildView(this.view)
  }

  /** 按 placement 切视图 bounds:full 铺满窗口;below-chrome 从地址栏底边起始 */
  layout(): void {
    if (this.view == null || this.window.isDestroyed()) return
    const [w, h] = this.window.getContentSize()
    if (this.current == null || this.current.placement === 'full') {
      this.view.setBounds({ x: 0, y: 0, width: w, height: h })
      return
    }
    const bandY = this.bandTopOf()
    this.view.setBounds({ x: 0, y: bandY, width: w, height: Math.max(0, h - bandY) })
  }

  /**
   * below-chrome 条带的窗口坐标 y:默认取 chrome 实测高度(绝不上盖工具栏);
   * 建议打开时收紧到地址栏底边(工具栏下方 5px 内无交互元素),让面板与地址栏无缝衔接。
   * 假设:当前 UI 中工具栏是 chrome 的最后一行(若将来加书签栏等整行,此处应回退为 chrome 高度)。
   */
  private bandTopOf(): number {
    if (this.current == null || this.current.placement !== 'below-chrome') return 0
    const [, h] = this.window.getContentSize()
    const base = this.tabs.getChromeHeight()
    const rect = (this.current.payload as SuggestPayload | undefined)?.rect
    if (!rect) return base
    return Math.max(0, Math.min(base, Math.ceil(rect.y + rect.height), h - 1))
  }

  /** 组装发给 overlay 页面的展示消息(bandTop 由主进程注入) */
  private showMessage(): OverlayShowMessage {
    const placement: OverlayPlacement = this.current?.placement ?? 'full'
    const bandTop = placement === 'below-chrome' ? this.bandTopOf() : 0
    return {
      id: this.current!.id,
      payload: this.current!.payload,
      placement,
      meta: { bandTop }
    } as OverlayShowMessage
  }

  /** 向 overlay 页面发消息(wc 不存在或已销毁则忽略) */
  send(channel: string, ...args: unknown[]): void {
    if (this.view == null) return
    const wc = this.view.webContents
    if (!wc.isDestroyed()) wc.send(channel, ...args)
  }

  private ensureView(): void {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.view = view
    view.setBackgroundColor('#00000000') // 透明,露出下方页面/工具栏
    view.setVisible(false)

    const wc = view.webContents
    wc.on('will-navigate', (e) => e.preventDefault())
    wc.on('did-finish-load', () => {
      // 首次加载完成时补发当前浮层状态(可能错过第一次发送)
      if (this.current) {
        this.raise()
        this.view!.setVisible(true)
        this.layout()
        this.send('overlay:show', this.showMessage())
      }
    })
    wc.on('did-fail-load', (_e, code, desc) => {
      if (code === -3) return // ERR_ABORTED(主动取消导航)
      logError('Overlay 加载失败', code, desc)
    })
    wc.on('render-process-gone', (_e, details) => {
      logError('Overlay 渲染进程崩溃', details.reason)
      this.recreate()
    })

    if (isDev && process.env['ELECTRON_RENDERER_URL']) {
      void wc.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
    } else {
      void wc.loadFile(join(__dirname, '../renderer/overlay.html'))
    }
    this.raise()
  }

  /** 渲染进程崩溃/加载失效时重建视图;若浮层正开着则自动重新打开 */
  private recreate(): void {
    const old = this.view
    this.view = null
    const content = this.current
    this.current = null
    if (old && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(old)
      if (!old.webContents.isDestroyed()) old.webContents.close()
    }
    if (content) this.show(content)
  }

  private destroy(): void {
    const old = this.view
    this.view = null
    this.current = null
    if (old && !old.webContents.isDestroyed()) old.webContents.close()
  }
}