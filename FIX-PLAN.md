# bow MCP 修复计划(可直接执行)

> **执行状态(已回填)**:P0-1 / P0-2 / P1 / P2 均已实现并通过验证。
> 单测 `288 passed`(基线 275 + 13 个新守卫),`npm run typecheck` 通过;
> 其中 12 个新用例在回退源码后确认会失败(即真守卫)。
> 真机端到端验证待补:需要在 **Windows 侧同步 + 重新构建 + 重启常驻浏览器** 后跑 `npm run test:mcp:http`
> (本仓库为 WSL2 开发、代码经 wsync 同步到 `D:\Workspace\browser`,AI 无法代跑 Windows 进程)。
> 附带发现并已修复:PowerShell 下 `MCP_HTTP=1 electron .` 无法执行 → 新增 `scripts/open-bow.mjs`。

> 面向执行者:本计划里的每一处行号、行为与报错文案都是**实测**过的,不是推测。
> 执行前先读「0. 证据」与「6. 陷阱」,它们决定了改动方式与验收写法。

---

## 0. 证据(已复现)

### 缺陷 1:`browser_navigate` / `browser_search` 静默忽略 `tabId`(P0)

现象(真机实测):

```jsonc
// 传一个不存在的 tabId,期望报错,实际却导航了活动标签
browser_navigate { url: "https://example.com", tabId: 999 }
→ { ok: true, url: "https://example.com", tabId: 1, createdTab: false, waited: true,
    loadedUrl: "https://example.com/" }
```

根因两层,缺一不可:

1. `src/main/mcp.ts:133-171` —— 这两个工具的 schema **根本没有 `tabId`**,handler 解构也不含它,
   内部只调 `tabs.openUrl(url)`(作用于**活动**标签,`src/main/tabManager.ts:345`)。
   其余 12 个页面类工具都有 `tabId`。
2. 未知参数被 **zod 静默丢弃**。对照实验(非 strict 的 raw shape):

```jsonc
// 传 url + tabId:999,handler 只收到 url 和默认值,tabId 无声消失
server.tool('lenient', { url: z.string(), waitUntil: z.enum(['load','none']).default('load') }, cb)
→ { ok: true, args: { url: "x", waitUntil: "load" } }   // tabId 不见了,没有任何报错
```

后果:LLM 按其他工具的约定传 `tabId` 时,会**静默导航到错误的标签**,且返回体看起来完全成功。
这比"报错"危险得多——调用方没有任何线索去发现走错了标签。

### 缺陷 2:`browser_press_key` 返回 `ok` 不代表网页已处理按键(P1)

`src/main/actions.ts:200-208` 的 `pressKey()` 连发三个 `sendInputEvent`(keyDown/char/keyUp)后立即返回;
`src/main/mcp.ts:275-302` 也没有任何等待选项。`sendInputEvent` 是把事件投递给渲染进程,**没有完成回调**。

实测现象:DDG 结果页输入新词后按 Enter,立刻读到的 URL/结果都没变;该按键的效果**延迟落地**,
污染了紧随其后的验证步骤。(隔离测试已证明按键本身完全正常:
keydown `trusted: true`、`keyCode: 13`、表单 submit 触发了。所以这不是按键投递的问题,是**时序契约**的问题。)

对照:`browser_click` 已经有 `waitUntil: 'load' | 'none'`(`mcp.ts:232-253`),press_key 缺失,属接口不对称。

---

## 1. 环境与基线

```bash
cd /home/ruinb0w/Workspace/browser
npm test          # 基线:20 个文件 / 275 个用例全绿(约 2.7s)
npm run typecheck # 提交前必须通过
```

git 状态只有若干未跟踪的 dotfile,工作区干净,直接在当前分支改即可。

**已确认的决策**(本计划按此执行,不要再改):

| 议题 | 决定 |
| --- | --- |
| `navigate`/`search` 的 `tabId` | **支持**:传了就就地导航该标签;不传保持现有 `openUrl()` 行为 |
| `press_key` 等待 | **加 `waitUntil`,默认 `'none'`**,与 `click` 对齐 |
| 未知参数 | **全部核心工具严格校验**,未知参数直接报错 |

