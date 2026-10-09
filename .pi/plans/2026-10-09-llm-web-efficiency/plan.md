# 让 LLM 更高效地读写网页：业界调研与 bow 方案

> 调研日期 2026-10-09。**纯调研/设计，不含实现**。所有「bow 现状」结论都对着当前源码核过；
> 所有「业界做法」都附了出处（见 §9）。带 ⚠️ 的是**尚未真机验证**、必须在动手时先验的假设。

## 0. TL;DR

bow 现在给 LLM 的网页接口是**一份平铺的交互元素清单 + 一个万能 eval**。这条路能跑通，
但业界（Playwright MCP、Chrome DevTools MCP、browser-use）已经收敛到**两条分离的通道**：

| 通道 | 解决什么 | 业界代表 | bow 现在有吗 |
| --- | --- | --- | --- |
| **动作面**（action surface）：带稳定句柄的可交互元素树 | 定位、点击、输入 | a11y 树 + `ref` / `uid` / `backend_node_id` | 有雏形（`browser_snapshot`），但句柄不稳定、信息维度少、格式臃肿 |
| **理解面**（comprehension surface）：正文/结构转 markdown 或大纲 | 读内容、总结、取数据 | `readability`/`defuddle`/`trafilatura`/browser-use 的 markdown_extractor | **完全没有**（只能 eval 手写 JS 或截图） |

建议按四步走，每一步都能独立验收：

1. **P0 · 换句柄**：`browser_snapshot` 改成 a11y 树 + 稳定 ref；动作后默认回带新快照（可选关）。
   顺手消灭一类**静默错点**（现在的 `nth-of-type` selector 会指向错元素，见 §2.3）。
2. **P0 · 补阅读面**：新增 `browser_read`（正文 → markdown，可 `selector` 收窄、可截断）。
   这是当前最大的能力空洞。
3. **P1 · 降往返**：`browser_find`（快照里搜，只回匹配子树）、`browser_fill`（批量填表）、
   `browser_wait{text}`、`handle_dialog`、真实输入、返回体分档与截断。
4. **P2 · 可选**：视觉通道（SoM 编号截图）、大产物落盘引用、WebMCP 前瞻。

**先建度量，再改工具**（§7）。Anthropic 那条经验值得照抄：不要只看 token，要看任务成功率——
一个更短的快照如果让模型漏掉元素，那是净亏。

---

## 1. bow 现状：LLM 眼里的世界长什么样

代码位置：`src/main/pageScripts.ts`（注入脚本唯一来源）、`src/main/actions.ts`（注入执行/等待）、
`src/main/mcp.ts`（工具面 + `MCP_INSTRUCTIONS`）。19 个核心工具 + 30 个插件工具。

### 1.1 读

- **`browser_snapshot`**：`document.querySelectorAll` 一个**写死的标签/ARIA 清单**，对每个元素输出
  `{tag, role, id, name, type, label, href, text, selector, visible}` 十个字段，**平铺数组、无层级**，
  默认上限 200。
- **`browser_eval`**：任意 JS，返回最后一个表达式的值。**这是目前唯一的「读完整个页面」手段**——
  要求 LLM 自己现写抽取 JS。
- **`browser_screenshot`**：PNG。视觉理解可行，但图像 token 贵，且「看到了但点不准」。

### 1.2 写

- `browser_click` → 页面里 **合成** `mousedown/mouseup/click` + `el.click()`。
- `browser_type` → 逐字符 `value` setter + `InputEvent`（受控输入框友好，这点做得好）。
- `browser_press_key` → `webContents.sendInputEvent`（真按键，已经是「真实输入」了）。
- `browser_scroll` / `browser_wait`（只支持 selector 与加载）/ `browser_back|forward|reload|stop` / 标签页那组。

### 1.3 实测到的四个浪费（按危害排序）

**① 没有阅读面 → 只能 eval 或截图。** 「读这篇文章讲了什么」这件事没有工具直说。
LLM 要么写一段一次性抽取 JS（每页都重新发明、易踩 CSP/SPA/懒加载的坑），
要么截图（贵、且不能精确取字段）。业界这一层是标配（§3.4）。

**② 快照格式臃肿，且大页上信息严重不足。** 真机实测（300 条搜索结果页，见 §8 实施记录）：

| 口径 | 字节 | 说明 |
| --- | --- | --- |
| bow 快照 `maxElements=200`（真实默认） | 31,256 | **丢掉 716 / 916 个元素** |
| bow 快照 `maxElements=500`（工具上限之外） | 78,579 | 丢 416 个 |
| bow 快照全量 916 元素 | 144,318 | 其中 **39,393 字符全花在 `selector` 字段** |

也就是说：**大页上 bow 既贵又瞎** —— 默认配置下三分之二的元素根本没给模型，而给了的那部分又有一半字节
是重复的 `nth-of-type` 路径。Playwright 用 `- button "提交" [ref=e12]` 一行搞定，还带层级与 accessible name。

⚠️ 早先我按形状建模估过「a11y 渲染比现有快照省 4.68x」，**真机实测证伪了这个说法**：a11y 裸渲染在小页上
（2456 字符）反而比 bow 快照（1853 字符）大，因为 AX 树会重复输出 `StaticText` 与结构容器。
真正的降本手段不是换格式，而是**过滤**（见 §4.1）。

**③ 句柄不稳定 → 静默错点。** `selFor()` 兜底生成 `div:nth-of-type(2)>ul:nth-of-type(1)>li:nth-of-type(7)>a:nth-of-type(1)`。
页面一重排（分页、懒加载、动画插节点），这条选择器仍然能 `querySelector` 到**另一个元素**，
于是点击**成功返回 ok**，打在错的东西上。Playwright 的做法是 ref 显式失效：
`Ref e12 not found in the current page snapshot. Try capturing new snapshot.` ——
**宁可失败，不可静默打偏**。这是正确性问题，不只是成本问题。

