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
npm run build      # 只编译 main / preload / renderer 到 out/(不产出可双击的应用)
npm run dist       # 编译 + 打包成 dist/win-unpacked/bow.exe(需在 Windows 侧跑,见下文)
npm run mcp        # 构建后以 stdio MCP 模式启动(供 AI 工具以子进程方式拉起)
npm run mcp:http   # 构建后以 HTTP MCP 模式常驻(强制模式;普通启动也默认开启,见下文)
npm run test:mcp   # 真机冒烟测试(自己拉起浏览器)
npm run test:mcp:http  # 真机冒烟测试(连已常驻的 HTTP 浏览器)
node scripts/open-bow.mjs http --dry-run   # 只看 HTTP 模式将注入的环境变量与端点
npm run mcp:install -- --help   # 把浏览器 MCP 写进 pi 的配置(幂等、可回滚)
npm test           # 单元测试
npm run typecheck  # 类型检查
```

## 打包成 bow.exe

`npm run build`(`electron-vite build`)**只是编译** —— 它把主进程 / preload / 渲染层编译到 `out/`,
产物仍需要 `node_modules` 里的 electron 才能跑。产出可双击的应用要用 electron-builder:

```powershell
# 必须在 Windows 侧执行(从 Linux/WSL 打 Windows 包需要 wine,用于改写 exe 图标与版本信息)
npm run dist
```

产物:`dist/win-unpacked/bow.exe`,自带 Electron 运行时,不依赖仓库与 `node_modules`。
`dist/` 已在 `.gitignore` 里。

关于数据目录:**打包版与开发版共用同一份 userData**。`main/ua.ts` 的 `applyBrowserIdentity()`
会把 userData 钉到旧目录名 `mcp-browser`(不跟随 productName),所以书签、历史、插件开关都不会丢。

### 两个容易踩的坑

1. **镜像**。electron-builder 除了 Electron 发行包,还要下 nsis / winCodeSign 工具链,
   后者默认走 GitHub、国内经常拿不下来。`scripts/dist.mjs` 会自动注入
   `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`(读 `.npmrc` 的 `electron_mirror`,
   否则回落到 npmmirror),所以 `npm run dist` 在 PowerShell / cmd / Git Bash 下都能用 ——
   **不要**自己写成 `ELECTRON_MIRROR=... electron-builder`,Windows 的 cmd 不认内联赋值。
2. **外部化依赖**。electron-vite 默认外部化依赖,主进程 bundle 里留的是
   `require("@modelcontextprotocol/sdk/...")`、`require("zod")`,这些包必须原样出现在
   `app.asar` 的 `node_modules` 里,否则 `bow.exe` 双击后一闪即退(崩在主进程,窗口都不弹)。
   electron-builder 会把**生产依赖闭包**自动打进去(`devDependencies` 不会);
   `npm run dist` 最后一步的 `scripts/verify-dist.mjs` 会从 bundle 里扫出实际的外部 require
   再逐个核对,不齐就直接失败。

```bash
node scripts/verify-dist.mjs            # 单独重跑产物自检(自动找 dist/<平台>-unpacked/resources/app.asar)
node scripts/dist.mjs -- --win portable # 试别的 target
```

### 单实例

普通启动带单实例锁:重复双击只会把已有窗口带到前台,不会再开一个浏览器
(否则两个实例都想占 MCP HTTP 端口)。**例外是 `MCP=stdio`** —— 那种模式下浏览器是 MCP 客户端的子进程,
必须允许与常驻实例并存,否则子进程一启动就退出、客户端的 stdio 连接直接断(`npm run test:mcp` 也会莫名其妙失败)。

## 给 AI 工具配置 MCP

> **跨平台启动**:两个 MCP 启动脚本都经由 `scripts/open-bow.mjs` 设置环境变量。
> 不要自己写 `MCP_HTTP=1 electron .` 这种内联赋值 —— Windows 的 PowerShell / cmd 不认,
> 会把 `MCP_HTTP` 当成命令名报错(`'MCP_HTTP' is not recognized as …`)。

两种传输,按需要选:

| | stdio(默认) | HTTP |
| --- | --- | --- |
| 谁启动浏览器 | AI 工具把它当子进程拉起 | 你自己先启动,浏览器常驻 |
| 多客户端共享 | ✗ 一个会话一个浏览器进程 | ✓ pi / Claude Code / 脚本可同时连 |
| 重复窗口 | stdio 实例不参与单实例锁(客户端子进程必须能独立启动),可能与常驻实例并存 | 普通启动即单实例,重复启动只把已有窗口带到前台 |
| 适用 | 随手用、零手工步骤 | 常驻服务、多工具共用同一个浏览器 |

### 接入 pi(推荐用安装脚本)

```bash
npm run mcp:install                  # stdio 版:pi 自动拉起浏览器
npm run mcp:install -- --http        # HTTP 版:连常驻端点(它默认就开着,无需先跑 mcp:http)
npm run mcp:install -- --direct-core # 额外把核心 5 个工具提升为 pi 原生工具
npm run mcp:install -- --tool-prefix none  # 同时把 settings.toolPrefix 设为 none
npm run mcp:install -- --dry-run     # 只看会写入什么
npm run mcp:install -- --remove      # 卸载(配置 + skill)
```

默认写 `~/.pi/agent/mcp.json`,加 `--project` 写 `./.pi/mcp.json`。脚本是幂等的:
保留其它服务器与顶层 `settings`,目标文件不是合法 JSON 时直接报错退出,绝不覆盖。
它还会把能力索引 skill 一并装到 `~/.pi/agent/skills/bow-browser/`(`--no-skill` 可跳过)。
改完要**重启 pi**(服务器清单与 skill 都在启动时加载)。

### pi 适配器推荐配置(能力索引 + 定向直挂)

pi 的 MCP 适配器默认是**代理模式**:工具 schema 不常驻上下文,模型必须先 `describe` 才拿到参数 ——
约 200 token/服务器换上下文干净,但模型常常不主动去 describe。它同时支持两条更好的路子,推荐组合使用:

1. **`directTools`:高频工具直挂为原生工具**(schema 进上下文,0 跳)。成本参考:5 个 ≈1k token、
   20 个 ≈4k、50 个 ≈10k,代理工具 ≈200。
2. **skill 做能力索引**:`description` 常驻(几十~百 token),正文按需加载 —— 放"什么场景用哪个工具、
   按什么顺序、有哪些反模式"。本仓库的 `.pi/skills/bow-browser/SKILL.md` 就是它,
   以 `/skill:bow-browser` 注册;模型不一定会主动加载,需要时直接敲该命令强制加载。

推荐的全局 `~/.pi/agent/mcp.json`:

```json
{
  "settings": { "toolPrefix": "none" },
  "mcpServers": {
    "codegraph": { "command": "codegraph", "args": ["serve", "--mcp"], "directTools": true },
    "browser": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/browser",
      "lifecycle": "lazy",
      "idleTimeout": 0,
      "directTools": ["browser_navigate", "browser_snapshot", "browser_wait", "browser_click", "browser_eval"]
    }
  }
}
```

browser 那半边一条命令就能装好:`npm run mcp:install -- --direct-core --tool-prefix none`。

几个容易踩的点:

- **`toolPrefix: "none"`**:默认的 `server` 模式会把服务器名再拼一遍 —— 本仓库工具已自带 `browser_` 前缀,
  codegraph 的工具名也自带 `codegraph_`,默认模式下会变成 `browser_browser_navigate`、
  `codegraph_codegraph_search` 这种双重前缀(本仓库会话里就能观察到)。两个服务器都自带命名空间,
  设 `none` 最干净。
- **`directTools` 数组用工具原始名**,不带前缀。
- **`directTools` 从缓存注册**(`~/.pi/agent/mcp-cache.json`),不是实时连接:首次配好后那一轮仍走代理,
  缓存后台填充,**重启 pi** 才生效;工具面变了(比如新增 `browser_wait`)先 `/mcp reconnect browser` 再重启。
- **更推荐 subagent 定向注册**,不污染主会话上下文:
  ```yaml
  tools:
    - mcp:browser                        # 该服务器全部工具
    - mcp:codegraph/codegraph_explore    # 或只给具体工具
  ```
- 试效果不用改配置:`MCP_DIRECT_TOOLS=browser pi`、`MCP_DIRECT_TOOLS=__none__ pi`。

### 手动配置

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
        "cwd": "$PROJECT",
        "lifecycle": "lazy",
        "idleTimeout": 0
      }
    }
  }
  ```
  HTTP 版则写成 `{"url": "http://127.0.0.1:8765/mcp", "lifecycle": "keep-alive"}`。

