# 手机调试看不到 IndexedDB / Local Storage:根因与修复

> 状态:待评审。调研日期 2026-09-18(部分结论来自**用户真机的实时数据**,见 §1.2)。
> 触发问题(用户原话):「手机调试功能看不到 indexeddb 和 localstorage,但是我在 chrome 的 inspect 能访问到数据」

## 0. 结论一句话

**不是 adb / 中继 / 权限的问题,是「前端与设备的 CDP 版本 skew」**:bow 标签页里的 DevTools 前端是
Electron 44 自带的 **Chromium 152** 前端,它从 `Storage.getStorageKey` 取 storage key;而用户的手机
WebView 是 **Chromium 138**,根本没有这个命令(也没有 storage key 可言)→ 前端的 `StorageKeyManager`
永远拿不到 key → Application 面板的 **Local storage / Session storage / IndexedDB 三个节点必然是空的**。
`chrome://inspect` 能看,是因为它用的前端**与设备版本匹配**(设备自己打包/按设备 revision 取)。

顺带确认:插件里**已经有**「设备自带前端」这条策略(`device-bundled`),所以这条链路不需要新造轮子;
缺的是「自动选对」+「设备不带前端时回退」。

> **落地时被真机修正了**(2026-09-18):设备自己的 `/devtools/inspector.html` 实测 **404**(vivo 系统 WebView
> 不打包前端资源),它给的是 appspot 上它自己 revision 的那份 → 落地的是「照搬设备的 `devtoolsFrontendUrl`」,
> 策略名 `device-suggested`。完整修正与真机验证见 §7。

---

## 1. 证据(全部实测/读源码,不是推测)

### 1.1 前端侧:Chromium 152 的前端只会用新命令

Electron 44.3.0 = Chromium 152(`node_modules/electron/dist/electron` 里 UA 字符串为 `Chrome/152.0.7977.78`)。
devtools-frontend 分支 `chromium/7977`(= Chromium 152,bow 实际打包的这一版):

- `front_end/core/sdk/ResourceTreeModel.ts`
  ```ts
  async storageKeyForFrame(frameId): Promise<string|null> {
    if (!this.framesInternal.has(frameId)) return null;
    const response = await this.storageAgent.invoke_getStorageKey({frameId});   // ← 新命令
    ...
  }
  ```
- `front_end/core/sdk/DOMStorageModel.ts`:Local/Session Storage 的条目**只**来自
  `StorageKeyManager.storageKeys()` 的 `STORAGE_KEY_ADDED`(`addStorageKey()` 是唯一入口,没有任何
  「用 securityOrigin 兜底」的分支)。
- `front_end/panels/application/IndexedDBModel.ts`:一切以 **Storage Bucket** 为单位,
  `StorageBucketsModel.addStorageKey()` → `Storage.setStorageBucketTracking({storageKey})` —— **也需要 storage key**。

三个面板同一个上游依赖,所以症状同时出现在 localStorage 与 IndexedDB 上,不是一个巧合。

### 1.2 设备侧:用户手机是 Chromium 138,没有 `Storage.getStorageKey`

用 bow 现成的 MCP 工具实时取证(`device_list_targets`,2026-09-18):

```json
{"serial":"192.168.1.2:35095","model":"V2536A",
 "socket":"webview_devtools_remote_22789",
 "package":"com.ruinb0w.exp1.debug",
 "browser":"Chrome/138.0.7204.179",
 "targets":[{"type":"page","title":"任务+积分工具","url":"http://tauri.localhost/store"}]}
```

即:这是 **exp1(Tauri)的 WebView**,设备 Chromium **138**。

对照 Chromium 源码里的 `content/browser/devtools/protocol/storage_handler.h`
(`Storage::Backend` 的 override 列表):

| Chromium 版本 | `GetStorageKeyForFrame` | `GetStorageKey(std::optional<string> frame_id)` |
| --- | --- | --- |
| 138.0.7204.179(**用户设备**) | ✅ | ❌ 不存在 |
| 140.0.7339.80 | ✅ | ❌ 不存在 |
| 146.0.7680.31 | ✅(pdl 里已标 *Deprecated*) | ✅ 存在 |

pdl 注释原文(146):「Deprecated. Please use Storage.getStorageKey instead.」—— 也就是说这条命令是
**近期才加的实验性命令**,老设备上必然没有。设备端不支持时,前端收到的是协议错误
(`'Storage.getStorageKey' wasn't found`),代码只特判了 `Frame tree node for given frame not found`,
其它错误直接返回 `response.storageKey`(= `undefined`)→ `storageKeys` 为空集合。