**④ 一轮动作 = 两次往返。** `click` 只回 `{ok,tabId,selector,result}`，想知道页面变成什么样必须再调一次
`snapshot`。Playwright 的每个动作**默认回带新快照**。

另外几个小一点的空洞：无 `browser_find`（大页只能整份快照）、无批量填表、
无 `wait{text}`（只能等 selector）、无 `handle_dialog`（弹窗会白烧几轮）、
bow 标签页侧**读不到 console/network**（手机侧 `device_console` 有，标签页侧没有）→ 失败原因不可见。

---

## 2. 业界的五条路线

### 2.1 A · a11y 树 + `ref` 稳定句柄（Playwright MCP / Chrome DevTools MCP）

两家主流 MCP 服务器的核心是同一个设计：**不看像素，看无障碍树**。

Playwright MCP（`microsoft/playwright-mcp`，~21–25 工具）：

```
- heading "todos" [level=1] [ref=e3]
- textbox "What needs to be done?" [ref=e5]
- list [ref=e8]:
  - listitem [ref=e9]:
    - checkbox "Toggle Todo" [ref=e10]
    - text: Buy groceries
```

要点（值得抄的）：

- **ref 是快照内的稳定句柄**，`e12` / 跨 frame 是 `f1e12`；工具参数叫 `target`，**同时接受 ref 或任意 selector**
  （已知元素时可跳过快照往返）。
- **ref 生命周期明确**：页面变化即失效，失效时**报错并提示重新快照**（不静默）。
- **每个动作默认回带新快照**，LLM 永远有最新状态；可用 `--snapshot-mode=none` 全局关掉。
- **`browser_snapshot` 支持 `depth` / `target`（只快照某子树）/ `boxes`（附边界框）/ `filename`（落盘不占上下文）**。
- **`browser_find{text|regex}`**：在当前快照里搜，**只返回匹配节点 + 从根到它的路径 + 少量上下文**
  （gap 用 `...` 标）。官方原话：大页上比整份快照便宜得多。
- **`browser_fill_form`** 一次填多个字段，而不是 N 次 `click`+`type`。
- 官方还有一张「为什么快照优于截图」的表：token 低、精确、快、确定性、不需要视觉模型。
- `--caps=vision` 是可选的坐标操作兜底（canvas 类页面）。

Chrome DevTools MCP（`ChromeDevTools/chrome-devtools-mcp`）几乎同构，差异点：

- 叫 **`uid`**，`take_snapshot` 的描述里直接写死两条纪律：
  *"Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot."*
- **动作工具的 `includeSnapshot` 默认 false**（与 Playwright 相反）——即「回带快照」做成**显式开关**。
  两家分歧本身就是一条经验：**默认值要按你自己的评测定**。
- **`fill_form` 的描述是强制的**：*"ALWAYS prefer this tool over multiple individual fill or click calls
  when interacting with forms. It is significantly faster, more reliable, and reduces turn count."*
- **`wait_for{text[]}`**：等任意一段**文本**出现（bow 只等 selector）。
- 工具面分**导航/输入/调试/性能/网络/内存/PWA/WebMCP** 等命名空间，且提供 **`--slim` 瘦身模式**只留基础浏览器任务。
- 大产物（截图、性能 trace、堆快照）走 **文件路径/资源 URI**，不回原始数据流。
- 遇到 dialog 有 **`handle_dialog`**；读不到原因有 `list_console_messages` / `list_network_requests`。
- 真实输入走 puppeteer（真事件链），不是合成 `dispatchEvent`。

### 2.2 B · 三源合流的「增强 DOM 树」（browser-use）

这是目前**工程上最完整**的一份公开设计（`browser_use/dom/`），值得逐条对照：

- **并行取三份视图**再合并成一棵树 `EnhancedDOMTreeNode`：
  `DOMSnapshot.captureSnapshot`（渲染几何）+ `DOM.getDocument`（结构）+ `Accessibility.getFullAXTree`（语义），
  外加 JS 小探针（iframe 滚动状态、点击监听器探测）。
- **iframe 缝进同一棵树**，跨源 frame 走各自的 CDP target 按需拉取。
- **索引就是 CDP `backend_node_id`**，不是 1..N 计数器。理由是它同时是 selector map 的 key、
  动作层解析回真实节点和坐标的句柄，而且**元素没变就一直是同一个号**（跨步稳定）。
- **变化追踪**：把本步 selector map 和上一步比，标出**新出现的元素**，给模型一个「哪里变了」的提示，
  不用重扫全页。
- **缓存复用与失效**：导航、focus 变化、session 重置、**滚动**都会作废 selector map（因为 map 只覆盖可见元素）。
- **性能护栏**：页面超过 10,000 元素就跳过点击监听器扫描这一遍（太贵）。
- **两条通道分离**：`serializer.py` 给动作面；`markdown_extractor.py` 给**阅读面**（HTML→markdown）。
  还有第三条 `eval_serializer.py` 给评估/裁判场景——**保留更多结构、更少动作线索**，因为那种场景要理解不要点击。
  这句话是整份材料里最有价值的判断之一：**「操作」和「理解」需要不同的序列化**。
- 视觉通道：截图**先去高亮再截**（保证图干净），随后用**同一批 backend_node_id** 在图上叠编号
  ——文字通道和视觉通道指向同一套句柄。这就是 Set-of-Mark 的工程化版本。

### 2.3 C · 自然语言原语（Stagehand）

Browserbase 的 Stagehand 提供三个 AI 原语 + 完整 Playwright API 并存，**由开发者决定每一步用多少 AI**：

| 原语 | 作用 |
| --- | --- |
| `act("click the login button")` | 自然语言执行动作（自愈：站点改版后重解析） |
| `extract("extract the price", zodSchema)` | **带 schema** 抽结构化数据 |
| `observe("find submit buttons")` | 先问「这页有哪些可做的动作」，返回候选 |

