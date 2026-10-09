# 文件管理插件(LLM 可操作的本地文件 + 网页上传)

日期:2026-10-09　模式:plan(只读调查,未改任何代码)→ **build(步骤 0~2 已实施)**

> ## 实施状态(2026-10-09)
>
> **已做**
> - **步骤 0~2**(保守切法,全程零 CDP):`src/plugins/files/`(main / shared / ui / ui/FilesSettings.vue)、
>   `src/main/plugins/fileRoots.ts`(核心策略)、`builtin.ts` + `registry.ts` 登记、`MCP_INSTRUCTIONS` 加「本地文件」一节。
> - **步骤 3(浏览面板,也零 CDP)**:`ui/FilesPanel.vue`(工具栏按钮 + `plugin:files:panel`;roots 下拉 / 面包屑 /
>   新建目录 / 重命名 / 移动到… / 复制到… / 删除 / 打开 / 显示位置 / 文本预览)与 `ui/FilesButton.vue`;
>   `main.ts` 重构成**操作层 + 工具层 + IPC 层**三层 —— 面板与 9 个工具共用同一套操作与 guard(语义只有一份)。
> - 文档同步:README / ARCHITECTURE(§1 §5.8 §6.2 §8 §13)/ bow-browser SKILL。
> - 测试:+3 文件 **90** 用例(`filesShared` 19 / `fileRoots` 26 / `filesPlugin` 45);全量 **67 文件 / 1309 用例** 绿,
>   `typecheck` / `build` 绿。
> - **真机验证两轮**(都用隔离实例 `--user-data-dir=…` + 真 MCP HTTP 端点):
>   - **工具面 18/18**:写 / 拒覆盖 / 原子写不留 `.tmp` / 白名单外与 bow 数据目录被拒 / mkdir /
>     move 进目录 / copy / list(glob+recursive)/ info / 回收站删除 / permanent 开关 / 工作目录本身不许删;
>   - **面板 17/17**(CDP 驱动真窗口:点工具栏按钮 → 读 overlay DOM → 真点一遍):roots 下拉、面包屑、
>     「目录在前」的列表、大小/时间列、7 个工具按钮、提示文案、点文件名出预览、新建目录落盘、重命名落盘、
>     删除两步确认 + 真的进回收站;并截了一张面板图核对排版(见下面的字体说明)。
>
> **未做**:步骤 4/5(`browser_upload` + 接管网站文件选择框)、6(堵 `browser_download.saveDir`)。
> ⇒ **`browser_download {url, saveDir}` 仍是不受白名单约束的写盘旁路**,见 §3.7。
>
> **实施中改掉的一处设计**:`browser_fs_roots` 与 `getSettings` 报的 roots 改成取 `resolveFileRoots()`
> (**guard 真正放行的那份**,每次现读磁盘)而不是内存 store —— 真机验证时发现这两者一旦不同步
> (有人手改 `files-settings.json`),AI 看到的清单就会与守卫不一致(已有回归用例看住)。
>
> **验证环境的一个坑(不是 bug)**:本仓库的 WSL2 开发副本里 `/usr/share/fonts` 只有 Adwaita / gnu-free,
> **一个 CJK 字体都没有** —— 所以 CDP 截图里中文全是豆腐块(整台机任何程序都如此),而 DOM 断言里的文案是对的。
> 排版已通过截图核对;字形渲染只能在你真用 bow 的那台上看(bow 实际跑在 Windows,字体栈里有 'Microsoft YaHei')。

## 1. 目标与假设

### 1.1 要解决的三个问题

| # | 问题 | 现状 |
| --- | --- | --- |
| 1 | LLM 对**本地文件**的增删改查 | **完全缺失**。`browser_eval` 跑在页面 sandbox 里碰不到磁盘;终端插件虽跑着真 shell,但没有 MCP 工具面(`terminal/main.ts` 只有 `getSettings/setSettings/listCandidates/attach/write/resize/detach`),LLM 驱动不了它 |
| 2 | LLM 把本地文件**交给网页**(点上传按钮 → 选文件) | **完全缺失**。全仓库无 `setFileInputFiles`、无文件选择器拦截 |
| 3 | 「下载」有 `browser_download`,但它的 `saveDir` 是**任意绝对路径**(`downloads/main.ts:567` 只校验 `isAbsolute`) | 护栏要能真正拦住这条路,否则只是装饰 |

### 1.2 用户已确认的决策(本次问答)

| 决策点 | 选择 |
| --- | --- |
| 可访问范围 | **白名单根目录**:设置页配置若干工作目录,所有路径 `resolve` + `realpath` 后必须落在其中之一;默认 roots = bow 下载目录 |
| 上传语义 | **在 bow 内部实现网站弹出的文件选择框**(不是把文件发给 LLM) |
| 下载 | 沿用现有 `browser_download`,不重造 |
| 删除/覆盖 | 删除默认 `shell.trashItem` 进回收站;`permanent:true` 要设置开关;**不弹确认框**(不打断自动化) |
| UI | 工具栏按钮 + 浮层面板(`plugin:files:panel`) |

### 1.3 假设(由此推导出后面的设计)

