# bow 架构与插件体系

> **读者**:AI agent 与未来的维护者。目标是「不读代码就能定位到代码」的高密度事实文档——
> 每条都给出文件路径与标识符,而不是叙述性描述。
>
> **来源**:2026-09-17 直接读源码得出(不是从 README 转抄)。凡与 README 冲突的地方都单列在 §12。
> 带 ⚠️ 的段落是**实测/验证过的坑**,不是推测。
>
> **配套文档**:`README.md`(面向使用者的操作说明:安装、部署、MCP 接入)、
> `.pi/skills/bow-browser/SKILL.md`(给 AI 的工具能力索引,随 `npm run mcp:install` 安装)、
> `FIX-PLAN.md`(⚠️ 已完成的历史计划,见 §12)。

---

## 0. 一句话定位

Electron 单窗口多标签浏览器(`productName: bow`),**内置 MCP 服务器**把自己的
页面操作能力暴露给 AI 工具;浏览器自身的每个功能(书签/历史/CORS/广告拦截/元素全屏/MCP HTTP)
都以**仓库内编译期插件**的形式实现,插件可运行时启停、能力自动回收。

- 三端:`main`(Node/Electron 全权限)、`renderer`(Vue 3,三个独立入口)、`shared`(同构纯逻辑)。
- 没有沙箱化的用户插件机制:**插件是源码模块**,新增 = 加目录 + 登记两行(见 §5.7)。

---

## 1. 目录地图

```
src/
  main/                          主进程(唯一持有 Electron 权限的地方)
    index.ts                     启动编排:身份/存储/热键 → 插件内核 → 窗口/标签 → IPC → MCP
    logger.ts                    日志 + 环境变量常量(IS_MCP_* / MCP_HTTP_*)
    ua.ts                        applyBrowserIdentity():显示名/ userData 路径 / UA 签名,一次调用;
                                 APP_DESKTOP_NAME 导出桌面集成标识(与 .desktop 文件名同源)
    singleInstance.ts            单实例锁(stdio 模式例外)
    rendererEntry.ts             四个渲染入口解析(dev=ELECTRON_RENDERER_URL,prod=file)
    openArgs.ts                  启动参数 → 打开目标(裸路径/URL;classifyArg 的判定顺序对 Windows 盘符路径敏感,
                                 second-instance 复用同一套规则)
    navInput.ts                  地址栏输入的本地文件兜底(不 import electron,可单测)
    devtools.ts                  DevTools 永远 detach + 全局快捷键拦截
    tabShortcuts.ts              标签/分屏快捷键(Ctrl+T/W/L/,/数字/Shift+T + Ctrl+Shift+方向/Alt+Shift+方向)全局拦截(终端页里 Ctrl+W/L 与分屏键放行给 shell)
    tabManager.ts                TabManager:每标签一个 WebContentsView + 内部页面标签 + 标签组/嵌套分屏 + 布局
    overlay.ts                   OverlayManager:常驻透明顶层视图,按 placement 布局
    closeConfirm.ts              关闭窗口确认:多标签时拦下 close 事件,改用应用内确认框
    actions.ts                   注入式页面操作原语(snapshot/click/type/scroll/pressKey/screenshot)+ waitForLoad
    ipc.ts                       chrome UI ↔ 主进程的 IPC 面(标签/导航/设置/浮层/布局/插件)
    stores.ts                    JsonStore(原子写)+ 核心 settings.json + 分屏布局 split-layouts.json
    mcp.ts                       核心 MCP 工具(19 个)+ MCP_INSTRUCTIONS + 服务器构建
    mcpHttp.ts                   无状态 StreamableHTTP 端点(回环 + Host 校验 + 可选 Bearer)
    mcpActivity.ts               在途工具调用计数器(进程级单例 mcpActivity)
    plugins/                     插件内核(见 §5.5)
      kernel.ts                  PluginKernel + PluginContextImpl(登记所有 disposer)
      core.ts                    PluginRegistry(纯逻辑:注册校验/固定顺序/启停投影)
      builtin.ts                 BUILTIN_PLUGINS 清单(顺序 = 网络钩子与建议源的稳定次序)
      types.ts                   PluginMain / PluginContext / PluginServiceApi 等主进程侧契约
      netHooks.ts                NetHookHost:独占 defaultSession 三个 webRequest 阶段
      contentHooks.ts            ContentHookHost:显式登记的标签页才注入 CSS/JS
      mcpHost.ts                 McpHost:缓冲插件工具声明,支持停用时热移除
      mcpHttpHost.ts             McpHttpHost:HTTP 服务的 owner/幂等/串行化
      mcpResult.ts               textContent / errorContent / imageContent(统一 isError 判定)
  plugins/<id>/                 内置插件(自包含,每插件一个目录)
    main.ts                     主进程侧:manifest + capabilities + activate(ctx)
    ui.ts                       渲染层侧:slots / overlays / settingsSections
    ui/*.vue                    该插件的 UI 组件(终端插件的 `ui/TerminalView.vue` 例外:它是 bow://terminal
                                页面的主体,由 renderer/src/terminal 直接挂载,不经渲染层注册表)
    shared.ts | picker.ts | scripts.ts   同构纯逻辑或注入脚本字符串(便于单测)
    adb.ts | targets.ts | cdp.ts          设备检查插件的 I/O 层(spawn / 转发池 / CDP 客户端;新文件名须登记到 tsconfig.node.json 的 include)
    relay.ts                              设备检查插件的「剥 Origin」TCP 中继(前端能连上设备的唯一原因;新文件名须登记到 tsconfig.node.json 的 include)
    registration.ts | linuxDesktop.ts | windowsRegistry.ts   平台实现 / 注册计划(新文件须登记到 tsconfig.node.json 的 include)
  preload/index.ts              contextBridge 暴露 window.browserAPI
  renderer/
    index.html + src/App.vue            chrome UI:标签栏/工具栏/地址栏/插件插槽
    overlay.html + src/overlay/         Overlay 宿主(注册表组件渲染)
    settings.html + src/settings/       设置页(bow://settings 内部标签页)
    terminal.html + src/terminal/       终端页(bow://terminal 内部标签页;xterm 视图在终端插件的 ui/ 里)
    src/plugins/registry.ts             PLUGIN_UI 注册表 + SLOT_PLUGIN_ORDER(渲染层唯一登记点)
    src/plugins/slots.ts                collectSlot 纯函数(插槽合并顺序,可单测)
    src/components/                     SuggestPanel(地址栏下拉)/ SplitMenu(分屏面板)/ CloseConfirmModal(关闭窗口确认)/ ModalShell(弹层壳 + Esc 栈顶)
    src/lib/                            avatar(字母头像)/ openFolder(批量后台开标签)/ modalStack
  shared/                        三端共享纯逻辑(无 electron / DOM)
    types.ts        跨端类型(TabInfo/Settings/Suggestion/Overlay*/ActionResult…)
    plugins.ts      插件契约类型 + PluginCapability 标签表
    url.ts          地址栏输入解析 + 搜索引擎表 + DEFAULT_SETTINGS
    groups.ts       标签组记账(标签栏一项 = 一个组:分屏/摘窗格/塌缩/焦点/拆组;纯函数)
    split.ts        嵌套分屏树(LayoutNode)+ 几何(computeLayout)+ 布局形状/预设归一化
    localFile.ts    本地路径形态判定(isFileUrl / looksLikeLocalPath / expandHome)
    internalPages.ts bow:// 内部页面标识与 parse(settings 单例 / terminal 可多开 + `openIn:'pane'` 顶替聚焦窗格,见 singleton / openIn 两轴)
    settingsNav.ts  设置页侧栏导航模型
    pluginMatch.ts  URL 通配 / host 与子域匹配
    suggest.ts      模糊打分 + 多来源合并 + 渲染行构建
    shortcuts.ts    快捷键识别(isDevToolsHotkey / matchTabHotkey / matchHotkey / switchIndexForDigit)
    cors.ts         CORS 白名单匹配 + 预检识别
    history.ts      历史条目增删/去重/裁剪/搜索/时间格式化
    bookmarkTree.ts 书签树 CRUD + 展平 + 一级目录迁移
    ua.ts           bowUserAgent() 纯函数
    devtools.ts     DevTools 前端 URL 构造(tabManager 与设备检查插件共用的唯一来源)
    adblock.ts      广告规则模型/解析/索引/匹配/迁移(v3),~1400 行
tests/            vitest 39 个测试文件(730 个用例)+ 3 个测试替身(fakeTabs/fakeWc/fakeKernel)
scripts/          构建与运维脚本(见 §11)
docs/             本文件 + opencode-session-header.md
.pi/skills/bow-browser/SKILL.md      给 AI 的能力索引(由 mcp:install 同步到 ~/.pi/agent/skills/)
```

---

## 2. 启动时序

`src/main/index.ts` 的顺序**有语义**,不是随意排列:

```text
模块级(import 时):
  logger.ts 读取 MCP / MCP_HTTP / MCP_HTTP_PORT / MCP_HTTP_TOKEN → 常量
  appendSwitch('allow-file-access-from-files')   本地页面的相对资源 / <script type="module"> / fetch
  IS_MCP_STDIO 时追加 --disable-logging(否则 Chromium 日志会污染 stdio 协议帧)
  app.setDesktopName(APP_DESKTOP_NAME)  ← Linux:Wayland app_id / X11 WM_CLASS,必须早于 ready
  collectOpenTargets(process.argv, …)     命令行带来的文件 / URL(stdio 模式恒为空)
  acquireSingletonLock()          ← 必须早于 ready(stdio 模式不抢锁)
  app.on('second-instance')       聚焦已有窗口 + 把 argv 里的目标开成新标签(tabs 未就绪时只聚焦)

whenReady():
  1. applyBrowserIdentity()       显示名→bow / userData 钉回 mcp-browser / UA 全局签名
                                  必须在任何 getPath('userData') 之前
  2. initStores()                 核心 settings.json
  3. setupDevTools()              注册 web-contents-created 监听 —— 必须早于任何窗口/视图创建,
  4. setupTabShortcuts(...)       否则已存在的 webContents 收不到快捷键
  5. new PluginKernel()
     reserveMcpToolNames(CORE_MCP_TOOL_NAMES)   插件重名将在激活时抛错
     registerAll(BUILTIN_PLUGINS)               读 plugins.json 的 disabled
     installHooks()                             NetHookHost.install() —— 必须先于窗口创建
     await activateEnabled()                    ← 此刻还没有窗口、没有 TabManager、没有标签
  6. app.on('web-contents-created')  外链处理:http(s) 与 file: 走新标签,其余 shell.openExternal
  7. createWindow() → TabManager → OverlayManager
     installCloseConfirm(mainWindow, tabs, overlay)   拦 close:≥2 个标签时先弹应用内确认框
  8. kernel.setTabProvider / setPageApi / setBroadcaster / setUiHost   注入运行时依赖
  9. tabs.on(...) → kernel.emitEvent('tab:navigated' | 'tab:created' | 'tab:closed' | 'tab:activated')
 10. chrome did-finish-load 且没有标签 → 先开命令行目标(initialTargets),否则开设置里的主页
 11. registerIpc(tabs, mainWindow, overlay, kernel)
 12. startMcpServer() (仅 stdio)
     kernel.attachMcpHttpDeps({tabs, kernel})
     IS_MCP_HTTP → kernel.mcpHttp.start({source:'env'})         强制模式先占位
     !IS_MCP_STDIO → kernel.notifyMcpHttpReady()                再唤醒插件
```

**第 5 步是整套设计里最容易踩的地方**:插件 `activate(ctx)` 发生在窗口/标签创建之前,
所以插件在 activate 期间**拿不到 TabManager**。依赖标签页的能力只有两条出路:

1. 通过 `ctx.service.onMcpHttpReady(cb)`(内核依赖就绪后回调)——MCP HTTP 插件走这条;
2. 通过 `ctx.tabs` / `ctx.pages`,它们由 `setTabProvider` / `setPageApi` 注入,
   在 activate 时是**空实现占位**(`EMPTY_TABS` / `EMPTY_PAGE_API`),调用只会返回空或 reject。

`EMPTY_PAGE_API.execute` 的 reject 文案是「页面执行 API 尚未就绪」。新增服务型插件**必须**沿用第 1 条路径。

---

## 3. 视图模型:谁盖着谁

Electron 的合成顺序:`contentView` 的子视图按加入顺序从底到顶;**页面(WebContentsView)永远绘制在 chrome UI 之上**,
所以任何要浮在页面上的 UI 都必须交给 Overlay。

