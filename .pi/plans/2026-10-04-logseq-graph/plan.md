# 笔记插件：Logseq 关系图谱（graph view）实施方案

- 日期：2026-10-04
- 模式：plan（待批准）
- 已定决策（本次问答用户拍板）：
  1. **范围：全局图谱 + 当前页局部图谱**（同一份数据，局部只做子集渲染）
  2. **载体：`bow://logseq` 页内全屏浮层**（不动内部页面注册表 / 标签体系）
  3. **交互：完整交互，Canvas 自写力导向**（拖拽 / 缩放 / 平移 / 悬停高亮 / 点击打开 / 过滤，零新增依赖）
  4. **同时暴露 1 个只读 MCP 工具**：`browser_logseq_graph`

---

## 1. 目标与假设

**目标**：给 `bow://logseq` 加一个 Logseq 风格的「关系图谱」：把图里所有页面/日志渲染成力导向网络，边 = 页面之间的 `[[双链]]` / `#标签` 引用（指向已存在文件），节点大小 ∝ 连接数；可切「全图 / 当前页 1~2 跳邻域」，悬停高亮邻居、点击打开页面、过滤日志与孤立页；并通过一个只读 MCP 工具让 AI 读到图结构。

**假设**（若与实际不符请纠正）：

- **边只来自引用**（`[[页面]]` / `#标签` / `#[[多字 标签]]`，与现有 `refsOfTokens` 一致）。**不做 unlinked references**（纯文本提及不建边）——Logseq 图谱也以链接为准。
- **节点 = 索引里的文件**（`journals/*.md` + `pages/*.md`），日志默认显示、可关；`#标签` 在 Logseq 里本身就是页面，天然已是节点。**被引用但还没创建的页面不建节点**，只在数据里报一个计数（避免图谱被大量空节点撑爆）。
- **图视为无向**（视觉上无箭头）；同一对文件多次引用合并成一条边，`weight` 记引用次数、`degree` 记不同邻居数。
- 规模：用户当前图约 180 个文件（`pages/` 121 + `journals/` 56，实测），O(n²) 力导向完全够用。索引上限 `MAX_INDEX_FILES = 5000`，方案给一个**硬上限**：超过 `MAX_SIM_NODES`（建议 1500）时不做逐帧力导向，改用确定性静态布局（仍可平移/缩放/点击/拖单个节点），并显示提示。
- 图谱**只读**：不改写任何文件，不写 `logseq.json`（除已有的 `fontSize`/收藏外无新状态）。布局/过滤都是页面内的瞬态状态，刷新即回默认。

---

## 2. 现状依据（读过的真实代码）

