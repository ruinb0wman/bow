# MCP Browser — AI 可操纵的简易 Electron 浏览器

多标签页浏览器:地址栏搜索(输历史/书签实时模糊建议)、浏览历史、书签(文件夹分组)、下载管理(工具栏面板:记录 / 暂停恢复 / 重新下载 / 取消)、页内查找(`Ctrl+F`:高亮 + `n/m` 计数 + 上下一个)、设置页(内部标签页 `bow://settings`)、终端(内部标签页 `bow://terminal`,连本机 shell,并会把终端里 pi 的执行 / 等待确认 / 完成状态显示成**标签角标**与**底部居中通知**)、笔记(内部标签页 `bow://logseq`,直接读写你已有的 Logseq 文件图);内置 **MCP 服务器(stdio)**,AI 编码工具(pi / Claude Code / Cursor 等)可以实时操纵这个浏览器:导航、搜索、点击、输入、滚动、切换标签、截图、读取页面快照、下载文件。

## 技术栈

- Electron(≥ 33,WebContentsView 每标签一实例)+ TypeScript
- Vue 3 + Vite(electron-vite 组织 main / preload / renderer 三端)
- `@modelcontextprotocol/sdk`(stdio transport)
- xterm.js + `node-pty`(内置「终端」插件:`bow://terminal` 内部页面连本机 shell;node-pty 是本仓库**唯一的原生模块**,见「打包成桌面应用」一节)
- 笔记插件**零新增依赖**:Logseq 文件格式的解析 / 序列化 / 行内 markdown 都是仓库内的纯 TypeScript(`src/plugins/logseq/`),
  所以「点一下就地编辑」能把光标映射回原始 markdown 的偏移,`[[页面]]` 也是可点击的组件而不是一段 HTML

> 对外签名:网站收到的 User-Agent 为 `bow/<版本>`(无 `Electron/` 与应用名令牌);
> `Sec-CH-UA` / `navigator.userAgentData` 保持 Chromium 原生(与 Chrome 一致,不做剥离)。
> 应用显示名为 bow,userData 数据目录仍为 `mcp-browser`,既有书签/历史/设置不受影响。

## 启动

```bash
npm install
npm run dev        # 开发(HMR)
npm run build      # 只编译 main / preload / renderer 到 out/(不产出可双击的应用)
npm run dist       # 编译 + 打包当前平台(Windows → dist/win-unpacked/bow.exe;Linux → dist/linux-unpacked/bow + dist/*.AppImage,见下文)
npm run mcp        # 构建后以 stdio MCP 模式启动(供 AI 工具以子进程方式拉起)
npm run mcp:http   # 构建后以 HTTP MCP 模式常驻(强制模式;普通启动也默认开启,见下文)
npm run test:mcp   # 真机冒烟测试(自己拉起浏览器)
npm run test:mcp:http  # 真机冒烟测试(连已常驻的 HTTP 浏览器)
npm run test:e2e:device  # 设备检查的假手机 E2E(真 Electron + 真 MCP,不需要真机/显示环境)
npm run test:e2e:agent   # 代理状态 E2E(假 pi 往 pty 打 OSC → 角标 / 底部居中通知 / 点击进标签)
npm run test:e2e:quark   # 夸克网盘插件的离线 E2E(假夸克服务器 + 假 aria2 RPC,不需要夸克账号,需要 openssl)
npm run pi:install-status   # 把状态桥扩展装进 pi(~/.pi/agent/extensions/),终端里的 pi 才有完整状态联动
node scripts/open-bow.mjs http --dry-run   # 只看 HTTP 模式将注入的环境变量与端点
npm run mcp:install -- --help   # 把浏览器 MCP 写进 pi 的配置(幂等、可回滚)
node scripts/open-bow.mjs -- a.html https://x.com   # 启动并打开(文件管理器/终端用的就是这个形态)
npm test           # 单元测试
npm run typecheck  # 类型检查
```

## 打包成桌面应用(Windows / Linux)

`npm run build`(`electron-vite build`)**只是编译** —— 它把主进程 / preload / 渲染层编译到 `out/`,
产物仍需要 `node_modules` 里的 electron 才能跑。产出可分发的应用要用 electron-builder;
`npm run dist` 会**按当前平台**选目标(Windows → `--win`,Linux → `--linux`,macOS → `--mac`),
所以 Windows 侧和 Linux 侧跑同一条命令即可:

```powershell
# Windows(从 Linux/WSL 打 Windows 包需要 wine,用于改写 exe 图标与版本信息)
npm run dist
```

```bash
# Linux:产出解包目录 + AppImage
npm run dist
```

| 平台 | 产物 | 说明 |
| --- | --- | --- |
| Windows | `dist/win-unpacked/bow.exe` | 双击即用 |
| Linux | `dist/linux-unpacked/bow` | 解包目录,`./bow` 直接跑 |
| Linux | `dist/bow-<版本>.AppImage` | 单文件可执行:`chmod +x` 后双击 / `./bow-*.AppImage` |

两者都自带 Electron 运行时,不依赖仓库与 `node_modules`。`dist/` 已在 `.gitignore` 里。

Linux 的打包配置在 `package.json` 的 `build.linux`:`executableName: "bow"`(否则可执行文件会跟着包名
叫 `mcp-browser`)、`target: ["dir", "AppImage"]`、以及 `desktopName` + `syncDesktopName: true`
(生成的 `.desktop` 基名 `com.ruinb0w.bow.desktop`,与运行时 `app.setDesktopName()` 的 app_id / WM_CLASS 逐字一致)。

只想打其中一种 / 换别的目标:

```bash
node scripts/dist.mjs -- --linux AppImage   # 只要 AppImage
node scripts/dist.mjs -- --linux deb        # 需要 fpm / dpkg
node scripts/dist.mjs -- --linux tar.gz
node scripts/dist.mjs --no-build            # 跳过前面的 electron-vite build
node scripts/dist.mjs --dry-run             # 只打印将执行什么
```

关于数据目录:**打包版与开发版共用同一份 userData**。`main/ua.ts` 的 `applyBrowserIdentity()`
会把 userData 钉到旧目录名 `mcp-browser`(不跟随 productName),所以书签、历史、插件开关都不会丢。

### 几个容易踩的坑

1. **镜像**。electron-builder 除了 Electron 发行包,还要下打包工具链(Windows 是 nsis / winCodeSign,
   Linux 的 AppImage 是 appimage / 7zip),默认走 GitHub、国内经常拿不下来。`scripts/dist.mjs` 会自动注入
   `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`(读 `.npmrc` 的 `electron_mirror`,
   否则回落到 npmmirror),所以 `npm run dist` 在 PowerShell / cmd / Git Bash 下都能用 ——
   **不要**自己写成 `ELECTRON_MIRROR=... electron-builder`,Windows 的 cmd 不认内联赋值。
2. **外部化依赖**。electron-vite 默认外部化依赖,主进程 bundle 里留的是
   `require("@modelcontextprotocol/sdk/...")`、`require("zod")`,这些包必须原样出现在
   `app.asar` 的 `node_modules` 里,否则 `bow.exe` 双击后一闪即退(崩在主进程,窗口都不弹)。
   electron-builder 会把**生产依赖闭包**自动打进去(`devDependencies` 不会);
   `npm run dist` 最后一步的 `scripts/verify-dist.mjs` 会从 bundle 里扫出实际的外部 require
   再逐个核对,不齐就直接失败。
3. **原生模块**。`node-pty`(终端插件用)是 N-API 二进制,npm 包自带 `prebuilds/win32-x64/…` 与 `prebuilds/darwin-*/…`,
   **不需要** `@electron/rebuild` 也不需要 VS 工具链;但它必须在 asar 里**解包**才能加载 ——
   `package.json` 的 `build.asarUnpack` 已配 `**/node_modules/node-pty/**`,产物里会落在
   `resources/app.asar.unpacked/…`。改这行配置时请跑一次打包 + 开一个终端验证。
   **Linux 例外**:node-pty 的 `prebuilds/` 不含 linux,`bun install` / `npm install` 时它会落到
   `node-gyp rebuild`(需要 `make`/`g++`/`python3`),编出来的 `build/Release/pty.node` 会被一起打进产物。
   机器上没有编译工具链时,打包仍会成功,但终端页会显示「终端后端不可用(node-pty 加载失败)」——
   浏览器其它功能不受影响。

```bash
node scripts/verify-dist.mjs            # 单独重跑产物自检(自动找当前平台 dist/<平台>-unpacked/resources/app.asar)
node scripts/dist.mjs -- --win portable # 试别的 target
```

### 单实例

普通启动带单实例锁:重复双击**不会**新起一个进程(否则两个实例都想占 MCP HTTP 端口),而是由已有进程
**开一个新窗口** —— 每个窗口有独立的标签栏、独立的浮层与内部页面标签,关掉一个窗口不影响其它窗口,
全部窗口关闭后才退出应用。**例外是 `MCP=stdio`** —— 那种模式下浏览器是 MCP 客户端的子进程,
必须允许与常驻实例并存,否则子进程一启动就退出、客户端的 stdio 连接直接断(`npm run test:mcp` 也会莫名其妙失败)。

多窗口下 MCP 的 `tabId` **全局唯一**:`browser_list_tabs` 每条带 `windowId` 与 `windowRole`。
**AI 用的是一个专属窗口**:省略 `tabId` 时只会作用于 bow 为 MCP 客户端自动创建并复用的 **agent 窗口**
(`windowRole: "agent"`,标题带「· Agent」后缀、相对你的窗口级联偏移 32px),**绝不会动你正在浏览的主窗口**;
没有就自动创建一个,之后一直复用。要操作你窗口里的标签(列表里 `windowRole: "user"`)必须在**那一次调用里显式传 `tabId`**。
`browser_new_tab` 可用 `windowId` 指定窗口;`browser_switch_tab` 只在 agent 窗口之间切换后续默认窗口 ——
指向用户窗口时只激活那个标签,不改默认窗口、也不抢焦点(注:Wayland 下窗口管理器可能拒绝「提到前台」的焦点请求)。
响应顶层的 `mcpWindowId` 就是省略 `tabId` 时会作用的窗口(还没创建时为 `null`),`focusedWindowId` 仅表示你在看哪个窗口。

## 设为默认浏览器 / 打开本地文件

注册在**设置页里点一下**就行:`bow://settings`(工具栏齿轮)→ 左侧「插件设置 → 默认浏览器」。
那里会显示**现在究竟是不是默认浏览器** —— 逐个目标(http 链接 / https 链接 / `.html` / `.htm` / `.xhtml`)
列出系统当前把它交给谁 —— 并提供「注册为默认浏览器 / 撤销注册 / 刷新」三个按钮。

| 平台 | 点「注册」后 bow 做了什么 | 还需要手动确认吗 |
| --- | --- | --- |
| Linux | 写 `~/.local/bin/bow` 包装脚本(dev)或直接指向 bow 二进制(打包)+ `~/.local/share/applications/com.ruinb0w.bow.desktop` + `~/.config/mimeapps.list` 的默认关联 | 不需要,点完即生效 |
| Windows | 在 HKCU 里把 bow 注册成**候选**:`bowHTML` / `bowURL` 两个 ProgID、`…\.html` / `.htm` / `.xhtml\OpenWithProgids` 与它们的 `HKCU\Software\Classes\.<ext>` 默认值、`…\Applications\bow.exe`、`…\Clients\StartMenuInternet\bow\Capabilities` + `RegisteredApplications` | **需要**:系统不允许程序代改默认关联,注册完要去「设置 → 默认应用」点一次(设置页会把这两步列出来) |

