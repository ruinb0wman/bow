# 笔记关系图谱改用 force-graph（2026-10-05）

- 模式：plan（待批准）
- 前作：`.pi/plans/2026-10-04-logseq-graph/plan.md`（手写力导向 + 自绘 Canvas 的实现记录）

---

## 1. 目标

把关系图谱的**布局 + 渲染 + 命中/交互**层从「仓库内自写」换成成熟库 **`force-graph`**（Canvas + `d3-force-3d`），
顺带修掉现存的三个缺陷：

1. 打开图谱时明显抖动几秒；
2. 节点名字全部显示成 `undefined`；
3. 点击不能跳到对应文件（手型光标与圆点对不齐、点名字框无效）。

**用户已拍板走整包 `force-graph`**（另两个选项「就地修」/「只换 d3-force」已排除）。
**假设**：现有 `GraphView` 对外契约不变 —— 仍然只 `emit('open-page', GraphNode)` 和 `emit('close')`，
数据仍由父组件经 IPC `graph` 注入；不新增写盘路径（ARCHITECTURE 第六条不变式不受影响）。

---

## 2. 现状（读到的代码）

### 2.1 库

**没有任何第三方图库，全是自写。** `package.json` 的 `dependencies` 里只有
`@modelcontextprotocol/sdk` / `@xterm/*` / `lucide-vue-next` / `node-pty` / `vue` / `zod`。
图谱 = 两个自写文件：

- `src/plugins/logseq/graphLayout.ts`（248 行，纯函数布局：种子 PRNG 环形撒点 → 显式欧拉积分 + 阻尼 + 速度上限，
  `ALPHA_DECAY=0.98`、`ALPHA_MIN=0.005`、`MAX_SIM_NODES=1500` 以上切静态螺旋）；
- `src/plugins/logseq/ui/GraphView.vue`（671 行，Canvas 绘制 + 自写命中测试 + 指针/滚轮交互 + rAF 循环）。

`graph.ts`（索引 → 节点/边）与 `main.ts` 的 `graph` IPC / `browser_logseq_graph` MCP 工具是数据层，**本次不动**。

### 2.2 三个缺陷的根因

**(2) 标签 `undefined` —— 确凿的一行 bug**

`graphLayout.ts` 的 `LayoutNode` 只有 `id / x / y / vx / vy / fixed / degree / day`，
**没有 `title`**（`LayoutNode` interface 定义 + `createLayout()` 里逐字段拷贝都印证了这点）。
而 `GraphView.vue` 的 `draw()` 却拿它当显示名用：

```ts
const width = ctx.measureText(node.title).width      // node.title === undefined
...
ctx.fillText(node.title, sx + radius + 6, sy)        // 画出来就是 "undefined"
```

`out/renderer/assets/logseq-Bjpm2_xF.js` 里同样是 `ctx.measureText(node.title)`，即打包产物一致。
为什么测试没抓住：`tests/logseqGraphLayout.test.ts` 里那条用例叫「绘制信息(degree / day)被拷进布局节点」，
只钉了 `degree`/`day` 两个字段 —— 恰恰漏了真正被绘制读取的 `title`。

**(3) 点不中 / 点标签不跳 —— 命中区只有圆点周围的隐形 halo，不含名字框**

`GraphView.vue` 的命中判定只在节点圆附近：

```ts
const slack = 10 / Math.max(0.1, transform.scale)
const hit = nearestNode(state, worldX, worldY, maxRadius + slack)
return distance <= nodeRadius(hit) + slack ? hit : null
```

而标签画在节点**右侧**、离圆心 `radius + 3` 起：

```ts
ctx.fillRect(sx + radius + 3, sy - 8, width + 6, 16)
```

→ 视觉上最显眼的是名字框，但命中区是圆心周围 `半径 + 10/scale` 的一个看不见的 halo。
用户反馈「手型出现在圆点外、和圆点对不齐」正是这个 halo（节点圆只有 2~7px，halo 却可到 10px+，
大小还随 `scale` 变）；去点名字框则落进 `panning` 分支，什么也不发生。

**(1) 开图抖几秒 —— 用户看到了整个收敛过程**

自写积分器从 `alpha = 1` 起衰减，`0.98^n < 0.005` 需要约 263 帧（≈4.4s），
用户看到的就是这几秒的收敛。库侧正解是 `warmupTicks`（首帧前 dry-run 布局）+ `cooldownTicks/cooldownTime`
（收敛后冻结引擎，配合 `autoPauseRedraw` 停止重绘）。

---

## 3. 为什么选 force-graph（与另外两条路的对比）