| 事实 | 出处 |
| --- | --- |
| 索引里每个文件已带**文件级引用集合**与**逐块引用**（小写去重）：`IndexedFile.refs` / `blocks[].refs` / `blocks[].text` / `blocks[].line` | `src/plugins/logseq/graph.ts:34-56`、`parseIndexedFile()`（`absorb`/`walk`） |
| 认页三条路已有：`byTitle`（含日志，键 = `pageKey(title)`）、`byStem`（仅页面，`title::` 与文件名不同的别名）、`byDay` | `src/plugins/logseq/graph.ts:60-84`、`resolvePage()` |
| 引用来源是行内 token，`[[页]]` 与 `#标签` 都算页面引用 | `src/plugins/logseq/format.ts:779` `refsOfTokens()` |
| 纯逻辑 `graph.ts` **同时被 node/web 两个 tsconfig 收录**，必须保持无 DOM、无 fs | `tsconfig.node.json:27`、`tsconfig.web.json` 跟随 import |
| 渲染层组件只允许出现在 `src/plugins/*/ui/**/*.vue` | `tsconfig.web.json:include` |
| 边界由测试强制：`main.ts` 不得引 `.vue`/`@renderer`；`ui.ts` 不得引 `electron` | `tests/pluginBoundaries.test.ts` |
| 笔记页结构：`bow://logseq` → `LogseqApp.vue` → 插件里的 `JournalView.vue`；页头按钮 / 状态 / 订阅都在这个组件 | `src/renderer/src/logseq/LogseqApp.vue`、`ui/JournalView.vue:1120-1180`（`head-side`） |
| 页面靠 `api.plugins.invoke('logseq', method, ...)` 取数据；`graph-changed` / `settings-changed` / `favorites-changed` 事件已有订阅 | `ui/JournalView.vue:520-540`（`subscribe`）、`main.ts` `ctx.ipc.emit` |
| 主进程 IPC 面在 `activate()` 里 `ctx.ipc.handle(...)`；索引入口是 `runtime.index ?? await ensureIndex()`（并发共享同一个 promise） | `src/plugins/logseq/main.ts` |
| 插件 MCP 工具写法：`ctx.mcp.tool(name, { description, inputSchema }, handler)`，返回 `textContent(...)`；带参数的 schema 用 zod（bookmarks 是范例） | `src/plugins/pomo/main.ts:229-268`、`src/plugins/bookmarks/main.ts:150-171` |
| MCP 工具要求 `capabilities` 里声明 `'mcp'`（番茄钟就是 `['ui','mcp','shortcut']`）；当前 logseq 是 `['ui']` | `src/plugins/logseq/main.ts:563`、`src/plugins/pomo/main.ts:173` |
| 插件 MCP schema 不做 strict 校验，未知参数静默丢弃（写文档时要知道） | `docs/ARCHITECTURE.md:638` |
| 工具计数文档：插件工具 19 个、合计 38；`SKILL.md` 也写 38（19 核心 + 19 插件） | `docs/ARCHITECTURE.md:630-641`、`.pi/skills/bow-browser/SKILL.md:8` |
| 现有测试用**内存 IO**（`logseqGraph.test.ts`）与**真实临时目录**（`logseqPlugin.test.ts`）两套；插件测试的 `mcp` 目前是空实现 | `tests/logseqGraph.test.ts:1-68`、`tests/logseqPlugin.test.ts:60-81` |
| lucide 图标可选：`Network` / `Share2` / `Waypoints` / `GitFork` 都在 | `node_modules/lucide-vue-next/dist/lucide-vue-next.d.ts` |

---

## 3. 数据模型（`src/plugins/logseq/graph.ts` 追加，纯逻辑、可单测）

```ts
export interface GraphNode {
  /** 节点 id = 文件的图内相对路径（`journals/2026_09_20.md`）—— 稳定、唯一 */
  id: string
  /** 显示名（`title::` 优先，否则文件名解码；日志是 `YYYY-MM-DD`） */
  title: string
  /** 日志才有；页面为 null */
  day: string | null
  /** 不同邻居数（点大小用它，不用 weight，避免一条强引用把节点撑大） */
  degree: number
}
export interface GraphLink {
  source: string   // GraphNode.id
  target: string   // GraphNode.id
  /** 同一对文件被引用的次数（块级 refs 计数；无向去重后累加） */
  weight: number
}
export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
  /** 被引用、但目标页还没创建的不同页面数（不建节点，只报数） */
  missingRefs: number
  /** 索引本身不完整（文件数 ≥ MAX_INDEX_FILES）—— 图谱据此提示可能不全 */
  tooLarge: boolean
}

/** 全图：把索引里的引用解析成节点/边 */
export function graphOf(index: GraphIndex): GraphData

/** 局部图：从 centerId 出发、双向 BFS `depth` 跳；保留原 degree，只保留两端都入选的边 */
export function localGraph(data: GraphData, centerId: string, depth?: number): GraphData
```

**`graphOf` 算法**（`index.files` 一趟）：

1. 建解析表：`pageKey(title) → id`（**含日志**，与 `byTitle` 一致）＋ `pageKey(stem) → id`（仅页面，别名路，与 `byStem` 一致）。
2. 遍历每个文件、每个块的 `refs`，`pageKey` 后查表：
   - 命中且目标 ≠ 自己 → 无向去重键 `min(a,b)\0max(a,b)` 累加 `weight`；
   - 未命中 → `missingSet.add(refKey)`（`missingRefs = missingSet.size`）。
