# 删除「笔记」插件(`bow://logseq` + Logseq 文件图读写)

> 目标:把 `src/plugins/logseq/` 连同它占用的内部页面 `bow://logseq`、渲染入口、MCP 工具、快捷键分区、
> 第三方依赖(`force-graph`)与文档一起从仓库里**彻底**移除。
> 非目标:不动 `<userData>/logseq.json` 的用户数据(不迁移、不删除)、不动 `.pi/plans/**` 历史留档、
> 不动用户的 Logseq 图目录(本插件只读过它,删代码不会碰它)。

## 0. 决策记录(本方案据此展开)

| 问题 | 决定 | 后果 |
| --- | --- | --- |
| 移除深度 | **彻底删源码 + 连核心的内部页面登记一起摘** | `InternalPageId` 从 3 个变 2 个;`bow://logseq` 不再是内部页面;删 ~5600 行插件代码 + 186 例单测 |
| 是否保留一个「已下线」空页 / 友好提示 | **不做** | 地址栏输 `bow://logseq` → `navigate()` 直接 `loadURL()` → Chromium 报未知 scheme 的加载失败页(不崩、不新增代码)。要恢复访问就连同插件一起恢复 |
| `force-graph` 依赖 | **删** | 唯一使用方是 `ui/GraphView.vue`;删完 `bun install` 重算 lock |
| `<userData>/logseq.json` | **留原地不删** | 与上次删「文件管理」时留 `files-settings.json` 同一套做法:删除后已无写入方,残留无害 |
| `plugins.json` 里残留的 `disabled:['logseq']` | 不管 | 插件不存在,id 匹配不到任何东西 |
| 文档 | 顺手改掉本次涉及的每一行 | ⚠️ 见 §6:ARCHITECTURE 里已有**与本次无关的旧漂移**(工具数 40 vs 实际 45、`SLOT_PLUGIN_ORDER` 还写着已删的 `'files'`),一起改掉 |

## 1. 影响面一览(改完逐条核对)

### 1.1 直接删掉的文件

| 位置 | 体量 |
| --- | --- |
| `src/plugins/logseq/**`(12 文件) | `main.ts` 788 / `shared.ts` 1415 / `format.ts` 798 / `graph.ts` 530 / `graphForce.ts` 147 / `ui.ts` 17 / 8 个 `.vue` 共 1895 |
| `src/renderer/logseq.html` | 16 |
| `src/renderer/src/logseq/**`(`LogseqApp.vue` + `main.ts`) | 18 |
| `tests/logseqFormat.test.ts` (35 例) / `logseqShared.test.ts` (83) / `logseqGraph.test.ts` (24) / `logseqGraphForce.test.ts` (9) / `logseqPlugin.test.ts` (35) | 186 例 |

`tsconfig.node.json` / `tsconfig.web.json` / `vitest.config.ts` 都是 glob(`src/plugins/*/…`),**不用改**。

### 1.2 核心里的内部页面骨架

| 文件 | 改什么 |
| --- | --- |
| `src/shared/internalPages.ts` | `InternalPageId` 去掉 `'logseq'`(L12);删 `LOGSEQ_URL`(L20-21);`INTERNAL_PAGES` 删 `logseq` 项(L48);L29-32 与 L22-23 的注释里「终端 / 笔记」两处 `openIn:'pane'` 的理由改回只剩终端;`satisfies Record<InternalPageId, InternalPageSpec>` 会自动兜住漏改 |
| `src/main/rendererEntry.ts` | `RendererEntryName` 去 `'logseq'`(L9);L3 注释「设置 / 终端 / 笔记」→「设置 / 终端」 |
| `electron.vite.config.ts` | rollup input 删 `logseq: resolve('src/renderer/logseq.html')`(L41) |
| `src/main/plugins/types.ts` | L19 注释 `bow://settings|terminal|logseq` → `bow://settings|terminal` |

`tabManager.ts` 全部经 `INTERNAL_PAGES` 查表,无硬编码 → 不用动。

### 1.3 登记点

| 文件 | 改什么 |
| --- | --- |
| `src/main/plugins/builtin.ts` | 删 `import logseq`(L11)、上面那行注释与数组项(L28-29) |
| `src/renderer/src/plugins/registry.ts` | 删 `import logseqUi`(L15)、数组项(L30)、`SLOT_PLUGIN_ORDER.toolbar` 里的 `'logseq'`(L49) |

### 1.4 快捷键目录 / 注释里的「笔记」