关键区别是**页面的理解由 Stagehand 内部的模型完成**，把「哪一坨 DOM 是相关的」压在一次子模型调用里，
驱动 agent 的上下文只留纯结果。代价是多一次 LLM 调用、行为不可完全预测。

对 bow 的启示不是照搬，而是：**「谁来做元素挑选」是一个可选的架构轴**。
pi 本身就是 LLM，bow 走「驱动 agent 自己挑」是对的；但 `find`/`observe` 这类**便宜的预筛**值得抄（§4.3）。

### 2.4 D · 内容抽取成 markdown（阅读面）

这是 bow 完全缺的那一层。业界可选项与取舍：

| 方案 | 形态 | 备注 |
| --- | --- | --- |
| `@mozilla/readability` + `turndown` | 浏览器内 JS | 经典组合，两个依赖 |
| **`defuddle`**（kepano / Obsidian Web Clipper） | TS 库，正文→markdown | 单篇实测 314KB HTML → 16KB markdown（−94.7%）；自带去除评论/侧栏/页眉页脚 |
| `mdream` | 快速 HTML→markdown | 流式，适合大页 |
| `trafilatura`（Python） | 服务端 | 多份基准里 F1/precision 最高（0.937 / 0.978），但**进不了浏览器** |
| Jina Reader / Firecrawl | 服务端 API | 效果稳，但要把页面内容送出本机——对 bow 这种「用户自己登录着的浏览器」不合适 |

**对 bow 的取舍**：抽取必须**在页面里跑**（尊重登录态、不外包数据），所以候选是
readability / defuddle / mdream，或者把一份精简抽取脚本按现有约定写进 `pageScripts.ts`。
后者更 bow：`pageScripts.ts` 的注释明确写了「同一个事实写两遍必然漂移」，且
**同一份脚本必须同时供 `browser_*`（executeJavaScript）与 `device_*`（CDP Runtime.evaluate）用**——
手机页面也要能读正文。所以「加一个大依赖」不是纯粹的依赖问题，而是会不会破坏这条单一来源约定。

⚠️ 抽取质量**必须拿真实中文站点实测**：SPA、懒加载、无限滚动、中文排版、
以及「正文在 iframe 里」的情况，readability 类库都可能抽空或抽半截。

### 2.5 E · 视觉通道（Set-of-Mark）

Set-of-Mark（Yang et al., arXiv 2310.11441）在多模态模型的图上叠编号标记来增强 visual grounding。
browser-use 的改良版更聪明：**截图时先去高亮**，截完再用同一批句柄叠编号。
对 bow 来说是 P2：当 a11y 树表达不了时（canvas、地图、图表、纯图页面）补一刀，
但**不要**当主通道（贵、且要视觉模型）。

---

## 3. 业界共识的设计原则

### 3.1 Chrome DevTools MCP 的 design principles（几乎逐条对得上 bow 的痛点）

- **Token-Optimized**：返回语义摘要。"LCP was 3.2s" 胜过 50k 行 JSON；**大量数据该放文件**。
- **Small, Deterministic Blocks**：给可组合的工具（Click、Screenshot），不给魔法按钮。
- **Self-Healing Errors**：错误里带上下文和修法。
- **Human-Agent Collaboration**：输出既要机器可解析，也要人能读。
- **Progressive Complexity**：默认简单（高层动作），高级参数可选。
- **Reference over Value**：重资产（截图/trace/视频）返回**路径或 URI**，绝不回原始数据流。

### 3.2 Anthropic《Writing effective tools for agents》

- **工具不是越多越好**：与其包 API，不如做**少量针对高价值工作流**的工具；
  能合并的多步操作就合并（`get_customer_context` 而不是三个查询；`search_logs` 而不是 `read_logs`）。
- **命名空间**：前缀/后缀分组能显著影响工具选择准确率（且效果因模型而异，要自己评）。
- **返回高信号上下文**：**别回 `uuid`、`mime_type` 这类低层标识**；
  把任意字母数字 UUID 换成**语义化名字或 0 基序号**能显著降低幻觉（这条直接支持「ref / backend_node_id 优于长 CSS 路径」）。
- 需要同时支持两种粒度时，加 **`response_format: concise | detailed`** 枚举（官方例子里 concise 只花 1/3 token）。
- **分页 / 范围 / 过滤 / 截断 + 合理默认值**；Claude Code 默认把工具响应卡在 25k token。
- **用截断文案和报错文案反向引导 agent**（「请改用小范围多次检索」这类明确指令）。
- 响应格式（XML / JSON / Markdown）对评测表现有影响，**没有万能答案，要按自己的评测选**。
- **一定要有 eval**：测准确率、总耗时、工具调用次数、token 消耗、错误率；
  冗余调用多 → 调分页/上限；参数错误多 → 改描述与示例。

### 3.3 顺带一条安全原则（加阅读面时必须同时考虑）

一旦有了「把网页正文塞进上下文」的工具，就等于把**不可信文本**请进了 agent 的决策回路
（间接提示注入 IDPI，已有野外案例）。最低限度：正文以「不可信数据」包裹返回，
动作面尽量只用结构化字段（role/name）而少用自由文本，并沿用 bow 现有的 agent 窗口隔离。
Anthropic 2026 的报告里 Claude Opus 4.5 在浏览器场景对注入的 ASR 已降到 1%，但**降到 1% 不是 0**。

---

## 4. 落在 bow 上的方案

排序原则：**先补能力空洞，再降往返，最后才谈省钱。**

### 4.0 先说清两边的架构差异（决定了怎么实现，很关键）

bow 的标签页不等于 Playwright 的页面：**bow 的页面可能同时开着你自己的 DevTools**。
这决定了两件事：

