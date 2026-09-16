/**
 * 测试用假 WebContents:只实现等待 / 交互逻辑真正用到的面。
 *
 * executeJavaScript 会「真的求值」注入源码,并提供极小化的 document / 事件构造器桩,
 * 因此选择器状态判定、选择器非法抛错、click/type 的成功与失败路径都被真实覆盖,
 * 而不只是验证外层时序。
 */

import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'

/** 假页面元素:visible 只影响 getBoundingClientRect 的尺寸(0×0 视为不可见) */
export interface FakeElement {
  visible?: boolean
  tag?: string
  value?: string
  text?: string
}

/** value 访问器:让 HTMLInputElement.prototype 的 setter.call(el, ...) 也能正确落到假元素上 */
const valueDesc = {
  configurable: true,
  get(this: { _v?: string }): string {
    return this._v ?? ''
  },
  set(this: { _v?: string }, v: string): void {
    this._v = String(v)
  }
}

class StubEvent {
  constructor(
    public type: string,
    public init?: unknown
  ) {}
}

class StubElement {
  constructor(public tagName = 'DIV') {}
}

class StubInput {}
Object.defineProperty(StubInput.prototype, 'value', valueDesc)

/** 造一个假元素:覆盖 snapshot / click / type / scroll 注入脚本会用到的全部成员 */
function makeElement(spec: FakeElement): Record<string, unknown> {
  const el: Record<string, unknown> = {
    tagName: (spec.tag ?? 'button').toUpperCase(),
    id: '',
    innerText: spec.text ?? '',
    textContent: spec.text ?? '',
    isContentEditable: false,
    labels: [],
    closest: () => null,
    getBoundingClientRect: () =>
      spec.visible === false ? { x: 0, y: 0, width: 0, height: 0 } : { x: 1, y: 1, width: 10, height: 10 },
    scrollIntoView: () => {},
    focus: () => {},
    click: () => {},
    dispatchEvent: () => true,
    getAttribute: () => null
  }
  Object.defineProperty(el, 'value', valueDesc)
  return el
}

export class FakeDebugger {
  attached = false
  /** attach() 抛错(模拟 DevTools 占着调试器) */
  attachError: Error | null = null
  /** sendCommand 抛错 */
  sendError: Error | null = null
  detachCount = 0
  calls: Array<{ method: string; params?: unknown }> = []
  /** Page.getLayoutMetrics 的返回;拿不到尺寸的路径用空对象 */
  metrics: unknown = { cssContentSize: { width: 1200, height: 800 } }
  /** Runtime.evaluate 读到的 devicePixelRatio;null 模拟读不到 */
  devicePixelRatio: number | null = 1.25
  /** Page.captureScreenshot 返回的 base64;null = 空图 */
  shotData: string | null = Buffer.from('fake-fullpage-png').toString('base64')

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    if (this.attachError) throw this.attachError
    this.attached = true
  }

  detach(): void {
    this.attached = false
    this.detachCount++
  }

  async sendCommand(method: string, params?: unknown): Promise<any> {
    this.calls.push({ method, params })
    if (this.sendError) throw this.sendError
    if (method === 'Page.getLayoutMetrics') return this.metrics
    if (method === 'Runtime.evaluate') {
      return { result: this.devicePixelRatio == null ? {} : { value: this.devicePixelRatio } }
    }
    if (method === 'Page.captureScreenshot') return { data: this.shotData }
    return {}
  }
}

export class FakeWc extends EventEmitter {
  destroyed = false
  loading = false
  url = 'https://example.com/'
  /** 视口截图(capturePage)的假返回值 */
  captureEmpty = false
  capturePng = Buffer.from('fake-viewport-png')
  captureCount = 0
  /** 整页截图(capturePage 之外的 CDP 路径)用的假调试器 */
  debugger = new FakeDebugger()
  /** 页面元素:选择器 → 元素规格 */
  elements = new Map<string, FakeElement>()
  /** 会由 querySelector 抛错的选择器 */
  invalid = new Set<string>()
  /** 轮询次数 */
  execCount = 0
  /** 直接 executeJavaScript(code) 的预设返回值(browser_eval 用) */
  raw = new Map<string, unknown>()
  /** 这些 code 会抛错(browser_eval 错误路径用) */
  throwOn = new Set<string>()
  /** 收到的原生按键事件 */
  sentEvents: unknown[] = []

