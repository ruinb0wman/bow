# 夸克网盘插件（pan.quark.cn 直链 → bow 下载器）

日期:2026-09-24 · 状态:**已实现并验证完毕**(S0-S7 全部完成;实测结论见 §0.1)

## 0. 目标与假设

**目标**:新增内置插件 `quark` —— 在 `pan.quark.cn` 的个人网盘页上,读当前目录的文件列表,
用**官方 PC 客户端的 UA + 会话 Cookie** 调夸克自己的 `/file/download` 接口拿 `download_url`,
然后把直链交给 **bow 现有的下载插件**(带 UA/Referer/Cookie 三个必需请求头)静默下载;
另外提供「复制直链 / 复制 aria2c 命令行 / 推送 aria2 RPC」三个导出动作,并给 AI 暴露 MCP 工具。

**用户已拍板的四个决策**(2026-09-24):

1. **下载落地**:复用 bow 下载面板 —— 给 `downloads` 插件加一条**跨插件 enqueue 契约**(事件通道 + 请求头注入),
   进度 / 暂停 / 续传 / `browser_list_downloads` 全部照旧可用,不弹保存对话框。
2. **页面范围**:**只做个人网盘页**(`pan.quark.cn` 文件列表)。分享页(`/s/xxx` 的 `pwd_id` / `share_fid_token` / `stoken`)不在本次范围。
3. **入口形态**:工具栏按钮 + 全屏浮层面板。**不往页面里注入任何 DOM**。
4. **导出能力**:复制直链 + 复制 aria2c 命令行 + 推送 aria2 RPC(JSON-RPC `aria2.addUri`)。

**假设**(如与实际不符,改动集中在 S3 / S5):

- 夸克 `/file/download` 接口的契约与 LinkSwift 1.1.3 一致:POST `{fids:[...]}` → `data[].download_url`。
  脚本已逐行读过(见 §1),这是目前唯一可信的行为依据。
- 直链 CDN 的 host 属于 `quark.cn` / `uc.cn`。**未证实**(§7 R2),所以实现上把域名白名单做成设置项 + 面板诊断。
- 用户已在 bow 里登录 `pan.quark.cn`(插件不提供登录流程,只复用会话)。

### 0.1 S0 实测结论(2026-09-24,Electron 44.3.0 / Chromium 152,独立 spike 脚本 + HTTPS 自签 echo server)

**四条机制的能力矩阵**(✅有 / ❌无):

| 机制 | UA | Referer | Cookie 首跳 | Cookie 跨重定向跳 | 自定义头跨跳 | DownloadItem |
| --- | --- | --- | --- | --- | --- | --- |
| `session.downloadURL(url,{headers})` | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |
| `net.request({headers})` | ✅ | ✅ | ✅ | ❌ | — | ❌ |
| `net.fetch({headers})` | ✅ | ✅ | ✅ | ❌ | — | ❌ |
| **页面发起下载(`<a download>` 点击)** | ✅(钩子改) | ✅(页面自动) | ✅(jar) | ✅(jar) | ✅ | ✅ |

**四条硬结论**(全部实测,非推断):

1. **`session.webRequest.onBeforeSendHeaders` 看不见 `session.downloadURL()` 的请求**(0 命中,下载本身成功);
   **看得见页面发起的下载**,含 302 跳转的每一跳(`resourceType=mainFrame`)。→ 加头只能靠页面发起的下载。
2. **显式 `Referer` 用 `downloadURL` 会被丢弃**(HTTPS 靶子上仍不发);`net.request`/`net.fetch` 能发。
   ⚠️ 用 HTTP 靶子测会得到误导性结果:Chromium 会因 HTTPS→HTTP 降级直接 `Cancelling request ... invalid referrer`。
3. **显式 `Cookie` 头在重定向跳上会被丢弃**(Chromium 全局行为,三种机制一致);**只有 cookie jar 里的 cookie 能跨跳存活**。
4. **`net.request` / `net.fetch` 的 `redirect:'manual'` 抛 `Redirect was cancelled`**,读不到 `Location`;
   `redirect:'follow'` 后 `response.url` 是空串。→ **主进程里无法自己解重定向链**。
5. **`<a download>` 点击对所有 Content-Type 都强制下载**(连跨源的 `video/mp4`、`application/pdf` 都行);
   `location.href = url` 在这些类型上会**导航/播放**。→ 必须用 `<a download>`。
6. 页面发起下载时 `item.getURLChain()` **包含被点击的原始 URL**(`takeDirective` 能精确匹配),
   `item.getURL()` 是重定向后的最终 URL,**文件名来自 `<a download="...">`**。

**⇒ 架构修正**:quark 插件**不再调 `session.downloadURL`**,改为
「先 enqueue 指令(登记 headers + silent)→ 再 `ctx.pages.execute` 在夸克页面里点一个 `<a download>`」。
这样 UA(钩子改写)+ Referer(页面自动)+ Cookie(jar,跨跳在)+ `DownloadItem` 四者同时成立。
计划原来的「选项 A / 选项 B / 选项 C」三选一随之作废,§2 已按此重写。

## 1. 已核实的现状(代码事实,改动都基于这些)

### 1.1 bow 侧