| 视图 | 创建处 | 说明 |
| --- | --- | --- |
| chrome 窗口 webContents | `index.ts` 的 `createWindow()` | `frame:false`;承载 `index.html`(标签栏+工具栏+地址栏) |
| 每标签一个 `WebContentsView` | `TabManager.spawn()`(`create()` / `splitFocused()` / `applyLayout()` 共用) | 普通标签**不给 preload**(`sandbox:true`);bounds 全部由活动组的 `computeLayout()` 给出(见下) |
| Overlay `WebContentsView` | `OverlayManager.ensureView()` | 透明(`#00000000`)、单例、按需创建;`raise()` = 重新 `addChildView` 置顶 |
| 内部页面标签 | `TabManager.create(internalId)` | 唯一的例外:普通标签视图 + **注入应用 preload** |

布局引擎:

- chrome 的高度由渲染层实测后经 `ui:chrome-height` 上报 → `TabManager.setChromeHeight()` → `layout()`。
  `App.vue` 用 `ResizeObserver` + `window.resize` 双重触发,并在挂载后 300ms 补一次。
- `OverlayManager.layout()` 的两种 placement:
  - `full`:铺满窗口 `{0,0,w,h}`,聚焦接管(modal);
  - `below-chrome`:从 `bandTopOf()` 起到底部。`bandTopOf()` 取
    `min(chromeHeight, ceil(payload.rect.y + rect.height))`——即「绝不上盖工具栏,但尽量贴住地址栏底边」。
    **假设工具栏是 chrome 的最后一行**;将来加书签栏这种整行,这里要回退成 `chromeHeight`。
- `raise()` 由 `tabs.on('tabs-changed')` 触发:新标签视图会盖住已开浮层,所以每次标签增删都要重新置顶。
- **标签组(标签栏的一项 = 一个组)**:一个组是一棵**二叉嵌套分屏树**(`shared/split.ts` 的 `LayoutNode`:
  叶子是标签,`split` 节点带 `axis`(row=左右 / column=上下)与 `ratio`)。`TabManager` 持有
  `groups: TabGroup[]`(纯记账在 `@shared/groups`,树操作在 `@shared/split`;单测见 `tests/groups.test.ts`、
  `tests/split.test.ts`);普通组 1 个窗格、分屏组 2..`MAX_GROUP_PANES=8` 个,组空了整项消失。
  活动组由 `activeId`(聚焦窗格)推出(不另存 `activeGroupId`)。`layout()` 用 `computeLayout()`
  (每层沿自己的轴扣一个 `SPLIT_GAP=4px`、`ratio` 夹在 10%~90%、单窗格不小于 `MIN_PANE=120px`)
  算活动组的**窗格 rect 与分隔条 rect**,渲染层直接拿这两组矩形画,其余视图 `setVisible(false)`。
  四个关键不变式:①**`layout()` 是页面视图可见性的唯一来源**(旧实现把 `setVisible` 放在 `activate()` 里,
  导致 `create(url, activate=false)` 的后台标签会盖住当前页);②**几何只有一处实现** ——
  渲染层不重算(`App.vue` 只是 `v-for` 画出 `dividers`,坐标就是窗口内容坐标);
  ③**新建标签永远是新建一个组,`activate()` 不拆任何组** —— 所以新建 tab3 不会弄丢已有的分屏;
  ④`Ctrl+Shift+方向` 分屏时**每次都嵌套一层**(新窗格吃掉被分窗格一半),`Alt+Shift+方向` 从叶子
  **由内向外**找第一个「轴匹配且能朝该方向扩」的祖先改它的 `ratio`。
  组变化通过 `groups-changed` 事件 → `groups:changed` 通道只发给 chrome(面板数据由 chrome 组装下发)。

### overlay 的两种消息流(别搞混)

| 方向 | 通道 | 用途 |
| --- | --- | --- |
| chrome → 主进程 → overlay | `ui:overlay` → `overlay:show` | 显示/更新/关闭浮层(`OverlayShowMessage`,含 `meta.bandTop`) |
| overlay → 主进程 → chrome/插件 | `ui:overlay-event` | `ev.id === 'suggest'` / `'split-menu'` 转发 chrome(这两个核心浮层的 owner 都是 chrome);`ev.id === 'confirm-close'` 且 `event === 'confirm'` → `closeConfirm.confirmWindowClose()`;`ev.event === 'close-request'` 主进程直接关;其余 `kernel.routeOverlayEvent()` |

`kernel.routeOverlayEvent()` 用正则 `/^plugin:([^:]+):/` 从浮层 id 里解析插件,调用其注册的
`overlay-event(overlayId, event, args)` 方法。**浮层 id 的格式是有功能的约定**,不是命名风格。

Overlay 视图崩溃会自动重建(`recreate()`),且若当时正开着浮层会重新打开。

**窗口关闭拦截(多标签确认)** 也走这条通道:主进程的 `close` 处理里 ≥2 个标签就 `e.preventDefault()` +
`overlay.show({id:'confirm-close', placement:'full', payload:{tabCount}})`(状态在 `main/closeConfirm.ts`);
取消走上表的 `close-request`,确认就是那个 `confirm-close` 分支。两个刻意的设计:

- **确认框已经开着时再次触发关闭(Alt+F4 / 窗口管理器)直接放行** —— overlay 页面加载失败(dev server 未起等)
  时遮罩画不出来、按钮点不到,这是唯一不自锁的出口(`overlay.currentId` 是主进程状态,不依赖渲染成功)。
- **不新增 IPC 通道、不动 preload**:浮层组件用 `overlay-event` 和宿主说话,与插件浮层一致(代价是 `ipc.ts`
  要为 `confirm-close` 开一个核心分支,与 `suggest` 同位置);`window:close`(自绘关闭按钮)与 `Alt+F4`(不经 IPC)
  都汇聚到窗口的 `close` 事件,所以只需在这一处拦。

---

## 4. 内部页面 `bow://`

`shared/internalPages.ts` 是唯一权威:

```ts
INTERNAL_SCHEME = 'bow'
InternalPageId = 'settings' | 'terminal'
SETTINGS_URL = 'bow://settings'
TERMINAL_URL = 'bow://terminal'
INTERNAL_PAGES = {
  settings: { url, title:'设置', entry:'settings', singleton: true,  openIn: 'tab'  },
  terminal: { url, title:'终端', entry:'terminal', singleton: false, openIn: 'pane' }
}
parseInternalUrl(url)   // 只接受 bow://<id> 与 bow://<id>/,带路径/查询/其它 host 一律 null
opensInPane(id)         // openIn === 'pane' 的内部页面(终端):地址栏通路走「顶替聚焦窗格」
```

打开语义有**两根正交的轴**:

| 轴 | 取值 | 消费者 |
| --- | --- | --- |
| `singleton` | `true`(设置页)已存在则只聚焦 / `false`(终端)不查找已有标签 | `TabManager.openInternal()` |
| `openIn` | `'tab'` 新建标签(设置页) / `'pane'` **顶替当前聚焦窗格**(终端) | 地址栏通路 `TabManager.openUrl()` |

所以地址栏输入 `bow://terminal` **不新建标签、也不自己造分屏**:它把聚焦窗格的叶子换成新开的内部页面视图
(`spawn()` 一个带 preload 的 view + `replaceTabInGroups()` 换叶子 + `close()` 旧标签进关闭栈),
`Ctrl+Shift+T` 仍能找回被顶替的页面。聚焦窗格**已经是**该内部页面时什么都不做。

> ⚠️ 为什么不能 `navigate()` 过去:内部页面依赖应用 preload,而 preload 只能在 `WebContentsView`
> **创建时**给 —— 普通标签的 webContents 永远变不成内部页面(见下表「跨边界拒绝」那条)。

`TabManager.create(url)`(工具栏「新终端」按钮 / `Ctrl+Shift+T` 恢复)是更底层的入口,
**不受这两根轴影响**——它永远是新标签;MCP 的 `browser_navigate`/`browser_search` 只接受 http(s),同样不经过 `openIn`。

不变量:

| 规则 | 实现处 |
| --- | --- |
| 内部页面标签持有应用 preload,普通标签**绝不能**有 | `TabManager.create()` 的 `...(internalId ? {preload} : {})` |
| 内部页面标签只能载入同一内部 URL | `wc.on('will-navigate')` 阻止 + `TabManager.navigate()` 返回 false |
| 内部页面标签不登记内容注入(否则插件 `<all_urls>` 会注入到浏览器自己的 UI) | `create()` 里 `if (!internalId) pageTracker.track(wc)` |
| 内部页面不发布 `tab-navigated`(不进历史),URL 恒为对外 URL,不可前进后退 | `did-navigate` 分支 + `syncNavigation()` |
| 内部页面标签可以被**反查 tabId**(终端页据此把会话绑到标签上) | `ipcMain.handle('tab:self')` → `TabManager.findTabIdByWebContents(sender)` |
| 内部页面不计入「最近浏览标签」(`lastBrowsingId`)且不可后退 | `activate()` / `syncNavigation()` |
| 跨「内部 ↔ 普通」边界一律拒绝就地导航,必须另开标签 | `navigate()` 返回 false;`openUrl()` 判断后 `create()` |
| `openIn:'pane'` 的内部页面(终端)从地址栏打开时**顶替聚焦窗格**(不新建标签) | `openUrl()` → `openInternalInPane()`:`spawn()` + `replaceTabInGroups()` + `close(旧)` |
| 活动标签是内部页面时,MCP 的 `navigate`/`search` 另开标签并回 `createdTab:true` | `mcp.ts` 的 `target()` + `openUrl()` |

`TabManager` 里与内部页面相关的取值口径(容易记错):

| 方法 | 语义 |
| --- | --- |
| `getActiveView()` | 活动标签,**可能是内部页面** |
| `getActiveBrowsingView()` | 活动标签优先,若是内部页面则退到最近浏览的普通标签 |
| `getLastBrowsingView()` | 只认普通标签;记忆失效时回退为 **id 最大**的普通标签 |
| `activateLastBrowsing()` | 激活最近浏览的普通标签(设置页里点「屏蔽元素」时先用它切回去) |
| `openInternalInPane(page)` | `openIn:'pane'` 的页面(终端)**顶替聚焦窗格**打开;已是它 / 没有活动窗格 → `null`(不生效) |
| `broadcastToInternal(ch, payload)` | 只发给内部页面标签(普通标签没有 preload,收不到) |

---

## 5. 插件体系

### 5.1 两侧契约

插件是**仓库内编译期模块**,分主进程侧与渲染层侧两个文件,靠 `shared/plugins.ts` 的类型对齐:

| 侧 | 文件 | 默认导出 | 契约类型 |
| --- | --- | --- | --- |
| 主进程 | `src/plugins/<id>/main.ts` | `PluginMain` | `main/plugins/types.ts` |
| 渲染层 | `src/plugins/<id>/ui.ts` | `PluginUiContribution` | `renderer/src/plugins/types.ts` |

```ts
// 主进程侧
interface PluginMain {
  manifest: PluginManifest            // { id, name, description, version, core? }
  capabilities: PluginCapability[]    // 只是给 UI 显示的标签,不影响实际能力(见下 ⚠️)
  activate(ctx: PluginContext): void | Promise<void>
  deactivate?(ctx: PluginContext): void | Promise<void>
}

// 渲染层侧
interface PluginUiContribution {
  id: string
  slots?: Partial<Record<PluginSlot, Component[]>>   // 'addressbar-trailing' | 'toolbar'
  overlays?: PluginOverlayContribution[]              // { id: 'plugin:<pid>:<panel>', component, placement }
  settingsSections?: Component[]                      // 空数组 = 侧栏不出现该插件项
}
```

⚠️ `capabilities` 是**声明**,内核不据此做任何权限控制。`PluginCapability` =
`'ui'|'suggest'|'mcp'|'net'|'content'|'shortcut'|'service'`,中文标签在
`shared/plugins.ts` 的 `PLUGIN_CAPABILITY_LABELS`。写错 capabilities 只会让设置页标签不准。

### 5.2 `PluginContext` 全 API

内核为每个插件在激活时创建一份 `PluginContextImpl`,**通过它注册的一切都会自动登记 disposer**,
停用时逆序回收。插件因此不需要手写清理逻辑。