3. 从边表算每个节点的不同邻居数 = `degree`。
4. **自环丢弃**（`file.refs` 里引到自己），与反向链接面板「不显示自己的反链」同一取舍。

**`localGraph` 算法**：由 `links` 建无向邻接表 → 从 `centerId` 做 BFS 到 `depth`（默认 1，夹到 1..3）→ 选中的 id 集合 → 过滤 nodes（保留原 degree）与两端都入选的 links。center 不在图里（例如正在编辑一个还没落盘的新页面）→ 返回空图，由 UI 显示提示。

---

## 4. 力导向布局（新增 `src/plugins/logseq/graphLayout.ts`，纯逻辑、可单测）

**为什么自己写**：仓库对笔记插件的硬要求是「零新增依赖」（README:11），且布局要能单测。不引 d3-force。

```ts
export interface LayoutNode { id: string; x: number; y: number; vx: number; vy: number; fixed: boolean }
export interface LayoutState { nodes: LayoutNode[]; byId: Map<string, LayoutNode>; alpha: number }
export interface LayoutOptions { width: number; height: number; seed?: number; linkDistance?: number; charge?: number }

export const MAX_SIM_NODES = 1500

export function createLayout(
  input: { nodes: { id: string; degree: number }[]; links: { source: string; target: string }[] },
  opts: LayoutOptions
): LayoutState

/** 一步积分：斥力（O(n²)，`charge/dist²` 截断）+ 弹簧（沿边）+ 向心 + 阻尼；alpha 衰减。fixed 节点不动 */
export function tickLayout(state: LayoutState, links: readonly {source:string;target:string}[], opts: LayoutOptions): void

export function layoutBounds(state: LayoutState): { minX: number; minY: number; maxX: number; maxY: number }
/** 屏幕坐标 → 最近的节点（含最大距离），命中测试用 */
export function nearestNode(state: LayoutState, x: number, y: number, maxDist: number): LayoutNode | null
/** 把 bounds 装进视口：返回 { scale, tx, ty } */
export function fitTransform(bounds: Bounds, width: number, height: number, padding?: number): { scale: number; tx: number; ty: number }
```

实现要点（写代码时按这些钉）：

- **确定性**：初始位置由 `mulberry32(seed ?? 1)` 的种子随机数按输入索引摆在圆上 —— 同一份数据每次打开布局一致，测试可断言。
- **积分**：`v = (v + F) * damping`，`x += v`，速度上限防爆；`alpha` 从 1 每帧 `* 0.98`，`< 0.005` 视为稳定（组件据此停 rAF）。
- **规模保护**：`nodes.length > MAX_SIM_NODES` 时 `alpha = 0`，节点按 degree 降序摆在阿基米德螺旋上（静态、仍可交互）；**绝不在主线程上跑 5000² 的循环**。
- 纯函数、不碰 DOM / Canvas / Vue：Canvas 只负责把 `LayoutState` 画出来。

---

## 5. 新增 / 修改的文件

### 新增

| 文件 | 内容 |
| --- | --- |
| `src/plugins/logseq/graphLayout.ts` | §4 的纯布局：种子 PRNG、`createLayout` / `tickLayout` / `layoutBounds` / `nearestNode` / `fitTransform`、`MAX_SIM_NODES` |
| `src/plugins/logseq/ui/GraphView.vue` | 全屏 Canvas 图谱：力导向动画循环、拖拽/缩放/平移、悬停高亮邻居、点击打开、节点搜索、日志/孤立页过滤、全局/局部切换（深度 1/2）、计数与提示、Esc 关闭 |
| `tests/logseqGraphLayout.test.ts` | 布局单测（见 §7） |

### 修改

