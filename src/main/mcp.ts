/** MCP stdio 服务器:暴露 AI 操纵浏览器的工具 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { SearchEngineId } from '@shared/types'
import { isHttpUrl, searchUrl } from '@shared/url'
import type { TabManager } from './tabManager'
import { getSettingsStore } from './stores'
import type { PluginKernel } from './plugins/kernel'
import { imageContent, textContent } from './plugins/mcpResult'
import { pageClick, pageSnapshot, pageScreenshot, pageScroll, pageType, pressKey } from './actions'
import { log, logError } from './logger'

export type MCPDeps = { tabs: TabManager; kernel: PluginKernel }

/** 核心工具名:预留给内核做插件重名校验 */
export const CORE_MCP_TOOL_NAMES = [
  'browser_navigate',
  'browser_search',
  'browser_eval',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_scroll',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_stop',
  'browser_new_tab',
  'browser_close_tab',
  'browser_switch_tab',
  'browser_list_tabs',
  'browser_screenshot',
  'browser_get_info'
]

const EngineSchema = z.enum(['google', 'duckduckgo', 'bing', 'baidu'])
const DirectionSchema = z.enum(['up', 'down', 'top', 'bottom'])

export function startMcpServer(deps: MCPDeps): void {
  const { tabs, kernel } = deps
  const server = new McpServer({ name: 'mcp-browser', version: '0.1.0' })

  // 当前操作目标视图:可指定 tabId,默认取活动标签(活动标签是内部页面时退到最近浏览的页面标签);
  // 内部页面标签(如 bow://settings)持有应用 preload,一律不作为页面工具的操作目标。
  const target = (tabId?: number): { view: ReturnType<TabManager['getActiveView']>; fail: string | null } => {
    if (tabId != null) {
      const hit = tabs.getView(tabId)
      if (!hit) return { view: null, fail: `标签 ${tabId} 不存在` }
      if (hit.info.internal) return { view: null, fail: `标签 ${tabId} 是浏览器内部页面,不支持页面操作` }
      return { view: hit, fail: null }
    }
    let hit = tabs.getActiveBrowsingView()
    if (!hit) {
      // 只有内部页面标签(或没有任何标签):新建空白标签作为操作目标
      const t = tabs.create('about:blank')
      hit = tabs.getView(t.id)
    }
    if (!hit) return { view: null, fail: '没有活动标签' }
    return { view: hit, fail: null }
  }

  server.tool(
    'browser_navigate',
    { url: z.string().describe('http(s) 地址') },
    async ({ url }) => {
      if (!isHttpUrl(url)) return textContent({ ok: false, error: 'navigate 仅接受 http/https 地址' })
      // 活动标签是设置等内部页面时另开新标签(内部页面不可被导航走)
      const tab = tabs.openUrl(url)
      return textContent({ ok: true, url, tabId: tab.id })
    }
  )

  server.tool(
    'browser_search',
    { query: z.string(), engine: EngineSchema.optional() },
    async ({ query, engine }) => {
      const settings = getSettingsStore().get()
      const engineId: SearchEngineId = engine ?? settings.searchEngine
      const url = searchUrl(engineId, query)
      const tab = tabs.openUrl(url)
      return textContent({ ok: true, engine: engineId, url, tabId: tab.id })
    }
  )

  server.tool(
    'browser_eval',
    { code: z.string().describe('在页面上下文中执行的 JavaScript 表达式/语句,返回最后一个表达式的值'), tabId: z.number().optional() },
    async ({ code, tabId }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      try {
        const raw = await view.view.webContents.executeJavaScript(String(code), true)
        if (raw === undefined) return textContent({ ok: true, result: null })
        return textContent({ ok: true, result: raw })
      } catch (e) {
        return textContent({ ok: false, error: String((e as Error)?.message ?? e) })
      }
    }
  )

  server.tool(
    'browser_snapshot',
    {
      tabId: z.number().optional(),
      maxElements: z.number().int().positive().max(1000).default(200).describe('最多返回可操作元素数')
    },
    async ({ tabId, maxElements }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const res = await pageSnapshot(view.view.webContents, maxElements)
      if (!res.ok) return textContent(res)
      return textContent({ ok: true, tabId: view.info.id, data: res.data })
    }
  )

  server.tool(
    'browser_click',
    { selector: z.string().describe('CSS 选择器'), tabId: z.number().optional() },
    async ({ selector, tabId }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const res = await pageClick(view.view.webContents, selector)
      return textContent(
        res.ok
          ? { ok: true, tabId: view.info.id, selector, result: res }
          : { ok: false, tabId: view.info.id, error: res.error }
      )
    }
  )

  server.tool(
    'browser_type',
    {
      selector: z.string().optional().describe('CSS 选择器;省略则输入到当前聚焦元素'),
      text: z.string(),
      clear: z.boolean().default(true).describe('输入前是否清空原内容'),
      tabId: z.number().optional()
    },
    async ({ selector, text, clear, tabId }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const res = await pageType(view.view.webContents, selector ?? '', text, clear)
      const typed = (res.result as { value?: string } | null)?.value
      return textContent(
        res.ok
          ? { ok: true, tabId: view.info.id, typed: text, value: typed ?? '' }
          : { ok: false, tabId: view.info.id, error: res.error }
      )
    }
  )

  server.tool(
    'browser_press_key',
    {
      key: z.string().describe('按键,如 Enter / Tab / Escape / ArrowDown / Ctrl+W / F5'),
      tabId: z.number().optional()
    },
    async ({ key, tabId }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const low = key.toLowerCase()
      if (low === 'f5' || low === 'ctrl+r' || low === 'control+r') {
        tabs.reload(view.info.id)
        return textContent({ ok: true, key })
      }
      if (low === 'ctrl+w' || low === 'control+w') {
        tabs.close(view.info.id)
        return textContent({ ok: true, key, closed: true })
      }
      if (low === 'ctrl+t' || low === 'control+t') {
        const t = tabs.create('about:blank')
        return textContent({ ok: true, key, newTabId: t.id })
      }
      const res = await pressKey(view.view.webContents, key)
      return textContent({ ok: res.ok, ...(res.ok ? { pressed: key } : { error: res.error }), tabId: view.info.id })
    }
  )

  server.tool(
    'browser_scroll',
    {
      selector: z.string().optional(),
      direction: DirectionSchema,
      amount: z.number().positive().optional().describe('滚动像素;缺省滚动约一屏的 70%'),
      tabId: z.number().optional()
    },
    async ({ selector, direction, amount, tabId }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const res = await pageScroll(view.view.webContents, selector ?? null, direction, amount ?? 0)
      const top = (res.result as { top?: number } | null)?.top
      return textContent(
        res.ok
          ? { ok: true, tabId: view.info.id, top: top ?? null, direction }
          : { ok: false, tabId: view.info.id, error: res.error }
      )
    }
  )

  const histories: Array<{ name: string; fn: (id: number) => void }> = [
    { name: 'browser_back', fn: (id) => tabs.back(id) },
    { name: 'browser_forward', fn: (id) => tabs.forward(id) },
    { name: 'browser_reload', fn: (id) => tabs.reload(id) },
    { name: 'browser_stop', fn: (id) => tabs.stop(id) }
  ]
  for (const { name, fn } of histories) {
    server.tool(name, { tabId: z.number().optional() }, async ({ tabId }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      fn(view.info.id)
      return textContent({ ok: true, tabId: view.info.id })
    })
  }

  server.tool(
    'browser_new_tab',
    { url: z.string().optional(), activate: z.boolean().default(true) },
    async ({ url, activate }) => {
      if (url && !isHttpUrl(url)) return textContent({ ok: false, error: 'new_tab 仅接受 http/https 地址' })
      const t = tabs.create(url ?? 'about:blank', activate)
      return textContent({ ok: true, tabId: t.id, url: t.url })
    }
  )

  server.tool('browser_close_tab', { tabId: z.number() }, async ({ tabId }) => {
    const res = tabs.close(tabId)
    return textContent(res.ok ? { ok: true, closed: tabId } : { ok: false, error: `标签 ${tabId} 不存在` })
  })

  server.tool('browser_switch_tab', { tabId: z.number() }, async ({ tabId }) => {
    const hit = tabs.getView(tabId)
    if (!hit) return textContent({ ok: false, error: `标签 ${tabId} 不存在` })
    tabs.activate(tabId)
    return textContent({ ok: true, activate: true, tabId })
  })

  server.tool('browser_list_tabs', {}, async () => {
    const list = tabs.listTabs()
    return textContent({
      ok: true,
      tabs: list.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        loading: t.loading,
        active: t.active,
        crashed: t.crashed,
        internal: !!t.internal
      }))
    })
  })

  server.tool('browser_screenshot', { tabId: z.number().optional() }, async ({ tabId }) => {
    const { view, fail } = target(tabId)
    if (!view) return textContent({ ok: false, error: fail })
    const res = await pageScreenshot(view.view.webContents)
    if (!res.ok || !res.data) return textContent({ ok: false, error: res.error ?? '截图失败' })
    return imageContent(res.data.pngBase64)
  })

  server.tool('browser_get_info', { tabId: z.number().optional() }, async ({ tabId }) => {
    const { view, fail } = target(tabId)
    if (!view) return textContent({ ok: false, error: fail })
    return textContent({ ok: true, info: view.info })
  })

  // 插件工具:内核已缓冲全部声明(MCP 模式启动前插件已激活),此处统一注册并回交句柄
  kernel.mcp.attach((spec) =>
    // 插件侧 config.inputSchema 为 zod raw shape;SDK 的重载推导在此处无收益,直接放宽
    (server.registerTool as any)(spec.name, spec.config, spec.handler)
  )

  const transport = new StdioServerTransport()
  server
    .connect(transport)
    .then(() => log('MCP 服务器已连接(stdin/stdout)'))
    .catch((e) => {
      logError('MCP 服务器启动失败', e instanceof Error ? e.message : e)
      process.exit(1)
    })
}