MCP 模式下浏览器窗口照常弹出,AI 的所有操作你都能实时看到。stdio 模式下 AI 断开连接后浏览器保持运行,
可继续手动使用。注意 **stdio 实例不参与单实例锁**(见「单实例」一节):它可能与常驻实例并存,
所以**开新会话前建议先关掉旧的 stdio 实例**,否则会多开一个;而普通 / HTTP 启动的单实例重复启动
只会把已有窗口带到前台。

### HTTP 模式的开启方式

HTTP 端点由内置插件「MCP HTTP 服务」提供,**默认开启** —— 只要 bow 正常启动,端点就在监听,
不需要额外命令行参数。关掉它有两条路:点**地址栏右侧工具栏里的 MCP 状态灯**只停/启端点(插件保持启用),
或在「设置页 → 插件管理」停用整个插件(端口/令牌在插件的设置分区里改)。

MCP 状态灯就是端点的状态机,点一下切换启停:

| 颜色 | 含义 |
| --- | --- |
| ⚪ 白 | 端点就绪、当前空闲 |
| 🔵 蓝(脉冲) | 正在被调用(有在途的工具调用) |
| ⚫ 灰 | 端点已停用(手动停用 / 启动失败 / 内核依赖未就绪) |

悬停会显示端点地址、最近调用的工具名与累计调用次数。状态灯只关 HTTP 端点,而且只在**本次运行内**生效
(重启 bow 会恢复默认开启);想长期关闭就去设置页停用插件。`MCP_HTTP=1` 强制开启的实例不受它支配
(悬停会标出这一点)。

