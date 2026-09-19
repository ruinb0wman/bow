# 终端插件(xterm + node-pty,bow://terminal)

日期:2026-09-19 · 状态:待批准

## 0. 目标与假设

**目标**:内置插件「终端」——工具栏按钮点一下,在**新标签页**里打开一个 xterm,背后连本机 shell(node-pty);
设置页可改**字体族 / 字号 / 滚动缓冲**,并维护**多套 shell 配置**(powershell / pwsh / cmd / WSL / Git Bash…),选一套作默认。
终端标签**可多开**,每个标签一个独立会话;不做终端内部的 tab、不做 MCP 工具(用户已拍板)。

**假设**(如与实际不符,改动集中在 S0/S8):

- 主运行平台是 **Windows 上的 bow.exe**;开发在 WSL、经 `wsync` 同步到 `/mnt/d/Workspace/browser`(`.wsync.config.js` 的 `keepTarget: ['node_modules/']`)。
- `node-pty@1.1.0` 是 **N-API** 原生模块,npm 包内自带 `prebuilds/win32-x64/{pty.node,conpty.node,conpty.dll,OpenConsole.exe}`,
  Windows 上**不需要 VS 工具链、不需要 electron-rebuild**。这条必须在 S0 用真机验证,失败有回退(§7)。
- Windows 11(Win10 1809+)→ node-pty 走 ConPTY,`useConptyDll` 默认 false,不依赖 `postinstall` 拷贝的 dll。

## 1. 已核实的现状(代码事实,改动都基于这些)

| 事实 | 位置 |
| --- | --- |
| 标签页 = 一个 `WebContentsView`;三种 kind `page`/`internal`/`inspector` | `src/main/tabManager.ts:47-62` |
| 内部页面 URL 只有 `bow://settings` 一个,`InternalPageId = 'settings'`,解析只接受 `bow://<id>`(无路径/查询) | `src/shared/internalPages.ts:12-24` |
| `create(url)` 对内部页面是**通用**的:`loadRendererEntry(wc, INTERNAL_PAGES[internalId!].entry)` | `src/main/tabManager.ts:249` |
| `openInternal(page)` 是**单例**(已存在则只聚焦),`openUrl()` 走它 | `src/main/tabManager.ts:499-516` |
| 渲染入口名字是联合类型,只有 3 个;vite input 也是 3 个 | `src/main/rendererEntry.ts:8`、`electron.vite.config.ts:24-30` |
| 插件 `ctx.ipc.handle(method, fn)` 的回调**拿不到调用方 webContents/tabId** | `src/main/plugins/kernel.ts:400-412` |
| `ctx.ipc.emit(event, payload)` → `kernel.broadcastPluginEvent` → broadcaster,投递面 = chrome + overlay + **所有 internal 标签页** | `src/main/plugins/kernel.ts:212-214`、`src/main/index.ts:156-162`、`src/main/ipc.ts:31-35` |
| `plugins:invoke` 的 handler 有 `event` 但当前丢弃(`_e`) | `src/main/ipc.ts:150-152` |
| 标签生命周期事件 `tab:closed {TabInfo}` 已发布给插件总线 | `src/main/index.ts:169-172` |
| `before-input-event` 对**所有** webContents 全局拦截 Ctrl+T/W/L/数字/,,命中即 `preventDefault` | `src/main/tabShortcuts.ts:47-105` |
| 快捷键判别是纯函数,action 有 `new/restore/close/switch/settings/focus-address` | `src/shared/shortcuts.ts:24-60` |
| 渲染层插槽只有 `toolbar` / `addressbar-trailing`,加按钮 = 登记 `registry.ts` 一行 | `src/renderer/src/plugins/{types,registry}.ts` |
| 插件边界由测试强制:`main.ts` 不引 `.vue`/`@renderer`;`ui.ts` 不引 `electron` | `tests/pluginBoundaries.test.ts` |
| 打包自检从 `out/main/index.js` 扫外部 require,逐个核对 asar 内 `node_modules/<pkg>` | `scripts/verify-dist.mjs:113-122` |
| `npmRebuild: false`;bun 的脚本白名单只有两个 esbuild | `package.json` |
| node-pty 运行时加载顺序 `build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>`;`install` 脚本是 `node scripts/prebuild.js \|\| node-gyp rebuild`(prebuilds 在则**不编译**);binding.gyp 用 `node-addon-api`(N-API) | node-pty@1.1.0 的 `lib/utils.js` / `package.json` / `binding.gyp` |

