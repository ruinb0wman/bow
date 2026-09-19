# 广告拦截对外部屏蔽规则的兼容性:现状评估 + 改造计划

> **实施状态(2026-09-16 收尾)**:P0 与 P1 已全部落地并验证,分两个提交:
> - `874e3df feat(adblock): 兼容 EasyList/AdGuard 规则子集(选项语义 / 元素例外 / 订阅)`
> - `2103bc6 perf(adblock): 元素规则建索引 + 单页选择器上限,存储改单行 JSON;修 replace 导入清掉订阅规则`
>
> 覆盖情况:P0 全部 8 项 ✔;P1 全部 7 项 ✔(存储走「至少去掉 pretty-print」这条,规则表未拆文件;
> 元素 CSS 走索引 + 2000 条上限,未做更大规模的分片)。P2(scriptlet / 过程式过滤 / `$removeparam` / `$csp` / `$redirect`)未做。
> 验证:389 单测通过 + 真机 e2e 21 项全绿(含元素隐藏真的生效、订阅替换、replace 不清订阅、hosts 全量拒绝);
> 设置页 UI 仍只做了 typecheck/build + IPC 方法名交叉核对,未真机点击。

## 0. 目标与结论

**问题**:当前项目的广告屏蔽能不能吃下别的工具(AdGuard / uBlock Origin / AdBlock Plus / hosts / Clash 等)的规则?

**结论**:只有「纯域名 / `||host^` / `##selector`」这一小子集能安全导入;
**真正的订阅列表(EasyList / AdGuard/uBO 中文规则)不是"不支持",而是"被降级成更强的规则后误伤"**,
hosts / dnsmasq / Clash 格式则是**导入显示成功但永不生效(静默失效)**。

因此本计划的第一优先级不是"多做功能",而是**修掉会误伤的解析语义**(P0),
在此基础上再做真正的订阅兼容(P1)与 uBO 级能力(P2)。

---

## 1. 现状证据(读过的代码)

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| 规则模型 | `NetworkRule{type:'block'\|'allow', pattern}` + `CosmeticRule{type:'hide'\|'unhide', domain, selector}`,无 options 字段 | `src/shared/adblock.ts` 顶部类型 |
| 网络匹配 | `||host^` 只取主机锚点;通配 `*`/`?` 走 URL glob;其余按 host/子域 | `networkPatternMatches()` |
| 匹配入口 | 每次请求**线性遍历全部网络规则** | `isNetworkBlocked(url, rules)` 里 `for (const r of rules)` |
| 拦截点 | `onBeforeRequest`,但**只挡 resourceType !== 'mainFrame'** | `src/plugins/adblock/main.ts` 的 `ctx.net.onBeforeRequest(...)` |
| 请求上下文 | `onBeforeRequest` 的 `NetContext` **不传 pageUrl**(只有 `onBeforeSendHeaders`/`onHeadersReceived` 调了 `pageUrlOf`) | `src/main/plugins/netHooks.ts` 的 `install()` |
| 元素规则 | 按 host 生成 CSS,`matches:['<all_urls>']`、`runAt:'dom-ready'`,逐 host 缓存(上限 64) | `main.ts` 的 `ctx.content.inject({id:'cosmetic'})` / `cssFor()` / `buildCosmeticCss()` |
| 文本导入 | `parseRuleText()` 支持 `!` 注释、`[..]` 头、`@@`、`##`、`#@#`;`#$#`/`#@$#`/`#?#` 跳过 | `adblock.ts` 第 442–466 行 |
| 选项处理 | `$options` 里**只有** `document`/`main_frame`/`csp`/`rewrite` 会被跳过,其余**被剥离后丢弃** | `stripOptions()` + `hasSkippableOption()`(第 389–404 行) |
| 手动新增规则 | `addNetworkRule()` 直接存原始 pattern,**不做任何校验/解析** | `main.ts` 的 `addNetworkRule` / MCP `adblock_add_rule` |
| 存储 | 单个 JSON、每次改动**同步全量 pretty-print 重写** | `src/main/stores.ts` 的 `save()`(`JSON.stringify(this.data, null, 2)` + tmp rename) |
| 渲染 | IPC 推**全量**规则(`state()` 里 `.map(r=>({...r}))`),设置页 `v-for` 全量渲染无虚拟滚动 | `main.ts` 的 `emitChanged()`;`ui/AdblockSettings.vue` 第 292/352 行 |
| 订阅 | 无 URL 订阅,只有文本框 + 文件导入/导出/复制 | `AdblockSettings.vue` 的 `onImportFile` / `exportFile` |

