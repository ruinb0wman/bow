# Logseq 兼容的极简笔记插件(`bow://logseq`):日志 + 双向链接 + 图目录 + 实时 markdown + 日志模板

> 2026-09-20 · 目标文件:新增 `src/plugins/logseq/**`、`src/renderer/{logseq.html,src/logseq/**}`;
> 核心改动 `src/shared/internalPages.ts`、`src/main/rendererEntry.ts`、`electron.vite.config.ts`、
> `src/main/plugins/builtin.ts`、`src/renderer/src/plugins/registry.ts`、`tsconfig.{node,web}.json`
> 前置先例:`.pi/plans/2026-09-19-terminal-plugin/plan.md`(插件 + `bow://terminal` 内部页面)、
> `.pi/plans/2026-09-19-terminal-entry-and-ctrlw/plan.md`(内部页进历史/可收藏/按来源 webContents 判键)

## 0. 结论(先说可行性)

**可行,而且大部分是「已经有现成通路、只是没人用过」的组合**。三条关键结论都有代码依据:

| 需要的能力 | 现状 | 依据 |
| --- | --- | --- |
| 一个全页编辑器承载在浏览器标签里 | **已有先例**:`bow://terminal` 就是「插件目录 + 新内部页面入口」 | `src/shared/internalPages.ts` 的 `INTERNAL_PAGES`、`src/main/rendererEntry.ts:9` 的 `RendererEntryName`、`electron.vite.config.ts` 的 `rollupOptions.input.terminal` |
| 主进程能读写任意本地文件 / 起子进程 / 用 electron API | **已有先例**:终端插件直接 `import { existsSync } from 'node:fs'`、`spawn`、`import { app } from 'electron'` | `src/plugins/terminal/main.ts` 顶部 import 与 `app.on('before-quit', …)` |
| 渲染层能读磁盘内容 | 经 `window.browserAPI.plugins.invoke(id, method, …args)` + `onEvent`,内部页面**有应用 preload** | `src/preload/index.ts`(`BrowserAPI` 权威清单)、`docs/ARCHITECTURE.md` §4「内部页面标签持有应用 preload」 |
| 每个编辑器标签一份视图状态(像终端把会话绑到 tabId) | **已有先例**:`tab:self` → `getSelfTabId()` | `src/preload/index.ts` 的 `getSelfTabId`;`terminal/main.ts` 的「会话按 tabId 绑定」注释 |
| 不引入新依赖 | 渲染侧依赖会被 Vite 打包进产物(xterm 已内联在 `out/renderer/assets/terminal-*.js`),**不存在打包自检风险**;markdown 用**手写 tokenizer** 的理由见 §2.4 | `out/renderer/assets/` 里没有 xterm 的 `require` |

**两处必须先校准的真实格式细节**(是我唯一不能靠代码确定的部分,已在 §7 列出):
① 日志文件里**页面属性行**的形态(`title:: x` 是否顶格、无 `- ` 前缀);② **块属性行**的缩进形态。
对策不是「猜」,而是 §3.2 的硬不变式:**`serialize(parse(text)) === text` 对任意输入恒等** ——
分类错了只影响编辑命令,不会改写用户的字节。

**拍板(用户问卷)**:

| # | 决定 |
| --- | --- |
| G1 | 编辑器形态 = **分块就地编辑(Logseq 手感)**:未聚焦渲染、点一下就地编辑原始 markdown;Tab 缩进 / Enter 新块 / Backspace 并块 |
| G2 | 双链深度 = `[[页面]]` + `#标签`(含 `#[[多字 标签]]`)+ **反链面板**;`((块引用))` 与 `{{embed}}` 不做(遇到时**原样显示、绝不丢字**) |
| G3 | 图目录 = **原生目录选择框 + 最近图列表 + `fs.watch` 自动重载 + 原子写 + mtime 冲突检测**(可以和 Logseq 同时开着用同一个图) |
| G4 | **不做 MCP 工具**(插件 IPC 面已就位,以后加 4 个工具是小改动) |

> ⚠️ 计划里替用户补的假设(需求没覆盖,批准时可直接改,见 §8):
> - 宿主形态 = bow 的**内置插件**(`src/plugins/logseq/`)+ 新内部页面 `bow://logseq`;
> - 只支持 **Logseq 文件图**(`journals/` + `pages/` + `templates/` + `logseq/config.edn`),
>   **不支持 DB 图**(`logseq/db.sqlite`/Desktop 新版 DB 模式)—— 那需要 SQLite 驱动与 Logseq 的 DB schema;
> - 不做 TODO/DOING、`{{query}}`、白板、闪卡、图片内联渲染、org 格式(`:preferred-format :org`);
> - 打开一个「还没有文件」的日志/页面**不落盘**(避免在图里留垃圾、给用户的 git 制造噪音),第一次编辑才创建文件。

---

## 1. 目标(一句话)

在 bow 里开 `bow://logseq`,选一个 Logseq 图目录,就能像 Logseq 一样写今日日志:分块就地编辑 + 实时 markdown,
`[[页面]]`/`#标签` 可点、可建页,页面底部给出反链;新日志按 `:default-templates` 的模板初始化;
与 Logseq 共用同一批 `.md` 文件且**不破坏它的格式**。

---

## 2. 可行性逐条(实读到的代码)

### 2.1 内部页面通路:5 处核心改动,全都有 terminal 先例

`src/shared/internalPages.ts` 是唯一权威,且**只接受已登记的 id**:

```ts
export type InternalPageId = 'settings' | 'terminal'
export const INTERNAL_PAGES = {
  settings: { url: SETTINGS_URL, title: '设置', entry: 'settings', singleton: true,  openIn: 'tab'  },
  terminal: { url: TERMINAL_URL, title: '终端', entry: 'terminal', singleton: false, openIn: 'pane' }
} as const satisfies Record<InternalPageId, InternalPageSpec>
```