`force-graph@1.52.0`（vasturiano，MIT，周下载 ~1M）：

- 渲染 = Canvas，物理 = `d3-force-3d`；内置缩放/平移/节点拖拽/悬停/点击；
- 关键 API 正好对上我们的三个需求：`warmupTicks` / `cooldownTicks` / `autoPauseRedraw`（抖动）、
  `nodeLabel` + `nodeCanvasObject`（标签）、`onNodeClick` + `nodePointerAreaPaint`（点击，且命中区**可自定义**，
  能把名字框一起纳入）；内部用 shadow canvas + 颜色索引做命中，天然与绘制对齐；
- 代价：`172.2 KB min / 55.9 KB gzip`，**15 个直接依赖**（`d3-force-3d` / `d3-zoom` / `d3-selection` / `d3-drag` /
  `lodash-es` / `tween.js` / `float-tooltip` …），npm unpacked 6.2 MB；shipped types（`types: src/index.d.ts`）。
- 这直接推翻 README 第 11 行「笔记插件**零新增依赖**」的承诺，是本方案唯一需要用户接受的代价。

> 记录：`d3-force` 单独引（约 15KB gzip）只能修抖动，标签与命中仍要自写，另两个 bug 不会自动消失；
> `cytoscape` / `sigma.js+graphology` 更重且主题/中文标签要重调，未选。

---

## 4. 要改的文件

| 文件 | 动作 |
| --- | --- |
| `package.json` | `dependencies` 加 `"force-graph": "^1.52.0"` |
| `src/plugins/logseq/ui/GraphView.vue` | **重写**渲染/交互层（模板头部/控件/样式基本保留，`<canvas>` → 容器 div；`<script>` 里删掉 transform / hitNode / pointer / rAF 那一整套） |
| `src/plugins/logseq/graphForce.ts` | **新增**：纯逻辑胶水（节点/边映射、位置复用、半径与标签可见性规则），**不 import force-graph、不碰 DOM**，供 vitest（`environment: 'node'`）直跑 |
| `src/plugins/logseq/graphLayout.ts` | **删除**（连同其全部导出） |
| `tests/logseqGraphLayout.test.ts` | **删除**（10 例，其中「绘制信息拷进布局节点」的漏测正是 bug 2 的来源） |
| `tests/logseqGraphForce.test.ts` | **新增**：钉住新胶水的行为 |
| `README.md` | 第 11 行「零新增依赖」、第 621~626 行「关系图谱」一节（布局来源、1500 静态布局、钉住/重新排布的描述） |
| `docs/ARCHITECTURE.md` | 第 1058 行测试基线（64 文件/1236 例要复测更新）、第 1095~1097 行测试表（`logseqGraphLayout.test.ts` 行换成新文件）、图谱相关处如提到自写布局一并改 |

**不需要改**：`graph.ts`、`main.ts`（IPC `graph` / MCP `browser_logseq_graph` / `capabilities`）、
`JournalView.vue`（`@open-page="onGraphOpenPage"` 的契约不变）、`scripts/mcp-smoke.mjs`（工具集不变）。

---

## 5. 实施步骤（每步都可独立验证）

### 步骤 1：加依赖 + 空跑构建
- 改 `package.json`；`npm install`（lockfile 更新）。
- 验证：`npm run typecheck` 仍 0；`npm run build` 成功，记录 `out/renderer/assets/logseq-*.js` 的体积增量
  （预期 +250~400KB min，lodash-es 已被 tree-shake）。

### 步骤 2：写 `src/plugins/logseq/graphForce.ts`（纯函数）
导出（命名待定，实现时以最小集为准）：
- `toForceNodes(data, prev?: Map<string, ForceNode>)` → `{ nodes, links }`
  - `ForceNode = { id, title, day, degree, x?, y?, vx?, vy?, fx?, fy? }`；
  - **按 id 复用 `prev` 里同一批对象**（d3-force 只在对象缺 x/y 时按 phyllotaxis 初始化，
    传新对象等于整图重排 —— 这是必须自己做的一步）；
  - `links` 用 `{ source: id, target: id, weight }`。
- `nodeRadiusOf(node)`（沿用旧公式 `3 + sqrt(degree)*1.7`，用来和 `nodeVal`/`nodeRelSize` 对齐或直接自绘）；
- `shouldShowLabel(node, { globalScale, focused, neighbor })`（旧规则：`scale >= 1.2` 或悬停/邻居；缩放后可收紧）；
- `labelBox(node, globalScale)` 之类的几何 helper，供绘制与 `nodePointerAreaPaint` **共用同一份矩形**，
  保证「画到哪就能点到哪」。

