import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { TabManager } from './tabManager'
import { OverlayManager } from './overlay'
import { registerIpc } from './ipc'
import { initStores, getSettingsStore } from './stores'
import { setupDevTools } from './devtools'
import { setupTabShortcuts } from './tabShortcuts'
import { loadRendererEntry } from './rendererEntry'
import { startMcpServer, CORE_MCP_TOOL_NAMES } from './mcp'
import { applyBrowserIdentity } from './ua'
import { PluginKernel } from './plugins/kernel'
import { BUILTIN_PLUGINS } from './plugins/builtin'
import { IS_MCP, log, logError } from './logger'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    show: false,
    backgroundColor: '#1e1f24',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())
  win.on('resize', () => tabs.layout())

  loadRendererEntry(win.webContents, 'index')
  return win
}

let tabs: TabManager
let overlay: OverlayManager
let kernel: PluginKernel

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

if (IS_MCP) {
  // MCP 模式下禁止 Chromium 往 stdout 打日志,避免破坏协议帧
  app.commandLine.appendSwitch('disable-logging')
}

app.whenReady().then(async () => {
  // 先于一切窗口/视图/存储:显示名 → bow、userData 钉旧路径、UA 全局签名
  applyBrowserIdentity()
  initStores()
  // 先于任何窗口/视图创建:保证 DevTools / Tab 快捷键监听覆盖全部 webContents
  setupDevTools()
  setupTabShortcuts(() => tabs, () => overlay)

  // 插件内核:网络钩子与内容注入必须在任何窗口/视图创建前安装
  kernel = new PluginKernel()
  kernel.reserveMcpToolNames(CORE_MCP_TOOL_NAMES)
  kernel.registerAll(BUILTIN_PLUGINS)
  kernel.installHooks()
  await kernel.activateEnabled()

  // 外链默认走系统浏览器,页面内 target=_blank 由 TabManager 接管为新标签
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        tabs.create(url)
        return { action: 'deny' }
      }
      shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  const mainWindow = createWindow()
  tabs = new TabManager(mainWindow)
  overlay = new OverlayManager(mainWindow, tabs)

  // 窗口重新获得 OS 焦点:把键盘焦点交还活动标签页,避免 Electron 默认恢复到 chrome webContents(地址栏)
  const focusActivePage = (): void => {
    if (overlay.isFullOpen) return // 全窗弹层打开时不抢焦点
    const active = tabs.getActiveView()
    if (active && !active.view.webContents.isDestroyed()) active.view.webContents.focus()
  }
  mainWindow.on('focus', focusActivePage)
  // 窗口失焦:让 chrome 侧地址栏主动释放焦点,消除 Electron 焦点恢复落到地址栏的路径
  mainWindow.on('blur', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('chrome:window-blur')
  })
  // 标签页 webContents → 内核内容注入宿主
  tabs.setPageTracker({ track: (wc) => kernel.trackPage(wc) })

  // 插件内核的运行时依赖(窗口/标签就绪后注入;插件 activate 期间不会触达)
  kernel.setTabProvider(() => ({
    list: () => tabs.listTabs(),
    getActive: () => tabs.getActiveTabInfo()
  }))
  // 页面执行 API:主世界执行 JS(元素框选等交互式脚本),带超时保护
  kernel.setPageApi({
    activeTabId: () => tabs.getActiveTabInfo()?.id ?? null,
    focus: (tabId) => {
      const hit = tabs.getView(tabId)
      if (hit && !hit.view.webContents.isDestroyed()) hit.view.webContents.focus()
    },
    execute: (tabId, code, opts) => {
      const hit = tabs.getView(tabId)
      if (!hit || hit.view.webContents.isDestroyed()) {
        return Promise.reject(new Error('标签页不存在或已关闭'))
      }
      const wc = hit.view.webContents
      const timeoutMs = opts?.timeoutMs ?? 10_000
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`页面脚本执行超时(${timeoutMs}ms)`)), timeoutMs)
        wc.executeJavaScript(code, true).then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (err) => {
            clearTimeout(timer)
            reject(err)
          }
        )
      })
    }
  })
  kernel.setBroadcaster((channel, payload) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    overlay.send(channel, payload)
    // 设置等内部页面标签也订阅插件事件(plugins:changed / plugin:event)
    tabs.broadcastToInternal(channel, payload)
  })
  kernel.setUiHost({
    overlayId: () => overlay.currentId,
    closeOverlay: () => overlay.show(null)
  })

  // 标签生命周期 → 插件事件总线(历史等插件据此工作)
  tabs.on('tab-navigated', (p) => kernel.emitEvent('tab:navigated', p))
  tabs.on('tab-created', (t) => kernel.emitEvent('tab:created', t))
  tabs.on('tab-closed', (t) => kernel.emitEvent('tab:closed', t))
  tabs.on('tab-activated', (t) => kernel.emitEvent('tab:activated', t))

  // 新建/关闭标签后把弹层重新置顶,防止新视图盖住已打开的弹层
  tabs.on('tabs-changed', () => overlay.raise())

  mainWindow.webContents.on('did-finish-load', () => {
    // 首个标签加载主页
    if (tabs.listTabs().length === 0) {
      const homepage = getSettingsStore().get().homepage
      tabs.create(homepage)
    }
  })

  mainWindow.webContents.on('will-navigate', (e) => {
    // 防止 chrome UI 自身被导航走
    e.preventDefault()
  })

  registerIpc(tabs, mainWindow, overlay, kernel)

  if (IS_MCP) {
    startMcpServer({ tabs, kernel })
  }

  log('应用已启动', { mcp: IS_MCP, version: app.getVersion() })
})

app.on('window-all-closed', () => {
  app.quit()
})

process.on('uncaughtException', (e) => {
  logError('未捕获异常', e)
})