| 成员 | 签名 | 回收方式 |
| --- | --- | --- |
| `id` | `string` | — |
| `log` / `logError` | `(...args) => void` | 前缀 `[plugin:<id>]` |
| `storage<T>` | `({ file, defaults, compact? }) => PluginStorage<T>` | **不回收**(同一个 file 复用同一实例,进程内长期持有) |
| `ipc.handle` | `(method, fn) => void` | 移除路由;`invoke` 找不到路由即报错 |
| `ipc.emit` | `(event, payload?) => void` | 广播 `plugin:event` 到 chrome + overlay + 内部页面 |
| `events.on` | `(name, cb) => void` | 从订阅集合移除 |
| `events.emit` | `(name, payload?) => void` | 内核事件总线(**跨插件可见**) |
| `suggest.register` | `(provider) => void` | 从建议源数组移除 |
| `mcp.tool` | `(name, config, handler) => void` | `kernel.mcp.removeByPlugin(id)`(dispose 里显式调用) |
| `net.onBeforeRequest`<br>`net.onBeforeSendHeaders`<br>`net.onHeadersReceived` | `(hook) => void` | 从对应阶段数组移除 |
| `content.inject` | `(spec) => void` | 移除规则并 `removeInsertedCSS` 所有已注入 key |
| `content.refresh` | `(tabId?) => void` | 只重跑 CSS(不重跑 JS),用于规则变更后的即时反馈 |
| `pages.activeTabId/focus/execute` | `execute(tabId, code, {timeoutMs=10000})` | 不回收(内核持有) |
| `pages.openDevToolsTab` | `(frontendUrl, title?, activate?) => number` | 不回收(内核持有)。把 CDP 前端接进标签页(设备检查插件用)。参数是**已拼好的前端地址**:可能是 `@shared/devtools` 拼的 bow 自带那份,也可能是设备指定的 `https://…`(见 `device-inspect/shared.effectiveStrategy`);标签只允许 `devtools://` 或与入口同源的导航 |
| `tabs.list/getActive` | `() => TabInfo[] / TabInfo \| null` | 只读;数据源是 `TabManager` |
| `service.onMcpHttpReady` | `(cb) => void` | 订阅 `MCP_HTTP_READY_EVENT` |
| `service.mcpHttp.start/stop/restart/status` | 见 §6.5 | 内核持有监听;`stop()` 固定以 `source:'plugin'` 调用 |
| `service.activity.snapshot/onChange` | 见 §6.6 | `onChange` 的取消订阅进 disposer |
| `shortcuts.register` | `(HotkeySpec, handler) => void` | 从热键数组移除 |

⚠️ `PluginStorage` 只是 `JsonStore<T>` 的结构子集(`get` / `set(patch)` / `setRaw(value)`)。
`storage()` 以 **file 名为 key 缓存**,`compact` 以**首次请求为准**——两个插件用同一个文件名是错误用法。

### 5.3 生命周期与时序契约

```text
registerAll(modules)    注册校验:ID_RE=/^[a-z][a-z0-9-]*$/ 不合法 → throw;id 重复 → throw(启动即失败)
                        setDisabled(plugins.json 的 disabled) — 未知 id 被过滤掉,防历史残留
activateEnabled()       按注册顺序逐个 await activate()
activate(id)            new PluginContextImpl → await module.activate(ctx)
                        ├─ 成功:存入 contexts、registry.setActive(true)
                        └─ 抛错:ctx.dispose() 回收**已注册的部分**并记日志,**不影响其它插件**
deactivate(id)          await module.deactivate?(ctx) → ctx.dispose() → setActive(false)
setEnabled(id, enabled) 状态机;持久化 { disabled } → broadcast('plugins:changed')
                        └─ 停用时若当前浮层 id 以 `plugin:<id>:` 开头,自动关闭该浮层
```

要点:

- **activate 是异步的且按注册顺序串行**;`BUILTIN_PLUGINS` 的顺序(`history, bookmarks, cors, adblock,
  element-fullscreen, mcp-http`)因此决定了网络钩子链与建议源的稳定次序,不是任意顺序。
- `dispose()` 逆序执行 disposer,再 `removeRoutes(id)` + `mcp.removeByPlugin(id)`。
- 内核**不**为 `net` / `content` 调 `removeByPlugin`——它们的清理完全依赖 disposer。
- `deactivate` 里插件只应处理**自有非内核资源**(如 adblock 落盘 `blockedCount`、
  element-fullscreen 还原页面)。

### 5.4 七类扩展点与宿主

| 扩展点 | 宿主文件 | 关键行为 |
| --- | --- | --- |
| `ui` | `renderer/src/plugins/registry.ts` + `App.vue` / `OverlayApp.vue` / `SettingsPage.vue` | host 按「已启用插件」过滤后渲染;`collectSlot()` 决定同槽顺序 |
| `suggest` | `main/plugins/kernel.ts` 的 `suggest()` | 各源 provide → `mergeSuggestions` → `buildSuggestRows` |
| `mcp` | `main/plugins/mcpHost.ts` | 缓冲声明,attach 后补注册;支持热移除 |
| `net` | `main/plugins/netHooks.ts` | 三阶段链式;**cancel/redirect 短路后续钩子** |
| `content` | `main/plugins/contentHooks.ts` | 显式登记的 webContents 才注入;CSS 可按 URL 动态生成 |
| `shortcut` | `main/tabShortcuts.ts` → `kernel.handleHotkey()` | 核心快捷键未命中才轮到插件 |
| `service` | `main/plugins/mcpHttpHost.ts` | 内核持有监听,插件只做启停决策(`onMcpHttpReady`) |

#### `net` 细节

- `install()` **必须在任何窗口/视图创建前调用**(否则 chrome 窗口自己的请求不会被覆盖)。
- 独占 `session.defaultSession.webRequest` 的三个阶段;每个阶段把所有插件的钩子**按注册顺序同步执行**,
  单插件抛错只记日志、不中断其他插件。
- 钩子上下文 `NetHookContext` 每次都是**新对象**,`requestHeaders` / `responseHeaders` 做的是浅拷贝。
- `cancel()` → `callback({cancel:true})`;`redirect(url)` → `callback({redirectURL})`;两者都会短路。
- `onHeadersReceived` 阶段可改写 `statusLine`(CORS 插件靠它把预检的 404/405 覆盖成 200)。
- `pageUrl` 通过 `webContents.fromId(details.webContentsId).getURL()` 补齐 ——
  这是 `$third-party` / `$domain=` 的依据,**拿不到时按「不拦截」处理**。
- ⚠️ 生态影响:`Electron 的 webRequest` 与 `chrome.webRequest`(扩展 API)互斥,
  想在 bow 里跑 MV2 拦截型浏览器扩展的人需要先解决这个冲突(本项目自带 adblock 覆盖同类能力)。

#### `content` 细节

- **不用 `webContents.getType()` 区分视图**:Electron 44 下 `WebContentsView` 的 `getType()` 也返回 `'window'`,
  无法与 chrome 窗口区分,所以采用 `TabManager.setPageTracker({ track })` 显式登记。
- `runAt` 默认 `'dom-ready'`;`did-finish-load` 时只跑 `runAt:'did-finish-load'` 的规则。
- `refresh(tabId?)`:重新按当前 URL 应用 **CSS**(先移除同 `(wc, pluginId, specId)` 的旧 key,再插入);
  返回空串/undefined 表示本页不注入。adblock 靠它做「改规则立即生效」。
- `matchUrl(url, matches, excludeMatches)`:任一 matches 命中且**没有** excludeMatches 命中;
  `<all_urls>` 等价于 `*://…`(见 `shared/pluginMatch.ts` 的 `compileUrlPattern`)。

#### `suggest` 细节

- 上限 `SUGGEST_LIMIT = 9`(内核常量):非空 query 时首行固定是搜索建议,后面最多 8 条命中。
- 去重键 = `url ?? id`;**同 URL 冲突时 `priority` 大者胜**(书签 20 > 历史 10),同 priority 再看 score。
- 排序:score 降序 → `visitedAt` 降序。
- 空 query:只有历史源会返回(最近 limit 条,score=1),不插搜索行。

#### `shortcut` 细节

- `HotkeySpec = { key, code?, ctrl?, shift?, alt? }`;`matchHotkey` 要求修饰键**精确一致**,
  `code` 提供时优先按物理键匹配(非 QWERTY 布局兼容)。
- 顺序:主进程 `before-input-event` → `matchTabHotkey` 命中则处理;
  未命中才 `kernel.handleHotkey(input)`(按注册顺序,第一个命中就 return true)。
- 页面内聚焦时也生效,因为监听装在主进程的每个 webContents 上。

### 5.5 内核实现要点与不变式

`PluginKernel`(`main/plugins/kernel.ts`,510 行)持有的状态:

| 字段 | 作用 |
| --- | --- |
| `registry: PluginRegistry` | 纯逻辑图与启停状态(`main/plugins/core.ts`,可单测) |
| `mcp` / `mcpHttp` / `net` / `content` | 四类能力的宿主 |
| `stateStore` | `plugins.json`,`{version:1, disabled: string[]}` |
| `contexts: Map<id, PluginContextImpl>` | 每个插件一份 |
| `routes / subscribers / providers / hotkeys` | 内核侧的注册表(id 维度) |
| `storageCache: Map<file, JsonStore>` | 插件私有存储按文件名复用 |
| `broadcaster / uiHost / tabProvider / pageApi` | 由 `index.ts` 注入的运行时依赖 |

对外/对内方法:`registerAll` `list` `reserveMcpToolNames` `installHooks` `setBroadcaster` `setUiHost`
`setTabProvider` `attachMcpHttpDeps` `notifyMcpHttpReady` `setPageApi` `trackPage` `activateEnabled`
`activate` `deactivate` `setEnabled` `invoke` `routeOverlayEvent` `suggest` `handleHotkey` `storageFor`
`addNetHook` `addContentScript` `refreshContent` `addMcpTool` `broadcastPluginEvent` `tabs` `pages`。

不变式:

- `invoke(id, method, args)` 三重校验,分别抛「插件不存在 / 插件已停用 / 插件方法不存在」。
- `addRoute` 同一 `(id, method)` 重复注册直接抛错;`addMcpTool` 重名抛错且**预留核心工具名**。
- `emitEvent` 遍历订阅者的**快照**(`[...set]`),订阅者抛错被吞掉、只记日志。
- 停用的插件不参与 `suggest`、不提供 MCP 工具、不注入内容、不再收到网络回调(因为钩子已移除)。

### 5.6 边界约束(由测试强制)

`tests/pluginBoundaries.test.ts`(47 行)逐个插件目录做**源码文本断言**:

| 约束 | 断言 |
| --- | --- |
| `main.ts` 不得引用 `.vue` | `not.toMatch(/\.vue['"]/)` |
| `main.ts` 不得引用 `@renderer` | `not.toMatch(/@renderer/)` |
| `ui.ts` 不得引用 `electron` | `not.toMatch(/from ['"]electron['"]/)` |

原因:electron-vite 把 main / renderer 编成两个独立 bundle,跨界会把 `.vue` 或 electron 拖进错误的产物。

其它编译期约束:`tsconfig.node.json` 的 `include` **只收录** `src/plugins/*/main.ts`、
`shared.ts`、`picker.ts`、`scripts.ts` —— 新增这类脚本文件名必须同步登记,否则类型检查看不到它。

### 5.7 新增一个插件

1. 新建 `src/plugins/<id>/`:
   - `main.ts`:默认导出 `PluginMain`;只用 `ctx.*` 注册能力;`deactivate` 只处理自有资源。
   - `ui.ts`(+`ui/*.vue`):默认导出 `PluginUiContribution`;浮层 id 约定 `plugin:<id>:<panel>`。
   - `shared.ts` / `picker.ts` / `scripts.ts`:同构纯逻辑或注入脚本字符串(便于单测);
     **记得登记进 `tsconfig.node.json` 的 include**。
2. `src/main/plugins/builtin.ts` → `BUILTIN_PLUGINS`(注意位置:决定钩子与建议源顺序)。
3. `src/renderer/src/plugins/registry.ts` → `PLUGIN_UI`(要在某个槽里插队就同时改 `SLOT_PLUGIN_ORDER`,
   但**新插件一律默认追加到末尾**,不需要动)。
4. 渲染层调用:`window.browserAPI.plugins.invoke(id, method, ...args)`;
   订阅:`plugins.onEvent` / `plugins.onChanged`。

### 5.8 内置插件贡献矩阵

**主进程侧**

