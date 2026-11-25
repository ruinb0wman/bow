# 统一备份与还原（设置页一个入口，一个包文件）

日期:2026-11-05 · 状态:**已实施**(`app.relaunch` 真机验证待做,见 §10) · 范围:
`src/shared/backup.ts`(新)、`src/main/backup.ts`(新)、`src/main/stores.ts`、`src/main/ipc.ts`、
`src/preload/index.ts`、`src/renderer/src/settings/{SettingsPage,BackupSettings}.vue`(后者新)、
`src/shared/settingsNav.ts`、`src/main/plugins/pickJsonFile.ts`、`tests/`、`docs/ARCHITECTURE.md`、`README.md`。
**不动存储层、不动插件的数据格式、不给插件加任何 API。**

## 0. 一句话

现在 18 份数据散在 `<userData>` 下,备份要逐个插件去翻(书签能导出、密码库能导出、历史/终端/番茄钟只能靠用户自己复制目录)。
本方案在**设置页加一个核心分区「备份」**,把 18 份文件打**一个 `.json.gz` 包**,路径由用户在保存对话框里指定;
还原 = 校验整包 → 存一份现态快照 → 逐文件原子写回 → **自动重启**。

存储层一个字不改:数据本来就已经在同一个目录里,缺的只是「一个可携带的单文件 + 元数据 + 还原语义」。
这也保证了手改 JSON 的逃生通道(`files-settings.json` 是唯一能加文件白名单的入口)不被关掉。

## 1. 现状与证据(已核实)

| 事实 | 位置 |
| --- | --- |
| 全部数据都在 `app.getPath('userData')` 下,开发版/打包版共用(`mcp-browser` 旧名钉定) | `docs/ARCHITECTURE.md` §8;`src/main/ua.ts:37` |
| `JsonStore` 原子写(`.tmp` → `renameSync`),接口只有 `get/set/setRaw` | `src/main/stores.ts:20-73` |
| `save()` 是**私有**的,所有落盘都经它 → 一个冻结标志就能全局生效 | `src/main/stores.ts:62` |
| 内核缓存了每个插件注册过的数据文件名(`storageCache`) | `src/main/plugins/kernel.ts:93`、`storageFor()` 在 `:400` |
| ⚠️ 该缓存**只含已激活插件**的文件:插件被停用 ⇒ 它不在清单里 ⇒ 备份会漏 | 同上(停用不 activate) |
| 核心 4 份文件不在 `storageCache` 里,散在三处字面量:`settings.json`/`split-layouts.json`(`stores.ts:86-87`)、`plugins.json`(`kernel.ts:103`)、`files-settings.json`(`fileRoots.ts:169`) | — |
| 即插即用的文件对话框已有:`pickJsonFile()`(`showOpenDialog` + 挂父窗口 + 读文本) | `src/main/plugins/pickJsonFile.ts:30-45` |
| 下载目录解析与日期戳已有:可复用作「默认保存路径」 | `src/main/plugins/exportFile.ts:26,44` |
| 设置页侧栏是固定清单 + 插件项,内核有精确断言测试 | `src/shared/settingsNav.ts:11`;`tests/settingsNav.test.ts:19-27` |
| 设置页组件是 `activeId` 的 if 链(加一项要动 3 处) | `src/renderer/src/settings/SettingsPage.vue:113-131` |
| `node:zlib` 可用,**不需要**新依赖(不引 zip 库) | 主进程内置 |
| `Window.browserAPI` 类型只从 `BrowserAPI` 接口来,加方法只改一个文件 | `src/preload/index.d.ts:5` |

数据总量实测(本机):`history.json` 985 B / 6 条、`bookmarks.json` 1.2 KB / 10 条、其余各几百字节 ——
整包解压后 **< 4 KB**,所以「包太大」不是问题,格式也不需要考虑分片/增量。

## 2. 契约:备份包格式

后缀 `.json.gz`(gzip 的 JSON 信封)。文件名 `bow-backup-YYYY-MM-DD.json.gz`。