| 文件 | 改动 |
| --- | --- |
| `src/plugins/logseq/graph.ts` | 追加 §3 的类型与 `graphOf` / `localGraph`（保持无 DOM / 无 fs，两个 tsconfig 都能编） |
| `src/plugins/logseq/main.ts` | ① 新 IPC `graph`（返回 `GraphData`）；② MCP 工具 `browser_logseq_graph`；③ `capabilities: ['ui']` → `['ui','mcp']`。MCP handler 与 IPC 共用同一个「取当前索引」入口（`runtime.index ?? await ensureIndex()`），无图时返回 `{ok:false,error:'还没有选择图目录'}` |
| `src/plugins/logseq/ui/JournalView.vue` | ① `head-side` 加「关系图谱」按钮（lucide `Network`）；② `openGraph()` = `saveNow()` → `invoke('graph')` → 打开浮层；③ 浮层挂载 `<GraphView>` 并接 `@open-page`（节点有 `day` → 日志视图，否则页面）；④ `graph-changed` 订阅里：浮层开着就防抖重取；⑤ `onWindowKeydown` 开头 `if (graphOpen.value) return`，把键位让给浮层 |
| `tests/logseqGraph.test.ts` | 追加 `graphOf` / `localGraph` 用例（§7） |
| `tests/logseqPlugin.test.ts` | harness 的 `mcp.tool` 改为**记录**工具名/handler；追加：`graph` IPC 路由、空图、MCP 工具返回体 |
| `scripts/mcp-smoke.mjs` | 断言 `names.includes('browser_logseq_graph')`；调一次并接受「没有选图」的优雅失败（与其它工具「只验在册」同风格） |
| `README.md` | 「笔记（bow://logseq）」一节新增图谱 bullet（入口 / 全局与局部 / 交互 / 过滤 / 日志开关 / 规模提示）；确认顶部「零新增依赖」仍成立 |
| `docs/ARCHITECTURE.md` | §5.8 的 `logseq` 行：capabilities `ui` → `ui, mcp`，IPC 面加 `graph`；§561 五条不变式**加一条**「图谱是索引的只读派生，不落盘、不改文件」；§630-641 插件工具 19 → 20、合计 38 → 39、静态计数列表加 `logseq/main.ts:<行号>`；§1086-1093 测试表加 `logseqGraphLayout.test.ts` 行并按 `npm test` 实测更新文件/例数 |
| `.pi/skills/bow-browser/SKILL.md` | 工具数 38 → 39（19 核心 + 20 插件），工具索引表加一行 `browser_logseq_graph`（只读：当前图的节点/边/度数/局部邻域） |
| `~/.pi/agent/skills/bow-browser/SKILL.md` | 与仓库内那份同步（安装态拷贝，不会自动同步） |

**不改**：`internalPages.ts` / `renderer/src/logseq/*` / `ui.ts` / `BUILTIN_PLUGINS` / `SLOT_PLUGIN_ORDER`（图谱是页内浮层，不进内部页面注册表，也不占插槽）。

---

## 6. 实施步骤（每步可独立验证）

1. **纯数据层**（`graph.ts`）：加 `GraphNode` / `GraphLink` / `GraphData` + `graphOf` / `localGraph`。
   验证：`tests/logseqGraph.test.ts` 新用例（§7）先红后绿。
2. **纯布局层**（`graphLayout.ts`）：加种子 PRNG + 五个导出函数。
   验证：`tests/logseqGraphLayout.test.ts` 全绿（确定性、有限坐标、收敛、斥力分开重合节点、fit 结果把 bounds 装进视口）。
3. **主进程接线**（`main.ts`）：`graph` IPC + `ctx.mcp.tool('browser_logseq_graph', …)` + `capabilities` 加 `'mcp'`。
   验证：`tests/logseqPlugin.test.ts` 新用例；`npm run typecheck` 两套 project 都不报（确认 `graph.ts` 仍无 DOM 引用）。
4. **MCP 工具**：按 §8 返回体实现（有界输出；`node` 存在时给局部邻域，否则给统计 + top 节点）。
   验证：单测断言返回体形状；`npm run test:mcp`（真浏览器）断言工具在册。
5. **布局动画组件**（`GraphView.vue`）：Canvas + rAF + 交互 + 过滤 + 工具栏。
   验证：`npm run typecheck`；`npm run build` 绿；用 `bow-browser` CDP 在真 Electron 里点开浮层（截图 + `__bowLogseq` 把手取节点/边计数、悬停高亮、点击节点打开页面、Esc 关闭）。