| 事实 | 位置 |
| --- | --- |
| 插件是仓库内编译期模块,两侧文件 `main.ts` / `ui.ts`,靠 `shared/plugins.ts` 对齐 | `docs/ARCHITECTURE.md` §5.1 |
| `PluginContext` 全 API(IPC / events / net / content / pages / tabs / mcp / shortcuts / storage) | `src/main/plugins/types.ts:93` |
| `ctx.pages.execute(tabId, code)` → `wc.executeJavaScript(code, true)`(**主世界**,可读 React fiber / `unsafeWindow`) | `src/main/plugins/types.ts:48`、`src/main/index.ts:210-235` |
| `ctx.events.emit` → `kernel.emitEvent`:同步遍历订阅者**快照**,单订阅者抛错只记日志;**无返回值** | `src/main/plugins/kernel.ts:296-306` |
| `ctx.events.on` → `addSubscriber`,**跨插件可见**(事件名不带命名空间限制) | `src/main/plugins/kernel.ts:280-294` |
| 插件之间**没有**主进程侧互调 API(`kernel.invoke` 不在 `PluginContext` 上) → 只能走事件总线 | `src/main/plugins/types.ts:93-125`、`src/main/plugins/kernel.ts:387-499` |
| `net` 钩子三阶段链式,`NetHookContext` 每次是新对象,`requestHeaders` 是浅拷贝;`requestId` 跨重定向跳保持 | `src/main/plugins/netHooks.ts:66-130`、`src/shared/plugins.ts` 的 `NetHookContext` |
| 钩子注册只需 `ctx.net.onBeforeSendHeaders(hook)`,宿主已 `install()` 过 | `src/main/plugins/netHooks.ts:86`、`:121` |
| `hostMatches(host, pattern)` / `hostOf(url)` 已存在于共享模块(支持 `*.子域` 与 `host:port`) | `src/shared/pluginMatch.ts:72`、`:85` |
| 浮层 id 约定 `plugin:<pluginId>:<panelId>`;`routeOverlayEvent` 只路由到插件的 `overlay-event` 方法 | `src/main/plugins/kernel.ts:227-235` |
| 渲染层可用 `plugins.invoke('<任意插件id>', method, ...)` 调另一个插件的 IPC | `src/preload/index.ts:149-154` |
| 插件边界由测试强制:`main.ts` 不引 `.vue` / `@renderer`;`ui.ts` 不引 `electron` | `tests/pluginBoundaries.test.ts` |
| `tsconfig.node.json` 的 include 已覆盖 `src/plugins/*/{main,shared,scripts}.ts`,**新插件无需改 tsconfig** | `tsconfig.node.json` |
| 内置插件顺序 = 钩子链与激活顺序,新插件追加到 `BUILTIN_PLUGINS` 末尾 | `src/main/plugins/builtin.ts` |
| 渲染层 UI 需在 `PLUGIN_UI` 登记一行;未列入 `SLOT_PLUGIN_ORDER.toolbar` 者自动排最后 | `src/renderer/src/plugins/registry.ts` |
| 注入脚本的测试约定:`new Function(JS)` 验语法 + `toContain` 验关键不变式(无 jsdom) | `tests/adblockPickerScript.test.ts`、`tests/elementFullscreenScript.test.ts` |
| 插件 `main.ts` 的单测约定:手写 `fakeCtx` + `vi.mock('electron')` | `tests/elementFullscreenPlugin.test.ts`、`tests/logseqPlugin.test.ts` |
| 插件纯逻辑必须放 `shared.ts` 且**不 import electron / node:fs** | `src/plugins/downloads/shared.ts:1-10` 的注释 |

### 1.2 downloads 插件侧(本次唯一要改的现有插件)

| 事实 | 位置 |
| --- | --- |
| `Directive { url, saveDir?, filename?, silent, retriedFrom?, createdAt, onCreated? }` 是「AI/外部发起下载」的载体 | `src/plugins/downloads/main.ts:44-53` |
| `silent = directive?.silent === true \|\| !state.askWhereToSave` | `src/plugins/downloads/main.ts:233` |
| `DEFAULT_DOWNLOAD_SETTINGS.askWhereToSave = true` → **不传 directive 的下载一定会弹保存对话框** | `src/plugins/downloads/shared.ts:69-73` |
| 下载入口只有 `session.defaultSession.downloadURL(url)`,**无法自定义请求头** | `src/plugins/downloads/main.ts:434`、`:590` |
| `browser_download` 用 directive + `silent:true` + `onCreated` 回调实现「不弹框 + 拿回记录」 | `src/plugins/downloads/main.ts:551-608` |
| `retry` 用重定向链**最后一跳**重下,`silent:false`(遵循设置) | `src/plugins/downloads/main.ts:424-440` |
| 插件**没有** `net` 能力(不注册任何网络钩子) | `src/plugins/downloads/main.ts:118`(`capabilities: ['ui','mcp']`) |
| 事件广播 `ctx.ipc.emit` 只到 chrome/overlay/internal 页,不适合主进程间通信;跨插件要用 `ctx.events.emit` | `docs/ARCHITECTURE.md` §5.9 |

### 1.3 夸克侧(从 LinkSwift 1.1.3 源码逐行读出,`/tmp/linkswift.user.js`)

