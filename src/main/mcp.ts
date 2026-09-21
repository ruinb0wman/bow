/** MCP stdio 服务器:暴露 AI 操纵浏览器的工具 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import type { WebContents } from 'electron'
import type { ActionResult, SearchEngineId } from '@shared/types'
import { isHttpUrl, searchUrl } from '@shared/url'
import type { TabManager } from './tabManager'
import { getSettingsStore } from './stores'
import type { PluginKernel } from './plugins/kernel'
import type { McpToolSpec } from './plugins/mcpHost'
import { imageContent, textContent } from './plugins/mcpResult'
import { mcpActivity } from './mcpActivity'
import {
  pageClick,
  pageSnapshot,
  pageScreenshot,
  pageScroll,
  pageType,
  pressKey,
  waitForLoad,
  waitForSelector
} from './actions'
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
  'browser_get_info',
  'browser_wait'
]

const EngineSchema = z.enum(['google', 'duckduckgo', 'bing', 'baidu'])
const DirectionSchema = z.enum(['up', 'down', 'top', 'bottom'])
const WaitUntilSchema = z.enum(['load', 'none'])
const WaitStateSchema = z.enum(['attached', 'visible', 'hidden', 'detached'])

const DEFAULT_LOAD_TIMEOUT_MS = 15_000
const DEFAULT_SELECTOR_TIMEOUT_MS = 10_000

/**
 * 服务器级使用说明:随 initialize 下发给客户端(无需占用工具描述空间),
 * 只写 schema 表达不了的东西——返回体约定、推荐工作流、工具选型与边界。
 */