1. **a11y 树在「手机侧」比在「bow 标签侧」更容易**：`device-inspect` 本来就握着一条常驻 CDP WebSocket
   （`src/plugins/device-inspect/cdp.ts`，已经在用 `Runtime.evaluate` 和 `Input.*`），
   加 `Accessibility.getFullAXTree` 几乎零成本。
   而 bow 标签侧要用 `wc.debugger` 临时 attach/detach（`actions.ts` 的整页截图已经这么干），
   代价是：**用户开着 DevTools 时会失败**（现有行为是不抢，明确报错）。
2. **真实点击在 bow 标签侧不需要 CDP**：`webContents.sendInputEvent` 是 Electron 自带能力，
   `pressKey` 已经在用。所以「用真事件替代合成 `dispatchEvent`」这条**不引入 DevTools 互斥**。
   ⚠️ 需确认坐标语义（DIP、`devicePixelRatio`、页面缩放、iframe 内 rect 的偏移）。

### 4.1 P0-① 换句柄：`browser_snapshot` → a11y 树 + 稳定 ref

**目标**：让「看到 → 点到」之间不再有一次可能失效的翻译。

- 输出换成 **Playwright 风格的 a11y 文本树**（`- role "name" [state] [ref=eN]`），而不是 10 字段 JSON：
  一行一个元素、天然带层级（`- list:` 下的 `- listitem:`），靠缩进表达归属。
  价值**不是更小**（真机实测小页上反而略大），而是**同样的字节给到更多可用信息**：
  状态（`checked`/`disabled`/`level`）、层级、shadow DOM 内部、表格结构、图片 alt、以及正文文本。
  按「每单位信息」算：a11y 约 30 字符/行，bow 约 157 字符/元素且不含状态与正文。
- **必须做视口/可见性过滤**（实测：文档高 39949px 的页面上，919 个候选元素里**视口内只有 17 个**）。
  这是比格式重要一个数量级的裁剪轴（919 → 17）。browser-use 的「selector map 只覆盖可见元素、
  滚动即作废」就是这么来的。默认只给视口内 + 可见，参数可放宽。
- **会话内自增的 ref**（不必是 backend_node_id，但必须**会话内稳定**，
  页面结构没变时同一个元素给同一个 ref），并把 ref → 元素的绑定**留在主进程的 session map 里**，
  而不是让 LLM 拿着 CSS 路径自己找。
- 动作工具参数从 `selector` 改为 **`target`：接受 ref 或 selector 两者**（已知元素时跳过快照往返）。
- **ref 失效时明确报错**：`Ref e12 not found in the current snapshot; take a new snapshot.`
  —— 直接消灭 §1.3-③ 那类静默错点。
- 保留 `maxElements`，新增 **`depth`** 与 **`target`（只快照某子树）**；
  200 个元素默认值可以保留，但要有截断提示与「下一页怎么看」的引导文案。
- ⚠️ **先验**：Electron `wc.debugger` 下 `Accessibility.getFullAXTree` 的完整度（表格、ARIA、中文、
  Electron 是否需要在 `attach` 前 en**able AX mode**）。
  **兜底方案**：纯 JS 近似（`aria-query` + `dom-accessibility-api` 的 accessible name 计算思路），
  写进 `pageScripts.ts`，好处是 browser 侧与 device 侧天然共用同一份。
- **顺手修一个既有缺陷**：现在 `SNAPSHOT_FN` 用**写死的标签/role 清单**挑元素，
  会漏 `div[onclick]` / `[tabindex]` / 自定义元素，也会收进不可见的垃圾。
  业界做法是**点击性探测**（cursor/监听器/tabindex/role 综合判断）——这条独立于 a11y 树，价值单独成立。

### 4.2 P0-② 补阅读面：新增 `browser_read`

**这是当前最大的空洞**：没有它，「读这篇文章」这件事只能靠 eval 现写 JS 或截图。

- 输出**markdown**（标题层级 + 正文 + 链接），默认做正文抽取（剥离导航/侧栏/页脚/评论）。
- 参数（学 Playwright/Chrome DevTools 的克制风格，少而正交）：
  - `selector?`：只读某个子树（对已定位的卡片/表格特别省）。
  - `maxChars?` + **截断标记 + 续读提示**（Anthropic 那条「用截断文案引导 agent」）。
  - `format?: 'markdown' | 'text'`（正文 vs 纯文本）。
- 返回体里明确**包裹成不可信内容**（§3.3）。
- 与 `browser_snapshot` 的分工要写进 `MCP_INSTRUCTIONS`（bow 的工具契约都在那儿）：
  **读内容 → `read`；找可点的东西 → `snapshot`；判断样式/布局 → `screenshot`**。
  现在的 instructions 已经这么分行写了，加一行即可。
- ⚠️ 抽取脚本**必须同时供 device 侧使用**（`pageScripts.ts` 单一来源约定），
  且要拿真实中文站点（含 SPA / 懒加载 / 长文）实测抽取率。

### 4.3 P1-③ 降往返与降噪