- **A1** 插件 id 取 `files`(满足 `ID_RE=/^[a-z][a-z0-9-]*$/`,`core.ts`)。
- **A2** 「上传」的目标是**真实网站的 `<input type=file>`**,不是「把文件读给 LLM 看存在哪」。所以上传必须有 CDP,不能靠页面脚本。
- **A3** 不引入新依赖:`node:fs` / `node:path` / `electron` / `zod` 已够(`zod` 已在 dependencies,插件工具现用)。
- **A4** 路径校验的纯逻辑必须能在 vitest(node 环境、无 Electron)里跑,所以 `node:path` **不能进** `shared.ts` —— 渲染层也 import 它(`bookmarks/shared.ts` 那种三端安全约定)。
- **A5** 调色:不新增 `PluginCapability` 值(`shared/plugins.ts:12` 是封闭联合,加值要动 labels),本插件用现成的 `ui` + `mcp`。

---

## 2. 现状(实际读到的代码与事实)

### 2.1 新增一个插件要动的固定位置(§5.7 的实现版)

| 位置 | 动作 |
| --- | --- |
| `src/plugins/files/{main.ts,ui.ts,shared.ts,guard.ts,ui/*.vue}` | 新建 |
| `src/main/plugins/builtin.ts` | `BUILTIN_PLUGINS` 末尾追加(不参与网络钩子链与建议源次序,与 `downloads`/`pomo` 同一位置) |
| `src/renderer/src/plugins/registry.ts` | `PLUGIN_UI` 追加一行;`SLOT_PLUGIN_ORDER.toolbar` **追加到末尾**(该常量在 `registry.ts:34`,ARCHITECTURE:563 有它的副本要同步) |
| `tsconfig.node.json` | `include` 里登记 `src/plugins/*/guard.ts`(新文件名;现在是显式白名单式 include) |
| `tests/pluginBoundaries.test.ts` | **自动覆盖**(它 readdir 遍历 `src/plugins/*`),只要守住 `main.ts` 不引 `.vue`/`@renderer`、`ui.ts` 不引 `electron` |
| `tests/pluginUiSlots.test.ts` / `settingsNav.test.ts` / `pluginRegistry.test.ts` | **不用改** —— 三个都是合成夹具,不读真实 `PLUGIN_UI` |
| `tests/mcpServer.test.ts` / `scripts/mcp-smoke.mjs` | **不用改** —— 没有任何工具名/数量断言(grep 确认) |

**主进程不能直接开浮层**:必须 `ctx.ipc.emit(...)`,由 chrome 侧组件收到后在**它所在的那个窗口**开浮层。先例是密码插件:`passwords/main.ts` 发 `open-panel` → `ui/PasswordsButton.vue:35` 订阅 `api.plugins.onEvent` 后 `api.showOverlay({id:'plugin:passwords:panel', placement:'full'})`。
⚠️ `plugin:event` 是**广播到所有窗口**的(ARCHITECTURE:991),所以文件面板必须按 payload 里的 `tabId` 过滤「这个标签是不是我窗口的」,否则多窗口会一起弹。

### 2.2 现成可复用件(不要重写)

- **`src/main/plugins/exportFile.ts`** —— 「核心共享工具读插件设置」的先例,而且正是本次需要的形状:`resolveDownloadsDir()` 直接读 `downloads-settings.json`(不缓存、不持有 store 快照),`dateStamp()`。ARCHITECTURE:69 把它列为「目录解析与下载插件同源」。
- **`src/plugins/logseq/main.ts:347` 的 `assertWritable()`** —— 越界校验的现成写法:
  `const inside = (dir) => abs === dir || abs.startsWith(dir + sep)`
  ⚠️ 但它**没有 realpath**,符号链接可以逃逸;新 guard 要补上这一步(见 §3.2)。
- **同文件 359 起的原子写**:`.tmp-<rand>` → `rename`,`rename` 失败(Windows 文件被占)退化为就地写。
- **`src/main/actions.ts:186` `fullPageScreenshot()`** —— 本地标签临时挂调试器的**完整正确写法**:`if (!dbg.isAttached()) dbg.attach('1.3')` → 用完 `detach()`;别人占着就报错、**不去抢**。上传要走同一条路。
- **`downloads/main.ts:500` 的 `pickDirectory`** —— `dialog.showOpenDialog({properties:['openDirectory']})` 的现成写法,设置页「添加工作目录」照抄。
- **`passwords/shared.ts` + `vault.ts` 的分工** —— 「纯逻辑 / 碰盘 I/O 分离,纯逻辑单测」的模板。

### 2.3 关键事实:Electron 44 没有文件选择器钩子,只能走 CDP

- `node_modules/electron/electron.d.ts` 全文 grep `fileChooser` **0 命中** —— `WebContents` 上没有 chooser 事件,`session.setPermissionRequestHandler` 也管不到它。
- `node_modules/electron/dist/electron` 二进制里存在这些符号(说明 Chromium 侧支持,Electron 只是没暴露):
  `Page.setInterceptFileChooserDialog`、`Page.fileChooserOpened`、`setFileInputFiles`、`enableFileChooserOpenedEvent`、以及字符串 `Intercepted by Page.setInterceptFileChooserDialog().`