### 1.1 会误伤的三类真实 bug(这是本次的重点)

1. **`$options` 被丢弃 → 规则变强**
   `hasSkippableOption()` 只认 4 个选项,`$third-party`、`$script`、`$image`、`$domain=`、`$important`、`$popup` 全被剥离,
   剩下 `||x.com^` 就是"整域拦截"。
   当前测试已经把错误行为固化了:`tests/adblock.test.ts` 断言 `tracker.example.com^$third-party`
   导入后存在 `block:tracker.example.com^`。

2. **选项正则漏字符 → 整行降级**
   `stripOptions()` 的判定正则 `^[a-z~][a-z0-9~=_,-]*$` 不含 `.`、`_`、`|`、`(`、`)`,
   于是 `||host^$removeparam=utm_source`、`$redirect=noop.js`、`$domain=a.com|b.com` 判定失败 →
   **整行当模式**;而 `networkPatternMatches()` 的 `||` 分支在第一个 `^` 处截断,只看到主机 →
   **仍然是整域 block**。`$badfilter` 同理会变成一条新 block。

3. **例外语义反转**
   `@@||site.com^$generichide`(只关闭该站泛化元素隐藏)被解析成
   网络 `allow ||site.com^` → **整站放行**;`$elemhide`/`$specifichide` 同理。

附带:
- 元素规则的域排除 `a.com,~sub.a.com##.ad`:`normalizeRuleDomain()` 不认识 `~`,
  生成永不匹配的域(排除失效,反而多隐藏)。
- `#%#`、`##+js(...)`、`:has-text()` 不跳过 → 变成死规则或无效 CSS(静默,不报错)。

### 1.2 非 ABP 格式的表现(导入成功但永不生效)

- `0.0.0.0 ads.example.com` / `127.0.0.1 ads.example.com`(hosts)→ 含空格,`hostMatches()` 永不命中。
- `address=/ads.example.com/0.0.0.0`(dnsmasq)→ 含 `/` 走 URL 通配,实际 URL 里不含该串。
- `DOMAIN-SUFFIX,example.com`(Clash/Surge)→ 当主机名,永不命中。
- `# 注释`(hosts 常用)→ 不是 `!`/`[`,变成死网络规则,还会被计入 `summary.imported`,
  让用户以为"导入成功"。

### 1.3 规模化(订阅级)会撞的墙

上表已列:线性扫描 + 全量 JSON 重写 + 全量 IPC/渲染 + `adblock_list_rules` 无过滤时返回全表。
EasyList 量级(数万条)会同时打爆主进程同步路径与设置页。

---

## 2. 兼容性矩阵(给用户的直接答案)

| 外部规则形态 | 现状 | 目标 |
| --- | --- | --- |
| `example.com` / `*.example.com` / `||host^` / `*` 通配 | ✅ 可用 | 保持 |
| `@@` 纯主机例外(放行优先) | ✅ 可用 | 保持 |
| `##`/`#@#`(含多域 `a.com,b.com##x`) | ✅ 可用 | 保持 |
| `$third-party`/`$script`/`$image`/`$domain=`/`$important`/`$popup` | ❌ 被丢弃并**变强** | P0:跳过并汇总;P1:真正实现 |
| `$removeparam=`/`$redirect=`/`$badfilter` | ❌ 整行降级成**整域 block** | P0:跳过;P2:实现 |
| `@@...$generichide`/`$elemhide`/`$specifichide` | ❌ 反转成**整站放行** | P0:跳过;P1:实现 |
| 元素域排除 `~sub.a.com` | ❌ 静默失效 | P0:整行跳过;P1:实现 excludeDomains |
| `#?#`/`#$#`/`#@$#`/`#%#`/`##+js(...)` scriptlet、过程式过滤 | ⚠️ 前三者跳过,其余静默变死规则/无效 CSS | P0:统一跳过并报数;P2:scriptlet |
| hosts / dnsmasq / Clash 列表 | ❌ 成功导入 + 永不生效 | P0:识别并报"不支持";P1:提供转换器或明确拒绝 |
| URL 订阅(自动更新) | ❌ 无 | P1 |