验证：`tests/logseqGraphForce.test.ts` 新增用例 —— `title` 被带进节点（**直接钉死 bug 2**）、
同 id 复用同一对象引用（位置不丢）、过滤掉再恢复仍复用旧对象、`links` 端点正确、标签可见性规则。

### 步骤 3：重写 `GraphView.vue`
保留：`props`/`emits`、`mode/depth/showJournals/hideOrphans/query`、`source`/`filtered`/`adjacency` 计算、
计数 chips、`Esc`/`0`/`f` 键位、`reflow` 按钮、`emptyHint`。

替换：

```ts
graph = new ForceGraph(containerRef.value)
  .nodeId('id')
  .width(w).height(h)                       // ResizeObserver 里更新（库不监听容器 resize）
  .backgroundColor(colors.bg)
  .nodeVal(n => 1 + n.degree)               // 面积 ∝ 度数
  .nodeLabel(n => n.title)                  // 悬停 tooltip：修 undefined
  .nodeColor(colorOf)                       // 悬停/邻居变暗逻辑同旧版
  .linkColor(l => active(l) ? colors.accent : colors.border)
  .linkWidth(l => 1 + Math.log2(l.weight) * 0.5)
  .nodeCanvasObjectMode(() => 'replace')
  .nodeCanvasObject((n, ctx, scale) => { /* 圆点 + 标签（字号 11/scale 保持屏幕恒定，深色底矩形） */ })
  .nodePointerAreaPaint((n, color, ctx, scale) => {
    // 圆（半径至少 8/scale，保证小图也点得中）+ 与 nodeCanvasObject 同一个标签矩形
  })
  .warmupTicks(200)                         // 首帧前把布局跑完 → 不抖
  .cooldownTicks(Infinity).cooldownTime(15000)
  .autoPauseRedraw(true)
  .onNodeHover(n => { hoverId.value = n?.id ?? null })
  .onNodeClick(n => { const hit = nodeById.get(n.id); if (hit) emit('open-page', hit) })
  .onEngineStop(() => { if (!userAdjusted) graph.zoomToFit(400, 40) })
```

- `onBeforeUnmount` 必须 `graph.pauseAnimation()`（否则 rAF 一直跑）并断开 ResizeObserver。
- 删除：`graphLayout` 的全部 import、`transform`/`size`/`dirty`/`raf`/`dragging`/`panning`、
  `screenPoint`/`screenToWorld`/`hitNode`/`fit`/`draw`/`loop`/`resize`/全部 pointer 与 wheel 处理器、
  `staticOnly` 与「节点过多切静态布局」chip、`MAX_SIM_NODES`。
- `reflow`：`nodes.forEach(n => { n.fx = undefined; n.fy = undefined })` + `d3ReheatSimulation()` + `zoomToFit`。
- `watch`（过滤/数据变化）→ `graph.graphData(toForceNodes(filtered.value, nodeById))`（复用对象，不重排）。

验证：`npm run typecheck`（两套 tsc）+ `npm run build`。

### 步骤 4：文档同步
- `README.md` 第 11 行：改成「除 `force-graph`（关系图谱的力导向/渲染）外，笔记插件其余全部为仓库内纯 TS」。
- `README.md` 第 621~626 行：重写为「布局与交互由 `force-graph` 提供（`warmupTicks` 预热，开图不抖；
  悬停/点击命中由库的 shadow canvas 保证与绘制一致）；节点上限与静态布局分支已移除」。
- `docs/ARCHITECTURE.md`：§测试基线（复测后的文件/用例数）、§测试表（`logseqGraphLayout.test.ts` 行 →
  `logseqGraphForce.test.ts`，描述改为「节点/边映射 + `title` 字段 + 位置复用 + 标签可见性」）；
  若 §5.8 提到「仓库内自写布局」一并改。

