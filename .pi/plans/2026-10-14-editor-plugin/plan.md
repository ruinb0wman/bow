# 编辑器插件:终端里的 nvim + Windows「编辑」动词

日期:2026-10-14 · 状态:**待批准**(方案已逐项与用户确认,代码一行未动)

> 形态拍板:**只做「终端里的 nvim」**——复用终端插件的 xterm + node-pty,**不引入 CodeMirror / Monaco,不新增任何运行时依赖**。
> 本文档里的「编辑器」= bow 标签页里一个跑着 `wsl.exe -e nvim <file>` 的终端会话。

## 0. 目标与已确认的决策

**目标**

1. 双击 `.txt` / `.md` / `.json` 等(或右键「用 bow 编辑」)时,由 bow 打开,并**直接在 nvim 里编辑那个文件**;
2. bow 出现在 Windows「设置 → 默认应用」的候选里,用户点一次就能把某类文件交给它;
3. 撤销注册后,系统恢复原样(不动别人的关联)。

**用户已拍板的四个选择**(2026-10-14)

| 决策点 | 选择 |
| --- | --- |
| 编辑器形态 | 只做终端里的 nvim(v1 不做内置 CodeMirror、不做 `bow://editor` 内部页面) |
| nvim 跑在哪 | **WSL 里** → 默认命令 `wsl.exe -e nvim {file}`,路径写法 `wsl`(`C:\a\b.txt` → `/mnt/c/a/b.txt`) |
| Windows 注册力度 | **候选 + 「编辑」动词**;**不做** `*\shell` 全局右键;**不写** `Classes\.<ext>` 默认值 |
| 默认扩展名 | 纯文本 + 常见代码(见 §4.4),注册表与插件设置共用同一份清单 |

**假设**

- 主运行平台是 **Windows 上的 bow.exe**(README/ARCHITECTURE 的既有前提),WSL 发行版里有 `nvim` 且在 PATH 上;
- 终端插件的 node-pty 通路在 Windows 上已经跑通(见 `.pi/plans/2026-09-19-terminal-plugin/plan.md` §10),本计划不重新验证它;
- `--edit` 是 bow 自己的开关,只由注册表里的 `shell\edit\command` 与「用编辑器打开…」按钮产生。

## 1. 已核实的现状(代码事实,改动都基于这些)