---

## 3. 实施步骤

> 核心不变式(全程适用):**不认识的语法只能"跳过",绝不能降级成更强的规则**。
> 任何降级都必须走 `summary.skipped` 显式暴露给用户。

### P0 — 止损:解析不再制造误伤(必做,小改动、可独立上线)

1. **统一选项识别**(`src/shared/adblock.ts`)
   - 抽出单一 helper `splitOptions(line)`:以 `lastIndexOf('$')` 切分,右侧**不含空白、不含 `$`、不含 `/`** 即视为选项串
     (替换 `stripOptions` 与 `networkPatternMatches()` 里第 177 行那份重复且同样有漏的正则)。
   - 删除/收窄 `hasSkippableOption()`;改为 `canApplyOptions(options): boolean` 白名单:
     只认当前真正实现了语义的选项(现阶段 **空集**),其余一律返回 false → 由调用方 `skip(line)`。
2. **未知选项 = 跳过而不是剥离**:`parseRuleText()` 里 block/allow 两条分支都改为
   `if (!pattern.trim() || !canApplyOptions(options)) { skip(line); continue }`。
3. **scriptlet / 过程式行统一跳过**:`parseRuleText()` 的跳过判定从
   `line.includes('#$#') || '#@$#' || '#?#'` 扩到 `#%#`、`#@%#`、`#@?#`、以及选择器里含 `+js(`/`:has-text(`/`-abp-` 的行。
4. **否定域先整行跳过**:`cosmeticFromLine()` 里若任一域名段以 `~` 开头 → `skip(line)`(P1 再实现)。
5. **非 ABP 格式识别并报错**:新增 `looksLikeForeignList(line)`(含空白分隔的 IP、`address=/…/`、
   `DOMAIN-SUFFIX,`、`DOMAIN,`、`IP-CIDR,`、`server=/…/`),命中即 `skip` 并在 summary 里单列一类
   `foreign: {count, format?: 'hosts'|'dnsmasq'|'clash'}`;`#` 开头的行也按注释跳过(hosts 文件)。
6. **手动新增路径也要守门**(`src/plugins/adblock/main.ts`)
   - `addNetworkRule()`(IPC 与 MCP `adblock_add_rule` 共用)对 `pattern` 调 `splitOptions`,
     若含选项则**抛错**「该选项暂不支持,请去掉 `$...` 或改用文本导入查看跳过统计」,
     避免用户从设置/MCP 粘贴带 `$` 的规则时被静默弱化。
7. **文案与文档同步**:`README.md:374`、插件 `manifest.description`、
   MCP `adblock_import_rules` 的 description 明确写「支持子集 / 其余跳过」,不再暗示"通用导入"。
8. **测试**(`tests/adblock.test.ts` + 新 fixture `tests/fixtures/easylist-sample.txt`)
   - 修正现有断言:`tracker.example.com^$third-party` 必须**不产生任何规则**。
   - 新增用例:`$domain=`、`$redirect=`、`$removeparam=`、`$badfilter`、`$important`、
     `@@||s^$generichide`、`a.com,~b.a.com##.x`、`0.0.0.0 x.com`、`# c`、`x.com#%#…`、`x.com##+js(aopr)`。
   - 加一条"不变式"用例:对 fixture 逐行统计「明确支持的语法」行数 N,
     assert `imported + skipped.count === 有效行数` 且**生成的 block 规则集合 ⊆ 支持行集合**(不出现任何 `$` 残留)。

   **验证**:`npm test`、`npm run typecheck`。

### P1 — 真兼容:吃下 EasyList / AdGuard 订阅

1. **规则模型 v3**(`src/shared/adblock.ts`):
   `NetworkRule.options?: { thirdParty?: boolean; resourceTypes?: string[]; domains?: {include:string[]; exclude:string[]}; important?: boolean }`;
   `CosmeticRule.excludeDomains?: string[]`;`version: 3` + 迁移(v2 幂等,已有规则 `options` 为空)。
