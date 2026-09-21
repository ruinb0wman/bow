# bow 下载管理插件(记录 / 暂停恢复 / 重新下载 / 取消)

日期:2026-09-22 · 模式:plan · 状态:待批准

## 0. 目标与假设

**目标**:给 bow 加一个内置插件「下载」,提供下载记录(持久化)、暂停 / 恢复、重新下载、取消下载,
以及打开文件 / 显示所在的常规动作;工具栏一个带进度的按钮 + 全屏浮层面板 + 设置页分区;
并给 AI 暴露 `browser_list_downloads` / `browser_download` 两个 MCP 工具。

**已确认的决策(用户拍板)**:

| 决策 | 选择 |
| --- | --- |
| UI 形态 | 工具栏按钮 + 全屏浮层面板 + 设置页「下载」分区(**不做** `bow://downloads` 内部页面) |
| 保存位置 | 默认弹保存对话框(保持现状),设置可关掉 → 静默存到指定目录并自动重名 |
| MCP 工具 | 加 `browser_list_downloads` + `browser_download`(工具总数 42 → 44) |
| 快捷键 | 加 `Ctrl/Cmd+J` 打开下载面板;**终端页放行给 shell** |

**必须说明的假设(代码里读出来的,不是猜的)**:

1. 所有标签、chrome、overlay 都跑在 `session.defaultSession` 上 —— 全仓库没有任何 `partition` /
   非默认 session(`grep partition|fromSession src/` 无命中),所以一个
   `session.defaultSession.on('will-download')` 就能覆盖全部下载入口。
2. 插件 `activate()` 早于窗口创建但在 `app.whenReady()` 之后(`docs/ARCHITECTURE.md` §2 第 5 步),
   因此 `session.defaultSession` 在 activate 里就已经可用,注册监听不需要新的内核钩子。