例外:`MCP=stdio`(`npm run mcp`,即被 AI 工具当子进程拉起)时不会自动开端点 ——
那种模式下浏览器是子进程,再开一个端点只会和常驻实例抢 8765。要在这个模式下也开就显式传 `MCP_HTTP=1`。

`MCP_HTTP=1` 是**强制模式**(脚本/CI 用),优先级高于插件开关;
强制模式启的实例不会被插件开关关掉。两条路径共用同一份监听,先起者赢,不会撞端口。

```bash
# Git Bash / WSL / macOS / Linux
MCP_HTTP=1 npm run mcp:http

# Windows PowerShell(PowerShell 不认识内联赋值,但这套写法是原生支持的)
$env:MCP_HTTP='1'; npm run mcp:http

# 其实上面的环境变量早已由启动器注入,所以直接跑就行
npm run mcp:http
```

对应地在 MCP 配置里加 `"headers": {"Authorization": "Bearer <随机串>"}`(`mcp:install --http --token <串>` 会替你写)。

### 浏览器与 AI 不在同一台机器(WSL2 → Windows)

HTTP 端点只监听回环地址,所以跨「Windows 浏览器 + WSL2 里的 agent」需要 **WSL2 镜像网络**:

```ini
# C:\Users\<你>\.wslconfig
[wsl2]
networkingMode=Mirrored
```

改完执行 `wsl --shutdown` 重启 WSL 生效。镜像模式下两边共享 `127.0.0.1`,所以
`http://127.0.0.1:8765/mcp` 在 WSL2 里直接可用,不需要改绑定地址。

⚠️ 镜像模式意味着 **WSL2 与 Windows 共享回环**:不加令牌时,两侧任何本地进程都能控制这个浏览器。
对不可信的本地环境,设 `MCP_HTTP_TOKEN` 并在 MCP 配置里加同值 `headers`。
常驻浏览器如果被关闭,AI 侧只需重新连接,不需要重启会话。

```bash
# 跨主机验证:在 WSL2 里跑,连 Windows 上的常驻浏览器
npm run test:mcp:http
```

## MCP 工具一览