| 文件 | 改什么 |
| --- | --- |
| `src/shared/shortcutCatalog.ts` | 删整个 `{ id: 'notes', label: '笔记(bow://logseq)', … }` 分组(L174-201);L4、L96 注释里的「笔记」 |
| `src/shared/shortcuts.ts` | L193/195/197 注释里的「笔记页」(分屏接管范围的说明只留终端 / 设置页) |
| `src/renderer/src/lib/splitKeys.ts` | L7 注释举例改成设置页 |
| `src/renderer/src/settings/main.ts` | L10 注释「与笔记页同一条路」→ 只提设置页 |
| `src/main/plugins/fileRoots.ts` | L15 注释把 logseq 的 `assertWritable()` 当例外先例 → 换掉这个例子 |
| `src/main/plugins/pickJsonFile.ts` | L10 注释「照 `logseq/main.ts` 的 `pickGraph` 写法」→ 改成描述做法本身 |

### 1.5 测试

| 文件 | 改什么 |
| --- | --- |
| `tests/internalPages.test.ts` | 删 import 里的 `LOGSEQ_URL`(L4);删两条用例(「笔记页也登记为内部页面」L64-70、「笔记页与终端同轴」L72-74,共 2 例);L95 的 entry 期望 `['settings','terminal']` |
| `tests/shortcutCatalog.test.ts` | L17 分组顺序去掉 `'notes'` |

### 1.6 MCP 面与依赖

| 位置 | 改什么 |
| --- | --- |
| `src/plugins/logseq/main.ts` | `browser_logseq_graph` 随文件删除自动注销 |
| `scripts/mcp-smoke.mjs` | 删 L97-98(那句断言 + 注释) |
| `package.json` | 删 `"force-graph": "^1.52.0"`(L87)→ `bun install` 更新 `bun.lock` |

核心注册表(`CORE_MCP_TOOL_NAMES`)不含它 → 不动。

### 1.7 文档

- `README.md`
  - L3 功能清单删「笔记(内部标签页 `bow://logseq`,…含关系图谱)」
  - L11 删「笔记插件只多用了一个第三方库(`force-graph`…)」整条(现在没有任何第三方格式库了)
  - L433 MCP 工具表删 `browser_logseq_graph` 一行
  - L489 / L498(快捷键接管范围)、L536-538(分屏)、L565 里的「笔记 / 笔记页」
  - **L710-805 整节 `## 笔记(bow://logseq)`** 删除
  - L813 数据存储里「笔记(「笔记」插件):`<userData>/logseq.json`」一行
  - L831(快捷键分类清单)、L831-837(设置页「插件设置」列表里的「笔记」与「笔记」分区那两行)
- `docs/ARCHITECTURE.md`:L92-93(src 树)、L105(渲染入口)、L121、L305-325(内部页面枚举与两根轴)、L353、L363、L424、L579(能力矩阵行)、L598(UI 矩阵行)、L606-607、L610、**L613-631 六条不变式整节**、L696-704(工具清单 + 静态计数)、L862(页面表)、L910-923(快捷键接管范围)、L957(快捷键清单分组)、L961-963(设置分区)、L1001(数据文件)、L1032、L1072、L1182-1183/1192/1213-1221(变更与测试体量的历史注记 —— 保留历史,但把「现存 5 个文件 / 186 例」改成「已于 2026-10-27 删除」)、L1272
- `packages/pi-bow/skills/bow-browser/SKILL.md`:L11 `45 个工具(20 核心 + 25 插件)` → `44 个工具(20 核心 + 24 插件)`;删 L40 那行 `browser_logseq_graph`

## 2. 执行顺序(每步做完都应能编译)

**步骤 1 — 摘核心登记(先做,否则删目录就编译不过)**
1. `src/shared/internalPages.ts`:按 §1.2 收缩枚举与登记表,注释只留终端。
2. `src/main/rendererEntry.ts`、`src/main/plugins/types.ts`、`electron.vite.config.ts`:各去掉一处 `logseq`。
3. `tests/internalPages.test.ts`:删 2 例 + 改 import + 改 entry 期望 → 此时 `bun run typecheck && bun run test tests/internalPages.test.ts` 应绿。

**步骤 2 — 摘登记点**
4. `src/main/plugins/builtin.ts`、`src/renderer/src/plugins/registry.ts`(含 `SLOT_PLUGIN_ORDER.toolbar`)。

**步骤 3 — 删插件本体**
5. `rm -rf src/plugins/logseq src/renderer/src/logseq src/renderer/logseq.html`。
6. 删 5 个测试文件。

**步骤 4 — 快捷键与注释**
7. `src/shared/shortcutCatalog.ts` 删 `notes` 分组;`tests/shortcutCatalog.test.ts` 去掉 `'notes'`。
8. `src/shared/shortcuts.ts`、`splitKeys.ts`、`settings/main.ts`、`fileRoots.ts`、`pickJsonFile.ts` 的注释按 §1.4 改。

**步骤 5 — 依赖与冒烟**
9. `package.json` 删 `force-graph`,`bun install`。
10. `scripts/mcp-smoke.mjs` 删那两条断言。

