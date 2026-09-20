# 笔记插件:状态提示改为浮层(消除编辑时的页面抖动)

> 起因(用户原话):「我希望修改一下笔记插件的状态提示改为浮动的, 例如未保存, 保存中. 不要占用文档流,
> 因为会造成页面抖动」。

## 1. 目标

把笔记页(`bow://logseq`,视图组件 `src/plugins/logseq/ui/JournalView.vue`)**编辑期间高频出现/消失**的
状态提示从文档流里挪出来,固定浮在窗口右下角 —— 它们不再推动正文,编辑时页面不会上下抖。

**已与用户确认的 4 个决策(问卷)**:

1. **只浮动编辑期瞬态状态**:`保存中…` / `未保存` / `外部已改动` / 错误消息(`message`)。
   `尚未创建文件` / `来自模板` / `图文件数超限` / `日期格式警告` 仍留在标题下那一行 `.meta`
   (它们只在切页/切图时变,频率极低);同时给 `.meta` 钉一个最小高度,避免首次保存成功后那一行整行消失
   造成一次跳动。
2. **浮层位置 = 右下角固定**(`position: fixed`,不随滚动移动)。
3. **不做「已保存」正向反馈**:浮层消失即完成,不新增状态与定时器。
4. **错误消息常驻到「下次成功保存 / 换页」**,不做自动淡出。

**非目标**:冲突横幅 `.conflict`(需要用户二选一,是交互区不是状态提示)继续留在文档流;
整页错误(`status === 'error'` / `nolograph` / `disabled`)继续走 `.notice` 全页提示;
工具栏按钮与标签标题不加状态点。

## 2. 现状(逐条对着读过的代码)

1. **抖动源就是 `.meta` 这一条 flex 行**。`JournalView.vue:753-767`:

   ```html
   <div class="meta">
     <span v-if="meta && !meta.exists" class="chip">尚未创建文件(第一次编辑时创建)</span>
     <span v-if="meta?.fromTemplate" class="chip">来自模板 {{ meta.fromTemplate }}</span>
     <span v-if="saving" class="chip">保存中…</span>
     <span v-else-if="dirty" class="chip warn">未保存</span>
     <span v-if="externalChanged" class="chip warn">外部已改动</span>
     <span v-if="graphState?.index?.tooLarge" class="chip warn">…</span>
     <span v-if="graphState && graphState.dateFormat.ok === false" class="chip warn">…</span>
     <span v-if="message" class="chip error">{{ message }}</span>
   </div>
   ```

   它 `display: flex`(`.meta`, `JournalView.vue:1009`),高度从 0(无 chip,仅 `padding: 6px 20px 0`)
   到约 24px(一行 chip)之间来回变 —— 每一次「打字 → 400ms 后保存成功」都会把它下面的 `<main class="blocks">`
   推上推下。
2. **瞬态状态的完整生命周期**(已读 `scheduleSave` / `doSave` / `commit`,`JournalView.vue:250-285`、`331-345`):
   - `input` → `dirty = true` + `scheduleSave()`(400ms 防抖)→ 显示「未保存」;
   - 防抖到点/失焦 → `doSave()`:先 `saving = true`(显示「保存中…」,此时 `dirty` 仍为 true,靠 `v-else-if`
     让「保存中」优先),成功后才 `dirty = false`(两个 chip 一起消失)。
   ⇒ 一次敲击会让 `.meta` 走「无 → 未保存 → 保存中 → 无」,这就是抖动。
3. **`外部已改动`(`externalChanged`)与错误 `message` 也在编辑期出现**:前者由 `graph-changed` 事件在
   `dirty` 时置位(`JournalView.vue:600-610`),后者由 `doSave` 失败设置(`JournalView.vue:270-281`)。
   两者都落在 `.meta`,同样会推正文,所以一并进浮层。
4. **`message` 目前的清空时机只有「保存成功」一处**(`JournalView.vue:279`)。用户问卷里选的是
   「常驻到下次成功保存 / 换页」,所以本次要**顺带补上换页清空**(现状切页后旧错误会一直挂着)。