```ts
// src/shared/backup.ts (纯逻辑,不碰 fs)
export const BUNDLE_VERSION = 1
export interface BackupEnvelope {
  version: 1
  appVersion: string        // app.getVersion()
  createdAt: number         // ms
  files: Record<string, string>  // 文件名 → 该文件的**原始文本**
}
export function buildEnvelope(files: Record<string, string>, meta: { appVersion: string; createdAt: number }): BackupEnvelope
export function parseEnvelope(text: string): { ok: true; envelope: BackupEnvelope } | { ok: false; error: string }
export function sanitizeOnRestore(name: string, text: string): string   // 见 §5 的例外
```

`files` 里存**原始文本**而不是解析后的对象:还原时能逐字节写回(手改过的排版、遗留字段全部保住),
也让 `parseEnvelope` 的校验退化成「每个值能不能 `JSON.parse`」。

`parseEnvelope` 的拒绝理由必须具体(用户在还原失败时要看得懂):

1. `version` 不是 `BUNDLE_VERSION` → `不支持的备份版本:…(当前 bow 只认 1)`(未来兼容留口,现在只写 1);
2. `files` 不是非空对象 → `备份文件里没有数据`;
3. 某个值是字符串但 `JSON.parse` 失败 → `备份已损坏:history.json 不是合法 JSON`;
4. 一个已知文件名都没命中 → `这个文件不像是 bow 备份`。

**不做 sha256**:gzip 自身带 CRC32,足以挡住截断/损坏;防篡改不在威胁模型内。
**保留包里的未知文件**:来自更新的 bow 的新插件文件,原样写回,当前版本忽略即可 —— 不静默丢弃用户数据。

## 3. 改动清单

### 3.1 `src/shared/backup.ts`(新,纯逻辑)

- `BUNDLE_VERSION` / `BackupEnvelope` / `buildEnvelope` / `parseEnvelope` / `sanitizeOnRestore`(§2);
- **静态文件清单**(唯一真相源):
  - `PLUGIN_DATA_FILES`(14):`bookmarks.json`、`cors.json`、`device-inspect.json`、`downloads.json`、
    `downloads-settings.json`、`editor.json`、`history.json`、`history-settings.json`、`mcp-http.json`、
    `passwords.json`、`passwords-settings.json`、`pomo.json`、`services.json`、`terminal.json`;
  - `CORE_FILES`(4):`settings.json`、`split-layouts.json`、`plugins.json`、`files-settings.json`;
  - `ALL_DATA_FILES = PLUGIN_DATA_FILES ∪ CORE_FILES`;
- 为什么**不用** `kernel.storageCache` 当清单:停用的插件没有 activate ⇒ 文件不在缓存里 ⇒ 备份会漏(§1 表第 5 行)。
  缓存只用来做**交叉校验**:导出时若发现缓存里有不在清单里的文件,记一条 `ctx.log` 警告(说明新插件忘了登记),不阻断。

### 3.2 `tests/backupFiles.test.ts`(新)

钉住「静态清单不会漂」:扫 `src/plugins/*/main.ts` 的源码文本,用 `/file: '([\w.-]+\.json)'/g`
抽出所有声明,断言 ⊆ `PLUGIN_DATA_FILES` 且**反向也成立**(清单里每个插件文件都能在源码里找到声明)。
这是仓库既有的「正则扫源码判语义」手法(`bundleScan.test.ts` 同款);`src/plugins/*/vault.ts` 之类不参与。

### 3.3 `tests/backup.test.ts`(新)

`parseEnvelope` 的四条拒绝理由各一例 + 正常往返 + 未知文件保留 + `sanitizeOnRestore` 对
`device-inspect.json` 的裁剪(见 §5)。

### 3.4 `src/main/stores.ts`

加**冻结标志**(还原期间禁止任何落盘,否则活着的内存快照会把刚还原的磁盘内容盖回去):

