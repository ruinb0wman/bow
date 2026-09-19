# 让 bow 成为默认浏览器 + 支持打开本地 html 等文件

> 目标(两行):① 桌面/其它应用点链接或双击 html 时由 bow 打开(http/https + text/html + xhtml 四类默认关联);
> ② bow 支持打开本地文件 —— 命令行参数、文件管理器「用 bow 打开」、地址栏输入路径,都以**新标签**打开本地 `file://` 页面。
>
> 已确认的决策(用户选择):
> - 启动器形态 = **开发态包装脚本**(`~/.local/bin/bow` → `node <repo>/scripts/open-bow.mjs "$@"`,不动打包);
> - 关联范围 = **最小集**(`x-scheme-handler/http`、`x-scheme-handler/https`、`text/html`、`application/xhtml+xml`);
> - **不**放开 MCP 的 `file://`(`src/main/mcp.ts:172`、`:461` 的校验与 `tests/mcpServer.test.ts:233` 的断言保持原样);
> - 本地文件访问**不**记入历史(history 插件 `isHttpUrl` 过滤保持原样)。
>
> 我做的一个假设:不需要在设置页里放「设为默认浏览器」按钮(注册走一次性脚本),也不接管 pdf/图片等其它类型。

## 0. 已核实的环境事实(决定了方案形状)

| 事实 | 证据 | 影响 |
| --- | --- | --- |
| Arch Linux + COSMIC 桌面 | `/etc/os-release`;`~/.config/cosmic/` | 走 freedesktop `.desktop` + `mimeapps.list` |
| **没有 xdg-utils** | `/usr/bin/xdg-open`、`xdg-mime`、`xdg-settings` 均不存在 | `app.setAsDefaultProtocolClient()` 在这台机器上必然失败 → 必须自己写 `.desktop` 与 `mimeapps.list` |
| 没有 `~/.local/share/applications` | `ls` 报 No such file | 脚本要自己建目录 |
| 没有 `~/.config/mimeapps.list` | read 报 ENOENT | 首次写入时新建,不用做合并兼容 |
| `~/.local/bin` 已在 PATH 里 | `~/.zshrc:122` | 包装脚本放这里,终端里可直接 `bow file.html` |
| 已有同类先例 | `~/.local/bin/terminal-browser` = `#!/bin/sh` + `exec ".../app/bin/terminal-browser" "$@"` | 包装脚本风格照抄这个 |
| `update-desktop-database` 存在 | `/usr/bin/update-desktop-database` | 注册后可刷新缓存 |
| Electron 44.3.0,`chrome-sandbox` 非 setuid | `node_modules/electron/dist/{version,chrome-sandbox}` | 靠 userns 跑(现在就能跑,不用改) |
| `app.setDesktopName()` 存在 | `node_modules/electron/electron.d.ts:1738`,注释明确:该值 = Wayland `app_id` / X11 `WM_CLASS`,**且必须在 ready 之前调用** | 与 `package.json` 里已有的 `build.appId: com.ruinb0w.bow` 对齐,窗口分组/图标才不会飘 |
| MCP 走常驻 HTTP 端点 | `~/.pi/agent/mcp.json` → `http://127.0.0.1:8765/mcp` + `lifecycle: keep-alive` | 桌面启动的实例也会自动开这个端点(插件默认开启),与现有用法兼容 |

## 1. 现状(从代码读到的、必须改的地方)

1. **argv 被完全丢弃** — `src/main/index.ts:58`:
   ```ts
   app.on('second-instance', () => {
     focusFirstWindow(BrowserWindow.getAllWindows())
   })
   ```
   第二个实例带来的文件/URL(文件管理器「用 bow 打开」、终端 `bow x.html`)只被用来聚焦窗口,参数没人看。

2. **首个标签固定开主页** — `src/main/index.ts:169`:
   ```ts
   mainWindow.webContents.on('did-finish-load', () => {
     // 首个标签加载主页
     if (tabs.listTabs().length === 0) {
       const homepage = getSettingsStore().get().homepage
       tabs.create(homepage)
     }
   })
   ```

3. **地址栏不认识本地路径** — `src/shared/url.ts:41` 的 `DOMAIN_RE` 会把 `file.html` 判成域名 → `https://file.html`;`/home/me/a.html` 则落到 `{kind:'search'}` 去搜索。`src/main/ipc.ts:47` 直接调 `resolveNavigation(input, ...)`。

4. **非 http 的外链被推给系统** — `src/main/index.ts:87`:
   ```ts
   if (/^https?:/i.test(url)) { tabs.create(url); return { action: 'deny' } }
   shell.openExternal(url)
   ```
   页面里指向本地文件的 `target=_blank` 会走 `shell.openExternal` → 而这台机器没有 `xdg-open` → 静默失败。应把 `file:` 也纳入 `tabs.create`。

