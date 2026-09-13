# MCP Browser — AI 可操纵的简易 Electron 浏览器

多标签页浏览器:地址栏搜索(输历史/书签实时模糊建议)、浏览历史、书签(文件夹分组)、设置页(内部标签页 `bow://settings`);内置 **MCP 服务器(stdio)**,AI 编码工具(pi / Claude Code / Cursor 等)可以实时操纵这个浏览器:导航、搜索、点击、输入、滚动、切换标签、截图、读取页面快照。

## 技术栈

- Electron(≥ 33,WebContentsView 每标签一实例)+ TypeScript
- Vue 3 + Vite(electron-vite 组织 main / preload / renderer 三端)
- `@modelcontextprotocol/sdk`(stdio transport)

> 对外签名:网站收到的 User-Agent 为 `bow/<版本>`(无 `Electron/` 与应用名令牌);
> `Sec-CH-UA` / `navigator.userAgentData` 保持 Chromium 原生(与 Chrome 一致,不做剥离)。
> 应用显示名为 bow,userData 数据目录仍为 `mcp-browser`,既有书签/历史/设置不受影响。

## 启动

```bash
npm install
npm run dev        # 开发(HMR)
npm run build      # 构建到 out/
npm run mcp        # 构建后以 MCP 模式启动(供 AI 工具以子进程方式拉起)
npm test           # 单元测试
npm run typecheck  # 类型检查
```

## 给 AI 工具配置 MCP

以本地 stdio 方式接入。假设项目路径为 `$PROJECT`:

- **Claude Code**
  ```bash
  claude mcp add --transport stdio browser -- bash -lc "cd $PROJECT && npm run mcp"
  ```
- **其他支持 MCP 的工具**(如 pi / Cursor):在 MCP 配置里添加服务器
  ```json
  {
    "mcpServers": {
      "browser": {
        "command": "npm",
        "args": ["run", "mcp"],
        "cwd": "$PROJECT"
      }
    }
  }
  ```

MCP 模式下浏览器窗口照常弹出,AI 的所有操作你都能实时看到。AI 断开连接后浏览器保持运行,可继续手动使用。

## MCP 工具一览

| 工具 | 说明 |
| --- | --- |
| `browser_navigate {url}` | 当前标签跳转(仅 http/https) |
| `browser_search {query, engine?}` | 用默认或指定引擎搜索 |
| `browser_eval {code, tabId?}` | 在页面上下文执行任意 JavaScript,返回最后一个表达式的值 |
| `browser_snapshot {tabId?, maxElements?}` | 页面可操作元素快照(title/url + 可点击输入元素列表,含稳定 CSS 选择器) |
| `browser_click {selector, tabId?}` | 点击元素(注入真实事件序列) |
| `browser_type {selector?, text, clear?, tabId?}` | 输入文字(React 兼容),省略 selector 输入到当前聚焦元素 |
| `browser_press_key {key, tabId?}` | 按键:Enter / Tab / Escape / ArrowDown / Ctrl+W / F5 等 |
| `browser_scroll {direction, selector?, amount?, tabId?}` | 滚动页面或元素 |
| `browser_back / forward / reload / stop` | 历史导航(可选 tabId) |
| `browser_new_tab {url?, activate?}` | 开新标签 |
| `browser_close_tab {tabId}` / `browser_switch_tab {tabId}` / `browser_list_tabs` | 标签管理 |
| `browser_screenshot {tabId?}` | 当前页面截图,以 PNG 图片内容返回给 AI |
| `browser_get_info {tabId?}` | 当前标签标题 / URL / 加载状态 |
| `browser_add_bookmark {title?, url, folderId?}` / `browser_list_bookmarks` | 书签维护(由「书签」插件提供) |
| `adblock_stats` | 广告/追踪拦截统计(由「广告/追踪拦截」插件提供) |
| `adblock_list_rules / adblock_add_rule / adblock_remove_rule / adblock_set_enabled` | 广告规则增删查与开关(由「广告/追踪拦截」插件提供) |
| `adblock_import_rules {text, replace?}` | 按 AdGuard/EasyList 常用语法批量导入规则(由「广告/追踪拦截」插件提供) |