```ts
let frozen = false
export function freezeStores(value: boolean): void { frozen = value }
// JsonStore.save() 第一行: if (frozen) return
```
`save()` 是私有且是唯一落盘点 ⇒ 一处生效,覆盖全部 18 个文件。

### 3.5 `src/main/backup.ts`(新,主进程 I/O + 编排)

```ts
export async function exportBackup(): Promise<{ canceled?: true; ok?: true; path?: string; error?: string }>
export async function restoreBackup(): Promise<{ canceled?: true; ok?: true; error?: string }>
```
- `gatherFiles()`:遍历 `ALL_DATA_FILES`,读原文;不存在的文件**跳过(不塞空默认值)** —— 塞默认值等于用旧默认覆盖用户没碰过的配置。
- `exportBackup()`:
  1. `dialog.showSaveDialog(parent, { title: '保存 bow 备份', defaultPath: join(resolveDownloadsDir(), `bow-backup-${dateStamp()}.json.gz`), filters: [{ name: 'bow 备份', extensions: ['gz'] }] })`
     —— 「让用户指定存放目录」就是这一步;**不自动落盘到下载目录**;
  2. `gzipSync(JSON.stringify(buildEnvelope(...)))` → `writeFileSync(path, buf, { mode: 0o600 })`(包里有密码库密文,别裸奔);
  3. 返回路径给 UI 显示「已保存到 …」。
- `restoreBackup()`:见 §4 时序。

### 3.6 `src/main/ipc.ts`

`registerIpc()` 里加两个 handle(与 `settings:get` 同区,`ipc.ts:228` 附近):

| 通道 | 参数 | 返回 |
| --- | --- | --- |
| `backup:export` | — | `{canceled:true}` / `{ok:true, path}` / `{ok:false, error}` |
| `backup:restore` | — | `{canceled:true}` / `{ok:true}` / `{ok:false, error}`(成功后 300ms 自动重启) |

两个通道都在主进程里自己弹对话框 ⇒ 不需要传路径、不需要多窗口协调(还原是**进程级**操作)。

### 3.7 `src/preload/index.ts`

`BrowserAPI` 加一组:
```ts
backup: {
  export: () => Promise<{ canceled?: true; ok?: true; path?: string; error?: string }>
  restore: () => Promise<{ canceled?: true; ok?: true; error?: string }>
}
```
`src/preload/index.d.ts` 不用改(它只 re-export `BrowserAPI`)。

### 3.8 `src/main/plugins/pickJsonFile.ts`

就地加一个 `pickSaveFile()`(与 `pickJsonFile()` 同一个理由:同一个「挂父窗口的对话框」样板别复制第二份),
导出 `{ canceled, path? }`,参数是 `{ title, defaultPath, extensions }`。还原用的读取继续复用 `pickJsonFile()`
——它的 `filters` 写死了 `['json']`,改成可选参数 `filters?: Electron.FileFilter[]`,两个既有调用方(书签、密码库)不传即保持原样。

> 备选:把文件改名成 `fileDialogs.ts`。**不做** —— 3 个调用点改名是纯 churn。

### 3.9 `src/shared/settingsNav.ts`

加 `SETTINGS_BACKUP_ID = 'backup'`,固定顺序插在「快捷键」之后、「插件管理」之前(插件管理保持最后),
`SettingsNavItem` 联合类型加 `kind: 'backup'`。同步改 `tests/settingsNav.test.ts` 的两处精确断言(数组 + 文案)。

### 3.10 `src/renderer/src/settings/SettingsPage.vue`

三处:标题 `<template v-else-if="activeId === SETTINGS_BACKUP_ID">备份</template>`
(`:117` 一带)、组件 `<BackupSettings v-else-if="activeId === SETTINGS_BACKUP_ID" />`(`:128` 一带)、import。

### 3.11 `src/renderer/src/settings/BackupSettings.vue`(新)