| id | core | capabilities | IPC 方法 | MCP 工具 | net | content | suggest | shortcut | events | 存储 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `history` | ✓ | ui, suggest | `list` `count` `remove(ids[])` `clear` `getSettings` `setSettings` | — | — | — | priority 10 | — | on `tab:navigated` `search:performed`;emit `changed` | `history.json` `history-settings.json` |
| `bookmarks` | ✓ | ui, suggest, mcp | `list` `add` `addFolder` `update` `remove` `move` `findByUrl` | `browser_add_bookmark` `browser_list_bookmarks` | — | — | priority 20 | — | emit `changed` | `bookmarks.json` |
| `cors` | — | ui, net | `getSettings` `setSettings` | — | `onBeforeSendHeaders`(记预检 id)+ `onHeadersReceived`(注入 ACAO/ACAM/ACAH,预检覆盖 statusLine) | — | — | — | emit `changed` | `cors.json` |
| `adblock` | — | ui, net, content, mcp | `getState` `listRules` `setEnabled` `resetCount` `addNetworkRule` `updateNetworkRule` `removeNetworkRule` `addCosmeticRule` `updateCosmeticRule` `removeCosmeticRule` `removeCosmeticFlag` `replaceUserRules` `importRules` `exportRules` `resetDefaults` `addSubscription` `removeSubscription` `setSubscriptionEnabled` `refreshSubscriptions` `pickElement` | `adblock_stats` `adblock_list_rules` `adblock_add_rule` `adblock_remove_rule` `adblock_set_enabled` `adblock_import_rules` `adblock_subscribe` `adblock_refresh_subscriptions` | `onBeforeRequest`(拦子资源,跳过 `mainFrame`) | `cosmetic`(动态 CSS, dom-ready)+ `mark`(打 `data-bow-adblock` 标记) | — | — | on `tab:navigated` `tab:closed` `tab:activated`;emit `changed` `pick-done` | `adblock.json`(compact) |
| `element-fullscreen` | — | ui, shortcut, mcp | `getState` `pickAndFullscreen` `exitFullscreen` | `browser_fullscreen_element` `browser_exit_fullscreen` | — | — | — | `Ctrl/Cmd+Shift+F` | on `tab:navigated` `tab:closed` `tab:activated`;emit `fullscreen-changed` `pick-done` | 无(纯内存) |
| `mcp-http` | ✓ | ui, service | `getState` `setSettings` `restart` `toggle` | — | — | — | — | — | on `mcp-http:ready`(经 `service.onMcpHttpReady`)+ `mcpActivity.onChange`;emit `changed` | `mcp-http.json` |
| `default-browser` | — | ui | `status` `register` `unregister` `openSettings` | — | — | — | — | — | — | 无(状态现读系统:Linux 读 `mimeapps.list`;Windows 先按 UserChoice 主键→备用键→`Software\Classes` 默认值读“记录”,再用 PowerShell 调 shell 的 `AssocQueryString` 拿“**实际生效者**”,两者不一致时以实际为准并标注记录已失效) |
| `device-inspect` | — | ui, mcp | `list` `open` `getSettings` `setSettings` `checkAdb` `connect` `pair` `cleanupForwards` `rawAdb` | `device_list_targets` `device_inspect` `device_eval` `device_screenshot` `device_connect` | — | — | — | — | — | `device-inspect.json`(adb 命令 / 前端策略 / 端口转发记录) |
| `terminal` | — | ui | `getSettings` `setSettings` `listCandidates` `attach` `write` `resize` `detach` | — | — | — | — | — | on `tab:closed`(按 tabId 回收 shell);emit `data` `exit` `settings-changed` `session-closed` | `terminal.json`(字体/字号/滚动缓冲 + shell 配置列表) |

**渲染层侧**(`registry.ts` / 各插件 `ui.ts`)

| id | `addressbar-trailing` | `toolbar` | overlays | settingsSections |
| --- | --- | --- | --- | --- |
| `bookmarks` | `StarButton` | `BookmarksButton` | `plugin:bookmarks:panel`(full,`BookmarksModal`) | — |
| `history` | — | — | — | `HistorySettings` |
| `cors` | — | — | — | `CorsSettings` |
| `adblock` | — | `BlockElementButton` | — | `AdblockSettings` |
| `element-fullscreen` | — | `ElementFullscreenButton` | — | — |
| `mcp-http` | — | `McpStatusBadge` | — | `McpHttpSettings` |
| `default-browser` | — | — | — | `DefaultBrowserSettings` |
| `device-inspect` | — | `DeviceInspectButton` | `plugin:device-inspect:panel`(full,`DeviceInspectPanel`) | —(adb 设置放在面板内的折叠区,不占设置页侧栏) |
| `terminal` | — | `TerminalButton` | —(终端是**内部页面**不是浮层:`bow://terminal`) | `TerminalSettings` |

⚠️ 终端插件的 `ui/TerminalView.vue` **不在**注册表里 —— 它是 `bow://terminal` 页面的主体,
由 `renderer/src/terminal/main.ts` 直接引用。插槽/浮层注册表面向的是 chrome 与 overlay 两个宿主。

`SLOT_PLUGIN_ORDER.toolbar = ['bookmarks','mcp-http','adblock','element-fullscreen','terminal']`;
`addressbar-trailing` 为空(保持注册顺序)。未列出的插件排在已列出者之后。

### 5.9 内核事件总线(全部事件名)

| 事件 | 发布者 | 订阅者 |
| --- | --- | --- |
| `tab:navigated` `{tabId,url,title}` | `TabManager` → `index.ts`(仅普通标签的主框架导航) | history, adblock, element-fullscreen |
| `tab:created` `{TabInfo}` | 同上 | (当前无) |
| `tab:closed` `{TabInfo}` | 同上 | adblock, element-fullscreen |
| `tab:activated` `{TabInfo}` | 同上 | adblock, element-fullscreen |
| `search:performed` `{url,query,title?}` | `ipc.ts` 的 `nav:go` 分支 | history |
| `mcp-http:ready` | `kernel.notifyMcpHttpReady()` | mcp-http |

⚠️ `tab:activated` / `tab:created` 的 payload **可能是内部页面标签**(设置页)。
插件若要读取 URL 必须自己判断;现有插件只拿 id 做状态清理,所以没受影响。

---

## 6. MCP 子系统

### 6.1 两种传输

| | stdio | HTTP |
| --- | --- | --- |
| 入口 | `npm run mcp` → `MCP=stdio` → `startMcpServer()` | `MCP_HTTP=1` 或 mcp-http 插件 → `startMcpHttpServer()` |
| 服务器实例 | **一个长连接实例** | **每个 HTTP 请求新建**(无状态) |
| 插件工具注册 | `kernel.mcp.attach(register)` 缓冲句柄,停用时可热移除 | 每个请求按 `kernel.mcp.listSpecs()` 快照重新注册 |
| 单实例锁 | 不参与(客户端子进程必须能独立启动) | 参与 |
| 日志 | 写 `<userData>/browser.log`(`--disable-logging` 关掉 Chromium stdout) | 写文件 |
| 对外 | `npm run mcp:install` 写进 pi 配置 | `http://127.0.0.1:8765/mcp`,可带 Bearer |

传输层可注入(`startMcpServer(deps, transport?)`),测试用 `InMemoryTransport` 免真实 stdio 与显示环境。

### 6.2 核心工具表(19 个)

所有核心工具经 `tool()` helper 注册:`inputSchema: z.object(shape).strict()`,处理器被
`mcpActivity.wrapTool(name, …)` 包一层。

| 工具 | 参数(粗体=必填) | 默认 | 返回体要点 |
| --- | --- | --- | --- |
| `browser_navigate` | **url**, tabId, waitUntil, timeoutMs | waitUntil `'load'`;timeout 15000 | `{ok,url,tabId,createdTab,waited?,loadedUrl?}`;非 http(s) 直接拒 |
| `browser_search` | **query**, engine, tabId, waitUntil, timeoutMs | engine 取设置;waitUntil `'load'` | 同上 + `engine` |
| `browser_eval` | **code**, tabId | — | `{ok,result}`;`undefined` → `result:null` |
| `browser_snapshot` | tabId, maxElements | 200(上限 1000) | `{ok,tabId,data:{title,url,elements[]}}` |
| `browser_wait` | tabId, selector, state, timeoutMs | state `'visible'`;等元素 10000 / 等加载 15000 | 有 selector → `{ok,tabId,selector,state,waited:true}`;无 → 走 `idle` |
| `browser_click` | **selector**, tabId, waitUntil, timeoutMs | waitUntil `'none'` | `{ok,tabId,selector,result,waited?,loadedUrl?}` |
| `browser_type` | text(**必填**), selector, clear, tabId | clear `true` | `{ok,tabId,typed,value}`;省略 selector = 当前聚焦元素 |
| `browser_press_key` | **key**, tabId, waitUntil, timeoutMs | waitUntil `'none'` | F5/Ctrl+R 强制等加载;Ctrl+W 关标签;Ctrl+T 开标签;其余走 `pressKey` |
| `browser_scroll` | **direction**, selector, amount, tabId | amount 0 → 一屏 70% | `{ok,tabId,top,direction}` |
| `browser_back` / `browser_forward` | tabId, waitUntil, timeoutMs | waitUntil `'load'` | 同一循环注册,`maybe-navigation` |
| `browser_stop` | tabId | — | `{ok,tabId}`,无等待语义 |
| `browser_reload` | tabId, waitUntil, timeoutMs | waitUntil `'load'` | `maybe-navigation` |
| `browser_new_tab` | url, activate, waitUntil, timeoutMs | activate `true`;waitUntil `'load'` | 无 url 时立即返回;带 url 时 `loadedUrl` 才是真实地址 |
| `browser_close_tab` | **tabId** | — | `{ok,closed}` |
| `browser_switch_tab` | **tabId** | — | `{ok,activate:true,tabId}` |
| `browser_list_tabs` | (空) | — | `{ok,tabs:[{id,url,title,loading,active,crashed,internal}]}` |
| `browser_screenshot` | tabId, fullPage | fullPage falsy | **image content**(`image/png`);失败才是 text |
| `browser_get_info` | tabId | — | `{ok,info:TabInfo}` |

插件工具 17 个:`browser_add_bookmark` `browser_list_bookmarks`(书签)、
`adblock_stats` `adblock_list_rules` `adblock_add_rule` `adblock_remove_rule` `adblock_set_enabled`
`adblock_import_rules` `adblock_subscribe` `adblock_refresh_subscriptions`(广告)、
`browser_fullscreen_element` `browser_exit_fullscreen`(元素全屏)、
`device_list_targets` `device_inspect` `device_eval` `device_screenshot` `device_connect`(设备检查)
—— 共 17 个,合计 **36** 个工具。

静态计数来源:`CORE_MCP_TOOL_NAMES`(19)+ `ctx.mcp.tool(...)` 的调用点
(`bookmarks/main.ts:136,161`、`adblock/main.ts:711,730,752,799,821,835,853,874`、
`element-fullscreen/main.ts:196,227`、`device-inspect/main.ts:381,421,438,461,481`)。
⚠️ 实际工具面**随插件启停变化**:停用 adblock 就少 8 个,停用 device-inspect 就少 5 个。

⚠️ 插件工具的 schema **不做 strict 校验**(走 `kernel.mcp` 声明快照),未知参数会被静默丢弃。

### 6.3 返回体与错误约定

- `{ok:false, …}` → `mcpResult.textContent()` 同时置 `isError: true`,调用方无需解析 JSON。
- `target(tabId?)` 是页面类工具的**统一取目标**入口,三类失败文案:
  `标签 N 不存在` / `标签 N 是浏览器内部页面,不支持页面操作` / `没有活动标签`。
  省略 tabId 且活动标签是内部页面时,退到最近浏览的普通标签;一个都没有则**新建 `about:blank`**
  (此时返回的 tabId 不是调用方预期的,以返回值为准)。
- `createdTab` 只在省略 tabId 且需要另开标签时为 true。
- 脚本里把失败放在 `result.error`(click/type/scroll 的注入函数这么做)会有 `ok:true` 的表象,
  由 `actions.ts` 的 `lift()` 统一提升为顶层失败。
- SDK 层校验失败(strict schema)的 `text` 是纯字符串 `MCP error -32602: … Unrecognized key(s) …`,
  **不是**项目的 `{ok:false,error}` JSON —— 写测试时别对它 `JSON.parse`。
- `MCP_INSTRUCTIONS`(mcp.ts 导出)随 `initialize` 下发,是 LLM 唯一必读的**行为契约**:
  返回体约定、推荐工作流、工具选型、边界。改工具语义时**必须同步改它**。

### 6.4 等待语义:`waitForLoad` 三模式

`actions.ts` 的 `waitForLoad(wc, {mode, timeoutMs, graceMs})`:

| 模式 | 结算条件 | 使用者 |
| --- | --- | --- |
| `idle` | 当前加载结束;**空闲立即返回** | `browser_wait`(无 selector) |
| `navigation{expectUrl}` | 导航到 expectUrl 并完成;**地址没到绝不结算** | `navigate` / `search` / `new_tab`(`loadFor()`) |
| `maybe-navigation` | graceMs 内无任何加载信号 → `waited:false` | click / F5 / reload / back / forward / press_key |

常量:`POLL_INTERVAL_MS = 120`、`NO_NAVIGATION_GRACE_MS = 1500`、默认 `timeoutMs = 15000`、
`EXEC_TIMEOUT = 10_000`、`DEFAULT_SELECTOR_TIMEOUT_MS = 10_000`。