- **调试器与 DevTools 互斥**(`electron.d.ts:7540`,Debugger `'detach'` 事件注释原文):
  > Emitted when the debugging session is terminated. This happens either when `webContents` is closed or **DevTools is invoked** for the attached `webContents`.
  → 我们挂着时用户按 F12 会让**我们的会话被终止**(DevTools 赢);反过来 DevTools 开着时 `attach()` 抛错(`actions.ts:196` 已按这个前提写了报错文案)。
- 副作用是好消息:`browser_screenshot {fullPage:true}` 与我们的挂载**不冲突** —— 它是 `if (!dbg.isAttached())` 复用现成会话,`attachedByUs=false` 就不会 detach(`actions.ts:190-198`)。

### 2.4 bow 没有权限系统,护栏只能自己写

- `PluginCapability` **只是 UI 标签**,内核不据此做任何校验(ARCHITECTURE §5.1 的 ⚠️)。
- MCP 工具契约 `McpToolConfig`(`main/plugins/types.ts:21`)只有 `title/description/inputSchema` —— **没有** `readOnly`/`destructive` 标注这东西(那是别的项目的机制);插件工具的 schema 还**不做 strict 校验**(ARCHITECTURE §6.2 末尾:未知参数被静默丢弃)。
- MCP HTTP 端点只监听 `127.0.0.1`,可带 Bearer token,但**默认不开 token**。
- ⇒ 结论:`delete` 的护栏必须(a)写入 guard 代码,(b)写进 `MCP_INSTRUCTIONS`(`src/main/mcp.ts:56` 导出)—— 后者才是 LLM **唯一必读**的行为契约(ARCHITECTURE §6.3 明说「改工具语义时必须同步改它」)。

---

## 3. 设计决策

### 3.1 白名单放哪:插件拥有数据,核心只读共享

- **数据所有权**:`files-settings.json` 由 files 插件用 `ctx.storage<FilesSettings>({file:'files-settings.json', ...})` 持有(唯写者)。
- **只读共享**:新增 `src/main/plugins/fsRoots.ts`(核心 helper,**照 `exportFile.ts` 的样子**),每次 `readFileSync` + `JSON.parse` 现读,不缓存、不写、不持有 store 快照(ARCHITECTURE:397 明说「插件间共享 storage 文件名是错误用法」,但**只读一次**是 exportFile.ts 已经确立的合法用法):

```ts
// src/main/plugins/fsRoots.ts
export function resolveFileRoots(): string[]        // files-settings.json 的 roots;空数组 → [resolveDownloadsDir()]
export function isWithinFileRoots(abs: string): boolean
```

- **谁用**:files 插件自己的 fs 操作;以及 `downloads/main.ts` 的 `saveDir` 校验(§3.7)。
- **否掉**:把白名单放进 core(`src/main/fsPolicy.ts` + 自己的 store + 设置页分区)。更干净,但 v1 就把核心与插件耦合起来,且要动 `stores.ts`/IPC 表;`fsRoots.ts` 完全做到同样的事且零核心改动。等真有第二个想用它的插件再升级。

### 3.2 路径校验(guard)

`src/plugins/files/guard.ts`(主进程侧,可用 `node:path`;纯函数 + 注入 `realpath`/`exists`,所以能单测):

```ts
interface GuardIo { realpath(p: string): string; exists(p: string): boolean }
/** 1) 拒 NUL;2) resolve();3) 逐级找到最深的已存在祖先,realpath 它;4) 结果必须在某个 root 内(同样 realpath 过) */
export function checkPath(raw: string, roots: string[], io: GuardIo): {ok:true; abs:string} | {ok:false; error:string}
/** 只做字符串共属判定,不碰磁盘(与 logseq 的 inside() 同源,但用 path.relative 实现) */
export function isInside(root: string, abs: string): boolean
```

要点(每条都对应一个真实会踩的坑):

1. **前缀判定不能用 `startsWith`**:`/a/bc` 会被 `/a/b` 误判为在内。用
   `const rel = relative(root, abs); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)`。