- 两个按钮:「导出备份」「从备份还原」;
- 说明文字:**包含**什么(18 份配置/数据,列出类别)、**不包含**什么(cookies 与登录态、下载的文件、日志、Chromium 缓存);
- 还原按钮二次确认交给主进程的系统对话框(§4),渲染层只做「进行中」置灰与结果提示;
- 还原成功后界面会立刻消失(进程重启)——说明文字里写清楚「成功后 bow 会自动重启」。

## 4. 还原时序(**本方案最容易出错的地方**)

```
1. pickJsonFile() 选包         → 取消则安静返回
2. 读文本 → gunzip → parseEnvelope      → 任一步失败:**不碰磁盘**,回具体错误
3. 系统确认框 dialog.showMessageBox(parent, {
     type:'warning', buttons:['取消','还原并重启'], defaultId: 0, cancelId: 0,
     message: `用备份覆盖当前的 ${n} 份配置与数据?(会覆盖:插件启停、MCP HTTP 端口/令牌、书签、历史、密码库、终端与下载设置。)`
   })
4. 现态快照:<userData>/backup-before-restore.json.gz(固定名,每次覆盖)
     —— 复用 exportBackup 的 gather+gzip 路径;失败 → **中止还原**并报错
5. freezeStores(true)
6. 逐文件:对每个 name → sanitizeOnRestore → 写 name+'.tmp' → renameSync
     —— 与 JsonStore.save() 同一套原子写法;任一失败 → 报错并提示现态快照路径(此时可能半写,快照就是退路)
7. 先回 IPC 响应,再重启: setTimeout(() => { app.relaunch(); app.exit(0) }, 300)
```

四条不能省的细节:

- **先回话再退出**:`app.exit(0)` 紧跟 `return` 会掐掉在途的 IPC 响应,渲染层永远等不到结果(它会以为卡住了)。
- **`freezeStores(true)` 必须在写盘之前**:还原期间任何事件(`tab:navigated` 写 history、番茄钟状态迁移、
  下载进度节流)都会把**旧的内存快照**盖回磁盘,结果就是「还原了但没生效」。
- **`app.relaunch()` 不传 args**:默认沿用当前 argv 与环境,stdio / HTTP 模式的实例不会被改成 GUI 实例。
- **不提供部分还原、不做选择性勾选**:全量覆盖是最小的正确语义(单插件导出/导入已按用户要求下线,见 §5)。

## 5. 数据清单与例外

进包(18):`bookmarks.json`、`history.json`、`history-settings.json`、`downloads.json`、`downloads-settings.json`、
`passwords.json`、`passwords-settings.json`、`terminal.json`、`editor.json`、`cors.json`、`pomo.json`、
`services.json`、`mcp-http.json`、`device-inspect.json`、`settings.json`、`split-layouts.json`、`plugins.json`、
`files-settings.json`。

**不进包**:

| 不备 | 为什么 |
| --- | --- |
| cookies / 登录态 / Chromium profile(`Cookies`、`Local Storage`、`IndexedDB`、`Cache`) | 用户已拍板不做。敏感(明文 session token)+ 体积几十上百 MB + 机器绑定 |
| 下载的文件本身 | 用户内容,已在用户自己管的下载目录里 |
| `browser.log` | 日志 |

**还原时需要裁剪的(`sanitizeOnRestore`)**:

| 文件 | 裁剪 | 理由 |
| --- | --- | --- |
| `device-inspect.json` | `forwards: []` | 那些是 **adb server 进程里的端口转发登记**,机器相关;跨机写回只会指向不存在的设备(其余字段照常还原) |

**已知不完美但接受**:`downloads.json` 里的 `savePath` 是绝对路径,跨机还原后指向不存在的位置 ——
下载插件本来就在读盘时过 `reconcileOnStart()` + `fileExists` 检查,会标成文件不存在,不会崩。
`files-settings.json` 的 `roots` 同理,UI 说明里写「还原后可能需要重新添加工作目录」(不改代码)。