---

## 2. P0-1:`navigate` / `browser_search` 支持 `tabId`

**改动文件**:`src/main/mcp.ts`

### 2.1 `browser_navigate`(`mcp.ts:133-151`)

schema 增加 `tabId`,handler 增加分支。**指定 `tabId` 时必须走 `tabs.navigate(id, url)`(就地导航),
不能走 `openUrl`**——`openUrl` 永远作用于活动标签。

```ts
server.tool(
  'browser_navigate',
  {
    url: z.string().describe('http(s) 地址'),
    tabId: z.number().optional().describe('目标标签;省略则作用于活动标签'),
    waitUntil: WaitUntilSchema.default('load').describe("'load' 等到页面加载完成(默认);'none' 立即返回"),
    timeoutMs: z.number().int().positive().optional().describe('waitUntil=load 时的超时毫秒数,默认 15000')
  },
  async ({ url, tabId, waitUntil, timeoutMs }) => {
    if (!isHttpUrl(url)) return textContent({ ok: false, error: 'navigate 仅接受 http/https 地址' })
    // 指定 tabId:就地导航该标签(内部页面标签不支持页面操作)
    if (tabId != null) {
      const { view, fail } = target(tabId)
      if (!view) return textContent({ ok: false, error: fail })
      const id = view.info.id
      if (!tabs.navigate(id, url)) {
        return textContent({ ok: false, tabId: id, error: `标签 ${id} 无法导航到该地址` })
      }
      if (waitUntil === 'none') return textContent({ ok: true, url, tabId: id, createdTab: false })
      const res = await loadFor(id, timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS)
      return textContent({ ok: res.ok, url, tabId: id, createdTab: false, ...loadFields(res) })
    }
    // 未指定:沿用统一入口(活动标签可承载则就地导航,是内部页面则另开新标签)
    const activeBefore = tabs.getActiveView()
    const tab = tabs.openUrl(url)
    const createdTab = tab.id !== activeBefore?.info.id
    if (waitUntil === 'none') return textContent({ ok: true, url, tabId: tab.id, createdTab })
    const res = await loadFor(tab.id, timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS)
    return textContent({ ok: res.ok, url, tabId: tab.id, createdTab, ...loadFields(res) })
  }
)
```

### 2.2 `browser_search`(`mcp.ts:152-171`)

同一套改法:`url` 换成 `searchUrl(engineId, query)`,两处分支逻辑完全对称,
指定 `tabId` 时 `createdTab: false`。

### 2.3 测试替身补 `navigate`

`tests/fakeTabs.ts:78-89` 目前只有 `openUrl`,而 `FakeTabs` 的注释写着「只实现 mcp.ts 真正调用到的面」——
现在 mcp.ts 会调 `navigate` 了,必须补上,否则新分支在新测试里直接炸:

```ts
  /** 与真实实现一致:就地导航;跨「内部页面 ↔ 普通网页」边界一律拒绝 */
  navigate(id: number, url: string): boolean {
    const rec = this.recs.get(id)
    if (!rec) return false
    if (rec.internalId) return false
    rec.info.url = url
    rec.view.webContents.url = url
    return true
  }
```

顺手让 `openUrl` 复用它(可选,保持两个假实现行为一致):

```ts
  openUrl(url: string, activate = true): TabInfo {
    const active = this.getActiveView()
    if (active && !active.internalId) {
      this.navigate(active.info.id, url)
      return { ...active.info, active: true }
    }
    return this.create(url, activate)
  }
```

### 2.4 验收

- `browser_navigate { url, tabId: <存在且非内部> }` → `ok:true, tabId:<该标签>, createdTab:false`,且**其它标签 URL 不变**。
- `browser_navigate { url, tabId: 999 }` → `ok:false, error` 含 `标签 999 不存在`(修复前是 `ok:true`)。
- `browser_navigate { url, tabId: <内部页面标签> }` → `ok:false, error` 含 `内部页面`。
- 不传 `tabId` 时行为与现在**逐字节一致**,特别是「活动标签是内部页面 → 另开新标签 + `createdTab:true`」必须保持
  (既有测试 `tests/mcpServer.test.ts:175-182` 守着这条)。