**步骤 6 — 文档**
11. README / ARCHITECTURE / SKILL.md 按 §1.7 逐条改;顺手把 §6 那两处**旧漂移**一起修掉。

## 3. 验证

```bash
rm -rf out                                   # 免得删掉的 logseq.html 残留在 out/renderer 被打进包
bun run typecheck                            # 两个 tsc 都 0 错
bun run test                                 # 86 文件 / 1584 例 → 81 文件 / 1396 例(1584 − 186 − 2)
bun run build                                # out/renderer 里没有 logseq.html
npm run test:mcp                             # listTools 共 44 个,没有再出现 browser_logseq_graph
```

基线记录(改动前实测):**86 文件 / 1584 例**;`tests/heartbeatHub` 那条 `hub.size` 用例偶发失败,单跑与重跑均过 —— 与本轮无关,别当成回归。

门禁 grep(除 `.pi/plans/**` 与 `bun.lock` 外应为空):
```bash
rg -n 'logseq|Logseq|LOGSEQ|force-graph' src tests scripts packages electron.vite.config.ts package.json README.md docs
```

真机手验清单:
1. 工具栏**没有**笔记按钮;设置页侧栏**没有**「笔记」分区;插件管理列表里没有 logseq 行。
2. 快捷键面板里没有「笔记」分组,其余分组顺序正常。
3. 地址栏输 `bow://logseq` → 不再打开内部页面,变成一个加载失败的标签/错误页(**不崩、不空白卡死**)。
4. `Ctrl+Shift+方向` 在设置页、终端页照常分屏(证明摘 `InternalPageId` 没伤到 `openIn:'pane'` 那条轴)。
5. `browser_list_tabs` 里 `internal:true` 的标签只剩 settings / terminal。
6. 打包产物跑一遍 `scripts/verify-dist.mjs`(它只校验 index/preload/remote,不受影响,但顺手确认 dist 能跑)。

## 4. 回滚

一个 commit(`chore(plugins): 删除笔记插件…`)做完 1–6 步;回滚 = `git revert`。
无数据迁移:`logseq.json`、`plugins.json` 残留都不需要回滚。

## 5. 风险与已知副作用

- **`bow://logseq` 变成无效地址**:用户历史记录 / 书签里指向它的标签点开会是错误页。刻意不做「已下线」提示页 —— 那要新增核心代码与一个渲染入口,与「删干净」的目标相反。想要就去 git 历史里捞回整包。
- **老用户的 `logseq.json` 变孤儿**:里面的图目录 / 最近图 / 字号 / 收藏还在,但再没有读者。文档里那行数据说明删掉后,谁都不知道它是什么 —— 可接受(与 `files-settings.json` 先例一致)。
- **`force-graph` 必须连 lock 一起删干净**:只删 `package.json` 而不 `bun install`,`npm run dist` 仍会把 `node_modules` 里的旧包拷进去(包会大几十 KB,不影响运行)。删完顺手 `rg force-graph bun.lock` 确认没有孤立的 lock 条目。
- **ARCHITECTURE 里的旧漂移**(工具数「合计 40」、`SLOT_PLUGIN_ORDER` 里的 `'files'`)是上一轮删除的遗留,本次一起改;不改的话下次读文档的人会先被这两处误导。
- **别顺手改 `.pi/plans/**`**:里面 10 个 logseq 计划是这类改动唯一的决策留档,删了就再也查不到「为什么当初那样做」。

## 7. 实施记录(2026-10-27)

按 §2 顺序做完,一步一个 commit 的量、单个 commit 未提交。实测:

| 步骤 | 结果 |
| --- | --- |
| `bun run typecheck` | 0 错 |
| `bun run test` | **81 文件 / 1396 例全绿**(1584 − 186 − 2,与预测一致) |
| `rm -rf out && bun run build` | 绿;`out/renderer/` 只剩 index / overlay / settings / terminal 四个 html |
| `npm run test:mcp` | 全过(工具面 44) |
| 门禁 grep | 代码里 0 命中;文档只剩 4 行**变更历史**(ARCHITECTURE 1158-1159、1189-1190) |

偏差与说明:
- ARCHITECTURE §13 里 `**合计 1025**` 那个旧聚合口径本来就对不上(718 + 186 ≠ 1025),连同笔记那 5 行表格一起换成了一条历史注记,
  不去重算历史快照;顺带把该节基线从「64 文件 / 1235 例」更新为本次实测。
- 顺手修掉的两处旧漂移:`SLOT_PLUGIN_ORDER.toolbar` 里早就删掉的 `'files'`;插件工具清单漏了终端的 5 个工具(原文写「30 个…共 20 个,合计 40」)。
  现在是「20 核心 + 24 插件 = 44」,与 `mcp-smoke` 实测一致。
- 未做:真机手验(§3 的 1-6 条)、`npm run dist` + `verify-dist.mjs`。