export const MCP_INSTRUCTIONS = `这是一个真实的多标签浏览器窗口(应用名 bow),你的每次操作用户都实时可见。

返回体约定
- 所有工具都返回 JSON。先看 ok 字段;ok=false 表示失败(协议层已同时标记 isError),不要当成成功继续往下走。
- 参数名必须精确:未知参数会被拒绝,报错里会列出本工具接受的参数名,不要凭记忆猜参数。
- 页面类工具默认作用于「活动标签」。若活动标签是浏览器内部页面(bow://settings,即 browser_list_tabs 里 internal: true),
  会退到最近浏览过的页面标签;一个都没有时会自动新建 about:blank 标签——此时返回的 tabId 并不是你预期的那个,一切以返回值为准。

推荐工作流
1. browser_navigate / browser_search / browser_new_tab / browser_reload 默认已等到页面加载完成(waitUntil: 'load');
   需要立刻返回就传 waitUntil: 'none'。返回值里 waited=false 表示调用时页面已经就绪。
   给 tabId 导航「非活动(后台)标签」时,加载由 Chromium 延后启动属正常,这条会等到真结果才返回 ——
   若不想等,传 waitUntil: 'none' 或更小的 timeoutMs。
2. 页面内容若是异步渲染的(SPA、懒加载),用 browser_wait { selector } 等目标元素出现,
   不要靠反复截图或盲目等待。
3. 用 browser_snapshot 拿到元素后,直接使用它返回的 selector 调 browser_click / browser_type,
   不要自己猜 CSS 选择器。快照默认最多 200 个元素;页面很大时先调小 maxElements 定位,需要更多再扩大。
4. browser_click 默认不等待(适合 SPA 内的局部交互);若这次点击会触发跳转,传 waitUntil: 'load',
   或随后用 browser_wait 等具体元素。动作没有引发跳转时 waitUntil: 'load' 会在约 1.5s 内以 waited=false 返回。
5. browser_press_key 返回 ok 只代表按键已投递,不代表网页已经处理完;若这次按键会触发跳转(如回车提交表单),
   传 waitUntil: 'load' 等到加载完成。等异步渲染仍然用 browser_wait,不要重复调用同一个工具探路。

工具选型
- 读结构化数据、批量取值 → browser_eval(最省 token)
- 定位可点 / 可输入元素 → browser_snapshot
- 判断样式、布局、视觉效果 → browser_screenshot;要看滚动到视口外的内容就传 fullPage: true
- 手机页面(= device_* 那一套)上的定位 → device_snapshot,操作 → device_tap / device_type / device_press_key,
  不要用 device_eval 里的合成事件(拿不到真事件与焦点链路)

手机调试(device_*)
- 这类工具作用于**通过 adb 连着的手机页面**(Android 应用里的 WebView / Chrome),与 browser_*(作用于 bow 自己的标签页)是两回事。
- 先 device_list_targets 拿 targetKey;有多个目标时必须显式指定(省略只在「恰好一个目标」时生效,不做猜测),
  省略时一律以返回体里的 targetKey 为准 —— 多步操作(snapshot → tap)建议显式带上它。
- 推荐工作流:device_snapshot 拿元素与 selector → device_tap / device_type 用**它返回的 selector**(别自己猜 CSS 选择器,
  也不要用 device_eval 反复手写查询表达式)。
  - device_tap 默认发真实触摸事件(mode 的起点是 touch);touch 不可用时自动降级为鼠标 —— 以返回的 mode 为准。
  - device_type 走 IME 插入路径,受控输入框(Vue/React)的 onChange 会收到真事件;省略 selector 则输入到当前聚焦元素。
  - device_press_key 只接功能键(Enter / Tab / Escape / Backspace / Delete / 方向键 / Home / End / PageUp / PageDown);
    文字用 device_type;翻页/取值优先 device_scroll / device_eval。
- 想让人看真实 DevTools 界面 → device_inspect(在标签页里打开);想自己取数据 → device_eval / device_screenshot。
- 看控制台与未捕获异常 → device_console:它只覆盖**调用期间**的日志(默认 800ms),CDP 没有历史回放;
  要看页面加载期的日志就传 reload: true(会重载页面,当前页面状态会丢)。
- 看不到目标通常是两类原因:设备未授权(去手机屏幕上点「允许 USB 调试」),或应用是 release 包且没调用
  WebView.setWebContentsDebuggingEnabled(true)。device_list_targets 的 notices 里会给出具体指引。

边界
- bow:// 内部页面标签不支持页面类工具,会被明确拒绝。
- browser_list_tabs 里 inspector: true 的标签是「远程调试用的 DevTools 前端」,同样属于浏览器自身页面,不支持页面类工具。
- device_eval / device_screenshot / device_snapshot / device_tap / device_type / device_press_key / device_scroll /
  device_console 需要设备可达:跨 WSL 时转发端口依赖 WSL2 镜像网络(networkingMode=Mirrored)。
- 手机页面的点击/输入坐标用**视口 CSS 像素**(不乘 devicePixelRatio);页面处于捏合缩放或软键盘顶起时
  注入位置可能整体偏移 —— 操作后用 device_eval 读一个计数器/值确认,不要假定点中了。
- browser_screenshot 默认只截当前视口;fullPage: true 截整页(输出分辨率 = 文档 CSS 尺寸 × devicePixelRatio,与普通截图一致)。整页截图需要临时附加调试器,该标签开着 DevTools 会失败;页面过高(设备像素超过 16000)会明确报错,改用 browser_scroll 分段。无 GPU 的环境可能返回黑帧,不要反复重试。
- browser_navigate / browser_search 传 tabId 时作用于指定标签(指向内部页面标签会被拒绝);省略则作用于活动标签。
- 插件被停用后,它贡献的工具(如 adblock_*)会从工具列表消失,这不是故障;可在 bow://settings 的「插件管理」重新启用。
- browser_press_key 的 Ctrl+T / Ctrl+W 直接操作标签页,不等同于网页内的按键。`