5. **启动器会把文件参数当成「模式」** — `scripts/open-bow.mjs:31`:`const mode = (argv.find((a) => !a.startsWith('--')) ?? '').toLowerCase()`,`:33` 非 `stdio/http` 直接 `process.exit(1)`;`:69` 的参数是 `['.', ...BOW_ELECTRON_ARGS]`,没有透传入口。

6. `TabManager.create/openUrl/navigate`(`src/main/tabManager.ts:144/268/334`)本身**不限制 scheme**,`loadURL('file:///…')` 可用;`parseInternalUrl`(`src/shared/internalPages.ts:24`)只认 `bow://`,不会误吞 `file://`。→ 应用内导航侧不需要动。

## 2. 要改/新增的文件与原因

### 应用侧(新增 3 个模块,全部不 import electron,便于单测)

**`src/shared/localFile.ts`(新)— 纯逻辑**
- `looksLikeLocalPath(input: string): boolean`:命中 `file://`、`/abs`、`~/…`、`./…`、`../…`、Windows `C:\`。
- `expandHome(input: string, home: string): string`(`~` / `~/x`,`~user` 不处理)。
- 放在 shared 是为了 `tests/localFile.test.ts` 能直接测(renderer 侧不引用也无副作用)。

**`src/main/navInput.ts`(新)— 地址栏输入的「本地路径」分支**
```ts
export interface NavInputDeps { exists(p: string): boolean; home: string; cwd: string }
export function resolveNavigationWithFiles(input, engine, deps): ResolveNavigationResult
```
- `looksLikeLocalPath(input)` → 展开 `~`、相对 `cwd` 解析、`exists` 为真 → `{parsed:'url', url: pathToFileURL(abs).href}`;
- 否则**原样委托** `shared/url.ts` 的 `resolveNavigation`(保证 `file.html` → 搜索/域名、以及 `bow://settings` 的行为零变化);
- 路径不存在时也走委托(变成搜索,与 Chrome 一致)。
- 依赖注入而非直接 `fs`,使 `exists` 可在测试里造假(vitest 是 node 环境,但 electron 模块在测试里不可 import)。

**`src/main/openArgs.ts`(新)— 启动参数 → 待打开目标**
```ts
export interface OpenTargetDeps {
  existsSync(p: string): boolean
  isDirectory(p: string): boolean
  home: string
  cwd: string
}
export function collectOpenTargets(argv: string[], skip: number, deps: OpenTargetDeps): string[]
```
规则:
- 丢掉前 `skip` 个(`electron .` 的 dev 形态是 2,打包后是 1);
- 丢掉 `--*` 开关(Chromium/Electron 的自家 flag 不算文件);
- 带 scheme:`http:`/`https:`/`file:` **原样保留**;其它 scheme(`mailto:` 等)记日志忽略;
- 裸路径:`~` 展开 → 相对 `cwd` 解析(第二实例要用事件给的 `workingDirectory`)→ `existsSync` 且**不是目录**才保留(目录忽略并记日志,不做递归、不调 `shell.openPath`);
- 去重后返回(按输入顺序,保持"第一个参数先开")。

### 接线改动

**`src/main/index.ts`**
- 顶层(与 `:45` 的 `appendSwitch` 同一批,ready 之前):
  ```ts
  if (process.platform === 'linux') app.setDesktopName('com.ruinb0w.bow')
  app.commandLine.appendSwitch('allow-file-access-from-files') // 本地 html 的相对资源/模块脚本
  ```
- 顶层计算一次 `initialTargets`(stdio 模式必须为空):
  `const initialTargets = IS_MCP_STDIO ? [] : collectOpenTargets(process.argv, app.isPackaged ? 1 : 2, deps)`
  (`deps` 用 `existsSync`/`statSync().isDirectory()`/`os.homedir()`/`process.cwd()`)。必须放在 ready 之前或最靠前的同步段 —— 因为 stdio 模式下 argv 由 MCP 客户端拼接,绝不能当文件打开。
- `app.on('second-instance', (_e, argv, cwd) => …)`:先 `focusFirstWindow(...)`,再 `if (!IS_MCP_STDIO && tabs) for (const t of collectOpenTargets(argv, app.isPackaged ? 1 : 2, {...deps, cwd}) ) tabs.create(t)`;
  `tabs` 尚未赋值时(`second-instance` 早到)只聚焦,不崩(加 `if (!tabs) return`)。