| 动作 | 学自 | 收益 |
| --- | --- | --- |
| 动作后**可选回带新快照**（`includeSnapshot?`，默认按 §7 的评测定） | Playwright（默认开）/ Chrome DevTools（默认关） | 一轮动作省一次往返 |
| 快照**差分**：标出「自上次以来新增/变化」的元素 | browser-use | 大页上把「哪里变了」直接给出来 |
| 新增 **`browser_find{text\|regex}`**：在当前快照里搜，只回匹配子树 + 从根的路径 + `...` 省略 | Playwright `browser_find` | 大页上比整份快照便宜得多 |
| 新增 **`browser_fill{fields[]}`**：一次填多个字段/下拉/勾选 | 两家都有 `fill_form` | 减少 turn 数，官方原话「更可靠」 |
| `browser_wait` 支持 **`text`** | Chrome DevTools `wait_for` | SPA 等文案出现，比猜 selector 稳 |
| 新增 **`browser_dialog{action}`** | 两家都有 | 弹窗不再白烧几轮 |
| bow 标签侧也能读 **console / network** | Chrome DevTools | 失败原因可见（手机侧已有 `device_console`） |
| **真实输入**：`click` 改用 `sendInputEvent` 坐标点击（或在 CDP 可用时用 `Input.dispatchMouseEvent`） | puppeteer / device_tap 已是这条路 | 治「合成事件点不动」的一类站点（原生控件、需要 trusted 事件的） |
| 返回体**分档**：`response_format: concise \| detailed` | Anthropic | 需要 ID 时才要详细档 |
| **大产物落盘**：`snapshot`/`screenshot` 支持 `filename`，或超阈值自动落盘回路径 | Chrome DevTools「Reference over Value」+ Playwright `filename` | 大页快照/整页截图不占上下文 |
| **截断与引导文案**：所有可能很大的返回都带 `truncated` + 明确「怎么拿全」 | Anthropic | 引导 agent 用分页/收窄而不是硬啃 |

**注意别过度合并**：Chrome DevTools 的 design principles 说的是「小而定死的积木」，
不是把 20 个工具塞进一个。合并只用在**高频且天然连在一起**的多步操作上（填表、点+等）。

### 4.4 P2 · 可选

- **视觉通道**：`browser_screenshot` 加 `annotate: true`（SoM 编号，编号与快照 ref 同一套句柄），
  只作为 canvas/图表/地图类页面的兜底。⚠️ 注意与现有整页截图共用调试器，别互相抢。
- **`browser_act{instruction}`**（Stagehand 式内部小模型）——可选，不是必须。
  pi 本身就是 LLM，多一层子模型会牺牲可预测性；只有当「元素挑选」在实测里成为主要失败原因时才值得。
- **WebMCP 前瞻**：Chrome 在推「站点主动向 agent 暴露工具」的协议，
  `chrome-devtools-mcp` 已经有 `list_webmcp_tools` / `execute_webmcp_tool`。
  bow 可以留一个「页面声明了 WebMCP 工具就直接用，不再猜 DOM」的口子——这是长期最省 token 的路，但现在还太早。

---

## 5. 与现有架构的接缝（改哪里、必须同步什么）

| 位置 | 改什么 |
| --- | --- |
| `src/main/pageScripts.ts` | 新的正文抽取脚本、a11y 近似实现（若走兜底）、点击性探测。**browser 与 device 共用这一份** |
| `src/main/actions.ts` | `pageSnapshot` 换成 a11y 路径；新增 `pageRead` / `pageFind`；`pageClick` 改真实输入；续用现有 `waitForLoad` 三模式与 `lift()` 约定 |
| `src/main/mcp.ts` | 工具面增删；**`CORE_MCP_TOOL_NAMES` 要同步**（内核拿它做插件重名校验）；**`MCP_INSTRUCTIONS` 必须同步**（它是 LLM 唯一必读的行为契约）；`tool()` 的 `strict()` 与 `mcpActivity.wrapTool` 保持 |
| `src/main/tabTarget.ts` | 不用改，但新工具必须走同一套 `target(tabId?)` 语义（省略 tabId 绝不落在用户窗口） |
| `src/plugins/device-inspect/cdp.ts` | 走 a11y 时加 `Accessibility.*`；它已有常驻 CDP 会话与 `Input.*`，是最省事的一侧 |
| `docs/ARCHITECTURE.md` | §6.2 核心工具表（现在写的是 19 个）、§6.4 等待语义、§13 已知坑（新增「快照句柄与 DevTools 互斥」之类） |
| `README.md` | 工具清单与计数（历史上已经漂移过，见 §12 文档漂移审计） |
| `tests/` | 现有 1352 用例里 `mcpServer.test.ts` / `mcpWait.test.ts` 会被改动波及；**新增 §8 的实时评测脚本**（放 `scripts/`，用隔离 `--user-data-dir`，见 §13-37） |

**架构红线（不要碰）**：插件拿不到 `webContents`（§13-36）。新的「跨域/复杂页面读取」如果必须用 CDP，
仍然要按 `pageUpload.ts` 的先例走「**核心出窄能力、插件只做决策**」，**不要**给插件开 `sendCommand`。
好消息是 P0/P1 的这些工具**全部属于核心工具面**，压根不需要碰插件契约。

---

## 6. 坑与风险

1. **CDP attach 与 DevTools 互斥**：bow 标签侧每次 attach/detach 都要么抢要么放弃；
   现有约定是「不去抢，明确报错」。a11y 路径要沿用这条，并在失败文案里说清「关掉 DevTools 再试」。
   **这是选「纯 JS 近似 a11y」而不是「CDP AX 树」的主要理由。**
2. **ref 生命周期**：导航、重排、滚动都可能作废。必须显式失效 + 明确报错，
   并**不要**在作废时回落到「按老路径再找一次」——那正是静默错点的来源。
3. **iframe / shadow DOM**：查询只覆盖主文档，这是**现已存在**的限制（README 已记 iframe file input 的限制）。
   a11y 树天然能穿 shadow DOM 与 iframe，是换路径的额外收益，但要逐项验证。
4. **⚠️ AX 树在 Electron 的可得性与成本**：未验证。大页 `getFullAXTree` 可能又大又慢
   （browser-use 在万级元素时主动跳过更贵的那一遍扫描）。需要设上限 + 降级。
5. **⚠️ 抽取质量**：中文站点、SPA、懒加载、无限滚动、正文在 iframe 里。务必真实页面测，
   并把「抽不到」明确报出来（而不是返回空 markdown 让模型以为页面是空的）。