几件容易误会的事:

- **状态是现读系统的,不是记自己写过什么** —— 设置页每行下面(鼠标悬停)可以看到这个结论是
  从哪个键 / 哪一行读出来的:Linux 是 `~/.config/mimeapps.list` 的具体行,Windows 是具体注册表键
  (如 `…\Shell\Associations\UrlAssociations\http\UserChoice → ProgId`)。
- **Windows 上「记录」与「实际」可能不一致**,而且**以实际为准**:UserChoice 带 Hash 保护,
  当那条记录失效(陈旧、被改写)时 Windows 会忽略它并按 HKCR 合并顺序回落到
  `HKCU\Software\Classes\.<ext>`。所以插件除了读记录,还会调 shell 自己的
  `AssocQueryString` 拿到「双击时到底用谁打开」;两者不一致的行会显示 `实际 xxx` 标记 +
  一段说明(该记录已被忽略,建议重新选一次以刷新)。
- **Windows 上「系统设置里显示 bow」不等于五项都是 bow**:系统判定默认浏览器看的是
  `.htm(l)` 文件 + http(s) 协议这几项,所以插件会把**每一项**当前归谁列出来,非默认的那几行会直接
  给出对应的改法(按文件类型 vs 按协议的操作路径不同)。
- **停用插件 ≠ 撤销注册**:停用只是把界面收起来,系统里的关联仍在;要撤掉请点「撤销注册」
  (Windows 上只删 bow 自己写的那些键/值 —— 撤销前会先 `reg query` 核对,别人写的默认值会保留)。
- **Windows 上的「已注册,但系统当前用的是别的」是正常中间态**:注册只让 bow 进入候选列表,选不选由你决定。
- **dev 模式注册的是包装脚本**(指向仓库里的 electron);打包版会直接指向 bow 二进制 —— 切换后点一次「更新注册」即可纠正。
- Linux 上缺 xdg-utils 时,bow 自己能被直接调用,但别的程序用 `xdg-open` 拉浏览器会失败(装 `xdg-utils` 可解);设置页会提示这一条。
- 注册是**幂等**的:重复点只会更新自己那几行 / 那几个键;改动 `mimeapps.list` 前会留一份 `.bow.bak`。

### 打开本地文件的三条路径(两个平台一致)

| 入口 | 形态 | 说明 |
| --- | --- | --- |
| 文件管理器 | Linux:桌面条目的 `%U`;Windows:注册表命令里的 `"%1"` | 第二个进程只把参数交给常驻实例 → **新开标签**,不顶掉当前页 |
| 终端 | `bow a.html` / `bow.exe C:\x\a.html` / `node scripts/open-bow.mjs -- a.html https://x.com` | 只有第一个参数是 `stdio`/`http` 时才当模式,其余原序透传给 electron |
| 地址栏 | `/tmp/a.html`、`~/a.html`、`./a.html`、`C:\x\a.html`、`\\server\share\a.html`、`file:///…` | 路径**存在**才算文件;否则维持原规则(`file.html` → `https://file.html`,不存在的路径 → 搜索) |

细节与边界:

- 启动时加了 `--allow-file-access-from-files`:本地页面的相对图片 / CSS / `<script type="module">` 才能加载
  (不加时 Chromium 会以 CORS 拒掉 `file://` 下的模块脚本,`fetch()` 同理)。
- 参数判定是「逐个分类」而不是「按位置取」:Windows 盘符 `C:\…` 同时长得像「协议 C:」,所以本地路径必须
  先于 scheme 判定(`src/main/openArgs.ts` 的 `classifyArg`,有回归测试看住顺序)。
- 目录参数、不存在的路径、`mailto:` 等其它协议一律忽略并记一条日志(普通启动写 stdout,MCP 模式写
  `<userData>/browser.log`),不会静默开出空白页。
- Windows 只认原生路径形态(`C:\…`、`file:///C:/…`、`\\server\share\…`);从 Git Bash 手敲
  `/c/Users/x/a.html` 是 MSYS 路径语义,不会被当成 Windows 路径。
- `file://` 访问**不**记入浏览历史(历史插件按 `isHttpUrl` 过滤),地址栏建议里也不会出现。
- MCP 的 `browser_navigate` / `browser_new_tab` **仍然只接受 http/https**:本地文件只能由人打开,
  AI 读不到任意本地文件。

## 给 AI 工具配置 MCP

> **跨平台启动**:两个 MCP 启动脚本都经由 `scripts/open-bow.mjs` 设置环境变量。
> 不要自己写 `MCP_HTTP=1 electron .` 这种内联赋值 —— Windows 的 PowerShell / cmd 不认,
> 会把 `MCP_HTTP` 当成命令名报错(`'MCP_HTTP' is not recognized as …`)。

两种传输,按需要选:

