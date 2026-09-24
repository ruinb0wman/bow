/** 渲染层(Vue UI)与主进程的 IPC 桥:核心 chrome 交互 + 插件调用面 */

import { clipboard, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { defaultNavInputDeps, resolveNavigationWithFiles } from './navInput'
import type { OverlayContent, OverlayEvent, Settings, TabInfo } from '@shared/types'
import { nextLayoutName, nextLayoutPresetId, normalizeLayoutPresets, paneCount, shapeOf } from '@shared/split'
import type { LayoutPreset, PaneDir } from '@shared/split'
import type { PluginKernel } from './plugins/kernel'
import type { WindowContext, WindowManager } from './windows'
import { getLayoutsStore, getSettingsStore } from './stores'
import { CLOSE_CONFIRM_OVERLAY_ID, confirmWindowClose } from './closeConfirm'
import { focusAddressBar } from './tabShortcuts'
import { log } from './logger'

/** 向某个窗口的 chrome 发消息(窗口/它的 webContents 已销毁则忽略) */
export function sendToChrome(ctx: WindowContext, channel: string, payload?: unknown): void {
  if (ctx.window.isDestroyed()) return
  const wc = ctx.window.webContents
  if (!wc || wc.isDestroyed()) return
  wc.send(channel, payload)
}

/**
 * 每个窗口一份的 chrome 事件接线(标签增删改、标签组、页面获焦)。
 * 与 `registerIpc()` 分离:后者只注册一次全局 `ipcMain.handle`,本函数每开一个窗口调一次。
 */
export function wireWindowIpc(ctx: WindowContext): void {
  const sendTabsList = (): void => sendToChrome(ctx, 'tab:list-changed', ctx.tabs.listTabs())

  ctx.tabs.on('tab-updated', (tab) => sendToChrome(ctx, 'tab:updated', tab))
  ctx.tabs.on('tabs-changed', sendTabsList)
  // 标签组结构只需通知 chrome(overlay 面板的数据由 chrome 组装并下发)
  ctx.tabs.on('groups-changed', (groups) => sendToChrome(ctx, 'groups:changed', groups))
  // 页面视图抢走键盘焦点 → chrome 收起自己的瞬态面板(地址栏建议下拉 / 分屏面板)。
  // 为什么不听 chrome 自己的 blur:跨 WebContentsView 的焦点切换不保证派发 DOM blur,
  // 反过来也会出现迟到的事件(典型是 Ctrl+T:create() 先 focus 新页面视图,
  // 紧接着 focusAddressBar() 把键盘焦点还给 chrome) —— 所以投递前用 isFocused() 核一下现况,
  // 否则会把刚打开的地址栏面板立即收回去。
  ctx.tabs.on('view-focused', (id) => {
    if (ctx.window.isDestroyed()) return
    // Electron 的 'focus' 事件可能**迟到**:此刻 chrome 已经又拿回了键盘焦点
    // (典型是 Ctrl+T:create() 先 focus 新页面视图,紧接着 focusAddressBar() 把焦点还给 chrome)
    // → 这种过期事件必须丢弃,否则会把刚打开的地址栏面板立即收回去。
    if (ctx.window.webContents.isFocused()) {
      log('页面视图获焦,但 chrome 仍持有键盘焦点(迟到的 focus 事件),忽略', id)
      return
    }
    sendToChrome(ctx, 'chrome:page-focus')
  })
}

export function registerIpc(windows: WindowManager, kernel: PluginKernel): void {
  /** 由 IPC 来源的 webContents 反查窗口(chrome / overlay / 内部页都能认出来) */
  const ctxOf = (e: IpcMainInvokeEvent): WindowContext | null => windows.byWebContents(e.sender)
  /** 同时通知所有窗口的 chrome、overlay 与内部页面标签(设置变更/插件事件是全局的) */
  const broadcast = (channel: string, payload: unknown): void => windows.broadcast(channel, payload)
  const sendSettings = (settings: Settings): void => broadcast('settings:changed', settings)

  ipcMain.handle('tab:create', (e, url?: string, activate = true): TabInfo | null => {
    const ctx = ctxOf(e)
    return ctx ? ctx.tabs.create(url, activate) : null
  })
  ipcMain.handle('tab:close', (e, id: number) => ctxOf(e)?.tabs.close(id) ?? { ok: false })
  ipcMain.handle('tab:restore', (e) => ctxOf(e)?.tabs.restoreLastClosed() ?? null)
  ipcMain.handle('tab:activate', (e, id: number) => {
    const ctx = ctxOf(e)
    if (!ctx) return null
    ctx.tabs.activate(id)
    return ctx.tabs.getActiveTabInfo()
  })
  ipcMain.handle('tab:list', (e) => ctxOf(e)?.tabs.listTabs() ?? [])
  ipcMain.handle('tab:active', (e) => ctxOf(e)?.tabs.getActiveTabInfo() ?? null)
  // 渲染层请求「真正的」地址栏聚焦:先把键盘焦点交给 chrome webContents(渲染层自己 el.focus()
  // 只改 DOM 状态、键盘事件仍进页面),再由主进程回发 chrome:focus-address 让它聚焦并全选。
  // 入口:工具栏 `+` / 双击标签栏新建标签、地址栏建议面板的 cancel。
  ipcMain.handle('chrome:request-focus-address', (e) => {
    const ctx = ctxOf(e)
    if (ctx) focusAddressBar(ctx.tabs)
    return true
  })
  // 激活最近浏览的普通页面标签(设置页的「屏蔽元素」等需要回到真实页面执行)
  ipcMain.handle('tab:activate-last-browsing', (e) => ctxOf(e)?.tabs.activateLastBrowsing() ?? null)
  // 内部页面认领自己所属的标签:终端页据此把 node-pty 会话绑到 tabId(而不是「最后激活的标签」)
  ipcMain.handle('tab:self', (e) => ctxOf(e)?.tabs.findTabIdByWebContents(e.sender) ?? null)

  // 剪贴板:内部页面统一走主进程。渲染层虽然也有 navigator.clipboard,但它的可用性取决于
  // secure context 与 Electron 的权限回调,主进程这两条没有这些变数(终端复制粘贴需要它可靠)。
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.handle('clipboard:write-text', (_e, text: string) => {
    clipboard.writeText(typeof text === 'string' ? text : '')
    return true
  })

  // ---------- 标签组(标签栏一项 = 一个组;组里是嵌套分屏树) ----------
  // 分屏 / 调整大小的**键盘入口在主进程**(tabShortcuts.ts);这两条 IPC 同时是渲染层兜底与
  // E2E 的入口(CDP 注入的按键验不了主进程 before-input-event)。
  const PANE_DIRS: readonly string[] = ['left', 'right', 'up', 'down']
  const isPaneDir = (v: unknown): v is PaneDir => typeof v === 'string' && PANE_DIRS.includes(v)

  ipcMain.handle('groups:get', (e) => ctxOf(e)?.tabs.listGroups() ?? [])
  ipcMain.handle('groups:activate', (e, groupId?: number) => {
    const ctx = ctxOf(e)
    if (ctx) {
      if (typeof groupId === 'number') ctx.tabs.activateGroup(groupId)
      return ctx.tabs.listGroups()
    }
    return []
  })
  ipcMain.handle('groups:split', (e, dir?: unknown) => {
    const ctx = ctxOf(e)
    if (ctx) {
      if (isPaneDir(dir)) ctx.tabs.splitFocused(dir)
      return ctx.tabs.listGroups()
    }
    return []
  })
  ipcMain.handle('groups:resize', (e, dir?: unknown) => {
    const ctx = ctxOf(e)
    if (ctx) {
      if (isPaneDir(dir)) ctx.tabs.resizeFocused(dir)
      return ctx.tabs.listGroups()
    }
    return []
  })
  ipcMain.handle('groups:ungroup', (e) => {
    ctxOf(e)?.tabs.ungroupActive()
    return ctxOf(e)?.tabs.listGroups() ?? []
  })

  // ---------- 保存的分屏布局(split-layouts.json;只存结构,套用时开新标签组) ----------
  const listLayouts = (): LayoutPreset[] => normalizeLayoutPresets(getLayoutsStore().get())

  ipcMain.handle('layouts:list', () => listLayouts())
  ipcMain.handle('layouts:save', (e, name?: unknown) => {
    const ctx = ctxOf(e)
    const existing = listLayouts()
    const tree = ctx?.tabs.activeGroupTree() ?? null
    // 单窗格组没有结构可存:不打扰、也不产生垃圾条目
    if (!tree || paneCount(tree) < 2) return existing
    const cleaned = typeof name === 'string' ? name.trim().slice(0, 24) : ''
    const preset: LayoutPreset = {
      id: nextLayoutPresetId(existing.map((p) => p.id)),
      name: cleaned || nextLayoutName(existing),
      shape: shapeOf(tree)
    }
    const next = normalizeLayoutPresets([...existing, preset])
    getLayoutsStore().setRaw(next)
    log('保存分屏布局', preset.id, preset.name)
    return next
  })
  ipcMain.handle('layouts:apply', (e, id?: unknown) => {
    const ctx = ctxOf(e)
    const hit = typeof id === 'string' ? listLayouts().find((p) => p.id === id) ?? null : null
    if (hit) ctx?.tabs.applyLayout(hit.shape)
    return ctx?.tabs.listGroups() ?? []
  })
  ipcMain.handle('layouts:delete', (_e, id?: unknown) => {
    const existing = listLayouts()
    if (typeof id !== 'string') return existing
    const next = existing.filter((p) => p.id !== id)
    if (next.length === existing.length) return existing
    getLayoutsStore().setRaw(next)
    log('删除分屏布局', id)
    return next
  })

  ipcMain.handle('nav:go', (e, input: string) => {
    const ctx = ctxOf(e)
    if (!ctx) return { parsed: null, tabId: null, url: '' }
    // 本地文件路径(存在的)在这里被识别成 file://,其余输入行为与原先完全一致
    const res = resolveNavigationWithFiles(input, getSettingsStore().get().searchEngine, defaultNavInputDeps())
    if (!res) {
      const tab = ctx.tabs.ensureActive()
      return { parsed: null, tabId: tab.id, url: tab.url }
    }
    // 内部页面 URL(bow://settings)→ 打开/聚焦内部标签;活动标签为内部页面时另开新标签
    const tab = ctx.tabs.openUrl(res.url)
    if (res.parsed === 'search') {
      // 搜索词富化:发布事件由历史插件记为 search 条目(did-navigate 的 plain 记录按 URL 去重合并)
      kernel.emitEvent('search:performed', { url: res.url, query: res.query, title: res.query })
    }
    return {
      parsed: res.parsed,
      query: res.parsed === 'search' ? res.query : undefined,
      url: res.url,
      tabId: tab.id
    }
  })

  ipcMain.handle('nav:url', (e, url: string) => {
    const ctx = ctxOf(e)
    return { tabId: ctx ? ctx.tabs.openUrl(url).id : null }
  })
  ipcMain.handle('nav:back', (e) => {
    const ctx = ctxOf(e)
    return ctx ? ctx.tabs.back(ctx.tabs.ensureActive().id) : false
  })
  ipcMain.handle('nav:forward', (e) => {
    const ctx = ctxOf(e)
    return ctx ? ctx.tabs.forward(ctx.tabs.ensureActive().id) : false
  })
  ipcMain.handle('nav:reload', (e) => {
    const ctx = ctxOf(e)
    if (!ctx) return
    const tab = ctx.tabs.ensureActive()
    ctx.tabs.reload(tab.id)
  })
  ipcMain.handle('nav:stop', (e) => {
    const ctx = ctxOf(e)
    if (!ctx) return
    const tab = ctx.tabs.ensureActive()
    ctx.tabs.stop(tab.id)
  })

  // 设置(核心:搜索引擎 / 主页;插件设置由各插件自管)
  ipcMain.handle('settings:get', () => getSettingsStore().get())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const store = getSettingsStore()
    const settings = store.set(patch)
    sendSettings(settings)
    return settings
  })

  // 通用顶层浮层开关(chrome 侧下发内容描述;overlay 页面按 id 渲染注册表组件)。
  // 多窗口:浮层开在**发起请求的那个窗口**(每个窗口一套 OverlayManager)。
  ipcMain.handle('ui:overlay', (e, content: OverlayContent | null) => {
    ctxOf(e)?.overlay.show(content)
    return true
  })
  // overlay → chrome / 插件:
  // - suggest 下拉事件转发 chrome;
  // - close-request 由主进程统一关闭浮层;
  // - 其余按浮层 id 路由给所属插件 main(约定注册 overlay-event 方法)。
  ipcMain.handle('ui:overlay-event', async (e, ev: OverlayEvent) => {
    const ctx = ctxOf(e)
    if (!ctx) return false
    // 核心浮层的事件回流:chrome 是它们各自的 owner(suggest 地址栏下拉 / split-menu 分屏面板)。
    // ⚠️ 必须在下面的通用 close-request 之前 —— 否则 chrome 收不到关闭事件,面板开关状态会变脏。
    if (ev.id === 'suggest' || ev.id === 'split-menu') {
      sendToChrome(ctx, 'overlay-event', ev)
      return true
    }
    if (ev.event === 'close-request') {
      ctx.overlay.show(null)
      return true
    }
    // 关闭窗口确认框:取消走上面的通用 close-request,只有确认需要主进程放行 close
    if (ev.id === CLOSE_CONFIRM_OVERLAY_ID && ev.event === 'confirm') {
      confirmWindowClose(ctx.window)
      return true
    }
    await kernel.routeOverlayEvent(ev.id, ev.event, ev.args)
    return true
  })

  // ---------- 插件调用面 ----------
  ipcMain.handle('plugins:list', () => kernel.list())
  ipcMain.handle('plugins:set-enabled', (_e, id: string, enabled: boolean) => kernel.setEnabled(id, enabled))
  ipcMain.handle('plugins:invoke', (_e, id: string, method: string, args: unknown[]) =>
    kernel.invoke(id, method, args ?? [])
  )
  ipcMain.handle('plugins:overlay-event', (_e, overlayId: string, event: string, args: unknown) =>
    kernel.routeOverlayEvent(overlayId, event, args)
  )
  ipcMain.handle('plugins:suggest', (_e, input: string) => kernel.suggest(input))

  // 窗口控制(作用在发起调用的那个窗口上)
  ipcMain.handle('window:minimize', (e) => ctxOf(e)?.window.minimize())
  ipcMain.handle('window:maximize', (e) => {
    const win = ctxOf(e)?.window
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', (e) => ctxOf(e)?.window.close())

  // chrome 高度(渲染层实测)→ 页面视图布局 + overlay 条带定位
  ipcMain.handle('ui:chrome-height', (e, height: number) => {
    const ctx = ctxOf(e)
    if (!ctx) return false
    log('chrome 高度上报', height)
    ctx.tabs.setChromeHeight(Math.max(0, Math.round(height)))
    ctx.overlay.layout()
    return true
  })

  log('IPC 注册完成')
}