**核心不变式:没观察到「本次」开始(`started`)就绝不结算。**
`started` 由「注册时已在加载」+ `did-start-loading` + `did-start-navigation`(`isMainFrame && !isSameDocument`)
+ `did-navigate` 置位;完成信号是 `did-finish-load` / `did-stop-loading`。
`sameUrl()` 比较时忽略 `#hash` 与末尾斜杠。

⚠️ 宽限值、以及「不能拿 `isLoading()===false` 判定本次导航成功」这两条,都是**真机赌输过**才写死的
(回归用例在 `tests/mcpWait.test.ts` 的「waitForLoad 竞态回归」,27 条)。

### 6.5 HTTP 服务与状态机

`main/mcpHttp.ts`:

- 路径固定 `/mcp`,方法 `POST` / `GET` / `DELETE`,其余 405;路径不符 404。
- 只监听 `127.0.0.1`(可被 `options.host` 覆盖,测试传 `port:0` 让系统分配)。
- `StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
  enableDnsRebindingProtection: true, allowedHosts: [...] })`
  —— `allowedHosts` 必须在拿到真实端口后才能确定,所以是**闭包变量**。
- 可选 Bearer:`Authorization === 'Bearer <token>'` 不满足 → 401。
- 每个请求 `createStatelessServer(deps)` 新建 server + transport,`res.on('close')` 时一起关闭。

`main/plugins/mcpHttpHost.ts` 的优先级模型:

| 概念 | 语义 |
| --- | --- |
| `owner: 'env' \| 'plugin'` | 谁起的监听。`source:'env'` = 环境变量强制模式 |
| `start(opts)` | **幂等**:已在跑直接返回状态;并发时用 `this.starting` Promise 串行化 |
| `stop({source})` | `owner==='env'` 且 `source==='plugin'` → **拒绝停止**,原样返回状态 |
| `restart(opts)` | `stop` 再 `start`;改端口/令牌时调用 |
| `status()` | `{ready, running, port?, url?, token?, forced?, error?}`;`forced = (owner==='env')` |
| `attach(deps)` | 由 `index.ts` 在标签就绪后注入 `{tabs, kernel}` |

`MCP_HTTP_READY_EVENT = 'mcp-http:ready'`。`index.ts` 的顺序即优先级:
`attach` → 环境变量强制启动 → `notifyMcpHttpReady()` 唤醒插件。

mcp-http 插件侧的补充行为:

- `onMcpHttpReady(() => start())` 之外,还**额外**检查 `status().ready` 立即 start 一次 ——
  因为「设置页先停用再启用」时 ready 事件不会重放,两条路径都幂等。
- `setSettings` 只在 `port`/`token` 真变了才 restart(避免打断已连接客户端)。
- `toggle`(MCP 状态灯点击)只停/启端点,**不动插件启用状态**,因此已声明的 MCP 工具仍在。
  端点停用只对**本次运行**生效,重启 bow 恢复默认开启。
- 端口归一 `normalizePort()`:非 1..65535 的整数回落到 8765。

### 6.6 MCP 活动跟踪

`main/mcpActivity.ts` 的**进程级单例** `mcpActivity`:

- 口径是**在途的工具调用数**,不是 HTTP 请求数。原因:StreamableHTTP 客户端会挂一条长驻 GET SSE 流,
  按请求计数会让「调用中」永远为真、状态灯钉死在蓝色。
- `wrapTool(name, fn)`:进入即 `inFlight++ / calls++ / lastTool=name`,无论返回/抛错/异步都保证离开
  (`Promise.resolve(fn()).finally(leave)`),避免异常路径把计数卡住。
- `snapshot() = { inFlight, calls, lastTool, lastAt }`;`onChange(cb)` 在进入/离开时各触发一次。
- 消费方:mcp-http 插件订阅后广播给渲染层,`McpStatusBadge` 据此在「白=就绪 / 蓝=调用中 / 灰=停用」之间切换。

---

## 7. 浏览器 UI 层

### 7.1 `window.browserAPI`(`src/preload/index.ts`)

contextBridge 暴露的唯一桥;`BrowserAPI` 接口是权威清单。

| 命名空间 | 成员 |
| --- | --- |
| 标签 | `createTab(url?, activate?)` `closeTab(id)` `restoreTab()` `activateTab(id)` `listTabs()` `getActiveTab()` `activateLastBrowsingTab()` `getSelfTabId()` |
| 导航 | `go(input)` `goUrl(url)` `back()` `forward()` `reload()` `stop()` |
| 设置 | `getSettings()` `setSettings(patch)` |
| 窗口 | `minimize()` `maximize()` `closeWindow()` `reportChromeHeight(h)` |
| 剪贴板 | `readClipboardText()` `writeClipboardText(text)`(走主进程 Electron `clipboard`,避开 renderer 侧的 secure context / 权限差异) |
| 标签组 | `getGroups()` `groupsActivate(groupId)` `splitPane(dir)` `resizePane(dir)` `groupsUngroup()`(后两条键盘入口在主进程,IPC 是渲染层兜底与 E2E 入口) |
| 分屏布局 | `getLayouts()` `saveLayout(name?)` `applyLayout(id)` `deleteLayout(id)`(只存结构;套用 = 在当前组后面新开一个标签组) |
| 浮层 | `showOverlay(content\|null)` `onOverlayEvent(cb)` `onOverlayShow(cb)` `overlayEmit(id,event,args)` |
| 插件 | `plugins.list()` `setEnabled(id,enabled)` `invoke(id,method,…args)` `overlayEvent(overlayId,event,args)` `suggest(input)` `onChanged(cb)` `onEvent(cb)` |
| 订阅 | `onTabUpdated` `onTabsChanged` `onTabActivated` `onSettingsChanged` `onFocusAddressRequest` `onWindowBlur` `onGroupsChanged`(均返回取消订阅函数) |

⚠️ `browserAPI` 也暴露给内部页面标签(设置页)与 Overlay;普通网页标签**没有** preload。

### 7.2 四个渲染入口

| 入口 | 文件 | 职责 |
| --- | --- | --- |
| index | `renderer/index.html` → `App.vue`(13KB) | 标签栏 / 工具栏 / 地址栏 / 插件插槽 / chrome 高度上报 |
| overlay | `renderer/overlay.html` → `OverlayApp.vue` | 按内容 id 从注册表渲染组件,回传 `overlay-event` |
| settings | `renderer/settings.html` → `SettingsPage.vue` | 左侧导航 + 右侧内容(常规 / 插件管理 / 插件分区) |
| terminal | `renderer/terminal.html` → `terminal/TerminalApp.vue` | `bow://terminal` 页面:xterm + node-pty 会话接线(视图组件在终端插件的 `ui/TerminalView.vue`) |

`App.vue` 关键机制:

- **chrome 高度上报**:`report()` 用 `getBoundingClientRect().height` 取整上报;
  `ResizeObserver` + `window.resize` + 挂载后 300ms 三重触发。
- **地址栏建议**:`onAddressInput` 100ms 防抖 → `api.plugins.suggest()` →
  `showOverlay({id:'suggest', payload, placement:'below-chrome'})`。
  `toPlainRows()` 深拷贝的原因是 **IPC 结构化克隆不能传 Vue 响应式代理**(分屏面板的 layouts 同理)。
- **标签栏按组渲染**:一项 = 一个组(`v-for="g in groups"`);多窗格组里**只有聚焦窗格**显示 `.tab-title`,
  其余窗格渲染 `.tab-pane-icon`(字母头像,点击切过去、中键关掉);`×` / 中键点项体 / `Ctrl+W` 都只关**聚焦那个窗格**。
  分隔条是 `v-for="d in activeGroupDividers"` 的 `.split-divider`,坐标直接吃主进程回传的 `dividers`(不重算)。
- **分屏面板**:工具栏「分屏」按钮打开 `{id:'split-menu', placement:'below-chrome'}`;
  chrome 是面板的 owner —— 它把 `panes/focusedTabId/layouts` 打进 payload,面板只回传
  `focus` / `save` / `apply` / `delete` / `ungroup` / `cancel`(与 suggest 同构)。
  两个刻意的细节:①`groups:changed` 到达、或保存/删除布局后要重推 payload;
  ②`pushSplitMenu()` 要 await 取数,而 `groups:changed` 的刷新可能晚于「套用布局后关面板」——
  所以用 `splitMenuSeq` 这个「代」计数作废过期结果(否则面板会被竞态重新弹出来)。
- **焦点策略**:`explicitFocus` / `selectOnFocus` 区分「显式聚焦(点击 / Ctrl+L / 新建标签)」与
  「窗口被动恢复聚焦」,只有前者才 `select()`。主进程 `chrome:window-blur` 会主动 `blur()` 地址栏,
  用于消除 Electron 把焦点恢复给地址栏的路径。
- **快捷键分工**:Ctrl+T/W/L/Shift+T/,/数字由**主进程** `tabShortcuts.ts` 拦截(页面聚焦时渲染层收不到按键);
  `Ctrl+Shift+方向` / `Alt+Shift+方向` 同样在主进程,但**只在聚焦的 webContents 属于普通网页标签时**才 `preventDefault`
  —— 地址栏 / 设置页 / 终端页 / DevTools 前端里的这些组合保持原样(按词选择、xterm 选择扩展、前端自己的快捷键);
  chrome 侧只保留 Ctrl+R。
- 标签关闭兜底:关掉最后一个标签时自动补一个 `about:blank`(与 `tabShortcuts.ts` 的 close 分支一致)。

`OverlayApp.vue`:注册表 = 核心 `{suggest: SuggestPanel, 'split-menu': SplitMenu, 'confirm-close': CloseConfirmModal}` + 已启用插件的 `overlays`;
组件契约 = `payload` prop + `band-top` prop + `overlay-event` emit。
`ModalShell.vue` 用模块级 `MODAL_STACK` 保证只有栈顶弹层响应 Esc(必须是模块级 —— `<script setup>` 顶层每实例执行一次)。

### 7.3 设置页

- 侧栏模型由 `shared/settingsNav.ts` 的 `buildSettingsNav()` 生成:
  `[常规, 插件管理]` + 「enabled && hasSections」的插件(保持 `PLUGIN_UI` 顺序)。
- 分区 id 约定 `plugin:<pluginId>`(`settingsSectionId()`);插件被停用/失去分区时自动回落到「插件管理」。
- 所有设置**即时保存**,没有保存/取消按钮。
- **常规**只有搜索引擎与主页(主页留空视为放弃修改)。**分屏宽度预设已取消** —— 分屏改成嵌套树,
  分隔比例由 `Alt+Shift+方向` 现场调,可复用的东西变成「布局」(只存结构)在工具栏分屏面板里保存/套用/删除。
- adblock 面板在设置页里点「屏蔽元素」会先 `activateLastBrowsingTab()`
  (`AdblockSettings.vue:453`)切回真实页面再进入框选 —— 因为框选脚本需要 http(s) 页面。
- **终端**分区:字体族 / 字号 / 滚动缓冲三个外观项 + shell 配置列表(名称/可执行文件/参数/工作目录,
  单选一套作默认)。「从预设添加」的候选由 `listCandidates` 给出(平台预设 + 在 PATH/常见路径里能否找到),
  参数与工作目录都即时保存;字号/字体改动经 `settings-changed` 广播,**已打开的终端立即跟随**。

---

## 8. 存储与数据文件

`main/stores.ts`:所有数据都在 `app.getPath('userData')` 下(被打包版与开发版共用,
因为 `applyBrowserIdentity()` 把 userData 钉在旧目录名 `mcp-browser`)。

`JsonStore<T>`:

- 原子写:`写 .tmp` → `renameSync`。
- 读取时**浅合并**默认值(对象型)或整体替换(数组型),JSON 坏掉时回退默认值。
- `{ compact: true }` → 单行 JSON(规则表这类大体积数据用,避免每次改动都 pretty-print)。
- 接口只有 `get()` / `set(patch)` / `setRaw(value)`。