| 事实 | 位置(该文件行号) |
| --- | --- |
| 伪装 UA:`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/3.20.0 Chrome/112.0.5615.165 Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch` | :369 |
| 接口:`POST https://drive-pc.quark.cn/1/clouddrive/file/download?entry=ft&fr=pc&pr=ucpro` | :371 |
| 个人网盘页 body 只有 `{ fids: [...] }`(**不需要 stoken / pwd_id**) | :7163 |
| 响应取 `data[].download_url`,字段还有 `file_name` / `size` / `file`(false=文件夹) | :7190 |
| 错误码:`31001`=未登录,`23018`=游客超大小限制(message 里含 `[fid]`) | :7165-7172 |
| 批量 15 个/批,批间 `sleep(1000)` | :7155-7158 |
| 下载必须带 `User-Agent`(同伪装 UA) + `Referer: https://<host>/` + `Cookie: document.cookie` | :7192-7194 |
| 文件列表从 React fiber 里读:`document.getElementsByClassName("file-list")[0]` → 向上找 `stateNode.props`,`props.list` / `props.selectedRowKeys` | :7253-7267、:1886 |
| aria2 命令行形态:`aria2c "<url>" --out "<name>" --header "User-Agent:…" --header "Referer:…" --header "Cookie:…"` | :770、:7192 |
| aria2 RPC 形态:JSON-RPC 2.0 `aria2.addUri`,`params: ["token:…", [url], {dir, out, header}]`,默认 `http://localhost:16800/jsonrpc` | :863-905、:2018-2028 |

**直链有效期**:接口响应含 `expires_in`(第三方资料普遍报 3600s),URL 自身带签名与 `Expires`。
所以「取直链 → 立刻入队下载」是唯一正确顺序,不做直链缓存。

## 2. 架构决策

### D1 请求头注入放在 downloads 插件,不在 quark 插件

理由:能改下载请求头的只有 `net.onBeforeSendHeaders`,而「哪次请求带哪些头」的状态天然属于**发起下载的那个人**。
把注入点放在 downloads 插件有三个好处:

- 全仓库只有一处给下载请求加头,不产生第二个 `net` 钩子与第二套待匹配状态;
- 重定向跳的跟随、TTL 回收、Cookie 域名白名单都只有一个实现;
- 钩子按 `requestId` 跟随跳转是**已被 spike v7 证实有效**的行为(改写的 UA 在跳转跳上也生效)。

quark 插件因此**不需要 `net` 能力**,只发一条 enqueue 事件。

### D1b 下载由页面发起(`<a download>`),不用 `session.downloadURL`

这是 S0 实测倒逼出来的(§0.1):`downloadURL` 的请求对 `webRequest` 不可见 → UA 改不了;
且它不发 Referer。页面发起的下载则四条件全中。

- quark 插件在 `ctx.pages.execute` 里注入:建一个 `<a>`、设 `download="<文件名>"`、`href=<直链>`、`click()`、立刻移除。
  `executeJavaScript(code, true)` 带 userGesture,配合**串行 + 间隔**触发,规避 Chromium 的多文件下载限制。
- `<a download>` 同时解决**文件名**:实测 `item.getFilename()` 取的就是 `download` 属性的值,
  不依赖夸克 CDN 是否回 `Content-Disposition`。
- 代价:**必须有一个活着的夸克标签页**(直链从该页发起)。面板在非夸克页给出明确提示。
- `downloads` 插件里的 `session.downloadURL()` 路径**保持不动**(`browser_download` MCP 工具继续用它,
  只是新增的 `headers` 参数对那条路径只保证 UA/自定义头、不保证 Referer —— 在文档里写清)。

### D2 跨插件契约走内核事件总线(请求 / 应答两跳)

`ctx.events.emit` 无返回值,所以用 `requestId` 配对:

```text
quark/main.ts                                       downloads/main.ts
  1. net.fetch 取直链(伪装 UA + jar cookie)
  2. emit('downloads:enqueue', req) ───────────────▶ on('downloads:enqueue', h)
                                                       ├─ normalizeEnqueueRequest(req)
                                                       ├─ 记下 headers/cookie 注入表
                                                       └─ directives.push({...silent:true, onCreated})
  3. ctx.pages.execute(tabId, CLICK_JS)                 (不发起下载,等页面)
       └─ 页面里 <a download> 点击
              ↓
     net.onBeforeSendHeaders:URL 命中注入表 → 改写 UA(+ 兜底 Cookie)
              ↓
     will-download → adopt(silent) → DownloadItem ✅
  4. on('downloads:enqueued', reply) ◀──────────────   emit('downloads:enqueued', {requestId, ok, record})
        (超时 → 明确报错)
```

- 事件名常量放 `downloads/shared.ts`(`DOWNLOADS_EVENT.enqueue` / `.enqueued`),quark 侧 import 该常量,
  避免两处字符串漂移。
- 用「事件名 + 纯函数归一」而不是在 payload 里塞回调:可单测、不依赖「同进程所以能传函数」这种未文档化行为。
- **downloads 插件被停用时**无人应答 → quark 报「下载插件未启用(设置 → 插件管理 → 下载)」,不静默失败。

### D3 Cookie 默认交给 cookie jar,显式注入只作为兜底

实测结论(§0.1 第 3 条):**显式 `Cookie` 头在重定向跳上会丢,jar 里的不会**。所以:

- **主路径**:什么都不传 Cookie。夸克登录态在 jar 里(`.quark.cn` 域 cookie),CDN 若同域,浏览器自动逐跳带上。
- **兜底**:契约里保留结构化的 Cookie 字段,只在「CDN 域名不在 jar 的 cookie 域内」时才用;
  且默认只发给 `quark.cn` / `uc.cn`(`hostMatches` 后缀匹配),避免把会话泄露给第三方 CDN
  (LinkSwift 的 `document.cookie` 就有这个问题:它把 pan.quark.cn 的 cookie 发给任意 CDN 域)。