## 2. 架构决策

1. **终端页 = 新的内部页面 `bow://terminal`**,由标签页承载。理由:`create()` 对内部页面已经通用(只要 `INTERNAL_PAGES` 加一条 + 一个渲染入口),
   天然可多开、可分屏、可 `Ctrl+Shift+T` 恢复、MCP 页面工具自动跳过(`internal: true`)—— 无需改内核的标签创建路径。
2. **会话按 tabId 绑定**,不用 sessionId 做主键:标签刷新/崩溃重建时能**复用同一 pty 并回放**最近输出;
   标签关闭(订阅 `ctx.events.on('tab:closed')`)时 kill。
   页面自己拿 tabId 需要一条核心 IPC `tab:self`(`event.sender` → `TabManager` 反查),约 10 行。
3. **主进程→页面用广播,不新增定向通道**:终端数据 `ctx.ipc.emit('data', {tabId, chunk})` 经现有 broadcaster
   到达所有 internal 页(含终端页),各页面**按自己的 tabId 过滤**。代价是多开 N 个终端时同一份数据发 N 次(小);换来内核零新增发送能力。
   插件侧做 ~8ms 合批,避免 `npm install` 式高频输出把 IPC 打爆。
4. **上行(按键/resize)用现有 `plugins.invoke`**,不引入单向通道:一次按键一个 round-trip 对人是无感的,`void` 掉 Promise 即可。
5. **地址栏输入 `bow://terminal` 也应当新开**(而不是像设置页那样聚焦已有的):给 `INTERNAL_PAGES` 加 `singleton` 字段(settings=true、terminal=false),
   `openInternal()` 据此分支。`Ctrl+Shift+T` 恢复、MCP `browser_new_tab` 本来就走 `create()`,不受影响。

## 3. 文件改动清单

### 新增