---

## 3. P0-2:核心工具严格校验未知参数

**改动文件**:`src/main/mcp.ts`(18 个核心工具调用点)

### 3.1 加一个 helper

在 `buildBrowserServer` 内、`server` 创建之后定义:

```ts
  /**
   * 注册核心工具。zod 默认静默丢弃未知参数,LLM 传错参数名时得不到任何反馈
   * (曾经导致 navigate 的 tabId 被无声忽略、静默导航到活动标签),这里用 strict() 让它显式报错。
   * 与 registerPluginTools 同理:raw shape → ZodObject 的重载推导无收益,直接放宽类型。
   */
  const tool = (
    name: string,
    shape: z.ZodRawShape,
    handler: (args: any, extra: any) => unknown
  ): RegisteredTool => (server.registerTool as any)(name, { inputSchema: z.object(shape).strict() }, handler)
```

### 3.2 替换 18 个调用点

把 `buildBrowserServer` 里的 `server.tool(` 全部换成 `tool(`(行号:133、152、173、189、204、232、254、275、
303、330、349、356、374、393、398、405、421、429 —— 其中 349、393、398、405、421、429 是单行调用形式,
同样替换)。

**不要动** `registerPluginTools`(`mcp.ts:439` 附近):插件工具走 `kernel.mcp` 的声明快照,不在本次范围。

### 3.3 已实测的行为(照此写断言)

```jsonc
// 未知参数
browser_snapshot { tabId: 1, maxElement: 20 }
→ content[0].text: "MCP error -32602: Input validation error: Invalid arguments for tool
                     browser_snapshot: Unrecognized key(s) in object: 'maxElement'"
   isError: true

// 合法调用 + 默认值仍然生效
→ { ok: true, args: { tabId: 1, maxElements: 200 } }

// 空 shape 工具(browser_list_tabs)的 schema 变化
{"type":"object","properties":{},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}
```

`description` 与 `default` 在 JSON Schema 里**完整保留**(已实测),所以 LLM 看到的参数说明不会退化。

### 3.4 验收

- 每个核心工具传一个不存在的参数名 → `isError: true`,`text` 含 `Unrecognized key`。
- `browser_list_tabs` 用 `arguments: {}` 调用正常(仓库既有的 `call()` helper 默认就是 `{}`,既有测试已覆盖)。
- 后端 `properties` 里各参数的 `description` / `default` 不变。

---

## 4. P1:`browser_press_key` 增加 `waitUntil`

**改动文件**:`src/main/mcp.ts:275-302`

```ts
  server.tool(
    'browser_press_key',
    {
      key: z.string().describe('按键,如 Enter / Tab / Escape / ArrowDown / Ctrl+W / F5;F5 与 Ctrl+R 会等到重新加载完成'),
      tabId: z.number().optional(),
      waitUntil: WaitUntilSchema.default('none').describe(
        "'none' 投递后立即返回(默认);'load' 等到按键引发的跳转加载完成"
      ),
      timeoutMs: z.number().int().positive().optional()
    },
    async ({ key, tabId, waitUntil, timeoutMs }) => {
      // ...F5 / Ctrl+R / Ctrl+W / Ctrl+T 四个特例分支保持原样...
      const res = await pressKey(view.view.webContents, key)
      if (!res.ok) return textContent({ ok: false, tabId: view.info.id, error: res.error })
      if (waitUntil !== 'load') return textContent({ ok: true, pressed: key, tabId: view.info.id })
      const load = await waitForLoad(view.view.webContents, timeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS)
      return textContent({ ok: load.ok, pressed: key, tabId: view.info.id, ...loadFields(load) })
    }
  )
```

要点:

- 复用现成的 `waitForLoad`(`actions.ts:277`),**不要**新写等待逻辑。
  它自带 300ms 宽限期:按键没触发跳转时约 300ms 内返回 `waited: false / ok: true`,不会误报超时。
