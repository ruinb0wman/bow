/**
 * 底部居中通知宿主(每窗口一个):一个透明、**按内容实际高度精确摆放**的 `WebContentsView`。
 *
 * 为什么必须自己开一个视图:`docs/ARCHITECTURE.md §3` 说得清楚 —— 页面视图永远绘制在 chrome 之上,
 * 要浮在页面上的 UI 只有 Overlay 一类宿主能做;而 chrome 自己的 webContents 铺在页面**下面**,
 * 画在它底部的东西根本看不见。所以通知需要一个和 Overlay 平级的顶层视图。
 *
 * 水平位置:贴窗口内容区**底部居中**(`x = (内容宽 - 视图宽) / 2`)。
 *
 * 为什么不能「铺满窗口 + CSS 点击穿透」:`setIgnoreMouseEvents` 只存在于 BaseWindow / BrowserWindow
 * (见 electron 的 electron.d.ts),`View` / `WebContentsView` **没有**。铺满窗口的视图会把落在这块矩形里的
 * 点击全部吃掉,页面上的按钮就点不动了。所以这里的 bounds 必须刚好包住通知卡片 ——
 * 高度由渲染层量完经 `toast:height` 上报(`ui:chrome-height` 的同一套思路)。
 *
 * 与 `OverlayManager` 的关系:**不复用**。Overlay 是「同一时刻一份内容」的替换语义(modal 与地址栏建议
 * 互斥),而通知要堆叠、要自动消失、还不能抢键盘焦点。两者的 `raise()` 时机(每次 `tabs-changed`)一样。
 *
 * 数据流是单向的:主进程(见 `main/agentNotify.ts`)是通知栈的权威,`set()` 整体下发;
 * 视图只回三条消息 —— `toast:height`(实测高度)、`toast:dismiss`(×)、`toast:activate`(点卡片进标签)。
 */