/** 构建一个注册好全部核心工具的 MCP 服务器(插件工具由调用方按传输方式接入) */
export function buildBrowserServer(deps: MCPDeps): McpServer {
  const { tabs } = deps
  const server = new McpServer(
    { name: 'mcp-browser', version: '0.1.0' },
    { instructions: MCP_INSTRUCTIONS }
  )

  /**
   * 注册一个核心工具。
   * zod 默认会静默丢弃未知参数 —— LLM 传错参数名时拿不到任何反馈(曾导致 navigate 的 tabId
   * 被无声忽略、静默导航到活动标签),这里用 strict() 让未知参数显式报错并回显可用参数名。
   * 与 registerPluginTools 同理:raw shape → ZodObject 的重载推导无收益,直接放宽类型。
   *
   * 处理器统一经 mcpActivity 包一层:MCP 状态灯据此显示「MCP 正在被调用」。
   */
  const tool = (
    name: string,
    shape: z.ZodRawShape,
    handler: (args: any, extra: any) => unknown
  ): RegisteredTool =>
    (server.registerTool as any)(
      name,
      { inputSchema: z.object(shape).strict() },
      (args: any, extra: any) => mcpActivity.wrapTool(name, () => handler(args, extra))
    )

  // 当前操作目标视图:可指定 tabId,默认取活动标签(活动标签是内部页面时退到最近浏览的页面标签);
  // 内部页面标签(如 bow://settings)持有应用 preload,一律不作为页面工具的操作目标。
  const target = (tabId?: number): { view: ReturnType<TabManager['getActiveView']>; fail: string | null } => {
    if (tabId != null) {
      const hit = tabs.getView(tabId)
      if (!hit) return { view: null, fail: `标签 ${tabId} 不存在` }
      if (hit.info.internal) return { view: null, fail: `标签 ${tabId} 是浏览器内部页面(设置 / DevTools 前端),不支持页面操作` }
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

  /** 取标签页的 WebContents(等待类工具用) */
  const wcOf = (tabId: number): WebContents | null => tabs.getView(tabId)?.view.webContents ?? null

  /**
   * 等到指定标签导航到 expectUrl 并加载完成;拿不到视图时返回失败体。
   * 用 navigation 模式:地址没到就不会结算(见 actions.ts 的结算判据)。
   */
  const loadFor = async (tabId: number, timeoutMs: number, expectUrl: string): Promise<ActionResult> => {
    const wc = wcOf(tabId)
    if (!wc) return { ok: false, error: `标签 ${tabId} 不存在` }
    return waitForLoad(wc, { mode: 'navigation', expectUrl, timeoutMs })
  }

  /** 加载等待结果的统一回执:失败直接带 error,成功带 waited 供模型判断是否真的等了 */
  const loadFields = (res: ActionResult): Record<string, unknown> =>
    res.ok ? { waited: res.waited, loadedUrl: res.url } : { error: res.error }

  tool(
    'browser_navigate',
    {
      url: z.string().describe('http(s) 地址'),
      tabId: z.number().optional().describe('目标标签;省略则作用于活动标签'),
      waitUntil: WaitUntilSchema.default('load').describe("'load' 等到页面加载完成(默认);'none' 立即返回"),
      timeoutMs: z.number().int().positive().optional().describe('waitUntil=load 时的超时毫秒数,默认 15000')
    },
    async ({ url, tabId, waitUntil, timeoutMs }) => {
      if (!isHttpUrl(url)) return textContent({ ok: false, error: 'navigate 仅接受 http/https 地址' })
      // 指定 tabId:就地导航该标签(是内部页面标签时 target() 会直接拒绝)
      if (tabId != null) {
        const { view, fail } = target(tabId)
        if (!view) return textContent({ ok: false, error: fail })
        const id = view.info.id
        if (!tabs.navigate(id, url)) {
          return textContent({ ok: false, tabId: id, error: `标签 ${id} 无法导航到该地址` })
        }
        if (waitUntil === 'none') return textContent({ ok: true, url, tabId: id, createdTab: false })
        const res = await loadFor(id, timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS, url)
        return textContent({ ok: res.ok, url, tabId: id, createdTab: false, ...loadFields(res) })
      }
      // 未指定:活动标签是设置等内部页面时另开新标签(内部页面不可被导航走)
      const activeBefore = tabs.getActiveView()
      const tab = tabs.openUrl(url)
      const createdTab = tab.id !== activeBefore?.info.id
      if (waitUntil === 'none') return textContent({ ok: true, url, tabId: tab.id, createdTab })
      const res = await loadFor(tab.id, timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS, url)
      return textContent({ ok: res.ok, url, tabId: tab.id, createdTab, ...loadFields(res) })
    }
  )

  tool(
    'browser_search',
    {
      query: z.string(),
      engine: EngineSchema.optional(),
      tabId: z.number().optional().describe('目标标签;省略则作用于活动标签'),
      waitUntil: WaitUntilSchema.default('load').describe("'load' 等到页面加载完成(默认);'none' 立即返回"),
      timeoutMs: z.number().int().positive().optional()
    },
    async ({ query, engine, tabId, waitUntil, timeoutMs }) => {
      const settings = getSettingsStore().get()
      const engineId: SearchEngineId = engine ?? settings.searchEngine
      const url = searchUrl(engineId, query)
      // 指定 tabId:就地导航该标签(是内部页面标签时 target() 会直接拒绝)
      if (tabId != null) {
        const { view, fail } = target(tabId)
        if (!view) return textContent({ ok: false, error: fail })
        const id = view.info.id
        if (!tabs.navigate(id, url)) {
          return textContent({ ok: false, tabId: id, error: `标签 ${id} 无法导航到该地址` })
        }
        if (waitUntil === 'none') return textContent({ ok: true, engine: engineId, url, tabId: id, createdTab: false })
        const res = await loadFor(id, timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS, url)
        return textContent({ ok: res.ok, engine: engineId, url, tabId: id, createdTab: false, ...loadFields(res) })
      }
      const activeBefore = tabs.getActiveView()
      const tab = tabs.openUrl(url)
      const createdTab = tab.id !== activeBefore?.info.id
      if (waitUntil === 'none') return textContent({ ok: true, engine: engineId, url, tabId: tab.id, createdTab })
      const res = await loadFor(tab.id, timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS, url)
      return textContent({ ok: res.ok, engine: engineId, url, tabId: tab.id, createdTab, ...loadFields(res) })
    }
  )

  tool(
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

  tool(
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

  tool(
    'browser_wait',
    {
      tabId: z.number().optional(),
      selector: z.string().optional().describe('CSS 选择器;省略则等待页面加载完成'),
      state: WaitStateSchema.default('visible').describe(
        'attached/visible/hidden/detached;仅在有 selector 时生效'
      ),
      timeoutMs: z.number().int().positive().max(120_000).optional().describe('默认:等元素 10000,等加载 15000')
    },
    async ({ tabId, selector, state, timeoutMs }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const id = view.info.id
      const wc = view.view.webContents
      if (selector) {
        const res = await waitForSelector(wc, selector, state, timeoutMs ?? DEFAULT_SELECTOR_TIMEOUT_MS)
        return textContent(
          res.ok
            ? { ok: true, tabId: id, selector, state, waited: true }
            : { ok: false, tabId: id, selector, state, error: res.error }
        )
      }
      const res = await waitForLoad(wc, { mode: 'idle', timeoutMs: timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS })
      return textContent({ ok: res.ok, tabId: id, ...loadFields(res) })
    }
  )

  tool(
    'browser_click',
    {
      selector: z.string().describe('CSS 选择器'),
      tabId: z.number().optional(),
      waitUntil: WaitUntilSchema.default('none').describe(
        "'none' 点完即返回(默认,适合 SPA 内局部交互);'load' 等到点击引发的跳转加载完成"
      ),
      timeoutMs: z.number().int().positive().optional()
    },
    async ({ selector, tabId, waitUntil, timeoutMs }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const id = view.info.id
      const res = await pageClick(view.view.webContents, selector)
      if (!res.ok) return textContent({ ok: false, tabId: id, error: res.error })
      if (waitUntil !== 'load') return textContent({ ok: true, tabId: id, selector, result: res })
      const load = await waitForLoad(view.view.webContents, {
        mode: 'maybe-navigation',
        timeoutMs: timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
      })
      return textContent({ ok: load.ok, tabId: id, selector, result: res, ...loadFields(load) })
    }
  )

  tool(
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

  tool(
    'browser_press_key',
    {
      key: z.string().describe('按键,如 Enter / Tab / Escape / ArrowDown / Ctrl+W / F5;F5 与 Ctrl+R 会等到重新加载完成'),
      tabId: z.number().optional(),
      waitUntil: WaitUntilSchema.default('none').describe(
        "'none' 投递后立即返回(默认,仅代表事件已投递);'load' 等到按键引发的跳转加载完成"
      ),
      timeoutMs: z.number().int().positive().optional()
    },
    async ({ key, tabId, waitUntil, timeoutMs }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const low = key.toLowerCase()
      if (low === 'f5' || low === 'ctrl+r' || low === 'control+r') {
        tabs.reload(view.info.id)
        const res = await waitForLoad(view.view.webContents, {
          mode: 'maybe-navigation',
          timeoutMs: DEFAULT_LOAD_TIMEOUT_MS
        })
        return textContent({ ok: res.ok, tabId: view.info.id, key, ...loadFields(res) })
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
      if (!res.ok) return textContent({ ok: false, tabId: view.info.id, error: res.error })
      if (waitUntil !== 'load') return textContent({ ok: true, pressed: key, tabId: view.info.id })
      const load = await waitForLoad(view.view.webContents, {
        mode: 'maybe-navigation',
        timeoutMs: timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
      })
      return textContent({ ok: load.ok, pressed: key, tabId: view.info.id, ...loadFields(load) })
    }
  )

  tool(
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

  // 后退/前进会引发导航,默认等到加载完成;stop 无等待语义
  const navigations: Array<{ name: string; fn: (id: number) => void }> = [
    { name: 'browser_back', fn: (id) => tabs.back(id) },
    { name: 'browser_forward', fn: (id) => tabs.forward(id) }
  ]
  for (const { name, fn } of navigations) {
    tool(
      name,
      {
        tabId: z.number().optional(),
        waitUntil: WaitUntilSchema.default('load').describe("'load' 等到页面加载完成(默认);'none' 立即返回"),
        timeoutMs: z.number().int().positive().optional()
      },
      async ({ tabId, waitUntil, timeoutMs }) => {
        const { view, fail } = target(tabId)
        if (!view) return textContent({ ok: false, error: fail })
        const id = view.info.id
        fn(id)
        if (waitUntil === 'none') return textContent({ ok: true, tabId: id })
        const res = await waitForLoad(view.view.webContents, {
          mode: 'maybe-navigation',
          timeoutMs: timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
        })
        return textContent({ ok: res.ok, tabId: id, ...loadFields(res) })
      }
    )
  }

  tool('browser_stop', { tabId: z.number().optional() }, async ({ tabId }) => {
    const { view, fail } = target(tabId)
    if (!view) return textContent({ ok: false, error: fail })
    tabs.stop(view.info.id)
    return textContent({ ok: true, tabId: view.info.id })
  })

  tool(
    'browser_reload',
    {
      tabId: z.number().optional(),
      waitUntil: WaitUntilSchema.default('load').describe("'load' 等到重新加载完成(默认);'none' 立即返回"),
      timeoutMs: z.number().int().positive().optional()
    },
    async ({ tabId, waitUntil, timeoutMs }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const id = view.info.id
      tabs.reload(id)
      if (waitUntil === 'none') return textContent({ ok: true, tabId: id })
      const res = await waitForLoad(view.view.webContents, {
        mode: 'maybe-navigation',
        timeoutMs: timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
      })
      return textContent({ ok: res.ok, tabId: id, ...loadFields(res) })
    }
  )

  tool(
    'browser_new_tab',
    {
      url: z.string().optional(),
      activate: z.boolean().default(true),
      waitUntil: WaitUntilSchema.default('load').describe("'load' 等到页面加载完成(默认);'none' 立即返回"),
      timeoutMs: z.number().int().positive().optional()
    },
    async ({ url, activate, waitUntil, timeoutMs }) => {
      if (url && !isHttpUrl(url)) return textContent({ ok: false, error: 'new_tab 仅接受 http/https 地址' })
      const t = tabs.create(url ?? 'about:blank', activate)
      // 新建标签的 info.url 要等 did-navigate 才更新,这里先回显请求地址,完成后的真实地址在 loadedUrl
      const requested = url ?? 'about:blank'
      if (!url || waitUntil === 'none') return textContent({ ok: true, tabId: t.id, url: requested })
      const res = await loadFor(t.id, timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS, url)
      return textContent({ ok: res.ok, tabId: t.id, url: requested, ...loadFields(res) })
    }
  )

  tool('browser_close_tab', { tabId: z.number() }, async ({ tabId }) => {
    const res = tabs.close(tabId)
    return textContent(res.ok ? { ok: true, closed: tabId } : { ok: false, error: `标签 ${tabId} 不存在` })
  })

  tool('browser_switch_tab', { tabId: z.number() }, async ({ tabId }) => {
    const hit = tabs.getView(tabId)
    if (!hit) return textContent({ ok: false, error: `标签 ${tabId} 不存在` })
    tabs.activate(tabId)
    return textContent({ ok: true, activate: true, tabId })
  })

  tool('browser_list_tabs', {}, async () => {
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
        internal: !!t.internal,
        // DevTools 前端标签(远程调试):同样是「浏览器自身页面」,这里多给一个标记方便 AI 区分
        ...(t.inspector ? { inspector: true } : {})
      }))
    })
  })

  tool(
    'browser_screenshot',
    { tabId: z.number().optional(), fullPage: z.boolean().optional() },
    async ({ tabId, fullPage }) => {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const res = await pageScreenshot(view.view.webContents, { fullPage: fullPage === true })
      if (!res.ok || !res.data) return textContent({ ok: false, error: res.error ?? '截图失败' })
      return imageContent(res.data.pngBase64)
    }
  )

  tool('browser_get_info', { tabId: z.number().optional() }, async ({ tabId }) => {
    const { view, fail } = target(tabId)
    if (!view) return textContent({ ok: false, error: fail })
    return textContent({ ok: true, info: view.info })
  })

  return server
}

/** 把插件声明的工具接入某个服务器实例 */
function registerPluginTools(server: McpServer, kernel: PluginKernel, mode: 'attach' | 'snapshot'): void {
  // 插件侧 config.inputSchema 为 zod raw shape;SDK 的重载推导在此处无收益,直接放宽。
  // 与核心工具同样经 mcpActivity 计数,MCP 状态灯对插件工具也有反应。
  const register = (spec: McpToolSpec): RegisteredTool =>
    (server.registerTool as any)(spec.name, spec.config, (args: unknown) =>
      mcpActivity.wrapTool(spec.name, () => spec.handler(args as Record<string, unknown>))
    )
  // stdio:内核缓冲声明时回交句柄,插件停用时可热移除
  if (mode === 'attach') kernel.mcp.attach(register)
  // HTTP 无状态:每个请求都是新实例,直接从声明快照注册(插件启停自然在下一次请求生效)
  else for (const spec of kernel.mcp.listSpecs()) register(spec)
}

/**
 * stdio 模式:单实例长连接。
 * 传输层可注入(测试用 InMemoryTransport 注入,无需真实 stdio 与显示环境)。
 */
export function startMcpServer(deps: MCPDeps, transport?: Transport): Promise<void> {
  const server = buildBrowserServer(deps)
  registerPluginTools(server, deps.kernel, 'attach')
  const link = transport ?? new StdioServerTransport()
  return server
    .connect(link)
    .then(() => log('MCP 服务器已连接'))
    .catch((e) => {
      logError('MCP 服务器启动失败', e instanceof Error ? e.message : e)
      process.exit(1)
    })
}

/** HTTP 无状态模式:每个请求新建实例(插件工具取声明快照) */
export function createStatelessServer(deps: MCPDeps): McpServer {
  const server = buildBrowserServer(deps)
  registerPluginTools(server, deps.kernel, 'snapshot')
  return server
}