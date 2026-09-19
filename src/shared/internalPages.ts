/**
 * 内部页面标识(同构纯逻辑,三端安全):
 * 设置等浏览器自有页面以 `bow://<id>` 假协议作为对外 URL,由标签页承载,
 * 地址栏/标签标题/MCP 标签列表都按该 URL 呈现(实际加载的是打包后的渲染入口)。
 *
 * 只接受 `bow://<id>` 与 `bow://<id>/` 两种形式:带路径/查询/其它 host 一律不识别,
 * 从而保证「内部页面」集合是封闭可枚举的。
 */

export const INTERNAL_SCHEME = 'bow'

export type InternalPageId = 'settings' | 'terminal'

/** 设置页对外 URL(地址栏/标签/入口统一使用) */
export const SETTINGS_URL = 'bow://settings'

/** 终端页对外 URL(插件「终端」贡献的页面,插件 id 与页面 id 同名) */
export const TERMINAL_URL = 'bow://terminal'

/**
 * 内部页面登记:url/title/entry 由 @shared/internalPages 统一提供。
 * `singleton` 决定 `TabManager.openInternal()` 的语义:
 * - true(设置页):已存在则只聚焦,重复打开不会堆出第二个设置标签;
 * - false(终端页):每次打开都是新标签(每个终端标签一个独立 shell 会话)。
 */
export const INTERNAL_PAGES = {
  settings: { url: SETTINGS_URL, title: '设置', entry: 'settings', singleton: true },
  terminal: { url: TERMINAL_URL, title: '终端', entry: 'terminal', singleton: false }
} as const satisfies Record<
  InternalPageId,
  { url: string; title: string; entry: string; singleton: boolean }
>

/** 是否为本应用内部页面 URL */
export function isInternalUrl(url: string): boolean {
  return parseInternalUrl(url) !== null
}

/** `bow://<id>` → 内部页面 id;非内部页面返回 null */
export function parseInternalUrl(url: string): InternalPageId | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)(\/?)(?:[?#].*)?$/.exec(url.trim())
  if (!m) return null
  if (m[1].toLowerCase() !== INTERNAL_SCHEME) return null
  const host = m[2].toLowerCase()
  const path = m[3]
  if (path && path !== '/') return null
  return isInternalPageId(host) ? host : null
}

/** 内部页面 id → 对外 URL */
export function internalPageUrl(id: InternalPageId): string {
  return INTERNAL_PAGES[id].url
}

/** 内部页面标题(标签初始标题,页面加载后由 document.title 接管) */
export function internalPageTitle(id: InternalPageId): string {
  return INTERNAL_PAGES[id].title
}

function isInternalPageId(value: string): value is InternalPageId {
  return Object.prototype.hasOwnProperty.call(INTERNAL_PAGES, value)
}