| 文件 | 内容 | 默认值 | 所有者 |
| --- | --- | --- | --- |
| `settings.json` | 核心设置 | `{searchEngine:'google', homepage:'https://www.google.com', corsBypassEnabled:true, corsWhitelist:CORS_DEFAULT_LIST}`(历史版本里遗留的 `splitPresets` 键不再读写,原样留在文件里) | `stores.ts` |
| `split-layouts.json` | 保存的分屏布局(数组整体替换;`LayoutPreset[]`,只存结构) | `[]` | `stores.ts`(读写前一律过 `normalizeLayoutPresets()`) |
| `plugins.json` | 插件启停 | `{version:1, disabled:[]}` | `PluginKernel` |
| `bookmarks.json` | 书签树 | `[]` | bookmarks |
| `history.json` | 历史条目 | `[]` | history |
| `history-settings.json` | `{maxEntries}` | `{maxEntries:500}`(范围 1–100000) | history |
| `cors.json` | `{enabled, whitelist}` | 首次从 `settings.json` 的 `corsBypassEnabled/corsWhitelist` 迁移(幂等) | cors |
| `adblock.json` | `AdblockConfig v3`(compact) | 经 `migrateConfig()` 生成,默认值仅占位 `{version:0}` | adblock |
| `mcp-http.json` | `{port, token}` | `{port:8765, token:''}` | mcp-http |
| `device-inspect.json` | `{version, adbCommand, strategy, forwards[]}` | `{version:2, adbCommand:'', strategy:'auto', forwards:[]}`;`strategy` 三选一(`auto`/`electron-bundled`/`device-suggested`,见 `shared.effectiveStrategy()`;旧名 `device-bundled` 会被归一成 `device-suggested`);v1 → v2 只把默认值换成 `auto`;`forwards` 是端口转发记录(adb 侧的转发登记在 adb server 里,靠它回收) | device-inspect |
| `terminal.json` | `TerminalSettings` | `{version:1, defaultProfileId, fontFamily, fontSize:14, scrollback:5000, profiles[]}`;profiles 按平台给预设(powershell/pwsh/cmd/wsl/git-bash 或 $SHELL/bash/zsh);每次读写都过 `normalizeSettings()` 夹紧/去重/兜底 | terminal |
| `browser.log` | 日志(MCP 模式) | — | logger |

---

## 9. IPC 通道表

`invoke`(渲染层 → 主进程,`ipcMain.handle`):

| 通道 | 参数 | 返回 |
| --- | --- | --- |
| `tab:create` | url?, activate=true | `TabInfo` |
| `tab:close` | id | `{ok}` |
| `tab:restore` | — | `TabInfo \| null` |
| `tab:activate` | id | `TabInfo \| null` |
| `tab:list` | — | `TabInfo[]` |
| `tab:active` | — | `TabInfo \| null` |
| `tab:activate-last-browsing` | — | `TabInfo \| null` |
| `tab:self` | — | `number \| null`(调用方 webContents 所属的标签 id;不是标签页则 `null`。终端页用它把会话绑到 tabId) |
| `clipboard:read-text` | — | `string` |
| `clipboard:write-text` | text | `true` |
| `groups:get` | — | `TabGroupInfo[]`(`{id, tabIds, focus, panes, dividers}`;几何只给活动组算) |
| `groups:activate` | groupId | `TabGroupInfo[]`(激活该组**聚焦的**窗格) |
| `groups:split` | `PaneDir` | `TabGroupInfo[]`(在聚焦窗格上分屏并新建空白标签;键盘入口在主进程,这条供渲染层兜底与 E2E) |
| `groups:resize` | `PaneDir` | `TabGroupInfo[]`(朝该方向扩张聚焦窗格;到边界则不变) |
| `groups:ungroup` | — | `TabGroupInfo[]`(把当前组的 N 个窗格拆成相邻 N 个单标签组) |
| `layouts:list` | — | `LayoutPreset[]`(已归一化) |
| `layouts:save` | name? | `LayoutPreset[]`(当前组 ≥2 窗格才存;名字默认「布局 N」) |
| `layouts:apply` | id | `TabGroupInfo[]`(在当前组后面新开一个标签组) |
| `layouts:delete` | id | `LayoutPreset[]` |
| `nav:go` | input | `{parsed, query?, url?, tabId}`(**本地路径存在时经 `navInput.ts` 识别为 `file://`**) |
| `nav:url` | url | `{tabId}` |
| `nav:back` / `nav:forward` | — | `boolean` |
| `nav:reload` / `nav:stop` | — | `void` |
| `settings:get` | — | `Settings` |
| `settings:set` | patch | `Settings` |
| `ui:overlay` | `OverlayContent \| null` | `true` |
| `ui:overlay-event` | `OverlayEvent` | `true`(`confirm-close` 的 `confirm` 由 `closeConfirm.ts` 处理:置位后放行关闭;取消走通用 `close-request`) |
| `ui:chrome-height` | height | `true` |
| `plugins:list` | — | `PluginInfo[]` |
| `plugins:set-enabled` | id, enabled | `PluginInfo[]` |
| `plugins:invoke` | id, method, args[] | `unknown` |
| `plugins:overlay-event` | overlayId, event, args | `boolean` |
| `plugins:suggest` | input | `{rows, suggestions}` |
| `window:minimize` / `window:maximize` / `window:close` | — | `void`(≥2 标签时被 `closeConfirm.ts` 拦下,先弹确认框) |

`send`(主进程 → 渲染层):

| 通道 | payload | 发送处 |
| --- | --- | --- |
| `tab:updated` | `TabInfo` | `ipc.ts`(订阅 `tab-updated`) |
| `tab:list-changed` | `TabInfo[]` | `ipc.ts`(订阅 `tabs-changed`) |
| `tab:activated` | `id` | `TabManager.activate()`(直发 chrome,不经 broadcaster) |
| `groups:changed` | `TabGroupInfo[]` | `ipc.ts`(订阅 `groups-changed`;只发 chrome,面板数据由 chrome 组装) |
| `settings:changed` | `Settings` | `ipc.ts` 的 `settings:set` |
| `plugins:changed` | `PluginInfo[]` | `kernel.setEnabled()` 经 broadcaster |
| `plugin:event` | `{id, event, args}` | `ctx.ipc.emit()` 经 broadcaster。终端插件的 `data`/`exit`/`settings-changed`/`session-closed` 走的就是这条(终端页按 `args.tabId` 自过滤) |
| `overlay:show` | `OverlayShowMessage \| null` | `OverlayManager.send()` |
| `overlay-event` | `OverlayEvent` | `ipc.ts`(suggest 专用转发) |
| `chrome:focus-address` | — | `tabShortcuts.ts` 的 `focusAddressBar()` |
| `chrome:window-blur` | — | `index.ts` 的 `mainWindow.on('blur')` |

broadcaster 的投递面 = chrome + overlay + 内部页面标签(`tabs.broadcastToInternal`)。
⚠️ 普通网页标签收不到任何主进程消息(没有 preload)。

---

## 10. 环境变量

| 变量 | 读取处 | 语义 |
| --- | --- | --- |
| `MCP` | `logger.ts` | `='stdio'` → stdio 模式(不抢单实例锁、不开 HTTP 端点、日志进文件、`--disable-logging`) |
| `MCP_HTTP` | `logger.ts` | 非空且 `!=='0'` → 强制开启 HTTP 端点(owner=`env`,插件关不掉) |
| `MCP_HTTP_PORT` | `logger.ts` | 默认 `8765` |
| `MCP_HTTP_TOKEN` | `logger.ts` | 设置后 HTTP 必须带 `Authorization: Bearer <token>` |
| `ELECTRON_RENDERER_URL` | `rendererEntry.ts` | dev server 地址(electron-vite dev 注入) |
| `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` | `scripts/dist.mjs`、`ensure-electron.mjs` | 国内镜像;dist 会自动注入 |
| `BOW_ELECTRON` / `BOW_ELECTRON_ARGS` | `scripts/open-bow.mjs` | 覆盖 electron 可执行文件 / 追加参数 |
| `ELECTRON_BIN` | `scripts/mcp-smoke.mjs` | 冒烟测试用的 electron 路径 |
| `MCP_SMOKE_URL` | `mcp-smoke.mjs` | 设置后走 HTTP 而非 stdio(默认 `http://127.0.0.1:8765/mcp`) |
| `SMOKE_ALLOW_MUTATIONS` | `mcp-smoke.mjs` | HTTP 模式下必须为 `1` 才允许写操作 |
| `SMOKE_LD_LIBRARY_PATH` `SMOKE_ELECTRON_ARGS` `SMOKE_SHOT_PATH` `SMOKE_FULL_PAGE_SHOT_PATH` | `mcp-smoke.mjs` | Linux 库路径 / 额外参数 / 截图输出路径 |

⚠️ 绝不要在 shell 里写 `MCP_HTTP=1 electron .` 这种内联赋值(Windows 不认);
统一走 `scripts/open-bow.mjs` 或 `npm run mcp:http`。

命令行开关(不是环境变量,但同属启动契约,改动需同步本节与 §2):`--allow-file-access-from-files`
(本地页面之间可互访 → `<script type="module">` / `fetch` 在 `file://` 下可用)与 `app.setDesktopName(APP_DESKTOP_NAME)`
(Linux 桌面身份,必须与内置插件 `default-browser` 写出的 `.desktop` 基名逐字一致)。

---

## 11. 构建、测试、脚本

| 命令 | 做什么 |
| --- | --- |
| `npm run dev` | electron-vite dev(HMR) |
| `npm run build` | 只编译到 `out/`,**不产出可双击的应用** |
| `npm run dist` | `scripts/dist.mjs`:编译 + 注入镜像 + electron-builder + `verify-dist.mjs` 自检(**必须在 Windows 侧跑**) |
| `npm run typecheck` | `tsc --noEmit` 跑 `tsconfig.node.json` + `tsconfig.web.json` |
| `npm test` | vitest(`tests/**/*.test.ts`,node 环境,alias `@shared`/`@plugins`) |
| `npm run test:mcp` | 真机冒烟:自己拉起 MCP 模式浏览器跑关键流程 |
| `npm run test:mcp:http` | 连已常驻的 HTTP 浏览器 |
| `npm run mcp` / `mcp:http` | 经 `open-bow.mjs` 以 stdio / HTTP 模式启动 |
| `npm run mcp:install [-- …]` | 把 MCP 配置 + skill 写进 pi(幂等、可回滚、非 JSON 直接中止) |

> 桌面默认浏览器注册**不是脚本**,是内置插件 `default-browser`(设置页点一下;见 §5.8)。> 它把「写哪些文件 / 写哪些注册表项」放在 `src/plugins/default-browser/{linuxDesktop,windowsRegistry}.ts`
> (纯逻辑,可在 Linux 上单测 Windows 分支),I/O 与平台分发在 `registration.ts`。

关键脚本:

| 脚本 | 职责 |
| --- | --- |
| `open-bow.mjs` | 跨平台拼环境变量再 spawn electron(解决 Windows 无内联赋值);支持 `--dry-run`;首个参数精确为 `stdio`/`http` 才算模式,其余参数原序透传为「打开目标」 |
| `install-pi-mcp.mjs` | 写 `~/.pi/agent/mcp.json`(或 `--project`),支持 `--http` `--direct-core` `--direct-all` `--tool-prefix` `--no-skill` `--remove` `--dry-run`;`directTools` 核心 5 个 = `browser_navigate` `browser_snapshot` `browser_wait` `browser_click` `browser_eval` |
| `dist.mjs` | 打包(含镜像注入) |
| `verify-dist.mjs` + `lib/externalRequires.mjs` | 从 bundle 扫出运行时外部依赖(`require` / `from` / **动态 `import()`**),逐个核对是否进了 `app.asar`(缺一个就 `bow.exe` 一闪即退);终端插件的 node-pty 就是靠动态 import 惰性加载的,漏扫这一形式等于自检有盲区 |
| `ensure-electron.mjs` | postinstall:确保 electron 二进制就位(走镜像) |
| `mcp-smoke.mjs` | 真机冒烟(405 行) |
| `cors-test-server.mjs` / `cors-probe.html` | CORS 插件的人工验证环境 |
| `fetch-northbound.mjs` | 外网连通性探测 |

⚠️ `npm test` / `npm ci` 会打印两条 `npm warn Unknown project config "electron_mirror"`:项目 `.npmrc` 里的
`electron_mirror` 是给 electron / electron-builder 用的自定义键,npm 不认但不影响功能。**别去「修」它** ——
`scripts/dist.mjs:38` 与 `scripts/ensure-electron.mjs:33` 正是用正则从这个文件读镜像地址。

原生依赖(全局只有这一个:node-pty)

- node-pty 是终端插件用的**唯一**原生模块。1.1.0 的 npm 包自带 `prebuilds/win32-x64/{pty.node,conpty.node,conpty.dll,OpenConsole.exe}`
  等二进制,而且是 **N-API**(只 import `napi_*`,零 V8 / `NODE_MODULE_VERSION` 符号)→ 同一个文件
  在 Node 与 Electron 里都能加载:**不需要 `@electron/rebuild`,也不需要 VS C++ 工具链**
  (实测 Electron 44.4.3 / Node 24.21.0 直接 `require('node-pty')` + `spawn('cmd.exe')` 跑通)。
- prebuilds 只覆盖 **win32 与 darwin**(没有 linux 目录)→ WSL/Linux 里的安装会落到 `node-gyp rebuild`。
  所以终端功能的真机验收在 **Windows 侧**(`--user-data-dir` 隔离实例 + CDP 脚本)。
