# 在 bow 里做 chrome://inspect:调试手机 WebView / Chrome(device-inspect 插件)

> 状态:待评审。本计划**不写代码**,只描述改动与验证步骤。
> 调研日期 2026-09-18;依据全部来自直接读源码 / 官方仓库(不是转抄 README)。

## 0. 目标与结论

**目标(用户原话)**:「能用 bow 实现 chrome:inspect 吗?我想用 bow 来调试手机应用。」

**结论:能,而且不需要给 Chromium 打补丁** —— 但有一个必须先用真机验掉的硬前提(见 §5 Spike)。
拆成两件事:

| 能力 | 可行性 | 依据 |
| --- | --- | --- |
| 复刻 chrome://inspect 的**发现流程**(adb 设备 → devtools 套接字 → `/json` 目标列表) | ✅ 确定可行 | 纯 `adb` + HTTP,ws-scrcpy 就是这么做的(`docs/Devtools.md` 三步) |
| 复刻**调试器 UI**(Elements/Console/Network) | ✅ 大概率可行,1 个待验前提 | Electron 二进制里就有 `devtools://devtools/bundled/devtools_app.html`;electron#49465 的提问者原话「Loads devtools bundled with electron on browser window. **I use this to inspect remote targets with devtools protocol.**」,39.2.7 可用(40.0.0 回归后已修复) |
| 给 AI 用的 `device_*` MCP 工具(eval/截图/列目标) | ✅ 可行 | 与上面同一个 CDP 通道,主进程直连(Node 侧不经浏览器 Origin 策略) |

**已定决策(用户 2026-09-18 确认)**

1. 目标形态:**Android 应用里的 WebView/H5 页面** + **Android Chrome 标签页**(两者都走 CDP)。
2. bow 运行侧:**Windows 常驻 bow.exe**,手机插在 Windows(同时要支持无线调试)。
3. 交付形态:**标签页里打开真 DevTools UI**(第一阶段)+ **`device_*` MCP 工具**(第二阶段)。
4. adb 连接:USB 与无线调试都要用 → adb 可执行文件必须可配置 + 面板里给无线配对入口。

**本计划不含**:iOS(WebKit Web Inspector,协议不同)、Flutter Dart VM(非 CDP)、React Native 原生层(仅 Hermes/JS 侧可经 metro 间接接 CDP)。这些要在 UI 里明确写成「不支持」,避免用户空等。

---

## 1. 关键事实(已核实,附证据)

### 1.1 前端能加载:`devtools://` 三个不变式

- `src/main/devtools.ts` 只做「快捷键 + 永远 detach」,没有禁用其它 webContents 加载 devtools:// 页面的逻辑。
- Electron 二进制里存在 `devtools://devtools/bundled/devtools_app.html`(实测 `strings`/grep 命中),bundle 数据源由 `shell/browser/ui/devtools_ui_bundle_data_source.cc` 的 `BundledDataSource`(`GetSource() = chrome::kChromeUIDevToolsHost`)提供,`ShouldUseBundledFrontendResources()` 恒 `true` → **不依赖 CDN**。
- `url::SCHEME_RE` 那类短路事实:`shared/url.ts:39` 是 `if (SCHEME_RE.test(raw)) return { kind: 'url', url: raw }` —— 说明 **bow 地址栏今天就能直接打开 `devtools://…`**(不经过 `isHttpUrl` 限制)。这条既是 Spike 的零代码入口,也意味着这个能力不是新增攻击面(渲染进程发起的 `devtools://` 导航被 Chromium 自己拦掉)。

### 1.2 真实的风险点:CDP 端点的 Origin 白名单(唯一未定项)

Chromium `content/browser/devtools/devtools_http_handler.cc` 的 `OnWebSocketRequest`:

```cc
bool is_same_origin = server_ip_address_ && url::Origin::Create(
    GURL(base::StrCat({"http://", server_ip_address_->ToString()})))
        .IsSameOriginWith(GURL(request.GetHeaderValue("origin")));
if (request.headers.count("origin") && !is_same_origin &&
    !remote_allow_origins_.count(base::ToLowerASCII(request.headers.at("origin"))) &&
    !remote_allow_origins_.count("*")) { Send403(...) }
```

- `remote_allow_origins_`(`devtools_http_handler.h`)的**唯一**来源是命令行 `--remote-allow-origins`,Electron 二进制里也没有内建默认值 → 手机侧（`Android WebView` 用 `webview_devtools_remote_<pid>`,见 `android_webview/browser/aw_devtools_server.cc`;Chrome 用 `chrome_devtools_remote`)**无法加这个开关**。
- 一个 `devtools://devtools` 页面发起的 WebSocket 会带 `Origin: devtools://devtools`;已有人因为这个被拒:`pd4d10/debugtron#27`「Rejected an incoming WebSocket connection from the devtools://devtools origin」。
- 但 chrome://inspect 对 Android 一直是可用的 → 上面这条路径**要么被设备接受,要么存在我们没看到的放行分支**。**这一点无法靠读源码定论,必须真机测**(Spike 的第一项)。