### 步骤 5：全量验证
1. `npm run typecheck`（`tsconfig.node.json` + `tsconfig.web.json` 都 0）；
2. `npm test`（新用例全绿，旧 `logseqGraphLayout` 10 例随文件删除而消失 → 总数会降，更新文档数字）；
3. `npm run build`；
4. `npm run test:mcp`（真浏览器，MCP 工具面未变，应仍全绿）；
5. **临时 CDP E2E（不入库，沿用 2026-10-04 的做法：`--remote-debugging-port` 起 Electron + 连 `bow://logseq`）**：
   - 开浮层 → 断言 canvas 有真实尺寸、节点/边计数正确；
   - **点击回归**：在调试把手 `__bowLogseq` 上临时暴露 `graph2ScreenCoords`（或一个
     `graphDebug.nodeScreenPos(id)`），对**名字框中心**发一次真实 `Input.dispatchMouseEvent`
     （`mousePressed` + `mouseReleased`）→ 断言 `__bowLogseq.view` 切到目标页（这条正是旧版没测过、也没做对的地方）；
   - **抖动回归**：`warmupTicks` 后连续两帧取全部节点坐标，断言已稳定（无位移）；
   - **标签回归**：临时把手返回「被绘制的标签文本」（或直接断言 `nodeLabel` 的取值 === `node.title`），
     确保不再出现 `undefined`。
6. `npm run dist` + `node scripts/verify-dist.mjs`（生产依赖闭包进 asar 的自检，只在打包时需要）。

### 步骤 6：真机确认（用户）
开图观感（不再抖）、中文标签在 HiDPI 下可读、点圆点与点名字都能跳、拖拽钉住 + 「重新排布」放开。

---

## 6. 风险与未决

| 风险 | 应对 |
| --- | --- |
| **hover 高亮在引擎冻结后可能不重绘** | force-graph 的 rAF 在 `autoPauseRedraw: true` 下只在需要时重绘，而 `pointermove` 不置 `needsRedraw`。首选 `autoPauseRedraw(false)`（覆盖层打开期间每帧重绘，~180 节点很便宜）；实测不行就去掉「悬停变暗」，只保留库自带的 tooltip + 手型 |
| **`graphData()` 不保留位置** | d3-force 对缺 x/y 的新对象做 phyllotaxis 初始化 ⇒ 必须由 `graphForce.ts` 复用同一批节点对象；步骤 2 的单测 + 步骤 5 的过滤回归覆盖 |
| **首屏缩放打架** | force-graph 在 `onFinishUpdate` 里若用户没动过缩放，会按节点数自动 `zoom(4 / cbrt(n))`（`lastSetZoom`）；我们的 `zoomToFit` 要放在 `onEngineStop` 并用 `userAdjusted` 标志，避免和它互相覆盖（实现时以实测为准，必要时干脆依赖库的自动缩放） |
| **打包 / 体积** | renderer 依赖由 Vite 打进 `out/renderer` 的 logseq chunk（现状 `vue` 已如此），electron-builder 仍会把生产依赖闭包塞进 asar（`vue`/`lucide-vue-next` 也是），asar 会因 force-graph 的 15 个依赖明显变大；`verify-dist.mjs` 走一遍确认；`force-graph` 必须放 `dependencies` 而非 `devDependencies`（否则与 `verify-dist` 的 devDep 污染检查/仓库惯例冲突） |
| **类型解析** | force-graph 的 `exports` 没有 `"."` 键（只有 `umd/types/default`），顶层另有 `"types": "src/index.d.ts"`；`moduleResolution: bundler` 下若解析失败，补一个最小 `*.d.ts` shim（只声明用到的方法），不要开 `skipLibCheck` 之外的放宽 |
| **`nodePointerAreaPaint` 必须与 `nodeCanvasObject` 同步** | 标签盒子几何抽到 `graphForce.ts` 里共用，避免再次出现「画得到、点不到」的漂移（本次 bug 3 的同类错误） |
| **中文字形 / HiDPI** | 沿用旧结论：headless 缺 CJK 字体渲染成豆腐块，文字可读性必须真机看（见 scratchpad） |
| **测试环境** | `vitest` 是 `environment: 'node'`，不能实例化 force-graph（需要 DOM）。所以胶水必须是纯函数、不 import force-graph；组件层只能靠步骤 5 的 CDP E2E 覆盖 |
| **深色主题** | 颜色仍在挂载时 `getComputedStyle(document.documentElement)` 读 CSS 变量（沿用旧做法，主题切换后重开浮层生效） |

---

## 7. 验收标准

- 开图不出现可见的收敛抖动（`warmupTicks` 生效）。
- 节点标签显示真实标题（`title::` 或文件名/日期），不再是 `undefined`。
- 点节点圆点、点名字框都能跳到对应页面/日志；手型出现在**可见图形的正上方**。
- 全图/邻域切换、日志/孤立页过滤、按标题搜索、缩放/平移/拖拽钉住、`reflow`、`Esc`/`0`/`f` 行为与旧版一致或更好。
- `npm run typecheck` / `npm test` / `npm run build` / `npm run test:mcp` 全绿；README 与 ARCHITECTURE 无文档漂移。

---

