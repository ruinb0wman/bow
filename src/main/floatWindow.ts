/**
 * 浮动窗口:工具栏「本地服务」里的小窗,内容是那条服务自己的页面。
 *
 * 为什么是 WebContentsView 而不是塞进 overlay 的 iframe(见 `overlay.ts` 顶部那条 ⚠️):
 * - overlay 是**全窗**视图,没有点击穿透 —— 拿它装浮窗,底下的页面就点不动了;
 * - iframe 被 `X-Frame-Options` / CSP `frame-ancestors` 拦下时是静默白屏,探测不到。
 * WebContentsView 与标签页吃同一份 session / UA / 代理,HMR、登录态、`window.open` 都照常;
 * 只要 bounds 严格等于浮窗矩形(几何在 `@shared/floatWindow`),就不存在上面的点击问题。
 *
 * 边界:**一个窗口一个浮窗**(换服务 = 换 URL)。它不进标签列表、历史、MCP 的目标集合 ——
 * 它就是「看一眼」的窗口;要长期用一个页面就 Ctrl+点击开成标签。
 *
 * 关闭的三个入口:再点一次工具栏图标(开关)、浮窗里按 Esc、切到别的服务。
 * 没有自绘标题栏 —— 加一条 overlay 条带盖住页面顶部 32px 的代价大于收益(见方案讨论)。
 */

import { WebContentsView } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { floatRect, normalizeFloatPrefs } from '@shared/floatWindow'
import type { FloatPrefs, FloatRequest, FloatState } from '@shared/floatWindow'
import { log, logError } from './logger'
import type { TabManager } from './tabManager'

export type { FloatRequest, FloatState } from '@shared/floatWindow'

export class FloatWindowManager {
  private view: WebContentsView | null = null
  private url: string | null = null
  private prefs: FloatPrefs | null = null
  private visible = false
  private onState: ((state: FloatState) => void) | null = null

  constructor(
    private window: BrowserWindow,
    private tabs: TabManager
  ) {
    window.on('resize', () => this.layout())
    window.on('closed', () => this.destroy())
    // 新建 / 切换标签会把页面视图重新 add 进 contentView(= 盖在浮窗上),所以每次都要提回来。
    // 反向不成立:overlay 在自己的 show() 里提到最高,modal 照样能盖住浮窗。
    tabs.on('tab-created', () => this.raise())
    tabs.on('tab-activated', () => this.raise())
  }

  get state(): FloatState {
    return { open: this.visible, url: this.visible ? this.url : null }
  }

  onStateChange(cb: (state: FloatState) => void): void {
    this.onState = cb
  }

  /** 工具栏点击:同一条服务再点一次 = 关掉 */
  toggle(req: FloatRequest): FloatState {
    if (this.visible && this.url === req.url) return this.hide()
    return this.show(req)
  }

  show(req: FloatRequest): FloatState {
    if (this.window.isDestroyed()) return this.state
    // 调用方是渲染层,prefs 属于信任边界:写脏了宁可不开,也不要把浮窗摆到窗口外面
    const prefs = normalizeFloatPrefs(req.prefs)
    if (prefs == null || typeof req.url !== 'string' || !req.url) return this.state
    this.prefs = prefs
    if (this.view == null) this.ensureView()
    if (this.view == null) return this.state
    this.visible = true
    this.view.setVisible(true)
    // 同 URL 再开只是提到眼前,不重载 —— 页面里的状态(滚动、输入、跳转)不该被点一下抹掉
    if (this.url !== req.url) {
      this.url = req.url
      void this.view.webContents.loadURL(req.url).catch((e: unknown) => {
        logError('Float 加载失败', req.url, String(e))
      })
    }
    this.raise()
    this.layout()
    this.view.webContents.focus()
    log('Float 显示', req.url)
    return this.emit()
  }

  hide(): FloatState {
    if (this.view == null || !this.visible) return this.state
    this.visible = false
    const wc = this.view.webContents
    if (!wc.isDestroyed()) {
      // 视图只是隐藏、不销毁,和 overlay 一样顺手关掉它的 DevTools,避免留孤立窗口
      wc.closeDevTools()
      this.view.setVisible(false)
    }
    // 键盘焦点还给活动标签页:焦点留在隐藏的视图里,用户会觉得「键盘失灵了」
    const active = this.tabs.getActiveView()
    if (active && !active.view.webContents.isDestroyed()) active.view.webContents.focus()
    else if (!this.window.isDestroyed()) this.window.webContents.focus()
    log('Float 隐藏')
    return this.emit()
  }

  /** 提到 contentView 最上层(已存在的子视图重新 add = 置顶) */
  raise(): void {
    if (this.view == null || !this.visible || this.window.isDestroyed()) return
    this.window.contentView.addChildView(this.view)
  }

  /** 窗口缩放 / chrome 高度变化时重算 bounds(位置与尺寸都来自 `@shared/floatWindow`) */
  layout(): void {
    if (this.view == null || this.prefs == null || this.window.isDestroyed()) return
    const [windowWidth, windowHeight] = this.window.getContentSize()
    this.view.setBounds(
      floatRect({
        placement: this.prefs.placement,
        width: this.prefs.width,
        height: this.prefs.height,
        windowWidth,
        windowHeight,
        chromeHeight: this.tabs.getChromeHeight()
      })
    )
  }

  /** 这个 webContents 是不是本窗口的浮窗(多窗口路由:`WindowManager.byWebContents` 用) */
  hasWebContents(wc: WebContents): boolean {
    return this.view != null && this.view.webContents === wc
  }

  private ensureView(): void {
    // 与标签页的差别:不给 preload、不登记内容注入 —— 这是别人家的页面
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    view.setVisible(false)
    this.view = view

    const wc = view.webContents
    // 浮窗没有自绘标题栏,键盘出口只有这个(焦点在浮窗里时才收得到,页面自己的 Esc 会被这里先吃掉)
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      e.preventDefault()
      this.hide()
    })
    wc.on('did-fail-load', (_e, code, description, validatedUrl) => {
      if (code === -3) return // ERR_ABORTED(主动取消导航)
      logError('Float 加载失败', code, description, validatedUrl)
    })
    wc.on('render-process-gone', (_e, details) => {
      logError('Float 渲染进程崩溃', details.reason)
      this.recreate()
    })
  }

  /** 渲染进程崩溃:重建视图,原来开着就按同一 URL / 位置再开一次 */
  private recreate(): void {
    const old = this.view
    const resume = this.state
    const prefs = this.prefs
    this.view = null
    this.visible = false
    if (old && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(old)
      if (!old.webContents.isDestroyed()) old.webContents.close()
    }
    if (resume.open && prefs) this.show({ url: resume.url!, prefs })
    else this.emit()
  }

  private destroy(): void {
    const old = this.view
    this.view = null
    this.visible = false
    if (old && !old.webContents.isDestroyed()) old.webContents.close()
  }

  private emit(): FloatState {
    const state = this.state
    this.onState?.(state)
    return state
  }
}