- 它的 install/postinstall 脚本**不需要跑**(prebuilds 已在包里);`package.json` 的 `allowScripts` 白名单里没有它。
- 打包:`build.asarUnpack` 里写了 `**/node_modules/node-pty/**`(`.node` / `.dll` 直接从 asar 里 dlopen 不稳),
  产物里落在 `resources/app.asar.unpacked/node_modules/node-pty/…`;`verify-dist.mjs` 会把 node-pty
  算进运行时依赖(它的 `await import('node-pty')` 是动态 import 形式,靠 `externalRequires` 认出来)。

测试约定:

- **纯逻辑必须放在 `shared/` 或插件的 `shared.ts`/`picker.ts`/`scripts.ts`**,这样 vitest 无需 Electron 环境。

- 主进程代码的测试靠三个假实现:`tests/fakeTabs.ts`(只实现 `mcp.ts`/`mcpHttp.ts` 真正调用的面)、
  `tests/fakeWc.ts`(WebContents 的等待/交互面)、`tests/fakeKernel.ts`(McpHost 对 mcp.ts 暴露的两条路径)。
  ⚠️ 给主进程加新的 `tabs.*` / `wc.*` 调用时**必须同步补假实现**,否则测试会红得莫名其妙。
- `tests/mcpServer.test.ts`(861 行)用 `InMemoryTransport` + 真实 `McpServer`/`Client` 握手,
  覆盖 instructions 下发、工具面与 schema、`waitUntil` 语义、失败一律 `isError`、内部页面边界、插件工具错误传播。
- **当前基线(2026-09-19 复测,地址栏终端顶替窗格 + Ctrl+Shift+L 改动后)**:`bun run test` → **39 个文件 / 730 个用例全绿**,约 3.7s。
  39 是 `tests/**/*.test.ts` 的文件数;`tests/` 下另有 3 个**测试替身**(不是测试):`fakeTabs.ts`、
  `fakeWc.ts`、`fakeKernel.ts`。

| 测试文件 | 行数 | 用例 | 测试文件 | 行数 | 用例 |
| --- | --- | --- | --- | --- | --- |
| `mcpServer.test.ts` | 861 | 59 | `mcpHttpHost.test.ts` | 159 | 11 |
| `adblock.test.ts` | 666 | 61 | `cors.test.ts` | 146 | 18 |
| `mcpHttpPlugin.test.ts` | 388 | 18 | `pluginRegistry.test.ts` | 115 | 9 |
| `mcpWait.test.ts` | 285 | 27 | `mcpActivity.test.ts` | 113 | 9 |
| `suggest.test.ts` | 283 | 32 | `mcpHttpService.test.ts` | 184 | 7 |
| `mcpHttp.test.ts` | 214 | 11 | `url.test.ts` | 105 | 11 |
| `history.test.ts` | 208 | 22 | `singleInstance.test.ts` | 70 | 6 |
| `shortcuts.test.ts` | 301 | 42 | `pluginUiSlots.test.ts` | 58 | 6 |
| `bookmarkTree.test.ts` | 198 | 14 | `internalPages.test.ts` | 81 | 11 |
| `pluginBoundaries.test.ts` | 47 | 3 | `elementFullscreenScript.test.ts` | 68 | 6 |

其余:`ua`(5)、`pluginMatch`(13)、`settingsNav`(4)、`modalStack`(3)、`bundleScan`(6)、
`adblockPickerScript`(4)、`elementFullscreenPlugin`(3)、`localFile`(6)、`navInput`(9)、`openArgs`(14)、
`defaultBrowser`(60)、`closeConfirm`(6)、`split`(50,嵌套分屏树 / 几何 / 原地换叶子 / 布局形状与归一化)、
`groups`(26,树版组记账 + 原地换叶子)、`terminalShared`(39,纯逻辑:设置规范化 /
平台预设 / spawn 参数 / 环境变量清洗 / 回放缓冲 / PATH 查找 / 参数文本 / 复制粘贴键位)。合计 **730**。

设备检查插件的三个测试文件(它们不在上表里:代码量不大,但每一条都在钉外部格式):

| 测试文件 | 行数 | 用例 | 铉住的是什么 |
| --- | --- | --- | --- |
| `deviceInspect.test.ts` | 565 | 49 | adb 输出格式、`/proc/net/unix` 列、`/json` 字段、前端 URL 形态、失败文案 |
| `deviceInspectTargets.test.ts` | 608 | 28 | 转发池(换端口重试 / 回收 / 中继挂掉要回收转发)、套接字探活自愈、整链路发现(假 adb + 假 HTTP) |
| `deviceInspectRelay.test.ts` | 237 | 12 | **真 TCP 链路**:带 Origin 的握手到设备侧时 Origin 已消失、首部之后双向透传、超限断开 |
| `deviceInspectCdp.test.ts` | 226 | 10 | 与**真实**本地 WebSocket 服务端对打:握手不带 Origin、id 匹配、超时、对端断开 |

---

## 12. 文档漂移审计(2026-09-17 核实)

**只报告,不改代码。** 每一条都已定位到具体行。修复时请把本表对应行删掉。

| # | 说法(位置) | 实际(位置) | 影响 |
| --- | --- | --- | --- |
| 1 | README:294 「`Ctrl+D` 收藏当前页」;`StarButton.vue:57` tooltip 也写「收藏当前页 (Ctrl+D)」 | **全仓库没有任何 Ctrl+D 处理**:`matchTabHotkey`(`shared/shortcuts.ts`)不认 `d`,`App.vue` 的 `onKeydown` 只处理 Ctrl+R | **该快捷键完全不可用**;页面聚焦时渲染层收不到按键,必须装进主进程 |
| 2 | README 「广告/追踪拦截是参考插件」 | `main/plugins/builtin.ts` 把 `adblock` 并入 `BUILTIN_PLUGINS`;`PluginRegistry.list()` 对所有插件硬编码 `builtin: true` | `PluginInfo.builtin` 无区分能力;措辞误导 |
| 3 | README 「Electron(≥ 33,…)」 | `package.json` = `electron: ^44.3.0`;`contentHooks.ts` 注释明确以 Electron 44 行为(44 下 `getType()` 无法区分 WebContentsView)为前提 | 升级/兼容判断会看错 |
| 4 | README 「tests/ vitest 单元测试(url 解析、内部页面、设置导航、书签树、历史、模糊建议、插件注册表/匹配/边界)」 | 实际 **31 个测试文件 / 493 个用例**(已实测),另有 `adblock` 61 例、`mcpServer` 59 例、`mcpWait` 27 例、`mcpHttp*`×3、`mcpActivity`、`bundleScan`、`singleInstance`、`ua`、`shortcuts`、`elementFullscreen*`×2、`modalStack` 等 | 低估了测试面 |
| 5 | README 扩展点表 6 行 | `PLUGIN_CAPABILITY_LABELS` 有 7 项,缺 `service`(后台服务;mcp-http 在用) | 新增服务型插件时找不到指引 |
| 6 | README 「数据存储」清单 | 缺 `<userData>/mcp-http.json`(MCP HTTP 端口/令牌) | 排查端点问题时少一处线索 |
| 7 | README 「手动使用快捷键」清单 | 缺 `Ctrl+数字`(1..8 切标签、9 取最后一个,`tabShortcuts.ts` + `switchIndexForDigit` 实现) | 少一条已实现能力 |
| 8 | README 「架构速览」的 src 树 | 未列 `main/mcpActivity.ts`、`main/mcpHttp.ts`、`main/tabShortcuts.ts`、`main/plugins/mcpHttpHost.ts`、`main/plugins/mcpResult.ts`、`renderer/src/lib/`、`shared/adblock.ts` 等 | 定位成本 |
| 9 | `FIX-PLAN.md`(仓库根) | 自述 P0/P1/P2 已全部实现,但仍留在根目录;里面的行号引用(如 `mcp.ts:133`)与当前 556 行的文件已不匹配;自述「288 passed」而当前实测为 **404 passed** | **历史文件容易被当成现状**,建议归档或加「已完成」抬头 |

### 文档未覆盖的重要行为(不是矛盾,是缺口)

- **书签一级目录不变量**:目录恒在根(`addFolder` 忽略传入 parentId);`move` 只允许目录→根、
  书签→根或根级目录,否则报错。激活时用 `flattenToSingleLevel()` 幂等迁移。
- **历史容量调整后立即裁剪**:`setSettings` 里 `trimHistory(store.get(), maxEntries)`,最旧优先。
- **CORS 预检识别**:`onHeadersReceived` 读不到请求头,只能靠 `onBeforeSendHeaders` 记 `requestId`;
  集合超过 5000 直接清空(防泄漏)。
- **adblock 的数量上限**:单条订阅最多 `MAX_RULES_PER_LIST = 100_000` 条规则;
  单页最多注入 `MAX_COSMETIC_SELECTORS = 2000` 条隐藏选择器(超出部分不注入,`unhide` 例外仍生效);
  规则列表分页 `RULE_PAGE_DEFAULT = 200` / `RULE_PAGE_LIMIT = 1000`;订阅拉取超时 `30_000ms`。
- **element-fullscreen 的两条入口语义不同**:IPC `pickAndFullscreen` 只作用于**活动标签**,
  活动标签是内部页会直接报「当前页面不支持」;MCP 工具则接受 `tabId`,省略时同样受限制、
  报错会建议显式传 `tabId`。
- **`browser_snapshot` 的选择器生成策略**:优先 `#id` → `data-testid/data-test/data-qa/name/aria-label/placeholder`
  属性 → 最多 4 层 `tag:nth-of-type(n)` 路径。选择器不稳定时改页面属性比调快照参数有效。
- **整页截图的设备像素上限** `MAX_FULL_PAGE_DEVICE_PX = 16_000`,CSS 上限 = 16000 / dpr;
  超限明确报错而不是返回错图(Chromium 在超过 GPU surface 尺寸时不报错而是返回内容重复的图)。

---

## 13. 已知坑与反模式(汇总)

**架构层**

1. 插件 `activate` 早于窗口/标签创建 → 需要 TabManager 的能力必须走 `onMcpHttpReady` 或惰性取 `ctx.tabs`/`ctx.pages`。
2. `NetHookHost.install()` / `setupDevTools()` / `setupTabShortcuts()` 都**必须在创建任何窗口/视图之前**调用。
3. 页面视图永远盖在 chrome 上 → 任何浮在页面上方的 UI 都必须走 OverlayManager,`tabs-changed` 时要 `raise()`。
4. 浮层 id 必须满足 `plugin:<pluginId>:<panelId>`,否则 `routeOverlayEvent` 路由不到插件。
   **核心浮层**(`suggest` / `split-menu` / `confirm-close`)反过来必须自己在 `ipc.ts` 开分支:
   `suggest` 与 `split-menu` 的事件要转发给 chrome(它们的 owner 是 chrome),
   而且这个转发**必须在通用 `close-request` 分支之前** —— 否则 chrome 收不到关闭事件、
   `showSuggest`/`splitMenuOpen` 这类本地开关会变脏。
5. **页面视图的可见性只在 `TabManager.layout()` 里设**。曾经在 `activate()` 里 `setVisible(vid === id)`,
   结果 `create(url, activate=false)`(MCP `browser_new_tab {activate:false}`)的后台标签视图
   (Chromium `views::View::visible_` 默认 true)会盖在当前页上。标签组把「可见集」从
   `{活动标签}` 扩成 `{活动组的可见窗格}`,别的什么都没变。
6. **`activate()` 不拆组**:新建标签 = 新建一个组(`insertNewGroup`),切标签 = 切到它所在的那个组。
   曾经分屏状态是全局单例、`activate()` 一见非成员就 `setSplit(null)` → 「新建 tab3 弄丢 tab1|tab2 的分屏」。
   组的记账规则(分屏/摘窗格/塌缩/拆组)全在 `@shared/groups` + `@shared/split` 的纯函数里,
   `TabManager` 只管数组/树 → 视图/事件。
7. 分屏组的**聚焦窗格**由 `wc.on('focus')` + `wc.on('input-event')` 双触发同步到 `activeId`
   (点击/滚轮/键盘进入哪个窗格,地址栏与导航就跟哪个);`activate()` 的 `activeId === id` 早退是防递归的关键。
   标签栏的「哪个窗格显示名字」、`Ctrl+W` 关哪个、面板里的当前组,全部看 `activeId` / `group.focus`。
8. **两个异步源会互相追尾**(分屏面板):`groups:changed` 触发的 `pushSplitMenu()` 要 await 取数,
   期间用户又套用了布局/点了取消 → 面板被关掉,随后**过期的刷新结果会把面板重新弹出来**。
   修法是 `App.vue` 里的「代」计数(`splitMenuSeq`):关面板时 +1,异步结果回来先比一代。