6. **⚠️ 坐标点击**：DIP / `devicePixelRatio` / 页面缩放 / iframe 内 rect 偏移。
   device 侧已有「点击后读一个计数器确认」的纪律（见 `MCP_INSTRUCTIONS`），bow 侧也照做。
7. **prompt injection**：见 §3.3。加阅读面 = 加注入面，别在同一版里顺手关掉已有的隔离。
8. **不要为了短而短**：截断/深度限制/只回交互元素，都可能让模型**漏掉关键信息**，
   表现为「反复乱试」——那种情况下的 token 是省了，任务成功率塌了。

---

## 7. 怎么量化（先做这个，再改工具）

没有度量就没法判断哪一版更好。建议一个小评测台：

- **任务集**：10–20 条真实任务，覆盖不同站点类型（静态长文 / 重 SPA / 表单 / 列表分页 / 需要登录）。
  任务要「需要多次工具调用」，避免玩具题（Anthropic 明确建议别用过于简单的沙箱环境）。
- **指标**：任务成功率、**每任务工具调用数**、**每任务 token**（把每次工具返回的字符数按字符数/3.5 粗估，
  或接真 tokenizer）、错误率、耗时。
  另记「工具选择是否合理」（用于发现冗余工作流 → 该合并哪些工具）。
- **口径**：隔离实例 `--user-data-dir=$TMP/...`（只设 `BOW_USER_DATA_DIR` 不隔离单实例锁，§13-37），
  MCP 走已有的 HTTP 模式或 `InMemoryTransport`（`startMcpServer` 支持注入传输，测试无需真实显示环境）。
  可复用「真机验证手法」那次留下的套路（CDP 直连 + `browserAPI.plugins.invoke` 走真 IPC 链路）。
- **基线**：先把当前版本跑一遍存下来。否则「优化了多少」永远是嘴说的。
- **验收**：成功率不降的前提下，比较 token 与调用数；A/B 换默认值（`includeSnapshot` 默认开还是关、
  快照默认深度、`maxElements`）——**这两家的默认值互相矛盾，说明只能靠自己的评测定**。

---

## 8. 实施记录

### 2026-10-09 步骤 0：真机验证 a11y 树（探针 `/tmp/bow-a11y/probe{,2,3}.mjs`，按仓库惯例**未入库**）

环境：headless Electron（`--ozone-platform=headless`）+ 隔离 `--user-data-dir`，
CDP（`--remote-debugging-port`）与主进程 Node inspector（`--inspect`）双通道驱动。
Fixture：`fixture.html`（小页，含 shadow DOM / iframe / 表格 / 表单状态 / 非清单元素）、
`fixture-large.html`（300 条搜索结果，文档高 39949px）。

**结论：P0-① 走 `wc.debugger` 可行；但首要工作是过滤，不是换格式。**

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | `wc.debugger.attach('1.3')` + `Accessibility.getFullAXTree` | ✅ 可用。fixture 137 节点 / **8ms** / 60KB raw |
| 2 | a11y 树补上清单式 `querySelectorAll` **漏掉的一切** | ✅ shadow DOM 内的按钮与输入框、`div[onclick]`、`[tabindex]`、表格结构（`columnheader`/`cell`）、`img alt`、`checked=true`/`disabled`/`level=2`、正文文本 —— 而 bow 现快照在这 9 项里只拿到 1 项 |
| 3 | iframe 内容 | ❌ **a11y 树不含**（只有一个 `Iframe` 占位节点）。要 `Page.getFrameTree` 遍历 → 每个 `frameId` 单独 `getFullAXTree({frameId})`。实测 `about:srcdoc` 子 frame 独立取到 15 节点，含其按钮 |
| 4 | 调试器互斥的确切形为 | ⚠️ 第二次 `attach` 抛 **`Debugger is already attached to the target`** → 必须捕获并给「关掉 DevTools 再试」的可读文案 |
| 5 | 大页代价 | ⚠️ `getFullAXTree` 6676 节点 = **2.53MB raw / 263ms**；`DOMSnapshot.captureSnapshot` 5158 layout 条目 / 595KB / 93ms。而**视口内**只有 **41**（DOMSnapshot 口径）/ **17**（选择器口径）个 → **过滤掉 ~99.7%** |
| 6 | ref → 真实坐标 | ✅ 6676 个 AX 节点里 **4258 个带 `backendDOMNodeId`**；`DOM.getBoxModel({backendNodeId})` 直接返回 border quad（实测取到「加购物车」按钮的 8 个坐标） |
| 7 | `Accessibility.queryAXTree` 能不能全局按名字搜 | ❌ 必须传 `nodeId`/`backendNodeId`/`objectId`，省略即报错 → **`browser_find` 要在已渲染的快照文本上做搜索**（Playwright 正是这么做的），不要问浏览器 |
| 8 | `getPartialAXTree({nodeId, fetchRelatives:false})` | 只回 1 个节点 → 取子树要么 `fetchRelatives:true`，要么在已拉的树里裁 |

**对设计的三条修正**（已回写进 §4.1）：

1. **视口/可见性过滤是第一优先级**（919 → 17，比「换格式 + 去重 + 丢容器」加起来的收益大一个数量级）。
   格式去重那一档实测只从 86 行降到 53 行（小页）。
2. **`wc.debugger` 必须做生命周期管理**：attach 前查 `isAttached()`、用完 detach、
   捕获 `already attached` 并降级到可读错误（不要静默失败、也不要抢用户已经打开的 DevTools）。
3. **`browser_find` 是纯文本搜索**，不需 CDP；`browser_read` 只需一个可注入的抽取脚本。
   两者都比 P0-① 的 CDP 改造独立，**建议把 P0-② 提到 P0-① 前面先做**（不破坏任何现有行为，可独立验收）。

### 2026-10-09 步骤 1：P0-② 落地 —— `browser_read` 已实现并真机验证