6. **接进页面**（`JournalView.vue`）：页头按钮、浮层挂载、事件订阅、键位让行；并在调试把手 `__bowLogseq` 加 `graphOpen` / `graphStats` 只读字段供 E2E。
   验证：CDP 步骤同上；`graph-changed`（在文件里改一条 `[[链接]]`）时浮层数据刷新。
7. **文档与计数**（README / ARCHITECTURE / SKILL / 安装态 SKILL / mcp-smoke）。
   验证：`npm run test:mcp`、`npm test` 全绿；文档里的工具数与测试数用实测值。
8. **整轮复验**：`npm run typecheck` → `npm test` → `npm run build` → `npm run test:mcp`（必要时 `test:e2e:agent` 回归，确认没碰坏通知链）。

---

## 7. 测试清单

**`tests/logseqGraph.test.ts`（内存 IO，扩展现有 fixture）**

- 边：`[[A]]` 双向去重成 1 条、`weight` 按块出现次数累加；`#标签` 与 `[[页]]` 一样成边；自环丢弃。
- 目标未创建的引用不建节点，`missingRefs` 计数正确。
- `degree` = 不同邻居数（不是 weight）；日志节点 `day != null`、页面为 null。
- `title::` 与文件名不同的页面：别名与显示名都能连上（复用 `byStem` 语义）。
- `localGraph`：1 跳 = 直接邻居；2 跳包含邻居的邻居；只保留两端入选的边；center 不存在 → 空图；`depth` 夹紧。
- `tooLarge` 索引照常产出（图谱自己提示）。

**`tests/logseqGraphLayout.test.ts`（新）**

- 同 seed + 同输入 → 坐标逐字节一致；不同 seed → 不同。
- 跑 N tick 后所有坐标有限（无 NaN/Infinity）。
- 收敛性：后 50 tick 的总动能 < 前 50 tick（松阈值，避免抖动误报）。
- 两个重合节点会互相推开（距离 > 0）。
- `fixed` 节点在 tick 后坐标不变。
- `fitTransform`：把 bounds 装进 `width×height`（变换后四角都在视口+padding 内）。
- `nodes.length > MAX_SIM_NODES` → `alpha === 0` 且坐标有限（静态布局分支）。

**`tests/logseqPlugin.test.ts`（真实临时目录）**

- `graph` 路由：真实建图后返回的节点/边与文件对应；无图时返回空 `GraphData`（不抛）。
- MCP：`browser_logseq_graph` 在册；无图时 `{ok:false,error}`；有图时统计字段形状正确、数组长度受 `limit` 约束。
- 回归：`capabilities` 含 `'mcp'` 且原有 IPC 面不变。

---

## 8. MCP 工具 `browser_logseq_graph` 契约（只读、有界）

参数（zod raw shape，插件侧不 strict）：

- `node?: string` —— 有值时返回**这个页面的局部邻域**（按显示名/文件名解析，与 `resolvePage` 同义）。
- `depth?: number` —— 局部邻域跳数，默认 1，夹 1..3。
- `limit?: number` —— 返回节点上限，默认 30，上限 200（避免把大图灌进上下文）。
- `includeJournals?: boolean` —— 默认 true。

返回 `textContent(...)`：

- 无图：`{ ok:false, error:'还没有选择图目录' }`。
- 无 `node`：`{ ok:true, nodes, links, journals, orphans, missingRefs, top:[{title,degree}×limit] }`。
- 有 `node`：`{ ok:true, center:{title,degree}, neighbors:[{title,day,degree}×limit], truncated }`。

---

## 9. 风险与未决