`parseInternalUrl()` 只认 `bow://<id>` 与 `bow://<id>/`(`带路径/查询/其它 host 一律 null`),所以
**「当前在哪一页」不能编码进 URL**,必须像终端那样按 tabId 存在主进程(见 §3.6)。

加一个 `logseq` 页面的全部触点(照 `terminal` 抄):

| 文件 | 现状 | 加什么 |
| --- | --- | --- |
| `src/shared/internalPages.ts` | `'settings' \| 'terminal'` | `+ 'logseq'`、`LOGSEQ_URL = 'bow://logseq'`、`INTERNAL_PAGES.logseq` |
| `src/main/rendererEntry.ts:9` | `type RendererEntryName = 'index' \| 'overlay' \| 'settings' \| 'terminal'` | `+ 'logseq'` |
| `electron.vite.config.ts` | `input: { index, overlay, settings, terminal }` | `+ logseq: resolve('src/renderer/logseq.html')` |
| `src/renderer/logseq.html` | 新增(照 `terminal.html`:同款 CSP + `<script type="module" src="/src/logseq/main.ts">`) | — |
| `src/renderer/src/logseq/main.ts` | 新增(3 行:`createApp(LogseqApp).mount('#app')`) | — |

`TabManager.create()` 会按 `INTERNAL_PAGES[id].entry` 载入(`tabManager.ts:282`
`if (kind === 'internal') loadRendererEntry(wc, INTERNAL_PAGES[internalId!].entry)`),
所以**不需要动 TabManager**。

**两根正交轴的取值**(§4 的 `singleton` / `openIn`):

- `singleton: false` + `openIn: 'pane'` —— 完全照终端:地址栏输 `bow://logseq` = 顶替聚焦窗格,
  于是「日志左 / 页面右」的分屏与「再开一个编辑器」都自然成立,并且与 `Ctrl+Shift+方向` 分屏组合得起来。
- 工具栏按钮(插件自己的 `LogseqButton.vue`)= `api.createTab(LOGSEQ_URL)`(新标签组),与终端按钮同款。

### 2.2 主进程侧:文件 I/O、目录选择、目录监听

- **文件 I/O 与子进程**:`src/plugins/terminal/main.ts` 已经在插件里直接用
  `node:child_process`、`node:fs`、`node:os`、`node:path` 与 `electron` 的 `app`;
  插件 main 与主进程同一个 bundle,所以 `node:fs/promises`、`dialog`、`BrowserWindow` 都能用。
- **目录选择框**:仓库当前**没有任何** `dialog.showOpenDialog` 调用(`grep` 过 `src/main`、`src/plugins`),
  这是本次新增的第一处用法 —— 用 `BrowserWindow.getFocusedWindow() ?? undefined` 当 parent,
  从 `plugins.invoke('logseq','pickGraph')` 里同步 await 即可(渲染层本来就是 `await invoke` 的形态)。
- **监听**:`fs.watch(dir, { recursive: true })`。Electron 44 / Node 22 上 Windows 与 Linux 都支持递归;
  macOS 也支持。**这是「和 Logseq 同时开着」唯一的技术支点**。
- **写入**:照 `JsonStore` 的做法 `.tmp` + `rename`(原子),并校验目标路径**必须在图目录内**且只落在
  `journals/` 或 `pages/`(`:journals-directory` / `:pages-directory` 覆盖后同规则)—— 这条要有单测。

### 2.3 渲染层侧:内部页面拿得到什么

`bow://logseq` 是 `kind:'internal'` 的标签 ⇒ **持有应用 preload**,所以页面里有
`window.browserAPI`(终端页就是这么接上 xterm 的)。本次用到的成员:

| 成员 | 用途 |
| --- | --- |
| `plugins.invoke('logseq', method, …args)` | 全部文件读写与索引查询(§3.6 表) |
| `plugins.onEvent(cb)` | `graph-changed` / `index-progress` 广播 |
| `getSelfTabId()` | 每个编辑器标签一份视图状态(照终端把会话绑 tabId 的思路) |
| `splitPane(dir)` / `resizePane(dir)` | 见 §3.7:页面自己接管 `Ctrl+Shift+方向` / `Alt+Shift+方向`,**核心零改动** |
| `createTab` | 工具栏按钮打开编辑器 |

⚠️ 一个必须记住的副作用:分屏快捷键的接管判据是
`shouldTakeSplitHotkey()`(`src/shared/shortcuts.ts`)= `!target.internal || target.internalPageId === 'terminal'`,
所以**新内部页面默认不接管** ⇒ 按键会正常送到页面 ⇒ 页面自己调 `splitPane/resizePane`。
这正好是我们要的(不必把 `logseq` 加进白名单,也就不必动核心与它的单测)。

### 2.4 依赖:不需要新依赖,markdown 手写

- 渲染侧依赖会被 Vite 打进产物(`out/renderer/assets/terminal-*.js` 里能直接搜到 xterm 源码),
  `npm run dist` 的自检(`scripts/lib/externalRequires.mjs`)只扫**主进程 bundle 的运行时 require** ⇒ 加渲染侧依赖也不会炸打包。
- **但仍然手写**是有硬理由的,不是洁癖:
  1. 「点一下就地编辑」需要**把点击位置映射回原始 markdown 偏移**(渲染后的文本与源码不等长:`[[cardinality]]` 显示成
     `cardinality`)。手写 tokenizer 可以给每个 token 带上 `srcStart/srcEnd`,点击命中哪个 token 就落哪个偏移;
     第三方库只吐 HTML 字符串,映射要另做一套(不划算)。
  2. 双链必须是**可点击的 Vue 节点**(点击 → 应用内跳转),不是一段 HTML。
  3. 有一个可测的硬不变式:**渲染零丢字**(所有 token 的原文拼接 === block 原文),第三方库不保证。