**改了什么**（`git diff --stat` 见提交记录；13 个文件改动 + 2 个新文件）：

| 位置 | 内容 |
| --- | --- |
| `src/main/pageScripts.ts` | 新增 `READ_FN`（~200 行注入脚本）：段落打分定位正文 → markdown 序列化 → 截断。**零依赖**，与手机侧共用同一份 |
| `src/main/actions.ts` | `pageRead(wc, {selector, maxChars})`，过 `lift()` 把 `result.error` 提升为顶层失败 |
| `src/shared/types.ts` | `PageRead`（含 `mode: selector \| main \| wide`） |
| `src/main/mcp.ts` | 工具 `browser_read` + `CORE_MCP_TOOL_NAMES` + `MCP_INSTRUCTIONS` 新增一段「读取页面正文」 |
| `tests/pageRead.test.ts` | **新增 20 条 jsdom 单测**（启发式必须拿真 HTML 测；jsdom 因此进 devDependencies） |
| `tests/fakeWc.ts` | 补最小 DOM 面（`body`/`children`/`matches`/`querySelectorAll`），让 MCP 层测试能跑真注入脚本 |
| `tests/mcpServer.test.ts` | +3 条：返回值形状、失败提升到 isError、strict schema 拒绝未知参数 |
| `scripts/mcp-smoke.mjs` | +3 条端到端断言（非空 markdown / 比原始 HTML 小 / 截断提示 / 未知 selector 报错） |
| README / ARCHITECTURE / SKILL.md / install-pi-mcp.mjs | 工具计数 19→20、49→50；`browser_read` 进 `directTools` 与工具选型表 |

**真机实测结果**（真 Chromium 的 `innerText`，不是 jsdom；8 个真实站点采样，`/tmp/bow-a11y/sample-real.mjs`）：

| 站点 | mode | read | 原始 HTML | 占原始 |
| --- | --- | --- | --- | --- |
| MDN 文档 | main | 1,426 | 67,786 | 2.1% |
| nodejs.org/api/fs | main | 100,001(截断) | 1,158,790 | 8.6% |
| 维基条目（中） | main | 3,760 | 360,232 | **1.0%** |
| 维基条目（en） | main | 21,709 | 294,879 | 7.4% |
| GitHub 仓库页 | main | 57,203 | 675,826 | 8.5% |
| 中文博客 | main | 11,056 | 75,807 | 14.6% |
| example.com | wide | 917 | 1,974 | — |
| BBC 新闻首页 | main | 278 | 337,440 | 0.1% |

**正文质量**：维基条目抽到的是条目本身(开头是定义段、结尾是参考文献),站点顶栏/侧栏/姊妹计划都没进来。

**实现期踩到/改掉的三个坑**(都有回归用例钉住):

1. **宽限降级阈值拍错了** —— 最初用「md < 200 字符」当绝对阈值,短文章直接翻车(把正文换成整页)。
   改成两道门:绝对量小 + 与整页差 3 倍以上。
2. **降级路径曾经退化成裸 `textContent` 倾倒** —— jsdom 里连 `<script>` 内容都进了输出。改成**用同一套 block-aware 遍历重走 body**。
3. **整页放宽会倒出导航** —— BBC 首页实测「可见文字 99% 都在 `<a>` 里」(用 `diag-noise.mjs` 探的祖先链:
   整页是一个 `div#__next`,148 个链接)。现在 wide 退路会跳过「链接农场」块;若跳过之后一无所有,
   就**明确报错并指向该用的工具**(而不是返回空 markdown 或 10k 字符的导航)。注意这条**只用在 wide 退路上** ——
   正文容器内的「参考资料」类链接列表是有效信息,不能一并剪掉。

**未做的**:`device_read`(脚本已在 `pageScripts.ts` 里,与手机侧共用,加工具是后续的事);
大页的 `browser_read` 仍然是全量抽取后再截断(34988 → 12000),没做「只抽视口附近」——
那属于 P0-① 视口过滤的一部分。

### 2026-10-09 步骤 2:P0-① 落地 —— 无障碍树快照 + ref 句柄

**改动**（+4 新文件、~10 改动）:

| 位置 | 内容 |
| --- | --- |
| `src/main/axTree.ts`(新) | **纯变换**:AX 节点数组 → 文本树 + ref 表。不碰 CDP ⇒ 可用伪造节点数组真测 |
| `src/main/axSnapshot.ts`(新) | CDP 驱动:`Page.getFrameTree` 逐 frame 取树、会话级 ref 表、文档身份校验、target 收窄 |
| `src/main/debuggerSession.ts`(新) | 「临时借用调试器」的**唯一**实现：只 detach 自己附加的那次;不去抢 DevTools |
| `src/main/pageScripts.ts` | CLICK/TYPE 拆成「元素版 + 选择器版」(两条路共用一份实现);删掉重复的 `el.click()` |
| `src/main/actions.ts` | `pageClickRef` / `pageTypeRef`;整页截图改走 `withDebugger` |
| `src/main/mcp.ts` | `browser_snapshot {format, target}`, `browser_click` / `browser_type {target}` |
| 测试 | `tests/axTree.test.ts`(17 条纯单测)+ `mcpServer.test.ts` +15 条(全走真 MCP 链路)+ `fakeWc` 补 AX 面 |
| `scripts/mcp-smoke.mjs` | +2 段真机断言(无障碍树 + 按 ref 点击 + `format:dom` 退路) |

**真机实测**(真 Chromium,同一页同一个 `maxElements`):

| | 旧 `format:dom` | 新 `format:ax` |
| --- | --- | --- |
| 大页(300 条结果)每元素字符 | 156 | **50** |
| 同上限下总字符 | 31,258 | **9,964(3.1x 更小)** |
| 小页(同 200 上限) | 14 元素 / 1,855 字符 | **51 元素** / 1,874 字符 ⇒ 每元素 132 → 37 字符 |
| shadow DOM 内部元素/文本 | ✗ | ✓ |
| iframe 内容 | ✗(只有占位) | ✓(2 frames 缝进来) |
| `checked`/`disabled`/`level`/`img alt`/表格结构 | ✗ | ✓ |

