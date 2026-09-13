/**
 * 内部页面标识(同构纯逻辑,三端安全):
 * 设置等浏览器自有页面以 `bow://<id>` 假协议作为对外 URL,由标签页承载,
 * 地址栏/标签标题/MCP 标签列表都按该 URL 呈现(实际加载的是打包后的渲染入口)。
 *
 * 只接受 `bow://<id>` 与 `bow://<id>/` 两种形式:带路径/查询/其它 host 一律不识别,
 * 从而保证「内部页面」集合是封闭可枚举的。
 */

export const INTERNAL_SCHEME = 'bow'

export type InternalPageId = 'settings'

/** 设置页对外 URL(地址栏/标签/入口统一使用) */
export const SETTINGS_URL = 'bow://settings'

/** 内部页面登记:url/title/entry 由 @shared/internalPages 统一提供 */
export const INTERNAL_PAGES = {
  settings: { url: SETTINGS_URL, title: '设置', entry: 'settings' }
} as const satisfies Record<InternalPageId, { url: string; title: string; entry: string }>

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