| 风险 / 未知 | 应对 |
| --- | --- |
| **大图性能**：索引上限 5000，O(n²) 力导向在几千节点会卡主线程 | `MAX_SIM_NODES = 1500` 之上切静态螺旋布局（可交互但无逐帧力）；测试钉住该分支 |
| **视觉主题**：Canvas 取不到 CSS 变量 | 挂载时从 `getComputedStyle(document.documentElement)` 读 `--bg/--fg/--fg-dim/--accent/--border`；主题切换后重新打开浮层即刷新（已知小瑕疵，文档注明；如要实时，加 `MutationObserver` 监听 `class`，属于可选） |
| **局部图中心不存在**（正在编辑还没落盘的新页） | `localGraph` 返回空图，浮层提示「这一页还没落盘，先写一个字」并保留「看全图」按钮 |
| **未做 unlinked references** | 明确写进 README / 工具描述；未来要做再加一步「纯文本提及」扫描 |
| **边方向** | 视觉无向；若之后想要箭头，数据层 `GraphLink.source/target` 已保留方向语义 |
| **MCP 输出膨胀** | `limit` 默认 30 / 上限 200；统计型返回只给 top 列表，不 dump 全图 |
| **工具计数文档** | `ARCHITECTURE` §6.2 是**静态计数**（`ctx.mcp.tool(...)` 调用点），实现后必须按真实行号/数量更新，否则文档漂移（本仓库已有前车之鉴） |
| **真机验证** | headless 只能验「逻辑 + DOM/Canvus 命令」；力导向观感、缩放手感、HiDPI 清晰度需要真机看一眼（用 `bow-browser` CDP 截图 + 手动确认） |
| **是否给反链面板加入口** | 本方案只放页头按钮；若想要「从反链面板一键进入当前页局部图谱」，在 `BacklinksPanel.vue` 头部加一个按钮即可（可选，本次不做） |

---

## 10. 实现记录（2026-10-04，build 模式执行完毕）

**改动落地**：

- 新增 `src/plugins/logseq/graphLayout.ts`（纯布局）、`src/plugins/logseq/ui/GraphView.vue`（Canvas 浮层）、`tests/logseqGraphLayout.test.ts`。
- 改 `graph.ts`（`GraphNode` / `GraphLink` / `GraphData` + `graphOf` / `localGraph`）、`main.ts`（`graph` IPC + MCP `browser_logseq_graph` + `capabilities: ['ui','mcp']` + manifest 描述）、`ui/JournalView.vue`（页头图谱按钮、浮层挂载、`graph-changed` 刷新、键位让行、调试把手 `graphOpen`/`graphStats`/`openGraph`/`closeGraph`）。
- 文档：`README.md`（笔记一节 + MCP 工具表 + 顶部摘要）、`docs/ARCHITECTURE.md`（§5.8 行 + 第六条不变式 + §6.2 工具 20/39 + 测试表）、`.pi/skills/bow-browser/SKILL.md`（39 = 19+20）+ 已同步 `~/.pi/agent/skills/bow-browser/`、`scripts/mcp-smoke.mjs` 断言。

**验证**（全绿）：`npx tsc -p tsconfig.node.json` / `-p tsconfig.web.json` 0；`npm test` **64 文件 / 1236 例**；`npm run build`；`npm run test:mcp`（真浏览器，`browser_logseq_graph` 在册）；临时 CDP E2E（真 Electron + 真 Logseq 图，不入库）验到：页头按钮开浮层 → 节点 5 / 边 4 / missingRefs 0 → canvas 有真实尺寸、浮层全屏 → 画布画出蓝色页面节点 + 金色日志节点 → Esc 关闭。

**与计划的偏差（都是实测后修正）**：

1. **`LayoutNode` 必须带 `degree` / `day`**：最初只存坐标，绘制时 `Math.sqrt(node.degree)` 得到 `NaN`，`ctx.arc` 抛错 → 边画出来了、节点一个都没有。已把这两个字段从输入拷进布局节点，并加单测钉住。
2. **向心力 0.001 → 0.02**：5 个节点时斥力把节点推到视口外（实测第一版只有 1 个节点可见）。同时加「仿真稳定（`alpha` 归零）后自动 `fit()` 一次」，把整张图框进视口；用户自己缩放/平移/拖拽过就不抢视角。
3. 计划里说用 `nearestNode` 做命中测试保留了下来（组件里用它 + 半径/余量复核）。

**未验 / 待真机瞄一眼**：力导向的观感、拖拽与缩放的手感、HiDPI 下标签清晰度。headless 下中文全部渲染成豆腐块（缺 CJK 字体），截图只能看形状与颜色，文字可读性需要真机看（见 scratchpad）。