### 1.3 为什么 `chrome://inspect` 能看

同一份 Chromium 源码解释了它:

```cc
// content/browser/devtools/devtools_http_handler.cc @138
std::string DevToolsHttpHandler::GetFrontendURLInternal(agent_host, id, host) {
  std::string frontend_url;
  std::string git_revision = embedder_support::GetChromiumGitRevision();
  if (git_revision == kMissingGitRevision && delegate_->HasBundledFrontendResources()) {
    frontend_url = "/devtools/inspector.html";                 // 相对地址 → 由**设备自己**提供前端
  } else {
    frontend_url = "https://chrome-devtools-frontend.appspot.com/serve_rev/<rev>/inspector.html";
  }                                                            // 否则按**设备自己的 revision**取前端
  return StringPrintf("%s?ws=%s%s%s", ...);
}
```

两条分支都是「与设备版本匹配的前端」:前者是设备打包的那份,后者是 appspot 上设备那个 revision 的那份。
Chromium 138 的前端用的是 `invoke_getStorageKeyForFrame`
(devtools-frontend 分支 `chromium/7204`,即 138.0.7204.x),设备支持 → 所以面板有数据。

**结论:chrome://inspect 不是「更有权限」,只是它的前端版本对得上。**

### 1.4 插件里已经有的东西