```ts
cookie?: { value: string; hosts: string[] }   // 只在 host 命中 hosts 时才注入
headers?: Record<string, string>              // 逐跳注入(重定向也跟随),约定不含 Cookie
```

面板诊断区显示「直链域名 / jar 里是否有该域的 cookie / 是否走了兜底注入」,设置页可加白名单域名。
**这条安全边界写进单测**(`shouldInjectCookie` 空白名单恒 false)。

### D4 会话 Cookie 从主进程 `session.cookies` 读,不用页面 `document.cookie`

- 主进程能读到 httpOnly 的 `__pus` / `__puus` 等(LinkSwift 的 `document.cookie` 读不到),是超集;
- 不需要页面脚本配合,也不受页面 CSP 影响;
- 只读 `pan.quark.cn` 适用的 cookie + `domain: 'quark.cn'` 的域级 cookie,按 name 去重。

### D5 页面状态按需读,不注入常驻脚本

工具栏按钮点击时才 `ctx.pages.execute(tabId, EXTRACT_JS)`(主世界)。好处:页面零痕迹、
不需要「页面按钮 → 主进程」的回调通道(那需要 DOM 标记 + 轮询)、`refresh` 语义不掺进来。
代价:面板里的文件列表是**点击那一刻**的快照,页面翻页/滚动加载后再点一次「刷新」即可。

## 3. 跨插件契约(冻结版)

```ts
// src/plugins/downloads/shared.ts
export const DOWNLOADS_EVENT = {
  changed: 'changed',
  /** 跨插件(主进程内 ctx.events):请求下载 */
  enqueue: 'downloads:enqueue',
  /** 跨插件:enqueue 的应答 */
  enqueued: 'downloads:enqueued'
} as const

export interface DownloadCookieInjection {
  /** 已拼好的 `k=v; k2=v2` */
  value: string
  /** host 后缀白名单,如 ['quark.cn','uc.cn'] */
  hosts: string[]
}

export interface DownloadEnqueueRequest {
  requestId: string
  url: string
  /** 逐跳注入(含重定向)的请求头;约定不含 Cookie */
  headers?: Record<string, string>
  /** 仅在 host 命中时注入的 Cookie */
  cookie?: DownloadCookieInjection
  filename?: string
  saveDir?: string
  retriedFrom?: string
}

export interface DownloadEnqueueReply {
  requestId: string
  ok: boolean
  error?: string
  record?: { id: string; url: string; filename: string; savePath: string; state: DownloadState }
}

/** 归一 + 校验:url 必须 http(s)、requestId 非空、headers/cookie 字段类型正确;坏输入返回 {ok:false,error} */
export function normalizeEnqueueRequest(raw: unknown): { ok: true; value: DownloadEnqueueRequest } | { ok: false; error: string }
/** 只保留 string→string,键名去空白;空对象返回 undefined */
export function sanitizeHeaders(raw: unknown): Record<string, string> | undefined
/** host 命中任一 pattern(@shared/pluginMatch 的 hostMatches);hosts 为空/非法 → false */
export function shouldInjectCookie(host: string, hosts: string[]): boolean
```

**不变式(测试锁定)**

1. `normalizeEnqueueRequest` 对任何输入都不抛,只返回判别联合。
2. `shouldInjectCookie` 对空 `hosts` 恒为 `false`(默认拒绝)。
3. 注入表**绝不落盘**:`DownloadRecord` 不新增任何 header/cookie 字段。
4. 非 Cookie 头只注入给「本次请求及其重定向跳」(`requestId` 配对),不按 host 命中全局注入。

## 4. 文件清单

### 新增

