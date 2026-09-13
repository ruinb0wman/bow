import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { TabManager } from './tabManager'
import { OverlayManager } from './overlay'
import { registerIpc } from './ipc'
import { setupCorsBypass } from './cors'
import { initStores, getSettingsStore } from './stores'
import { setupDevTools } from './devtools'
import { setupTabShortcuts } from './tabShortcuts'
import { startMcpServer } from './mcp'
import { IS_MCP, log, logError } from './logger'

const isDev = !!process.env['ELECTRON_RENDERER_URL']

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

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

let tabs: TabManager
let overlay: OverlayManager

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

if (IS_MCP) {
  // MCP 模式下禁止 Chromium 往 stdout 打日志,避免破坏协议帧
  app.commandLine.appendSwitch('disable-logging')
}

app.whenReady().then(() => {
  initStores()
  // 先于任何窗口/视图创建:保证 DevTools / Tab 快捷键监听覆盖全部 webContents
  // CORS 白名单注入同样需在 webContents 创建前挂到 defaultSession
  setupCorsBypass()
  setupDevTools()
  setupTabShortcuts(() => tabs, () => overlay)

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

  registerIpc(tabs, mainWindow, overlay)

  if (IS_MCP) {
    startMcpServer({ tabs })
  }

  log('应用已启动', { mcp: IS_MCP, version: app.getVersion() })
})

app.on('window-all-closed', () => {
  app.quit()
})

process.on('uncaughtException', (e) => {
  logError('未捕获异常', e)
})