典型 AI 工作流:`browser_new_tab` → `browser_search` → `browser_snapshot` 找到结果链接的选择器 → `browser_click` → `browser_screenshot` 确认 → `browser_type`/`browser_click` 填表。

## 手动使用快捷键

- `Ctrl+T` 新标签、`Ctrl+W` 关闭、`Ctrl+Shift+T` 恢复
- `Ctrl+L` 聚焦地址栏、`Ctrl+R` 刷新、`Ctrl+,` 打开设置(设置是内部标签页 `bow://settings`,重复打开只聚焦已有标签)
- `Ctrl+D` 收藏当前页
- `Ctrl+Shift+I` / `F12`:为**当前聚焦的视图**(页面 / 浏览器 UI)打开或关闭 DevTools。
  DevTools 固定以**独立窗口**打开(不会停靠、也不会被标签页遮挡);焦点在 DevTools 窗口内时,
  按同一快捷键可关闭它。

## 数据存储

- 书签(「书签」插件):`<userData>/bookmarks.json`
- 浏览历史(「浏览历史」插件,默认保留最近 500 条,可在「设置页 → 浏览历史」调整,按 URL 去重):`<userData>/history.json`;保留条数配置:`<userData>/history-settings.json`
- CORS 放行配置(「CORS 放行」插件,首次启动从 `settings.json` 迁移):`<userData>/cors.json`
- 广告拦截配置与计数(「广告/追踪拦截」插件,含网络规则与元素规则,自动从 v1 主机清单迁移):`<userData>/adblock.json`
- 插件启停状态(内核):`<userData>/plugins.json`
- 核心设置(默认搜索引擎/主页):`<userData>/settings.json`
- MCP 模式下日志:`<userData>/browser.log`

## 设置页(`bow://settings`)

设置是**浏览器内部标签页**,不是弹窗:工具栏齿轮、`Ctrl+,` 或地址栏输入 `bow://settings` 均可打开(已存在则只聚焦,不重复新建)。
左侧导航固定为「常规 / 插件管理」+ 每个*已启用且提供设置分区*的插件各一项,右侧内容全宽渲染,**所有设置即时保存**(没有保存/取消按钮)。

- **常规**:默认搜索引擎、主页(主页留空视为放弃修改并回填已存值)。
- **插件管理**:运行时启停(立即生效并持久化)、能力标签、核心提示;有设置分区的插件可一键跳到对应分区。
- **插件设置**:CORS 放行 / 浏览历史 / 广告追踪拦截等分区直接内联展示(取消旧版的嵌套弹窗)。

边界约束:内部标签页只允许载入内部页面,因此**在设置页里输入普通网址会新开标签**,设置标签本身不会被导航走;地址栏星标、页面框选这类依赖真实页面的操作在设置标签下不可用(框选会先自动切回最近浏览的页面标签)。MCP 的页面类工具(`browser_eval` / `snapshot` / `click` 等)同样跳过内部页面标签,`browser_list_tabs` 会用 `internal: true` 标出它们。

## 插件体系

书签、历史、CORS 放行都是内置插件;广告/追踪拦截是参考插件。插件是**仓库内编译期模块**(无动态代码执行),
可在「设置页 → 插件管理」里运行时启停(无需重启),状态持久化到 `plugins.json`;停用时内核自动回收其 IPC、
建议源、MCP 工具、网络钩子与已注入 CSS。