| 文件 | 内容 |
| --- | --- |
| `src/plugins/quark/shared.ts` | 纯逻辑:URL 判定、UA 常量、接口地址、请求头构造、响应解析、错误码映射、分批、文件名清洗、aria2 命令行 / RPC body 构造、设置归一 |
| `src/plugins/quark/scripts.ts` | `EXTRACT_JS`(读页面状态)+ `WALK_FN_SRC`(fiber 遍历函数**源码字符串**,既内联进 `EXTRACT_JS` 又给单测直接 `new Function` 跑)+ `buildClickScript(url, filename)`(建 `<a download>` 并点击,JSON.stringify 内联参数) |
| `src/plugins/quark/main.ts` | `PluginMain`:IPC / MCP / enqueue 应答配对 / 设置存储 |
| `src/plugins/quark/ui.ts` | `PluginUiContribution`:`slots.toolbar=[QuarkButton]`、`overlays=[plugin:quark:panel]`、`settingsSections=[QuarkSettings]` |
| `src/plugins/quark/ui/QuarkButton.vue` | 工具栏按钮,仅在活动标签是夸克个人网盘页时可点 |
| `src/plugins/quark/ui/QuarkPanel.vue` | 全屏浮层:文件列表 / 勾选 / 下载 / 导出 / 进度 / 诊断 |
| `src/plugins/quark/ui/QuarkSettings.vue` | 设置分区:UA、Cookie 域名白名单、aria2 RPC |
| `tests/quarkShared.test.ts` | 纯逻辑用例(本次测试的主战场) |
| `tests/quarkScript.test.ts` | `EXTRACT_JS` 语法 + `WALK_FN_SRC` 对假 fiber 的行为 |
| `tests/downloadsEnqueue.test.ts` | 跨插件契约:enqueue → directive → `downloadURL` → 应答;net 钩子注入与域名门禁 |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/plugins/downloads/shared.ts` | 加 `DOWNLOADS_EVENT.enqueue/.enqueued`、`DownloadEnqueueRequest/Reply`、`normalizeEnqueueRequest`、`sanitizeHeaders`、`shouldInjectCookie` |
| `src/plugins/downloads/main.ts` | `Directive` 加 `headers?/cookie?`;新增注入表 + `net.onBeforeSendHeaders` 钩子;订阅 `downloads:enqueue` 并应答;`browser_download` 加 `headers` 参数;`retry` 复用注入表(缺失时明确报错);`capabilities` 加 `'net'` |
| `src/main/plugins/builtin.ts` | `BUILTIN_PLUGINS` 末尾追加 `quark` |
| `src/renderer/src/plugins/registry.ts` | `PLUGIN_UI` 追加 `quarkUi`(不动 `SLOT_PLUGIN_ORDER`,自动排最后) |
| `docs/ARCHITECTURE.md` | §5.8 贡献矩阵加 `quark` 行 + 更新 `downloads` 行;§5.9 之后新增「插件间事件契约」小节;§6.2 工具表加 3 个 quark 工具与 `browser_download` 的 `headers` |
| `README.md` | `## MCP 工具一览` 加 3 行 + `browser_download` 行补 `headers`;新增 `### 夸克网盘插件` 小节(放在 `### 下载插件` 之后);`### 下载插件` 补一句跨插件 enqueue 契约 |

## 5. 分步实施(每步都能独立验证)

### ~~S0 先验证最大未知~~ ✅ 已完成(2026-09-24)

结论见 §0.1。9 个 spike 脚本在 `/tmp/bow-*-spike*.js`(离线 HTTPS 自签 echo server,不碰仓库代码)。
产出:**架构改为「页面发起下载」**(D1b),`session.downloadURL` 的路径不再是 quark 的下载入口。
`net.onBeforeSendHeaders` 对页面发起的下载**有效**这一点已实测(v7:UA 在跳转跳上也被改写)。

### S1 downloads 插件:契约的纯逻辑部分

- 改 `src/plugins/downloads/shared.ts`(§3 的类型与三个函数)。
- 加 `tests/downloadsShared.test.ts` 用例:`normalizeEnqueueRequest` 的 6 类坏输入、`sanitizeHeaders` 的
  非字符串值过滤、`shouldInjectCookie` 的 `quark.cn` / `a.quark.cn` / `quark.cn.evil.com` / 空白名单。
- **验收**:`npx vitest run tests/downloadsShared.test.ts` 全绿;`npm run typecheck` 通过。

### S2 downloads 插件:注入 + enqueue 接线

> ⚠️ 本步**不引入新的下载入口**:钩子只改写「已经发生的」下载请求的请求头。
> `session.downloadURL` 的调用点(`browser_download` MCP / `retry`)保持原样。

- `Directive` 加 `headers?` / `cookie?`;`adopt()` 在 push 时把两者登记进两张内存表:
  - `injectionByUrl: Map<url, Injection>`(重定向/暂停恢复后按 URL 重新匹配)
  - `injectionByRequest: Map<requestId, Injection>`(跨跳跟随)
- 注册 `ctx.net.onBeforeSendHeaders`:URL 命中 → 记 `requestId`;`requestId` 命中 → 合并
  `headers`,并在 `shouldInjectCookie(hostOf(ctx.url), cookie.hosts)` 为真时合并 `Cookie`。
  每次调用顺带做 TTL 清扫(默认 12h,上限 500 条,超限丢最旧)。
- `finish()` 里按 url/requestId 清掉注入表(暂停/恢复期间保留)。
- 订阅 `downloads:enqueue`:归一 → push directive(`silent: true`)+ `onCreated` 应答;
  `DIRECTIVE_TTL_MS` 到期未创建 → 应答 `{ok:false, error:'下载没有启动(地址被拦截或服务器拒绝)'}`。
- `browser_download` 加 `headers` 参数(透传进 directive);`retry` 时若该记录有注入表 → 复用,
  否则返回 `{ok:false, error:'这条记录需要请求头(如夸克直链),请重新发起下载'}`。
- 加 `tests/downloadsEnqueue.test.ts`(`vi.mock('electron')` + fake ctx):
  1. 坏 payload → 应答 `ok:false` 且不调 `downloadURL`;
  2. 好 payload → `downloadURL` 被调用一次,`silent` 生效,`onCreated` 触发后应答 `ok:true` 带 record;
  3. 钩子:同 `requestId` 的第二跳(换 host)仍注入 UA/Referer,但**只有** host 命中白名单才注入 Cookie;
  4. `hosts: []` 时任何 host 都不注入 Cookie。
- **验收**:该测试文件全绿;`vitest run` 全量绿;`typecheck` 通过。

### S3 quark 插件:纯逻辑(`shared.ts`)

- 常量:`QUARK_UA_DEFAULT`、`QUARK_API`、`QUARK_HOME_HOSTS = ['pan.quark.cn','drive.quark.cn']`、
  `QUARK_COOKIE_HOSTS_DEFAULT = ['quark.cn','uc.cn']`、`QUARK_CODE = {ok:0, notLoggedIn:31001, guestLimit:23018}`。
