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

/** 造一个假元素:覆盖 snapshot / click / type / scroll / read 注入脚本会用到的全部成员 */
function makeElement(spec: FakeElement): Record<string, unknown> {
  const el: Record<string, unknown> = {
    nodeType: 1,
    tagName: (spec.tag ?? 'button').toUpperCase(),
    id: '',
    innerText: spec.text ?? '',
    textContent: spec.text ?? '',
    isContentEditable: false,
    labels: [],
    // READ_FN 的正文定位会用到这几个面;返回空即「没有可分析的子树」
    children: [],
    childNodes: [],
    parentElement: null,
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
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

/**
 * 假的 a11y 树(最小形态:一个按钮)。真机上的形状由 `scripts/mcp-smoke.mjs` 覆盖;
 * 这里只保证 MCP 层接线(取树 → 渲染 → ref 表)能跑通。
 */
const DEFAULT_AX_NODES = (): Array<Record<string, unknown>> => [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Fake Page' }, childIds: ['2'] },
  { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: '提交' }, backendDOMNodeId: 11 }
]

export class FakeDebugger {
  attached = false
  /** attach() 抛错(模拟 DevTools 占着调试器) */
  attachError: Error | null = null
  /** sendCommand 抛错 */
  sendError: Error | null = null
  /** 主框架地址(`Page.getFrameTree` 里回显,便于验 URL 变化 → ref 失效) */
  frameUrl = 'https://example.com/'
  /** detach 次数(验「只 detach 自己附加的那次」) */
  detachCount = 0
  calls: Array<{ method: string; params?: unknown }> = []
  /** Page.getLayoutMetrics 的返回;拿不到尺寸的路径用空对象 */
  metrics: unknown = { cssContentSize: { width: 1200, height: 800 } }
  /** Runtime.evaluate 读到的 devicePixelRatio;null 模拟读不到 */
  devicePixelRatio: number | null = 1.25
  /** Page.captureScreenshot 返回的 base64;null = 空图 */
  shotData: string | null = Buffer.from('fake-fullpage-png').toString('base64')
  /** DOM.querySelector 的返回(nodeId;0 = 没找到) */
  queryNodeId = 0
  /** DOM.querySelectorAll('input[type=file]') 的返回 */
  fileInputNodeIds: number[] = []
  /** nodeId → DOM.describeNode 的属性扁平数组([name,value,…]) */
  nodeAttributes = new Map<number, string[]>()
  /**
   * `Accessibility.getFullAXTree` 的返回(null = 用一个最小的默认树:单个按钮)。
   * 按 frameId 覆盖用 `axNodesByFrame`。
   */
  axNodes: Array<Record<string, unknown>> | null = null
  axNodesByFrame = new Map<string, Array<Record<string, unknown>>>()
  /** 主框架的 loaderId:`Page.getFrameTree` 返回它,用来验「文档换了 → ref 失效」 */
  loaderId = 'L1'
  /** `Runtime.callFunctionOn` 的返回(按 ref 操作节点时用) */
  handleResult: unknown = { tag: 'button', text: '提交' }
  /**
   * upload 的 Runtime.evaluate 读回:页面侧 `input.files` 的真实状态。
   * null = 没设(那就按整页截图那条路返回 devicePixelRatio)。
   */
  uploadState: { multiple: boolean; accept: string; files: Array<{ name: string; size: number; type: string }> } | null =
    null

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
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'F1', url: this.frameUrl, loaderId: this.loaderId } } }
    }
    if (method === 'Accessibility.getFullAXTree') {
      const frameId = String((params as { frameId?: string } | undefined)?.frameId ?? '')
      if (this.axNodesByFrame.has(frameId)) return { nodes: this.axNodesByFrame.get(frameId) }
      return { nodes: this.axNodes ?? DEFAULT_AX_NODES() }
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'fake-object-1' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: this.handleResult } }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelector') return { nodeId: this.queryNodeId }
    if (method === 'DOM.querySelectorAll') return { nodeIds: this.fileInputNodeIds }
    if (method === 'DOM.describeNode') {
      const nodeId = Number((params as { nodeId?: number } | undefined)?.nodeId ?? 0)
      return { node: { attributes: this.nodeAttributes.get(nodeId) ?? [] } }
    }
    if (method === 'Runtime.evaluate') {
      if (this.uploadState) return { result: { value: this.uploadState } }
      return { result: this.devicePixelRatio == null ? {} : { value: this.devicePixelRatio } }
    }
    if (method === 'Page.captureScreenshot') return { data: this.shotData }
    return {}
  }
}

export class FakeWc extends EventEmitter {
  destroyed = false
  loading = false
  url = 'https://example.com/'  /** 视口截图(capturePage)的假返回值 */
  captureEmpty = false
  /** 页面标题(wc.getTitle();无障碍树快照的返回体里会带它) */
  title = 'Fake Page'
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
  /** 假 body 的纯文本(`browser_read` 走 document.body 时的正文) */
  bodyText = '假页面正文'
  /** 收到的原生按键事件 */
  sentEvents: unknown[] = []
  /** findInPage 调用记录(页内查找) */
  findCalls: Array<{ text: string; options?: unknown }> = []
  /** stopFindInPage 的 action 序列 */
  stopFindCalls: string[] = []
  private nextFindId = 1

  findInPage(text: string, options?: unknown): number {
    this.findCalls.push({ text, options })
    return this.nextFindId++
  }

  stopFindInPage(action: string): void {
    this.stopFindCalls.push(action)
  }

  /** 模拟一次 'found-in-page'(页内查找结果) */
  emitFoundInPage(result: unknown): void {
    this.emit('found-in-page', {}, result)
  }

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

  getTitle(): string {
    return this.title
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
      title: this.title,
      activeElement: null,
      // READ_FN 会在正文定位失手时退到 document.body(整页放宽,并跳过链接农场);
      // 给它一具能读出行内文本的假 body —— 注意 `children` 要有东西,
      // 否则会被判定为「整页没有任何可读内容」。
      body: (() => {
        const text = { nodeType: 3, nodeValue: this.bodyText }
        const child = {
          nodeType: 1,
          tagName: 'DIV',
          children: [],
          childNodes: [text],
          parentElement: null,
          textContent: this.bodyText,
          matches: () => false,
          querySelectorAll: () => [],
          getAttribute: () => null
        }
        return {
          nodeType: 1,
          tagName: 'BODY',
          children: [child],
          childNodes: [child],
          parentElement: null,
          textContent: this.bodyText,
          matches: () => false,
          getAttribute: () => null
        }
      })(),
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