- `src/plugins/device-inspect/shared.ts:DEVICE_BUNDLED_FRONTEND_ENTRY = 'devtools/inspector.html'` +
  `frontendUrlFor('device-bundled', …)` → `http://127.0.0.1:<中继端口>/devtools/inspector.html?ws=…`
  (注释已经写明「chrome://inspect 用的就是它」)。
- `relay.ts` 会把握手首部的 `Origin` 删掉,所以**设备自带前端这条路本来就通**。
- `/json/version` 的 `browser` 字段已经取到了(`SocketReport.browser`),只是 **UI 里没显示**,
  且**没有参与任何决策**。

---

## 2. 需要改的文件与理由

| 文件 | 现状(实际读到的代码) | 改什么 |
| --- | --- | --- |
| `src/plugins/device-inspect/shared.ts` | `FrontendStrategy = 'electron-bundled' \| 'device-bundled'`;`DEFAULT_STATE.strategy = 'electron-bundled'`;`targetsFromJson()` 用传入的单一 `strategy` 拼 `frontendUrl` | ① 加 `'auto'`;② 加纯函数 `parseBrowserMajor()` / `needsDeviceFrontend()` / `effectiveStrategy()` / `normalizeStrategy()`;③ `SocketReport` 加 `frontendStrategy`(实际生效的那个)供 UI 解释 |
| `src/plugins/device-inspect/targets.ts` | `probeSocket()` 里已经拿到 `/json/version`(含 `browser`),但 `discover(deps, {strategy})` 全局传一个策略;`HttpDeps` 只有 `getJson` | ① `HttpDeps` 加 `getStatus(url)`(只取状态码,不解析 body);② 按**每个套接字**算生效策略(旧设备 + 设备带前端 → `device-bundled`,否则 `electron-bundled`);③ 探测 `/devtools/inspector.html` 是否存在,**按套接字缓存**(挂在转发池的 live 条目上,随套接字生命周期失效) |
| `src/plugins/device-inspect/ui/DeviceInspectPanel.vue` | 设置区两个按钮(设备自带 / bow 自带);目标行只渲染 `type/title/url/device·model·socketLabel`,**不显示 `socket.browser`** | ① 三个按钮(自动(推荐)/设备自带/bow 自带);② 每行显示设备浏览器版本;③ 自动切换时给一行说明(为什么切/为什么回退) |
| `src/plugins/device-inspect/main.ts` | `DEFAULT_STATE = {version: 1, strategy: 'electron-bundled'}`;`getSettings/setSettings` 只认两个值 | ① `version: 2` + v1→`'auto'` 迁移(否则老用户的状态里钉着 `electron-bundled`,自动修复永远不生效);② 设置校验走 `normalizeStrategy()` |
| `tests/deviceInspect.test.ts` | 纯逻辑用例(解析 adb / `/json` / 前端 URL) | 加 `parseBrowserMajor`(Chrome/WebView/垃圾串)、`needsDeviceFrontend`(138→true,146/152→false,unknown→false)、`effectiveStrategy`(显式覆盖优先)、`normalizeStrategy`(旧值/'auto'/垃圾) |
| `tests/deviceInspectTargets.test.ts` | 假 adb + 假 HTTP 跑完整发现流程,夹具 browser 是 `Chrome/120.0.6099.43` | 加两条:设备 138 + 前端 404 → 目标 `frontendUrl` 回退 `devtools://…`;设备 138 + 前端 200 → `http://127.0.0.1:<中继>/devtools/inspector.html?ws=…`;并断言**探测只发生一次**(缓存生效) |
| `README.md` §设备检查 | 「前端来源两种策略(设置里可切)」 | 改成三种 + 写清自动规则与依据(Chromium 138/140 vs 146 的实测边界) |
| `docs/ARCHITECTURE.md` §13 已知坑 | 第 20~25 条是设备检查的坑 | 加一条:前端与设备的 CDP skew(Application 面板空 = storage key 拿不到),以及「版本不匹配时用设备自带前端」这条不变式 |
| `.pi/plans/device-inspect.md` §12 | 记录了 S1/S2/端到端结论 | 追加本次发现(之前只测了 Elements/Console/Network/Sources,**没测 Application**) |

**不动**:`relay.ts`、`cdp.ts`、`@shared/devtools`(URL 拼装仍是唯一来源)、MCP 工具集。

---

## 3. 实施步骤(每步可独立验证)

1. **纯逻辑先行**(`src/plugins/device-inspect/shared.ts` + `tests/deviceInspect.test.ts`)
   - `parseBrowserMajor('Chrome/138.0.7204.179') → 138`、`'WebView/120.0.6099.230' → 120`、其它 → `undefined`
   - `FRONTEND_MIN_BROWSER_MAJOR = 146`,注释写明依据:「140 无、146 有(实测 `storage_handler.h`);
     真实引入点在 141~146 之间,取已验证存在的最小值,偏保守(141~145 的设备只是多用一次设备前端,无副作用)」
   - `effectiveStrategy(requested, {browser, deviceFrontendAvailable})`:
     显式 `electron-bundled`/`device-bundled` → 原样;`auto` → 设备 major < 146 **且**设备带前端 → `device-bundled`,否则 `electron-bundled`;版本解析不出来 → `electron-bundled`。
   - 验证:`npm test`(该文件单跑)全绿。
2. **发现流程**(`targets.ts`)
   - `getStatus(url)` 走中继端口 `GET /devtools/inspector.html`(设备只认 GET;`RequestIsSafeToServe` 要求 Host 是 IP/localhost,我们的 Host 就是 `127.0.0.1:<中继端口>`,✅)。
   - 缓存挂在 `ForwardPool` 的 live 条目上(`releaseAll`/插座失效自然清空),避免 8s 轮询每次都打设备。
   - `probeSocket` 里算出生效策略 → `targetsFromJson(..., {strategy: effective})` + `SocketReport.frontendStrategy`。
   - 验证:`npm run typecheck` + `tests/deviceInspectTargets.test.ts`(含 404 回退与缓存计数)。
3. **状态与 IPC**(`main.ts`)
   - `InspectState.version: 2`;读到 v1(或无 version)时把 `strategy` 归一到 `'auto'` 并写回;`setSettings` 用 `normalizeStrategy()` 兜底。
   - 验证:构造一份 v1 的 `device-inspect.json`,启动插件后设置页显示「自动」;`getSettings` 返回 `auto`。
4. **UI**(`DeviceInspectPanel.vue`)
   - 设置区三个按钮 + 每行显示 `socket.browser`(如 `Chrome/138.0.7204.179`);生效策略 ≠ 设置值时给一行灰字说明。
   - 验证:`npm run build` 后真机看面板文案。
5. **文档**(README / ARCHITECTURE §13 / `.pi/plans/device-inspect.md` §12)。
6. **真机回归**(见 §4):重开 exp1 → 面板 → 「检查」→ Application 面板出现 Local storage / IndexedDB,并与 `chrome://inspect` 逐条比对。
   顺带目视回归 Elements/Console/Network/Sources(换前端后仍要正常)。
   收尾:`npm test` / `npm run typecheck` / `npm run build` / `npm run test:mcp`。

---

## 4. 验证清单(真机)

1. **先验(不改代码就能做)**:面板「设置 → DevTools 前端」切成**设备自带** → 检查同一个目标 →
   Application 面板应出现 Local storage / IndexedDB(这就是本计划的靶心判据)。
   同一条前端里 Console 跑 `localStorage.length` / `await indexedDB.databases()` 能拿到数据,
   证明「数据在页面里、只是前端面板取不到」。
2. 若第 1 步 404(设备没打包前端)→ 记录该事实,回退策略生效,面板给出说明(此时功能上限就是
   「用 chrome://inspect 看存储面板」)。
3. 精确取证(可选,AI 可代跑,需要 WebView 活着):在 bow 标签页打开
   `http://127.0.0.1:<adb forward 端口>/json/protocol`,看 `Storage` 域的命令表里有没有
   `getStorageKey`(138 上应**没有**)。注意该端口每次刷新都会变,别拿旧端口。
4. 改完之后:同一目标、默认「自动」→ 应自动用设备自带前端且 Application 面板有数据;
   换个 Chrome 152 的手机/新设备 → 应继续用 bow 自带前端(版本相同,无需下载数 MB 前端)。
5. 断网/拔线/进程退出:回退与提示仍不出错(转发池的探活重试逻辑不回归)。

---

## 5. 风险与未知

1. **设备是否真的打包了前端资源**(`HasBundledFrontendResources()`):未知。判据就是 §4.1/§4.2。
   若为 false,唯一「版本匹配的前端」是 appspot 上那条 `serve_rev/<设备 revision>`——
   bow 理论上能从 `/json/version` 的 `WebKit-Version` 里抠出 revision 去拉,但那要外网、要处理
   跨源/mixed-content,收益小风险大,**本计划不做**(只记为退路)。
2. **设备前端的加载成本**:经 adb 转发拉数 MB 前端资源,比本地 `devtools://` 慢,所以**只在版本不匹配时**切,
   不做成全局默认。
3. **`FRONTEND_MIN_BROWSER_MAJOR = 146` 是保守值**(真实引入点在 141~146 之间,未逐版核对):
   偏高的代价只是 141~145 的设备多走一次设备前端;偏低才会让老设备继续空面板。
   想要精确值可以把「版本比较」换成「一次性 `GET /json/protocol` 查 `Storage` 命令表」(按套接字缓存),
   代价是每次会话多传约 1MB;本计划先用版本比较,§3.1 的函数签名已经允许以后替换判据。
4. **其它 skew 表现未知**:前端 152 对设备 138,除存储面板外可能还有别的版本敏感 CDP。
   换到设备前端后应目视回归一遍主要面板,并把新发现记进 ARCHITECTURE §13。
5. **顺带发现的小问题(与本次根因无关,单独一条,可选修)**:2026-09-18 连调两次 `device_list_targets`,
   第一次报 `port-unreachable` 并给「需要 WSL2 镜像网络」的提示,但本机 adb 是 **Windows 原生**
   `adb.exe`(`C:\Users\ruin\AppData\Local\Microsoft\WinGet\...\platform-tools\adb.exe`),真实原因是
   WebView 进程/套接字已经消失(第二次调用直接变成 `no-sockets`)。
   建议:`port-unreachable` 的文案只在 adb 命令里含 `wsl` 时才提镜像网络,否则改为
   「套接字可能已失效(应用退到后台/进程退出),刷新重试」;`shared.ts:problemHint` 一处即可。
6. **`Storage.getStorageKey` 的调用点不止存储面板**:前端 152 的 `StorageKeyManager` 是全局的,
   若以后有别的面板依赖 storage key(如 Storage Buckets),同一处修复一并覆盖;反之不需要为它单独做适配。

---

## 6. 明确不做的方案

- **在 `relay.ts` 里把 `Storage.getStorageKey` 翻译成 `Storage.getStorageKeyForFrame`**:
  会让中继从「只改 HTTP 首部、之后纯字节透传」退化成 CDP 感知的 WS 代理(要解帧、要维护 id 映射),
  违背 `relay.ts` 顶部那段设计说明;收益仅一个命令,性价比不划算。
- **在 bow 里内置多版本前端**:打包体积与维护都不可接受。

---

## 7. 实施记录(2026-09-18,已完成 1~6 步)

**重要中途修正**:真机实测把原计划里「用设备自带前端(`device-bundled`,设备自己的 `/devtools/inspector.html`)」
这一条推翻了 —— vivo 系统 WebView 的 `/devtools/inspector.html` 返回 **404**(设备不打包前端资源),
它给的是 `https://chrome-devtools-frontend.appspot.com/serve_rev/<它自己的 revision>/inspector.html`。
所以落地的是「照搬设备的 `devtoolsFrontendUrl`」,策略名改为 `device-suggested`(旧名 `device-bundled` 会被归一)。

| 步骤 | 状态 | 证据 |
| --- | --- | --- |
| 1 纯逻辑 + 单测 | ✅ | `FRONTEND_STORAGE_KEY_MIN_MAJOR` / `parseBrowserMajor` / `needsDeviceFrontend` / `effectiveStrategy` / `frontendNotice` / `normalizeStrategy` / `suggestedFrontendUrl` / `firstSuggestedFrontendUrl` / `isWslAdb`;`tests/deviceInspect.test.ts` 38→49 例 |
| 2 发现流程 | ✅ | `HttpDeps.getStatus` + `ForwardPool.ensureSuggestedFrontend`(按套接字缓存,超时等「没结论」不缓存)+ 按套接字算生效策略;`tests/deviceInspectTargets.test.ts` 19→28 例 |
| 3 状态与 IPC | ✅ | `InspectState.version: 2` + v1→`auto` 迁移(真机实例日志实证:`device-inspect 状态升级到 v2 前端来源= auto`)| 
| 4 UI | ✅ | 三个策略按钮 + 每行显示设备版本 + 生效策略≠设置值时给解释行 |
| 5 内核 API | ✅ | `openDevToolsTab(frontendUrl, …)`:`createInspectorTab` 不再自己拼 `devtools://`(否则永远得不到「设备指定」那份);`will-navigate` 放宽为「`devtools://` 或与入口同源」 |
| 6 探活网络栈 | ✅ | 探活改用 Electron `net`(Chromium 网络栈),与标签页共用代理设置 —— Node `fetch` 不认系统代理,会把 appspot 误判成打不开 |
| 7 真机回归 | ✅ | 见下 |

自动化:`npm test` → 35 文件 / 592 用例全绿;`npm run typecheck`(node + web)干净;`npm run build` 成功。

### 真机验证(2026-09-18,vivo V2536A 系统 WebView `Chrome/138.0.7204.179`,exp1 的 Tauri 页面)

1. **根因直证**(直接对设备发 CDP):`Storage.getStorageKey` → `'Storage.getStorageKey' wasn't found`;
   同时 `Storage.getStorageKeyForFrame` → `http://tauri.localhost/`、`DOMStorage.getDOMStorageItems` →
   `[["i18nextLng","zh-CN"]]`、`IndexedDB.requestDatabaseNames` → `["exp-v7"]`、`Storage.setStorageBucketTracking` 正常且推回 bucket 事件。
2. **设备给的前端**:`/json` 的 `devtoolsFrontendUrl` = appspot `serve_rev/@2d64ccbb…/inspector.html`,
   而设备自己的 `/devtools/inspector.html` = **404**。
3. **机制在 bow 里可用**:在 bow(真实例)里打开那份 appspot 前端(ws 指向中继)→ `document.title` =
   `DevTools - tauri.localhost/`,DOM 树里就是手机页(`<script src="/src/main.tsx">`),Application/Console 面板都在。
4. **新构建端到端**:`device_list_targets` → `browser: Chrome/138.0.7204.179` **`frontendStrategy: device-suggested`**;
   `device_inspect` 开出的标签页 URL = appspot 那份 + `ws=127.0.0.1:<中继>/devtools/page/<id>`。
   对照:代理未生效时探活失败 → 自动回退 `electron-bundled`,且前端 console 直接打出
   `Request Storage.getStorageKey failed` —— 与根因完全一致(同一批 skew 还有 `Autofill.enable` 等)。

> ⚠️ 沙箱限制(与产品代码无关,记下来免得下次又踩):WSL 里的 `adb` 实际连的是 **Windows 的 adb server**,
> Windows 有「保留端口段」(Hyper-V/WSL),WSL 里 `bind(0)` 挑到的端口约 30% 在 Windows 侧绑不上(10048)
> —— 验证时用了一个把 forward 端口钉死 + WSL 本地 TCP 代理的 `adb` 夹具绕开。
> 顺带发现的产品问题:若用户真用 `wsl adb`,同一机制会让他们遇到「端口转发失败」;可选后续:
> 重试几次失败后**改用 `adb forward --list` 里已存在的同套接字转发**(`parseForwardList` 已写好但没有调用方)。

未提交(工作区)。

### 顺带修掉的小问题

`port-unreachable` 的提示原本无条件指向「WSL2 镜像网络」,而本机 adb 是 Windows 原生 `adb.exe`
(真实原因是套接字已失效/WebView 进程退出)。现在文案先给「目标进程已退出,刷新重试」,
只有 adb 命令确实是 `wsl …`(`isWslAdb`)时才追加镜像网络那段。