9. **小数缩放下的 ±1 px 是正常的**:显示器 125% 时 `getContentSize()` 是 DIP 整数,
   Chromium 把 view 的 DIP 边界舍入到物理像素后,渲染层的 `innerWidth` 可能比 `rect.width` 大/小 1。
   几何正确性的判据应该是 **DIP 层面铺满无缝隙/不重叠**(`dividers` 与 `panes` 互相印证),
   而不是逼页面自己报回完全相同的数字。
5. IPC 不能传 Vue 响应式代理(结构化克隆),`App.vue` 的 `toPlainRows()` 就是为此。
6. 内部页面标签持有 preload,**任何**让它能载入远程内容的改动都是安全漏洞(`will-navigate` 与 `navigate()` 双重拦截)。

**开发层**

7. `npm run build` 不等于产出可用的 exe;发布要 `npm run dist`(Windows 侧)。
8. 外部化依赖必须进 `app.asar` 的 `node_modules`,否则双击一闪即退;`verify-dist.mjs` 是守门人。
9. Windows 上不要用内联环境变量赋值,统一 `open-bow.mjs`。
10. stdio 实例不参与单实例锁 → 开新会话前先关掉旧的 stdio 实例。
11. 新增 `src/plugins/*/scripts.ts` 这类文件要登记进 `tsconfig.node.json` 的 include。
12. 靠正则扫源码判语义必须接受「数据字符串长得像代码」——`bundleScan.test.ts` 与
    `lib/externalRequires.mjs` 都是这条教训的产物。

**终端层(node-pty)**

18. ConPTY 下 `pty.kill()` 会 fork `conpty_console_list_agent` 去 `AttachConsole` 枚举控制台进程,
    而它在 GUI 进程里**必然失败**(每个终端一条 `Error: AttachConsole failed` 堆栈),兑底退化成 5s 超时后
    只 kill `innerPid` —— shell 里的子进程树(典型: `npm run dev`)可能留着占端口。
    插件因此在 win32 上先 `taskkill /PID <pid> /T /F` 再 `pty.kill()`(见 `plugins/terminal/main.ts` 的 `killTree`)。
19. **关闭标签会销毁该页面的 target**:之后再对它发 CDP `Runtime.evaluate` 会永远不返回(E2E 里
    改成断言 target 列表 + 插件侧 `write` 返回 false,不要去 eval 已销毁的页面)。
20. 终端页可能在任何时候失去会话(标签被关、插件被停用、shell 自己退出),这些都要经
    `session-closed` / `exit` 广播告诉页面 —— 不能指望 IPC 调用抛错来发现。
21. 终端页的 `Ctrl+W` / `Ctrl+L` 是**故意放行**给 shell 的(`@shared/shortcuts.releasesToTerminal`):
    主进程 `preventDefault` 过的按键渲染层收不到,xterm 无法把组合送进 pty。
22. 终端的**复制/粘贴也是自己接管的**(`ui/TerminalView.vue` 的 `attachCustomKeyEventHandler` +
    `@plugins/terminal/shared` 的 `matchClipboardKey`),两个不好踩的坑:
    ① **钩子返回 `false` 不会 `preventDefault`**(xterm `_keyDown` 里直接 `return !1`)——
       而 `Ctrl+V` 的默认动作是往它的隐藏 textarea 原生粘贴,且 xterm 在 **textarea 与 element 上都**
       挂了 `paste` 监听 ⇒ 不自己拦就会「原生粘一遍 + 我们 IPC 粘一遍」。
    ② xterm 的选区**画在 canvas 上、不是 DOM 选区**,菜单栏/右键触发的原生 `copy` 事件默认什么也复制不到,
       所以另在 `.terminal-host` 上监听 `copy`,自己把选区塞进 `clipboardData`。
    另两条语义细节:mac 上认 ⌘(`Ctrl+C` 在 mac 上仍是中断信号),**带 Alt 一律不接管**(AltGr 会编码成 Ctrl+Alt)。
23. **内部页面只能在 `WebContentsView` 创建时拿到 preload** ⇒ 「把当前标签导航成 `bow://terminal`」不可实现。
    「在聚焦窗格就地开终端」= `spawn()` 一个新内部页视图 + `replaceTabInGroups()` 换叶子 + `close(旧)`
    (地址栏 `bow://terminal` 走的就是这条路,旧标签进关闭栈可 `Ctrl+Shift+T` 找回);
    `TabManager.navigate()` 对跨「普通 ↔ 内部」边界一律拒绝,别为了这个去放宽它。
24. `releasesToTerminal()` 是**按 action 放行**的:`Ctrl+Shift+L`(`focus-address-anywhere`)必须与 `Ctrl+L`
    (`focus-address`)是两个不同的 action,否则会被一起让给 shell —— 而它存在的意义正是「终端里也能跳去地址栏」。

**MCP 层**

13. 别用 `sleep` + 重复截图探路;要等就用 `browser_wait` 或 `waitUntil: 'load'`。
14. `waited:false` 只表示「没观察到本次加载过程」,不代表失败。
15. 核心工具 strict 校验,插件工具**不** strict —— 写工具时要意识到这个不对称。
16. 改工具语义必须同步 `MCP_INSTRUCTIONS`(它才是 LLM 的行为契约)。
17. 延迟回复/竞态问题优先用「观察到本次开始」的判据解决,不要用固定宽限期赌(300ms 曾真机赌输)。

**环境层**

18. Linux 容器缺 `libasound.so.2` 时用 `LD_LIBRARY_PATH`;无 GPU 环境截图可能黑帧(功能本身正常)。
19. pi 的 bash 沙箱会拒绝 unix socket(连 X11/Wayland 都是 EPERM)→ `npm run dev` / `test:mcp`
    这类要开窗的命令请在沙箱外的终端跑。

**远端调试(设备检查插件)**

20. Chromium 的 DevTools 端点只对**带 `Origin` 头**的 WebSocket 握手做白名单校验
    (`devtools_http_handler.cc`);白名单**唯一**来源是 `--remote-allow-origins`,手机上加不了。
    ⚠️ **Android 上连「同源豁免」也不成立**:它的 devtools 服务在 unix 抽象套接字上,
    `server_ip_address_` 为 null → `is_same_origin` 恒为 false。所以「用设备自带前端凑同源」是错的
    (本项目早期计划里就是这么写的,已纠正)。正确做法 = **本地剥 Origin 的 TCP 中继**(`relay.ts`)。
21. 反过来,**Node 的 `WebSocket` 握手不带 Origin**(实测),所以主进程直连设备的 CDP 客户端不需要代理;
    中继只是为了让**浏览器页面里的前端**能连上。
22. 中继只改 HTTP 首部、之后纯字节透传 —— **不需要 WebSocket 帧编解码**,也就不需要 `ws` 依赖。
    实测(electron 44 + 一个「带 Origin 就 403」的假设备):前端经中继后 Elements/Console/Network 全部可用。
23. `adb forward` 登记在 **adb server 进程**里,bow 退出不会自动清 → 转发记录必须落盘并在下次激活时回收;
    且只回收**自己记录过的**那几条(用户手动建的 `adb forward tcp:9222 …` 不能动)。
24. 前端地址里的 `ws=` 参数**不能带 `ws://` 前缀**(devtools 前端自己会补),写错的表现是白屏;
    唯一的拼装处在 `@shared/devtools`。
25. 验证这类功能时注意 **`out/` 是旧产物**:`electron .` 加载的是 `out/main/index.js`,
    改完主进程代码不 `npm run build` 就会拿旧行为做实验(本人踩过:中继没生效,却以为是链路有问题)。
26. **DevTools 前端与设备的 CDP 版本必须对得上,否则面板会静默空白**。bow 自带的前端是 Electron 自带的
    那一份(`@shared/devtools`),它跟着 Electron 升级、可能比手机新好几代。最典型的例子:Chromium 152 的前端用
    `Storage.getStorageKey` 取 storage key(实验性命令,146 才出现,140 及之前只有 `getStorageKeyForFrame`),
    而 Application 面板的 Local storage / Session storage / IndexedDB **只**由 storage key 驱动
    (`DOMStorageModel` 靠 `StorageKeyManager.storageKeys()`,`IndexedDBModel` 靠 `StorageBucketsModel` 的
    `setStorageBucketTracking({storageKey})`)。旧设备上三个节点全空,但页面里数据都在 ——
    真机对照(WebView `Chrome/138.0.7204.179`):`Storage.getStorageKey` 报 *wasn't found*,
    而 `getStorageKeyForFrame` / `DOMStorage.getDOMStorageItems` / `IndexedDB.requestDatabaseNames` 都正常返回。
    这就是「bow 里看不到 indexeddb/localstorage、chrome://inspect 却能看到」的原因:chrome://inspect 拿的是
    **与设备版本一致**的前端 —— `devtools_http_handler.cc::GetFrontendURLInternal()` 要么给设备自带的
    `/devtools/inspector.html`,要么给 appspot 上 `serve_rev/<设备自己的 revision>` 那份。
    因此前端来源的默认值是 `auto`:设备 Chromium < 146 时用**设备指定的**那份(先探活,失败回退 bow 自带),
    否则用 bow 自带。判定与回退的唯一实现在 `plugins/device-inspect/shared.ts`(`effectiveStrategy` / `needsDeviceFrontend`);
    探活必须走 Electron `net`(Chromium 网络栈)而不是 Node `fetch` —— 后者不认系统代理,会把 appspot 误判成打不开。
27. **「端口连得上但服务不响应」通常是目标被系统冻结,不是端口问题**。Android 会冻结后台应用的进程:
    套接字还在、TCP 握手也能成,但 devtools 服务不应答(`/json` 超时/连接被关)→ `classifyFetchError` 归类为
    `port-unreachable`。因此 `problemHint('port-unreachable')` 先让用户「把应用切到前台/解开屏幕再刷新」,
    **只有 adb 确实是 `wsl …`(`isWslAdb`)时才提** WSL2 镜像网络 —— 本机 adb 是 Windows 原生 `adb.exe` 时那句提示是误导。
    验证这类功能时先 `adb shell input keyevent KEYCODE_WAKEUP` + `am start -n <pkg>/<activity>`,
    必要时 `adb shell svc power stayon true`(完事 `false` 还原):否则会出现「刚才还好、几秒后就超时」。
28. **`wsl adb` 拓扑下端口分配会错配(已知缺口)**。端口是 WSL 里 `bind(0)` 选的,而监听建在 Windows 的 adb server 上:
    WSL 挑中的端口可能落在 **Windows 的保留端口段**(Hyper-V/WSL 会占掉大段动态端口),Windows 侧 `adb forward`
    就绑不上(`cannot bind listener` / **10048**)。实测随机端口失败率约 30%,而插件只重试 3 次(≈2.7% 全败),告警文案是
    「端口转发失败」。可选修法:重试仍失败后**改用 `adb forward --list` 里已存在的同一个套接字的转发**
    (`shared.parseForwardList` 已写好但没有调用方 —— 它现在是诊断用;注意只是「借用」,不要去删用户手建的转发)。

**关闭窗口确认**(`main/closeConfirm.ts`,测试:`tests/closeConfirm.test.ts`)

29. 三条不变式:①只拦窗口不拦标签页(`Ctrl+W` / 标签 × 不受影响);
    ②`overlay.currentId === 'confirm-close'` 时再次触发关闭**必须放行** —— overlay 页面加载失败时
    遮罩画不出来、按钮点不到,不放行就再也关不掉窗口(这也是「第二次点关闭才生效」的原因);
    ③系统关机/注销在 Windows 走 `query-session-end`/`session-end`、Linux 走 SIGTERM,
    **不要**为此加 `before-quit` 拦截(那才会真的挡住注销)。
30. 计数口径是 `tabs.listTabs().length`(含 `bow://settings` 与 DevTools 前端标签),
    与「普通网页标签数」不是一个口径 —— 改判据时先想清楚哪一个是想要的。
    Bow 侧规避:改用与 bow 同侧的原生 adb(设置里填 Windows `platform-tools\adb.exe` 路径)。

---

## 14. 维护本文件

- 改以下任一内容时**必须**回来更新对应章节:核心工具表(§6.2)、`PluginContext` API(§5.2)、
  IPC 表(§9)、数据文件(§8)、环境变量(§10)、插件贡献矩阵(§5.8)。
- §12 的漂移项修掉后请删除该行;新发现的漂移请补进去(并附文件:行号)。
- 本文档刻意**不复制** README 的操作步骤(安装、部署、pi 接入配置),只写结构与契约;
  重复的内容必然漂移。