- `waitUntil` 默认 `'none'`,现有调用方行为不变。
- F5 / Ctrl+R 分支已经有自己的等待,不用改。

### 验收

- `browser_press_key { key: 'Enter', waitUntil: 'load' }` 在会提交表单的页面 → `waited: true` + 新 `loadedUrl`。
- `browser_press_key { key: 'Tab' }`(默认)→ 立即返回,**不带** `waited` 字段(与 `navigate` 的 `waitUntil:'none'` 一致)。
- 既有测试 `tests/mcpServer.test.ts:352-359` 断言 `wc.sentEvents` 长度为 3 —— **不要**新增 `sendInputEvent` 调用。

### 可选实验(默认不做)

若真机回归仍偶发「按键效果延迟落地」,可在 `pressKey()` 里加一次渲染进程往返(`await wc.executeJavaScript('void 0')`)
作为排序兜底。**风险**:`FakeWc.execCount` 会被计入,可能影响既有断言;而且这条路没有硬保证。
只在真机复现时再做,并附上复现记录。

---

## 5. P2:`resolveKey` 拒绝纯修饰键

**改动文件**:`src/main/actions.ts:224`

```ts
  // 纯修饰键(如裸 'Ctrl')会生成空 keyCode 的无效事件,却返回 ok —— 直接判为不支持
  if (!main) return null
```

现状 `return mods.length ? { keyCode: '', modifiers: mods } : null` 会让
`browser_press_key { key: 'Ctrl' }` 返回 `ok: true` 并投递一个 `keyCode: ''` 的事件。
改后返回 `{ ok: false, error: '不支持的按键: Ctrl' }`。已有测试 `mcpServer.test.ts:373-378`(`key: '+'`)不受影响。

---

## 6. 文档同步

| 文件 | 位置 | 改什么 |
| --- | --- | --- |
| `README.md` | 147 行(navigate 行) | 参数表补 `tabId?`;`search` 行同样 |
| `README.md` | 154 行(press_key 行) | 补 `waitUntil?`,注明「返回 `ok` 仅代表按键已投递,需要等跳转时传 `waitUntil:'load'`」 |
| `README.md` | 175-182 行(等待语义段) | 补 press_key 的 `waitUntil`;补一条「核心工具 strict 校验,未知参数直接报错」 |
| `src/main/mcp.ts` | `MCP_INSTRUCTIONS`(63-93 行) | ① 推荐工作流第 4 条(click)旁边补 press_key 的等待语义;② 边界段(90 行附近)说明 `navigate`/`search` 现在接受 `tabId`,省略则作用于活动标签;③ 加一句「未知参数会被拒绝,报错里会列出本工具接受的参数」 |

`MCP_INSTRUCTIONS` 是随 `initialize` 下发给客户端的**行为契约**,优先级高于 README——它是 LLM 唯一必读的那份。

---

## 7. 验证

### 7.1 单元 / 集成(必做)

在 `tests/mcpServer.test.ts` 的现有 `call()` harness 上补:

1. `navigate` 传存在的 `tabId` → 该标签 URL 变化、`createdTab:false`、**其它标签 URL 不变**。
2. `navigate` 传不存在的 `tabId` → `isError`,error 含 `标签 999 不存在`。
3. `navigate` 传内部页面标签的 `tabId` → `isError`,error 含 `内部页面`。
4. `search` 同样三条(至少 1 与 2)。
5. `propsOf('browser_navigate')`(116 行)与 `browser_search` 的断言扩到含 `tabId`。
6. 未知参数:任选一个工具传 `{ maxElement: 20 }` → `isError`,`text` 含 `Unrecognized key`。
7. `press_key { waitUntil: 'load' }` → `waited:true`;默认调用**不带** `waited`。
8. `press_key { key: 'Ctrl' }` → `isError`,error 含 `不支持的按键`。

注意断言写法:strict 校验失败是 **SDK 层**报错,`text` 是 `MCP error -32602: ...` 纯字符串,
不是项目的 `{ok:false,error}` JSON —— `JSON.parse` 会失败,`res.data` 为 `null`。
这类用例断言 `isError` 与 `res.text`;**项目自己返回的错误**仍按老写法断 `res.data.error`。