| 事实 | 位置 |
| --- | --- |
| 第二个进程只传意图,参数交给常驻实例开新窗口 | `src/main/index.ts:118`(`second-instance`) |
| argv → 待打开目标(裸路径/file:// /http),`--*` 开关一律丢弃 | `src/main/openArgs.ts`、`src/main/index.ts:101` |
| 目标在这里被开成标签:**没有插件参与决策** | `src/main/index.ts:213` `for (const target of targets) tabs.create(target)` |
| 插件上下文(`ctx`)已有 ipc / events / suggest / mcp / net / content / pages / tabs / service / shortcuts | `src/main/plugins/types.ts:137` |
| `ctx.tabs` **只读**(list/getActive),插件**不能建标签** | `src/shared/plugins.ts:101`(`PluginTabApi`),`src/main/plugins/types.ts` 里只是 `tabs: PluginTabApi` |
| 唯一"插件建标签"的先例:核心出的窄能力 `ctx.pages.openDevToolsTab` | `src/main/plugins/types.ts`、`kernel.ts` `setPageApi` |
| 内核 host 注入点:setBroadcaster / setUiHost / setTabProvider / setPageApi | `src/main/plugins/kernel.ts:131,135,139,157` |
| `ctx.events` 是**全局总线**(任何插件 emit,所有订阅者收) | `src/main/plugins/kernel.ts:307,323` |
| 终端会话按 tabId 绑定;`attach()` 时按**默认 profile** spawn | `src/plugins/terminal/main.ts:216,230` |
| spawn 参数只来自 profile(`buildSpawnSpec`),没有"跑一条指定命令"的入口 | `src/plugins/terminal/shared.ts:215` |
| `cleanEnv` / `isWslShell` / `withBowTerminalEnv` / `findInPath` 现成 | `src/plugins/terminal/shared.ts:230,249,269,319` |
| `windowsPathToWsl`(C:\x → /mnt/c/x)现成,但只给 pi 桥接用 | `src/plugins/terminal/piBridge.ts:80` |
| 终端页把 profileName 写进标签标题 | `src/plugins/terminal/ui/TerminalView.vue:191` |
| 默认浏览器插件已有一整套 Windows 注册能力:纯计划 + I/O 编排 + 状态展示 | `src/plugins/default-browser/{windowsRegistry.ts,registration.ts,main.ts}` |
| 注册表原语(`regAddArgs` / `regQueryArgs` / `parseRegQuery*` / `buildAssocProbeScript`)是纯函数 | `src/plugins/default-browser/windowsRegistry.ts:249,254,259,264,282,301,360,387` |
| `userChoiceTargets()` 里**写死了** http/https/.html/.htm/.xhtml | `src/plugins/default-browser/windowsRegistry.ts:92` |
| 终端插件有单测注入缝 `createTerminalPlugin({ loadPty })` + 假 pty | `tests/terminalAgentSignal.test.ts` |
| 新插件 = 加目录 + **登记两行**(`builtin.ts`、渲染层 `registry.ts`) | `src/main/plugins/builtin.ts`、`src/renderer/src/plugins/registry.ts` |
| 新文件名必须进 `tsconfig.node.json` 的 include(白名单式) | `tsconfig.node.json` |

**Windows 侧不可绕过的现实**(决定了方案的形状)

- Windows 8+ 起默认关联由 `UserChoice` + 每用户哈希保护,10/11 还叠了 UserChoice Protection Driver(2024-02 KB5034763/KB5034765):
  **程序无法把自己设为默认**。能做的只有注册成候选,最后一步用户在「设置 → 默认应用」点。仓库里的
  `default-browser` 插件与 README:135-152 已经把这套做法和话术定下来了,编辑器沿用同一套。
- 传统注册表动词在 **Win11 主右键菜单里不显示**,落在「显示更多选项」里。进主菜单要 IExplorerCommand + MSIX 打包,**不做**。

## 2. 架构决策

### 2.1 数据流

```
Explorer 双击 a.txt / 右键「用 bow 编辑」
  → 注册表: bowEditor\shell\open|edit\command = "<bow.exe>" --edit "%1"
  → 第二个进程把 argv 交给常驻实例(已有通路)
  → openArgs.collectOpenTargets → file:///C:/tmp/a.txt; --edit → editMode = true
  → kernel.fileOpeners.claim(path, mode)            ← 核心只做「问一圈」
      ├ 命中(editor 插件):
      │    1. ctx.tabs.openInternal('terminal') → tabId      (核心建标签)
      │    2. ctx.events.emit('terminal:run', {tabId, file:'wsl.exe',
      │         args:['-e','nvim','/mnt/c/tmp/a.txt'], cwd:'C:\\tmp', name:'nvim(a.txt)'})
      │    3. 终端页加载完 → invoke('attach', {tabId}) →
      │       终端插件发现该 tabId 有 pending → 用 pending spawn(不走默认 profile)
      │       → xterm 里就是 nvim
      └ 未命中: 照旧 tabs.create(file://…) —— 今天的行为一点不变
```

**分工原则**(与 `openDevToolsTab` / `uploadFiles` 同构):**资源与权限在核心,决策在插件**。
核心不认识"编辑器",只认识两件事:①「插件可以让我建一个内部页标签,并拿到 tabId」②「开本地文件之前先问一圈谁能认领」。

### 2.2 为什么不做全局 `*\shell` 右键

- `HKCR\*\shell\...` 会出现在**所有**文件的右键菜单里(含 .exe/.dll),太吵;
- 按扩展名挂「编辑」动词有正路:`HKCU\Software\Classes\SystemFileAssociations\.<ext>\shell\<verb>\command`
  —— per-extension、**与该扩展名当前的默认处理程序无关**、不抢默认(Windows XP 起的官方机制)。
  反面例子是把动词挂在 `HKCU\…\Classes\.<ext>\shell` 下:该扩展名一旦有 ProgID 就**不生效**(经典坑)。
- 代价:Win11 主菜单不显示(见 §1),且白名单以外的文件没有右键入口 → 用 §5 的「用编辑器打开…」按钮兜底。

### 2.3 三个明确的设计取舍

1. **路由只接 argv 那条通路**(双击 / 右键 / 命令行)。地址栏输入本地路径、网页里指向本地文件的链接
   仍按老样子开浏览器标签——不动那两条通路,风险最小。要扩展时只需再造一个 `claim()` 的调用点。
2. **路径换算不出就不认领**(UNC `\\wsl$\…` 之类):回落成浏览器标签并记日志,不猜、不静默失败。
3. **不做 nvim 预检测**:直接开终端,pty 起不来的报错原样显示(与现在 shell 起不来一模一样);
   设置页给一个「测试」按钮(开一个空 nvim 标签)。

## 3. 文件改动清单

### 新增

| 文件 | 职责 |
| --- | --- |
| `src/main/plugins/fileOpeners.ts` | 核心:本地文件认领注册表(纯逻辑,形状照 `McpHost`:按注册顺序问,第一个认领的说了算;停用自动回收) |
| `src/main/plugins/registryOps.ts` | 核心:`reg.exe` 原语 + PowerShell 关联探测的**纯函数**(从 `default-browser/windowsRegistry.ts` 搬过来,零改动搬迁) |
| `src/shared/terminalRun.ts` | 内核事件契约:`TERMINAL_RUN_EVENT` + `TerminalRunRequest`(类型 + 常量,两端共用,不引 electron/DOM) |
| `src/plugins/editor/shared.ts` | 编辑器设置模型 + 规范化 + `buildEditorCommand()` + `shouldOpenInEditor()` + 默认扩展名清单(纯) |
| `src/plugins/editor/main.ts` | 插件主进程侧:认领 → 开标签 → 发 `terminal:run`;IPC;Windows 注册入口 |
| `src/plugins/editor/windowsRegistry.ts` | 编辑器注册计划(纯):ProgID / OpenWithProgids / SystemFileAssociations 动词 / Applications / Capabilities 的增删与状态键 |
| `src/plugins/editor/registration.ts` | 编辑器注册的 I/O 编排(形状照抄 `default-browser/registration.ts`:幂等、撤销前 `reg query` 核对、只删自己写的) |
| `src/plugins/editor/ui.ts` + `ui/EditorSettings.vue` | 设置分区:命令模板 / 路径写法 / 扩展名清单 / 注册状态 / 「打开系统默认应用设置」/ 步骤文案 |
| `src/plugins/editor/ui/EditorButton.vue` | 工具栏「用编辑器打开…」(文件选择框 → 开 nvim 标签) |
| `tests/fileOpeners.test.ts`、`tests/editorShared.test.ts`、`tests/editorRegistry.test.ts`、`tests/terminalRun.test.ts` | 单测 |

### 修改

| 文件 | 改什么 |
| --- | --- |
| `src/main/plugins/types.ts` | `PluginTabHost` + `PluginContext.tabs.openInternal`;`PluginContext.fileOpeners.register` |
| `src/main/plugins/kernel.ts` | `setTabHost()` 注入 + 空实现;`fileOpeners` host 接线(KernelApi + PluginContextImpl) |
| `src/main/index.ts` | 注入 tabHost;解析 `--edit`;`:213` 的 targets 循环改成"先问 `fileOpeners.claim()`,没人认领才 `tabs.create()`" |
| `src/plugins/terminal/shared.ts` | 新增纯函数 `buildCommandSpawn(request, { homedir })` |
| `src/plugins/terminal/main.ts` | tabId → pending 命令表;订阅 `TERMINAL_RUN_EVENT`;`attach()` 优先 pending;`describe()` 用命令名当 profileName |
| `src/plugins/terminal/piBridge.ts` | `windowsPathToWsl` 改为从 `@shared/localFile` 导入(函数体搬到 shared,`tests/piBridge.test.ts` 一行不动) |
| `src/shared/localFile.ts` | 接收 `windowsPathToWsl`(纯函数,与 `expandHome` / `isFileUrl` 同类) |
| `src/plugins/default-browser/windowsRegistry.ts` | 删掉搬走的原语,改为 `export * from '../../main/plugins/registryOps'` 或逐个 re-export;`userChoiceTargets` 里文件类型的部分抽成 `fileUserChoiceTargets(exts, progId)` |
| `src/main/plugins/builtin.ts`、`src/renderer/src/plugins/registry.ts` | 各登记一行 `editor` |
| `tsconfig.node.json` | include 里补新文件名(`registryOps.ts` 配置顶层已覆盖 `src/main/**/*`;`src/plugins/editor/{shared,windowsRegistry,registration}.ts` 需要分别加一条) |

**不新增任何 npm 依赖。**

## 4. 契约细节

### 4.1 核心新增能力 ①:插件能建内部页标签

```ts
// src/main/plugins/types.ts
export interface PluginTabHost {
  /** 建一个内部页标签,返回 tabId;打不开(没有窗口等)返回 null */
  openInternal(page: InternalPageId, opts?: { activate?: boolean; windowId?: number }): number | null
}
export interface PluginContext {
  // …
  tabs: PluginTabApi & { openInternal: PluginTabHost['openInternal'] }
}
```

- 只允许**内部页**(`InternalPageId`,目前 settings / terminal / logseq):插件仍然无法导航用户的浏览标签、无法建任意 URL 标签。
- 复用 `TabManager.openInternal()`:settings 是 singleton(已有就聚焦),terminal 每次新建 —— 正是编辑器要的。
- 注入(`src/main/index.ts`,`kernel.setTabProvider` 旁边):

```ts
kernel.setTabHost({
  openInternal: (page, opts) => {
    const wc = opts?.windowId ? windows!.byId(opts.windowId) : windows!.focused()
    return wc?.tabs.openInternal(page)?.id ?? null
  }
})
```

- 兜底:kernel 未注入时 `openInternal` 返回 `null`(插件必须处理 null,不许崩)。

### 4.2 核心新增能力 ②:本地文件认领

```ts
// src/main/plugins/fileOpeners.ts(纯逻辑,不 import electron)
export type LocalFileMode = 'open' | 'edit'

export interface LocalFileOpener {
  /** 插件 id(诊断与顺序用) */
  id: string
  /** 认不认这个文件 */
  match(path: string, mode: LocalFileMode): boolean
  /** 认领了就由它负责打开;返回 false / 抛错 = 放弃,核心继续问下一个,最后照旧开 file:// 标签 */
  open(path: string, mode: LocalFileMode): boolean
}

export class FileOpenerHost {
  add(id: string, opener: Omit<LocalFileOpener, 'id'>): () => void
  /** 按注册顺序问一圈;true = 已经有人打开过了,调用方不要再开标签 */
  claim(path: string, mode: LocalFileMode): boolean
  /** 设置页/诊断用 */
  list(): Array<{ id: string; claimed?: never }>
}
```

- 与 `McpHost` / `addProvider` 同构:`open()` 抛错只记日志,不影响下一个 opener,也不影响"照旧开标签"的兜底。
- `claim()` 是**同步**的(`openInternal` 与 `emit` 都是同步的),所以核心的 targets 循环不需要改成 async。

### 4.3 内核事件 `terminal:run`

```ts
// src/shared/terminalRun.ts
export const TERMINAL_RUN_EVENT = 'terminal:run'

export interface TerminalRunRequest {
  /** 目标标签(由发起的插件用 openInternal 拿到) */
  tabId: number
  /** node-pty 的 spawn 目标(与 terminal 的 SpawnSpec 同形) */
  file: string
  args: string[]
  /** 工作目录;省略 = 用户主目录 */
  cwd?: string
  /** 标签标题里显示的名字,如 `nvim(a.txt)` */
  name?: string
}
```

- **时序不变式**:`openInternal()` 返回 → `emit()` → 标签页异步加载 → `invoke('attach')`。所以 attach 一定晚于 emit,不需要握手。
- 终端插件侧:`pending: Map<tabId, TerminalRunRequest>`,订阅时只接受合法 payload(tabId 为正整数、file 非空)。
- `attach()` 顺序:①已有会话 → 复用(不动 pending);②有 pending → 用它 spawn,**spawn 成功后删除**(失败保留,刷新可重试);
  ③否则默认 profile(今天的行为)。
- `Session` 增加 `commandName?: string`,`describe()` 的 `profileName` 取它 → `TerminalView.vue:191` 自然把标签标题写成
  「终端 — nvim(a.txt)」,前端零改动。
- 插件被停用时 `deactivate` 里清空 pending(与既有的 killAll 一起)。
- 环境仍走 `cleanEnv` + `withBowTerminalEnv`(WSL 场景下 `BOW_TERMINAL` 照样进发行版,顺手保持一致性)。

### 4.4 编辑器插件设置(`<userData>/editor.json`)

```ts
export interface EditorSettings {
  version: number
  /** 可执行文件 —— Windows 默认 'wsl.exe' */
  shell: string
  /** 参数模板,`{file}` 是唯一占位符;默认 ['-e','nvim','{file}'] */
  args: string[]
  /** 文件路径怎么写给编辑器:'wsl' = C:\a\b.txt → /mnt/c/a/b.txt;'native' = 原样 */
  pathStyle: 'wsl' | 'native'
  /** 路由白名单 + 注册表用的扩展名(小写、带点、去重、只允许 [a-z0-9]) */
  extensions: string[]
  /** 上一次真的写进注册表的扩展名清单 —— 撤销时按它删,否则改了清单再撤销会漏删(见 §7-4) */
  lastRegistered: string[]
}
```

默认值(按平台)

| 平台 | shell | args | pathStyle |
| --- | --- | --- | --- |
| win32 | `wsl.exe` | `['-e','nvim','{file}']` | `wsl` |
| linux / darwin | `nvim` | `['{file}']` | `native` |

默认扩展名(`DEFAULT_EXTENSIONS`,纯文本 + 常见代码,**不含** `.html/.htm/.xhtml`——那两个归默认浏览器插件)

```
.txt .md .markdown .log .json .yaml .yml .toml .ini .csv .conf
.js .mjs .cjs .ts .tsx .jsx .vue .py .sh .bash .zsh .ps1 .c .h .cpp .hpp .cc
.go .rs .java .kt .rb .php .lua .sql .css .scss .xml .env .gitignore
```

纯函数(全部可单测):

```ts
normalizeEditorSettings(raw: unknown, fallback: EditorSettings): EditorSettings
buildEditorCommand(s: EditorSettings, filePath: string, platform: string):
  { ok: true; file: string; args: string[]; cwd: string } | { ok: false; error: string }
shouldOpenInEditor(s: EditorSettings, path: string, mode: 'open' | 'edit'): boolean
//  - mode === 'edit' → 一律 true
//  - 否则扩展名(小写、带点)在 extensions 里 → true
```

`buildEditorCommand` 的规则:

- `{file}` 在 `args` 的**每一项**里替换(允许 `--cmd 'e {file}'` 这种);
- `pathStyle: 'wsl'` 时用 `windowsPathToWsl()`;换算不出(UNC 等)→ `{ok:false}`(据 §2.3-2 不认领);
- `cwd` 默认**文件所在目录**(WSL 会把 Windows 的 cwd 映射成 `/mnt/c/...`,于是 nvim 的 cwd 就是文件目录,`:e`/`gf` 相对路径可用);设置里可选"统一用主目录"。

### 4.5 插件 IPC(`plugins.invoke('editor', method, …)`)

| method | 行为 |
| --- | --- |
| `getSettings` / `setSettings(patch)` | 读写设置(规范化;`lastRegistered` 不允许从渲染层改) |
| `status()` | `{ platform, exe, registered: boolean, extensions, lastRegistered, targets: {ext, effective, isDefault}[], steps: string[] }` |
| `register()` / `unregister()` | 走 `registration.ts`;返回 `{ ok, log, state }`(形状照 `DesktopActionResult`) |
| `openSettings()` | `shell.openExternal('ms-settings:defaultapps')` |
| `pickFile()` | 系统文件选择框 → 选中就开 nvim 标签(白名单外的文件也认) |
| `test()` | 开一个**空**的 nvim 标签(不带文件),用来确认命令模板能起来 |

### 4.6 Windows 注册表计划(纯逻辑)

```
classes = HKCU\Software\Classes
progId  = bowEditor            (所有扩展名共用一个 ProgID)
verb    = bow-edit             (SystemFileAssociations 下的动词键名,固定,便于撤销)

adds:
  classes\bowEditor                                   (默认)  = 'bow 文本编辑器'
  classes\bowEditor                                   FriendlyTypeName = 'bow 文本编辑器'
  classes\bowEditor\DefaultIcon                       (默认)  = "<exe>,0"
  classes\bowEditor\shell\open\command                (默认)  = "<exe>" --edit "%1"
  classes\bowEditor\shell\edit\command                (默认)  = "<exe>" --edit "%1"
  classes\bowEditor\shell\edit                        MUIVerb = '用 bow 编辑'
  对每个 ext:
    classes\.<ext>\OpenWithProgids                    bowEditor = REG_NONE ''
    classes\SystemFileAssociations\.<ext>\shell\bow-edit          MUIVerb = '用 bow 编辑'
    classes\SystemFileAssociations\.<ext>\shell\bow-edit          Icon    = "<exe>,0"
    classes\SystemFileAssociations\.<ext>\shell\bow-edit\command  (默认)  = "<exe>" --edit "%1"
  classes\Applications\<exeName>                      FriendlyAppName = 'bow'
  classes\Applications\<exeName>\shell\open\command   (默认)  = "<exe>" "%1"
  classes\Applications\<exeName>\shell\edit\command   (默认)  = "<exe>" --edit "%1"
  classes\Applications\<exeName>\SupportedTypes\<ext> REG_NONE ''
  HKCU\Software\Clients\StartMenuInternet\bow\Capabilities\FileAssociations\<ext> = bowEditor

deletes(只删自己写的):
  values: 每个 ext 的 OpenWithProgids\bowEditor、Capabilities\FileAssociations\<ext>
  keys:   classes\bowEditor
          classes\Applications\<exeName>
          classes\SystemFileAssociations\.<ext>\shell\bow-edit   ← 只删这一个子键,绝不动 SystemFileAssociations\.<ext>
  明确不做: 不删 HKCU\Software\RegisteredApplications\bow(归默认浏览器插件)、不动 Classes\.<ext> 的默认值
```

**注册状态探测**(「注册了没有」与「系统当前默认是不是我」分开报,与 `default-browser` 同构):

- 注册没注册:读 `classes\bowEditor` 的默认值、每个 ext 的 `OpenWithProgids\bowEditor`、`SystemFileAssociations\.<ext>\shell\bow-edit`;
- 当前默认:Windows 判定用 `UserChoice` + HKCR 回落。`userChoiceTargets()` 现在写死了 http/https/.html,
  抽出一个 `fileUserChoiceTargets(extensions, progId)`(纯重构,`tests/defaultBrowser.test.ts` 看住协议那两条不变),
  editor 用它对每个扩展名报「当前交给谁」(ProgID → 人话,复用 `friendlyProgId`,未知的原样显示);
- 「实际会用哪个程序」的 `AssocQueryString` 探针复用 `buildAssocProbeScript`(已搬进 `registryOps.ts`)。

**必须让用户点一次**(与 README:135-152 同一套话术,设置页照抄结构):

```
1) 让 bow 出现在「默认应用」里:设置 → 应用 → 默认应用 → bow
2) 逐项把 .txt / .md / … 选成 bow(Windows 不给程序代改;UCPD 还会把直接改注册表的改回)
3) 之后右键任意 .txt 的「显示更多选项」里都有「用 bow 编辑」(与默认程序是谁无关)
```

### 4.7 路径换算

只有一处实现:`windowsPathToWsl` 从 `src/plugins/terminal/piBridge.ts:80` **搬到 `src/shared/localFile.ts`**
(piBridge 改成 import;`tests/piBridge.test.ts:137-148` 的用例一行不动 = 搬迁正确的证据)。
编辑器插件的 `buildEditorCommand` 是唯一调用点(经由 `pathStyle: 'wsl'`)。

## 5. 实施步骤(每步独立可验)

### S0 核心:插件能建内部页标签

- 改 `src/main/plugins/types.ts`(§4.1)、`kernel.ts`(`setTabHost` + `EMPTY_TAB_HOST`)、`src/main/index.ts`(注入)。
- `tests/fakeKernel.ts` 补上 stub(check 现有用它的用例不会炸)。
- **验收**:`npm run typecheck`;`tests/pluginRegistry.test.ts` / `pluginBoundaries.test.ts` 绿。

### S1 核心:本地文件认领 + `--edit`

- 新增 `src/main/plugins/fileOpeners.ts` + `tests/fileOpeners.test.ts`(顺序、第一个认领者说了算、抛错不影响别人、无人认领返回 false)。
- `types.ts` 加 `ctx.fileOpeners.register`;`kernel.ts` 接线(登记 disposer)。
- `src/main/index.ts`:
  - `const editMode = !IS_MCP_STDIO && process.argv.includes('--edit')`(第二个实例同理从它自己的 argv 取);
  - `:213` 改成 `for (const target of targets) openTarget(target, editMode)`,`openTarget` 里:`file://` → `fileURLToPath` → `kernel.fileOpeners.claim(path, mode)`,claim 成功就跳过 `tabs.create`。
- **验收**:`tests/openArgs.test.ts` 全绿(解析逻辑没动);新增用例:没人认领时 `openTarget` 与今天行为逐字一致;
  手工 `bow.exe --edit a.txt` → **仍然开浏览器标签**(此刻还没人认领,正是预期的中间态)。

### S2 终端插件:`terminal:run`

- 新增 `src/shared/terminalRun.ts`。
- `src/plugins/terminal/shared.ts` 加 `buildCommandSpawn(request, { homedir })`(纯)+ `tests/terminalShared.test.ts` 补用例。
- `src/plugins/terminal/main.ts`:pending 表 + 事件订阅 + `attach()` 三段式 + `Session.commandName` + deactivate 清 pending。
- 新增 `tests/terminalRun.test.ts`(形状照 `tests/terminalAgentSignal.test.ts`:假 pty 走真代码路径):
  ① emit 后 attach 用命令 spec spawn(断言假 pty 收到的 file/args/cwd);
  ② 没有 pending 时仍是默认 profile(回归);
  ③ pending 用完即删(第二次 attach 复用同一会话,不重复 spawn);
  ④ 非法 payload(tabId 非正整数 / file 空)被忽略且不抛。
- **验收**:全量 `npm run test`、`typecheck` 绿。

### S3 编辑器插件骨架(先不碰注册表)

- 新增 `src/plugins/editor/{shared.ts,main.ts,ui.ts,ui/EditorSettings.vue,ui/EditorButton.vue}` + `tests/editorShared.test.ts`;
  登记 `builtin.ts` 与渲染层 `registry.ts`。
- 认领逻辑:`match = shouldOpenInEditor(...)`;`open` = `buildEditorCommand` → 失败返回 false(回落标签页)→
  `openInternal('terminal')` → `null` 就记日志并返回 false → `emit(TERMINAL_RUN_EVENT, …)` → true。
- **验收(真机,Windows)**:
  1. `bow.exe --edit C:\tmp\a.txt` → 出现一个终端标签,里面是 nvim 打开着 a.txt,标签标题带文件名;
  2. 在注册表里手动把 `.md` 指到 bow(或先用「用编辑器打开…」按钮)→ `.md` 直接进 nvim;
  3. `.html` 双击 → **仍是浏览器标签**(未被白名单拦住);
  4. `wsl nvim --version` 不通时:标签里显示 pty 的原始报错,浏览器不崩。

### S4 Windows 注册表

- 抽 `src/main/plugins/registryOps.ts`(纯搬迁),`default-browser/windowsRegistry.ts` 改为 re-export + 抽 `fileUserChoiceTargets`;
  **`tests/defaultBrowser.test.ts` 必须全绿**(这就是搬迁没错的证据)。
- 新增 `src/plugins/editor/windowsRegistry.ts`(§4.6 的增删与状态键)、`registration.ts`(I/O 编排)、`tests/editorRegistry.test.ts`。
- UI:注册 / 撤销 / 状态表 / 「打开系统默认应用设置」/ 三步文案。
- **验收(真机)**:
  1. 注册后 `reg query` 五处都在(ProgID、OpenWithProgids、SystemFileAssociations、Applications、Capabilities);
  2. 右键 .txt →「显示更多选项」→「用 bow 编辑」→ 点开进 nvim;
  3. 「设置 → 默认应用」里 bow 能展开,列出白名单内的扩展名;
  4. 撤销后:这些键/值都没了,`.txt` 的默认程序**没被改过**(`reg query UserChoice` 前后一致);
  5. 改短扩展名清单 → 注册 → 撤销,验证 `lastRegistered` 生效(旧清单不残留)。

### S5 兜底入口 + 与文件面板联动

- 工具栏「用编辑器打开…」按钮(`pickFile`),覆盖白名单之外的任何文件。
- (可选,最后做)`files` 插件面板的「打开」旁加一个「用编辑器编辑」:白名单内文件走编辑器,其余仍走系统默认程序。

### S6 文档 + 全量验证

- `README.md`:用法一段(装 nvim 在 WSL → 设置页确认命令 → 设为默认 → 右键编辑 → 已知限制)。
- `docs/ARCHITECTURE.md`:§1 目录地图加 `editor/` 与 `fileOpeners.ts`、`registryOps.ts`;§5 插件体系补
  `ctx.tabs.openInternal` 与 `ctx.fileOpeners`(含"核心只出窄能力"的理由);§6 插件契约表;§13 加一条"插件不能自己建标签"的边界更新。
- `packages/pi-bow/skills/bow-browser/SKILL.md`:**不用改**(没有新增 MCP 工具)。
- 全量:`npm run typecheck` / `npm run test` / `npm run build`。

## 6. 验证与验收

**自动化**:上面每一步的单测 + 全量 `typecheck` / `test` / `build`。新增用例集中在
`fileOpeners`(认领顺序/兜底)、`editorShared`(模板替换、路径换算、白名单判定)、`editorRegistry`(键路径、幂等、撤销只删自己)、
`terminalRun`(pending 消费与回归)。

**真机(Windows,必须)**:

1. `wsl.exe -e nvim /mnt/c/tmp/a.txt` 这个形态本身先单独验一次(`-e` 与直参两种写法都要试,记进 §10 实施记录);
2. nvim 在 `/mnt/c/...` 上写 swap / undo 文件的表现(Windows 侧权限、`.swp` 落盘位置);
3. S3 的 4 条 + S4 的 5 条;
4. 终端插件被**停用**时:认领了却没人跑 → 必须给出明确提示(不许静默什么都不发生);
5. 多文件:`bow.exe --edit a.txt b.txt` → 两个标签各自一个 nvim;
6. 文件管理器多选 → 「用 bow 编辑」是否传多个 `%1`(预期只传一个,记录实际行为)。

**人工(真机一次)**:中文文件名/中文内容在 nvim 里的字形(终端字体栈);多行粘贴;nvim 退出后标签显示 shell 退出的提示是否可理解。

## 7. 风险与未知

1. **系统侧无法代设默认**(UCPD + 哈希):必须用户点一次。这是既成事实,不是本计划的缺陷;设置页把步骤写清楚即可。
2. **Win11 主右键菜单不显示传统动词**:「用 bow 编辑」在「显示更多选项」里。要进主菜单得打包 MSIX + IExplorerCommand —— 不做。
3. **`SystemFileAssociations` 的键是会被人/别的软件写的公共位置**:撤销时**只删 `shell\bow-edit` 这一个子键**,
   绝不整段清 `.txt`;这条要有测试看住。
4. **扩展名清单改动后的撤销**:所以设置里存 `lastRegistered`(§4.4),撤销按它删。漏了这条就会出现"改了清单再撤销,旧的残留"。
5. **白名单外的文件没有右键入口**:靠 S5 的「用编辑器打开…」按钮兜底;这是"只保留「编辑」动词"的直接代价,用户已知情。
6. **终端插件是硬依赖**:编辑器插件只在「终端」启用时才有用。停用时给明确提示(验收第 4 条)。
7. **核心 API 面扩大**:新增 `ctx.tabs.openInternal` + `ctx.fileOpeners`。前者已收窄到"只能开内部页",
   后者只影响"开本地文件"这一条通路;评审时请确认这个边界可接受。
8. **未验**:`wsl.exe -e nvim` 的确切参数形态、`MUIVerb` 中文在 Win11「显示更多选项」里的显示、多选传参行为 —— 都在 §6 第 1/6 条里排了。

## 8. 文档更新

见 S6。要点:README 给用户操作路径;ARCHITECTURE 补两个新能力与两个新模块(以及"插件不能自己建标签"这条边界被收窄成
"只能建内部页");`SKILL.md` 不动。

## 9. 明确不做

- 内置编辑器(CodeMirror 6 / Monaco)、`bow://editor` 内部页面、markdown 预览;
- `*\shell` 全局右键、「用 bow 打开」这类与「编辑」重复的动词;
- 写 `HKCU\Software\Classes\.<ext>` 的默认值(不抢默认打开方式);
- IFEO 替换 `notepad.exe`(要管理员、毁调试语义);
- 地址栏输入路径 / 网页链接指向本地文件这两条通路的路由(留接口,不接);
- 把编辑能力做成 MCP 工具;
- nvim 的 preflight 检测、「nvim 已在别处打开同一文件」的互斥(交给 nvim 自己的 swap 机制);
- Linux 侧的 `.desktop` 编辑器关联(v1 只做 Windows;要做时复用 `default-browser/linuxDesktop.ts` 的形状)。

---

## 10. 实施记录(2026-10-14 完成 S0~S4 + S6;S5 未做)

**状态**:S0~S4 全部完成并验证;S6(文档)完成;S5 只做了工具栏「用编辑器打开…」(「文件管理面板里加编辑入口」那条**没做**,理由见下)。
真机(Windows + WSL 的 nvim)那部分**仍需你在自己的机器上跑一遍** —— 见 §10.3。

### 10.1 与原计划的偏差(6 处,都是往小改)

| # | 计划写的 | 实际做的 | 原因 |
| --- | --- | --- | --- |
| 1 | `ctx.tabs.openInternal(page, {activate?, windowId?})` | `openInternal(page, {windowId?})` | `TabManager.openInternal()` 本来就一定激活(settings 是聚焦已存在的那个),`activate` 是个骗人的参数 —— 不如没有 |
| 2 | `buildEditorCommand(settings, filePath, platform)` | 去掉 `platform` 参数 | 没有任何分支用到它(路径写法是显式设置项,不是平台推断) |
| 3 | `Session` 加 `commandName` 字段 | 没有加:直接把 `profileName` 设成命令名 | 终端页渲染标题用的就是 `profileName`,少一个字段少一处同步 |
| 4 | `windowsPathToWsl` 搬到 `@shared/localFile`,piBridge 改 import | `piBridge.ts` 改成 `import` + `export { windowsPathToWsl }` | re-export 保住了原有 import 路径与 `tests/piBridge.test.ts` 一行不动(那是搬迁正确的证据) |
| 5 | 撤销按 `settings.lastRegistered` 删 | 撤销清单 = `lastRegistered` **∪ 当前清单** | 只按 `lastRegistered`:设置文件被重置 / 从旧版本升级上来时会漏删;只按当前清单:改小清单后撤销会漏删。并集两个都盖住 |
| 6 | 「测试」按钮开一个空编辑器标签 | 同,但用 `buildEditorCommand(settings, null)` 实现 | 一个函数两种语义(含 `{file}` 的参数整项去掉),不用写第二份拼装 |

另外顺手清掉一处**既有重复**:`default-browser/windowsRegistry.ts` 里 `UserChoiceTarget` 声明了两遍
(TS 接口合并让它一直没报错),现在只留一份,并抽出 `fileUserChoiceTargets(exts, progId)` 给编辑器复用。

### 10.2 实施中发现的两处**真**问题(计划里没有)

1. **`editorStatus()` 在非 Windows 上会白跑上百次 `spawnSync`**。
   实测:80 次 `spawnSync('reg.exe')`(必然 ENOENT)要 **~3 秒**,`powershell.exe` 80 次要 **~80 秒**。
   而状态页一挂载就调 `status()`、白名单默认 ~40 个扩展名 × 2~3 次查询。
   修法:非 Windows 直接跳过全部 reg/PowerShell 调用(没有任何注册表可查);Windows 上先查一条
   (ProgID 的默认值)判「注册了没有」,没注册就不逐条核对 —— 于是「没注册」这条常见路径只有 1 次 reg 调用。
2. **`--edit` 是「整批 argv」的开关,不是「每个文件一个」**。
   一次启动带两个目标(`--edit a.txt b.html`)时,`.html` 也会被认领进编辑器。
   这是**对的行为**(注册表里的「编辑」动词一次只传一个 `%1`),但它意味着 E2E 脚本不能在一次启动里
   同时验「认领」与「不认领」——脚本因此改成启动两次(见 §10.4)。

### 10.3 已验证 / 未验证

**已验证(本机 = Linux,自动化)**

- `npm run typecheck`、`npm test`(**78 文件 / 1487 用例**)、`npm run build` 全绿。
- 新增/扩展的用例:`tests/pluginTabHost.test.ts`(3)、`tests/fileOpeners.test.ts`(7)、
  `tests/terminalRun.test.ts`(7)、`tests/editorShared.test.ts`(23)、`tests/editorRegistry.test.ts`(13);
  `tests/defaultBrowser.test.ts` **60 条一行没改仍然全绿**(= `registryOps.ts` 是纯搬迁的证据)。
- **端到端(真 Electron + node-pty + 真 nvim)**:`npm run test:e2e:editor` **16/16** ——
  `bow --edit a.txt` 开成终端标签、标题带文件名、**xterm buffer 里出现文件内容(nvim 真的打开了它)**、
  没有多开 `file://` 标签;不带 `--edit` 时 `.html` 照旧开 `file://` 标签而 `.txt` 仍进编辑器。

**未验证(需要你)**

- Windows 真机:`reg query` 五处、右键「显示更多选项」里的「用 bow 编辑」、
  「设置 → 默认应用」里 bow 能展开、撤销后 `.txt` 的默认程序没被动过。
- `wsl.exe -e nvim <file>` 这个形态本身(**Linux 上验的是 `nvim <file>`,WSL 那条没验**):
  `-e` 与直参两种写法都试一下。
- nvim 在 `/mnt/c/...` 上写 swap / undo 的表现。
- 中文文件名/内容的字形、多行粘贴(终端插件的老检查项)。

### 10.4 顺带留下的产物

- `scripts/e2e-editor-open.mjs` + `npm run test:e2e:editor`:上面那条端到端验证,Windows 上也能跑。
- 文档:`README.md` 新增「编辑器(把本地文件交给 nvim)」一节 + 插件清单/设置页/E2E 三处;
  `docs/ARCHITECTURE.md` 的 §1(目录地图 + `shared/terminalRun.ts` / `localFile.ts`)、§5.2(两条新能力)、
  §5.4(新扩展点行)、§5.8(两张矩阵 + 插槽顺序)、§5.9(`terminal:run` 及其时序不变式)、§13(边界第 1 条)。
- `packages/pi-bow/skills/bow-browser/SKILL.md` **未改**(没有新增 MCP 工具,符合计划 §9)。

### 10.5 S5 为什么没做

「文件管理面板里加一个『用编辑器编辑』按钮」是**可选**项,而它的价值已经被工具栏的「用编辑器打开…」覆盖
(白名单外的文件也能送进编辑器)。面板那条要多写一套「白名单内走编辑器、其余走系统默认程序」的判断,
收益不明确 —— 留给以后需要时再做。