2. **符号链接逃逸**:`roots = [/home/me/pub]`,`/home/me/pub/link → /etc`。所以要对「最深的已存在祖先」做 `realpath` 再判定(创建新文件时父目录可能还不存在,`mkdir -p` 的场景要逐级向上找)。这是 logseq 那套 `resolve()` 没覆盖的洞。
3. **不存在的目标**:`realpath` 会 ENOENT → 退化为 realpath 父目录 + 拼 basename,再判定。
4. **硬性 deny 名单**:`app.getPath('userData')`(里面是 `passwords.json` 密文、`bookmarks.json`、`plugins.json`…)。理由:让 LLM 读/删自己的插件库没有正当用途,而误删的代价是数据丢失。设置页也**拒绝把它加为 root**。
5. **不许动 root 本身**:`delete`/`move` 的目标不允许等于任一 root(否则一次调用就能把工作目录整个送进回收站)。
6. **Windows**:`path.relative` 本来就大小写不敏感;但要额外拒 `\\?\` 前缀(绕过长路径规范化会破坏前缀判定),UNC 路径靠 `relative` 处理。盘符大小写由 Node 统一。
7. `browser_fs_read` 另有**大小闸**:默认 `maxBytes = 64 KiB`,上限 1 MiB,超限返回 `{truncated:true}` 而不是失败。

### 3.3 MCP 工具集(10 个)

命名沿用 `browser_*` 前缀(与 `browser_download` 并排好读);本地文件一组用 `browser_fs_*`。

| 工具 | 参数 | 行为 | 回收/护栏 |
| --- | --- | --- | --- |
| `browser_fs_roots` | — | 返回生效的 roots(含 `exists:false` 标记)+ 实际下载目录。**LLM 第一步就该调它**,避免瞎猜路径 | — |
| `browser_fs_list` | `path?`, `glob?`, `recursive?`, `limit?`, `showHidden?` | 省略 `path` = 第一个 root。返回 `{entries:[{name,path,type,size,mtimeMs}]}` | 条数上限(默认 200 / 上限 2000)、递归深度上限 8、跳过 `.git`/`node_modules`? **不跳**(显式才可信),但默认 `showHidden:false` |
| `browser_fs_info` | `path` | `{exists,type,size,mtimeMs}`,回答「在不在 / 多大 / 什么时候改的」 | 走 guard |
| `browser_fs_read` | `path`, `maxBytes?` | UTF-8 文本;含 NUL 或非法 UTF-8 → 拒绝并提示「这是二进制文件,用 browser_upload / browser_download 处理」 | 大小闸;拒绝读目录 |
| `browser_fs_write` | `path`, `content`, `overwrite?`, `createDirs?` | 原子写(`.tmp-<rand>` → `rename`,失败退化就地写,与 logseq 同源) | 目标已存在且 `overwrite!==true` → **拒绝**,不给 LLM 静默覆盖的机会 |
| `browser_fs_mkdir` | `path`, `recursive?` | — | 走 guard |
| `browser_fs_move` | `from`, `to`, `overwrite?` | 先 `rename`;`EXDEV/EPERM`(跨盘/被占)回落 `copy + unlink` | 目标存在且无 `overwrite` → 拒绝;任一端等于 root → 拒绝 |
| `browser_fs_copy` | `from`, `to`, `overwrite?`, `recursive?` | 目录要显式 `recursive:true` | 同上 |
| `browser_fs_delete` | `path`, `recursive?`, `permanent?` | 默认 `shell.trashItem(path)`(**可恢复**);`recursive:true` 才能删非空目录 | `permanent:true` 且设置开关关 → 拒绝;删 root → 拒绝;`trashItem` 失败**不**静默降级为永久删,原样报错 |
| `browser_upload` | `path`\|`paths`, `selector?`, `tabId?`, `multiple?` | 见 §3.4 | 只接受 http(s)/内部页之外? 见下 |

计数影响:`docs/ARCHITECTURE.md:636-647` 的「插件工具 20 个 / 合计 39」→ **30 / 49**,并在「静态计数来源」里补 `files/main.ts:<行号>`。
README 的「MCP 工具一览」表(`README.md:344` 起)追加 10 行。

**否掉的替代方案**:单个 `browser_fs {op, ...}` 工具。省 9 个工具名,但(a)插件工具的 schema 不经 strict 校验,`op` 的合法域只能写进 description,LLM 更容易写错;(b)pi 的 MCP 适配器默认是**代理模式**(schema 不常驻上下文,README:211),所以工具数不直接等于 token 成本;(c)与现有 `device_*` 一组 11 个工具的风格不一致。

### 3.4 上传:两条路,一个工具

**核心工具**(LLM 永远可用,不依赖任何挂载状态):

```ts
browser_upload { path | paths, selector?, tabId?, multiple? }
```

解析顺序(确定性的四步,单测用假 debugger 逐个覆盖):

1. 这个 tab 有**待应答的 chooser**(§3.4 的接管产生了 `Page.fileChooserOpened`)→ 直接用它的 `backendNodeId`;
2. 给了 `selector` → 走 `DOM` 查询拿 `nodeId`;
3. 没给 selector → 页面上**恰好一个** `input[type=file]` 就用它;多个 → 返回候选清单(选择器 + accept + multiple)让 LLM 自己挑;
4. 一个都没有 → 报错:「页面上没有 `input[type=file]`;若上传框要点按钮才出现,先 `browser_click` 那个按钮再调本工具(需要文件选择接管已开启)」。

命令序列(每条都已确认存在于 Chromium 44 的二进制里):

```
dbg.attach('1.3')            // 已是自己挂的 → 复用,不 detach
Page.enable                  // best-effort(照 device-inspect/cdp.ts:496 的 bestEffort 写法)
DOM.enable                   // best-effort
DOM.getDocument {depth:-1}   → root.nodeId
DOM.querySelector {nodeId, selector}  → nodeId          (1/3 两条路)
DOM.setFileInputFiles {files:[...abs], nodeId|backendNodeId}
→ 返回 {ok, tabId, files:[{name,size}], input:{selector,multiple,accept}}
detach                        // 只有「本次是我们 attach 的」才 detach(照 actions.ts:198)
```

**推荐给 LLM 的主流程**(写进 `MCP_INSTRUCTIONS`):先 `browser_upload {path, selector:'input[type=file]'}` **再** `browser_click` 提交按钮。因为操作 `<input>` 不需要用户手势,这条路对绝大多数站点都成立,且完全不需要挂调试器。

**接管原生文件框的人机路径**(用户要的那条):

只靠上面那条路不够 —— 用户/LLM 先点了上传按钮时,原生文件框会弹出来挡在所有人面前。所以要在**点击之前**挂上拦截:

```
对每个普通标签(见下面的挂载策略):
  Page.setInterceptFileChooserDialog {enabled:true, cancel:true}   // 抑制原生框 + 回事件
  dbg.on('message', (ev, method, params) => method === 'Page.fileChooserOpened' && …)