| 扩展点 | 用途 | 现有用例 |
| --- | --- | --- |
| 浏览器 UI | 工具栏按钮 / 地址栏尾部插槽 / Overlay 浮层 / 设置分区 | 书签星标与管理面板、各插件设置分区(设置页侧栏) |
| 地址栏建议源 | 贡献模糊匹配建议(同 URL 冲突按优先级决胜) | 历史(10)、书签(20) |
| 网络钩子 | `onBeforeRequest` / `onBeforeSendHeaders` / `onHeadersReceived` 链式拦截与改写 | CORS 放行、广告拦截 |
| 内容注入 | 按 URL 匹配在 `dom-ready` / `did-finish-load` 注入 CSS/JS(仅标签页,CSS 可按页面动态生成与刷新) | 广告元素隐藏 |
| MCP 工具 | 把能力暴露给 AI 工具(随插件启停动态增减) | `browser_add_bookmark`、`adblock_stats` |

> opencode 的 `x-opencode-session` 会话头由**前端应用自行发送**(OpenCode Go/Zen 的官方要求),
> 浏览器不再代注入;需要时把 `docs/opencode-session-header.md` 里的提示词交给应用开发者。

### 浏览历史插件

「设置页 → 浏览历史」提供:按标题 / 网址 / 搜索词的模糊搜索,单条删除、勾选批量删除、
清空二次确认,以及保留条数配置(默认 500,范围 1–100000,保存后立即按最旧优先裁剪)。
历史数据按 URL 去重、最近优先,并作为地址栏建议源参与模糊匹配。

### 广告/追踪拦截插件

规则分两类,均可在「设置页 → 广告/追踪拦截」中增删改/启停:

- **网络规则**:拦截或放行请求,模式支持 `example.com`(含子域)、`*.example.com`、`||ads.example.com^` 与含 `*` 的 URL 通配;`@@` 为放行例外(放行优先)。主文档不拦截。
- **元素规则**:按域隐藏页面元素,`domain##selector` 为隐藏、`domain#@#selector` 为例外;域对该域及其子域生效,`*` 表示全站。

**元素框选**(类 AdGuard):点击工具栏「屏蔽元素」后,在页面中悬停高亮、点击选中、父/子级切换、选择器可编辑、实时预览、`Esc` 取消、`Enter`/「屏蔽」确认;确认后按当前页域立即生效并持久化。在设置页里点「屏蔽元素」会先自动切回最近浏览的页面标签再进入框选。

**文本规则与导入导出**:设置里的「文本规则」页可维护用户规则,支持导入/导出 AdGuard/EasyList 常用子集(`||host^`、`host`、`*.host`、`*` 通配、`@@`、`##`、`#@#`、`!` 注释);不支持的语法(`#?#`、`#$#`、`$document` 等)会跳过并汇总提示。

> 限制:跨域 iframe 内部元素、closed shadow root 内部元素、scriptlet/JS 规则暂不支持。

### 新增一个插件

1. 新建 `src/plugins/<id>/`:
   - `main.ts`:默认导出 `PluginMain`(`manifest` + `capabilities` + `activate(ctx)`),
     通过 `ctx.storage / ipc / events / suggest / mcp / net / content` 注册能力;`deactivate` 只处理自有非内核资源。
   - `ui.ts` + `ui/*.vue`:默认导出 UI 贡献(`slots` / `overlays` / `settingsSections`),浮层 id 约定 `plugin:<id>:<panelId>`;`settingsSections` 组件渲染在设置页侧栏对应插件的分区里。
   - `shared.ts` / `picker.ts`(可选):同构纯逻辑或注入脚本字符串,便于单测。
   - 边界约束:`main.ts` 不得 import `.vue` 或 `@renderer`;`ui.ts` 不得 import `electron`(由 `tests/pluginBoundaries.test.ts` 强制)。
2. 在 `src/main/plugins/builtin.ts` 的 `BUILTIN_PLUGINS` 登记 main;在 `src/renderer/src/plugins/registry.ts` 的 `PLUGIN_UI` 登记 ui。
3. 渲染层用 `window.browserAPI.plugins.invoke(id, method, ...args)` 调插件方法,`plugins.onEvent` 订阅插件事件。

## 环境注意事项