| | stdio(默认) | HTTP |
| --- | --- | --- |
| 谁启动浏览器 | AI 工具把它当子进程拉起 | 你自己先启动,浏览器常驻 |
| 多客户端共享 | ✗ 一个会话一个浏览器进程 | ✓ pi / Claude Code / 脚本可同时连 |
| 重复窗口 | stdio 实例不参与单实例锁(客户端子进程必须能独立启动),可能与常驻实例并存 | 普通启动即单实例,重复启动**开一个新窗口**(同一进程,不再只聚焦旧窗口) |
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
会**开一个新窗口**(同一进程)。

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
| `browser_screenshot {tabId?, fullPage?}` | 截图,以 PNG 图片内容返回给 AI;默认只截当前视口,`fullPage: true` 截整页(含滚动到视口外的内容) |
| `browser_get_info {tabId?}` | 当前标签标题 / URL / 加载状态 |
| `browser_add_bookmark {title?, url, folderId?}` / `browser_list_bookmarks` | 书签维护(由「书签」插件提供;`url` 除 http(s) 外也接受 `bow://` 内部页) |
| `device_list_targets {serial?}` | 列出通过 adb 连接的可调试手机目标(Android 应用里的 WebView / Chrome),含所属 App 包名与 `targetKey`(由「设备检查」插件提供) |
| `device_inspect {targetKey, activate?}` | 在 bow 的标签页里打开该目标的 DevTools 前端(等同 `chrome://inspect` 的 inspect)(由「设备检查」插件提供) |
| `device_snapshot {targetKey?, maxElements?}` | 手机页面的可操作元素快照(与 `browser_snapshot` 同一份脚本、同一种返回形状),返回的 `selector` 可直接给 `device_tap` / `device_type`(由「设备检查」插件提供) |
| `device_tap {targetKey?, selector?, x?, y?, mode?}` | 在**手机页面**上点一下 —— 默认发真实触摸事件(`Input.dispatchTouchEvent`,与 chrome://inspect 的 screencast 同款),不可用时自动降级为鼠标(以返回的 `mode` 为准)(由「设备检查」插件提供) |
| `device_type {targetKey?, selector?, text, clear?}` | 往手机页面的输入框输文字(聚焦 + 全选 + `Input.insertText`,受控输入框的 `onChange` / `beforeinput` 都收到真事件)(由「设备检查」插件提供) |
| `device_press_key {targetKey?, key}` | 在手机页面上按功能键(Enter / Tab / Escape / Backspace / Delete / 方向键 / Home / End / PageUp / PageDown);文字用 `device_type`(由「设备检查」插件提供) |
| `device_scroll {targetKey?, selector?, direction, amount?}` | 滚动手机页面或页面内的滚动容器(与 `browser_scroll` 同一套语义)(由「设备检查」插件提供) |
| `device_console {targetKey?, durationMs?, reload?, maxEntries?}` | 采集手机页面**接下来这段时间**的控制台输出、未捕获异常与浏览器日志(CDP 没有历史回放;要看加载期日志传 `reload: true`)(由「设备检查」插件提供) |
| `device_eval {code, targetKey?}` | 在**手机页面**里执行 JavaScript(由「设备检查」插件提供) |
| `device_screenshot {targetKey?, fullPage?}` | 截取**手机页面**并作为 PNG 返回(由「设备检查」插件提供) |
| `device_connect {address}` | 连接已开启无线调试的设备(`adb connect <address>`)(由「设备检查」插件提供) |
| `browser_list_downloads {id?, state?, limit?}` | 下载记录(进行中的在前),含状态、进度百分比、速度、保存路径与文件是否还在磁盘上(由「下载」插件提供) |
| `browser_download {url, saveDir?, filename?, wait?, timeoutMs?}` | 从 URL 下载文件(不需要页面上的点击,也不弹保存对话框);默认保存到 bow 的下载目录并自动重名,`wait: true` 等到下载结束才返回(由「下载」插件提供) |

> 夸克网盘插件**不贡献 MCP 工具** —— 它只在夸克个人网盘页的工具栏按钮里提供一个面板(见下文)。

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

同一份清单也做成了设置页的「快捷键」分区(`bow://settings` → 快捷键,按分类展示、含各自例外说明),不用翻文档。

- `Ctrl+T` 新标签、`Ctrl+W` 关闭**聚焦的那个窗格/标签**(终端页里也一样 —— 终端就是普通标签,`Ctrl+W` 一律关它)、`Ctrl+Shift+T` 恢复
- `Ctrl+L` 聚焦地址栏(页面/地址栏/弹层任意焦点下都生效;**终端页除外** —— 那里 `Ctrl+L` 是 shell 的清屏)、`Ctrl+R` 刷新**聚焦窗格**(页面里也生效;**终端页除外** —— 那里 `Ctrl+R` 是 shell 的反向历史搜索)、`Ctrl+,` 打开设置(设置是内部标签页 `bow://settings`,重复打开只聚焦已有标签)
- `Ctrl+Shift+L` 聚焦地址栏,**任何焦点下都生效(含终端页)** —— 在终端里想跳去地址栏就用它
- `Ctrl+Shift+E`:**在聚焦窗格开终端**(顶替当前窗格,与在地址栏输 `bow://terminal` 同一条路;聚焦窗格已是终端则什么也不做)。
  它和 `Ctrl+Shift+L` 一样**在终端里也生效** —— 不会漏给 shell
- `Ctrl+F` 页内查找:高亮并计数(`n/m`),`Enter` 下一个 / `Shift+Enter` 上一个 / `Esc` 关闭 / `Aa` 区分大小写
  —— **终端页除外**(那里 `Ctrl+F` 是 shell 的按字符前进);DevTools 前端自带查找,也不接管;
  地址栏建议 / 分屏面板 / 下载面板打开时查找条会被替换(页内高亮仍在)
- `Ctrl+J`:打开 / 关闭**下载面板**(再按一次关;**终端页除外** —— 那里 `Ctrl+J` 是 shell 的 accept-line,
  等价于回车)。代价与 `Ctrl+←/→` 同类:网页里的编辑器(Jupyter、网页版 vim 等)拿不到这个组合
- `Ctrl+数字`:`Ctrl+1..8` 切到标签栏第 n 项(一个分屏组只算一项)、`Ctrl+9` 取最后一项
- `Ctrl+←` / `Ctrl+→`:后退 / 前进(**聚焦的那个窗格**的历史,与 `Ctrl+W` 同口径;焦点不在任何窗格时作用于活动标签)
  —— 除**终端页**与 **macOS** 外,任何焦点下都接管(含地址栏、设置页、笔记页、DevTools 前端),
  所以网页输入框里的「按词移动光标」让位(与 `Ctrl+Shift+方向` 分屏同一类代价);
  终端页里放行给 shell(readline 的按词移动);macOS 上不启用 —— 那里的 `Ctrl+←/→` 常被系统
  (Mission Control / 切换桌面)先吃掉,而 `⌘+←/→` 是「行首/行尾」,两个都不能动
- `Ctrl+Shift+←/→/↑/↓`:在**聚焦的窗格**上分屏(新窗格开一个空白标签并聚焦它,方向 = 新窗格的位置);
  `Alt+Shift+←/→/↑/↓`:把聚焦窗格**最内层那条分隔条朝该方向推一步**(推离窗格 = 它变大,推向窗格 = 它变小;
  长按可连续调整)
  —— 这两个组合在**普通网页标签**、**终端页**(`bow://terminal`)与**手机调试的 DevTools 前端标签**上接管 ——
  终端窗格里也能就地分屏 / 调大小,手机 DevTools 窗格里也能(它没有 preload,页面自己调不了 `splitPane`);
  地址栏、设置页里的它们保持原样(按词选择 / 前端自己的快捷键)。代价见下方「标签组与分屏」
- 终端页(`bow://terminal`)里:`Ctrl+L`(清屏)、`Ctrl+R`(反向历史搜索)、`Ctrl+F`(按字符前进)、`Ctrl+←/→`(按词移动)**归 shell**;**`Ctrl+W` 不再归 shell** —— 它照常关掉聚焦的那个终端窗格;
  `Ctrl+C` **有选中内容就复制**(不打扰 shell)、没有选中才照常发给 shell 当中断信号;`Ctrl+V` 粘贴
  (`Ctrl+Shift+C` / `Ctrl+Shift+V` 是同一套动作的备用组合;都走主进程剪贴板,不依赖渲染层的敏感上下文/权限)
- `Ctrl+Shift+P` 密码:填入当前登录页 / 打开密码库(匹配到多个账号时在密码框旁弹页内下拉;
  未创建 / 已锁定 / 当前页没有登录表单时改为打开密码面板)。网页 IDE(如 vscode.dev)的命令面板也是这个组合,
  会被浏览器先吃掉
- `Ctrl+Shift+I` / `F12`:为**当前聚焦的视图**(页面 / 浏览器 UI)打开或关闭 DevTools。
  DevTools 固定以**独立窗口**打开(不会停靠、也不会被标签页遮挡);焦点在 DevTools 窗口内时,
  按同一快捷键可关闭它。

## 关闭窗口

点标题栏关闭按钮 / `Alt+F4` / 窗口管理器关闭窗口时,只要还有 **2 个及以上标签页**,会先弹出应用内确认框
(设置页 `bow://settings` 与设备检查的 DevTools 前端标签**也算在内**):

- 「取消」/ `Esc` / 点遮罩 → 回到页面,窗口不关;
- 「关闭窗口」→ 关掉**这个**窗口,它的全部标签页一并丢弃(**bow 不保存会话**,重启不会恢复);
  还有别的窗口开着时进程继续运行,全部窗口关闭后才退出;
- 确认框开着时再按一次 `Alt+F4` = 直接关闭(也是 overlay 渲染异常时唯一不自锁的出口)。

只有 1 个标签(或没有标签)时直接关闭,不打扰。**确认态按窗口隔离**:关掉 A 窗口不会让 B 窗口跳过确认。`Ctrl+W` / 标签上的 × 关单个标签**不**确认;
确认框开着时 `Ctrl+W` / `Ctrl+T` 不生效(否则框里的「当前有 N 个标签页」当场就过时了;要关窗口就点按钮或再按一次 `Alt+F4`)。

## 标签组与嵌套分屏

**标签栏里的每一项就是一个标签组**,组里是一棵可任意嵌套的**二叉分屏树**:普通组 1 个窗格,分屏组 2..8 个;
组里的窗格全关掉,这一项就消失。

- `Ctrl+Shift+←/→/↑/↓` 在当前聚焦的窗格上**分屏**:新窗格开一个空白标签、立刻聚焦它(接着在地址栏输网址),
  位置按箭头(→ 右、← 左、↑ 上、↓ 下)。每一次都**在当前窗格外嵌套一层**,新窗格吃掉它一半的地方 ——
  连按三次 → 得到 `50% / 25% / 25%` 这样的嵌套比例(想要均分用 `Alt+Shift+方向` 自己调)。
- `Alt+Shift+←/→/↑/↓` 把**最内层那条方向对得上的分隔条朝箭头方向推一步**:箭头指哪,分隔条就往哪挪
  (也就是「贴窗口边界那侧推不动」不再是死键 —— 那个方向推的是**反方向**那条,所以窗格会变小)。
  `←/↑` 与 `→/↓` 是同一套语义的两个方向:箭头指着你要推的那条边。
  上下 / 左右都**只动最内层**那一层(外层的比例不受影响);那条已经到 10% / 90% 的极限、
  或整棵树里没有同方向的分隔条(比如左右并排里按 ↑/↓)时,按键不动。
- **在分屏里开终端 / 笔记**:先 `Ctrl+Shift+方向` 分出一个空白窗格,再在地址栏输入 `bow://terminal`(或直接按 `Ctrl+Shift+E`)——
  终端**顶替当前聚焦的那个窗格**(不新建标签)。笔记页同理(`bow://logseq`,也可以先在笔记页里按 `Ctrl+Shift+方向`
  就地分屏,再 `Ctrl+点击` 一个 `[[链接]]` 把它开在新窗格里)。工具栏的终端 / 笔记按钮则是「新标签」入口。
- **新建标签(`Ctrl+T` / `+` / MCP `browser_new_tab`)永远是新建一个组,不会拆掉已有的分屏。**
- 多窗格组在标签栏里只占**一项**:只显示**聚焦窗格**的名字,其余窗格只显示一个字母图标(点哪个图标就聚焦哪个窗格,
  中键点图标关掉它);聚焦窗格的那一项有高亮底色,地址栏、前进后退、`Ctrl+L` 都跟着它。
  标签宽 90~160px(分屏组 160~240px),再长的标题用省略号截断。
- 聚焦的窗格**四边都有 2px 强调色描边**(左右分屏 = 完整一圈框,嵌套分屏 = 每边各一段)。
  分屏时页面区四周会留 **2px 内边距**给外边框让位 —— 窗格是盖在浏览器 UI 之上的原生视图,只有没被盖住的条带
  能画高亮;单窗格 / 不分屏时不留内边距,页面区与以前**逐像素一致**。
- `Ctrl+1..9` 切的是**组**(标签栏第几项,`9` = 最后一项),不是按标签切。
- `Ctrl+W` / 标签上的 × / 中键点项体 = 关掉**聚焦的那个窗格**:它所在的节点会塌缩(剩下的兄弟顶替它占满那块地方),
  焦点落到阅读顺序里的下一个窗格;把组里最后一个窗格也关掉,这一项就消失。
  「聚焦的窗格」不看它是什么 —— 网页、终端、设置页、DevTools 前端一律照此关(终端的 shell 会话也随之回收)。
- **保存/套用布局**:工具栏「分屏」面板列出当前组的窗格(点一行聚焦它)、「保存当前布局」、以及已保存的布局列表
  (点一行**在当前组后面新开一个标签组**,按同一形状摆出 N 个空白标签;行尾垃圾桶删除)。
  只存**结构**(嵌套方向 + 每个分隔的比例),不存网址,落盘在 `<userData>/split-layouts.json`。
- 「取消分屏」把当前组的 N 个窗格拆成**相邻的 N 个单标签组**(标签都不销毁,顺序 = 从左到右/从上到下)。
- `Esc` 或点面板外的空白处关闭面板;标签组**只在内存**,不跨重启保存(只有布局落盘)。
- 一个组最多 **8 个窗格**(每个窗格都是一个真 `WebContentsView`);到上限后分屏快捷键不再响应。
- 某个层级放不下两个 120px 的窗格时,这一层**只显示聚焦那一支**(树不拆,窗口拉大后自动恢复)。
- 组里可以是任意标签(普通网页、本地文件、`bow://settings`、设备检查的 DevTools 前端都行)。
- ⚠️ 代价:`Ctrl+Shift+方向` / `Alt+Shift+方向` 是在**普通网页标签、终端页与手机调试的 DevTools 前端标签**上全局接管的,
  所以网页里的 `<input>` / `<textarea>` 也拿不到这两个组合(主进程无法同步得知「当前焦点是不是可编辑元素」);
  终端里 shell 以及 vim / tmux 这类程序也收不到它们(xterm 原本会把它们编成 CSI 序列送进 pty);
  手机 DevTools 内部输入框(Styles / Console 提示)里的 `Ctrl+Shift+方向` 按词选择也让位给分屏
  (DevTools 里的 `Alt+Shift+方向` 本来没有绑定)。地址栏、设置页不受影响。
- MCP 工具签名不变:`browser_close_tab {tabId}` 关的是**一个标签**(节点塌缩,不会整组消失);
  `browser_list_tabs` 的每一项带 `groupId`,可以据此看出哪几个标签同组。

## 终端(bow://terminal)

工具栏的终端按钮在**新标签页**里开一个连到本机 shell 的终端(xterm.js + node-pty);
**地址栏输入 `bow://terminal` 则是「就地打开」**——终端**顶替当前聚焦的窗格**(不新建标签、也不额外分屏),
所以分屏后在窗格里输 `bow://terminal` 就能得到一个「网页 | 终端」的布局(聚焦窗格已经是终端时该输入不生效):

- 四个入口,同一个终端:① 工具栏终端按钮(新标签);② 地址栏输 `bow://terminal`(顶替聚焦窗格);
  ③ `Ctrl+Shift+E`(同上,不用打字);④ 历史 / 书签里点「终端」(同地址栏语义 —— 顶替聚焦窗格)。
  终端与 `bow://settings` 都**可收藏**(星标 / MCP `browser_add_bookmark`),也都会进浏览历史。

- **每个终端标签一个独立会话**(可多开,能与网页左右分屏)。标签刷新/崩溃重建会**接回同一个 shell** 并回放最近的输出;
  标签关掉才回收(退出 bow 时全部回收)。
- 默认 shell 在「设置页 → 终端」选:Windows 预设 Windows PowerShell / PowerShell 7 / 命令提示符 / WSL / Git Bash,
  也能自己加配置(名称 / 可执行文件 / 参数 / 工作目录)。WSL 的启动目录用参数 `--cd ~` 表达
  (Windows 侧的 `cwd` 会被映射成 `/mnt/c/...`,不是 WSL 的 home)。
- 外观:字体族 / 字号 / 滚动缓冲,**改完即时作用到已打开的终端**。
- 键位:**`Ctrl+W` 归浏览器** —— 关掉聚焦的那个终端窗格(与标签上的 × 同义);
  `Ctrl+L`(清屏)、`Ctrl+R`(反向历史搜索)、`Ctrl+F`(按字符前进)、`Ctrl+←/→`(按词移动)**归 shell**;
  **`Ctrl+Shift+←/→/↑/↓` 与 `Alt+Shift+←/→/↑/↓` 也归浏览器** —— 焦点在终端窗格上照样分屏 / 调整大小,
  shell(以及终端里跑的程序)收不到这两个组合(xterm 平时会把它们编成 CSI 序列送进 pty)。
  ⇒ 想用 shell 的「删词」请按各 shell 自己的绑定(如 bash/WSL 的 `Alt+Backspace`);
  **`Ctrl+C` 有选中就复制到剪贴板,没有选中则照常发给 shell 当中断信号**;
  `Ctrl+V` 粘贴(多行文本按 xterm 的括号粘贴规则送进去),`Ctrl+Shift+C` / `Ctrl+Shift+V` 是备用组合;
  `Ctrl+D` 照常是 shell 的 EOF;`Ctrl+←/→` 与 `Ctrl+R` 也照常是 shell 的(按词移动 / 反向搜索),
  浏览器不再用它们回退 / 前进 / 刷新;`Ctrl+Shift+L` 跳回地址栏;`Ctrl+Shift+E` 当前窗格已是终端 → 什么也不做。
- **`Ctrl+Alt+<可打印键>` 一律送进 pty**(如 pi / pi-agents 的 `Ctrl+Alt+P` 切模式)。xterm.js 在 Windows 上
  把所有 `Ctrl+Alt+字母` 当成 AltGr(第三级 shift)、在送数据**之前**就丢掉,终端页启动时会包住它那条判据
  (`plugins/terminal/ui/xtermCtrlAltChord.ts`):只在「Chromium 明确说这次组合没有 AltGr 字符」
  (`getModifierState('AltGraph')` 为假)时放行,字节仍由 xterm 自己编码。
  两条已知边界:① AltGr 布局(德语/法语/波兰语…)里 Chromium 会给 `Ctrl+Alt` 组合置上 AltGraph,
  真组合仍分不出来(维持现状);② macOS 的 `Ctrl+Option+字母` 是另一处原因(`evaluateKeyboardEvent`
  在 mac 上就不产出 key),本次未修。
- **AI 代理状态联动**:终端里的 **pi** 会把「在跑 / 等你确认 / 跑完了」写成一条自定义 OSC
  (`ESC]1337;bow;{…}BEL`),终端插件在 pty 输出里把它剥掉(不会漏进 xterm),于是:
  - **正在执行** → 那个标签亮一个蓝色呼吸点(标签栏一项 = 一个组,分屏时按 blocked > working > done 取优先级);
  - **需要你确认**(一切 `ctx.ui.confirm/select/input/editor/custom` 弹框:plan→build 的批准、权限询问、
    `ask_user_question` 等都算)→ 窗口**底部居中**弹通知,卡片带弹框标题与会话名;这条**不自动消失**(它就是要等你);
  - **任务完成**(pi 的 `agent_settled` —— 重试/压缩/排队续跑都真的结束了)→ 底部居中弹「已完成」通知,8 秒后自动收起;
  - **点通知卡片 = 进入对应标签**:切标签 + 把窗口提到前台 + 把键盘焦点交给那个终端。
  接入(两种都行):**设置页 → 终端 → Pi 状态联动 → 安装**(点一下就好,装完在 pi 里重开或 `/reload` 生效),
  或者命令行 `npm run pi:install-status`(幂等,`--uninstall` 可撤;需要 pi ≥ 0.84.4)。
  不想动 pi 配置、只想试一次:`pi --extension <仓库>/integrations/pi/bow-agent-state.ts`。
  - 📁 **pi 会把 `~/.pi/agent/extensions/` 下的每个 `*.ts` 都加载**,没有登记表 —— 所以这个目录里
    可能同时躺着**别的宿主**留下的同类扩展(比如 herdr 装的那份)。这不是重复:每个扩展自己拿环境变量
    门禁(bow 看 `BOW_TERMINAL=1`,herdr 看 `HERDR_ENV=1`),在别人的终端里一步就返回、什么都不做;
    bow 的安装/卸载只碰**自己那个文件**(文件名 + `managed by bow` 归属标记),绝不改别人的扩展。
  - ⚠️ **pi 与 bow 不在同一个系统里时**(典型:Windows 的 `bow.exe` + WSL 的 pi),要装两份到认知不一的地址:
    设置页的按钮写的是 **`bow` 进程自己的家目录**(Windows 的 `%USERPROFILE%\.pi\agent\extensions`),
    而发行版里的 pi 读的是 **WSL 的 `~/.pi/agent/extensions`** —— 后者要自己放一份。
    **这一段不需要你手写命令**:只要你的终端配置里有 `wsl.exe`,设置页就会把那条命令显示出来并可一键复制
    (它是拿主进程算出的 `/mnt/<盘>/…` 路径拼的,见 `src/plugins/terminal/piBridge.ts` 的 `wslHint`);
    命令行等价写法:从 WSL 里 `cp /mnt/c/…/bow/integrations/pi/bow-agent-state.ts ~/.pi/agent/extensions/`,
    或在 WSL 里直接跑 `node scripts/install-pi-agent-state.mjs`。
  - ⚠️ **`shell` 是 `wsl.exe` 时**:bow 会自动把 `BOW_TERMINAL` 列进 `WSLENV`(否则 Windows 的变量进不了发行版,
    扩展会认不出 bow —— 实测:不列是空、列了是 `1`)。若你用别的容器/远程终端做类似的事,就在那边 `export BOW_TERMINAL=1`。
  **不装也能用一半**:靠 pi 内建的 `terminal.showTerminalProgress`(默认关)至少能显示「正在执行」,
  没有「需要确认 / 已完成」这两档。协议本身是通用的(`BOW_TERMINAL=1` 门禁 + 1337 私有区间,
  别的终端不认识这套序列),所以桥接扩展在 bow 之外什么都不做。
  已知边界:在 tmux / screen / ssh 里跑 pi 时,外层复用器可能不放行这条 OSC。
  **不生效时按这个顺序查**(三个判据,一次分清是哪一层坏了):
  1. **先确认你敲命令的终端就是 bow 里那个**:`ps -o comm= -p $PPID`(bash/zsh/WSL)
     —— 是 `bow`/`electron` 才对;是 `systemd`/`login`/`-zsh` 那就是普通终端,在那里打什么都到不了 bow;
  2. **标记必须进得来**:`node -e "console.log(process.env.BOW_TERMINAL)"` 要输出 `1`
     (PowerShell 里看环境变量要写 `$env:BOW_TERMINAL`;zsh/bash 才是 `echo $BOW_TERMINAL`)。
     不是 `1` → bow 没送到:Windows+WSL 看上面的 `WSLENV` 那条,其它容器/远程终端就 `export BOW_TERMINAL=1` 兜底;
  3. **手工打一条信号证明 bow 侧链路**(不经过 pi):
     `node -e "process.stdout.write('\x1b]1337;bow;'+JSON.stringify({v:1,state:'blocked',title:'test'})+'\x07')"`
     → 应当出现**黄点 + 底部居中卡片**。有卡片 = bow 侧没问题,去查 pi 那侧(扩展位置 / `pi --version` ≥ 0.84.4 / `/reload`);
     没反应 = 看日志(`npm run dev` 时直接打在跑 dev 的那个终端里):
     `会话已创建` / `通知视图加载失败` / `代理状态信号落到不存在的标签,忽略`。
     注意这条命令**本身不会打印任何东西**,是正常的 —— 它写的是零宽控制序列,效果在标签栏。
- 同时最多 12 个会话(超了会提示);终端页是内部页面标签,MCP 的页面类工具不会拿它做操作目标。
- node-pty 的预编译二进制只覆盖 Windows / macOS —— 这套终端主要在 Windows 侧的 bow.exe 上用。

## 笔记(bow://logseq)

工具栏的笔记按钮在**新标签页**里开一个笔记编辑器;**地址栏输入 `bow://logseq` 则是「就地打开」**
(与终端同一条路:顶替当前聚焦的窗格,不新建标签)。它读写的是**你自己已有的 Logseq 文件图**,
不是另一份数据:同一个目录既能被 Logseq 打开,也能被 bow 打开。

- **选图**:第一次打开会提示「选择 Logseq 图目录」(系统目录选择框),选过的图记在 `logseq.json` 里,
  设置页「笔记」分区可以切换(最多记 5 个最近图)。识别规则:目录下有 `logseq/`、`journals/` 或 `pages/`;
  **Logseq 的 DB 图(`logseq/db.sqlite`)会被明确拒绝** —— 那是另一套存储引擎,本插件只支持文件图。
- **只做四件事**:日志(`journals/YYYY_MM_DD.md`,目录名与日期格式都从 `logseq/config.edn` 读)、
  双向链接(`[[页面]]` 与 `#标签`,含 `#[[多字 标签]]`;点不存在的页面就建它)、反向链接面板、
  实时 markdown(分块就地编辑),外加「日志模板」(`:default-templates {:journals "…"}` + `templates/<名字>.md`,
  支持 `<%date%>` / `<%time%>` / `<%current page%>` / `<%yesterday%>` / `<%tomorrow%>`)。
- **页面名与文件名互为别名**:页面 identity 是**显示名**(`title::` 优先,否则文件名解码),
  但**文件名也能用**:`[[文件名]]`、搜索框里敲文件名、用文件名打开,都会落到同一个页上 ——
  两个名字指向的本来就是同一个文件,认错就是**覆盖用户的笔记**。
  保存还有一道底线:编辑器打开时文件不存在(新建页面 / 还没落盘的今日日志),而保存时磁盘上
  已经有了这个文件(Logseq 先建了它),**不会被静默覆盖** —— 走「冲突」横幅,由你选重载还是强行覆盖。
- **块编辑**:点一下块就地编辑(渲染态 → 原始 markdown),**光标落在被点那一行的行尾**(多行块就是那一行;
  表格行就是被点的那一行表格行);拖选文本不会误进编辑态。
  `Enter` 新块 / 块首 `Enter` 在**块前**插一个空块(原块的文字、多行内容、`id::` 这类属性行与
  子块全都留在原块,光标落在新空块里)/ 块中间 `Enter` 劈开 / `Ctrl/Cmd+Enter` 块内换行 /
  `Shift+Enter` 同样块内换行 /
  `Tab` 缩进(成为上一个兄弟的子块)/ `Shift+Tab` 反缩进 / 块首 `Backspace` 合并(顶层第一块若是**空块**则
  删掉自己 —— 块首 `Enter` 建出来的空块靠这条能收回去;非空块 / 页面上唯一的块保持原样)/
  `↑` `↓` 换块 / `Esc` 退出 / `Ctrl+Z` `Ctrl+Shift+Z` 撤销重做(整篇快照,上限 50 步)。
  输入 `[[` 或 `#[[` 会给出页面补全。
  中文输入法下**主推 `Ctrl+Enter`**:不少输入法把单按 `Shift` 当「中/英切换」吃掉,
  于是 `Shift+Enter` 到达页面时已经变成普通 `Enter`(会新建块、光标跳走)。
  换行后 `textarea` 会自己长高 —— 否则新行会被 `overflow: hidden` 裁掉、看起来像「根本没换行」。
- **粘贴按 `-` 行拆成块**:从 Logseq / 别处复制一段 `- ` 列表粘进块里时,**每一行各自成为一个块**,
  缩进还原成子块(把一段子树复制再粘回来能原样还原层级);粘贴来源的缩进(2 / 4 空格、tab)会按
  **本文件的缩进单位**重新对齐。不以 `-` 开头的行**归上一个块做块内内容行**(与 `Ctrl+Enter` 等价),
  粘贴开头就是这种行时并入当前块。在块中间粘贴 = **在光标处劈开**:光标前的文字留在原块,
  光标后的文字成为最后一个粘贴块之后的**新块**(文字顺序不乱);当前块是空块(且没有子块、没有 `id::`
  这类属性行)时被粘贴内容**顶替**,不留空块;粘完光标落在**最后一个粘贴块的末尾**。
  **整段不含 `-` 行的纯文本仍然照旧**(全部进当前块做块内内容行);一次 `Ctrl+Z` 可回滚整次粘贴。
- **多块选中(整块操作)**:在块左侧的**圆点上按住鼠标往下拖**,划过哪些块就选哪些(选中行有底色,
  右下角显示「已选 N 块」);`Esc` 或点空白处取消。选中后:
  `Backspace`/`Delete` 删除整组(含子块,可 `Ctrl+Z`)、`Ctrl+C` 把选中块按 Logseq markdown 写入剪贴板、
  `Ctrl+X` 剪切、`Tab` / `Shift+Tab` 整组缩进 / 反缩进(要求选中块是同一层里连续的同级兄弟;
  混合层级时不动作)。圆点上原地点一下仍然是旧的「折叠」行为。
  **剪切是「先确认复制成功、再删」**:剪贴板写完会读回校对一次,没写进去就**不删**(右下角给出失败原因)——
  宁可不删也不丢内容;复制成功会提示「已复制 N 块」。
- **字号与收藏**:设置页「笔记」分区可调**正文字号**(整个笔记正文与行内标题按比例缩放,页头控件不变);
  标题旁的星标收藏当前日志/页面,页头的「收藏」下拉一键打开或取消(按图分开记,存在 `logseq.json` 里)。
- **渲染**:行内(粗体 / 斜体 / 行内代码 / 删除线 / 高亮 / `[[双链]]` / `#标签` / 链接)之外还认**行级**
  markdown —— `#`~`######` 标题、`> ` 引用(支持 `>>` 嵌套)、`* [ ]` / `* [x]` 复选框、`* ` / `1. ` 列表、
  `---` 水平线、``` 围栏代码块、**`|` 表格**(判据与 Logseq/CommonMark 一致:**表头行 + 紧跟的分隔行**,
  分隔单元格里 **`-` 只要一个就算**(`|-|-|` —— Logseq 自己写出来的就是这个形态,和 `| --- | --- |` 等价),
  支持 `:---` / `:---:` / `---:` 对齐;单元格里的双链 / 标签 / 粗体照旧可点,**点单元格光标落该表格行行尾**)。
  **点复选框即勾选**,只翻转那一行的 `[ ]`↔`[x]` 并写回文件(可 `Ctrl+Z`);
  标记只在渲染态生效,进编辑态看到的仍是原始 markdown。
  块内清单用 `* [ ]`(Logseq 的写法);`- [ ]` 会被解析成子块,但子块开头的 `[ ]` 同样渲染成复选框 ——
  这是 Logseq 文件图的固有语义(`- ` 即子块),bow 不改写它。
- **键位与分屏**:`Ctrl+Shift+←/→/↑/↓` / `Alt+Shift+←/→/↑/↓` 在笔记页里也管用(分屏、调大小),
  由页面自己调 IPC 完成 —— 与终端页必须由主进程接管的做法不同(见「标签组与嵌套分屏」)。
  `Ctrl+点击` 一个 `[[链接]]` = 在右侧新窗格里打开它。
- **与 Logseq 共用同一个图的规矩**:只写 `journals/` 与 `pages/` 下的 `.md`(改文件前会校验路径),
  `logseq/config.edn` **只读、永不写回**;编辑命令只替换被碰过的那几行 —— 没改的行逐字节原样保留
  (解析→序列化对任意输入恒等,`tests/logseqFormat.test.ts` 钉住了这一点);写入用 `.tmp` + rename 原子替换。
- **外部改动**:整个图目录被递归监听。文件在别处(比如 Logseq 自己)被改动时,当前页**没有未保存改动**就自动重载;
  **有改动**则等保存时给出冲突横幅,让你二选一:「用磁盘版本重载(丢弃本地改动)」/「强行覆盖磁盘」——
  **绝不静默覆盖**。
- **自动保存不得打断编辑(不变式)**:自家写入绝不能让页面重载。主进程按「**写之前**记账 + flush 时比对
  磁盘内容」吞掉自己的 watcher 回声(光看事件到达时刻必然记不住:通知在 `rename` 那一刻就产生了);
  页面侧的同页重载一律走 `silent`,**磁盘内容与内存逐字节相同 = 一个 DOM 都不动** —— 否则 `<textarea>`
  会被卸下重建,编辑器退出、焦点与撤销栈一起丢(2026-09-20 修的就是这个:每次防抖保存后都静默重载一次)。
  内容真的变了才更新,并且尽量保住正在编辑的那个块。
- **未保存窗口 = 400ms**:编辑是防抖自动保存的(失焦立刻保存)。`Ctrl+W` 由主进程在页面之前处理(关掉聚焦窗格),
  页面拦不住它,所以这 400ms 内的输入可能丢 —— 想彻底避免就在关窗前停一下手。
- **状态提示是浮层**:`保存中…` / `未保存` / `外部已改动` / 保存失败消息固定显示在窗口右下角(`position: fixed`),
  **不参与文档流** —— 它们每敲一次字都要出现/消失一次,占位会把正文推来推去;标题下那一行只留「尚未创建文件 /
  来自模板 / 图文件数超限 / `:journal/file-name-format` 警告」这类切页/切图时才变的提示。
- **不做的事**:`((块引用))` 与 `{{embed}}` 只原样显示(不丢字节);不做 `TODO`/`DOING` 关键字、优先级、查询/白板/闪卡、
  不渲染图里的本地图片
  (显示为链接)、不支持 org 格式的图;`<%date%>` 展开成 `2026-09-20` 这样的 ISO 日期,而不是 Logseq 的
  `:journal/page-title-format`(moment 语法)结果。
- **表格与多块选中的边界**:表格只认「表头行 + 紧跟着的分隔行」(没有分隔行的 `|` 行照旧是普通文本);
  **写在 `- ` 块之外的顶层裸行一个都不渲染**(标题 / 段落 / 表格都算) —— 这类页只显示 `- ` 开头的行,
  顶部会挂一条「本页有 N 行不在块里(不渲染)」的弱提示,免得被当成渲染坏了;
  切列只按**未转义的 `|`**,所以单元格里的裸 `|` 与反引号内的 `|` 会把列切断(`\|` 不切但会原样显示成一个反斜杠);
  表格不可在渲染态直接编辑单元格,点一下仍是整块进入编辑态。多块选区只支持**从圆点拖选**(不做 Shift 扩选 /
  拖动排序 / 拖到视口边缘自动滚动),整组缩进/反缩进要求选中的是**同一层里连续的同级兄弟**(混合层级不动作,
  选区保留)。
- **粘贴的边界**:只认 `-` 前缀的行(不认 `*` / `+` / `1.`);富文本一律取纯文本(`text/plain`),
  不解析剪贴板里的 HTML;复制一个带 `id::` 的块再粘出来会得到**两个同 id 的块**(Logseq 那边会困惑,
  本插件不替你重发 id);粘贴文本里若混着不以 `-` 开头的行,它们会变成**上一个块的内容行**(不是新块)。

## 数据存储

- 书签(「书签」插件):`<userData>/bookmarks.json`
- 浏览历史(「浏览历史」插件,默认保留最近 500 条,可在「设置页 → 浏览历史」调整,按 URL 去重):`<userData>/history.json`;保留条数配置:`<userData>/history-settings.json`
- CORS 放行配置(「CORS 放行」插件,首次启动从 `settings.json` 迁移):`<userData>/cors.json`
- 设备检查(「设备检查」插件):`<userData>/device-inspect.json` —— 只存 adb 命令、前端来源策略与**端口转发记录**(转发登记在 adb server 里,bow 被强杀后靠这份记录在下次启动时回收)
- 终端(「终端」插件):`<userData>/terminal.json` —— 字体族 / 字号 / 滚动缓冲与 shell 配置列表(每次读取都会夹紧/兜底)
- 笔记(「笔记」插件):`<userData>/logseq.json` —— 存**图目录 / 最近图 / 正文字号 / 每个图的收藏**;笔记内容本身就在你的 Logseq 图里,不另存一份
- 下载(「下载」插件):`<userData>/downloads.json` —— 下载记录(文件名 / 网址 / 保存路径 / 状态 / 进度 / 是否可续传);设置(保存目录 / 是否询问 / 保留条数)在同目录的 `downloads-settings.json`。**删除记录不会删文件**
- 插件启停状态(内核):`<userData>/plugins.json`
- 核心设置(默认搜索引擎/主页):`<userData>/settings.json`
- 保存的分屏布局(只存结构):`<userData>/split-layouts.json`
- MCP 模式下日志:`<userData>/browser.log`

## 设置页(`bow://settings`)

设置是**浏览器内部标签页**,不是弹窗:工具栏齿轮、`Ctrl+,` 或地址栏输入 `bow://settings` 均可打开(已存在则只聚焦,不重复新建)。
左侧导航固定为「常规 / 快捷键 / 插件管理」+ 每个*已启用且提供设置分区*的插件各一项,右侧内容全宽渲染,**所有设置即时保存**(没有保存/取消按钮)。

- **常规**:默认搜索引擎、主页(主页留空视为放弃修改并回填已存值)。分屏布局改在工具栏的「分屏」面板里保存/套用/删除。
- **快捷键**:按分类列出全部键位(标签 / 地址栏与导航 / 分屏与布局 / 视图与面板 / 终端 / 笔记 / 窗口),纯参考清单、**不注册任何热键**;macOS 上的 `⌘` 差异与平台受限组合(`Ctrl+←/→`)在条目里单独注明。
- **插件管理**:运行时启停(立即生效并持久化)、能力标签、核心提示;有设置分区的插件可一键跳到对应分区。
- **插件设置**:CORS 放行 / 浏览历史 / 终端 / 笔记 / 下载 等分区直接内联展示(取消旧版的嵌套弹窗)。
  「终端」分区里有 shell 配置与外观,还有 **Pi 状态联动** —— 点一下把状态桥扩展装进 pi(或卸载),
  装完终端里的 pi 就会把「执行中 / 等待确认 / 已完成」显示成标签角标与底部居中通知(见「终端」一节);
  如果你的终端配置里有 `wsl.exe`(bow 在 Windows、pi 在 WSL2),这一段还会多出一条
  **「如果使用 WSL2,请执行以下命令将扩展安装到 WSL2 中」** 的提醒 —— 命令直接可复制粘贴,
  因为上面那个按钮装的是 bow 自己那个系统的家目录,发行版里的 pi 看不到(见「终端」一节的跨系统说明)。
  「笔记」分区可调**正文字号**,并**显示**从 `logseq/config.edn` 读到的目录 / 日期格式 / 默认模板与索引统计,还提供「重建索引」——
  改模板请去 Logseq 里改配置(这份插件从不写回 `config.edn`);收藏在笔记页里用标题旁的星标管理。

边界约束:内部标签页只允许载入内部页面,因此**在设置页里输入普通网址会新开标签**,设置标签本身不会被导航走;地址栏星标这类依赖真实页面的操作在设置标签下不可用。MCP 的页面类工具(`browser_eval` / `snapshot` / `click` 等)同样跳过内部页面标签,`browser_list_tabs` 会用 `internal: true` 标出它们。

## 插件体系

书签、历史、CORS 放行、MCP HTTP 服务、默认浏览器、设备检查、终端、笔记、下载、夸克网盘、密码都是内置插件。插件是**仓库内编译期模块**(无动态代码执行),
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
| 网络钩子 | `onBeforeRequest` / `onBeforeSendHeaders` / `onHeadersReceived` 链式拦截与改写 | CORS 放行(暂时无插件使用 `onBeforeRequest`) |
| 内容注入 | 按 URL 匹配在 `dom-ready` / `did-finish-load` 注入 CSS/JS(仅标签页,CSS 可按页面动态生成与刷新) | 目前无插件使用(钩子保留) |
| MCP 工具 | 把能力暴露给 AI 工具(随插件启停动态增减) | `browser_add_bookmark`、`device_list_targets` |
| 快捷键 | 注册主进程全局热键(任意焦点下生效,含页面内) | 密码(`Ctrl+Shift+P`) |

> opencode 的 `x-opencode-session` 会话头由**前端应用自行发送**(OpenCode Go/Zen 的官方要求),
> 浏览器不再代注入;需要时把 `docs/opencode-session-header.md` 里的提示词交给应用开发者。

### 下载插件

工具栏的下载按钮(进行中显示百分比与角标)与 `Ctrl+J` 打开下载面板:记录列表(文件名 / 来源域名 / 进度 /
速度 / 剩余时间 / 保存路径),以及暂停、恢复、取消、重新下载、打开文件、在文件夹里显示、复制链接、删除记录、
清空已完成。设置页的「下载」分区可以改保存目录、关掉「下载前询问保存位置」(关掉后直接存到该目录,
同名文件自动加 `(1)`,不会覆盖)、限制保留条数(默认 500,**进行中的记录永不裁剪**)。

两条需要知道的边界:

- **恢复下载的行为由服务器决定**:服务器支持 Range 与 `ETag` / `Last-Modified` 时是真续传;不支持时浏览器会重新请求,
  实测它会保留已收到的那部分继续写(最终文件仍然正确)。万一观测到字节被丢弃,记录里会带上 `restarted: true`,
  面板也会标注「服务器不支持续传,已从头开始」 —— 这一条不预判,只在真发生时出现;
- **重启浏览器后,上次没下完的记录会显示「已中断」**,只能「重新下载」(跨会话续传要记录更多握手信息,
  这一版刻意不做);删除记录**不会**删磁盘上的文件。

### 夸克网盘插件

在 `pan.quark.cn` 的个人网盘页,工具栏会出现一个云朵按钮(其他页面上置灰)。点开面板:
列出**当前目录**的文件、勾选后一键**推送到 aria2**。插件不贡献 MCP 工具 —— 它只有界面。

**它怎么拿到直链**:冒充夸克官方 PC 客户端(专用 User-Agent)调它自己的
`drive-pc.quark.cn/1/clouddrive/file/download` 接口,响应里的 `download_url` 就是 CDN 直链;
下载时还必须带同一个 UA。登录态直接复用 bow 的 cookie 域罐(所以**要先在 bow 里登录夸克**),
插件不接触你的密码,也不保存任何凭据。

**推送怎么落地**:把直链与三个请求头(UA / Referer / Cookie)交给
**aria2 的 JSON-RPC `aria2.addUri`**(设置页可配域名 / 端口 / 路径 / 令牌 / 保存目录)。
为什么不是 bow 自己的下载器:aria2 是独立进程,拿不到浏览器的 cookie 域罐,
而夸克直链离开这套请求头就下不动 —— 干脆把「拿链接」与「下载」分开,下载交给专业的那个。

几条要知道的限制与排障:

- **必须有一个活着的、已登录的夸克标签页**:直链要从该页的 React 状态里读;
- **分享页(`/s/xxx`)不支持**,只做个人网盘页;
- 面板只列出**页面当前已加载**的那一页文件(夸克自己滚动加载更多之后,点「刷新」即可);
- 取不到直链时先在面板里看错误文案:`31001` = 需要登录,`23018` = 游客可获取大小超限;
  仍然不行就打开面板的「诊断」区,把原始响应体一并带上;
- **UA 是整套方案的命门**,而且是可改的设置项:夸克升级客户端导致失效时,到「设置 → 夸克网盘」
  把新版客户端的 UA 贴进去即可,不用等插件更新;
- **Cookie 只发给白名单域名**(默认 `quark.cn` / `uc.cn`,留空 = 不传)。
  aria2 会跟着重定向跳跑,而直链有时落在别的域名上;空白名单最安全但大文件很可能 403 ——
  面板「诊断」区会显示真实域名,把它加进白名单即可;
- 设置页的「测试连接」会调 `aria2.getVersion`,先确认 aria2 开着 RPC(`--enable-rpc`)再推。

⚠️ 这类工具处于「个人自用 vs 服务条款」的灰色地带,且会用到你已登录的账号;请自行判断是否使用。

### 密码插件

工具栏的钥匙按钮或 `Ctrl+Shift+P`:在登录页按需注入一个页内下拉(匹配到多个账号时)或直接填入;
没有匹配 / 还没建库 / 已锁定时改为打开「密码」面板(点工具栏按钮也是它)。面板里可以搜索、增删改条目、
复制用户名 / 密码、把某一条填入当前页,以及「从当前页面保存」(读回页面上已输入的账号密码并预填)。

**数据与加密**:密码库由一个主密码解锁。主密码经 **scrypt** 派生密钥,条目整体用 **AES-256-GCM** 加密后
写进 `passwords.json`(盐与 KDF 参数是明文,条目明文为零);主密码本身不落盘,解锁期间密钥与条目只在
**主进程内存**里,面板只按需取单条。「设置页 → 密码」可改自动锁定时间、剪贴板清除秒数、子域匹配,
以及修改主密码 / 清空密码库。**忘记主密码无法恢复** —— 想备份就整份复制 `passwords.json`(它是密文)。

几条要知道的边界:

- **只填不提交**:插件不会替你点「登录」;
- 只有 `http/https` 页面能填,且**不注入常驻脚本**(每次探测 / 下拉 / 填入都是按需注入,用完即走);
  `bow://` 内部页、手机调试的 DevTools 前端、`file://` 一律跳过;
- **跨域 iframe 内、closed shadow root 内的密码框找不到**;
- 多步登录(先输用户名、下一页才输密码)只覆盖一半:第一页填用户名,第二页再按一次 `Ctrl+Shift+P`;
- 密码只在**真的填某一条**时才作为一次注入脚本的参数进入页面 —— 页内下拉里只送「名称 + 用户名」;
- 复制密码后按设置清除剪贴板,但仅在「剪贴板里还是那条密码」时才清(你已复制别的东西就不动);
- 不提供任何 MCP 工具:AI 拿不到密码库(刻意的隔离)。

### 浏览历史插件

「设置页 → 浏览历史」提供:按标题 / 网址 / 搜索词的模糊搜索,单条删除、勾选批量删除、
清空二次确认,以及保留条数配置(默认 500,范围 1–100000,保存后立即按最旧优先裁剪)。
历史数据按 URL 去重、最近优先,并作为地址栏建议源参与模糊匹配。
**`bow://` 内部页(终端 / 设置)也计入历史**(2026-09-19 起):开过一次终端,以后在空地址栏的「最近」列表里
就能直接看到「终端」,输「终」/「term」也能模糊命中 —— 选中即顶替当前聚焦窗格。

### 设备检查插件(手机 WebView / Chrome)

工具栏「设备检查」按钮(手机图标)→ 全窗面板:设备 → 套接字 → 可调试目标,点「检查」就把该目标接进 DevTools 前端(在 bow 的**标签页**里打开,不是新窗口);每行也可以**复制 ws 地址**或**复制地址**(即点「检查」会打开的那个 DevTools 前端地址,免去先开一个标签)。

⚠️「复制地址」拿到的是**那一刻**的前端地址:bow 自带那份是 `devtools://…`,只有 bow 自己能开;设备指定那份是 appspot 的 `https://…`,任何浏览器都能开,但前提是 bow 的端口转发与中继还活着(关掉面板重新刷新可能换端口)。

复制的是 `chrome://inspect` 那条链路:adb 设备 → `cat /proc/net/unix` 找出 `webview_devtools_remote_<pid>` / `chrome_devtools_remote` → `adb forward` → 设备 `/json` 目标列表 → DevTools 前端。所属 App 的包名来自 `/json/version` 的 `Android-Package` 字段(Chromium 只在 Android 上返回它)。

**给 AI 用的工具面不止「看」**:除了 `device_list_targets` / `device_inspect` / `device_eval` / `device_screenshot`,
还有 `device_snapshot`(元素快照)→ `device_tap` / `device_type` / `device_press_key` / `device_scroll`(真输入事件)
与 `device_console`(控制台 / 未捕获异常 / 浏览器日志)。最后四个的位置是刻意的:脚本只负责量坐标与摆焦点,
**点击/输入一律走 CDP `Input.*`** —— 合成事件(`isTrusted: false`)与 `Input.insertText` 的差别在受控输入框上会直接暴露。
DevTools 前端标签是「浏览器自身页面」,核心的 `browser_*` 工具不会去操作它(用 `device_*` 操作被调试的那个页面)。

**一边调手机一边跑终端 / 记笔记**:焦点落在手机 DevTools 窗格里按 `Ctrl+Shift+→`(或其它方向)→ 新窗格里
`Ctrl+Shift+E` 开终端(或在地址栏输 `bow://logseq`)—— 于是左边看 DevTools、右边跑 AI / 写记录,
而 AI 侧用 `device_*` 操作同一个手机页面。

**前提条件**(缺一个就只会看到空列表,面板会给出对应提示):

1. **adb 可用**。「设置」里可填复合命令:Windows 侧没有 adb 时填 `wsl adb`(本机就是这种:bow.exe 在 Windows、adb 在 WSL);留空则依次探测 `adb` → `wsl adb`。
2. **设备已授权**:手机屏幕上点「允许 USB 调试」;无线调试则先「配对」(Android 11+:手机「无线调试 → 使用配对码配对设备」,面板里填地址与配对码)再「连接」。
3. **应用开启了 WebView 调试**:debug 包默认开;release 包必须让开发调用 `WebView.setWebContentsDebuggingEnabled(true)`,否则套接字根本不存在。Chrome 则打开任意标签页即可。
4. **跨 WSL 时要镜像网络**:转发建在 WSL 的 netns 里,Windows 侧访问 `127.0.0.1:<端口>` 依赖 WSL2 镜像网络(`.wslconfig` 的 `networkingMode=Mirrored`)。不通时提示语会直接点名这一条。

**排查：列表里没目标 / 一直连不上**（两个我实测碰到过的真原因，面板提示也按这两条写）：

- **应用被切到后台 / 屏幕锁了 → 「转发端口连不上」**。Android 会把后台应用的进程冻结：这时候套接字还在、TCP 也连得上，
  但 devtools 服务**不响应**（表现是请求超时，不是连接被拒）。把应用切到前台再刷新一次就好；
  长时间盯着一个页面调试时，先 `adb shell input keyevent KEYCODE_WAKEUP` + `adb shell svc power stayon true`
  （验证完 `svc power stayon false` 还原）。
- **`wsl adb` 时可能反复「端口转发失败」**。这种拓扑下 **adb 与 bow 不在同一个网络命名空间**：端口是 WSL 里 `bind(0)` 选的，
  而真正监听的是 Windows 侧的 adb server —— WSL 挑的端口可能落在 **Windows 的保留端口段**（Hyper-V/WSL 会占掉大段动态端口），
  于是在 Windows 侧绑不上（adb 报 `cannot bind listener` / 错误码 **10048**）。插件会对每个套接字重试 3 个随机端口，
  可多刷新几次；最稳的是改用**与 bow 同侧**的 adb（Windows 原生 `platform-tools\adb.exe`，设置里填它的路径）。
  已知缺口与可选修法见 `docs/ARCHITECTURE.md` §13#28。

**为什么必须由 bow 代理(而不是让前端直连设备)**:Chromium 的调试端点会对**带 `Origin` 头**的 WebSocket 握手做白名单校验,白名单唯一来源是 `--remote-allow-origins`,手机上加不了;而浏览器里的 devtools 前端**一定**带 `Origin: devtools://devtools`。更关键的是:**Android 上连「同源豁免」都不存在** —— 它的 devtools 服务挂在 unix 抽象套接字上,`server_ip_address_` 为 null,所以 `is_same_origin` 恒为 false。

因此 bow 在本地为每个套接字起一个**剥 Origin 的 TCP 中继**(`relay.ts`,~90 行、无依赖):前端连本机中继 → 中继删掉 `Origin` 头 → 转发到 `adb forward` 端口。WS 握手就是一个 HTTP 请求,所以只改首部即可,**不需要实现 WebSocket 帧编解码**。

⚠️ 主进程自己的 CDP 客户端(Node 的 `WebSocket` 握手不带 Origin,已实测)本来就不受这限制,`device_eval` / `device_screenshot` 以及操作类工具(`device_tap` …)只是复用了同一个 `ws` 地址。

**前端来源三种策略**(设置里可切;三者都经中继):

- `bow 自带`(默认策略下的快路径):`devtools://devtools/bundled/devtools_app.html` —— 用 Electron 自带的前端,不依赖网络也最快;
- `设备指定`:照搬设备 `/json` 里每个目标的 `devtoolsFrontendUrl`,只把 `ws=` 换成 bow 的中继端口 ——
  **`chrome://inspect` 走的就是这一条**。设备只给两种形态(实测):
  - 设备打包了前端资源 → 相对地址 `/devtools/inspector.html`(Android Chrome);
  - 不打包 → `https://chrome-devtools-frontend.appspot.com/serve_rev/<设备自己的 revision>/inspector.html`
    (vivo 系统 WebView 实测:`/devtools/inspector.html` 返回 **404**,它给的就是 appspot 那份)。
- `自动`(默认):设备 Chromium 低于 **146** 时用「设备指定」(先探一下那个地址能不能打开,打不开就回退 bow 自带),否则用 bow 自带。

**为什么需要按版本挑前端**:前端与设备的 CDP 版本必须对得上,否则有些面板会**静默空白**。
bow 自带的前端是 Electron 44(Chromium 152)的,它取 storage key 用的是 `Storage.getStorageKey`,
而 Local storage / Session storage / IndexedDB 三个节点**只**由 storage key 驱动
(`DOMStorageModel` 靠 `StorageKeyManager.storageKeys()`,`IndexedDBModel` 靠 `StorageBucketsModel` 的
`Storage.setStorageBucketTracking({storageKey})`)。这个命令是近期才加的实验性命令:
实测 `138.0.7204.179` 与 `140.0.7339.80` 只有旧的 `Storage.getStorageKeyForFrame`,`146.0.7680.31` 才有新的。
在 Chromium 138 的真机(WebView)上直接发 CDP 的对照结果很干净:
`Storage.getStorageKey` → `'Storage.getStorageKey' wasn't found`,而同一时刻
`Storage.getStorageKeyForFrame` → `http://tauri.localhost/`、`DOMStorage.getDOMStorageItems` → `[["i18nextLng","zh-CN"]]`、
`IndexedDB.requestDatabaseNames` → `["exp-v7"]` —— **数据都在设备上**,只是 bow 自带的前端拿不到 storage key;
那种组合下 bow 的前端会在 console 里直接打出 `Request Storage.getStorageKey failed`(同一批 skew 还有
`Autofill.enable` / `Network.emulateNetworkConditionsByRule` / `CSS.getEnvironmentVariables` 等)。
版本判定、回退与解释文案的唯一实现分别在 `plugins/device-inspect/shared.ts`(`effectiveStrategy` / `frontendNotice`)。

⚠️ 「设备指定」那份可能是**外网地址**(appspot)。探活走的是 **Chromium 的网络栈**(Electron `net`),
与随后真正加载它的标签页同一套代理设置 —— 用 Node 的 `fetch` 探会因不认系统代理而误判为「打不开」。

**转发与中继的回收**:`adb forward` 登记在 adb server 进程里,bow 退出不会自动清。插件在停用、退出、以及下次激活时都会清理(还有面板里的「回收全部转发」按钮);中继监听随插件停用/退出一起关闭。只清理**自己记录过的**转发 —— 不会去动你手动建的 `adb forward`。

### 新增一个插件

1. 新建 `src/plugins/<id>/`:
   - `main.ts`:默认导出 `PluginMain`(`manifest` + `capabilities` + `activate(ctx)`),
     通过 `ctx.storage / ipc / events / suggest / mcp / net / content` 注册能力;`deactivate` 只处理自有非内核资源。
   - `ui.ts` + `ui/*.vue`:默认导出 UI 贡献(`slots` / `overlays` / `settingsSections`),浮层 id 约定 `plugin:<id>:<panelId>`;`settingsSections` 组件渲染在设置页侧栏对应插件的分区里。
   - `shared.ts` / `picker.ts` / `scripts.ts`(可选):同构纯逻辑或注入脚本字符串,便于单测(脚本文件需登记到 `tsconfig.node.json` 的 include)。
   - 边界约束:`main.ts` 不得 import `.vue` 或 `@renderer`;`ui.ts` 不得 import `electron`(由 `tests/pluginBoundaries.test.ts` 强制)。
2. 在 `src/main/plugins/builtin.ts` 的 `BUILTIN_PLUGINS` 登记 main;在 `src/renderer/src/plugins/registry.ts` 的 `PLUGIN_UI` 登记 ui(新插件的按钮默认追加到插槽末尾;要在同一个插槽里插队就写进同文件的 `SLOT_PLUGIN_ORDER`)。
3. 渲染层用 `window.browserAPI.plugins.invoke(id, method, ...args)` 调插件方法,`plugins.onEvent` 订阅插件事件。
4. 想要**自己的页面**(而不是浮层):在 `@shared/internalPages` 里加一条并配一个渲染入口(html + vite input + `RendererEntryName`),
   按钮用 `browserAPI.createTab(bow://…)` 打开;`singleton` 决定重复打开是聚焦还是新开(终端插件就是这么做的,
   它的会话靠 `getSelfTabId()` + `tab:closed` 绑定到标签上)。

## 环境注意事项

- **手机调试要 adb**:「设备检查」插件不会自带 adb。Windows 侧没有 adb 时,在插件面板的「设置」里填 `wsl adb`
  (或你实际的 adb 路径);跨 WSL 时还需 WSL2 镜像网络,详见「设备检查插件」一节。

- **终端只在 Windows/macOS 有预编译二进制**:`node-pty` 的 `prebuilds/` 不含 linux。在 Linux/WSL 里装依赖时它
  会落到 `node-gyp rebuild`(需要 `make`/`g++`/`python3`),否则终端页会显示「终端后端不可用(node-pty 加载失败)」——
  浏览器其它功能不受影响。Windows 与 macOS 开箱即用,不需要任何编译器。

- **Linux 依赖**:Electron 需要 `libasound.so.2`(ALSA)。精简容器若缺失,可在运行时指定
  `LD_LIBRARY_PATH=<包含 libasound.so.2 的目录>`,或安装 `libasound2` 系统包。
- **无 GPU/无显示环境**:在无合成管线的容器里(如 ssh/CI),浏览器功能(导航/点击/输入/快照/MCP)均正常,
  但 `browser_screenshot` 可能返回黑色帧——截图请在实际桌面环境使用。
- **整页截图(`fullPage: true`)**:`capturePage()` 只能拿视口内的像素,整页需要临时 `debugger.attach`
  后走 CDP 的 `Page.captureScreenshot{captureBeyondViewport}`。因此:
  - 该标签页开着 DevTools 时会明确报错(不去抢别人已附加的调试器);
  - 输出分辨率是设备像素(文档 CSS 尺寸 × `devicePixelRatio`),与普通截图一致;
  - 超过 GPU 能承载的 surface 高度时 Chromium **不报错而是返回错图**(实测 dpr 1.25 下
    16125 设备像素正确、16500 设备像素时底部变回页面顶部),所以按设备像素卡 16000 上限,
    超过就明确报错让调用方改用 `browser_scroll` 分段;
- **MCP 模式日志**写入 `<userData>/browser.log`,不会污染 stdio 协议。

## MCP 冒烟测试

```bash
npm run test:mcp   # 拉起 MCP 模式浏览器并自动跑关键流程(instructions 下发→新标签等待加载→快照→等待原语/超时 isError→截图→搜索→点击→输入→书签)
```

需要显示环境;Linux 缺 ALSA 时:`SMOKE_LD_LIBRARY_PATH=<目录> npm run test:mcp`。
截图会保存到 `/tmp/mcp-shot.png`(可用 `SMOKE_SHOT_PATH` 覆盖);整页截图另存为同名 `-full.png`
(可用 `SMOKE_FULL_PAGE_SHOT_PATH` 覆盖,断言 PNG 高度覆盖 `document.scrollHeight`)。
无显示环境可用 `SMOKE_ELECTRON_ARGS=--ozone-platform=headless npm run test:mcp`,但导航仍需网络、
截图可能为黑帧或空图,完整验证仍需真实桌面。

## 设备检查的假手机 E2E

```bash
npm run test:e2e:device   # 真 Electron + 真 MCP + 真 TCP/WS,只有 adb 与「手机」是假的
```

`scripts/fixtures/fake-phone-adb.mjs` 伪装 `adb`(version / devices -l / /proc/net/unix / forward),
它执行 `forward` 时拉起 `fake-phone-device.mjs` —— 后者在同一个端口上同时提供 `/json`、`/json/version`
与一个**真 WebSocket 的 CDP 服务端**。插件链路(发现 → 转发 → 剥 Origin 中继 → CDP)全部是真的,
只有设备端的返回值是 canned 的,所以下面这些都能在没有手机、没有显示环境的机器上验证:

- 11 个 `device_*` 工具在册与发现链路(设备 / 套接字 / App 包名 / `targetKey`);
- `device_snapshot` / `device_tap` / `device_type` / `device_press_key` / `device_scroll` / `device_console`
  真正发出的 CDP 命令序列与参数(断言 `cdp-log.jsonl`,含「触摸成功就不开触摸模拟」这类反面判据);
- **手机 DevTools 前端窗格上分屏**:`device_inspect` 开出真前端标签后,用 bow 自己的
  `--remote-debugging-port` 往那个 target 发 `Ctrl+Shift+→`,再读 chrome 页面的
  `window.browserAPI.getGroups()` 断言它所在组从 1 个窗格变成 2 个(MCP 的 `browser_list_tabs` 不返回 `groupId`)。

临时文件在 `$TMPDIR/bow-e2e`(`BOW_E2E_DIR` 可改);每次运行用独立 userData 与调试端口,不会碰你正在跑的 bow。
真机上的差异(触摸注入是否需要 `Emulation.setTouchEmulationEnabled`、捏合缩放下的坐标口径)仍需真机验证。

## 代理状态 E2E(假 pi)

```bash
npm run build && npm run test:e2e:agent                                                                  # 开发产物(out/)
BOW_E2E_BIN=dist/linux-unpacked/bow npm run test:e2e:agent                                                # 打包版(需先 npm run dist)
```

终端里的 pi 写一条自定义 OSC(`ESC]1337;bow;{...}BEL`)就能驱动标签栏角标与底部居中通知。这个脚本里
**pi 是假的**(一个几十字节的 node 脚本,只把那条序列打到 pty),其余全是真的:真 Electron、真终端(node-pty)、
真信号剥离与归约、真通知视图。它用 CDP 断言三件事:

- chrome 页面:`TabInfo.agent` 与标签栏角标的 DOM 同时变(`working` / `blocked` / `done`);
- 通知视图:卡片文本、量出来的高度(视图 bounds 靠它)、点卡片后**真的切到了那个标签**,
  而且**点通知 ≠ 回答弹框**(角标仍停在 blocked,直到 pi 报出下一个状态);
- 清理:关标签后角标与通知都不留(这条靠的是主进程缓存的宿主引用 —— `TabManager.close()` 先摘 record 再发事件)。

后半段还验**设置页 → 终端 → Pi 状态联动**的一键接入:`PI_CODING_AGENT_DIR` 指向临时目录,
脚本点侧栏进分区、点「安装」→ 断言文件真的落盘且带 `managed by bow` 标记 → 点「卸载」→ 断言文件没了。
`BOW_E2E_BIN` 指向打包后的可执行文件时,额外验一遍「源码能从 `app.asar` 里读到」(就靠 `build.files` 里的 `integrations`)。

与设备/夸克 E2E 一样:独立 userData + 独立调试端口,不会碰你正在跑的 bow。

> Linux 上 Electron 报 `libasound.so.2: cannot open shared object file` 时**不需要 root**:
> `ldd node_modules/electron/dist/electron | grep 'not found'` 先确认只缺这一个,去镜像的 `extra.db`
> (注意 `alsa-lib` 在 `extra` 仓库,不在 `core`:`bsdtar -xOf extra.db alsa-lib-*/desc | grep -A2 %FILENAME%`)
> 查出包名,`curl` 下下来 `bsdtar -xf` 到**持久目录**(别放 `/tmp` —— 它会被清掉,实测凌晨清过一次,
> 表现是「昨天还能跑的 E2E 突然报找不到 chrome target」):
> ```bash
> mkdir -p ~/.cache/bow-alsa && cd ~/.cache/bow-alsa
> curl -sS https://geo.mirror.pkgbuild.com/extra/os/x86_64/extra.db -o extra.db
> FN=$(bsdtar -xOf extra.db alsa-lib-*/desc | grep -A1 '^%FILENAME%' | tail -1)
> curl -sS "https://geo.mirror.pkgbuild.com/extra/os/x86_64/$FN" -o "$FN" && bsdtar -xf "$FN" -C .
> ```
> 然后用 `LD_LIBRARY_PATH=$HOME/.cache/bow-alsa/usr/lib npm run test:e2e:agent`。
> `test:mcp` / `test:e2e:device` 同理(那个脚本自己认 `SMOKE_LD_LIBRARY_PATH`)。

## 夸克网盘插件的离线 E2E

```bash
npm run build && npm run test:e2e:quark   # 需要 openssl;不需要夸克账号,也不需要显示环境
```

它把 `pan.quark.cn` / `drive-pc.quark.cn` 两个域名用 Chromium 的
`--host-resolver-rules` 指到本机一个 HTTPS 假服务器(自签证书 + `--ignore-certificate-errors`),
再起一个假的 aria2 JSON-RPC 服务器,假页面里伪造一条 React fiber 链供插件读取。
页面用 MCP 的核心工具(`browser_navigate`)打开;插件不再贡献 MCP 工具,所以插件 IPC 改用
bow 自己的 `--remote-debugging-port` 在 chrome 页面的 target 上 `Runtime.evaluate` 调
`window.browserAPI.plugins.invoke(...)`(与 `e2e-device-inspect.mjs` 读 `getGroups()` 同一手法):

```
假夸克页(React fiber) → quark 插件 listFiles → 假 /file/download 接口
  → 插件用 JSON-RPC aria2.addUri 推给假 aria2
```

断言里最关键的是**两端真正收到了什么**:取直链接口上的伪装 UA、cookie 域罐登录态、
以及**没有** `Origin`(带它 `net.fetch` 必 `ERR_FAILED`);交给 aria2 的 `header` 数组里的
UA / Referer,以及**白名单边界** —— 直链在 `quark.cn` 下才带 Cookie,落在第三方 CDN 上绝不带。
这些全是真 Electron 行为(真 cookie 域罐、真 HTTPS、真 `net.fetch`),单测(假 electron)永远发现不了,
所以单独用一个脚本钉住。

## 无需显示环境的部分

`npm test`(vitest,无需显示环境)覆盖:`tests/mcpServer.test.ts` 用 `InMemoryTransport` + 假 TabManager
与真实 `McpServer`/`Client` 握手,验证 instructions 下发、工具面与 schema、`waitUntil` 等待语义、
失败一律 `isError`、内部页面标签边界与插件工具错误传播;`tests/mcpWait.test.ts` 单独覆盖等待原语。

代理状态联动也能无显示环境测两层:`tests/agentState.test.ts`(OSC 解析与归约,含 chunk 切开 / 非本协议序列放行 / `9;4` 降级)、
`tests/toasts.test.ts`(假 electron 验证通知视图的 bounds 数学)、`tests/terminalAgentSignal.test.ts`(假 pty 跑真插件代码)、
`tests/piBridge.test.ts`(真 fs + 临时目录验证一键接入的归属/幂等)。
端到端那层(`npm run test:e2e:agent`)需要能跑 Electron 的机器或 `LD_LIBRARY_PATH` 补库(见上)。

## 架构速览

> 逐文件职责地图、插件契约(`PluginContext` 全 API)、七类扩展点、MCP 工具表、
> IPC 通道表、数据文件与环境变量、以及**已核实的文档漂移清单**见
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 本章只是速览,细节以那份为准。

```
src/
  main/          主进程:窗口、TabManager(每标签 WebContentsView + 内部页面标签 + 标签组/分屏)、
                 通用 Overlay 浮层宿主(OverlayManager + overlay 页面注册表)、
                 底部居中通知宿主(ToastManager)+ 代理状态落地(AgentNotify:角标 + 通知栈 + 定时器)、
                 渲染入口解析(rendererEntry)、MCP 服务器(stdio + 无状态 HTTP + instructions)、
                 注入式页面操作执行器与等待原语、JSON 存储、IPC
  main/plugins/  插件内核:注册/启停编排、独立存储、IPC 路由、事件总线、建议合并、
                 网络钩子宿主、内容注入宿主、MCP 工具宿主
  plugins/<id>/  内置插件(自包含):main.ts(主进程侧)/ ui.ts + ui/*.vue(渲染层侧)
                 / shared.ts|rules.ts(同构纯逻辑)
  preload/       contextBridge 暴露 window.browserAPI(含 plugins 调用面)
  renderer/      Vue 3 六个渲染入口:chrome UI(index.html:标签栏/地址栏/插件插槽/建议下拉浮现层)、
                 Overlay 宿主(overlay.html)、设置页(settings.html,内部标签页 bow://settings)、
                 终端页(terminal.html,内部标签页 bow://terminal)、笔记页(logseq.html)、
                 底部居中通知栈(toast.html)
                 plugins/registry.ts = 渲染层插件 UI 注册表
  shared/        三端共享:类型、URL 解析、内部页面标识、设置页导航模型、标签组记账、嵌套分屏树与几何、
                 代理状态协议与通知栈归约(agentState.ts)、
                 书签树/历史/模糊匹配/建议合并/URL 匹配纯逻辑
  integrations/  给外部工具装的辅助文件(pi/ 里是终端状态桥扩展)
tests/           vitest 单元测试(url 解析、内部页面、设置导航、书签树、历史、模糊建议、插件注册表/匹配/边界、代理状态与通知)
```

WebContentsView 的布局顶部偏移量由 chrome UI 实测高度通过 `ui:chrome-height` IPC 上报,标签栏/工具栏高度变化时自动跟随。

**标签组与嵌套分屏**:一个标签组 = 一棵二叉布局树(`shared/split.ts` 的 `LayoutNode`:叶子是标签,`split` 节点带轴与比例),
标签栏的一项就是一个组。`TabManager` 持有 `groups: TabGroup[]`(纯记账规则在 `@shared/groups`,可单测),
`layout()` 是页面视图**可见性的唯一来源**:几何由 `computeLayout()` 现算(每层扣 4px 间隔、比例夹在 10%~90%、
单窗格不小于 120px),分屏组的内容区四周再留 `SPLIT_INSET`(2px)给聚焦窗格的外边框让位;主进程把**窗格 rect + 分隔条 rect** 一起回传,渲染层只画不重算。有两条关键不变式:
新标签总是新建一个组(新建标签不会拆掉已有的分屏)、一个组最多 8 个窗格;`Ctrl+数字` 按组切。
组状态只在内存,布局（只存结构）落盘在 `split-layouts.json`。

**内部页面标签页**:设置等浏览器自有页面以 `bow://<id>` 作为对外 URL(见 `@shared/internalPages`),由 TabManager 创建为普通标签视图,但额外注入应用 preload、不登记内容注入、并禁止就地导航到非内部 URL;反之普通标签也不会就地载入内部页面——跨界一律另开标签。渲染入口由 `main/rendererEntry.ts` 统一解析(dev 走 Vite dev server,prod 走打包 html)。

**通用 Overlay 浮层框架**:页面(WebContentsView)永远绘制在 chrome UI 之上,所以任何需要浮在页面上方的 UI(书签面板等插件浮层、地址栏建议下拉)都交由常驻的透明顶层视图承载——`OverlayManager` 按 `placement` 布局:`full` 全窗弹层;`below-chrome` 页面区条带(不遮工具栏)。渲染层 `OverlayApp.vue` 是注册表宿主,新增浮层只需扩展 `OverlayContentId` + 注册一个组件(组件契约:`payload` prop + `overlay-event` 回传,`close-request` 为通用请求关闭事件)。建议下拉由此浮在页面上方(Chrome 同款交互:展开时点页面先收起、第一击不穿透),**页面高度不再随搜索栏高度变化而重排**。
