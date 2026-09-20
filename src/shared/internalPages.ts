/**
 * 内部页面标识(同构纯逻辑,三端安全):
 * 设置等浏览器自有页面以 `bow://<id>` 假协议作为对外 URL,由标签页承载,
 * 地址栏/标签标题/MCP 标签列表都按该 URL 呈现(实际加载的是打包后的渲染入口)。
 *
 * 只接受 `bow://<id>` 与 `bow://<id>/` 两种形式:带路径/查询/其它 host 一律不识别,
 * 从而保证「内部页面」集合是封闭可枚举的。
 */

export const INTERNAL_SCHEME = 'bow'

export type InternalPageId = 'settings' | 'terminal' | 'logseq'

/** 设置页对外 URL(地址栏/标签/入口统一使用) */
export const SETTINGS_URL = 'bow://settings'

/** 终端页对外 URL(插件「终端」贡献的页面,插件 id 与页面 id 同名) */
export const TERMINAL_URL = 'bow://terminal'

/** 笔记页对外 URL(插件「笔记」贡献的页面,同样插件 id 与页面 id 同名) */
export const LOGSEQ_URL = 'bow://logseq'

/**
 * 内部页面登记:url/title/entry 由 @shared/internalPages 统一提供。
 * 两根**正交**的轴决定打开语义:
 * - `singleton`(`TabManager.openInternal()` 用):true(设置页)= 已存在则只聚焦、不堆第二个;
 *   false(终端页)= 不查找已有标签,每次都开一个新的 shell 会话;
 * - `openIn`(地址栏通路 `TabManager.openUrl()` 用):'tab' = 新建标签(设置页);
 *   'pane' = **顶替当前聚焦窗格**(终端页 / 笔记页:先分屏、再输 `bow://terminal`,就落在那个窗格里)。
 *
 * ⚠️ 笔记页(`bow://logseq`)与终端页同轴但理由不同:它自己带一个「页内导航」(日志 ↔ 页面),
 * 所以需要「一个窗格 = 一个编辑器实例」才能两边对照着写(状态按 tabId 绑,见 `logseq/main.ts`)。
 *
 * ⚠️ `TabManager.create(url)`(工具栏「新终端」按钮 / `Ctrl+Shift+T` 恢复)是更底层的入口,
 * 不受这两根轴影响 —— 它永远是新标签。
 */
export interface InternalPageSpec {
  url: string
  title: string
  entry: string
  singleton: boolean
  openIn: 'tab' | 'pane'
}

export const INTERNAL_PAGES = {
  settings: { url: SETTINGS_URL, title: '设置', entry: 'settings', singleton: true, openIn: 'tab' },
  terminal: { url: TERMINAL_URL, title: '终端', entry: 'terminal', singleton: false, openIn: 'pane' },
  logseq: { url: LOGSEQ_URL, title: '笔记', entry: 'logseq', singleton: false, openIn: 'pane' }
} as const satisfies Record<InternalPageId, InternalPageSpec>

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

/** 内部页面是否「顶替当前聚焦窗格」打开(地址栏输入不新建标签;终端用) */
export function opensInPane(id: InternalPageId): boolean {
  return INTERNAL_PAGES[id].openIn === 'pane'
}

function isInternalPageId(value: string): value is InternalPageId {
  return Object.prototype.hasOwnProperty.call(INTERNAL_PAGES, value)
}