**单插件导出/导入已于实施后下线**(用户 2026-11-05 拍板):书签的 JSON 导出/导入、密码库的加密备份导出/导入
连同上游工具(`writeToDownloads`、`normalizeImportedTree`、`parseVaultFile`)一并删除,备份粒度统一成整包。
代价:**没有局部恢复**了(想只换书签只能整包还原);`pickJsonFile.ts` 随之改名 `fileDialogs.ts`(只剩 `pickFile` / `pickSaveFile`)。

## 6. 不做的事

- 不引数据库 / 不改 `JsonStore` 的存储格式(备份层先做掉,存储层换不换是独立的另一件事);
- 不引 zip / 不新增任何依赖(`node:zlib` 现成);
- 不做增量备份、云端同步、定时自动备份、加密整个包(密码库那块已在包内自带 AES-GCM 密文);
- 不做 sha256 防篡改、不做版本降级兼容(只认 `version: 1`);
- 不做热重载(不重启就生效)——那要 16 个插件各写一个 `reload`,是另一个量级的事;
- 不动插件的 `ctx.storage` 契约、不动插件的 MCP 工具面。

## 7. 验收判据

1. 设置页出现「备份」分区(在「快捷键」之后、「插件管理」之前);点「导出备份」弹保存对话框,默认名
   `bow-backup-YYYY-MM-DD.json.gz`、默认目录 = bow 下载目录;**可以改目录**;保存后界面显示实际路径。
2. `gunzip -c 包 | jq '.files | keys'` 得到 18 个键;`jq '.files["history.json"]'` 的内容与磁盘上逐字一致(含排版)。
3. 跑掉一批改动(加书签、改搜索引擎、停用一个插件)→ 还原该包 → 确认框 → **自动重启** → 三项都回到备份时状态;
   `<userData>/backup-before-restore.json.gz` 存在,且解出来是「还原前」的状态。
4. 三个坏包(截断的 gzip / `version: 99` / `files["history.json"]` 是个数组)各试一次:都**不写盘**,
   报错文案具体到文件,`backup-before-restore.json.gz` 不被创建(走到第 4 步才算失败)。
5. **停用一个插件后再备份**:该插件的数据文件仍在包里(静态清单生效,不依赖 `storageCache`)。
6. 还原期间的落盘确实被冻住:还原前把 history 清空 → 还原后重启 → history 回到备份时的条数(而不是被清空)。
7. `npm test` 全绿(新增 2 个测试文件;`settingsNav.test.ts` 断言已更新)、`npm run typecheck`、
   **`npm run build`**(改了 `.vue`,这条只有 build 会报错 —— `tsc` 不检查 `.vue`)。
8. 真机各验一次:dev(`npm run dev`)与打包版(`npm run dist` → `dist/<平台>-unpacked/bow`)的
   **`app.relaunch()` 行为**(这是本方案唯一没有先验保证的环节,见下)。

## 8. 文档同步(§14 的硬要求)

- `docs/ARCHITECTURE.md` §8 数据文件表:加一行 `<userData>/backup-before-restore.json.gz`(所有者 = 核心 `main/backup.ts`);
- §9 IPC 表:加 `backup:export` / `backup:restore` 两行;
- §11 测试表面:加 `backup`(x 例)、`backupFiles`(x 例),更新「当前基线」的文件数/用例数;
- `README.md`「数据存储」一节(`:658` 起):加一句「统一备份/还原:设置页 → 备份,单个 `.json.gz` 包,
  不含登录态与下载的文件」。
- 本文件 §6/§7 若实施时有调整,以代码注释与本文件为准并同步回来。

## 9. 工期与风险

约 **0.5–1 天**(含两个测试文件与一次真机验证)。