### 1.3 有一条「同源豁免」的旁路(备选方案 M2)

注意 `is_same_origin` 比的是 **`http://<CDP 服务自己的地址:端口>`**。而 `adb forward tcp:P localabstract:<socket>` 之后设备那侧的 `/devtools/...` 资源是**可以经这个 TCP 端口取到**的(`ServerWrapper::OnHttpRequest` 里 `bundles_resources_` 分支 → `OnFrontendResourceRequest`)。于是:

> 把前端页面从 **`http://127.0.0.1:P/devtools/inspector.html?ws=127.0.0.1:P/devtools/page/<id>`** 加载 → 页面 Origin 恰好 = `http://127.0.0.1:P` = CDP 服务自己的 Origin → **天然同源,Origin 检查必过**,而且前端版本与设备完全匹配。

代价:依赖设备自身打包了前端资源;若设备(`HasBundledFrontendResources()` 为 false / 老版本)不提供,则回退 M1/M3。

### 1.4 现成的地基(改造面很小)

- `TabManager` 已经是「每标签一个 `WebContentsView`」(`src/main/tabManager.ts:137` `create()`),新增一个标签种类只是加个字段 + 几个分支。
- 插件的页面侧 API 已是**注入式**:`main/index.ts` 里 `kernel.setPageApi({ activeTabId, focus, execute })`,加一个方法即可,插件不用碰 electron。
- `tests/pluginBoundaries.test.ts` 按目录枚举插件,新插件自动被三条边界断言覆盖;`tests/pluginUiSlots.test.ts` 是纯函数测试,不受影响。

---

## 2. 文件清单与现状

### 2.1 需要修改的既有文件