| 工具 | 说明 |
| --- | --- |
| `browser_navigate {url, tabId?, waitUntil?, timeoutMs?}` | 导航(仅 http/https);传 `tabId` 就地导航该标签,省略则作用于活动标签;默认等到加载完成 |
| `browser_search {query, engine?, tabId?, waitUntil?, timeoutMs?}` | 用默认或指定引擎搜索;`tabId` 语义同 `navigate`;默认等到加载完成 |
| `browser_wait {tabId?, selector?, state?, timeoutMs?}` | 等页面加载完成(省略 selector)或等元素达到 attached/visible/hidden/detached 状态 |
| `browser_eval {code, tabId?}` | 在页面上下文执行任意 JavaScript,返回最后一个表达式的值 |
| `browser_snapshot {tabId?, maxElements?}` | 页面可操作元素快照(title/url + 可点击输入元素列表,含稳定 CSS 选择器) |
| `browser_click {selector, tabId?, waitUntil?, timeoutMs?}` | 点击元素(注入真实事件序列);默认不等待,点击会跳转时传 `waitUntil: 'load'` |
| `browser_type {selector?, text, clear?, tabId?}` | 输入文字(React 兼容),省略 selector 输入到当前聚焦元素 |
| `browser_press_key {key, tabId?, waitUntil?, timeoutMs?}` | 按键:Enter / Tab / Escape / ArrowDown / Ctrl+W / F5 等;返回 `ok` 仅代表事件已投递,按键会触发跳转时传 `waitUntil: 'load'`;F5 与 Ctrl+R 会等到重新加载完成 |
| `browser_scroll {direction, selector?, amount?, tabId?}` | 滚动页面或元素 |
| `browser_back / forward {tabId?, waitUntil?}` | 后退/前进(默认等到加载完成) |
| `browser_reload {tabId?, waitUntil?}` / `browser_stop {tabId?}` | 刷新(默认等到加载完成) / 停止加载 |
| `browser_new_tab {url?, activate?, waitUntil?}` | 开新标签;带 url 时默认等到加载完成 |
| `browser_close_tab {tabId}` / `browser_switch_tab {tabId}` / `browser_list_tabs` | 标签管理 |
| `browser_screenshot {tabId?}` | 当前页面截图,以 PNG 图片内容返回给 AI |
| `browser_get_info {tabId?}` | 当前标签标题 / URL / 加载状态 |
| `browser_add_bookmark {title?, url, folderId?}` / `browser_list_bookmarks` | 书签维护(由「书签」插件提供) |
| `adblock_stats` | 广告/追踪拦截统计(由「广告/追踪拦截」插件提供) |
| `adblock_list_rules / adblock_add_rule / adblock_remove_rule / adblock_set_enabled` | 广告规则增删查与开关(由「广告/追踪拦截」插件提供) |
| `adblock_import_rules {text, replace?}` | 按 AdGuard/EasyList 常用语法批量导入规则(由「广告/追踪拦截」插件提供) |
| `browser_fullscreen_element {selector, tabId?}` | 让页面元素铺满网页视口(由「元素全屏」插件提供) |
| `browser_exit_fullscreen {tabId?}` | 退出元素全屏并还原页面(由「元素全屏」插件提供) |

典型 AI 工作流:`browser_new_tab`/`browser_navigate`(已等到加载完成)→ `browser_wait` 等目标元素渲染出来 → `browser_snapshot` 找到结果链接的选择器 → `browser_click` → `browser_screenshot` 确认 → `browser_type`/`browser_click` 填表。

## MCP 行为约定

- **服务器级 `instructions`**:随 `initialize` 下发给客户端,内含返回体约定、推荐工作流、工具选型与边界
  (内部页面标签、插件工具动态增减、无 GPU 环境下截图可能为黑帧等),定义在 `src/main/mcp.ts` 的 `MCP_INSTRUCTIONS`。
- **等待语义**:`navigate` / `search` / `new_tab` / `reload` / `back` / `forward` 默认 `waitUntil: 'load'`,
  等到主文档 `did-finish-load` 才返回(失败或超时会带回 `error`);`browser_wait` 用于等异步渲染的具体元素。
  返回体里的 `waited=false` 表示调用时页面已经就绪,并不代表这次没等待。
  `browser_press_key` 的 `F5` / `Ctrl+R` 同样会等到重新加载完成;`browser_click` 默认不等待。
  `browser_press_key` 默认不等待(`waitUntil: 'none'`):它返回 `ok` 只说明按键已投递给渲染进程,
  不代表网页已处理完(如回车提交表单引发的跳转可能稍后才落地);需要跟随后续状态就传 `waitUntil: 'load'`
  或接一个 `browser_wait`。
- **未知参数**:所有核心工具的 schema 都是 strict 的,未知/拼错的参数会直接报 `isError` 并回显本工具接受的参数名,
  不会被静默丢弃(`src/main/mcp.ts` 的 `tool()` helper)。插件工具走各自的声明路径,不在此列。
- **错误标记**:所有工具返回 `{ok:false, ...}` 时,结果同时带 `isError: true`(`src/main/plugins/mcpResult.ts` 统一处理,
  核心工具与插件工具一致),AI 无需解析 JSON 就能识别失败。页面脚本把失败放在 `result.error` 的情况
  (如 `未找到选择器`)也已在 `src/main/actions.ts` 的 `lift()` 里提升为顶层失败。