| 风险 | 应对 |
| --- | --- |
| **`app.relaunch()` 在 dev / 打包版下行为不同**(唯一先验未知项) | 实施第一件事就是写一个 20 行的 spike:A 按钮 → relaunch → 看进程是否恢复;dev 由 electron-vite 拉起,重启后 vite dev server 仍在、`ELECTRON_RENDERER_URL` 仍有效 |
| 还原是破坏性操作,中途失败会半写 | 现态快照 + 「整包校验先做完再动盘」两步保证;快照路径在错误文案里直接给用户 |
| 静态清单漂移(新插件加了 `ctx.storage` 却忘了登记) | `tests/backupFiles.test.ts` 扫源码,双向断言;运行期 `storageCache` 交叉校验打日志 |
| 用户在 stdio / HTTP 模式下还原 | relaunch 沿用 argv,重启后仍是同一模式;不需要额外分支 |

## 10. 实施记录(偏离计划的地方)

1. **对话框没改 `pickJsonFile()` 的签名**,而是新增 `pickFile()`(返回 **Buffer**)与 `pickSaveFile()`:
   备份包是 gzip,gzip 字节用 `utf-8` 读会被解码坏(还原时表现为「gzip 解不开」)。
   `pickJsonFile()` 保持原契约不动 —— `tests/pickJsonFile.test.ts` 钉着「选中了但读不出来 ≠ 取消」。
2. **`parseEnvelope` 多了一条计划里没写的校验:文件名白名单**(`^[A-Za-z0-9._-]+$`,禁 `..`)。
   备份包是**外来文件**,还原会按里面的键往 `userData` 写盘 ⇒ `../../.bashrc` 本来能写到任意位置。
   这是信任边界,不是可选项;`tests/backup.test.ts` 有专门的路径穿越用例。
3. **`gunzipSync` 加 `maxOutputLength: 64 MiB`**:真实包解压只有几 KB,这个上限只挡压缩炸弹。
4. **写盘失败时解冻**(计划只写了成功路径):半写之后再继续冻结,会让应用**静默地不再保存任何东西**,
   比半写更糟。用户手上的退路就是那份现态快照,错误文案里直接把路径给他。
5. **交叉校验真的接了**:内核加 `storageFiles()`,`exportBackup(registered)` 发现漏登记就 `logError`,不阻断导出。
6. **测试从 2 个文件变 3 个**:多出的 `tests/backupRestore.test.ts` 用 `vi.mock('electron')` + 临时目录
   把「校验 → 快照 → 冻结 → 原子写 → 延后重启」整条**真路径**盖住了(计划里只规划了纯逻辑测试)。
   两个坑:①`app.exit` 必须 mock,否则测试进程真的退出;②成功用例会把模块级冻结标志留在 `true`
   (真实进程此时本来就该退出了),所以闸门用例开头要显式解冻。
7. **`app.relaunch()` 真机 spike 没做**:开发沙箱里开不了窗口(X11/EPERM)。这是本方案唯一未经真机
   验证的环节 —— 请在真机上各试一次 `npm run dev` 与打包版:「导出 → 还原 → 确认」之后进程必须自己回来,
   且回来后设置是备份里的那份(`backup-before-restore.json.gz` 同时存在)。
8. **第二轮:删掉单插件备份**(2026-11-05,用户要求「把书签和密码的备份去掉」)。删了:书签的
   `export`/`import` IPC + `BookmarksSettings.vue` + `bookmarks/shared.ts`、密码的 `exportBackup`/`importBackup`
   IPC + 设置页那一段、`shared/bookmarkTree.ts` 的 `normalizeImportedTree`、`passwords/vault.ts` 的
   `parseVaultFile`/`IMPORT_KDF_LIMITS`/`isSealed`、`exportFile.ts` 的 `writeToDownloads`,
   以及对应的 5 处测试(1281 例)。书签插件因此**不再有设置分区**(导航里那项消失)。
9. 顺带更新了 `README.md`「数据存储」首条、`ARCHITECTURE.md` §8(数据文件 + 机制说明)、§9(IPC 表)、
   §7.3(设置页分区枚举)、§11(测试基线:78 → 79 文件 / 1310 例)。
</content>