## 8. 实现记录（2026-10-05，build 模式执行完毕）

**落地改动**：

- `package.json`：`dependencies` + `"force-graph": "^1.52.0"`（renderer 依赖，由 Vite 打进 `out/renderer` 的 logseq chunk；electron-builder 照旧把生产依赖闭包塞进 asar）。
- 新增 `src/plugins/logseq/graphForce.ts`（纯胶水，不 import force-graph / 不碰 DOM）：`toForceGraph`（**跨刷新复用同一批节点对象**、边每次重建）、`nodeRadius`/`nodeValue`、`shouldShowLabel`、`labelBox`/`labelFont`（**绘制与命中共用同一份几何**）、`withAlpha`。
- 重写 `src/plugins/logseq/ui/GraphView.vue`：删掉自写的 transform / 命中测试 / 指针与 rAF 那一整套（`graphLayout.ts` 整体删除，其 10 例单测同时删除），改由 `force-graph` 承担布局/渲染/缩放/拖拽/命中；我们只喂 `nodeCanvasObject`（圆点 + 标签）、`nodePointerAreaPaint`（圆点至少 9 屏幕像素 + **标签框矩形**）、`nodeLabel`、`linkColor`/`linkWidth`、`onNodeClick`/`onNodeHover`、`onEngineTick`。
- 新增 `tests/logseqGraphForce.test.ts`（9 例）。
- 文档同步：`README.md`（技术栈第 11 行不再写「零新增依赖」、关系图谱一节重写）、`docs/ARCHITECTURE.md`（§2 目录树加 `graphForce.ts`、第六条不变式补「首次 fit 必须等 `onEngineTick`」、测试表/基线 64 文件 1235 例、§11 汇总 187→186 / 1026→1025）。

**验证（全绿）**：`npx tsc --noEmit -p tsconfig.web.json` / `-p tsconfig.node.json` 0；`npx vitest run` **64 文件 / 1235 例**；`npm run build`（logseq chunk 104KB → **426KB**，多出来的是 force-graph + 它的 15 个依赖）；`npm run test:mcp` 全过；`npm run dist` + `scripts/verify-dist.mjs` 通过（asar 62.3MiB，运行时外部依赖仍只有 `@modelcontextprotocol/sdk` / `node-pty` / `zod`，force-graph 已打进 renderer chunk）；**临时 CDP E2E**（`/tmp/bow-graph-e2e.mjs`，真 Electron + 临时 Logseq 图，不入库）全绿：
节点 5 / 边 4 → 首屏缩放/平移有限（非 NaN）→ 5 个节点全部在画布内 → 前后帧团数一致、600ms 位移 **0.19px** → 悬停在**画出来的节点像素**上手型生效 → tooltip = 真实标题 → 点节点跳到**同一个**页面 → 节点右侧标签框也在命中区 → 点标签框关闭浮层并落到它自己那页。

**与计划的偏差（3 条，都是实测后修正）**：

1. **首次 `zoomToFit` 必须等 `onEngineTick`**（计划里没预见到，E2E 抓到的真 bug）：`graphData()` 只是把数据交给库；`force-graph`/`kapsule` 的布局（含 `warmupTicks`）跑在一个 `debounce(1ms)` 的 update 里，而 `new ForceGraph()` 时节点还没有 `x/y`。抢在布局之前调 `zoomToFit` → 包围盒 NaN → `d3-zoom` 变换 NaN → **节点全部不可见、悬停与点击全部落空**（`canvas.__zoom` 是 `{k:NaN,x:NaN,y:NaN}`）。改成在 `onEngineTick`（布局跑起来的第一帧）里做一次性 fit，并在 fit 前 `resize()` 保证按当前容器尺寸算。首次 fit 用 `duration = 0`（不做动画，避免任何 tween 起点竞态）。
2. **画边时 `link.source`/`link.target` 已被 d3-force 就地改写成节点对象**（不再是 id）—— `linkColor`/`linkWidth` 里的「是否高亮这条边」必须同时兼容 id 与对象（`endpointId()`）。
3. 首屏 fit 从「按 `rebuildLayout()` 同步调」改成「布局就绪后一次性调用」；`f` / `reflow` 复用同一条路径（`needsFit = true; applyFit()`），所以引擎冻结后再按 `f` 也不会算出坏变换。

**未验 / 待真机瞄一眼**：中文标签在 HiDPI 下的可读性（headless 缺 CJK 字体）、悬停高亮在引擎冻结后的观感（已用 `autoPauseRedraw(false)` 保证每帧重绘）、拖拽钉住的手感与「重新排布」。