- `isQuarkHomeUrl(url)`:host 命中 `QUARK_HOME_HOSTS` 且 pathname **不**以 `/s/`、`/share/` 开头
  (分享页明确排除,与决策 2 一致)。
- `buildApiHeaders({ua, cookie})`、`buildDownloadHeaders({ua, referer})`、`cookieHeaderFrom(cookies)`。
- `parseDownloadResponse(json)` → `{ok:true, files}` 或 `{ok:false, code, reason, message}`,
  `reason ∈ 'not-logged-in' | 'guest-size-limit' | 'api-error' | 'malformed'`(23018 时从 message 抠 fid)。
- `chunk(fids, 15)`、`sanitizeFilename(name)`(去 `/\:*?"<>|`、控制字符、首尾空白与点)、`formatBytes(n)`。
- `buildAria2Command({url, filename, headers})`、`buildAria2RpcBody({url, filename, headers, settings})`。
- `normalizeQuarkSettings(patch, prev)`(UA 非空、hosts 数组去重去空、aria2 端口 1-65535 夹紧)。
- 加 `tests/quarkShared.test.ts`(约 25 条):响应解析的四类分支、23018 抠 fid、分批边界(0/1/15/16/31)、
  `isQuarkHomeUrl` 对分享页与 `drive-pc.quark.cn` 的拒绝、文件名清洗、aria2 命令的引号与头顺序、
  `normalizeQuarkSettings` 的坏输入回退。
- **验收**:`npx vitest run tests/quarkShared.test.ts` 全绿。

### S4 quark 插件:页面提取脚本(`scripts.ts`)

- `WALK_FN_SRC`:一个纯函数源码字符串,输入「起始 fiber」,沿 `fiber.return` 向上找
  `stateNode?.props?.list` 或 `memoizedProps?.list` 是数组的那个节点,返回 `{props, depth, keys}`
  (找不到返回 `null`)。**不碰 DOM**,所以单测可以直接喂假对象。
- `EXTRACT_JS`(`String.raw`,内联 `WALK_FN_SRC`,不使用反引号/`${` 插值,与 `element-fullscreen/scripts.ts` 同风格):
  1. 依次尝试 `[class*="file-list"]` / `.file-list` / `[class*="FileList"]` 找列表容器,取 `__reactFiber$`/`__reactInternalInstance$` 键;
  2. `walk(fiber)` 拿 props → `props.list` 过滤出**文件**(`v.file === true || v.dir === false || v.file_type !== 0`),
     映射成 `{fid, name, size, updatedAt?}`;`props.selectedRowKeys` 作为预勾选;
  3. 返回 `{ok:true, folder:{name?}, files, selected, diagnostics:{selector, classList, fiberKeyPrefix, listLength, host, path}}`;
  4. 任一步失败返回 `{ok:false, error, diagnostics}`,**绝不修改页面**。
- 加 `tests/quarkScript.test.ts`:
  - `new Function(EXTRACT_JS)` 不抛;`toContain` 关键标记(`__reactFiber$`、`return`、`selectedRowKeys`);
  - `const walk = new Function('return ' + WALK_FN_SRC)()` 然后喂 4 组假 fiber:
    命中 `stateNode.props.list` / 命中 `memoizedProps.list` / 一路到顶没有 list → `null` / `list` 不是数组 → `null`;
  - 断言脚本里**没有** `innerHTML`、`appendChild`、`document.write`(不写页面)。
- **验收**:测试全绿。

### S5 quark 插件:主进程 `main.ts`

- `storage('quark.json', normalizeQuarkSettings)` 存设置。
- `readPage(tabId?)`:`tabs.getActive()` → `isQuarkHomeUrl` 校验 → `ctx.pages.execute(tabId, EXTRACT_JS, {timeoutMs:5000})`
  → 归一结果(非法/失败给可读错误)。
- `readCookies()`:`session.defaultSession.cookies.get({url:'https://pan.quark.cn/'})` +
  `{domain:'quark.cn'}`,按 name 去重 → `cookieHeaderFrom`。
- `fetchLinks(fids)`:`net.fetch` POST 到 `QUARK_API`,`chunk(fids,15)` + 每批间隔 1s,
  逐批 `parseDownloadResponse`,合并 `[{fid, name, size, url, host}]`。
  (用 `net.fetch` 而非 `net.request`:它能发 Referer 且 API 更短;两者对 POST + 自定义头都可用。)
- `download(items)`:**串行**逐条:
  1. `requestId = randomUUID()`,订阅 `downloads:enqueued` 配对(5s 超时);
  2. `emit('downloads:enqueue', { requestId, url, headers:{'User-Agent':UA}, silent:true, filename })`;
  3. `ctx.pages.execute(tabId, buildClickScript(url, filename))`;
  4. 等应答;两条之间间隔 ~300ms(规避 Chromium 多文件下载限制)。
  失败条目单独报告,不中断整批。
- `pushAria2(items)`:POST 设置的 RPC 地址,`aria2.addUri`,返回逐条结果。
- IPC:`state`(设置 + 页面快照 + 诊断)、`listFiles`、`getLinks`、`download`、`aria2Push`、
  `copyAria2Command`、`getSettings`、`setSettings`。