import { BrowserWindow, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import { join } from 'node:path'
import type { AgentToastItem } from '@shared/agentState'
import { rendererEntry } from './rendererEntry'
import { log, logError } from './logger'

/** 通知区宽度与贴边距离(CSS px) */
export const TOAST_WIDTH = 360
export const TOAST_MARGIN = 12
/**
 * 单条通知的估算高度:渲染层实测(`toast:height`)回来之前先用它,避免视图一开始是 0 高。
 * 故意取偏大值 —— 估算偏大只是短暂多挡一点区域,偏小会让通知被裁掉。
 */
const TOAST_ESTIMATED_ITEM_HEIGHT = 104

export class ToastManager {
  private view: WebContentsView | null = null
  private current: AgentToastItem[] = []
  /** 渲染层实测的整栈高度,以及它对应的**条数**(条数变了就不算数了) */
  private measured = { count: -1, height: 0 }

  constructor(private window: BrowserWindow) {
    window.on('resize', () => this.layout())
    window.on('closed', () => this.destroy())
  }

  items(): readonly AgentToastItem[] {
    return this.current
  }

  getItem(id: string): AgentToastItem | null {
    return this.current.find((t) => t.id === id) ?? null
  }

  /** 通知栈的权威入口:整体替换(空数组 = 收起) */
  set(items: readonly AgentToastItem[]): void {
    // 窗口已销毁:任何 set 都必须退化成空操作。否则「关窗口后又有新通知进门」会在
    // ensureView() 里对已销毁的 BrowserWindow 调 contentView(抛错)—— 而这条路径是可达的:
    // index.ts 的窗口 closed 处理器会补发 tabClosed,但迟到的信号 / 定时器都可能先一步。
    if (this.window.isDestroyed()) return
    const wasEmpty = this.current.length === 0
    this.current = [...items]
    if (this.current.length === 0) {
      if (wasEmpty) return
      // 先把空栈同步给视图(否则它的 DOM 里还留着上一批卡片),再收起来
      this.send('toast:show', { items: [] })
      this.hide()
      return
    }
    if (!this.view) this.ensureView()
    this.raise()
    this.view!.setVisible(true)
    this.layout()
    this.send('toast:show', { items: this.current })
  }

  /** 渲染层量出来的整栈高度(在 `layout()` 里用;只在这个条数上有效) */
  setHeight(px: number): void {
    const next = Number.isFinite(px) ? Math.max(0, Math.round(px)) : 0
    if (next === this.measured.height && this.measured.count === this.current.length) return
    this.measured = { count: this.current.length, height: next }
    this.layout()
  }

  /** 重排到最顶层(新增标签视图、打开浮层之后都要来一次;由 index.ts / ipc.ts 触发) */
  raise(): void {
    if (this.view == null) return
    this.window.contentView.addChildView(this.view)
  }

  /** 贴底部居中摆放;高度 = 渲染层实测(没量过就按条数估算) */
  layout(): void {
    if (this.view == null || this.window.isDestroyed()) return
    const [w, h] = this.window.getContentSize()
    const height = this.targetHeight(h)
    if (height <= 0) {
      this.view.setVisible(false)
      return
    }
    const width = Math.max(120, Math.min(TOAST_WIDTH, w - TOAST_MARGIN * 2))
    // 居中:x 由剩余空间对半;窄窗口下 width 被夹到 `w - 2*MARGIN`,结果正好是 MARGIN
    const x = Math.max(0, Math.round((w - width) / 2))
    this.view.setBounds({ x, y: h - height - TOAST_MARGIN, width, height })
  }

  /** 这个 webContents 是不是本窗口的通知视图(`WindowManager.byWebContents` 用) */
  hasWebContents(wc: WebContents): boolean {
    return this.view != null && this.view.webContents === wc
  }

  /** 向通知视图发消息(wc 不存在或已销毁则忽略) */
  send(channel: string, ...args: unknown[]): void {
    if (this.view == null) return
    const wc = this.view.webContents
    if (!wc.isDestroyed()) wc.send(channel, ...args)
  }

  private targetHeight(windowHeight: number): number {
    if (this.current.length === 0) return 0
    // 实测值只对它被量出来的那个条数有效:条数变了就先按估算摆,等渲染层重新量
    const measured = this.measured.count === this.current.length ? this.measured.height : 0
    const wanted = measured > 0 ? measured : this.current.length * TOAST_ESTIMATED_ITEM_HEIGHT
    return Math.min(wanted, Math.max(0, windowHeight - TOAST_MARGIN * 2))
  }

  private hide(): void {
    if (this.view == null) return
    this.measured = { count: -1, height: 0 }
    this.view.setVisible(false)
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
    view.setBackgroundColor('#00000000') // 透明,只露出卡片
    view.setVisible(false)

    const wc = view.webContents
    wc.on('will-navigate', (e) => e.preventDefault())
    wc.on('did-finish-load', () => {
      // 首次加载可能错过 `toast:show`,加载完补发一次当前栈
      if (this.current.length === 0) return
      this.raise()
      this.view?.setVisible(true)
      this.layout()
      this.send('toast:show', { items: this.current })
    })
    wc.on('did-fail-load', (_e, code, desc) => {
      if (code === -3) return // ERR_ABORTED(主动取消导航)
      logError('通知视图加载失败', code, desc)
    })
    wc.on('render-process-gone', (_e, details) => {
      logError('通知视图渲染进程崩溃', details.reason)
      this.recreate()
    })

    const entry = rendererEntry('toast')
    if (entry.kind === 'url') void wc.loadURL(entry.target)
    else void wc.loadFile(entry.target)
    this.raise()
  }

  /** 崩溃后重建;若还有通知则重新推一次(与 OverlayManager.recreate 同姿态) */
  private recreate(): void {
    const old = this.view
    this.view = null
    this.measured = { count: -1, height: 0 }
    if (old && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(old)
      if (!old.webContents.isDestroyed()) old.webContents.close()
    }
    if (this.current.length > 0) {
      log('通知视图已重建,重推通知栈', this.current.length)
      this.set(this.current)
    }
  }

  private destroy(): void {
    const old = this.view
    this.view = null
    this.current = []
    if (old && !old.webContents.isDestroyed()) old.webContents.close()
  }
}
