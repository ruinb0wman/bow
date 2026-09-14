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

export class FakeWc extends EventEmitter {
  destroyed = false
  loading = false
  url = 'https://example.com/'
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