| 文件 | 现状(实际读到的代码) | 改什么 |
| --- | --- | --- |
| `src/shared/types.ts` | `TabInfo` 只有 `internal?: boolean`,注释「内部页面标签(如 bow://settings)」 | 加 `inspector?: boolean`(DevTools 前端标签),注释写清与 `internal` 的关系:inspector 也 `internal: true`(不参与 MCP 页面操作),但**不给 preload、不拦导航、不登记内容注入** |
| `src/main/tabManager.ts` | `TabRecord { view, info, internalId }`;`create()` 里 `if (!internalId) this.pageTracker?.track(wc)`、`if (internalId) loadRendererEntry(...)`、`did-navigate` 里 `if (!internalId) this.emit('tab-navigated', …)`;`navigate()` 有「跨内部↔普通边界一律拒绝」的不变式;`close()` 进 `closedStack`;`activate()` 里 `if (!hit.info.internal) this.lastBrowsingId = id` | ① `TabRecord` 加 `kind: 'page' \| 'internal' \| 'inspector'`(用 kind 取代现在散落的 `internalId` 判空);② 新增 `createInspectorTab(wsUrl: string, title?: string): TabInfo` —— 无 preload、无 pageTracker、无 `tab-navigated`、不进 `closedStack`、不进 `lastBrowsingId`、标题不被 `page-title-updated` 覆盖;③ `syncNavigation()` 对 inspector 保留我们设的 `info.url`/`info.title` |
| `src/main/index.ts` | `kernel.setPageApi({ activeTabId, focus, execute })`(ready 后注入) | 加 `openDevToolsTab: (wsUrl, title) => tabs.createInspectorTab(wsUrl, title).id` |
| `src/main/plugins/types.ts` | `PluginPageApi { activeTabId, focus, execute }` | 加 `openDevToolsTab(wsUrl: string, title?: string): number`,注释说明「只用于把 `ws://` 目标接进 DevTools 前端;内核负责拼 `devtools://devtools/bundled/…`」 |
| `src/main/plugins/kernel.ts` | `EMPTY_PAGE_API`(第 65 行起)是三个方法的空实现 | 补第 4 个方法,`throw new Error('页面执行 API 尚未就绪')` 同款 |
| `src/main/mcp.ts` | `:133` `if (hit.info.internal) return { view: null, fail: '标签 N 是浏览器内部页面,不支持页面操作' }` | 文案改成中立(`浏览器自身页面(设置 / DevTools 前端)`);`browser_list_tabs`(`:494` `internal: !!t.internal`)保持,另透出 `inspector: true` |
| `src/main/devtools.ts` | `before-input-event` 对**每个** webContents 生效:`toggleDetachedDevTools(contents)` | 加一条 `if (contents.getURL().startsWith('devtools://')) return`(不 preventDefault):否则在远程 DevTools 前端标签里按 `Ctrl+Shift+I` 会给这个标签再开一个**本地** DevTools(套娃且无意义) |
| `src/main/plugins/builtin.ts` | `BUILTIN_PLUGINS = [history, bookmarks, cors, adblock, elementFullscreen, mcpHttp, defaultBrowser]` | 末尾加 `deviceInspect`(放末尾:不参与网络钩子/建议源次序) |
| `src/renderer/src/plugins/registry.ts` | `PLUGIN_UI = [bookmarksUi, …, defaultBrowserUi]` | 末尾加 `deviceInspectUi`;`SLOT_PLUGIN_ORDER.toolbar` 决定按钮位置(建议插在 `bookmarks` 之后,或先不动 = 排最后) |
| `tsconfig.node.json` | `include` 只收 `src/plugins/*/{main,shared,picker,scripts,registration,linuxDesktop,windowsRegistry}.ts` | 若新增 `adb.ts` / `targets.ts` 这类 I/O 文件,**必须登记**(否则 `npm run typecheck` 看不到它 —— 这是仓库文档明写的坑) |
| `docs/ARCHITECTURE.md` | §5.2 `PluginContext` 表、§5.8 贡献矩阵、§6.2 工具计数(**31** = 19 核心 + 12 插件)、§8 数据文件、§1 目录图 | 按 §14 的「维护本文件」规则同步;§12 顺手清掉与此相关的漂移 |
| `README.md` | §「MCP 工具一览」表格、§「插件体系」、§「数据存储」、§「环境注意事项」 | 加插件小节 + `device_*` 工具行 + `<userData>/device-inspect.json` + adb 前置条件 |
| `.pi/skills/bow-browser/SKILL.md` | `:8` 写「29 个工具」(已被 §12#10 记为漂移) | 顺手改成真实数字(插件加 4 个后 31→35;实际随启停浮动) |

### 2.2 新增文件

```
src/plugins/device-inspect/
  main.ts                    manifest(id: 'device-inspect')、capabilities: ['ui','mcp']
                             activate: ctx.ipc.handle(...) + ctx.mcp.tool(...)
                             deactivate: 停转发 + 摘掉 app 事件监听(自有的非内核资源)
  adb.ts                     adb I/O:探测可执行文件、devices/sockets/forward、超时、windowsHide
                             (需登记进 tsconfig.node.json)
  targets.ts                 HTTP I/O:GET /json、/json/version;转发生命周期(端口分配 + 回收)
                             (需登记进 tsconfig.node.json)
  cdp.ts                     最小 CDP 客户端(第二阶段):Runtime.evaluate / Page.captureScreenshot
                             (需登记进 tsconfig.node.json)
  shared.ts                  同构纯逻辑(可单测):解析 adb 输出、解析 /proc/net/unix、
                             改写 /json 目标、拼前端 URL、目标过滤与排序
  ui.ts                      { id, slots: { toolbar: [DeviceInspectButton] },
                               overlays: [{ id: 'plugin:device-inspect:panel', component: DeviceInspectPanel, placement: 'full' }],
                               settingsSections: [DeviceInspectSettings] }
  ui/DeviceInspectButton.vue 工具栏按钮(类 BookmarksButton)
  ui/DeviceInspectPanel.vue  设备/目标列表 + 「检查」+ 无线配对/连接 + 错误态引导
  ui/DeviceInspectSettings.vue adb 路径、自动刷新、手动清理转发、说明
tests/deviceInspect.test.ts  纯逻辑用例(见 §7)
```

插件 id 定为 `device-inspect`(kebab-case,符合 `ID_RE=/^[a-z][a-z0-9-]*$/`),显示名「设备检查(手机 WebView / Chrome)」,浮层 id 满足 `plugin:<id>:<panel>` 约定(否则 `kernel.routeOverlayEvent` 路由不到)。

---

## 3. 前端加载策略(Spike 之后的决策树)

`shared.ts` 暴露**纯函数** `frontendUrlFor({ strategy, forwardPort, targetId })`,三种策略:

| 策略 | URL | 何时用 |
| --- | --- | --- |
| `electron-bundled`(M1,默认首选) | `devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:P/devtools/page/<id>` | Spike 第一项通过就用它:前端是 bow 自带的,与 Electron 同版本,最稳 |
| `device-bundled`(M2) | `http://127.0.0.1:P/devtools/inspector.html?ws=127.0.0.1:P/devtools/page/<id>` | M1 被 403 / 白屏时;同源豁免,且版本与设备匹配 |
| `proxy`(M3) | `devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:<bowProxyPort>/devtools/page/<id>` | 前两条都不行时的兜底:bow 自己起一个 WS 代理,用**不带 Origin** 的 Node WS 连设备 |

M3 的实现代价(只有真需要才做):新增依赖 `ws`(客户端 + 服务端),代理同时提供 `/json`(聚合多套接字)与 `/devtools/page/*` 转发。到时必须同步:
`package.json` 的 `dependencies`、`scripts/verify-dist.mjs` 的自检(外部依赖必须进 `app.asar`)、`tests/bundleScan.test.ts` 的扫描口径。**决策依据只能是 Spike,不要预先开工。**

---

## 4. 目标发现与转发(第一阶段的实质内容)

1. **找 adb**:优先级 ① 插件设置里的路径(可填 `adb`、`C:\…\platform-tools\adb.exe`,也允许 `wsl adb` 这种前缀形式)② `PATH` 里的 `adb(.exe)` ③ 常见路径探测(Windows:`%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`、`C:\platform-tools\adb.exe`;Linux:`/usr/bin/adb`)。
   ⚠️ 调研时在 Windows 侧**常见路径都没找到 adb.exe**(本机 WSL 有 `/usr/bin/adb`),所以「设置里能填」是必需品,不是可选项。
2. **列设备**:`adb devices -l` → 解析 `serial / state(device|unauthorized|offline) / model / transport_id`。`unauthorized` 要在 UI 上明说「手机屏幕上点允许 USB 调试」。
3. **列套接字**:`adb -s <serial> shell cat /proc/net/unix`(ws-scrcpy 用的同一招)→ 取抽象命名空间里含 `devtools_remote` 的项:`webview_devtools_remote_<pid>`(= 某个 App 的 WebView)、`chrome_devtools_remote`(= Chrome);**排除** `webview_devtools_tethering_*`。
4. **按套接字转发**:`adb -s <serial> forward tcp:<P> localabstract:<name>`。端口由 bow 用 Node 绑 `0` 拿一个空闲端口再释放(避免固定端口冲突);`adb forward` 失败就换端口重试。
5. **拉目标**:`GET http://127.0.0.1:<P>/json` + `/json/version`。
   - `/json/version` 里有 Chromium 的 Android 专有字段 **`Android-Package`**(`devtools_http_handler.cc` 的 `version.Set("Android-Package", base::android::apk_info::host_package_name())`)→ 直接得到**所属 App 包名**,用它给套接字贴标签。
   - `/json` 里的 `webSocketDebuggerUrl` 是设备侧端口(`ws://localhost:9222/…`),**必须重写成我们的转发端口**;`devtoolsFrontendUrl` 一并改写(不用它,但要保证 UI 里复制出去的链接是对的)。
6. **无线调试**:面板里给两个入口 —— `adb connect host:port`(直接连)与 `adb pair host:port <配对码>`(Android 11+ 首次配对,需在手机「无线调试 → 使用配对码配对设备」对话框打开期间执行)。这两个只是多两行命令,不做自动发现(mDNS 不稳定,收益低)。
7. **转发的回收**:`adb forward` 登记在 **adb server 进程**里,bow 退出不会自动清 ——
   - 插件 `deactivate()` 与 `app.on('before-quit')` 里逐个 `adb -s <serial> forward --remove tcp:<P>`(同步 `spawnSync` + 2s 超时,避免退出被拖住);
   - 每次分配前把 `{serial, localPort, socket}` 写进 `device-inspect.json`,插件下次激活时先按这份记录清理一次(应对 bow 被强杀)。

---

## 5. 第一步:Spike(真机,做完再写插件)

**不改任何源码就能做掉第一项** —— 因为地址栏本来就接受任意 `scheme://`。

1. 手机开 USB 调试并授权;目标 App 打开 `WebView.setWebContentsDebuggingEnabled(true)`(debug 包默认开);或直接用 Chrome for Android。
2. 命令行(Windows,或能连到同一 adb server 的 WSL):
   ```bash
   adb devices -l
   adb shell cat /proc/net/unix | grep -a devtools_remote
   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
   curl http://127.0.0.1:9222/json        # 记下某个 id 与 webSocketDebuggerUrl
   ```
3. 在 bow 地址栏粘 M1 的 URL(把 `<id>` 换成上一步的):
   `devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:9222/devtools/page/<id>`

**Spike 要回答的三个问题(顺序即回退顺序)**

| # | 问题 | 通过判据 | 不通过怎么办 |
| --- | --- | --- | --- |
| S1 | Electron 44 的 `WebContentsView` 能不能加载 `devtools://` 前端并连上远端目标 | Elements 出现真实 DOM;Console 能执行表达式;Network 有请求 | 试 `inspector.html` 而非 `devtools_app.html`;再不行走 M2 |
| S2 | 设备的 CDP 端点接不接受 `Origin: devtools://devtools` | S1 通过即等于接受 | 改 M2(同源豁免,见 §1.3);M2 也 404 才做 M3 |
| S3 | 前端的关键交互是否可用(右键菜单、面板下拉、Console 输入、Device Toolbar) | 手动点一遍 | 只影响体验,不阻塞交付;记进计划文件与 ARCHITECTURE 的已知坑 |

判据 `S2` 的失败现象是可观测的:前端显示连接失败,且手机侧 `adb logcat | grep -i devtools` 会打出
`Rejected an incoming WebSocket connection from the devtools://devtools origin`(对照 `debugtron#27`)。

---

## 6. 分步实施(每步可独立验证)

| # | 步骤 | 触碰文件 | 验证 |
| --- | --- | --- | --- |
| 0 | **Spike**(§5),把结论记进本文件「Spike 结论」小节 | 无 | S1/S2/S3 三个判据 |
| 1 | `device-inspect/shared.ts` 纯逻辑 + `tests/deviceInspect.test.ts` | 新增 2 文件 | `npm test` 全绿(新增用例全过,既有 493 例不回归) |
| 2 | adb I/O:`adb.ts`(探测、devices、sockets、forward/remove)+ 登记 `tsconfig.node.json` | `src/plugins/device-inspect/adb.ts`、`tsconfig.node.json` | `npm run typecheck` 干净;临时用 `node`/单测跑解析函数 |
| 3 | 目标发现:`targets.ts`(端口分配、`/json`、`/json/version`、聚合) | 新增 | 真机:`plugins.invoke('device-inspect','list')` 能列出 WebView/Chrome 目标与包名 |
| 4 | 标签种类:`TabRecord.kind` + `createInspectorTab()` + `pages.openDevToolsTab` + MCP 文案 + `devtools.ts` 守卫 | `shared/types.ts`、`tabManager.ts`、`index.ts`、`plugins/types.ts`、`kernel.ts`、`mcp.ts`、`devtools.ts` | `npm test` + `npm run typecheck`;真机点「检查」弹出 DevTools 前端标签,标题/URL 正确,`Ctrl+Shift+T` 不会把它当普通标签恢复 |
| 5 | 转发生命周期:store 记录 + `deactivate`/`before-quit` 清理 + 启动恢复 | `main.ts` | 杀进程后重新打开 bow,旧转发被清(`adb forward --list` 无残留) |
| 6 | UI:工具栏按钮 + 「设备检查」浮层(设备/目标列表、检查、复制 ws、无线配对/连接、错误引导) | `ui.ts`、3 个 `.vue`、`registry.ts` | 真机走通「插线 → 点按钮 → 看到 App 的 WebView 页 → 检查」 |
| 7 | 停用能力:插件管理里停用 `device-inspect` 后转发被清、工具消失、按钮消失 | — | 设置页停用/启用各一次,`adb forward --list` 与工具列表都符合预期 |
| 8 | MCP 工具(§6.1)+ `MCP_INSTRUCTIONS` 增补 | `main.ts`、`mcp.ts` | `npm run test:mcp:http` 冒烟 + `device_list_targets` 真实返回 |
| 9 | 文档:README(插件小节/工具表/数据文件/adb 前置)、ARCHITECTURE(§1/§5.2/§5.8/§6.2/§8/§12)、SKILL.md 工具数 | 3 个文档 | 「文档漂移审计」不再新增条目;计数与实际工具面一致 |
| 10 | 真机回归:USB + 无线各走一遍;多设备、多 WebView 进程、未授权设备、目标 App 未开 WebView 调试 四种异常态 | — | 见 §8 验证清单 |

### 6.1 MCP 工具设计(第二阶段)

沿用仓库约定:名不与 `CORE_MCP_TOOL_NAMES` 冲突、返回 `{ok:…}`、失败 `isError: true`(`textContent` / `errorContent` / `imageContent` 从 `../../main/plugins/mcpResult` 引入,与 adblock/element-fullscreen 同款)。

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `device_list_targets` | `{serial?}` | 设备 + 套接字 + 目标(App 包名/title/url/type)。给 AI 的「先看清有什么」入口 |
| `device_inspect` | `{targetId, activate?}` | 在 bow 里打开该目标的 DevTools 前端标签,返回 `{ok, tabId}` |
| `device_eval` | `{code, targetId?, expression?}` | 经 CDP `Runtime.evaluate` 在设备页面执行 JS;省略 `targetId` 时用「唯一目标」或报错要求指定(不做隐式猜测) |
| `device_screenshot` | `{targetId?, fullPage?}` | CDP `Page.captureScreenshot` → `imageContent(pngBase64)` |
| `device_connect` | `{address}` | `adb connect`(无线);配 `device_pair {address, code}` |

`MCP_INSTRUCTIONS` 要补两段:①`device_*` 与 `browser_*` 的区别(前者作用于**手机**页面,后者作用于 bow 自己的标签);②`device_screenshot` 返回的是手机屏幕内容,不是 bow 的标签内容。

---

## 7. 测试(纯逻辑,放在 `shared.ts`)

`tests/deviceInspect.test.ts` 覆盖:

1. `parseAdbDevices`:`device` / `unauthorized` / `offline` / 网络串号(`192.168.1.5:5555`)/ `-l` 字段缺失。
2. `parseDevtoolsSockets`:`@webview_devtools_remote_12345`、`@chrome_devtools_remote`、`@chrome_devtools_remote_5678`,排除 `webview_devtools_tethering_12345_1`、去重、保序。
3. `rewriteJsonTargets`:设备侧 `ws://localhost:9222/devtools/page/X` → `ws://127.0.0.1:<P>/devtools/page/X`;`devtoolsFrontendUrl` 同步改写;不认识的字段原样保留;`/json` 不是数组时返回空列表而不是抛错。
4. `frontendUrlFor`:三种策略各一条断言;`ws=` 参数必须是 **host+path 且不带 `ws://` 前缀**(写错会白屏);目标 id 需要编码。
5. `targetsForDisplay`:过滤/排序(交互型 `page`/`webview`/`iframe` 在前,worker 类在后并可折叠)。
6. `planForwardRemoval` / 端口分配失败重试:给定 store 记录与当前端口占用,输出要执行的 `forward --remove` 命令列表。
7. `formatDeviceError`:四种异常态(无 adb / 无设备 / 未授权 / 无 devtools 套接字)各自给出可执行的下一步提示文案。

> 注意仓库既有坑:主进程新增 `tabs.*` / `wc.*` 调用会牵动 `tests/fakeTabs.ts` / `fakeWc.ts`,第 4 步若给 `TabManager` 加方法,`fakeTabs` 要同步补,否则测试会以莫名其妙的方式红。

---

## 8. 验证清单(真机,交付前跑一遍)

1. USB:`adb devices` 出现设备 → 面板列出 App 包名与 WebView 页 → 「检查」→ Elements/Console/Network 均可用。
2. 无线:`adb pair` + `adb connect` 后同一套流程可用;拔掉 USB 后无线仍能连。
3. 多设备同时插着:目标按设备分组,不串台。
4. 一个 App 有多个 WebView 进程:每个套接字单独一条,页面标题能区分。
5. 目标 App 未开 WebView 调试:面板给「未发现可调试 WebView 套接字 → 让开发在 Application.onCreate 里调 `WebView.setWebContentsDebuggingEnabled(true)`」而不是空白列表。
6. 设备 `unauthorized`:面板提示去手机上点「允许 USB 调试」。
7. bow 关闭再打开:`adb forward --list` 无本次遗留;旧转发记录被清理。
8. 停用插件:转发被清、按钮与工具消失。
9. 回归:`npm test` 全绿、`npm run typecheck` 干净、`npm run build` 成功;`npm run dist`(Windows 侧)自检通过(若加了 `ws` 依赖,重点看 `verify-dist`)。

---

## 9. 风险与未知

1. **【最高】S2 Origin 白名单**(§1.2):M1 可能被设备 403。回退顺序 M2 → M3 已经设计好,但 M3 会引入 `ws` 依赖 + 代理代码 + 打包自检的连带改动,是本计划**唯一可能膨胀的地方**。Spike 不通过就要把工期重估。
2. **【中】Electron 44 上 `devtools://` 在 `WebContentsView` 里的行为**只在 39.2.7 有「能用来调试远端目标」的公开证据(#49465),40.0.0 曾回归、后续修复。S1 必须亲自验;若 44 又坏,退路是 M2/M3(bow 自己的前端不需要 Electron 的 devtools:// 支持)。
3. **【中】远端前端的 `DevToolsHost` 绑定**:同源/devtools:// 页面在普通 `WebContentsView` 里可能缺原生菜单/保存文件等能力(devtools-frontend 会退回 `InspectorFrontendHostStub`)。影响体验不影响主流程,S3 记录实测结论。
4. **【中】Windows adb 位置未知**:调研时 `%LOCALAPPDATA%\Android\Sdk`、`C:\platform-tools`、scoop/choco 常见路径都没有 `adb.exe`,而 WSL 有 `/usr/bin/adb`(且本机 WSL **没有** `/dev/bus/usb`)。需要用户告知 Windows 侧 adb 在哪,或确认走「bow 调 `wsl adb`」这条路。→ **开工前请先确认这一条**。
5. **【中】`adb` 首次调用会拉起 adb server**,Windows 冷启动可能 3–10s;所有 adb 调用要有超时与「正在启动 adb…」状态,不能用固定 sleep 探路。
6. **【低】转发残留**:adb server 独立于 bow 进程;`--remove` 失败(设备已拔)时要忽略错误并清掉本地记录,避免记录无限增长。
7. **【低】devtools 前端标签的标题**:`page-title-updated` 会把标题覆盖成「DevTools」,我们打算改成「[检查] <页面标题> — <App 包名>」,因此该分支要跳过覆盖。
8. **【低】键盘冲突**:前端标签里 `Ctrl+Shift+I` 已被 §2.1 的 `devtools.ts` 守卫处理;`Ctrl+W` 关标签、`Ctrl+R` 由页面自己处理属预期行为,写进文档。
9. **【明确不做】** iOS / Flutter / RN 原生层(协议不同);面板里显式写「不支持」,不做半吊子引导。

## 10. 待用户确认的两个问题(开工前)

1. Windows 侧 `adb.exe` 的路径(或用 `wsl adb` / 已有一台常驻 adb server)? —— §9.4。
2. 第一阶段的「检查」按钮希望放在**工具栏**还是**设置页分区**(本计划默认工具栏 + 浮层,与书签一致)?

## 11. 实施记录(2026-09-18)

已落地(未提交):

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 1 纯逻辑 + 单测 | ✅ | `src/plugins/device-inspect/shared.ts` + `tests/deviceInspect.test.ts`(38 例) |
| 2 adb I/O | ✅ | `adb.ts`(含 `wsl adb` 复合命令支持),已登记进 `tsconfig.node.json` |
| 3 目标发现 | ✅ | `targets.ts`(转发池 / 探活自愈 / 失败归类)+ `tests/deviceInspectTargets.test.ts`(19 例,假 adb + 假 HTTP) |
| 4 标签种类 | ✅ | `TabRecord.kind: page\|internal\|inspector`、`createInspectorTab()`、`pages.openDevToolsTab`、`@shared/devtools` |
| 5 转发回收 | ✅ | `device-inspect.json` 落盘 + `before-quit` / `deactivate` / 下次激活三处回收 |
| 6 UI | ✅ | `DeviceInspectButton` + `DeviceInspectPanel`(设备/套接字/目标/无线配对/设置/失败指引) |
| 7 停用能力 | ✅(代码) | `deactivate` 回收转发并摘监听;待真机复验 |
| 8 MCP 工具 | ✅ | `device_list_targets` `device_inspect` `device_eval` `device_screenshot` `device_connect` + `MCP_INSTRUCTIONS` 同步 |
| 9 文档 | ✅ | README / ARCHITECTURE(§1 §5.2 §5.8 §6.2 §8 §11 §13)/ SKILL.md 计数 |
| 0 Spike(真机) | ⏳ **未做** | 见 §12 |
| 10 真机回归 | ⏳ **未做** | 见 §12 |

自动化验证:`npm test` → **34 文件 / 560 用例全绿**;`tsc --noEmit`(node + web)干净;`npm run build` 成功。

## 12. Spike 结论与验证记录(2026-09-18,均实测)

### S1 — Electron 44 能不能在普通窗口/视图里跑远端 DevTools 前端:**能(已证)**

独立 spike(`/tmp/spike`,一个只做两件事的 Electron 应用:开一个 `BrowserWindow` 当目标 + 另一个
`BrowserWindow` 加载 `devtools://devtools/bundled/devtools_app.html?ws=…`):

- 前端加载无 `did-fail-load`;`document.title` 变成 `DevTools - <目标页 URL>`(F12 目标信息只有真连上才有);
- 穿透 shadow DOM 探测:Elements / Console / Network / Sources 四个面板全在,无连接错误;控制台里出现
  前端发出的 CDP 命令(`protocol_client.js` 的 `Autofill.enable`);
- 结论:`SPIKE_RESULT FRONTEND_USABLE`。
- 附带发现:前端跑在 **stub host 模式**(`DevToolsHost` 未定义、`InspectorFrontendHost` 存在)——原生右键菜单/
  文件保存这类集成会降级,属 S3 体验项,不影响主流程。

### S2 — 设备侧 Origin:**手机无法放行,所以由 bow 代理(已证)**

- 对照实验:目标**不带** `--remote-allow-origins` 时,前端被拒,目标侧日志:
  `Rejected an incoming WebSocket connection from the devtools://devtools origin`(`devtools_http_handler.cc:831`)。
- **重要更正**:原计划的退路 M2(用设备自带前端凑同源)**在 Android 上无效** ——
  它的 devtools 服务在 unix 抽象套接字上,`server_ip_address_` 为 null,`is_same_origin` 恒为 false。
- **实际采用的方案 M3-light**:`relay.ts` —— 本地 TCP 中继,只把握手首部的 `Origin` 头删掉再转发,之后纯字节透传。
  **不需要实现 WebSocket 帧编解码,也不需要 `ws` 依赖**(这正是它比「本地 WS 代理」好的地方)。
- 对照实验(同一个目标不 allowlist + 中继):`RELAY_WORKS`,前端可用。

### 在真实应用里端到端跑通(假手机 + 假 adb,不需要真机)

做法:写一个**「任何带 Origin 的握手一律 403」的假设备端点**(精确模仿 Android 的策略)+ 一个假 `adb`
(只实现 `version` / `devices -l` / `shell cat /proc/net/unix` / `forward`),把插件设置指向假 adb,
再用 MCP 客户端驱动真实应用(`npm run build` 后的 `out/` 产物):

| 验证项 | 结果 |
| --- | --- |
| `device_list_targets` | 拿到设备 `FAKE123` / 套接字 / **包名 `com.example.fake`**(来自 `/json/version` 的 Android-Package)/ targetKey |
| `device_eval` | `{"ok":true,"result":"来自假设备: document.title"}` |
| `device_screenshot` | 返回图片内容(96 字节 PNG) |
| `device_inspect` | 开出真前端标签:`devtools://…devtools_app.html?ws=127.0.0.1:<中继端口>/devtools/page/FAKE1`,标题 `[检查] 假设备上的 H5 页面 — com.example.fake` |
| `browser_list_tabs` | 该标签 `internal: true, inspector: true`(不会被页面类工具当成可操作页面) |
| 端口拓扑 | `adb forward` 用 43458,**中继 45222 才是对外端口** |
| 假设备日志 | **0 次 REJECT**;而且看到前端启动的完整 CDP 序列(`Network.enable` / `Page.enable` / `Runtime.enable` / `DOM.enable` / `CSS.enable` / `Debugger.enable` / `DOM.getDocument` …) |
| 退出清理 | `adb -s FAKE123 forward --remove tcp:43458` 已执行 |

### 仍需真机确认的只剩「环境类」两项

1. bow.exe 在 Windows 下能不能驱动 adb 到手机(已支持 `wsl adb` 复合命令;仍需确认 PATH/镜象网络);
2. 目标 App 是否真的开起了 WebView 调试(`setWebContentsDebuggingEnabled(true)`)。

代码路径本身已无可疑点:发现的每一步、中继、CDP 客户端、前端启动、标签标记与回收都有实测证据。

### S3/S4 备注

- S3(前端交互完整度):stub host 模式下右键菜单/文件保存可能降级 —— 真机看一眼即可,不影响主流程。

### 事后补充(2026-09-18,用户真机反馈「Application 面板看不到 IndexedDB/localStorage」)

原 Spike 只验了 Elements / Console / Network / Sources **四个面板**,漏了 Application —— 而它恰恰是最容易
被版本 skew 打死的一个。结论:**bow 自带前端(Electron 44 = Chromium 152)在旧设备上取不到 storage key**:
前端用 `Storage.getStorageKey`(146 才有;140 及之前只有 `getStorageKeyForFrame`),而 Local storage /
Session storage / IndexedDB 三个节点只由 storage key 驱动。用户设备是 WebView `Chrome/138.0.7204.179`,
所以三个节点全空;`chrome://inspect` 能看是因为它拿的是与设备版本一致的前端。
修复:前端来源默认改为 `auto`(见 `shared.effectiveStrategy`)。完整证据链与实施步骤见同目录
`device-inspect-storage-panel.md`。

> 教训:**验远端调试的前端不能只挑几个面板点一下**;至少要扫一遍面板列表,并拿一台「比 Electron 落后若干代」
> 的设备当另一个数据点。
- S4(跨 WSL 端口可达):中继→`adb forward` 那一跳仍依赖 WSL2 镜像网络,提示语已直接点名。


### 一个已知未做的事

`device-inspect` 的 `activate()` 会在后台回收上次残留的转发,但**不阻塞**激活。如果上一次 bow 是被强杀
且当时有转发,第一次打开面板时可能看到「端口被占」类提示 —— 再点一次刷新即可(转发池会在失败后换端口重试)。
真机上如这个观感不好,可改成“面板首次打开时先 await 一次 cleanup”。