- `did-finish-load` 的首页逻辑:`initialTargets.length ? initialTargets.forEach(t => tabs.create(t)) : tabs.create(homepage)`。放在这里而不是更早,是为了保证 `registerIpc()`(`src/main/ipc.ts`)已把 `tabs-changed` 广播挂上。
- `setWindowOpenHandler` 的正则改为 `/^(https?|file):/i`(本地文件的 `target=_blank` 也进标签,不再依赖缺失的 `xdg-open`)。

**`src/main/ipc.ts`**
- `nav:go` 换成 `resolveNavigationWithFiles(input, engine, { exists: existsSync, home: homedir(), cwd: process.cwd() })`;其余分支(内部页面、`search:performed` 事件)不动。

### 启动器与注册(脚本侧)

**`scripts/open-bow.mjs`**
- 模式判定收紧为「第一个参数精确等于 `stdio`/`http` 才算模式」,其余参数(以及 `--` 之后的全部)**按顺序透传**给 electron:`args = ['.', ...rest, ...BOW_ELECTRON_ARGS]`。
  - 关键:现在传 `/tmp/a.html` 会命中 `:33` 的 `未知模式` 直接退出。
  - `--dry-run` 仍只认自己的开关,并在输出里打印将要传给 electron 的参数(已有)。
- 用法补充:`node scripts/open-bow.mjs -- /tmp/a.html https://example.com`。

**`scripts/install-desktop.mjs`(新,Linux 专用,幂等)**
1. 建目录 + 写包装脚本 `~/.local/bin/bow`(chmod 0755):
   ```sh
   #!/bin/sh
   # bow:browser(由 scripts/install-desktop.mjs 生成,勿手改)
   exec node "/home/ruinb0w/Workspace/browser/scripts/open-bow.mjs" "$@"
   ```
   已存在且不是 bow 生成的内容 → 报错退出,不覆盖。
2. 写 `~/.local/share/applications/com.ruinb0w.bow.desktop`(文件名必须与 `setDesktopName('com.ruinb0w.bow')` 一致):
   ```ini
   [Desktop Entry]
   Type=Application
   Name=bow
   Comment=AI 可操纵的简易浏览器
   Exec=/home/ruinb0w/.local/bin/bow %U
   Terminal=false
   Categories=Network;WebBrowser;
   MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;application/xhtml+xml;
   StartupNotify=true
   StartupWMClass=com.ruinb0w.bow
   ```
3. 按 INI 语义改 `~/.config/mimeapps.list`:**只**动 `[Default Applications]` 下这 4 个键,其余键/段落原样保留;文件不存在就新建;若原值不是我们写的,`--dry-run` 会显示"将要覆盖 xxx=yyy"。
4. `update-desktop-database ~/.local/share/applications`(不存在就跳过)。
5. 检测 `xdg-open`/`xdg-mime` 缺失 → 提示 `sudo pacman -S xdg-utils`(**不**代跑 sudo)。
6. 开关:`--dry-run`(只打印)、`--remove`(删 desktop 文件 + 仅移除值等于 bow.desktop 的键)、`--no-default`(只装 desktop 文件,不改默认应用)、`--exec <path>`(给以后打包产物用)。
7. `package.json` scripts 加 `"install:desktop": "node scripts/install-desktop.mjs"`。

### 测试(新增 3 个,vitest node 环境)

- `tests/localFile.test.ts`:`looksLikeLocalPath` / `expandHome` 的边界(`file.html` 必须为 false;`~/x`、`./x`、`/x`、`file:///x` 为 true)。
- `tests/openArgs.test.ts`:`collectOpenTargets` —— dev `skip=2` 时 `['electron','.','/tmp/a.html']`;`--ozone-platform=headless` 被忽略;`https://…` 直传;`file:///tmp/a.html` 直传;`mailto:` 忽略;目录忽略;不存在的路径忽略;`~` 展开;`cwd` 生效;去重。
- `tests/navInput.test.ts`:存在路径 → `file://` URL;不存在 → 回退搜索;`file.html` → 仍走原 `parseInput` 行为(回归保护)。

**不改**:`tests/url.test.ts`、`tests/mcpServer.test.ts`、`tests/singleInstance.test.ts`(前者语义没动,后两者是本次明确不动的边界)。

### 文档

- `README.md`:「启动」清单加 `npm run install:desktop`;新增小节「作为默认浏览器 / 打开本地文件」(注册命令、卸载、`bow` 包装脚本、命令行与地址栏两种用法、`xdg-utils` 提示、已知限制)。
- `docs/ARCHITECTURE.md`:`§2` 文件地图加 `main/openArgs.ts`、`main/navInput.ts`、`shared/localFile.ts`;`§9` IPC 表 `nav:go` 行注明"本地路径由 `navInput.ts` 兜底";`§10` 加 `--allow-file-access-from-files` 与 `setDesktopName('com.ruinb0w.bow')`;`§11` 脚本表加 `install-desktop.mjs` + `npm run install:desktop`;`§12` 若本次发现新漂移就补行。
- `.pi/skills/bow-browser/SKILL.md` 不涉及(工具面没变)。