2. **补齐请求上下文**:`src/main/plugins/netHooks.ts` 的 `install()` 里给 `onBeforeRequest` 也传
   `pageUrlOf(details)`(当前只有另外两个阶段传),并把 `ctx.pageUrl` 交给匹配层。
   → `isNetworkBlocked(url, rules, { resourceType, pageUrl, thirdParty })`:
   `$third-party` 用「请求 host 与页面 host 的注册域不同」判定(无 PSL,用后缀近似,写入文档为已知偏差);
   `$domain=` 用 `pageUrl` 的 host 后缀匹配;`resourceTypes` 直接比对 `c.resourceType`。
3. **优先级语义**:`$important` 的 block 无视 allow;`$badfilter` 在导入/保存时**删除**等价规则(而不是新增)。
4. **元素例外**:`generichide`/`elemhide`/`specifichide` 不再落成网络 allow,
   而是编译成 host → 标志(如 `networkRules` 之外的一张 `cosmeticFlags` 表);
   `cssFor(host)` 里据此跳过"无域选择器"(`domain === '*'`)。
5. **性能与规模**
   - `isNetworkBlocked` 换索引:`buildIndex(rules)` → `Map<hostSuffix, Rule[]>` + 少量通配规则列表;
     改动后重建(与现有 `cssCache` 清理同点)。
   - 存储:`src/main/stores.ts` 的 `save()` 去掉 pretty-print;规则表与用户规则/计数**分文件**
     (`adblock-rules.json` vs `adblock.json`),避免每次勾选重写数 MB。
   - IPC/渲染:`emitChanged()` 只推统计;新增 `listRules({kind, keyword, offset, limit})`;
     `AdblockSettings.vue` 列表改分页/虚拟滚动(默认只展示过滤结果前 N 条)。
   - MCP:`adblock_list_rules` 加 `limit`(默认 200)与 `offset`,绝不返回全表。
   - 元素 CSS:按 host 后缀预分组 + 限制单页注入体积,避免"数万泛化选择器 × 每站"。
6. **订阅能力**:`adblock_subscriptions`(URL、启用、上次更新、条数、失败原因),
   主进程拉取 → 复用 `parseRuleText` → 并入;UI 文本规则页加订阅列表与「立即更新」。
7. **文档 + 真机验证**:WSL 用 `MCP_HTTP_PORT=8799` 起独立实例验证,Windows 侧 `npm run test:mcp`。

### P2 — uBO 级能力(可选,成本高)

`##+js(...)`/`#%#` scriptlet(需带参数的安全注入宿主)、`:has-text`/`:matches-css` 过程式过滤、
`$removeparam`(可用 onBeforeRequest 的 `redirectURL`)、`$redirect=+资源包`、`$csp`(`onHeadersReceived` 已能改响应头)、
`$popup`/`$replace` 等。每项独立成计划。

---

## 4. 风险 / 未知

- **第三方判定精度**:Electron 的 `onBeforeRequest` 不提供 initiator/frame URL,
  `pageUrlOf()` 拿的是 webContents 当前 URL;子框架请求与快速连续导航会有漂移 →
  `$third-party`/`$domain=` 只能做近似(需在 README 标注)。
- **iframe 内元素隐藏**仍不支持(README 已注明),EasyList 中大量 `##` 规则在 iframe 内失效。
- **泛化元素规则的真实误伤**只有真机才看得见(需在若干真实站点跑 P1 的元素部分)。
- **P0 会让"能导入的行数"下降**:用户若已导入过带 `$` 的规则,升级后这些规则会变成 skipped
  (而不是继续误伤)。需要迁移说明:已存在的旧规则不自动删除,但在设置页标出"含未支持选项"。
- 未确定:`parseRuleText` 跳过 `~domain` 后是否要在导入汇总里给出"建议改用 `#@#` 例外"的提示(取决于用户偏好)。

## 5. 待你拍板(已定)

- 已确认范围:**P0 + P1**(P2 另议)。
- hosts/Clash 这类非 ABP 格式:**识别并明确拒绝**(在导入汇总里单列 `foreign` 计数与格式)。