| 文件 | 内容 |
| --- | --- |
| `src/plugins/terminal/shared.ts` | 纯逻辑(同构、可单测):`TerminalSettings`/`TerminalProfile` 类型、`DEFAULT_SETTINGS`、`normalizeSettings()`、`profileCandidates(platform)`、`buildSpawnSpec(profile, homedir)`、`cleanEnv(env)`、回放缓冲 `pushReplay(clone, chunk, maxBytes)`、`newProfileId()`、`TERMINAL_THEME` |
| `src/plugins/terminal/main.ts` | 插件主进程侧:会话表 `Map<tabId, Session>`、惰性 `await import('node-pty')`、IPC 方法、MCP 无、`tab:closed` 回收、`before-quit` 全量 kill |
| `src/plugins/terminal/ui.ts` | 贡献 `toolbar: [TerminalButton]` + `settingsSections: [TerminalSettings]`(**不**注册 TerminalView,见下) |
| `src/plugins/terminal/ui/TerminalButton.vue` | lucide `SquareTerminal`,点击 `api.createTab(TERMINAL_URL)` |
| `src/plugins/terminal/ui/TerminalView.vue` | xterm 实例、fit、attach/write/resize、复制粘贴、断线提示。**只被 `renderer/src/terminal` 引用**,因为它是内部页面的视图而非插件插槽组件 |
| `src/plugins/terminal/ui/TerminalSettings.vue` | 字体族 / 字号 / 滚动缓冲 + profile 列表(增删改、设默认),全部即时保存 |
| `src/renderer/terminal.html` | 抄 `settings.html` 的 CSP 结构,`<script type="module" src="/src/terminal/main.ts">` |
| `src/renderer/src/terminal/main.ts` | `createApp(TerminalApp).mount('#app')` + `import '@xterm/xterm/css/xterm.css'` + `../style.css` |
| `src/renderer/src/terminal/TerminalApp.vue` | 薄壳:`<TerminalView />`(将来放标题条/重连提示时不用动视图) |
| `tests/terminalShared.test.ts` | shared 纯逻辑单测 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/shared/internalPages.ts` | `InternalPageId` 加 `'terminal'`;`INTERNAL_PAGES` 加 `{ terminal: { url: TERMINAL_URL, title: '终端', entry: 'terminal', singleton: false } }`;settings 补 `singleton: true`;导出 `TERMINAL_URL` |
| `src/main/rendererEntry.ts` | `RendererEntryName` 加 `'terminal'`(dev → `${dev}/terminal.html`,prod → `../renderer/terminal.html`) |
| `electron.vite.config.ts` | `rollupOptions.input` 加 `terminal: resolve('src/renderer/terminal.html')` |
| `src/main/tabManager.ts` | ① `TabRecord`/`views` 上加 `findTabIdByWebContents(wc)`;② `openInternal()` 读 `INTERNAL_PAGES[page].singleton` 分支(单例 → 聚焦已有;否则 `create(internalPageUrl(page), true)`) |
| `src/main/ipc.ts` | 加 `ipcMain.handle('tab:self', (e) => tabs.findTabIdByWebContents(e.sender))`;加 `clipboard:read-text` / `clipboard:write-text`(Electron `clipboard` 模块,避免 renderer 剪贴板权限问题) |
| `src/preload/index.ts` | `BrowserAPI` 加 `getSelfTabId()` / `readClipboardText()` / `writeClipboardText(text)`(三个 invoke) |
| `src/shared/shortcuts.ts` | 加纯函数 `releasesToTerminal(hk: TabHotkey): boolean` = `hk.action === 'close' \|\| hk.action === 'focus-address'` |
| `src/main/tabShortcuts.ts` | 命中快捷键后先判「活动标签是终端页」(`parseInternalUrl(active.url) === 'terminal'`)且 `releasesToTerminal(hk)` → **不 preventDefault、直接 return**(把 Ctrl+W 删词、Ctrl+L 清屏还给 shell) |
| `src/main/plugins/builtin.ts` | `BUILTIN_PLUGINS` 末尾加 `terminal`(与 device-inspect 一样不参与 net/suggest 次序) |
| `src/renderer/src/plugins/registry.ts` | `PLUGIN_UI` 加一行;`SLOT_PLUGIN_ORDER.toolbar` 末尾加 `'terminal'`(排在元素全屏右侧、设备检查左侧) |
| `package.json` | `dependencies` 加 `@xterm/xterm`、`@xterm/addon-fit`、`node-pty`;`build.asarUnpack: ["**/node_modules/node-pty/**"]`(原生模块与 conpty.dll 必须解包) |
| `tests/internalPages.test.ts` | 补 `terminal` 的往返一致 + 两个页面 `singleton` 的断言 |
| `tests/shortcuts.test.ts` | 补 `releasesToTerminal()` 的用例 |

## 4. 契约细节

### 4.1 设置数据(`<userData>/terminal.json`,插件 storage)

```ts
interface TerminalProfile { id: string; name: string; shell: string; args: string[]; cwd: string }
interface TerminalSettings {
  version: 1
  defaultProfileId: string
  fontFamily: string        // 默认 'Consolas, "Cascadia Mono", "Microsoft YaHei", monospace'
  fontSize: number          // 默认 14(夹紧 8..32)
  scrollback: number        // 默认 5000(夹紧 200..50000)
  profiles: TerminalProfile[]  // 至少 1 条;id 唯一
}
```
Windows 预设候选(`profileCandidates('win32')`,设置页「添加配置」里列出):`powershell.exe` / `pwsh.exe -NoLogo` /
`cmd.exe` / `wsl.exe --cd ~` / `C:\Program Files\Git\bin\bash.exe --login -i`;其它平台 `$SHELL`、`/bin/bash -l`、`/bin/zsh -l`。
`wsl.exe` 用 `--cd ~` 而不是 set `cwd`(WSL 的 `~` 只有 wsl.exe 认)。

### 4.2 插件 IPC(`window.browserAPI.plugins.invoke('terminal', method, ...)`)

| method | 参数 | 返回 |
| --- | --- | --- |
| `getSettings` | — | `TerminalSettings` |
| `setSettings` | `patch` | 规范化后的 `TerminalSettings`(并广播 `settings-changed`) |
| `listCandidates` | — | `{ profile, available }[]`(PATH / 常见路径探测,纯 fs,不 spawn) |
| `attach` | `{ tabId, cols, rows }` | `{ ok, profileName, replay, render: { fontFamily, fontSize, scrollback } }` 或 `{ ok:false, error }` |
| `write` | `tabId, data` | `true`(会话不存在时静默 false) |
| `resize` | `tabId, cols, rows` | `true` |
| `detach` | `tabId` | `true`(只摘监听,不 kill —— 刷新要复用会话) |

主进程 → 页面的广播(`plugins.onEvent`):`data {tabId, chunk}`、`exit {tabId, code}`、
`settings-changed {fontFamily,fontSize,scrollback}`、`session-closed {tabId, reason}`(插件停用/kill 时)。

### 4.3 渲染侧行为

- 挂载:`term = new Terminal({ fontFamily, fontSize, scrollback, theme: TERMINAL_THEME, cursorBlink: true, allowProposedApi: false })`
  → `loadAddon(fit)` → `open(container)` → `fit()` → `const tabId = await api.getSelfTabId()`(null 则显示错误) → `attach({tabId, cols, rows})`
  → `term.write(replay)`。
- `onData` → `void invoke('write', tabId, data)`;`fit()` 后 `invoke('resize', tabId, cols, rows)`;`ResizeObserver` + `window.resize` 驱动重排(分屏切半会触发页面 resize)。
- `attachCustomKeyEventHandler`:`Ctrl+Shift+C` 复制选区、`Ctrl+Shift+V` 粘贴(走 `readClipboardText/writeClipboardText`),`return false` 阻止 xterm 把组合当输入。
- 未加载 node-pty / 插件被停用 → 容器上盖一条提示,不白屏。
- `document.title = '终端'`;调试把 `window.__bowTerminal = { term, fit, send }` 暴露出来(供 CDP E2E 断言,内部页面无安全风险)。
- `onBeforeUnmount` 清理:dispose term、取消订阅、`detach`。

## 5. 实施步骤(每步独立可验)

**S0 · 依赖与原生模块可行性(先验,不动仓库逻辑)**
Windows 侧项目目录执行 `bun add @xterm/xterm @xterm/addon-fit` 与 `bun add node-pty`(`allowScripts` **不**加 node-pty,
故意跳过 `prebuild.js`/`node-gyp`,prebuilds 已在包内)。验证:
`node -e "const p=require('node-pty');const t=p.spawn(process.env.COMSPEC||'cmd.exe',[],{cols:80,rows:24,cwd:process.env.USERPROFILE||'.'});t.onData(d=>process.stdout.write(d));setTimeout(()=>{t.kill();process.exit(0)},1200)"`
→ 看到 `cmd` 提示符。失败 → §7 的回退。

**S1 · `bow://terminal` 登记**(`internalPages.ts`、`tests/internalPages.test.ts`)→ `bun run test -- internalPages`
**S2 · 渲染入口**(`terminal.html`、`renderer/src/terminal/*`、`rendererEntry.ts`、`electron.vite.config.ts`)→ `npx electron-vite build` 后有 `out/renderer/terminal.html`
**S3 · 核心 IPC**(`tabManager.findTabIdByWebContents`、`ipc.ts` 三条、`preload` 三个方法)→ `bun run typecheck`
**S4 · 插件骨架**(`src/plugins/terminal/{shared,main,ui}.ts`、`builtin.ts`、`registry.ts`、单测)→ `bun run test` 全绿
**S5 · 快捷键放行**(`shared/shortcuts.ts` + `tabShortcuts.ts` + 单测)→ 终端页里 Ctrl+W/Ctrl+L 不再关标签/聚焦地址栏
**S6 · 终端视图**(`TerminalView.vue` 完整实现)→ 手动:开终端、`echo hi`、`ls`、方向键/历史、`Ctrl+C`、缩放窗口后 `stty size` 跟随
**S7 · 设置页分区**(`TerminalSettings.vue`)→ 改字号后已开的终端立即变化(走 `settings-changed`);改默认 shell 后新终端生效
**S8 · 打包**(`package.json` 的 `asarUnpack`;Windows 侧 `npm run dist`)→ `node scripts/verify-dist.mjs` 通过 + **双击 bow.exe 开终端能用**
**S9 · 文档**(见 §8)
**S10 · 真机 E2E**(CDP 脚本,见 §6.2)

