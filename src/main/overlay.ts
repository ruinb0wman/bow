/** 顶层透明 Overlay:承载书签管理/设置弹层,常驻 contentView 最顶层,平时隐藏 */

import { BrowserWindow, WebContentsView } from 'electron'
import { join } from 'node:path'
import type { ModalKind } from '@shared/types'
import { log, logError } from './logger'
import type { TabManager } from './tabManager'

const isDev = !!process.env['ELECTRON_RENDERER_URL']

export class OverlayManager {
  private view: WebContentsView | null = null
  private kind: ModalKind | null = null

  constructor(
    private window: BrowserWindow,
    private tabs: TabManager
  ) {
    window.on('resize', () => this.layout())
    window.on('closed', () => this.destroy())
  }

  /** 当前是否有弹层打开 */
  get isOpen(): boolean {
    return this.kind != null
  }

  /** 打开(或切换)弹层;懒创建 Overlay 视图 */
  open(kind: ModalKind): void {
    if (this.kind === kind && this.view && this.view.getVisible()) return
    this.kind = kind
    const first = this.view == null
    if (first) this.ensureView()
    this.raise()
    this.view!.setVisible(true)
    this.layout()
    // 首次打开时页面可能还在加载,发送由 did-finish-load 兜底重放
    if (!first) this.send('overlay:open', kind)
    this.view!.webContents.focus()
    log('弹层打开', kind)
  }

  /** 关闭弹层并把焦点还给活动标签页 */
  close(): void {
    if (this.kind == null) return
    this.kind = null
    if (this.view) {
      // 视图只是隐藏、并不销毁,需顺手关掉它的 DevTools 窗口,避免留下孤立窗口
      if (!this.view.webContents.isDestroyed()) this.view.webContents.closeDevTools()
      this.view.setVisible(false)
      this.send('overlay:close')
    }
    const active = this.tabs.getActiveView()
    if (active) active.view.webContents.focus()
    log('弹层关闭')
  }

  /** 重排到 contentView 最顶层(文档保证:已存在的子视图重新 add 会置顶) */
  raise(): void {
    if (this.view == null) return
    this.window.contentView.addChildView(this.view)
  }

  /** 跟随窗口尺寸铺满整个 contentView */
  layout(): void {
    if (this.view == null || this.window.isDestroyed()) return
    const [w, h] = this.window.getContentSize()
    this.view.setBounds({ x: 0, y: 0, width: w, height: h })
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
    view.setBackgroundColor('#00000000') // 透明,露出下方页面做遮罩
    view.setVisible(false)

    const wc = view.webContents
    wc.on('will-navigate', (e) => e.preventDefault())
    wc.on('did-finish-load', () => {
      // 首次加载完成时补发当前弹层状态(可能错过第一次发送)
      if (this.kind) {
        this.raise()
        this.view!.setVisible(true)
        this.layout()
        this.send('overlay:open', this.kind)
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

  /** 渲染进程崩溃/加载失效时重建视图;若弹层正开着则自动重新打开 */
  private recreate(): void {
    const old = this.view
    this.view = null
    const kind = this.kind
    this.kind = null
    if (old && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(old)
      if (!old.webContents.isDestroyed()) old.webContents.close()
    }
    if (kind) this.open(kind)
  }

  private destroy(): void {
    const old = this.view
    this.view = null
    this.kind = null
    if (old && !old.webContents.isDestroyed()) old.webContents.close()
  }
}