- MCP:`quark_list_files {tabId?}`、`quark_get_links {fids?, names?, tabId?}`、
  `quark_download {fids?, names?, saveDir?, wait?}`、`quark_push_aria2 {fids?, names?}`。
  (`fids`/`names` 都省略 = 全部文件;`names` 支持前缀/包含匹配,便于 AI 只说文件名。)
- `ctx.events.on('tab:closed')` 丢掉该 tab 的快照缓存。
- 加 `tests/quarkPlugin.test.ts`(fake ctx + `vi.mock('electron')`):manifest/capabilities、
  注册的 IPC 方法名集合、MCP 工具名集合、`isQuarkHomeUrl` 不在夸克页时 `listFiles` 的报错文案。
- **验收**:测试全绿;`npm run dev` 手工在 `pan.quark.cn` 上点按钮能看到文件列表。

### S6 UI:按钮 + 面板 + 设置

- `QuarkButton.vue`:订阅 `onTabUpdated`/`onTabActivated`,非夸克页置灰 + tooltip 说明;
  点击 `api.showOverlay({id:'plugin:quark:panel', payload: undefined, placement:'full'})`。
- `QuarkPanel.vue`:
  - 顶部:页面地址 / 目录名 / 「刷新」/「全选」/ 诊断折叠区(选择器命中、fiber 键前缀、cookie 条数、直链域名、是否注入 Cookie);
  - 列表:复选框 + 文件名 + 大小 + 每行「复制直链 / 复制 aria2c 命令」;
  - 底部:「下载选中(N)」「推送 aria2」「复制全部直链」;
  - 进度:轮询 `plugins.invoke('downloads','list')`(500ms,仅在有非终态时;与 `DownloadsButton.vue` 同一策略),
    用 `percentOf` 显示,错误(403/超时)就地展示并给「重新获取直链」按钮;
  - 未登录(31001)/ 游客超限(23018)给出明确文案与「去登录」跳转。
- `QuarkSettings.vue`:UA 输入(带「恢复默认」)、Cookie 域名白名单(逗号分隔)、aria2 RPC(域名/端口/路径/token/目录)+「测试连接」。
- **验收**:真机点一遍:列文件 → 勾选 → 下载 → 文件落盘且能在下载面板看到进度、`browser_list_downloads` 能查到。

### S7 注册、文档、回归

- `builtin.ts` 追加 `quark`;`registry.ts` 追加 `quarkUi`。
- 更新 `docs/ARCHITECTURE.md`(§5.8 / §5.9 / §6.2)与 `README.md`(工具表 + 新小节 + 下载插件小节)。
- **验收**:`npm run typecheck`、`npm run test`(全量)、`npm run build` 三者通过;
  `npm run test:mcp` 通过(⚠️ 该冒烟会往**真实** `~/.config/mcp-browser/bookmarks.json` 写一条 `Example`,跑完记得还原为 `[]`,见既有惯例)。

## 6. 测试清单(汇总)

| 文件 | 覆盖 |
| --- | --- |
| `tests/quarkShared.test.ts`(新) | 接口 body/headers 构造、响应解析 4 分支、错误码映射、分批、URL 判定、文件名清洗、aria2 命令行与 RPC body、设置归一 |
| `tests/quarkScript.test.ts`(新) | `EXTRACT_JS` 语法与不变式;`WALK_FN_SRC` 对 4 组假 fiber 的行为;不写页面 |
| `tests/quarkPlugin.test.ts`(新) | manifest / capabilities / IPC 与 MCP 名集合 / 非夸克页报错 |
| `tests/downloadsShared.test.ts`(扩) | `normalizeEnqueueRequest`、`sanitizeHeaders`、`shouldInjectCookie` |
| `tests/downloadsEnqueue.test.ts`(新) | enqueue 接线、应答配对、钩子注入(UA 改写 + 跳转跟随)、Cookie 域名门禁、无白名单不注入 |
| `scripts/e2e-quark-headers.mjs`(新,可选) | 离线 E2E:起本地 HTTPS echo server + 独立 userData 的 Electron,断言「页面发起下载 → 钩子改写 UA → 服务端收到伪装 UA / Referer / Cookie」。S0 的 spike v7/v8/v9 固化成可重跑脚本 |
| `tests/pluginBoundaries.test.ts`(自动) | 新插件目录的 main/ui 边界 |

## 7. 风险、未知与回退