## 6. 验证与验收

### 6.1 自动化

- `bun run test`(现有 646 例 + 新增 shared 用例)、`bun run typecheck`、`bun run build` 全过。
- 单测覆盖:`normalizeSettings`(夹紧/去重/至少一条/默认 id 兜底)、`buildSpawnSpec`(cwd 兜底、args 原样)、
  `cleanEnv`(剔除 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS`,设 `TERM`)、`pushReplay`(超限裁剪,保留尾部)、
  `releasesToTerminal`、`internalPages` 的 singleton 语义。

### 6.2 真机 E2E(`/tmp/terminal-e2e.mjs`,沿用既有 CDP 手法)

1. 通过 chrome 页 `browserAPI.createTab('bow://terminal')` 开两个终端标签 → `listTabs` 里两条 `internal: true`、`bow://terminal`(多开断言)。
2. 终端页 target 上 eval:`__bowTerminal.send('echo BOW-TERM-OK\r')` → 轮询 `term.buffer.active` 的 `translateToString()` 出现 `BOW-TERM-OK`。
3. 两个标签各写不同标记 → 各自 buffer 互不含对方的标记(会话隔离)。
4. `__bowTerminal.term.options.fontSize` 在设置页改字号后变化;`.xterm-screen` 的实测宽高随之变化。
5. `stty size`(WSL/bash)或 `[Console]::WindowHeight`(powershell)输出与 `term.rows/cols` 一致(resize 链路)。
6. 关掉一个终端标签 → 另一个不受影响;`tasklist`/`ps` 里对应 shell 进程消失(**pty 不泄漏**)。
7. 关窗口 → 所有 shell 进程消失(退出回收)。

### 6.3 人工

字体(中文字形/等宽)、光标、复制粘贴、`Ctrl+C` 中断、粘贴多行、分屏里终端与网页并排、`Ctrl+Shift+T` 恢复后是新会话。

## 7. 风险与未知

| 风险 | 处置 |
| --- | --- |
| **node-pty 的 prebuilds 不是 N-API**(目录无 ABI 后缀、binding.gyp 用 node-addon-api,二者都指向 N-API,但未真机验证) | S0 第一步就验。失败回退 A:`bunx @electron/rebuild -m node-pty`(Windows 需 VS 2022 + Spectre 库,成本高);回退 B:换 `@homebridge/node-pty-prebuilt-multiarch`(真机可选 prebuild,API 同名) |
| node-pty 1.1.0 的 `prebuilds/` 里**似乎没有 linux 目录**(win32-x64 / darwin-x64 / darwin-arm64 都在,未见到 linux) | 意味着 WSL 里跑 bow 需要本机编译工具链。因此**E2E 主战场放 Windows**;WSL 侧只跑 typecheck/test(不加载原生模块)。若确实要在 WSL 跑,S0 记录结论并补 `sudo apt install build-essential python3` |
| 在 WSL 侧 `bun install` 时 node-pty 的 install 脚本 | `allowScripts` 白名单里**不加** node-pty → bun 跳过脚本 ⇒ 不会触发 node-gyp;prebuilds 已在包内,Windows 运行时直接命中 |
| asar 内加载 `.node` | 显式 `asarUnpack: ["**/node_modules/node-pty/**"]`;`verify-dist.mjs` 只读 asar 头部,unpack 条目仍在头里(仍会通过),但**必须**跑一次真实打包 + 双击验收 |
| 广播式数据流在多终端下浪费 | 插件侧 8ms 合批 + 只在 attach 时绑定;超过 `MAX_SESSIONS`(12)拒绝新建并提示 |
| Ctrl+W 在终端里不再关标签(UX 变化) | 有意的:终端里 Ctrl+W 是「删词」。关闭仍可用 × / 中键;文档写明 |
| xterm 6.0 的 breaking(viewport/scrollbar、`windowsMode` 移除等) | 只用 `open/write/onData/options/fit`,不碰这些选项;S6 真机回归 |
| 无 GPU 环境(本机记录过) | 不加 `@xterm/addon-webgl`,用默认渲染器 |

## 8. 文档更新

- `README.md`:「插件体系」(终端加入内置清单)、「数据存储」加 `terminal.json`、「设置页」加「终端」分区、
  「手动使用快捷键」补终端里的键位约定(Ctrl+W/Ctrl+L 归 shell、Ctrl+Shift+C/V 复制粘贴)、
  「技术栈」提一句 node-pty 是唯一原生依赖、「打包成 bow.exe」的坑里补「原生模块需 asarUnpack」。
- `docs/ARCHITECTURE.md`:§1 目录地图(新渲染入口 + 插件)、§4 内部页面(两个 id + `singleton` 语义)、
  §5.8 贡献矩阵(主进程侧 + 渲染层侧各一行)、§7.1 preload 新增 3 个方法、§7.2 四个渲染入口、
  §7.3 设置页分区、§8 存储、§9 IPC 通道表(3 条 invoke)、§11 构建(原生依赖说明)。
- `.pi/plans/2026-09-19-terminal-plugin/plan.md`(本文件)+ 完成后按仓库惯例拆提交(`feat` + `docs` + `docs(plans)`)。

## 9. 明确不做

- 不做 MCP 终端工具(AI 不能通过 MCP 执行本机命令)。
- 不做终端内部的 tab / 分屏 / 面板;不做 overlay 形态。
- 不做光标样式/行高/字距/配色主题(留给以后)。
- 不做会话持久化(不重启后恢复)、不做终端搜索/链接点击/图片协议(sixel/kitty)。
- 不改 MCP 核心工具签名,不动现有插件的任何行为。

---

## 10. 实施记录(2026-09-19 完成)

### 10.1 与原计划的偏差(3 处)

1. **`applyBrowserIdentity()` 加了 userData 逃生口**(`src/main/ua.ts`):存在 `--user-data-dir=…` 或
   `BOW_USER_DATA_DIR` 时不再把 userData 钉回 `appData/mcp-browser`。原计划没这一条 —— E2E 时才发现:
   钉 userData 使隔离目录失效 ⇒ 单实例锁撞上用户**正在跑的 bow** ⇒ 测试实例直接 `app.quit()`,根本跑不起来。
   默认行为零变化(只有显式要求时才跳过)。
2. **Windows 下会话回收先 `taskkill /T /F` 再 `pty.kill()`**(`plugins/terminal/main.ts` 的 `killTree`):
   ConPTY 的 `kill()` 会 fork `conpty_console_list_agent` 去 `AttachConsole`,在 GUI 进程里**必然失败**
   (每关一个终端一条红色堆栈),兜底退化成 5s 超时后只 kill `innerPid` → shell 里的子进程树可能残留(典型 `npm run dev`)。
3. **修了 `scripts/lib/externalRequires.mjs` 的扫描盲区**:它原来只认 `require("x")` 与 `from "x"`,而 node-pty 是
   `await import('node-pty')` —— 万一打包漏装它,`verify-dist` **不会报错**。现在动态 `import()` 也扫
   (`tests/bundleScan.test.ts` 补了用例)。

### 10.2 验证结果

- `bun run typecheck` / `bun run build` 通过;**39 文件 / 681 用例全绿**(新增 35 例:terminalShared 28、internalPages 3、shortcuts 2、bundleScan 2)。
- **最大的假设已证实**:win32 prebuild 是纯 N-API 二进制(只有 `napi_*` 导入、零 V8 / `NODE_MODULE_VERSION` 符号),
  Electron 44.4.3(Node 24.21.0)直接 `require('node-pty')` + `spawn('cmd.exe')` 跑通、echo 回传 —— 不需要
  `@electron/rebuild`、不需要 VS 工具链。`prebuilds/` 里只有 win32-x64/win32-arm64/darwin-x64/darwin-arm64(**无 linux**)。
- **真机 CDP E2E(Windows 侧 `bun.exe D:/tmp/terminal-e2e.mjs`,隔离 `--user-data-dir`)**:**21/21 通过,跑了两遍**。
  关键判据:xterm 量到 164x42(窗口尺寸)、`echo BOW-TERM-OK` 进 xterm 缓冲、两个终端会话互不含对方标记、
  字号 14→20 即时生效且落盘、候选 shell 探测对(`pwsh.exe` 未装被正确标 false)、关标签后该会话 `write` 返回 false
  而另一个不受影响、标签标题被页面接管为「终端 — Windows PowerShell」。
- **打包验收**:`npm run dist` 通过;`verify-dist` 报「运行时外部依赖 3 个:@modelcontextprotocol/sdk, node-pty, zod」
  (node-pty 正是新扫出来的那一个);`node-pty` 落到 `resources/app.asar.unpacked/node_modules/node-pty/…`;
  **双击版实跑**——`dist/win-unpacked/bow.exe` 开终端 + echo 回显 **2/2 通过**(asar.unpacked 生效)。

### 10.3 没能自动验证的(需真人一次)

- **Ctrl+W / Ctrl+L 真的落到 shell**:CDP 的 `Input.dispatchKeyEvent` **不触发** `before-input-event`,
  放行逻辑只有单测(`releasesToTerminal`)与「终端标签 URL 判据」的间接断言。请真人按一下确认「Ctrl+W 删词而不是关标签」。
- 中文/emoji 宽字与粘贴多行、分屏里终端与网页并排的观感、字体族实测(Cascadia Mono 等)。
- WSL / Git Bash 配置的**实际启动**(候选探测已验,两个没逐个跑)。
- 窗口 resize 时 `stty size` 与 `term.rows/cols` 一致(strategy 已在 `refit()` 里接线,未做自动断言)。

### 10.4 环境注记(下次在 Windows 侧装依赖时)

- Windows 侧 `bun install --ignore-scripts` 会**跳过 electron 的 postinstall** → `node_modules/electron/dist` 缺失,
   `electron.exe` 不存在。补法:`node scripts/ensure-electron.mjs`(走镜像)。
- Windows 侧 bun 1.3.14 读不了 WSL bun 1.4.0 写的 `bun.lock`(`UnknownLockfileVersion` → 忽略并按
  `package.json` 重新解析、重写目标端 lockfile)。两边的 lockfile 会因此不一致(不影响运行,也不影响 wsync 的单向同步)。
- E2E 脚本(不入库):`D:/tmp/terminal-e2e.mjs`(功能)、`D:/tmp/bow-dist-e2e.mjs`(打包版)、`D:/tmp/pty-smoke.cjs`(ABI 最小验证)。