3. **重启后不做断点续传**:Electron 的跨会话续传只能走 `ses.createInterruptedDownload()`
   (需要 offset/length/ETag/Last-Modified),而该 API 有长期未解的 `canResume()` 恒 false 报告
   (electron#8061)。第一版把重启时未完成的记录归一成 `interrupted`,UI 提供「重新下载」。
4. 记录里不保存正文,只保存元数据;删除记录**不删文件**(与 Chrome 的「从列表中移除」同语义)。

---

## 1. 现状:它为什么是一个插件,以及必须挂在哪

| 事实 | 位置 |
| --- | --- |
| 插件 = 目录 + 两处登记(`BUILTIN_PLUGINS` / `PLUGIN_UI`),UI 由渲染层注册表按「已启用插件」过滤 | `src/main/plugins/builtin.ts:20`、`src/renderer/src/plugins/registry.ts:19` |
| 工具栏按钮打开插件的**唯一**方式是在渲染层调 `api.showOverlay({id:'plugin:<id>:<panel>',…})` —— 主进程插件自己打不开浮层 | `src/plugins/device-inspect/ui/DeviceInspectButton.vue:8`、`src/plugins/bookmarks/ui/BookmarksButton.vue:8` |
| 浮层关闭走通用 `close-request` 分支(`overlay.show(null)`),插件不用加 IPC | `src/main/ipc.ts:206` |
| `PluginContext` 有 `storage` / `ipc.handle` / `ipc.emit` / `mcp.tool`,**没有** download 钩子 → 插件直接 `import { session } from 'electron'` | `src/main/plugins/types.ts:96`;先例:`src/plugins/device-inspect/main.ts:30`(import app/net)、`src/plugins/logseq/main.ts`(dialog) |
| 插件在 activate 里自己加的 Electron 监听要在 `deactivate` 里手动摘(内核只管 `ctx.*` 注册的东西) | `src/plugins/device-inspect/main.ts:750-770`(`app.on('before-quit')` 的加/删) |
| ⚠️ activate 抛错时内核只 `ctx.dispose()`,**不会**调 `module.deactivate` | `docs/ARCHITECTURE.md` §5.3;所以 `will-download` 必须注册在 activate 的**最后一行** |
| 核心快捷键在 `matchTabHotkey` 里识别、`tabShortcuts.ts` 里分派;`releasesToTerminal()` 是**按 action** 放行的 | `src/shared/shortcuts.ts:82`、`:141`;`src/main/tabShortcuts.ts:66-76` |
| 插件热键(`ctx.shortcuts.register` → `kernel.handleHotkey(input)`)拿不到按键来源的 webContents,**无法**做「终端页放行」 | `src/main/plugins/kernel.ts:333`、`src/main/tabShortcuts.ts:198` |
| 未知浮层 id 时 OverlayApp 渲染 `null`,但 overlay 视图仍然 `setVisible(true)` 铺满窗口 → 会**挡住页面且 Esc 无效** | `src/renderer/src/overlay/OverlayApp.vue:39`、`src/main/overlay.ts:76` |
| `shared.ts` 已经在两个 tsconfig 的通配里,新插件不用改 tsconfig | `tsconfig.node.json:29`、`tsconfig.web.json:26` |

---

## 2. 要改的文件(精确清单)

### 2.1 新增

| 文件 | 职责 |
| --- | --- |
| `src/plugins/downloads/shared.ts` | **纯逻辑**(三端安全,可单测):记录模型 / 设置归一 / 动作可用性 / 启动归一 / 裁剪 / 排序 / 去重文件名 / 格式化。**不 import electron,不 import node:fs** |
| `src/plugins/downloads/main.ts` | 装配:`will-download` 宿主 + in-flight 表 + 落盘节流 + IPC 面 + 2 个 MCP 工具 + deactivate 清理 |
| `src/plugins/downloads/ui.ts` | 贡献:`toolbar: [DownloadsButton]`、`overlays: [{id:'plugin:downloads:panel', placement:'full'}]`、`settingsSections: [DownloadsSettings]` |
| `src/plugins/downloads/ui/DownloadsButton.vue` | 工具栏按钮(进行中显示进度百分比 + 环形/填充角标),点击 `api.showOverlay({id:'plugin:downloads:panel', payload:undefined, placement:'full'})` |
| `src/plugins/downloads/ui/DownloadsPanel.vue` | 全屏面板(`ModalShell`):列表 + 行内操作 + 头部「清空已完成」 |
| `src/plugins/downloads/ui/DownloadsSettings.vue` | 设置页分区:保存目录 / 询问开关 / 记录上限 / 清空全部 |
| `tests/downloadsShared.test.ts` | `shared.ts` 的用例(见 §5) |

### 2.2 修改

| 文件 | 改什么 | 现状(引用) |
| --- | --- | --- |
| `src/main/plugins/builtin.ts` | `BUILTIN_PLUGINS` 末尾追加 `downloads`(与 device-inspect/terminal/logseq 同位置,注释写明「只贡献 UI/MCP,不参与网络钩子链与建议源次序」) | 第 20-30 行 |
| `src/renderer/src/plugins/registry.ts` | `import downloadsUi`;`PLUGIN_UI` 追加;`SLOT_PLUGIN_ORDER.toolbar` 改成 `['bookmarks','downloads','mcp-http',…]`(下载按钮挨着书签) | 第 8-30 行 |
| `src/shared/shortcuts.ts` | ① `TabHotkey` 加 `{ action: 'downloads' }`;② `matchTabHotkey` 加 `j`/`KeyJ` 分支;③ `releasesToTerminal` 加 `'downloads'`;④ 顶部注释同步 | 第 30-65、106-116、141-147 行 |
| `src/main/tabShortcuts.ts` | `switch` 加 `case 'downloads'`:插件启用 + 面板未开 → 打开;面板已开 → 关;别的 full 浮层开着 → 忽略 | 第 95-175 行 |
| `README.md` | 首段能力列表 / MCP 工具表(2 行)/ 手动快捷键(`Ctrl+J`)/ 数据存储(`downloads.json`)/ 内置插件列表 | 第 3、320-338、366-374、559-569、586 行 |
| `.pi/skills/bow-browser/SKILL.md` | 开头「42 个工具(19 核心 + 23 插件…)」→ `44 / 19+25`;工具选型表加一行下载 | 第 8 行、选型表 |
| `docs/ARCHITECTURE.md` | §5.8 贡献矩阵加 `downloads` 行(主进程侧 + 渲染层侧两张表)、§6.2 插件工具数 23→25 与合计 42→44、§8 数据文件加 `downloads.json`、§7.3 设置页分区列表加「下载」、§11 测试基线计数(965 → 实测值)、§13 补一条「未知浮层 id 会挡住页面」的坑 | 各节 |

**不改**(有意):`src/preload/index.ts`(插件面已够)、`src/main/ipc.ts`(浮层关闭走通用分支)、
`shared/internalPages.ts`(不做内部页面)、`shared/types.ts`、三个 tsconfig。

---

## 3. 关键实现细节(实现时按这个写)

### 3.1 `shared.ts` 的数据模型与纯函数

```ts
export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadRecord {
  id: string
  url: string                 // item.getURL()
  urlChain: string[]          // item.getURLChain()(重下 / 将来续传用)
  filename: string            // item.getFilename() || 'download'
  savePath: string            // 询问模式下对话框确认前是空串
  mimeType: string
  totalBytes: number          // 0 = 未知
  receivedBytes: number
  state: DownloadState
  /** canResume() 的快照:服务器支持 Range + ETag/Last-Modified 才能真续传 */
  resumable: boolean
  startedAt: number           // epoch ms
  endedAt?: number
  /** 失败/取消/中断的原因(文案由主进程给,浏览器级别) */
  error?: string
  /** 来源页面 URL(webContents.getURL()),重下时作 Referer 提示用 */
  pageUrl?: string
  /** 由「重新下载」产生时指向原记录 id */
  retriedFrom?: string
}

export interface DownloadsSettings {
  askWhereToSave: boolean     // 默认 true = 保持 bow 现在的行为
  downloadDir: string         // '' = 用 app.getPath('downloads')
  maxRecords: number          // 默认 500,范围 1..5000
}
```

纯函数(全部可测,无 IO):

| 函数 | 语义 |
| --- | --- |
| `normalizeSettings(patch, prev)` | 坏输入一律回退 prev(不跳默认值);`maxRecords` 夹到 1..5000;`downloadDir` 必须字符串否则保留 |
| `isTerminal(s)` | `completed / cancelled / interrupted` |
| `actionsFor(record, live)` | 返回可用动作集合 `('pause'\|'resume'\|'cancel'\|'retry'\|'open'\|'showInFolder'\|'copyUrl'\|'remove')[]`。`live` = 该 id 在 in-flight 表里(决定「继续」还是「重新下载」) |
| `reconcileOnStart(records)` | 非终态(`progressing`/`paused`)→ `interrupted`,补 `error:'浏览器退出时中断'` |
| `trimRecords(records, max)` | **永不裁非终态**;终态里删最旧(`startedAt` 小) |
| `sortRecords(records)` | 非终态在前(按 startedAt 升序,先来的在上),终态按 startedAt 降序 |
| `uniqueFileName(filename, exists, max=1000)` | `report.pdf` → `report (1).pdf`;按**最后一个点**切扩展名(与 Chromium 一致);无扩展名 → `name (1)`;超上限回退时间戳后缀 |
| `formatBytes(n)` / `formatSpeed(bps)` / `formatEta(seconds)` | 0 / 未知(`totalBytes===0`) / NaN 都有明确输出(`'—'` / `'未知大小'`) |

### 3.2 `main.ts`:下载宿主

```ts
const downloadSession = session.defaultSession           // 见 §0 假设 1
```

- **注册**:`downloadSession.on('will-download', onWillDownload)` 放在 `activate()` 的最末(见 §1 表格里的内核语义),
  并在 `deactivate()` 里 `off(...)`。
- `onWillDownload(event, item, wc)`:
  1. 生成 `id`(`node:crypto` 的 `randomUUID()`);`filename = item.getFilename() || 'download'`。
  2. **AI 指令优先**:`pendingDirectives` 队首若 `url` 匹配(`item.getURL()` 或 `urlChain[0]`),
     用之决定 saveDir/filename 并**静默** `item.setSavePath(unique)`,并回调它的 `onCreated`。
     (URL 不匹配就不消费 —— 防「AI 请求的 directive 被用户此刻的手动下载吃掉」。directive 15s 未消费自动过期。)
  3. 否则按设置:静默 → `existsSync` 去重后 `item.setSavePath(join(dir, unique))`;
     询问 → `item.setSaveDialogOptions({ defaultPath: join(dir, filename) })` 且**不** setSavePath
     (Electron 的原始流程弹保存对话框;`docs/api/download-item.md` 就是这么写的)。
  4. 建记录(in-flight 表: `id → { item, record }`),挂 `item.on('updated', …)` 与 `item.once('done', …)`:
     - `updated(state)`:刷新 receivedBytes / totalBytes / bytesPerSecond / `state = item.isPaused() ? 'paused' : (state==='interrupted' ? 'interrupted' : 'progressing')` / `resumable = item.canResume()`;`Date.now()-lastPersist > 1000` 时落盘。
     - `done(_e, state)`:按 state 写 `completed / cancelled / interrupted`,补 `endedAt`、`savePath`(询问模式下**只有这里才拿得到用户选的名字**)、`error`(取消=「已取消」,中断=「下载中断」);从 in-flight 表删除;立即落盘并 `emitChanged()`。
  5. 落盘前一律过 `trimRecords(records, settings.maxRecords)`;每次落盘都有进度节流,终态/状态迁移立即落盘。
- `activate` 里先 `records = reconcileOnStart(store.get())` 并回写(这就是「重启后都显示已中断」)。
- `emitChanged()` = `ctx.ipc.emit('changed')`(广播面 = chrome + overlay + 内部页面,面板与按钮都收得到)。
- **IPC 面**(`ctx.ipc.handle`,渲染层 `plugins.invoke('downloads', m)`):

| 方法 | 行为 |
| --- | --- |
| `list` | `sortRecords` 后返回;`completed` 记录现算 `fileExists`(不落盘);附 `settings`(已 resolve 的目录) |
| `pause(id)` / `resume(id)` / `cancel(id)` | 只对 in-flight 生效;`resume` 时若 `!canResume()` 返回 `{ok:true, restart:true}` 让 UI 提示「服务器不支持续传,将从头开始」(文案由浏览器给,不在 UI 里硬编码) |
| `retry(id)` | 用记录里的 `url` 走 `downloadSession.downloadURL(url)`(不做来源检查,这正是重下要的);新记录带 `retriedFrom`;设置里询问模式下仍会弹对话框 |
| `remove(id)` / `clear(finishedOnly?)` | 只删记录(不删文件);in-flight 项先 `cancel()` |
| `openFile(id)` / `showInFolder(id)` | `shell.openPath` / `shell.showItemInFolder`,前置校验路径存在 |
| `getSettings` / `setSettings(patch)` | 过 `normalizeSettings`;返回 resolve 后的目录与「是否为系统默认」 |
| `pickDirectory` | `dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {properties:['openDirectory','createDirectory']})`,照 `src/plugins/logseq/main.ts:586-596` 的写法 |
| `revealDir` | `shell.openPath(dir)`(不存在则 `mkdirSync` 后打开) |

- **MCP 工具**(`ctx.mcp.tool`,不 strict —— 与其它插件工具一致):
  - `browser_list_downloads { id?, state?, limit? }` → `{ok, downloads:[{id, filename, url, state, percent, receivedBytes, totalBytes, bytesPerSecond, savePath, fileExists, startedAt}]}`;`id` 给了就返回单条(找不到 `{ok:false,error}`)。
  - `browser_download { url, saveDir?, filename?, wait?, timeoutMs? }` → 校验 http(s) → 压入 directive(静默保存,**不弹对话框**,否则 AI 的调用会卡在等人点确认)→ `downloadSession.downloadURL(url)` → 返回 `{ok,id,filename,savePath}`;`wait:true` 时等到 `done` 或 `timeoutMs`(默认 30s,上限 120s)返回终态。
  - **数据模型**:`urlChain` 让 AI 能看到重定向链;`resumable` 让 AI 知道能不能暂停续传。

### 3.3 UI

- `DownloadsButton.vue`:图标 `Download`(lucide-vue-next);有非终态记录时 `setInterval(500ms)` 调 `list`(无则停),按钮显示 `NN%` 小字 + 进度条状下划线;tooltip 写「下载(P)」。
- `DownloadsPanel.vue`:`ModalShell` + 与 `DeviceInspectPanel.vue` 同款排版;`onMounted` 立即 `list`,有非终态时 500ms 轮询;订阅 `plugins.onEvent`(`ev.id === 'downloads' && ev.event === 'changed'` → 立刻 refresh 一次);每行按 `actionsFor` 渲染按钮(进行中:`⏸/▶`+`✕`;完成:`打开`/`文件夹`;终态:`重下`/`删除`;全部:`复制链接` 走 `api.writeClipboardText`)。
- `DownloadsSettings.vue`:目录行(只读文本 + 「选择目录」+「打开目录」)、「下载前询问保存位置」开关、记录上限数字、清空全部;分区自带 `flex:1; min-height:0; overflow-y:auto` + `padding: 4px 14px 20px`(照 `docs/ARCHITECTURE.md` §7.3 的笔记分区约定 —— 父层 `.settings-body-plugin` 是 `overflow:hidden`)。

### 3.4 Ctrl+J

```ts
// shared/shortcuts.ts
| { action: 'downloads' }                       // Ctrl/Cmd+J:打开下载面板(终端页让给 shell)
if (key === 'j' || input.code === 'KeyJ') return { action: 'downloads' }
// releasesToTerminal():加 hotkey.action === 'downloads'(shell 里 Ctrl+J = accept-line,必须放行)
```

```ts
// main/tabShortcuts.ts
case 'downloads': {
  const overlay = getOverlay()
  if (overlay.currentId === DOWNLOADS_OVERLAY_ID) { overlay.show(null); break }   // 再按一次 = 关
  if (overlay.isFullOpen) break                                                   // 别的 modal 开着不抢
  const enabled = getKernel().list().some((p) => p.id === 'downloads' && p.enabled)
  if (!enabled) break                          // ⚠️ 停用时绝不能打开:未知 id 会留下挡页面且 Esc 无效的空浮层
  overlay.show({ id: DOWNLOADS_OVERLAY_ID, payload: undefined, placement: 'full' })
  break
}
```

`DOWNLOADS_OVERLAY_ID = 'plugin:downloads:panel'` 作为 `tabShortcuts.ts` 的局部常量(与 `CLOSE_CONFIRM_OVERLAY_ID` 同款做法)。

---

## 4. 实施步骤(每步可独立验证)

1. **纯逻辑 + 测试**:新增 `src/plugins/downloads/shared.ts` 与 `tests/downloadsShared.test.ts`;
   跑 `bun run test tests/downloadsShared.test.ts` 与 `bun run typecheck`。
2. **主进程**:新增 `src/plugins/downloads/main.ts`(`will-download` + IPC + 2 个 MCP 工具);
   `bun run typecheck`;`bun run build`(main 侧能被 electron-vite 编译)。
3. **UI**:新增 `ui.ts` + 三个 `.vue`;`bun run build`(⚠️ `.vue` 不在 `tsc` 范围内,只有 rollup 会报引用错 —— `docs/ARCHITECTURE.md` §11)。
4. **登记两处**:`builtin.ts` + `registry.ts`(含 `SLOT_PLUGIN_ORDER.toolbar`);`bun run test` 全绿(此时 `pluginBoundaries` / `pluginUiSlots` 应自动通过)。
5. **Ctrl+J**:改 `shared/shortcuts.ts` 与 `main/tabShortcuts.ts`;补 `tests/shortcuts.test.ts` 用例(Ctrl+J 识别、终端放行、Ctrl+Shift+J 不命中)。
6. **文档**:README / ARCHITECTURE(§5.8 / §6.2 / §7.3 / §8 / §11 / §13)/ SKILL.md 计数。
7. **端到端验证**:`bun run test` + `bun run typecheck` + `bun run build` + `bun run test:mcp`
   (`SMOKE_ELECTRON_ARGS=--ozone-platform=headless`,预期「工具数: 44」);然后按下表真机过一遍。

### 真机验证清单(只有真机能定论,验完回填 ARCHITECTURE §13)

| # | 验什么 | 判据 |
| --- | --- | --- |
| 1 | 普通网页点击下载 | 弹保存对话框(默认设置)/ 关掉询问后直接落到设置目录;面板出现进行中项、百分比跟得上 |
| 2 | **暂停 → 恢复是否真续传** | 服务器支持 Range(选一个大文件静态站)时 `resumable=true`、恢复后 receivedBytes 不回零;不支持时提示「将从头开始」 |
| 3 | 中断(拔网/断流) | 记录显示「已中断」+ 可「继续」;`canResume()` 为假时给「重新下载」 |
| 4 | 取消 | 记录标「已取消」,`.crdownload` 临时文件被清掉,原文件不存在 |
| 5 | 同名去重 | 同一文件下两次 → `a (1).pdf`;不覆盖已有文件 |
| 6 | 重启 | 未完成记录变「已中断」且不再谎报进度;已完成的仍可「打开 / 显示文件夹」 |
| 7 | 询问模式下暂停/取消 | `savePath` 在对话框确认前为空 → 面板显示「等待选择保存位置」而不是 0 字节假进度 |
| 8 | `browser_download` | 不弹对话框、`savePath` 正确、`wait:true` 能等到终态;带 `saveDir` 写到你指定的目录 |
| 9 | `Ctrl+J` | 任意焦点(页面/地址栏/面板内)都能开面板;再按一次关;**终端页里 Ctrl+J 落到 shell**(`read` 一行确认是 accept-line);DevTools 前端标签里也是开面板 |
| 10 | 插件停用/启用 | 停用:面板自动关闭、Ctrl+J 无反应、进行中的下载**不被取消**(记录继续更新);启用后记录仍在 |
| 11 | UI 极端尺寸 | 面板在窄窗口下不裁按钮、长文件名截断、大字节数格式化正确 |

---

## 5. 测试计划

`tests/downloadsShared.test.ts`(纯逻辑,node 环境,不需要 electron):

- `normalizeSettings`:空对象 / `maxRecords: 0|-1|1e9|'abc'` / `downloadDir: 42` 都回退或夹紧。
- `actionsFor`:进行中非暂停 → `pause/cancel`;暂停 & live → `resume/cancel`;暂停 & !live → `retry`;完成 → `open/showInFolder`;取消 → `retry/remove`;`open` 只在 `fileExists` 为真时出现。
- `reconcileOnStart`:`progressing`/`paused` → `interrupted` 且补 error;终态原样(不漏改 `endedAt`)。
- `trimRecords`:非终态永不裁;`max=1` 只留最新的终态;`max<=0` 用默认值。
- `uniqueFileName`:`a.pdf` → `a (1).pdf`;`a.tar.gz` → `a.tar (1).gz`;无扩展名;`exists` 恒真时到上限回退;文件名里的 `(`/`)` 不被误判。
- `formatBytes/formatSpeed/formatEta`:0、1 字节、999.9KB→MB 边界、`totalBytes=0`(未知)、`NaN`。
- `sortRecords`:进行中在最前、终态按时间倒序、同时间戳稳定。

`tests/shortcuts.test.ts`(追加):`Ctrl+J` → `downloads`;`Ctrl+Shift+J` → `null`;`releasesToTerminal({action:'downloads'})` 为 `true`。

集成层(真 Electron)不写 vitest —— 与 `device_*` 一族的做法一致:先 `bun run test:mcp` 看工具面,
再按 §4 的真机清单人工过。

---

## 6. 风险与未知

| 风险 | 说明 / 缓解 |
| --- | --- |
| **`setSavePath` 的历史 bug** | electron#6009(Windows 上「有时保存对话框仍弹出 / 路径不生效」)。第一版接受:静默路径失败退化为弹对话框,不会丢文件。真机清单 #1 覆盖 |
| **`setSaveDialogOptions` 语义古怪** | electron#41640:`will-download` 回调在对话框**弹出期间**就开始跑,`getFilename()` 不随用户改名更新,`getSavePath()` 会,且**没有**「对话框结束」事件 ⇒ 记录里 `savePath` 只能在 `done` 时补齐。这正是 §3.2 第 4 步与真机清单 #7 存在的原因 |
| **暂停/恢复的真续传取决于服务器** | `resume()` 文档写明:服务器不支持 Range 时会**丢弃已收字节从头来**。UI 必须给出提示(§3.2 的 `restart:true`),不能假装是续传 |
| **重启后的续传不做** | `createInterruptedDownload` 的老问题(electron#8061)。第一版只提供「重新下载」;若将来要做,记录里已经有 `urlChain/etag/lastModified(=resumable 快照)` 需要的字段 |
| **进度落盘频率** | 1s 节流 + 终态立即落盘;`downloads.json` 是数组型(整体替换),每写一次都是全量 → `maxRecords` 默认 500 保证文件不会大 |
| **AI 可以写任意目录** | `browser_download {saveDir}` 不做范围限制(与用户用地址栏下到任意位置同权限)。在 `MCP_INSTRUCTIONS` 里写清「只有用户明确要求时才传 saveDir」 |
| **核心硬编码插件浮层 id** | `tabShortcuts` 里出现 `plugin:downloads:panel`。代价:核心知道一个插件 id。替代方案(插件热键)会破坏终端里的 `Ctrl+J`,所以按现有「核心知道 `confirm-close`」的先例接受;并用「插件启用才打开」防住未知 id 挡页面那个坑(§1 表格最后一行) |
| **停用插件时正在下载** | 不取消(取消会删掉 `.crdownload` 临时文件,是有损的);保留 in-flight 的 `updated/done` 监听直到结束,记录还能落盘。代价:插件停用后仍会写 `downloads.json`(计划里明确接受;这是为了让用户的大文件不白下) |
| **`will-download` 是全局独占事件** | 若将来有第二个下载类插件会互相抢。本项目是「仓库内编译期插件」,接受,并在插件注释里写明这个前提 |
| **未验证的平台差异** | macOS 无真机(保存对话框 / `⌘J`);Linux 侧只能 headless + 合成事件。真机清单里 #1/#7 需要 Windows 侧确认(`--user-data-dir` 隔离实例) |

---

## 7. 不在本次范围(明确不做)

- `bow://downloads` 内部页面 / 系统通知 / 下载完成后自动打开。
- 跨会话断点续传(`createInterruptedDownload`)+ 暂停项重启后恢复。
- 多段并发下载、限速、按类型分流目录、下载队列(单文件串行)。
- 删除记录时删文件、以及「撤销删除」。
- `browser_pause_download` 之类的细粒度 MCP 工具(先用 `browser_list_downloads` 观测;真要控制再加)。

---

## 8. 实施记录(2026-09-22,已完成,待真机确认 UI 观感)

### 8.1 落地内容

新增:`src/plugins/downloads/{shared.ts,main.ts,ui.ts,ui/DownloadsButton.vue,ui/DownloadsPanel.vue,ui/DownloadsSettings.vue}`
+ `tests/downloadsShared.test.ts`(33 例)。

修改:`src/main/plugins/builtin.ts`、`src/renderer/src/plugins/registry.ts`(含 `SLOT_PLUGIN_ORDER.toolbar`)、
`src/shared/shortcuts.ts`(新 action `downloads` + `releasesToTerminal`)、`src/main/tabShortcuts.ts`(`case 'downloads'`)、
`src/main/mcp.ts`(`MCP_INSTRUCTIONS` 的下载一节)、`README.md`、`docs/ARCHITECTURE.md`(§1 / §5.8 / §6.2 / §7.3 / §8 / §11 / §13)、
`.pi/skills/bow-browser/SKILL.md`(44 个工具)。未改 preload / ipc.ts / tsconfig(与计划一致)。

### 8.2 验证结果

| 项 | 结果 |
| --- | --- |
| `bun run typecheck` | 干净 |
| `bun run test` | **46 文件 / 1001 例全绿**(基线 45/965) |
| `bun run build` | 成功 |
| `bun run test:mcp`(`SMOKE_ELECTRON_ARGS=--ozone-platform=headless`) | **工具数 44**,`browser_list_downloads` / `browser_download` 在册 |
| 临时端到端脚本(`/tmp/bow-dl-e2e.mjs`,真 Electron + 真 MCP + 真 CDP + 本地 HTTP 服务器) | **37 条断言全绿**:页面点击下载→静默落盘、`browser_download`(wait / 非 wait)、同名去重、暂停中字节不增长、支持 Range 的续传(字节连续 + 文件完整)、无 Range 也能暂停/恢复/取消/完整下载、取消不留 `.crdownload`、`retry` 产生 `retriedFrom` 记录、删除记录不动文件、落盘记录全为终态 |

### 8.3 实测发现(计划外的坑,都已写进代码注释)

1. **`item.canResume()` 不能用来判断「服务器支不支持续传」**:下载进行中恒 `false`、暂停时恒 `true`。
   → 记录里改成**观测字段** `restarted`(字节回退才置位),不再预判。原计划的 `resume` 返回 `restart` 已删除。
2. **服务器不支持 Range 时,`resume()` 不会丢弃已收字节**:Chromium 重发整份请求但保留已收部分继续追加,
   实测「支持 Range + ETag」与「只返回 200」两种服务器**都不回退**,最终文件均正确(所以 `restarted` 基本不出现)。
3. **AI 指令(`Directive`)的 URL 匹配不可靠**:`session.downloadURL()` 触发的 will-download 上
   `getURL()/getURLChain()` 拿不到可匹配的值 → 加「5s 内的队首指令可被认领」兜底,否则 `retry` 的 `retriedFrom` 会丢。
4. **`directive.silent` 只能强制静默**:早期实现里 `silent:false` 被当成「强制询问」,于是在用户已经关掉
   「下载前询问保存位置」时,「重新下载」仍会弹对话框(headless 下直接卡死)—— 真 bug,E2E 抓到。
   现在的语义:`silent === true` 才强制静默,否则一律遵循设置。
5. **未知浮层 id 会留下「透明但挡住一切」的遮罩**(OverlayApp 渲染 `null`,overlay 视图仍铺满窗口且没有 Esc 处理)
   → `Ctrl+J` 打开前必须确认下载插件已启用;此坑已写进 ARCHITECTURE §13。

### 8.4 仍需真机确认(只有真机能定论)

- 保存对话框的默认目录是否落在设置目录(`setSaveDialogOptions.defaultPath` 的观感)与 Windows 上 `setSavePath` 是否稳定;
- 面板/按钮在 125% 缩放、窄窗口下的观感;长文件名与路径截断;
- `Ctrl+J` 在**终端页**里确实落到 shell(accept-line)、在 DevTools 前端标签里能开面板;
- 停用插件时**进行中**的下载不被取消且记录继续更新(停用→启用后状态仍准);
- 询问模式下暂停/取消时面板显示「等待选择保存位置」的观感(实测逻辑正确,但没跑过真对话框);
- macOS(无真机):`⌘J`、保存对话框行为。