按 ref 操作已真机验过:注入一个自增计数器的按钮 → `snapshot` 拿 ref → `browser_click {target}`
→ 计数器 = 1;输入框按 ref 写值后真落到 `input.value`;重新加载后旧 ref **明确报错**
(文案:`页面在这期间重新加载了,e23 已失效…`),`target` 收窄 51 → 16 个元素。

**★ 顺带抓出一个既存 bug:`browser_click` 会点两下。**
旧 `CLICK_FN` 既 `dispatchEvent(new MouseEvent('click'))` 又补一次 `el.click()` ——
在按钮/链接上等于触发两次默认行为(真实表现:自增两次、表单提交两次)。
之前从未暴露,是这次给 fixture 加了点击计数器才现形。已删掉重复那次,
并在 `scripts/mcp-smoke.mjs` 里加了「按 ref 点击只能让计数器 +1」的真机断言钉住。

**其它两个“只差一点就写错”的实测坑**:

1. **Chromium 的三态属性值是字符串 `'true'`**,不是布尔。渲染器一开始只认布尔,
   结果勾选态被整个吐掉(真机才看得出来,伪造数据里很容易写成布尔)。
2. **`backendNodeId` 跨 attach/detach 稳定**(单独探针 `probe-backend.mjs` 验过:`resolveNode` /
   `callFunctionOn` / `getBoxModel` 都行,跨会话点击真的命中)—— 这是 ref 设计成立的前提。
   但**同 URL 原地重载后不稳定**:所以加了 `loaderId` 比对(只比地址不够)。

**关于视口过滤:本次故意没做。** 实测的真相是「大页上 919 个候选里视口内只有 17 个」,
但 bow 的快照本来就有 `maxElements` 上限——真正的浪费是**每元素 156 字符的格式**,
不是没过滤。换成无障碍树后每元素 50 字符,同样上限下已经 3.1x 更小,
而视口过滤会带来新摩擦(模型要操作视口外的元素时必须先猜到自己得传参)。
如果后续还有 token 压力,再加成**可选**的 `scope: "viewport"`。

**P0-① 未做的（下一步候选,按性价比排序）**:
- `browser_find`(在已渲染的快照文本上搜,只回匹配子树)—— 纯文本搜索,不需 CDP,便宜;
- 动作后**可选回带新快照**( `includeSnapshot`),省一轮往返;
- 快照**差分**(标出「自上次以来新增/变更」的元素, 学 browser-use);
- `browser_fill`(批量填表)、`browser_dialog`、标签侧 console/network 可见性;
- 真实输入事件(`Input.dispatchMouseEvent` / `sendInputEvent`)代替合成事件 —— 需先验坐标空间(dpr/缩放/iframe);
- **跨源 iframe(OOPIF)**:目前逐 frame 取不到就跳过并记日志,ref 也解析不到;
- 快照的 `maxDepth`(Playwright 有,bow 暂未做)。

---

## 9. 参考

**主流浏览器 MCP 实现**
- Playwright MCP 快照与 `ref` 机制 — https://playwright.dev/mcp/snapshots
- Playwright MCP 工具与交互 — https://playwright.dev/mcp/tools/interaction ・ https://playwright.dev/mcp/introduction
- `microsoft/playwright-mcp` — https://github.com/microsoft/Playwright-MCP
- Chrome DevTools MCP 工具参考（`take_snapshot`/`click`/`fill_form`/`wait_for`/`includeSnapshot`）— https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md
- Chrome DevTools MCP design principles（Token-Optimized / Progressive Complexity / Reference over Value）— 同仓库 `docs/design-principles.md`
- Playwright aria snapshot 格式规范 — https://github.com/microsoft/playwright/blob/main/docs/src/aria-snapshots.md

**Agent 侧的 DOM 表示**
- browser-use：The Agent Sees the Page（三源合流、backend_node_id 句柄、变化追踪、缓存失效、markdown 通道）
  — https://doc.holiday/library/browser-use/how-the-agent-sees-the-page/
- Stagehand 的 `act` / `extract` / `observe` — https://docs.stagehand.dev/v4/first-steps/introduction
- Set-of-Mark Prompting — https://arxiv.org/abs/2310.11441 ・ https://github.com/microsoft/SoM

**内容抽取**
- defuddle（Obsidian Web Clipper，正文→markdown）— https://github.com/kepano/defuddle
- trafilatura 基准与评测 — https://trafilatura.readthedocs.io/en/latest/evaluation.html
- 抽取库横向基准（Readability vs Trafilatura）— https://www.bulkmd.app/blog/readability-vs-trafilatura-extractors
- 文章抽取基准集 — https://github.com/scrapinghub/article-extraction-benchmark

**工具设计方法论**
- Anthropic《Writing effective tools for agents》— https://www.anthropic.com/engineering/writing-tools-for-agents
- MCP 工具注解（只读/破坏性披露）— https://modelcontextprotocol.io/specification/2025-06-18/server/tools

**安全**
- Anthropic：缓解浏览器场景的 prompt injection — https://www.anthropic.com/research/prompt-injection-defenses
- 野外 IDPI 案例 — https://unit42.paloaltonetworks.com/ai-agent-prompt-injection/

**前瞻**
- WebMCP（站点向 agent 暴露工具）— https://developer.chrome.com/docs/ai/webmcp

> 第三方数字声明（如「Playwright MCP ~13.7k vs Chrome DevTools MCP ~18k token 的工具面开销」）
> 来自博客基准，**未独立复现**，只当量级参考。