- **`createdTab`**:当活动标签是内部页面(如设置页)时,`navigate`/`search` 会另开新标签而不是就地导航,
  返回体用 `createdTab: true` 标出,避免 AI 对标签状态产生错误预期。
  传了 `tabId` 时不会另开标签(`createdTab` 恒为 `false`);`tabId` 指向内部页面标签会被拒绝,
  不存在的 `tabId` 报 `标签 N 不存在`。

## 手动使用快捷键

- `Ctrl+T` 新标签、`Ctrl+W` 关闭、`Ctrl+Shift+T` 恢复
- `Ctrl+L` 聚焦地址栏(页面/地址栏/弹层任意焦点下都生效)、`Ctrl+R` 刷新、`Ctrl+,` 打开设置(设置是内部标签页 `bow://settings`,重复打开只聚焦已有标签)
- `Ctrl+D` 收藏当前页
- `Ctrl+Shift+F` 元素全屏:框选当前页面元素铺满网页视口(再按一次或 `Esc` 退出)
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

书签、历史、CORS 放行、元素全屏、MCP HTTP 服务都是内置插件;广告/追踪拦截是参考插件。插件是**仓库内编译期模块**(无动态代码执行),
可在「设置页 → 插件管理」里运行时启停(无需重启),状态持久化到 `plugins.json`;停用时内核自动回收其 IPC、
建议源、MCP 工具、网络钩子与已注入 CSS。

MCP HTTP 服务插件演示了「后台服务」型插件:插件 activate 发生在窗口/标签创建**之前**,
碰不到 TabManager,所以真正的监听由内核的 `McpHttpHost` 持有,
插件只在收到 `mcp-http:ready`(内核注入运行时依赖后触发)时做启停决策 —— 与 `setTabProvider` / `setPageApi`
是同一个时序契约。新增服务型插件请沿用这条路径。

同一个插件还用 `service.activity` 拿到了「MCP 正在被调用」的实时信号:内核的
`McpActivityTracker`(`src/main/mcpActivity.ts`)在**工具处理器**上做在途计数,
插件订阅快照后广播给渲染层,MCP 状态灯据此在白色与蓝色之间切换。
只数工具调用而不数 HTTP 请求,是因为 StreamableHTTP 客户端会挂一条长驻的 GET SSE 流 ——
按请求计数会让状态灯一旦连上就永远停在蓝色。

### HTTP 模式的安全姿态

这个端点能执行页面 JS、读任意页面内容,因此默认只做本地防护:

- 只监听 **127.0.0.1**,不对外暴露;
- 开启 DNS rebinding 防护并限定 `Host` 白名单,防止网页脚本打到本机端口;
- 可选 Bearer 令牌:设了 `MCP_HTTP_TOKEN`(或插件设置里的令牌)后所有请求必须带 `Authorization: Bearer <token>`。

⚠️ 端点默认开启且无令牌 —— 本机任何进程都能控制这个浏览器(包括登录态)。
在意的话就在插件设置里填一个令牌,并把同值写进 AI 侧的 MCP 配置。

| 扩展点 | 用途 | 现有用例 |
| --- | --- | --- |
| 浏览器 UI | 工具栏按钮 / 地址栏尾部插槽 / Overlay 浮层 / 设置分区 | 书签星标与管理面板、MCP 状态灯、各插件设置分区(设置页侧栏) |
| 地址栏建议源 | 贡献模糊匹配建议(同 URL 冲突按优先级决胜) | 历史(10)、书签(20) |
| 网络钩子 | `onBeforeRequest` / `onBeforeSendHeaders` / `onHeadersReceived` 链式拦截与改写 | CORS 放行、广告拦截 |
| 内容注入 | 按 URL 匹配在 `dom-ready` / `did-finish-load` 注入 CSS/JS(仅标签页,CSS 可按页面动态生成与刷新) | 广告元素隐藏 |
| MCP 工具 | 把能力暴露给 AI 工具(随插件启停动态增减) | `browser_add_bookmark`、`adblock_stats` |
| 快捷键 | 注册主进程全局热键(任意焦点下生效,含页面内) | 元素全屏(`Ctrl+Shift+F`) |

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

### 元素全屏插件