5. **`.chip` 底色是 `--bg2`(#26272e)**,与 `.head` 同色(`JournalView.vue:1016-1023`)。浮到正文
   (`--bg` #1e1f24)之上会显得「贴」在背景里,需要换成 `--bg3`(#2e3038)+ 一点阴影才看得清。
6. **E2E 断言不依赖这些 chip 的 DOM**:`/mnt/d/tmp/logseq-e2e-wsl.mjs` 用调试把手
   `window.__bowLogseq.{meta,dirty,conflict,rows}`(grep 全文件确认无 `.chip` / `.meta` 选择器),
   所以模板调整不会打断既有 46 条断言。当前把手**没有暴露 `saving`**(`JournalView.vue:614-660`)。
7. **架构约定**:`.vue` 不在 `tsc` 检查范围内,渲染层改动必须跑 `bun run build` 才抓得到错
   (README/ARCHITECTURE §11、以及 2026-09-20 踩过的坑)。

## 3. 设计

### 3.1 模板:拆成「留文档流的 `.meta`」+「浮层 `.status-float`」

`<template v-else>` 内(正常分支)改成:

```html
<div class="meta">
  <span v-if="meta && !meta.exists" class="chip">尚未创建文件(第一次编辑时创建)</span>
  <span v-if="meta?.fromTemplate" class="chip">来自模板 {{ meta.fromTemplate }}</span>
  <span v-if="graphState?.index?.tooLarge" class="chip warn">
    图文件数超过 {{ graphState.index.files }} 上限,反链可能不全
  </span>
  <span v-if="graphState && graphState.dateFormat.ok === false" class="chip warn">
    `:journal/file-name-format` 用了不认识的 token({{ graphState.dateFormat.unsupported }}),新建日志按
    {{ graphState.dateFormat.format }}
  </span>
</div>
```

```html
<!-- 编辑期瞬态状态:固定右下角浮层,不参与文档流 —— 出现/消失不会推动正文(见 .status-float) -->
<div v-if="saving || dirty || externalChanged || message" class="status-float">
  <span v-if="saving" class="chip">保存中…</span>
  <span v-else-if="dirty" class="chip warn">未保存</span>
  <span v-if="externalChanged" class="chip warn">外部已改动</span>
  <span v-if="message" class="chip error">{{ message }}</span>
</div>
```

要点:
- 浮层放在 `</main>` 之后(位置由 `fixed` 决定,放哪都一样,放尾部语义更清楚),**必须在 `<template v-else>` 内** ——
  `.notice` 分支(无图/停用/整页错误)不需要它,`fail()` 会把 `status` 变成 `error` 而整块 `v-else` 卸载。
- 用 `v-if` 而不是 `v-show`:没有状态时连空容器都不渲染,不会留下一个吃点击的 `fixed` 节点。
- chip 的文案、`v-if`/`v-else-if` 的相对关系逐字保留,只换父容器。

### 3.2 CSS(同一个 `<style scoped>` 里)

`.meta`(`JournalView.vue:1009`)加一行最小高度:

```css
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 24px; /* 钉住单行高度:chip 全部消失时也不塌下去(=首次保存成功后不跳一下) */
  padding: 6px 20px 0;
}
```

新增浮层样式(放在 `.chip` 规则之后):

```css
/* 编辑期瞬态状态:固定右下角,不参与文档流 —— 出现/消失不会推动正文(消除抖动) */
.status-float {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 40; /* 高于 header(5)、块建议下拉(20)与搜索下拉(30) */
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
  max-width: min(60vw, 420px);
  pointer-events: none; /* 只有 chip 本体吃事件,容器不挡正文 */
}

.status-float .chip {
  max-width: 100%;
  padding: 3px 8px;
  white-space: normal; /* 保存失败的异常文本可能很长:换行而不是拉宽出屏 */
  background: var(--bg3); /* 默认 --bg2 与页面底色太近,浮在正文上要更亮一档 */
  border-radius: 4px;
  box-shadow: 0 2px 10px rgb(0 0 0 / 35%);
  pointer-events: auto;
}
```

- 选择器权重 `.status-float .chip`(0,2,0)> `.chip`(0,1,0),只覆盖上面写明的属性;
  `.chip.warn` / `.chip.error` 的 `color` / `border-color` 照旧生效。
- 多个状态同时在(例:`未保存` + `外部已改动` + 错误)时纵向堆叠、右对齐,不会横向把窗口撑开。
- 不用 `transform`/动画:出现/消失不需要过渡,避免引入 `prefers-reduced-motion` 之类的额外考虑。

### 3.3 换页清空 `message`

`loadResult()`(`JournalView.vue:137`)里增加 `message.value = ''`。这样:
- 切页 / 点「重新载入」 / 冲突横幅的「用磁盘版本重载」「强行覆盖」之后,旧的失败提示不再残留;
- `fail()` 走的整页错误分支不受影响(`fail` 不经过 `loadResult`);
- `pickGraph` / `switchGraph` 失败仍会先设 `message` 并保持(它们成功时才 `openView` → `loadResult` 清空)。

### 3.4 调试把手补 `saving`

`exposeDebugHandle()`(`JournalView.vue:614`)里加:

```ts
get saving() {
  return saving.value
}
```

E2E 要断言「保存中…」这一态必须有它(现在只能靠 `dirty` 反推);对既有断言无影响。

## 4. 实施步骤(每步独立可验证)

| # | 动作 | 文件 | 验证 |
| - | ---- | ---- | ---- |
| 1 | 拆分模板:`.meta` 只留 4 类持久 chip,新增 `.status-float` 浮层(§3.1) | `src/plugins/logseq/ui/JournalView.vue` | `bun run build` 过;页面上编辑一次,正文首行位置不动 |
| 2 | 加 `.meta { min-height: 24px }` 与 `.status-float` / `.status-float .chip` 样式(§3.2) | 同上 | 浮层在右下角、底色可辨、不随滚动移动;`.meta` 空时也占一行 |
| 3 | `loadResult()` 清 `message`(§3.3) | 同上 | 保存失败后切页 → 浮层不再显示旧错误 |
| 4 | 调试把手补 `saving`(§3.4) | 同上 | `page.eval('window.__bowLogseq.saving')` 可读 |
| 5 | README 笔记插件小节加一句浮层约定(可选:`ARCHITECTURE.md §13` 记一条 UI 反模式) | `README.md`(可选 `docs/ARCHITECTURE.md`) | 文档与实际一致 |
| 6 | E2E 新增断言并跑(§5) | `/mnt/d/tmp/logseq-e2e-wsl.mjs`(工作区外,用户侧) | 46 基线 + 新增若干条全绿 |

## 5. 验证

1. `bun run typecheck`(把手新增字段)。
2. **`bun run build`(必跑)**:`.vue` 不在 `tsc` 覆盖内,模板/CSS 写错只有 build 抓得到。
3. `bun run test` → 期望仍是 **43 文件 / 838 例**(本改动不含纯函数逻辑,不新增单测)。
4. `/mnt/d/tmp/logseq-e2e-wsl.mjs`(WSL,`DISPLAY=:0`)新增断言,建议:
   - 在已有页面上改一行(触发 `dirty`)→
     `document.querySelector('.status-float')` 存在且文本含「未保存」;
   - **核心判据(直接证「不抖动」)**:记录 `document.querySelector('.blocks').getBoundingClientRect().top`
     —— 浮层出现前后必须**完全相等**;再取 `.status-float.parentElement` 的 `position` 为 `fixed`;
   - `window.__bowLogseq.save()` 跑完 → 浮层消失(`.status-float` 为 `null`)且 `dirty === false`;
   - 未创建文件的日期页(若图里已有)断言「尚未创建文件」在 `.meta` 里出现、不在 `.status-float` 内。
5. 手动看一眼:编辑时正文首行不动、浮层不挡最后一行文字(右下角 16px 内边距)、滚动时浮层不移动。

## 6. 风险与未知

- **`.meta` 常驻 24px 空白**:这是「钉最小高度」的代价(用户已确认该方案)。好处是首次保存成功后不再跳。
- **长警告折行**:「图文件数超限」「日期格式警告」文本超过一行时 `.meta` 仍会撑高 —— 但它们只在载入/切图时确定,
  不参与编辑循环,接受的抖动频率≈0。
- **与块内建议下拉的层叠**:`BlockRow.vue:372` 有 `z-index: 20` 的浮层(靠近光标)。浮层设 40 会在极偶然的
  右下角重叠中盖住它。若实际碍事,可把浮层降到 10(header 为 5)。
- **长错误消息**在右下角会盖住末尾少量文本(约 `max-width: min(60vw,420px)` 宽度);`pointer-events` 只给 chip
  本体,不会拦住旁边的点击。可接受。
- **真机未验**:Windows(`D:\Workspace\browser` 是落后 3 个提交的另一份检出)与 mac 未跑;本轮只跑 WSL E2E。
- **E2E 脚本在工作区外**(`/mnt/d/tmp/`),需要用户侧同步脚本;若不同步,本次只有 build + 手动看。

## 7. 相关文档

- 计划:`2026-09-20-logseq-plugin/plan.md`(插件总体)、`2026-09-20-logseq-line-markdown/plan.md`(行级渲染)。
- 约定:`.vue` 改动必须跑 `bun run build`(ARCHITECTURE §11 与 MEMORY)。

## 8. 实施记录(2026-09-20)

**落地清单**(与 §4 一致,无功能偏差):

- `src/plugins/logseq/ui/JournalView.vue`:
  - 模板:`.meta` 只留 4 类低频 chip;新增 `</main>` 之后的 `.status-float` 浮层(§3.1);
  - CSS:`.meta { min-height: 24px }`;`.status-float`(fixed / right 16 / bottom 16 / z-index 40 /
    `pointer-events: none` 容器)+ `.status-float .chip`(`--bg3` 底 + 阴影 + `pointer-events: auto`)(§3.2);
  - `loadResult()` 补 `message.value = ''`(§3.3);调试把手补 `saving`(§3.4)。
- `README.md`:笔记插件小节新增「状态提示是浮层」一条。
- `/mnt/d/tmp/logseq-e2e-wsl.mjs`:新增 §M(8 条断言)。

**与计划的偏差 / 新发现**:

1. **ARCHITECTURE.md 未改**(计划里标为可选)。§13 的分类标题与编号本来就已经错乱(「架构层」1–10 之后
   夹着无标题的 5、6,紧接着又开「开发层」7–12),单加一条只会加剧混乱;约定写进 README 与本文件即可。
2. **E2E 顺带看到浮层会短暂显示「未保存 + 外部已改动」**:§M 探针打字时,同一轮里 §L 写回 MD 文件的
   `graph-changed` 事件刚好到达(`dirty === true` ⇒ `externalChanged = true`)。保存成功后 `doSave` 会清零,
   所以终态正确 —— 这是**既有**行为(不是本次引入),E2E 序列里的 `未保存外部已改动 | 保存中…外部已改动`
   正好证明了多 chip 纵向堆叠不会横向撑开窗口。

**验证结果**:

- `bun run typecheck` / `bun run build` 均过(改的是 `.vue`,build 是必跑项)。
- `bun run test`:**43 文件 / 838 例**(与基线一致,本改动不含纯函数逻辑,未新增单测)。
  - 全量跑时 `tests/logseqPlugin.test.ts` 的「mtime 变了就报冲突」会偶发失败(WSL 的 `/tmp` 是 tmpfs,
    粗粒度时间戳:读 → 立刻写可能落在同一个 tick,而产品侧判据容忍 ±1ms 的舍入)⇒ 实测约 1/8 复现,
    与本次改动无关(插件主进程代码逐字节未动)。**已当场修掉**,见下面「计划外的一处修复」。
- `/mnt/d/tmp/logseq-e2e-wsl.mjs`:**54/54 ×2**(基线 46,新增 §M 8 条)。核心判据实测:
  `blocksTopBefore=77`,`floatTops=[77,77,77,77,77]` ⇒ 浮层出现/消失全程正文起点一动不动;
  `getComputedStyle(.status-float).position === 'fixed'`;浮层文本序列 `'' | 未保存 | 未保存外部已改动 |
  保存中…外部已改动 | ''`(没有「已保存」)。
- Windows 真机 / mac 真机未跑(E2E 脚本只在 WSL 侧)。

**计划外的一处修复(2026-09-20,验证阶段顺手做)**:

- `tests/logseqPlugin.test.ts` 的冲突用例把前置条件从「靠时间流逝让 mtime 变」改成**显式
  `utimesSync(before.path, before.mtimeMs + 2000, …)`** —— 确定性,不再依赖文件系统时间戳粒度。
  证据:修前 8 次单跑挂 1 次;修后该文件连跑 **15 次全绿**、全量连跑 **3 次全绿**。
- 产品侧判据不动(`main.ts:414` 的 `Math.abs(diskMtime - base) > 1`):±1ms 容忍本身是为了吸收
  文件系统舍入,该改的是测试的构造,不是把判据改严。