- 需要渲染的子集很小:粗体/斜体/行内代码/删除线/高亮/链接/`[[页]]`/`#标签`/`#[[多字标签]]`/围栏代码块。
  其它一切(含 `((uuid))`、`{{query}}`、`TODO`)**原样当文本渲染**。

### 2.5 格式兼容:靠「parse→serialize 恒等」兜底

我核对了官方模板 `logseq/templates/config.edn`(实读原文)与文件命名规则(`markdown_mirror.cljs`
的 `journal-file-stem`、PR #6134 的 `:triple-lowbar` 规则):

| 事实 | 来源 |
| --- | --- |
| 日志默认文件名 `yyyy_MM_dd`(`:journal/file-name-format` 可改,默认值),目录默认 `journals/`(`:journals-directory`) | 官方 config.edn 注释 + `journal-file-stem` |
| 页面目录默认 `pages/`(`:pages-directory`) | 同上 |
| 默认日志模板:`:default-templates {:journals ""}`(模板文件在 `<graph>/templates/<名字>.md`) | 同上 |
| 页面里 `/` 编码成 `___`,其它保留字符按 URL 百分号编码,文件名词干上限 160 | PR #6134(`:file/name-format :triple-lowbar` 为默认) |
| 页面属性可写在文件顶部(`title::`),用于「文件名不能表达标题」的场景 | PR #6134 的报错文案「unless the `title::` property is set manually」 |
| 块内嵌套 = 每层 2 空格缩进;`- ` 开头是块 | `docs/logseq-markdown-syntax.md`(DB 镜像文档,缩进语义与文件图一致) |

**结论**:格式本身是「缩进 + `- ` + `key:: value` + 行内标记」,写一个保守的解析器完全可行;
真正的风险不是难度而是**细节猜错**,所以 §6.1 的第一组用例就是「对真实 Logseq 文件 parse→serialize 恒等」。

### 2.6 已知必须处理的三个既有行为

| 行为 | 位置 | 处理 |
| --- | --- | --- |
| `body { user-select: none }`(全站共用样式) | `src/renderer/src/style.css` | 编辑器页面在自己的 CSS 里显式 `user-select: text`(否则文本无法选中) |
| 内部页面**不参与内容注入**(防插件往浏览器自己的 UI 注入) | `TabManager.create()` 的 `if (!internalId) pageTracker.track(wc)` | 不需要处理,反而正合适 |
| `Ctrl+W` 一律关聚焦窗格,且由**主进程**在页面之前吃掉 | `src/shared/shortcuts.ts` 的 `releasesToTerminal`(只剩 `focus-address`) | 页面拿不到 `Ctrl+W` ⇒ 只能靠「防抖自动保存」把未落盘窗口压到 ≤400ms;写进 §7 风险 |

---

## 3. 设计

### 3.1 文件与目录

```text
<graph>/                          ← 用户选的目录(必须是 Logseq 文件图)
  logseq/config.edn               ← 只读:`journals-directory` / `pages-directory` /
                                     `file-name-format` / `default-templates` / `:hidden`
  journals/2026_09_20.md          ← 日志
  pages/cardinality.md            ← 页面
  templates/Daily.md              ← 日志模板(名字由 config 指定)
```

- **图识别**(打开时校验,失败给明确文案):存在 `<graph>/logseq/` 或 `<graph>/journals/` 或 `<graph>/pages/`;
  识别为 **DB 图**(存在 `logseq/db.sqlite` 或 `logseq/db/`)时**明确拒绝**并解释原因(§8)。
- **config.edn 解析**:只做**键值行提取**(不需要完整 EDN 解析器):
  `:journals-directory "…"`、`:pages-directory "…"`、`:journal/file-name-format "…"`、
  `:hidden ["…"]`、以及 `:default-templates {:journals "名称"}` 这一段(在同一个「键值对块」里取 `:journals`)。
  解析失败/缺失一律回落默认值,并且**永不写回** `config.edn`。
- **日期 ↔ 文件名词干**(纯函数,`shared.ts`):支持 token 子集 `yyyy yy MMM? MM M dd d`(实际只承诺
  `yyyy / MM / M / dd / d` 与时字面分隔符),把格式串编译成一个带命名捕获的正则 ⇒ 写用 `format(day)`、
  读用 `match(stem)` **同一个来源**,杜绝两处漂移。整串无法识别(用了 `EEE` 之类)时**回落 `yyyy_MM_dd` 并在
  设置页显示一行提示**(不静默)。
- **页面名 ↔ 文件名**(纯函数):`encodePageName(title)`(`/`→`___` → 百分号编码保留集 → 去尾空格/点 →
  截断 160)与 `decodePageName(stem)`;往返不相等(例如被截断)时,写文件时**同时写 `title:: <原名>`**。
- **索引 key 用小写**(Logseq 的页面 identity 就是小写),显示保留原样 ⇒ `[[Cardinality]]` 能命中
  `pages/cardinality.md`。

### 3.2 块模型与编辑命令(全部是纯函数)

解析结果(不需要「语义」,只需要**能原样写回**):

```ts
interface ParsedFile {
  /** 文件顶部的页面属性行(原样保留,含缩进与行尾) */
  pageProps: Line[]
  /** 块树;每个块保留自己的原始行文本数组 */
  blocks: BlockNode[]
  /** 原文件的收尾形态:末尾换行 / CRLF / 尾随空行各留一份 */
  ending: { eol: '\n' | '\r\n'; trailingNewlines: number }
  /** parse 时算出的:文件是否以日志命名(即 title:: 缺失时的显示名) */
  title?: string
}

interface BlockNode {
  key: string          // 会话内稳定的路径键(0.2.1);每次结构改动后重算
  indent: number       // 空格数
  text: string         // 第一个 `- ` 之后的内容
  extraLines: Line[]   // 多行内容(代码围栏、软换行)与属性行(id::/collapsed::…),**原样**
  children: BlockNode[]
}
```

**编辑命令**(接收「文件树 + 目标块 key」,返回新树;实现于 `shared.ts`,单测直接对树断言):

| 命令 | 语义 |
| --- | --- |
| `insertSiblingAfter` | Enter(光标在末尾)→ 同级新空块 |
| `splitBlock(offset)` | Enter(光标在中段)→ 原块留前半、后半成新兄弟 |
| `insertMultilineText` | Shift+Enter(块内换行,进 `extraLines`) |
| `indent` / `outdent` | Tab / Shift+Tab:**整棵子树**平移 2 空格/档;outdent 后若与前一兄弟同级则挂到它下面(Logseq 语义) |
| `mergeWithPrev` | Backspace 在块首:上一块有子块 → 先 outdent;否则拼成一块(保留上一块的属性行) |
| `setText(key, text)` | 就地编辑(只替换第一行 `- ` 之后的文本,`extraLines` 不动) |
| `deleteBlock` | 删块与子树(空块且非唯一块时) |
| `toggleCollapse` | 折叠(仅会话内,不写 `collapsed::`) |

**兼容性不变式**(§6.1 用 fixtures 钉死):

1. `serialize(parse(raw)) === raw`(对任意 raw,包括空文件、无尾换行、CRLF、4 空格缩进、Unicode);
2. 任何命令后的 `serialize` 结果里,**未被触及的那些行逐字节不变**;
3. 渲染零丢字:块内所有 token 的原文拼接 === 块原文。

### 3.3 行内 tokenizer 与渲染

```ts
type Token =
  | { kind: 'text'; raw: string }
  | { kind: 'strong' | 'em' | 'code' | 'strike' | 'highlight'; children: Token[] }
  | { kind: 'page'; target: string; label: string }       // [[x]] / [[x|display]]
  | { kind: 'tag'; target: string }                        // #tag / #[[多字 标签]]
  | { kind: 'url'; href: string; label: string }            // [label](href) 与裸 http(s)
  | { kind: 'raw'; text: string }                           // ((uuid)) / {{query}} / 未识别 —— 原样
```

每个 token 额外带 `srcStart/srcEnd`(§2.4 的点击映射)。**Vue 组件渲染,永不 `v-html`**。
块首 `# ` 之类当标题样式;含围栏代码的块整块按代码块渲染。

### 3.4 索引与反链

主进程内存索引(懒建 + 按 mtime 增量):

```ts
interface PageEntry {
  path: string
  mtimeMs: number
  title: string          // decode 文件名,或 title:: 
  day: string | null     // 日志才是 YYYY-MM-DD
  refs: string[]         // 出链(小写页面名)
  blocks: Array<{ line: number; text: string; refs: string[] }>  // 供反链定位
}
```

- **建索引**:遍历 `journals/` + `pages/`(config 目录名,跳过 `:hidden`),只读 `.md`;
  每个文件解析一次并把 `mtimeMs` 一起缓存 ⇒ 第二次只重解析变化的文件。
- **反链查询**:`refs` 里含目标页面名的文件 → 每条块给出「来源(日期/页面标题)+ 块文本 + 行号」,按日期倒序。
- **进度**:`index-progress {done, total}` 广播,首次建索引时页面顶部显示一行细进度(不阻塞)。
- **规模保护**:文件数或总字节超阈值(暂定 5000 文件 / 64MB)时,设置页显示提示并**只对当前页做即时扫描**
  (退化成 O(n) 扫描),不建全量索引。

### 3.5 保存、冲突、监听

| 场景 | 行为 |
| --- | --- |
| 编辑落盘 | 400ms 防抖 + 失焦立即 flush + 切图前 flush ⇒ 未落盘窗口 ≤400ms |
| 原子写 | `.tmp` → `rename`;只允许写 `journals/`、`pages/` 目录内(resolve 后必须在图目录内) |
| 冲突检测 | `savePage({path, raw, baseMtimeMs})`,磁盘 mtime 与 `baseMtimeMs` 不一致 ⇒ 返回 `{conflict:true, diskRaw}`,**绝不覆盖**;UI 顶部横幅给两个按钮「用磁盘版本重载(丢弃本地)」「强制覆盖」 |
| 外部改动 | `fs.watch` 防抖 200ms → 失效索引 + 广播 `graph-changed`;当前页**干净**则静默重载,**脏**则显示同一横幅 |
| 自己写的文件 | 记录 `lastWrite: Map<path, {mtimeMs, hash}>`,watcher 事件与之匹配就吞掉(否则每次打字都触发一次重载) |
| 新建文件 | 只在第一次保存时创建(空日志/空页面不发文件) |
| 撤销 | 每标签一个**整篇 raw 快照**栈(上限 50),`Ctrl+Z` / `Ctrl+Shift+Z` → 恢复快照并走同一条保存路径(不做逐块 diff 级 undo) |

### 3.6 插件主进程 API 面(`ctx.ipc.handle`)

| method | 参数 | 返回 |
| --- | --- | --- |
| `getState` | — | `{graphPath, recentGraphs[], config, indexStats}` |
| `pickGraph` | — | 弹目录框 → `getState`(取消则原样返回) |
| `setGraph` | `path` | 校验后切换(`getState`);失败 `{ok:false, error}` |
| `attach` | `tabId` | `{view: {kind:'journal'\|'page', name}}` —— 该标签上次看的页,没有则今天 |
| `setView` | `tabId, view` | `true`(标签刷新后仍回到同一页;`tab:closed` 时清理) |
| `readJournal` | `day` | `{day, path, exists, raw, mtimeMs, templateApplied?}` |
| `readPage` | `name` | `{name, path, exists, raw, mtimeMs}` |
| `savePage` | `{path, raw, baseMtimeMs}` | `{ok:true, mtimeMs}` / `{ok:false, conflict:true, diskRaw}` |
| `listJournals` | — | `{days: string[], first, last}` |
| `listPages` | `query?` | `{name, path, isJournal}[]`(前缀优先,供 `[[` 补全与搜索框) |
| `backlinks` | `name` | `{total, groups:[{source, title, day, blocks:[{text, line}]}]}` |
| `listTemplates` | — | `{name, path}[]` |
| `renderTemplate` | `{name, day, page}` | `{raw}`(展开 `<%date%>` / `<%time%>` / `<%current page%>` / `<%yesterday%>` / `<%tomorrow%>`) |
| `openInNewPane` | `name` | 置「下一个编辑器标签的待开页」→ `true`(§5 的 S8,**可砍**) |
| `rebuildIndex` | — | `true`(设置页用) |

事件(`ctx.ipc.emit`,内核会广播到 chrome + overlay + **内部页面**):
`graph-changed {path, kind}`、`index-progress {done,total}`、`graph-switched {graphPath}`、`settings-changed`。

### 3.7 UI 与键位

组件(`src/plugins/logseq/ui/`):

| 组件 | 职责 |
| --- | --- |
| `JournalView.vue` | **页面主体**(`renderer/src/logseq/LogseqApp.vue` 直接挂载,不进插件注册表 —— 与 `TerminalView.vue` 同款) |
| `BlockRow.vue` | 一个块:圆点/折叠箭头 + 渲染态 / 就地编辑态(单块 textarea,自适应高度) |
| `BlockText.vue` | token → Vue 节点(双链可点) |
| `BacklinksPanel.vue` | 反链面板 |
| `PageSuggest.vue` | `[[` / `#` 补全(**S7,可砍**)与页面搜索框 |
| `LogseqButton.vue` | 工具栏按钮(`scripts/registry` 注册) |
| `LogseqSettings.vue` | 设置分区:图路径 / 最近图 / 索引统计 + 重建 / 默认日志模板选择 / 文件名格式提示 |

页面内键位(页面自己处理,不新增主进程热键):

| 键 | 行为 |
| --- | --- |
| Enter / Shift+Enter / Tab / Shift+Tab / Backspace(块首) | §3.2 的编辑命令 |
| ↑ / ↓ | 上/下一块(尽量保持光标列) |
| Esc | 退出编辑态 |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` | 整篇快照 undo/redo |
| `Ctrl/Cmd+Shift+←/→/↑/↓` | `api.splitPane(dir)`(页内也能分屏,见 §2.3) |
| `Alt+Shift+←/→/↑/↓` | `api.resizePane(dir)` |
| `Ctrl/Cmd+点击 [[x]]` | `openInNewPane`(S8,可砍);单击 = 本页内跳转 |

### 3.8 插件注册与页面接入(每一处都要改)

| 文件 | 改动 |
| --- | --- |
| `src/shared/internalPages.ts` | `InternalPageId` + `'logseq'`;`LOGSEQ_URL`;`INTERNAL_PAGES.logseq = {url, title:'笔记', entry:'logseq', singleton:false, openIn:'pane'}` |
| `src/main/rendererEntry.ts` | `RendererEntryName` + `'logseq'` |
| `electron.vite.config.ts` | `input.logseq` |
| `src/main/plugins/builtin.ts` | `import logseq from '@plugins/logseq/main'` + 追加到 `BUILTIN_PLUGINS` 末尾(不参与网络钩子/建议源顺序) |
| `src/renderer/src/plugins/registry.ts` | `import logseqUi` + 追加到 `PLUGIN_UI`;`SLOT_PLUGIN_ORDER.toolbar` 末尾加 `'logseq'` |
| `tsconfig.node.json` | `include` 里登记 `src/plugins/*/format.ts`、`src/plugins/*/graph.ts`(仓库明确要求:新文件名不登记就 typecheck 看不到) |
| `tsconfig.web.json` | `include` 里登记 `src/plugins/*/format.ts`(渲染层要用同一份解析器) |
| 新增 | `src/renderer/logseq.html`、`src/renderer/src/logseq/{main.ts,LogseqApp.vue,logseq.css}` |

> 边界约束(`tests/pluginBoundaries.test.ts` 文本断言):`main.ts` 里**不能出现 `.vue` 与 `@renderer`**,
> `ui.ts` 里**不能 `from 'electron'`** ⇒ 主进程侧的文件读写只能待在 `main.ts`/`graph.ts`,组件只能在 `ui/`。

---

## 4. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/plugins/logseq/main.ts` | `PluginMain`(manifest/capabilities `['ui']`)、`ctx.storage('logseq.json')`、§3.6 全部路由、fs 读写 + 原子写 + 路径校验、`fs.watch`、`dialog`、`tab:closed` 清理、`before-quit` 关 watcher |
| `src/plugins/logseq/shared.ts` | 类型 + 日期/文件名词干编译与匹配 + 页面名 encode/decode + 全部块编辑命令(纯) |
| `src/plugins/logseq/format.ts` | `parse` / `serialize` / `tokenize` / 结构查询(纯,主进程与渲染层共用) |
| `src/plugins/logseq/graph.ts` | 索引 / 反链 / 日期范围 / `:hidden` 过滤(纯:文件访问以接口注入,便于单测) |
| `src/plugins/logseq/ui.ts` | `{ id:'logseq', slots:{toolbar:[LogseqButton]}, settingsSections:[LogseqSettings] }` |
| `src/plugins/logseq/ui/*.vue` | §3.7 组件 |
| `src/renderer/logseq.html` + `src/renderer/src/logseq/*` | 页面入口与外壳(照 `terminal.html` / `src/terminal/*`) |
| 核心 8 处 | §3.8 的表 |
| `tests/logseqFormat.test.ts`(新) | 恒等 / 零丢字 / 编辑命令 / token |
| `tests/logseqShared.test.ts`(新) | 日期格式编译、页面名往返、`:hidden` |
| `tests/logseqGraph.test.ts`(新) | 注入式 IO 的索引与反链 |
| `tests/logseqPlugin.test.ts`(新) | `vi.mock('electron')` + 真临时目录:`savePage` 冲突、越界路径拒绝、只写 journals/pages、原子写、`tab:closed` 清理 |
| `tests/internalPages.test.ts` | 增加 `logseq` 登记/`openIn`/`singleton` 用例 |
| `README.md` | 特性行、插件体系列表、新小节「笔记(`bow://logseq`)」、数据存储(新增 `logseq.json`)、快捷键代价说明 |
| `docs/ARCHITECTURE.md` | §1 目录地图、§4 内部页面表(`InternalPageId`/`INTERNAL_PAGES` 代码块与不变量)、§5.8 贡献矩阵(主进程 + 渲染层两张表)、§7.2 渲染入口(四个 → 五个)、§8 数据文件、§11 用例基线、§12 漂移审计(当前 740 例 → 新数) |

---

## 5. 分步实施(每步单独可验证)

| 步骤 | 内容 | 验证 |
| --- | --- | --- |
| **S1** | `format.ts` + `shared.ts`(解析/序列化/tokenizer/编辑命令/日期与页面名)与单测。**先拿一个真实 Logseq 图当 fixture**(用户在 Windows 侧把 `journals/*.md`、`pages/*.md` 各拷 2~3 个到 `tests/fixtures/logseq/`) | `bun run test`:`logseqFormat` / `logseqShared` 全绿,恒等不变式在真实文件上成立 |
| **S2** | `graph.ts`(索引/反链)+ `tests/logseqGraph.test.ts` | 单测:反向链接命中、大小写不敏感、`:hidden` 跳过、mtime 增量 |
| **S3** | `main.ts` 全部 IPC 路由(不含 watch/dialog)+ `tests/logseqPlugin.test.ts` | 单测:落盘内容正确、冲突返回、越界拒绝、只写两个目录 |
| **S4** | 核心接入(§3.8 的 8 处)+ 内部页面能开出来(先只显示图路径与「未选图」) | `bun run typecheck` / `build` 过;真机:`bow://logseq` 能开、标题是「笔记」、地址栏显示 `bow://logseq` |
| **S5** | `JournalView` + `BlockRow` + `BlockText`:今日日志读写、块编辑命令、markdown 渲染、点击映射 | 真机 E2E 场景 1~3;`bun run test` 全绿 |
| **S6** | 保存策略(防抖/冲突横幅/undo 快照)+ `fs.watch` 自动重载 + 最近图 + 设置分区 | 真机 E2E 场景 4~7 |
| **S7** | 反链面板 + 页面搜索 + `[[` 补全 + 模板(`listTemplates`/`renderTemplate`,新建日志时展开) | 真机 E2E 场景 5、8 |
| **S8**(可砍) | `openInNewPane`(Ctrl+点击在新窗格开页)+ 工具栏按钮 + 历史/书签里的 `bow://logseq`(自动生效,不必改代码) | 真机 E2E 场景 9 |
| **S9** | 文档(README + ARCHITECTURE,含漂移审计与用例基线)+ 全量回归 + E2E 记录写入本文件 §9 | `bun run test` 全绿;E2E 全项;无新 `未捕获异常` |

---

## 6. 验证矩阵

### 6.1 单测(`bun run test`,当前基线 **39 文件 / 740 例**)

| 用例组 | 关键断言 |
| --- | --- |
| 恒等 | 对每个 fixture:`serialize(parse(raw)) === raw`(空文件 / 无尾换行 / CRLF / 4 空格缩进 / 块属性 / 多行块 / 围栏代码 / `title::` / 中文与 emoji) |
| 零丢字 | 每个块:`tokens.map(t => t.raw ?? 拼接子 token).join('') === block.text` |
| 编辑命令 | `indent/outdent/split/merge/insert/delete` 对树的结果(含「outdent 后挂到前一兄弟下」这类 Logseq 语义)与「未触及行不变」 |
| 日期/命名 | 格式串编译 ↔ 匹配互逆;无法识别的格式回落 `yyyy_MM_dd`;`encodePageName`/`decodePageName` 往返;`/`→`___`、`?`→`%3F` 等具体样本(照 PR #6134 的样例) |
| 图与反链 | 反向链接命中与排序、大小写不敏感、`:hidden` 跳过、mtime 未变不重解析 |
| 插件 IPC | `savePage` 冲突(改文件后 baseMtime 变旧)、`../` 越界路径拒绝、只允许写 `journals/`+`pages/`、原子写(写后无 `.tmp` 残留)、`tab:closed` 后 `attach` 回到默认视图 |
| 内部页面 | `parseInternalUrl(LOGSEQ_URL)`、`openIn==='pane'`、`singleton===false`、`entry==='logseq'` |

### 6.2 真机 E2E(Windows,`D:/tmp/logseq-e2e.mjs`,沿用隔离 userData + CDP 骨架;先由 `setGraph` 免弹框)

| # | 场景 | 判据 |
| --- | --- | --- |
| 1 | 打开 `bow://logseq`(未选图) | 显示「选择图目录」引导,不白屏、无异常 |
| 2 | `setGraph` 后开今日日志 | 顶部日期 = 今天;此时 `journals/` **没有**新文件(未编辑不落盘) |
| 3 | 输入 `今天读了 [[cardinality]] 的笔记` → Enter → 输入 `关联到 #数据库` → Tab | 文件内容 = 两行 + 2 空格缩进;无多余空行;`mtimeMs` 递增 |
| 4 | 点块里的 `cardinality` | 进入 `pages/cardinality.md`(不存在 → 空页);输入后落盘;文件名词干符合 `:triple-lowbar` |
| 5 | 页面底部反链面板 | 出现 1 条来自今日日志的块;点它 → 回到日志并高亮/滚动到该块 |
| 6 | 配 `:default-templates {:journals "Daily"}` + 写 `templates/Daily.md`(含 `<%date%>`) | 打开一个未创建的日期 → 内容 = 展开后的模板;落盘后与 Logseq 能打开 |
| 7 | 用外部脚本改同一文件(编辑器干净) | 编辑器自动重载,内容更新,**不**出现冲突横幅 |
| 8 | 编辑器有未保存改动时外部改同一文件 → 保存 | 出现冲突横幅;选「重载」→ 本地改动被丢弃、显示磁盘版本;选「覆盖」→ 磁盘 = 本地 |
| 9 | 标签刷新(F5)/ 再开一次 `bow://logseq` | 回到同一个页面(per-tabId 视图状态);关标签后主进程无残留会话 |
| 10 | `Ctrl+Shift+→`(焦点在编辑器) | 当前组变成两个窗格(页面自己调 `splitPane`,核心零改动) |
| 11 | 停用「笔记」插件后开 `bow://logseq` | 页面显示「插件已停用」提示(invoke 报错被捕获),不是白屏/未捕获异常 |
| 12 | 回归 | `terminal-e2e` 21/21、`nested-split-e2e` 60/60、`terminal-pane-e2e` 43/43 仍全绿;主进程日志无 `未捕获异常` |

---

## 7. 风险 / 未知

1. **两处格式细节未用真实文件校准**(页面属性行形态、块属性缩进形态)。缓解:①S1 第一步就用真实图当 fixture;
   ②恒等不变式保证「分类错也不会改写字节」;③反链/编辑命令错只影响交互,不损坏数据。
2. **`Ctrl+W` 关窗格会丢最后 ≤400ms 的输入**(主进程在页面之前吃掉该键,页面无法 flush)。缓解:防抖压到 400ms;
   写进 README 的代价清单。想彻底解决需要在核心加「内部页面关闭前的保存钩子」——本次不做。
3. **`fs.watch` 的可靠性**:Windows 递归监听可靠;Linux 递归自 Node 20 起支持;但网络盘/同步盘(OneDrive、
   Dropbox)上事件可能丢。缓解:反链面板与页面列表每次**打开时**都做一次轻量 stat 校验;设置页给「重建索引」。
4. **和 Logseq 同时写作的语义冲突**(比如 Logseq 把 `collapsed:: true` 写进文件、我们在 UI 上折叠但不写):
   双方都只动自己改的那些行,冲突检测兜住并发;但「同一块同时在两边编辑」会按 mtime 报冲突(不自动合并)。
5. **大图性能**:全量索引是 O(文件数 × 大小);已给阈值与退化路径(§3.4),但真实大图(>5000 文件)未实测。
6. **文件名词干截断 160 与重名**(Logseq 新版对超长标题会附加 page uuid 以避免重名)我们只截断,
   可能出现两个标题映射到同一个文件名 → 写文件前**必须检查目标路径是否已属于别的标题**,重名则报错而不是覆盖。
7. **`title::` 语义**:显示名以 `title::` 优先,但我们不会替用户补 `title::`(只在「文件名表达不了标题」时写);
   与 Logseq 的行为对齐情况需要真机对一遍。
8. **mac 未验**(与前几份计划同样的遗留):`Cmd+Shift+方向`、`Cmd+W` 只在 Windows 真机实测。
9. **既有测试基线会变**:`tests/internalPages.test.ts` 与 §1/§11/§12 里的用例数要同步,否则又留一条文档漂移。

---

## 8. 不做的事(明确排除)

- **不支持 DB 图**(`logseq/db.sqlite` / Desktop 的 DB 模式)、不支持 org 格式(`:preferred-format :org`);
  遇到就明确拒绝 + 解释,不尝试半支持。
- 不做 `((块引用))`、`{{embed}}`、`{{query}}`、`TODO/DOING`、优先级、闪卡、白板、`{{video}}` 等;
  这些语法**原样显示、原样保存**(零丢字不变式兜底)。
- 不做 MCP 工具(G4);不做图片内联渲染(本地 `assets/…` 图片显示为链接文本;要做得走自定义协议,另有单独计划)。
- 不做多图同时编辑(一次一个图;最近图列表用于切换)、不做同步/协作/网络访问。
- 不改 `shouldTakeSplitHotkey`(不加 `logseq` 白名单),分屏由页面自己调 IPC。
- 不改 `logseq/config.edn`(只读);不建 `.bak`、不自动格式化用户的文件。

---

## 9. 实施记录(2026-09-20 完成)

### 9.1 落地了什么

| 类别 | 文件 |
| --- | --- |
| 插件(新) | `src/plugins/logseq/{main.ts,shared.ts,format.ts,graph.ts,ui.ts}` + `ui/{JournalView,BlockRow,BlockText,BacklinksPanel,LogseqButton,LogseqSettings}.vue` |
| 渲染入口(新) | `src/renderer/logseq.html`、`src/renderer/src/logseq/{main.ts,LogseqApp.vue}` |
| 核心接线 | `src/shared/internalPages.ts`(`'logseq'` + `LOGSEQ_URL` + 登记项)、`src/main/rendererEntry.ts`、`electron.vite.config.ts`、`src/main/plugins/builtin.ts`、`src/renderer/src/plugins/registry.ts`、`tsconfig.{node,web}.json`(登记 `format.ts` / `graph.ts` 两个新文件名) |
| 单测(新) | `tests/logseqFormat.test.ts`(16)、`logseqShared.test.ts`(34)、`logseqGraph.test.ts`(16)、`logseqPlugin.test.ts`(22);`tests/internalPages.test.ts` +2 |
| 文档 | `README.md`(特性行 / 技术栈 / 新小节「笔记(bow://logseq)」/ 数据存储 / 设置页 / 插件清单 / 分屏一节)、`docs/ARCHITECTURE.md`(§1 目录地图、§4 内部页面、§5.8 两张贡献表 + 三条不变式、§7.2 五个渲染入口、§7.3 设置页、§8 数据文件、§11 用例基线、§9 事件总线说明) |

### 9.2 与计划的偏差(都是实施中改的,理由在下面)

1. **删掉了计划里的 `applyEdit` IPC 面**。每个编辑命令都是纯函数,渲染层 import 同一份实现就能算,
   走 IPC 只是多一层序列化与一处「raw 与基线 mtime 谁对」的隐患。现在主进程只保留
   `read* / savePage / 索引查询 / 视图状态`。数据安全不变(同一份代码,单测更直接)。
2. **新增 `setBlockContentLines()`**,并删掉 `appendContentLine()`。界面上一个块是**多行**的
   (多行内容也在同一个 textarea 里),只改第一行不够用;顺带把 `hasBlocks()` 补进 `format.ts`。
   同时合并了两个重名函数(`format.ts` 的 `blockDisplayLines` 与 `shared.ts` 的 `blockLinesForDisplay`)。
3. **`:hidden` 的语义按「相对图根」实现**(`/archived` = `<graph>/archived`,不带 `/` 的条目额外按基名匹配)——
   计划里没写清,照 Logseq 的 `config.edn` 注释定的,单测钉住了三种写法。
4. **`fs.watch` 的索引刷新改成按路径增量**:配置变了才全量重扫,否则只重读被改的那个文件
   (计划里没写这一层,但「每次打字都 O(n) 全量扫描」在大图上不可接受)。
5. **修了一个真机 E2E 抓出来的 bug**:点「用磁盘版本重载」之后冲突横幅会**再弹回来** —— 重载把
   `<textarea>` 卸下时浏览器触发 `blur`,那个 handler 立刻用**旧基线**又存了一次。修法:
   换页期间 `loadingView` 守卫 + 冲突未解决时 `scheduleSave` 直接拒绝 + 重载/覆盖前显式丢弃本地改动。
   (`window.__bowLogseq.trace` 就是为查这个加的,留在调试把手上了。)
6. **`hiddenProps` 一开始漏了系统属性**:渲染时只按 `config.edn` 的 `:block-hidden-properties` 过滤,
   于是 `id::` / `collapsed::` 会被画到界面上(`format.ts` 的 `visibleProperties()` 默认带系统属性,
   所以单测是绿的、UI 是错的)。修法:界面把 `DEFAULT_HIDDEN_PROPERTIES` 与配置项合并,
   E2E 里加了两条断言(`id::` 不渲染 / `rating:: 8` 照常显示)。
7. **`typecheck` 抓不到 `.vue` 的错误**:`tsc` 不看 `.vue`(只有 rollup 会报)。实施中两个真实的
   导出错误(`blockLinesForDisplay` 引错模块、`hasBlocks` 漏导出)都是 `bun run build` 报的 ——
   已写进 ARCHITECTURE §11。

### 9.3 验证(实测)

- `bun run typecheck` / `bun run build` 过(`out/renderer/logseq.html` + 独立 chunk 产物正常)。
- `bun run test` → **43 个文件 / 830 个用例全绿**(基线 39/740:+4 文件、+90 例)。
- **真机式 E2E:`/mnt/d/tmp/logseq-e2e-wsl.mjs` → 33/33,连跑两次全绿。**
  它在 **WSL/Linux 的 Electron 上跑真实应用**(`--user-data-dir` 隔离 + CDP,`DISPLAY=:0` / WSLg),
  **真的建了一个 Logseq 文件图并真的读写磁盘**,覆盖:工具栏入口、选图与 `config.edn` 读取、
  模板渲染且未编辑不落盘、输入/回车/缩进的落盘内容逐字节比对、双链点击跳转、反链面板(数量 + 来源 + DOM 计数)、
  系统属性隐藏与自定义属性显示、外部改动自动重载、mtime 冲突(不改磁盘 + 横幅 + 磁盘内容一致 + 重载解决)、标签刷新回到同一页、
  页内 `Ctrl+Shift+→` 分屏、地址栏 `bow://logseq` 通路、停用插件后的提示、主进程日志无未捕获异常。

### 9.4 仍未验证(如实记录)

- **Windows 真机 E2E 没跑**:`D:\Workspace\browser`(E2E 脚本里写死的 CWD)是另一份检出,
  比本工作区**落后 3 个提交**(HEAD `fc446ec` vs 本工作区的 `5b29acf`),里面**没有**这个插件;
  要在 Windows 侧跑得先把它同步到当前工作区。`terminal-e2e` / `nested-split-e2e` 等回归脚本同理未跑
  (它们依赖 Windows 的 `node-pty` 预编译与 `electron.exe`)。
- **mac 未验**(与前几份计划同样的遗留)。
- 大图(> 5000 文件)的性能只是设计了退化路径(索引上限 + 「太多文件」提示),**没有真实大图实测**。
- `Ctrl+W` 关窗格时最后 ≤400ms 的输入仍可能丢(计划 §7 风险 2,未解决 —— 真要解决得在核心加
  「内部页面关闭前的保存钩子」,本次刻意不做)。
- 与 Logseq 的**双向格式校准**只到「解析→序列化恒等 + 按官方 `config.edn` 语义读写」这一层:
  没有在装了 Logseq 的真机上做过「bow 写 → Logseq 读 / Logseq 写 → bow 读」的往返对照(见计划 §7 风险 1)。