  isDestroyed(): boolean {
    return this.destroyed
  }

  /** 视口截图:真实 Electron 用 NativeImage,这里只需要 isEmpty()/toPNG() 两个面 */
  async capturePage(): Promise<{ isEmpty: () => boolean; toPNG: () => Buffer }> {
    this.captureCount++
    return { isEmpty: () => this.captureEmpty, toPNG: () => this.capturePng }
  }

  isLoading(): boolean {
    return this.loading
  }

  getURL(): string {
    return this.url
  }

  sendInputEvent(event: unknown): void {
    this.sentEvents.push(event)
  }

  /** 模拟加载完成 */
  finishLoad(url?: string): void {
    if (url) this.url = url
    this.loading = false
    this.emit('did-finish-load')
  }

  /**
   * 模拟「一次完整加载」的开始:地址提交(did-navigate)+ 开始加载(did-start-loading)。
   * 真实 Electron 里 did-navigate 在主框架提交时发出,这里与 start-loading 一起发,
   * 因为 waitForLoad 的 navigation 模式需要看到「本次主框架导航」这个配对信号。
   */
  startLoad(url?: string): void {
    if (url) this.url = url
    this.loading = true
    this.emit('did-start-loading')
    this.emit('did-navigate', {}, this.url)
  }

  /** 模拟「一次完整加载」的结束(与 startLoad 配对,两个完成信号一起发) */
  stopLoad(url?: string): void {
    if (url) this.url = url
    this.loading = false
    this.emit('did-stop-loading')
    this.emit('did-finish-load')
  }

  /** 只发主框架导航开始信号(用于验证 started 的配对判据) */
  emitStartNavigation(url: string, isMainFrame = true, isSameDocument = false): void {
    this.emit('did-start-navigation', { url, isMainFrame, isSameDocument }, url, isSameDocument, isMainFrame)
  }

  async executeJavaScript(code: string): Promise<unknown> {
    this.execCount++
    if (this.throwOn.has(code)) throw new Error(`页面脚本抛错: ${code}`)
    if (this.raw.has(code)) return this.raw.get(code)

    const document = {
      title: 'Fake Page',
      activeElement: null,
      documentElement: { clientHeight: 800, scrollTop: 0, scrollHeight: 2000 },
      scrollingElement: null,
      querySelectorAll: (): unknown[] => [...this.elements.values()].map(makeElement),
      querySelector: (sel: string): unknown => {
        if (this.invalid.has(sel)) throw new Error(`'${sel}' is not a valid selector`)
        const spec = this.elements.get(sel)
        return spec ? makeElement(spec) : null
      }
    }
    const location = { href: this.url }
    const window = { innerWidth: 1200, innerHeight: 800 }
    const getComputedStyle = (): Record<string, string> => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1'
    })
    // 注入源码是 IIFE 表达式,直接求值即可得到 runInPage 期望的 JSON 字符串
    const run = new Function(
      'document',
      'location',
      'window',
      'getComputedStyle',
      'CSS',
      'MouseEvent',
      'InputEvent',
      'Event',
      'HTMLElement',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      `return ${code}`
    )
    return run(
      document,
      location,
      window,
      getComputedStyle,
      { escape: (s: string) => s },
      StubEvent,
      StubEvent,
      StubEvent,
      StubElement,
      StubInput,
      StubInput
    )
  }
}

export const asWc = (wc: FakeWc): WebContents => wc as unknown as WebContents

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
