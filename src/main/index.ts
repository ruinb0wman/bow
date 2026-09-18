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
import { acquireSingletonLock, focusFirstWindow } from './singleInstance'
import { collectOpenTargets, defaultOpenTargetDeps } from './openArgs'
import { PluginKernel } from './plugins/kernel'
import { BUILTIN_PLUGINS } from './plugins/builtin'
import { APP_DESKTOP_NAME } from '@shared/ua'
import { IS_MCP, IS_MCP_STDIO, IS_MCP_HTTP, MCP_HTTP_PORT, MCP_HTTP_TOKEN, log, logError } from './logger'

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
// 本地 html 的相对资源(图片 / CSS / 普通脚本)本来就能加载,但 <script type="module"> 与 fetch
// 会被 Chromium 的 file:// opaque origin 拦掉。这个开关只放宽 file:// 文档之间的互访,
// http(s) 页面加载 file:// 依旧被拒。
app.commandLine.appendSwitch('allow-file-access-from-files')

if (IS_MCP_STDIO) {
  // stdio 模式下禁止 Chromium 往 stdout 打日志,避免破坏协议帧
  app.commandLine.appendSwitch('disable-logging')
}

// Linux 桌面集成标识:必须与已安装的 .desktop 文件基名逐字一致
// (由内置插件「默认浏览器」写在 ~/.local/share/applications/com.ruinb0w.bow.desktop),否则
// Wayland app_id / X11 WM_CLASS 对不上 —— 图标与窗口分组会飘。Electron 要求该调用发生在 ready 之前,
// 所以它不能和 whenReady 里的 applyBrowserIdentity() 放一起。
if (process.platform === 'linux') app.setDesktopName(APP_DESKTOP_NAME)

// 命令行带来的打开目标(文件管理器「用 bow 打开」/ 终端 `bow x.html`)。
// stdio 模式下 argv 是 MCP 客户端拼的,绝不能当文件打开;dev 是 `electron . <args>`,
// 打包后是 `bow <args>`,所以 skip 随 app.isPackaged 变。
const initialTargets = IS_MCP_STDIO
  ? []
  : collectOpenTargets(process.argv, app.isPackaged ? 1 : 2, defaultOpenTargetDeps(), {
      onSkip: (arg, reason) => log('忽略启动参数', arg, reason)
    })

// 必须在 app ready 之前取锁。第二个实例拿到锁失败后会触发已有实例的 second-instance,
// 由后者把窗口带到前台,自己则直接退出(不创建窗口)。
const hasSingletonLock = acquireSingletonLock({
  isStdio: IS_MCP_STDIO,
  requestLock: () => app.requestSingleInstanceLock()
})
app.on('second-instance', (_e, argv, workingDirectory) => {
  focusFirstWindow(BrowserWindow.getAllWindows())
  // 第二个进程只负责传递意图(它自己随即退出):把 argv 里的 URL / 文件补开成新标签,
  // 而不是顶掉用户当前正在看的页面。tabs 还没建好(极早到达)时只聚焦。
  if (IS_MCP_STDIO || !tabs) return
  const targets = collectOpenTargets(argv, app.isPackaged ? 1 : 2, defaultOpenTargetDeps(workingDirectory), {
    onSkip: (arg, reason) => log('忽略启动参数', arg, reason)
  })
  for (const target of targets) tabs.create(target)
})

app.whenReady().then(async () => {
  if (!hasSingletonLock) {
    app.quit()
    return
  }
  // 先于一切窗口/视图/存储:显示名 → bow、userData 钉旧路径、UA 全局签名
  applyBrowserIdentity()
  initStores()
  // 先于任何窗口/视图创建:保证 DevTools / Tab 快捷键监听覆盖全部 webContents
  setupDevTools()
  setupTabShortcuts(
    () => tabs,
    () => overlay,
    () => kernel
  )

  // 插件内核:网络钩子与内容注入必须在任何窗口/视图创建前安装
  kernel = new PluginKernel()
  kernel.reserveMcpToolNames(CORE_MCP_TOOL_NAMES)
  kernel.registerAll(BUILTIN_PLUGINS)
  kernel.installHooks()
  await kernel.activateEnabled()

  // 外链:http(s) 与本地文件由 TabManager 接管为新标签,其它协议(邮件等)才交给系统处理程序
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // http(s) 与本地文件都进标签页;其它协议走系统默认处理程序(shell.openExternal)
      if (/^(https?|file):/i.test(url)) {
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
    },
    // 远程调试标签(设备检查插件用):内核负责拼 devtools:// 前端地址,插件只给 CDP 目标
    openDevToolsTab: (url, title, activate) => tabs.createInspectorTab(url, title, activate ?? true).id
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
    // 首个标签:优先打开命令行 / 文件管理器传来的目标(每个目标一个标签),否则开主页。
    // 放在这里而不是更早,是为了保证 registerIpc() 已挂好 tabs-changed 广播。
    if (tabs.listTabs().length > 0) return
    if (initialTargets.length > 0) {
      for (const target of initialTargets) tabs.create(target)
      return
    }
    tabs.create(getSettingsStore().get().homepage)
  })

  mainWindow.webContents.on('will-navigate', (e) => {
    // 防止 chrome UI 自身被导航走
    e.preventDefault()
  })

  registerIpc(tabs, mainWindow, overlay, kernel)

  if (IS_MCP_STDIO) {
    startMcpServer({ tabs, kernel })
  }
  // MCP HTTP 服务:先注入内核运行时依赖,再起强制模式(若有),最后唤醒等待中的插件。
  // 顺序即优先级:MCP_HTTP=1 先占住宿主,插件(默认开启)只会在没人起过时才真正监听。
  kernel.attachMcpHttpDeps({ tabs, kernel })
  if (IS_MCP_HTTP) {
    void kernel.mcpHttp.start({ port: MCP_HTTP_PORT, token: MCP_HTTP_TOKEN, source: 'env' }).then((s) => {
      // HTTP 模式下 stdout 不承载协议,地址直接打到终端方便复制
      if (s.url) console.log(`MCP HTTP 端点: ${s.url}(由 MCP_HTTP 环境变量强制开启)`)
      else logError('MCP HTTP 启动失败', s.error ?? '未知错误')
    })
  }
  // stdio 模式下浏览器是 MCP 客户端的子进程,再开一个 HTTP 端点没有意义,
  // 而且会与常驻实例抢 8765(谁先起谁占,另一个只能在设置页看到端口占用错误)。
  // 需要在 stdio 下也要端点就显式设 MCP_HTTP=1(强制模式不受这里影响)。
  if (!IS_MCP_STDIO) kernel.notifyMcpHttpReady()

  log('应用已启动', { mcp: IS_MCP, http: IS_MCP_HTTP, version: app.getVersion() })
})

app.on('window-all-closed', () => {
  app.quit()
})

process.on('uncaughtException', (e) => {
  logError('未捕获异常', e)
})