| # | 风险 | 影响 | 处置 |
| --- | --- | --- | --- |
| ~~R1~~ | ~~`net` 钩子看不见下载请求~~ | — | **已实测并已按结论改架构**:`downloadURL` 确实看不见 → 改用页面发起下载(§0.1 / D1b)。钩子对页面发起下载有效已证 |
| **R1b** | 页面发起的下载**必须有活着的夸克标签页**,且 `ctx.pages.execute` 需要该 tabId | 用户关掉标签页后无法下载 | 面板只对「活动标签是夸克页」开放;下载发起前重新校验 `isQuarkHomeUrl`;失败给明确文案。不做「无页面下载」的回退 |
| **R1c** | Chromium 可能限制「无用户手势的连续下载」 | 批量下载时部分被拦 | `executeJavaScript(code, true)` 带 userGesture + 串行 + 300ms 间隔 + 每条等 `onCreated` 应答(拿不到就报该条失败) |
| **R2** | 直链 CDN 的 host 未知(可能不是 `quark.cn`) | Cookie 不注入 → 403 | 面板诊断显示真实域名 + 设置页可加白名单 + 单测锁定「非白名单绝不注入 Cookie」;若确认是固定第三方域,再把它写进默认白名单 |
| **R3** | React 内部结构漂移(类名 hash、fiber 字段名、`props.list` 改名) | 列不出文件 | 多选择器 + `WALK_FN_SRC` 的两种 props 路径 + 诊断区把「命中的选择器 / fiber 键前缀 / 顶层 props 键名」显示出来,便于按实际情况加一条路径;失败文案给出「复制诊断信息」按钮 |
| **R4** | 会话 Cookie 被写进磁盘 | 账号凭据泄露 | 契约里注入表**只在内存**;`DownloadRecord` 不加任何头字段;`quark.json` 只存 UA / 白名单 / RPC 配置 |
| **R5** | Cookie 被注入到第三方 CDN | 同上 | 结构化 `cookie{value,hosts}` + 默认拒绝 + 单测 |
| **R6** | 风控 / 限速(批量取直链) | 接口 403 或账号被限 | 15/批 + 1s 节流 + 串行入队;面板不提供「递归整目录」;失败文案提示降低批量 |
| **R7** | 跨插件事件契约是本仓库**首次**引入 | 架构口味问题 | 契约冻结在 `downloads/shared.ts` 并单测;文档写明「主进程内、仅 downloads 一个消费者」。若不接受,退回 `ask_user_question` 里的**选项 B**(quark 自带 net 钩子 + `downloadURL`,代价是每文件弹保存框) |
| **R8** | 重启 bow 后对「需要请求头」的记录点「重新下载」 | 403 且原因不明 | 注入表丢失时 `retry` 返回明确错误,文案指向「请重新从夸克面板发起」 |
| **R9** | 分页:面板只看到页面已加载的那一页 | 大目录列不全 | 面板顶部说明「列表 = 页面当前已加载的内容」,并给「刷新」(页面自己滚动/加载更多后再刷新) |
| **R10** | 夸克接口变更(UA 版本号、`entry/pr` 参数) | 取不到直链 | UA 与接口地址做成设置项 / 常量集中在一处;失败时把原始响应体打进诊断区 |

## 8. 明确不做(本次范围外)

- 分享页(`/s/xxx`)与「转存到我的网盘」流程(决策 2)。
- 多线程 / 分片下载(LinkSwift 的「增强下载」)—— bow 的下载引擎按 `DownloadItem` 走,不做第二套。
- 递归整目录 / 文件夹下载、断点续传直链缓存、下载直链的本地缓存。
- UC 网盘(接口与 UA 只差一个值,但不在本次需求里;`shared.ts` 的常量结构为它留了位置)。
- 浏览器扩展(`chrome.webRequest`)共存问题 —— 与 `docs/ARCHITECTURE.md` §5.4 记录的既有冲突一致,不在本次解决。

## 9. 后续精简:只留「推送 aria2」(2026-09-24,同日晚)

用户决定**砍掉 bow 下载器接管**,只保留「取直链 → 推送 aria2 RPC」一条出口。§0–§8 保留为设计记录,
实现已按下表收敛(本节之后以代码为准):

| 删除 | 保留 / 替代 |
| --- | --- |
| downloads 插件的**全部**改动:跨插件 enqueue 契约、`net.onBeforeSendHeaders` 请求头注入、`browser_download` 的 `headers` 参数、`tests/downloadsEnqueue.test.ts`(§3 整节作废,已回退到 HEAD) | downloads 插件回到原状;`downloads:enqueue` / `downloads:enqueued` 事件不复存在 |
| quark 的 bow 下载入口:`downloadFiles` / `enqueueDownload` / `buildClickScript`(页面 `<a download>` 点击)/ `QUARK_DOWNLOAD_GAP_MS` | 无 —— 下载由 aria2 自己发,浏览器不需要参与 |
| 复制直链 / 复制 aria2c 命令行(`buildAria2Command` / `shellQuote` 与面板上的两个按钮) | 面板只剩「推送 aria2」 |
| 4 个 MCP 工具(`quark_list_files` / `quark_get_links` / `quark_download` / `quark_push_aria2`) | quark 插件 `capabilities: ['ui']`,**不贡献 MCP 工具**(工具总数回到 44) |
| IPC `getLinks` / `download` | IPC 只剩 `listFiles` / `pushAria2` / `getSettings` / `setSettings` / `testAria2` |

保留的实测结论与边界(仍然有效):

- **`net.fetch` 不能带 `Origin`**(§13 第 33 条)—— 取直链接口照旧不带它,单测 + E2E 都钉住;
- **Cookie 白名单**(§13 第 32 条)—— 意义反而更强:aria2 是独立进程,**拿不到浏览器 cookie 域罐**,
  所以 Cookie 必须显式传,也就必须限定域名(默认 `quark.cn` / `uc.cn`,留空 = 不传);
- **`buildAria2Headers`**(UA + Referer)+ `aria2.addUri` 的 `header` 数组;
- E2E `scripts/e2e-quark-headers.mjs` 改测新链路:假夸克页(真 fiber)→ `listFiles` → 假 `/file/download`
  → 假 aria2 JSON-RPC。插件 IPC 用 `--remote-debugging-port` 在 chrome 页面 target 上调
  `window.browserAPI.plugins.invoke(...)`(与 `e2e-device-inspect.mjs` 读 `getGroups()` 同一手法),
  并断言两端真正收到了什么(含「白名单外的直链绝不带 Cookie」)。