### 7.2 真机端到端(必做,单测覆盖不到真实渲染)

```bash
npm run build && MCP=stdio electron .   # 或沿用你平时启动 bow 的方式
```

然后按顺序打这几枪(这是缺陷 1 的原始复现路径):

1. `mcp({ connect: "browser" })` 确认 29 个工具在线。
2. 造一个**非活动**标签:`browser_new_tab { url: "https://www.iana.org/", activate: false }` → 记下它的 `tabId`(记为 B)。
3. **核心回归**:`browser_navigate { url: "https://duckduckgo.com/", tabId: B }`
   → 期望 `ok:true, tabId:B, createdTab:false`;`browser_list_tabs` 确认 **B 的 URL 变了、原活动标签没动**。
4. **缺陷 1 的哨兵**:`browser_navigate { url: "https://example.com", tabId: 999 }`
   → 期望 `ok:false / isError`,`error` 含 `标签 999 不存在`。**这一枪在修复前返回 `ok:true`,是最硬的验收点。**
5. **缺陷 2**:在搜索框里 `browser_type` 输入新词,再 `browser_press_key { key: "Enter", waitUntil: "load" }`
   → 期望 `waited:true` 且 `loadedUrl` 是**新查询词**的结果页(修复前这里踩过坑)。
6. **strict**:`browser_snapshot { tabId: B, maxElement: 20 }` → 期望报 `Unrecognized key(s) in object: 'maxElement'`
   并在报错里看到可用参数名。
7. 收尾:`browser_close_tab` 关掉测试标签,把浏览器恢复到测试前状态。

### 7.3 收尾

```bash
npm run typecheck && npm test
```

---

## 8. 踩过的坑(不要重犯)

1. **SDK 校验错误不是项目返回体**。见 7.1 末尾。别写 `expect(res.data.error)`。
2. **`additionalProperties: false` 会出现在所有核心工具的 JSON Schema 里**(含空 shape 工具)。
   已实测客户端不受影响,但如果你在别处断言 schema 字符串,记得更新。
3. **`arguments` 完全省略仍然报 `Required`**。既有测试都传 `{}`,所以不是本次改动引入的回归;
   但别把「省略参数」当成「空参数」去写新测试。
4. **`press_key` 的 `sentEvents` 长度断言 = 3**,别加事件。
5. **`createdTab: true` 那条路径必须活着**(活动标签是内部页面时另开标签),
   `tests/mcpServer.test.ts:175-182` 在守它——加 `tabId` 分支时别把它重构没了。
6. **`FakeTabs` 是"mcp.ts 用到什么就实现什么"**,加了新调用就必须同步补假实现,否则测试红得莫名其妙。
7. **别用 `sleep` 和重复截图去试探按键是否生效**,那是当初误判成 bug 的原因;要等就用 `browser_wait` / `waitUntil`。

## 9. 范围外(本轮不做)

- 插件工具(`adblock_*`、`browser_fullscreen_element` 等)的 strict 校验 —— 它们走 `kernel.mcp` 声明快照,改动面完全不同。
- `pressKey` 的渲染进程往返兜底(见 4 节「可选实验」)。
- `navigate` 接受 `bow://` 内部页面 URL —— `isHttpUrl` 这道闸门是有意为之,不要放开。
- 重写 `openUrl` 的统一入口语义。

## 10. 完成定义(DoD)

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全绿,且新增用例覆盖 7.1 的 8 条
- [ ] 7.2 的 7 步真机验证全部符合预期,尤其是第 4、5 步这两枪
- [ ] README 与 `MCP_INSTRUCTIONS` 与实现一致(参数表不再有真实存在的缺口)
- [ ] 浏览器被恢复到验证前的状态,没留下测试标签

建议提交拆分:`fix(mcp): navigate/search 支持 tabId,修复未知参数被静默丢弃` +
`feat(mcp): press_key 支持 waitUntil,resolveKey 拒绝纯修饰键` + `docs(mcp): 同步参数表与行为契约`。