- **Linux 依赖**:Electron 需要 `libasound.so.2`(ALSA)。精简容器若缺失,可在运行时指定
  `LD_LIBRARY_PATH=<包含 libasound.so.2 的目录>`,或安装 `libasound2` 系统包。
- **无 GPU/无显示环境**:在无合成管线的容器里(如 ssh/CI),浏览器功能(导航/点击/输入/快照/MCP)均正常,
  但 `browser_screenshot` 可能返回黑色帧——截图请在实际桌面环境使用。
- **MCP 模式日志**写入 `<userData>/browser.log`,不会污染 stdio 协议。

## MCP 冒烟测试

```bash
npm run test:mcp   # 拉起 MCP 模式浏览器并自动跑关键流程(新标签→导航→快照→截图→搜索→点击→输入→书签→广告拦截统计)
```

需要显示环境;Linux 缺 ALSA 时:`SMOKE_LD_LIBRARY_PATH=<目录> npm run test:mcp`。
截图会保存到 `/tmp/mcp-shot.png`(可用 `SMOKE_SHOT_PATH` 覆盖)。

## 架构速览

```
src/
  main/          主进程:窗口、TabManager(每标签 WebContentsView + 内部页面标签)、
                 通用 Overlay 浮层宿主(OverlayManager + overlay 页面注册表)、
                 渲染入口解析(rendererEntry)、MCP 服务器、注入式页面操作执行器、JSON 存储、IPC
  main/plugins/  插件内核:注册/启停编排、独立存储、IPC 路由、事件总线、建议合并、
                 网络钩子宿主、内容注入宿主、MCP 工具宿主
  plugins/<id>/  内置插件(自包含):main.ts(主进程侧)/ ui.ts + ui/*.vue(渲染层侧)
                 / shared.ts|rules.ts(同构纯逻辑)
  preload/       contextBridge 暴露 window.browserAPI(含 plugins 调用面)
  renderer/      Vue 3 三个渲染入口:chrome UI(index.html:标签栏/地址栏/插件插槽/建议下拉浮现层)、
                 Overlay 宿主(overlay.html)、设置页(settings.html,内部标签页 bow://settings)
                 plugins/registry.ts = 渲染层插件 UI 注册表
  shared/        三端共享:类型、URL 解析、内部页面标识、设置页导航模型、
                 书签树/历史/模糊匹配/建议合并/URL 匹配纯逻辑
tests/           vitest 单元测试(url 解析、内部页面、设置导航、书签树、历史、模糊建议、插件注册表/匹配/边界)
```

WebContentsView 的布局顶部偏移量由 chrome UI 实测高度通过 `ui:chrome-height` IPC 上报,标签栏/工具栏高度变化时自动跟随。

**内部页面标签页**:设置等浏览器自有页面以 `bow://<id>` 作为对外 URL(见 `@shared/internalPages`),由 TabManager 创建为普通标签视图,但额外注入应用 preload、不登记内容注入、并禁止就地导航到非内部 URL;反之普通标签也不会就地载入内部页面——跨界一律另开标签。渲染入口由 `main/rendererEntry.ts` 统一解析(dev 走 Vite dev server,prod 走打包 html)。

**通用 Overlay 浮层框架**:页面(WebContentsView)永远绘制在 chrome UI 之上,所以任何需要浮在页面上方的 UI(书签面板等插件浮层、地址栏建议下拉)都交由常驻的透明顶层视图承载——`OverlayManager` 按 `placement` 布局:`full` 全窗弹层;`below-chrome` 页面区条带(不遮工具栏)。渲染层 `OverlayApp.vue` 是注册表宿主,新增浮层只需扩展 `OverlayContentId` + 注册一个组件(组件契约:`payload` prop + `overlay-event` 回传,`close-request` 为通用请求关闭事件)。建议下拉由此浮在页面上方(Chrome 同款交互:展开时点页面先收起、第一击不穿透),**页面高度不再随搜索栏高度变化而重排**。