## 3. 实施顺序(每步可独立验证)

1. `src/shared/localFile.ts` + `tests/localFile.test.ts` → `npm test`(只跑新用例)。
2. `src/main/navInput.ts` + `tests/navInput.test.ts`。
3. `src/main/openArgs.ts` + `tests/openArgs.test.ts`。
4. 接线 `src/main/index.ts`(setDesktopName / 开关 / initialTargets / second-instance / did-finish-load / setWindowOpenHandler)+ `src/main/ipc.ts`(nav:go)→ `npm run typecheck && npm test`。
5. `scripts/open-bow.mjs` 参数透传 → `node scripts/open-bow.mjs --dry-run -- /tmp/a.html` 看输出里 argv 正确。
6. `scripts/install-desktop.mjs` + `package.json` 的 `install:desktop` → `node scripts/install-desktop.mjs --dry-run` 检查 4 个文件/键的最终内容;再 `--dry-run --remove` 检查回滚内容。
7. 文档(README / ARCHITECTURE)。
8. 真机验证(见 §4),最后才真正执行 `npm run install:desktop`。

## 4. 验收方式(真机)

- `npm run build && node scripts/open-bow.mjs -- /tmp/bow-local-test.html` → 新标签打开该文件;用 MCP 的 `browser_eval` 读 `document.title` 与 `location.href` 应为 `file:///tmp/bow-local-test.html`。
- 再跑一次 `node scripts/open-bow.mjs -- /tmp/bow-local-test2.html`:不新开进程(单实例),已有窗口**新增**一个标签(而不是顶掉当前页)。
- 地址栏输入 `/tmp/bow-local-test.html` → 打开文件;输入 `file.html` → 仍是搜索/域名行为不变。
- `npm run install:desktop` 后:`grep -n "text/html" ~/.config/mimeapps.list` 与 `ls ~/.local/share/applications/com.ruinb0w.bow.desktop`;COMSIC 的「默认应用」里能看到 bow 且可被改回。
- 窗口分组/图标:`setDesktopName` 生效后,任务栏里 bow 与 `com.ruinb0w.bow.desktop` 对应(否则退化成 generic icon)。
- 回归:`npm run test:mcp`(确认 stdio 模式的 argv 没有被误当文件打开)。

## 5. 风险与未知(需要实现时实测,不要想当然)

1. **本地 html 的 ES module / fetch**:Chromium 对 `file://` 是 opaque origin,`<script type="module" src="./x.js">` 与 `fetch()` 会被 CORS 拦(相对路径的 `<img>/<link>/<script>` 正常)。计划里加了 `--allow-file-access-from-files`,**该开关能否救回模块脚本要在第 8 步实测**;若不行 → 本次记为已知限制并写进 README,后续用自定义 `bow-local://` 协议解决(不在本次范围)。
2. **`setDesktopName` 在 COSMIC/Wayland 下的实际 app_id**:d.ts 写明它同时决定 Wayland app_id 与 X11 WM_CLASS,但 COSMIC 是 Wayland 合成器,分组/图标效果需实机确认;若分组仍不对,退路是给 `.desktop` 加 `StartupWMClass`(已包含)或在 `package.json` 里加 `desktopName`。
3. **没有 xdg-utils**:第三方应用(以及 bow 自己的 `shell.openExternal`)靠 `xdg-open` 拉起;不装的话"别人调到 bow"这条路只有 `%U` 直连 desktop 文件的应用能用。建议用户手动 `sudo pacman -S xdg-utils`(agent 不代跑 sudo)。
4. **`%U` vs `%F`**:`Exec` 用 `%U` 时启动器可能传 `file:///…` URI,也可能传裸路径(不同实现不同)—— `collectOpenTargets` 两种都处理,并有单测覆盖。
5. **dev 与未来的打包产物共用 userData**(`src/main/ua.ts` 把 userData 钉到 `mcp-browser`)→ 单实例锁同一把:桌面启动会被已在 dev 模式运行的实例接管(只聚焦+加标签),这是期望行为,但调试时要意识到"代码改了得重启那个进程"。
6. **`--allow-file-access-from-files` 是进程级开关**,会放宽所有 `file://` 文档的本地文件互访;http(s) 页面加载 `file://` 仍被 Chromium 拒绝,风险可接受但不为零。
7. `navInput.ts` 的 `exists` 检查发生在主进程,**地址栏输入一个敏感路径会在历史/日志层面留下痕迹吗**:当前 history 插件只记 http(s)(本次指定保持),`log()` 不打地址栏输入 → 无新增泄漏面。