→ params: {frameId, mode:'selectSingle'|'selectMultiple', backendNodeId}
→ 记 pending chooser {tabId, backendNodeId, mode, at}
→ ctx.ipc.emit('chooser', {tabId, mode, accept?})
→ chrome 侧(对 tabId 属于本窗口的那个)开 plugin:files:panel,payload {mode:'pick-upload', tabId}
→ 人在面板里逛 roots 选文件 → plugins.invoke('files','answerChooser',{paths})
→ DOM.setFileInputFiles {files, backendNodeId} → emit 'chooser-resolved' 让所有窗口收面板
→ 取消 / 30s 超时 → 什么都不设(等同用户关掉原生框)
```

**挂载策略(这里有个真实取舍,我建议默认 A)**:

- **A(推荐,v1)**:`did-finish-load` 时用 `wc.executeJavaScript("document.querySelectorAll('input[type=file]').length")` 探一下,**页面有 file input 才挂**。绝大多数站点的上传框在 HTML 里(只是被 CSS 藏起来),所以命中率高,而纯浏览的标签完全不挂调试器 —— 不影响 DevTools。
  - 漏的场景:SPA 里「点了按钮才 `createElement('input')` 再 `click()`」,而且创建与点击在同一个 tick(我们来不及挂)。**兜底**:面板里放一个「接管本标签页」手动开关(`armTab`/`disarmTab`),人先开、再点上传;而 LLM 走 §3.4 的核心工具,本来就不需要挂载。
- **B**:设置一开就对**每个**普通标签常挂。彻底不怕漏,代价是那些标签的 DevTools 一开就把我们的会话顶掉(功能静默失效),每个标签多一个 CDP 会话。**如果真机验证发现 A 漏得太频繁,改成 B 只是删掉那个探测分支**。

**detach 处理**:`dbg.on('detach', ...)` → 清掉该 tab 的挂载标记 + 记日志;不做自动重挂(会和 DevTools 打架),下次 `did-finish-load` 自然重来。标签关闭(`events.on('tab:closed')`)必须显式清理挂载记录与 pending chooser。

### 3.5 删除与覆盖(按用户选择)

- `browser_fs_delete` 默认 `shell.trashItem` —— **可恢复**,这是比任何确认框都有效的护栏(确认框还会卡住自动化)。
- `permanent:true` 需要 `files-settings.json` 的 `allowPermanentDelete`(设置页开关,默认 **关**)。
- `trashItem` 失败(Linux 上没有 trash 实现是常见情况)时**不降级**为永久删,返回失败原文 + 提示。
- 写类一律「已存在且未显式 `overwrite` 就拒绝」—— 直接吸取 logseq 的教训(`expectMissing`:一次静默覆盖把用户的笔记清空过,ARCHITECTURE:575)。
- 不弹确认框,但**每一次破坏性调用都写一条日志**(`ctx.log`,前缀 `[plugin:files]`,进 `browser.log`),事后可追溯。

### 3.6 UI

**工具栏按钮**(`ui/FilesButton.vue`,lucide `FolderOpen` 图标):点开 `plugin:files:panel`(`placement:'full'`,与下载/密码面板一致)。

**面板**(`ui/FilesPanel.vue`)两种模式:

- **浏览模式**(默认):roots 下拉 + 面包屑 + 列表(图标/名字/大小/mtime);
  工具条:新建目录 / 重命名 / 移动 / 复制 / 删除 / 刷新 / 在文件管理器中显示(`shell.showItemInFolder`)/ 打开(`shell.openPath`);
  文本文件点击 → 右侧预览(`readText`,只读)。
  多选 + 批量删除(删除走回收站)。
- **上传模式**(payload `{mode:'pick-upload', tabId, multiple}`):同一套浏览 UI,底部换成「选择 N 个文件」;单选 chooser 就只能选 1 个(按 `mode` 限制)。
- `api.plugins.onEvent` 里**必须**按 `payload.tabId ∈ 本窗口标签` 过滤,否则多窗口一起弹面板(§2.1)。

**设置页**(`ui/FilesSettings.vue`):
- 工作目录列表:列出 roots(默认项标注「默认 = 下载目录」且不可删)、`[+ 添加目录]`(走 `dialog` 多选)、`[移除]`、每项显示 `不存在` 徽标;尝试添加 `userData` 或系统盘根/家目录时给**醒目警告**(`/` 与 `~` 允许但提示「等于放弃白名单」);
- `[ ] 允许永久删除(不进回收站)`;
- `[x] 接管网站的文件选择(改用 bow 面板;会让该标签的 DevTools 顶掉接管)`;
- 「本标签页接管」的手动开关也放这里 + 面板里各一份。

### 3.7 顺带堵住 `browser_download.saveDir`

不堵的话 §3.2 的白名单形同虚设 —— LLM 可以 `browser_download {url, saveDir:'/任意路径', filename:'x'}` 凭空写盘。

改法(3 行):`downloads/main.ts:567` 那行 `if (rawDir && !isAbsolute(rawDir))` 之后加一句 `if (rawDir && !isWithinFileRoots(rawDir)) return errorContent('saveDir 不在允许的工作目录内(可在「文件管理」设置页添加)')`。

- 不传 `saveDir` 的老路径不受影响(默认就是下载目录 = 默认 root)。
- 「存到 `/tmp`」这类正当用法会失效 —— 去设置页把 `/tmp` 加成 root 即可,语义一致。
- 这条改动**可延后**:如果不想动 downloads 插件,就在 §8 明确记下这个已知旁路,别假装护栏是全的。

### 3.8 被否掉的替代方案

| 方案 | 为什么否 |
| --- | --- |
| 不用 CDP,页面里用 `DataTransfer` + `new File([bytes])` 合成文件塞给 `input.files` | 得把整个文件读进主进程再送进页面(内存翻倍);正常标签**没有 preload**,通道只能是 `console-message` 这类黑招;严格 CSP 站点会挡掉 `fetch`;合成出来的 `File` 没有真实路径,靠 `files[i].path` 的站点直接不认 |
| 拦截 `<input type=file>` 的 `click()`(注入脚本覆盖原型方法) | 破坏站点行为(很多站点自己合成 click),而且**仍然解决不了**「怎么把磁盘文件放进 `files`」——没有 CDP 就没有 `setFileInputFiles` |
| `content.inject` 一个 MutationObserver,出现 file input 就通知主进程挂载 | 「创建 + 同 tick click」的场景来不及挂,收益小、还要给页面控制台留脏话。当成 §3.4 挂载策略 A 的备选记录在这里即可 |
| 每个不可逆操作都弹 `dialog.showMessageBox` 确认 | 会把 LLM 的自动化卡在等人点按钮上(MCP 调用还可能超时),而回收站比确认框更可靠 |
| 插件自带 `.trash/` 目录(不碰系统回收站) | 跨平台行为一致,但要额外维护一份回收站状态与清理策略;系统回收站已经解决了这个问题 |

---

## 4. 改动清单(文件级)

**新增**

- `src/plugins/files/main.ts` —— 唯一碰盘与 CDP 的地方:settings store、guard 接线、fs 操作、10 个 MCP 工具、IPC 面、chooser 挂载与应答、`tab:closed` 清理
- `src/plugins/files/guard.ts` —— 路径校验纯逻辑(`node:path`;`realpath/exists` 注入)
- `src/plugins/files/shared.ts` —— 三端安全类型:`FilesSettings` / `normalizeFilesSettings` / `formatSize` / 事件名 / 排序与 glob 纯函数
- `src/plugins/files/ui.ts` —— `slots.toolbar: [FilesButton]`、`overlays: [plugin:files:panel]`、`settingsSections: [FilesSettings]`
- `src/plugins/files/ui/FilesButton.vue` / `FilesPanel.vue` / `FilesSettings.vue`
- `src/main/plugins/fsRoots.ts` —— 核心只读共享(`resolveFileRoots` / `isWithinFileRoots`),照 `exportFile.ts`
- `tests/filesGuard.test.ts` / `tests/filesShared.test.ts` / `tests/filesPlugin.test.ts` / `tests/filesUpload.test.ts`(假 debugger)/ `tests/fsRoots.test.ts`
- `scripts/e2e-file-upload.mjs`(可选,真 Electron + 真 MCP;见 §6.3)

**修改**

- `src/main/plugins/builtin.ts` —— 末尾加 `files`
- `src/renderer/src/plugins/registry.ts` —— `PLUGIN_UI` 加一行 + `SLOT_PLUGIN_ORDER.toolbar` 末尾加 `'files'`
- `tsconfig.node.json` —— include 加 `src/plugins/*/guard.ts`
- `src/plugins/downloads/main.ts:567` —— `saveDir` 加 root 校验(§3.7)
- `src/main/mcp.ts` —— `MCP_INSTRUCTIONS` 加「本地文件」「上传」两节(§7)
- `docs/ARCHITECTURE.md` —— §1 目录地图、§5.8 矩阵两行、§6.2 计数 20/39→30/49 与调用点行号、§8 存储表加 `files-settings.json`、§13 加 CDP/DevTools 互斥这条坑、§5.7 的 include 清单句
- `README.md` —— 顶部功能段一句、MCP 工具表 10 行、数据存储一节

**不动**:`src/shared/plugins.ts`(不加 capability)、`preload/index.ts`(插件 IPC 走现成的 `plugins:invoke`/`plugin:event`)、`builtin.ts` 里其它插件的次序、`internalPages.ts`(不做 `bow://files`)。

---

## 5. 实施步骤(每步独立可验证)

| 步 | 内容 | 独立验证 |
| --- | --- | --- |
| 0 | 骨架:id/`builtin`/`registry`/空 `ui.ts` + 设置页 + `FilesSettings` + guard + `fsRoots.ts` + 单测 | `bow://settings` 出现「文件管理」分区,能添加/移除工作目录并落盘;越界路径被拒;`npm run typecheck && npm run test` 绿 |
| 1 | 只读三件套:`browser_fs_roots` / `list` / `read` / `info` | 用 MCP 客户端(或 `npm run mcp` + pi)调这几个工具,读真实目录;越界路径报错;`browser.log` 有记录 |
| 2 | 写:`write`(原子写 + overwrite 闸)/ `mkdir` / `move` / `copy` / `delete`(→ 回收站) | 真机跑一遍:写→改→移→复制→删,去系统回收站里确认文件真的在 |
| 3 | 面板 UI(浏览 + 管理 + 预览 + 多选删除) | 真机点一遍;多窗口下确认只有一个窗口弹面板 |
| 4 | 上传:`browser_upload`(selector / 自动探测两条路)+ 假 debugger 单测 + E2E | E2E 脚本对本地页面的 `<input type=file>` 上传,断言 `input.files[0].name`;DevTools 开着时确认报错文案正确 |
| 5 | 接管 chooser:挂载策略 A + `Page.fileChooserOpened` → 面板 → `answerChooser` → `setFileInputFiles` | 真机:开一个真实上传页(如 GitHub 的 issue 附件),点按钮 → **不弹原生框**、bow 面板出现、选文件后网页里出现文件名 |
| 6 | 堵 `browser_download.saveDir` + 文档同步 + 全量校验 | 见 §9 |

---

## 6. 测试

### 6.1 纯逻辑(必做)

- **`tests/filesGuard.test.ts`** —— `/a/b` 不包含 `/a/bc`;`..` 穿越;符号链接逃逸(注入的 `realpath` 把 `link` 解析到 root 外 → 拒);目标不存在时退回父目录判定;NUL 拒绝;`\\?\` 拒绝;root 本身不可删;`userData` 硬拒;Windows 形态(盘符大小写 / UNC;用 `path.win32` 或注入 path 实现)。
- **`tests/filesShared.test.ts`** —— `normalizeFilesSettings`(roots 去重、去空、绝对化、坏类型丢弃)、`formatSize`、排序、glob。
- **`tests/fsRoots.test.ts`** —— 空 roots 落到下载目录;**JSON 坏掉 / 文件不存在**时回退默认(照 `exportFile.test.ts` 的形状)。

### 6.2 插件(真实临时目录,照 `logseqPlugin.test.ts` 的风格)

`tests/filesPlugin.test.ts`:用 `mkdtemp` 真目录 + 注入的 `trash` 假件:

- 原子写不留 `.tmp-*`;`overwrite` 缺省拒绝覆盖;已存在时用 `expectMissing` 那类断言守住「绝不静默覆盖」;
- `move` 的 `rename` 失败回落 `copy+unlink`(注入一个抛 `EXDEV` 的假 fs);
- `delete` 调用了 `trashItem` 而不是 `rm`;`permanent:true` 在开关关时被拒;
- 越界路径全被拒(每个工具至少一条);
- 列表上限/深度上限夹紧。

`tests/filesUpload.test.ts`:假 debugger(记录 `sendCommand` 调用序列,照 `deviceInspectCdp.test.ts` 的风格):

- 解析顺序:pending chooser > selector > 唯一 input > 报错;
- 命令序列精确匹配:`DOM.getDocument` → `DOM.querySelector` → `DOM.setFileInputFiles {files}`;
- 「调试器是别人/DevTools 占的」→ attach 抛错 → 返回可直接读的失败文案,**不** detach 别人的会话;
- 「本次是我们 attach 的」才 detach。

### 6.3 端到端(可选但值得)

`scripts/e2e-file-upload.mjs`(`npm run test:e2e:upload`,照 `e2e-device-inspect.mjs` 的脚手架):headless Electron + `MCP_HTTP=1` →

1. `browser_new_tab` → `about:blank`;`browser_eval` 注入 `<input type=file>` + 一个 change 监听计数;
2. 在临时目录造一个真文件;`browser_upload {path, selector:'input[type=file]'}`;
3. `browser_eval` 读 `document.querySelector('input').files[0].name/.size` 与 change 计数 → 断言;
4. 再走一遍「接管」路径(`armTab` → eval 触发 `input.click()` → 断言 `chooser` 事件到达 → `answerChooser` → 断言 files)。

---

## 7. 文档同步

- **`MCP_INSTRUCTIONS`(`src/main/mcp.ts`,最重要)** 要新增两节:
  - **本地文件(browser_fs_\*)**:「这些工具操作的是**真实磁盘**,不是网页;只能在 `browser_fs_roots` 列出的工作目录里操作,越界会被拒;删除默认进系统回收站(`permanent` 需要用户开着开关);写文件不会覆盖已存在的文件,除非显式 `overwrite:true`;第一步先 `browser_fs_roots` 看有哪些目录。」
  - **上传(browser_upload)**:先 set 输入框、再点提交(推荐);`selector` 从 `browser_snapshot` 拿;若上传框是点了按钮才出现的,先确认设置里的「接管文件选择」开着再点按钮,然后不带 `selector` 调本工具应答;`accept` 过滤由网站负责;上传期间该标签**不能**开 DevTools(会顶掉接管)。
- **README**:工具表 10 行 + 顶部功能段一句 + 「数据存储」加 `files-settings.json`。
- **ARCHITECTURE**:§5.8 两处矩阵行;§6.2 「插件工具 20 个」→ 30、「合计 39」→ 49、静态计数来源补 `files/main.ts:<行号>`;§8 存储表加 `files-settings.json`(所有者 files);§13 加「CDP 调试器与 DevTools 互斥(接管文件选择 / 整页截图都吃这条)」;§1 目录地图加插件目录;§5.7 的 include 清单加 `guard.ts`。
- 顺带:`README.md:294` 那条「Ctrl+D 收藏当前页」的文档漂移**不在本次范围内**(记在 scratchpad),不要手贱一起改。

---

## 8. 风险与未知(必须真机验证,别靠读文档假定)

| # | 未知 | 影响 | 验证方式 |
| --- | --- | --- | --- |
| 1 | `Page.setInterceptFileChooserDialog {enabled:true, cancel:true}` 是否真的**抑制原生框**并回 `Page.fileChooserOpened`(二进制里那个 `enableFileChooserOpenedEvent` 内部名暗示可能还有一层开关;`cancel` 的语义要实测) | **接管功能的成败点**,不成立就只能退回 §3.4 核心工具 + 手动 `armTab` | 真机 + 一个本地 `input[type=file]` 页面 |
| 2 | `DOM.setFileInputFiles` 是否**自动**触发 `input`/`change` | 不触发就得手动 `dispatchEvent(new Event('change'))`,而 React 受控组件可能不认 | E2E §6.3 第 3 步 |
| 3 | 调试器互斥的真实表现:我们挂着时用户开 DevTools,是我们被顶掉还是 DevTools 被拒?`detach` 的 reason 是什么? | 决定要不要自动重挂 / 要不要在设置页写警告 | 真机 F12;读 `browser.log` 里的 detach 日志 |
| 4 | `<input>` 在 iframe / OOPIF 里时,`Page.fileChooserOpened.backendNodeId` 能否直接喂给 `DOM.setFileInputFiles`(跨 frame 的 node id 是否全局有效) | 决定要不要按 `frameId` 做 `DOM.getDocument` 的 frame 定位 | 真机找一个 iframe 上传框 |
| 5 | ~~Linux 上 `shell.trashItem` 在无 gio / 容器环境会不会失败~~ **✅ 已实测(2026-10-09)** | 结论:取决于文件所在的**挂载点**,不是发行版。`$HOME`(ext4 根分区)上正常进回收站;**`/tmp`(tmpfs)上必然失败** —— `shell.trashItem` 报 `Failed to move item to trash`,底层 `gio trash` 的原话是 `Trashing on system internal mounts is not supported`。代码按设计**不降级**为永久删,把错误原文交给 AI ⇒ 删 tmpfs 上的文件会失败,这是**环境事实**,不是 bug(要真删就打开「允许永久删除」) | 真机已验(18/18) |
| 6 | `accept` / `multiple` 的约束是网站还是浏览器校验;`mode` 只给 single/multiple | 面板的单选/多选限制只能按 `mode` 做,提示文案要诚实 | 真机试一个 `multiple` 上传框 |
| 7 | `wc.executeJavaScript` 在 CSP 严格站点探测 file input 是否可用(devtools 式求值一般不受 CSP 限制,但要确认) | 影响挂载策略 A 的命中率 | 真机试 GitHub / 一个 CSP 严格的站点 |
| 8 | Windows 路径形态(UNC、`\\?\`、盘符大小写、`path.relative` 行为) | guard 的跨平台正确性 | 本机没有 Windows 的话:**明确记为未验证**,单测里用 `path.win32` 覆盖字符串逻辑 |
| 9 | `did-finish-load` 时挂调试器 vs `browser_screenshot {fullPage:true}` 的交互 | 已知可复用(`actions.ts:190` 的 `isAttached()` 分支),但要确认 `Page.setInterceptFileChooserDialog` 不会干扰 `captureScreenshot` | 真机:挂载状态下截图 |

---

## 9. 验证命令

```bash
npm run typecheck            # tsconfig.node.json 的 include 漏登记会在这里现形
npm run test                 # 新增 5 个测试文件;关注 pluginBoundaries(新目录)
npm run build                # electron-vite 两侧 bundle;ui.ts 引 electron 会在这里炸
npm run test:e2e:upload      # 新增(若做 §6.3)
npm run dev                  # 真机:设置页 / 面板 / 上传 / 接管 / 回收站
npm run mcp:http             # 真 MCP:调 browser_fs_* 与 browser_upload 各一次
```

**完成定义**:上面全绿 + `MCP_INSTRUCTIONS` 与 README/ARCHITECTURE 已同步 + §8 的 1/2/3/5 条有真机结论(通过或明确记为不通过 + 降级方案)。