工具栏「元素全屏」按钮或 `Ctrl+Shift+F` 进入框选:悬停高亮、`↑`/`↓` 切换父/子级、点击选中、`Esc` 取消;选中后元素**原地**铺满网页视口(标签栏/工具栏保留),深色背景层,`img`/`video` 按 `contain` 保持比例。`Esc`、再次点按钮或 `Ctrl+Shift+F` 退出。

- **仅当前页面有效**:不落盘,页面刷新/跳转后自动还原。
- 仅 `http/https` 页面可用;不移动 DOM(iframe 不会重载),但跨域 iframe 内部元素、closed shadow root 内部元素无法选中。
- AI 可经 MCP 的 `browser_fullscreen_element` / `browser_exit_fullscreen` 直接按选择器全屏或还原。

### 新增一个插件

1. 新建 `src/plugins/<id>/`:
   - `main.ts`:默认导出 `PluginMain`(`manifest` + `capabilities` + `activate(ctx)`),
     通过 `ctx.storage / ipc / events / suggest / mcp / net / content` 注册能力;`deactivate` 只处理自有非内核资源。
   - `ui.ts` + `ui/*.vue`:默认导出 UI 贡献(`slots` / `overlays` / `settingsSections`),浮层 id 约定 `plugin:<id>:<panelId>`;`settingsSections` 组件渲染在设置页侧栏对应插件的分区里。
   - `shared.ts` / `picker.ts` / `scripts.ts`(可选):同构纯逻辑或注入脚本字符串,便于单测(脚本文件需登记到 `tsconfig.node.json` 的 include)。
   - 边界约束:`main.ts` 不得 import `.vue` 或 `@renderer`;`ui.ts` 不得 import `electron`(由 `tests/pluginBoundaries.test.ts` 强制)。
2. 在 `src/main/plugins/builtin.ts` 的 `BUILTIN_PLUGINS` 登记 main;在 `src/renderer/src/plugins/registry.ts` 的 `PLUGIN_UI` 登记 ui(新插件的按钮默认追加到插槽末尾;要在同一个插槽里插队就写进同文件的 `SLOT_PLUGIN_ORDER`)。
3. 渲染层用 `window.browserAPI.plugins.invoke(id, method, ...args)` 调插件方法,`plugins.onEvent` 订阅插件事件。

## 环境注意事项

- **Linux 依赖**:Electron 需要 `libasound.so.2`(ALSA)。精简容器若缺失,可在运行时指定
  `LD_LIBRARY_PATH=<包含 libasound.so.2 的目录>`,或安装 `libasound2` 系统包。
- **无 GPU/无显示环境**:在无合成管线的容器里(如 ssh/CI),浏览器功能(导航/点击/输入/快照/MCP)均正常,
  但 `browser_screenshot` 可能返回黑色帧——截图请在实际桌面环境使用。
- **MCP 模式日志**写入 `<userData>/browser.log`,不会污染 stdio 协议。

## MCP 冒烟测试

```bash
npm run test:mcp   # 拉起 MCP 模式浏览器并自动跑关键流程(instructions 下发→新标签等待加载→快照→等待原语/超时 isError→截图→搜索→点击→输入→书签→广告拦截统计)
```

需要显示环境;Linux 缺 ALSA 时:`SMOKE_LD_LIBRARY_PATH=<目录> npm run test:mcp`。
截图会保存到 `/tmp/mcp-shot.png`(可用 `SMOKE_SHOT_PATH` 覆盖)。
无显示环境可用 `SMOKE_ELECTRON_ARGS=--ozone-platform=headless npm run test:mcp`,但导航仍需网络、
截图可能为黑帧或空图,完整验证仍需真实桌面。

无需显示环境的部分由 `npm test` 覆盖:`tests/mcpServer.test.ts` 用 `InMemoryTransport` + 假 TabManager
与真实 `McpServer`/`Client` 握手,验证 instructions 下发、工具面与 schema、`waitUntil` 等待语义、
失败一律 `isError`、内部页面标签边界与插件工具错误传播;`tests/mcpWait.test.ts` 单独覆盖等待原语。

## 架构速览

```
src/
  main/          主进程:窗口、TabManager(每标签 WebContentsView + 内部页面标签)、
                 通用 Overlay 浮层宿主(OverlayManager + overlay 页面注册表)、
                 渲染入口解析(rendererEntry)、MCP 服务器(stdio + 无状态 HTTP + instructions)、
                 注入式页面操作执行器与等待原语、JSON 存储、IPC
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