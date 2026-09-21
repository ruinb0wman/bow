# 笔记插件三项:`|` 表格渲染 / 多块整块选中 / `Ctrl+Enter` 块内换行

日期:2026-09-21 · 插件:`src/plugins/logseq`(`bow://logseq`)

## 1. 目标与假设

1. **表格没有渲染** —— 现在 `| a | b |` 这类行落进 `plain`,按纯文本显示。要按 Logseq/CommonMark 的**严格**判据渲染成表格(表头行 + `|---|` 分隔行,支持 `:---` / `:---:` / `---:` 对齐)。
2. **不能跨多个块整块选中** —— 要按 Logseq 的手感:**从块左侧的圆点/折叠区按住拖动选中连续多个块**,然后能**删除 / 复制为 markdown / 剪切 / 整组缩进·反缩进**,`Esc` 或点空白处清除。
3. **回车建新块,想要 `Ctrl+Enter` 块内换行** —— 用户实测 `Shift+Enter` 无效。

用户拍板的四项(2026-09-21):

| 问题 | 拍板 |
| --- | --- |
| 「不能选择多行」 | 指**跨多个块整块选中**(不是渲染态拖选文本) |
| 表格判据 | **严格**(必须有 `\|---\|` 分隔行)+ 支持对齐 |
| 换行键 | **保留 `Shift+Enter`**,但主推 `Ctrl/Cmd+Enter` |
| 多块操作 | 删除 + 复制 markdown + 整组缩进/反缩进 + 剪切 |
| 选中入口 | **只做「从圆点拖选」**(Shift+点圆点 / 键盘扩选不做) |
| 点表格单元格 | 光标落**该表格行的行尾**(与现有「点击落行尾」一致) |

假设(需要实现时验证):

- **`Shift+Enter` 为什么无效**:用户描述是「按下后右下角出现『未保存』,然后光标失去焦点」——这正是 `new-sibling` 那条路的特征(`JournalView.commit()` 把 `editingKey` 换成新块 ⇒ 旧 `<textarea>` 卸载 ⇒ 焦点丢 + `dirty=true`)。最可能是中文输入法把单按 `Shift` 当「中/英切换」吃掉,`Enter` 到达页面时 `shiftKey === false`(输入法没置 `isComposing`),于是走成了「新建块」。**这一点不改代码也就无法从页面侧补救**(修饰键信息已经丢了),所以主推 `Ctrl+Enter`。
- `Ctrl+Enter` **今天其实已经能用**(没有任何分支拦它 ⇒ textarea 默认插入 `\n` ⇒ `@input` ⇒ `setBlockContentLines`)。本次要把它变成**显式、确定**的绑定:补 `preventDefault` + 光标、不被 `[[` 补全下拉吞掉、写进 README。
- 顺带修两个相邻的键位问题(低风险,写进测试/文档):① `[[` 补全下拉打开时 `Ctrl+Enter` 会被当成「采纳建议」;② 输入法组合中(`isComposing` / `keyCode 229`)的 `Enter` 不该被当成建新块。

---

## 2. 现状(逐字引用真正读过的代码)

### 2.1 表格

`src/plugins/logseq/format.ts` 的行级判据只有这些,`|` 不在其中:

```ts
export type LineMarkKind = 'plain' | 'heading' | 'task' | 'quote' | 'bullet' | 'ordered' | 'hr' | 'fence'
/** 只看**行首前缀**判断行级标记(不处理围栏的跨行状态,那是 `analyzeBlockLines` 的事)。 */
export function matchLineMark(text: string): LineMark {
  ...
  return { kind: 'plain', raw: '' }
}
```

`analyzeBlockLines()` 是目前唯一的跨行状态机(只有围栏),它给每行算出 `base`/`tokens`,并维持不变式
「`mark.raw + tokensToRaw(tokens) === 整行原文`」(测试 `tests/logseqFormat.test.ts:256`)。渲染入口是
`BlockRow.vue` 的 `v-for="(line, index) in renderLines"` → `<MarkdownLine>`。

### 2.2 选中

`BlockRow.vue` 现在**没有任何块级选区概念**:

```html
<div class="block-gutter" :style="{ paddingLeft: `${depth * 18}px` }">
  <button v-if="childCount > 0" class="collapse" ... @click.stop="emit('action', { type: 'toggle-collapse', ... })">
  <span v-else class="collapse placeholder"></span>
  <span class="bullet" :class="{ collapsed }" @click.stop="emit('action', { type: 'toggle-collapse', ... })"></span>
</div>
```

`JournalView.vue` 持有唯一可变状态(`file`/`editingKey`/`collapsed`/undo 栈)与 `visibleRows` 计算属性;
`onBlockAction()` 是全部块操作的分发点;`onWindowKeydown()` 是页面级键位(capture)。

⚠️ 项目里最容易写错的一处(见 `shared.ts` 的注释):`topBlocks()` 返回的是**派生新数组**,顶层结构改动必须走
`insertTopBlock()` / `removeTopBlock()`(entries 感知)。

### 2.3 换行

`BlockRow.vue` 的 `onKeydown()`:

```ts
if (suggestions.value.length > 0 && (event.key === 'Enter' || event.key === 'Tab')) { ...采纳建议... }

if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
  event.preventDefault()
  const atEnd = caret >= draft.value.length
  emit('action', atEnd ? { type: 'new-sibling', ... } : { type: 'split', ... })
  return
}

if (event.key === 'Enter' && event.shiftKey) { ...插入 '\n'... }
```

`JournalView.commit()`:

```ts
if (result.focusKey) { editingKey.value = result.focusKey; caretIntent.value = null }
```

—— 这就是「Shift 被输入法吃掉 ⇒ 变成普通 Enter ⇒ 新建块 ⇒ `editingKey` 换块 ⇒ textarea 卸载 ⇒ 焦点丢 + 未保存」的完整链路。

---

## 3. 设计

### 3.1 表格(严格判据)

判据与渲染都放在 `format.ts`(纯逻辑,可单测),组件只负责画:

- **一行是表格行**:去掉前导空白后以 `|` 开头,且至少 2 个 `|`(即 ≥1 个单元格)。
- **是表格**:第 `i` 行是表格行、第 `i+1` 行的每个单元格都匹配 `^:?-{2,}:?$`(分隔行)⇒ 从 `i` 起进入表格状态;后续连续的表格行都算 body;第一个非表格行 / 空行 / 围栏行结束表格。
- **对齐**:分隔行的 `:--` / `--:` / `:--:` → left / right / center,其余 `null`。按列号作用到 `<th>`/`<td>`。
- **单元格**:按未转义的 `|` 切分,content 去首尾空白后 `tokenizeInline(content, base + contentStart)` ⇒ 单元格里 `[[双链]]` / `#标签` / 粗体照旧可点(与正文同一套 token)。
- **围栏优先**:`|` 行在 ``` 围栏内 ⇒ 仍是代码(沿用现有 `open` 状态,表格检测放在围栏分支之后)。
- **不是表格**:只有表头行、没有分隔行(或分隔行没有表头)⇒ 全部退回 `plain`,与今天行为一致。

数据结构:

```ts
export type TableAlign = 'left' | 'center' | 'right' | null
export interface TableCell { text: string; srcStart: number; srcEnd: number; align: TableAlign; tokens: Token[] }
export interface LineMark {
  kind: LineMarkKind            // += 'table'
  raw: string
  role?: 'open'|'content'|'close' | 'header'|'delim'|'row'   // += 表格三型
  cells?: TableCell[]
  ...
}
```

**零丢字不变式照旧成立**:表格行的 `mark.raw = 整行原文`、`tokens = []`(与 `hr` 同款),所以
`mark.raw + tokensToRaw(tokens) === line.text` 不需要改;单元格另行断言 `tokensToRaw(cell.tokens) === cell.text`
且 `line.text.slice(cell.srcStart - line.base, cell.srcEnd - line.base) === cell.text`。

渲染:`format.ts` 新增 `groupBlockLines(rendered)` → `Array<{kind:'line',line} | {kind:'table',rows}>`
(纯函数,可单测)。`BlockRow.vue` 用分组替代今天的逐行 `v-for`,表格组交给新组件 `MarkdownTable.vue`:

- 真 `<table>`,每行 `<tr :data-line="row.index" :data-base :data-end>` ⇒ 现有 `startEdit()` 的
  `target.closest('[data-line]')` 照旧命中,光标落**该表格行行尾**(用户拍板)。
- `<thead>` 放表头行,分隔行**不画**(只取它的对齐);`<tbody>` 放其余行。
- 列数取分隔行列数;短行补空单元格,长行多出来的单元格**照画不截断**(渲染不丢内容)。
- 外层 `overflow-x: auto` 容器 + `border-collapse: collapse`,防止宽表把正文撑出页面。

### 3.2 多块整块选中

**状态**(`JournalView.vue`,唯一状态源):

```ts
const selection = ref<{ anchor: string; focus: string } | null>(null)
const selectedKeys = computed<string[]>(...)   // visibleRows 里 anchor..focus 之间的连续区间(含端点)
```

**拖选入口**(只做「从圆点拖选」):

1. `BlockRow.vue` 的 `.block-gutter` 加 `@mousedown` → `emit('action', { type: 'select-start', key })`;`.block-gutter { user-select: none }`(避免拖动时选中旁边文字)。
2. `JournalView` 收到 `select-start` 后进入拖选态:在 `window` 上挂 `mousemove`/`mouseup`;
   `mousemove` 用 `document.elementFromPoint(x, y)?.closest('.block-row[data-key]')` 取当前块 → 更新 `focus`。
3. `mouseup`:若 `focus !== anchor` ⇒ 保留选区,并**吃掉随后那一次 `click`**(capture 阶段的一次性拦截,否则松手点会触发圆点的折叠或渲染态的 `startEdit`);若没移动过 ⇒ 清掉选区,`click` 照旧走「点圆点 = 折叠」。
4. 不实现拖动到视口边缘自动滚动(记为「不做的事」)。

**键位**(`onWindowKeydown`,capture;选区非空时优先处理,处理掉就 `return`):

| 键 | 行为 |
| --- | --- |
| `Esc` | 清除选区 |
| `Backspace` / `Delete` | 删除选中块(含子块) |
| `Ctrl/Cmd+C` | 复制为 Logseq markdown → `api.writeClipboardText()`(preload 已暴露) |
| `Ctrl/Cmd+X` | 复制 + 删除 |
| `Tab` / `Shift+Tab` | 整组缩进 / 反缩进 |
| `Ctrl/Cmd+Z` / `Shift+Ctrl/Cmd+Z` | 走现有整篇快照 undo/redo(顺手清选区) |

清除选区的时机:拖选换成新选区、`Esc`、点空白/正文的 `mousedown`、任何 `commit()` 结构改动之后、undo/redo、换页(`openView`/`loadResult`)。

**视觉**:`.block-row.selected` 加一层强调色背景(与 `--accent` 混色);右下角状态浮层(`.status-float`)多一个 chip「已选 N 块」。

**纯命令**(`shared.ts`,与现有 `indentBlock`/`deleteBlock` 并列):

```ts
export function deleteBlocks(file: ParsedFile, keys: readonly string[]): EditResult
export function indentBlocks(file: ParsedFile, keys: readonly string[]): EditResult
export function outdentBlocks(file: ParsedFile, keys: readonly string[]): EditResult
export function blocksToMarkdown(file: ParsedFile, keys: readonly string[]): string
```

实现要点:

- 先算**选中根**(`selectedRoots`):按文档顺序取「祖先未被选中」的块 ⇒ 选中父块时子块随子树一起动/删/复制,不会对子块重复操作。
- **不能用 key 链式调用 `indentBlock()`**:每次 `reindex()` 都会重排 key,第二个块的旧 key 会指向别的块(实测推演:`[P,B,C]` 缩进 B 之后,`C` 的旧 key 已经指不到 C)。所以批量操作内部改用**对象引用**定位(`locateRef`)。
- 顶层块的摘除/插入必须走 entries 感知的助手(新增一个内部 `detachBlocks(file, blocks)` 按对象同一性过滤 `entries` 与各层 `children`,复用 `insertTopBlock` 做插入)。
- **整组缩进**:要求选中的根是**同一 list 里连续的同级兄弟**(含只有 1 个根的情形;混合层级的选区直接 no-op,写进文档)。目标父块 = 组里第一个根的前一个兄弟;没有前一个兄弟 ⇒ 不动。摘除整组后按顺序 push 进目标父块的 `children`,每个块 `alignIndent()` 到「目标父块缩进 + 一个缩进单元」(复用现有 `shiftIndentLines` 语义,整棵子树跟着移)。
- **整组反缩进**:父块为 `null` ⇒ no-op。摘除整组后按**原顺序**插到父块在原 list 中的下一个位置(嵌套走 `parent.children.splice`,顶层走 `insertTopBlock`),缩进对齐到「祖父缩进 + 一个单元」。
- **复制**:`serializeLogseqFile({ entries: roots.map(b => ({kind:'block', block:b})) })`,末尾补该文件的行尾(`fileEol`)使其以换行结束;嵌套块保留自己的原始缩进(与 Logseq 的「复制就是复制原文」一致)。
- **删除**:过滤后若一个块都不剩 ⇒ 补一个空块(与 `loadRaw()` 的「空页面也得有地方输入」同一不变式);`EditResult.focusKey` 给第一个被删块的前一个兄弟。
  (`deleteBlock()` 单个删除没有这个兜底 —— 既有缺口,本次不动,记在「不做的事」。)

### 3.3 `Ctrl+Enter`

`BlockRow.vue` 的 `onKeydown()` 改成:

```ts
// 输入法组合中的按键一律交给 IME(否则中文输入时用于「上屏」的回车会建块)
if (event.isComposing || event.keyCode === 229) return

if (suggestions.value.length > 0 && (event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.metaKey) { ...采纳建议... }

// 新建块只认「裸 Enter」;Shift+Enter 与本行的 Ctrl/Cmd+Enter 都是块内换行
if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) { ...new-sibling / split... }
if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey)) { ...插入 '\n'... }
```

- 分支顺序 = 把现在的 Shift 分支扩成「Shift 或 Ctrl/Cmd」,`preventDefault` + 手动插入 `\n` + 光标落在换行后 + `emit input`。
- `Ctrl+Enter` 原来靠浏览器默认就「碰巧能用」,改完是**显式**的:补全下拉打开时也不再被吞。
- `Alt+Enter` 不加(用户拍板)。

### 3.4 顺带修的相邻 bug:渲染态拖选文本

`BlockRow.vue` 的 `startEdit()` 现在是:

```ts
function startEdit(event: MouseEvent): void {
  if (props.editing) return
  const end = target?.closest('[data-line]')?.getAttribute('data-end')
  emit('action', { type: 'start-edit', ... })
}
```

浏览器在「拖选文本后松手」时**仍会派发 click**(此时选区还是非折叠的),于是立刻切进编辑态、选区丢失。加一行守卫:

```ts
if (!window.getSelection()?.isCollapsed) return   // 拖选文本的那次 click 不该进编辑态
```

单点一下(没有拖选)= 选区已折叠 ⇒ 行为不变。这条也让「拖着选文字」和「从圆点拖选块」两套手势互不打架。

---

## 4. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/plugins/logseq/format.ts` | `LineMarkKind += 'table'`;`TableCell` / `TableAlign` / `LineMark.cells` / `role` 扩展;新增 `matchTableDelimiter()`、`splitTableRow()`、`groupBlockLines()` 与 `RenderedGroup`;`analyzeBlockLines()` 改索引循环 + 表格状态机(围栏之后);更新文件头与 `LineMark` 的注释 |
| `src/plugins/logseq/shared.ts` | 新增 `deleteBlocks()` / `indentBlocks()` / `outdentBlocks()` / `blocksToMarkdown()`,内部新增 `selectedRoots()` / `locateRef()` / `detachBlocks()`(顶层 entries 感知),复用 `insertTopBlock()`、`alignIndent()`、`reindex()` |
| `src/plugins/logseq/ui/MarkdownTable.vue` | **新文件**:分组后的表格行 → 真 `<table>`;表头/分隔行/正文行;对齐;行上保留 `data-line`/`data-base`/`data-end`;`open-page`/`open-url` 透传 |
| `src/plugins/logseq/ui/BlockRow.vue` | ① 新 prop `selected`;② `.block-gutter` 的 `mousedown` → `select-start`(加 `user-select:none`);③ 模板改用 `groupBlockLines()` 分组,表格组交给 `MarkdownTable`;④ `startEdit()` 加选区守卫;⑤ `onKeydown()`:IME 守卫、补全分支排除 Ctrl/Meta、`Ctrl/Cmd+Enter` 换行;⑥ 头部注释同步 |
| `src/plugins/logseq/ui/JournalView.vue` | 选区状态 + 拖选机器(mousemove/mouseup/一次性 click 拦截)+ 选区键位 + 剪贴板 + chip + `:selected`;`commit()`/`undo()`/`redo()`/`loadResult()` 清选区;`onBeforeUnmount` 摘监听 |
| `tests/logseqFormat.test.ts` | 表格:判据(有/无分隔行)、对齐、单元格 token 与偏移、围栏内的 `\|` 行不算表、残缺行列数、`groupBlockLines()` 分组、零丢字仍成立 |
| `tests/logseqShared.test.ts` | `deleteBlocks`(子树 / 顺序 / raw 条目不受影响 / 全删补空块 / 不存在的 key)、`indentBlocks` / `outdentBlocks`(同级连续组的顺序、顶层走 entries、混合层级 no-op、第一个兄弟 no-op)、`blocksToMarkdown`(逐字节、尾换行)、全部纯函数(不动输入文件) |
| `README.md` §笔记 | 「渲染」补 `\|` 表格(严格判据/对齐);「块编辑」补 `Ctrl/Cmd+Enter` 块内换行(并说明 `Shift+Enter` 在中文输入法下可能收不到);新增一段「多块选中」(圆点拖选 / Del / Ctrl+C / Ctrl+X / Tab / Shift+Tab / Esc);「不做的事」按需补 |
| `docs/ARCHITECTURE.md` §5.8 不变式表第 4 行 | 「行级标记」那句补上表格(`mark.raw` = 整行、单元格另证);`ui/*.vue` 无需改动(未逐组件枚举) |

无需改动:`internalPages.ts` / 注册表 / tsconfig / preload(剪贴板 API 已有)/ `main.ts` / `graph.ts`。

---

## 5. 实施步骤(每步都能单独验证)

1. **`format.ts` 表格判据 + 分组**(纯函数)。
   验证:`npx vitest run tests/logseqFormat.test.ts`(表格新用例 + 既有零丢字/围栏用例全绿)。
2. **`MarkdownTable.vue` + `BlockRow.vue` 分组渲染**。
   验证:`npm run typecheck` + `npm run build`,然后在 `bow://logseq` 里手看一张 Logseq 写的表格。
3. **`format.ts`/`shared.ts` 批量命令**(4 个纯函数)。
   验证:`npx vitest run tests/logseqShared.test.ts`。
4. **`JournalView.vue` 选区状态 + 拖选机器 + 键位 + 剪贴板 + chip**。
   验证:`npm run typecheck` + `npm run build`。
5. **`BlockRow.vue` 键位**(IME 守卫、`Ctrl+Enter`、选区守卫)。
   验证:`npm run build`。
6. **E2E 扩写**:`/mnt/d/tmp/logseq-e2e-wsl.mjs` 补三组判据(见 §6.2),跑通。
7. **pre-fix 红测**:`git checkout HEAD~1 -- src` → `npm run build` → 跑 E2E,确认**只有新判据红**;
   然后 `git checkout HEAD -- src` → **重建**(否则 `out/` 留在 pre-fix 状态,这是上次踩过的坑)。
8. **全量回归**:`bun run test`(基线 **45 文件 / 882 例**)、`npm run typecheck`、既有 E2E 用例。
9. **文档**:README §笔记 + ARCHITECTURE §5.8;把本计划 §6 的实测结果写回本文件。

---

## 6. 验证

### 6.1 单测(纯逻辑,node 环境,无 DOM)

- `logseqFormat.test.ts` 新增:
  - `analyzeBlockLines(['| a | b |', '| --- | ---: |', '| 1 | 2 |'])` → `kind` 全为 `table`、`role` = `header`/`delim`/`row`;第 2 列对齐 `right`;单元格 token 能识别 `[[页]]` 且 `srcStart` 是全局偏移。
  - 只有 `| a | b |`(后面不是分隔行)⇒ `plain`;只有 `|---|` ⇒ `plain`。
  - 表格在 ``` 围栏里 ⇒ 仍为 `fence`。
  - 行数不齐(3 列分隔、2 列数据)⇒ 不抛异常、列数按分隔行。
  - `groupBlockLines()` 把连续表格行合成一组,其余行各占一组。
- `logseqShared.test.ts` 新增:见 §4 那一行。

### 6.2 E2E(`/mnt/d/tmp/logseq-e2e-wsl.mjs`,WSL 侧真跑 Electron)

新 fixture 页(例如 `pages/md-table.md`):一个表格块 + 4 个同级块(用来拖选)。

- **§Q 表格**:`document.querySelectorAll('.md-table tr')` 行数 = 表头+数据行(分隔行不画);表头文本/对齐样式;表格块渲染后**磁盘文件逐字节未变**(渲染不改写);点某个单元格 → 出现 textarea 且 `selectionStart === ` 该行 `data-end`。
- **§R `Ctrl+Enter`**:进编辑态 → 输入 → `pressKey({key:'Enter', modifiers:2})` → textarea 含 `\n`、`window.__bowLogseq.rows.length` 不变;`save()` 后文件里是**内容行**(缩进续行)而不是新的 `- ` 行。同时验 `Shift+Enter`(modifiers=8)等价(回归,防这次改动打坏它)。
- **§S 多块选中**:用 `Input.dispatchMouseEvent`(mousePressed → mouseMoved → mouseReleased)从块 0 的圆点拖到块 2 的圆点 ⇒ `.block-row.selected` 数量 = 3、chip 显示「已选 3 块」;`Ctrl+C` → `browserAPI.readClipboardText()` 等于这 3 块的 markdown;`Delete` → 行数减少且 `save()` 后文件里这 3 块消失;`Ctrl+Z` → 恢复;再拖选 → `Tab` → 文件里整组多一层缩进;`Shift+Tab` → 还原;`Esc` → 选区清空。
- **回归**:渲染态单点仍能进编辑态;拖圆点选块**不会**进编辑态、也不会误触发折叠。

### 6.3 命令与基线

- `npm run typecheck`、`npm run build`、`bun run test`(基线 **45 文件 / 882 例**,只应增加)。
- E2E 前必须 `npm run build`(脚本跑的是 `out/`);Windows 侧等价脚本仍未建立(沿用现状,只跑 WSL)。

---

## 7. 风险与未知

1. **「Shift+Enter 无效」的根因未在真机证实**(计划里只是最可能解释)。若实际是别的原因,`Ctrl+Enter` 仍然可用,但 `Shift+Enter` 的分支是否要留需要再看。
2. **表格判据可能漏 Logseq 的写法**:本计划要求「去掉前导空白后以 `|` 开头」。若用户的图里存在「首尾都不带 `|`」或「用 `\|` 转义 + 单元格里含 `|` / 反引号内 `|`」的表,会退化成纯文本或切错列。**只渲染、不写回**,不会破坏文件;真机验证时拿用户真实的表格看一眼。
3. **整组缩进要求同级连续**:混合深度的选区直接 no-op(不报错)。若用户实际常用混合选区,需要再加一轮定义。
4. **拖选不自动滚动**:块多到超出视口时只能拖到可见范围。
5. **`Ctrl+C` 复制的是原始 markdown**(嵌套块保留原缩进),不是「渲染文本」;嵌套块会在剪贴板里带上前导空格。
6. **多块选区与既有键位的边界**:`Ctrl+X` / `Delete` 只在有块选区时接管,文本编辑态(无块选区)行为不变;`Tab` 在有块选区时不再切焦点(这正是期望)。
7. 组件层没有单测环境(vitest 是 node,无 DOM)⇒ 交互只能靠 E2E 兜,迭代成本比纯函数高。

## 8. 不做的事(明确排除)

- Shift+点圆点扩选、`Shift+↑/↓` 键盘扩选、拖动整组到别处(拖拽排序)、移动端/触屏。
- 输入法组合期间的选区/表格行为只做「放行给 IME」,不做逐 IME 适配。
- 表格的编辑态可视化(编辑态仍是原始 markdown)、列宽调整、单元格内换行/合并。
- `deleteBlock()`(单块删除)删空整页时补空块 —— 既有缺口,本次只保证批量删除不留下空页。
- `((块引用))` / `{{query}}` 等仍未支持(与本计划无关)。

---

## 9. 实施记录(2026-09-21)

### 9.1 结果

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `bun run test` | **45 文件 / 906 例全绿**(基线 45/882 → **+24**:`logseqFormat` 22→32,`logseqShared` 41→55);约 8.7s |
| WSL E2E(`/mnt/d/tmp/logseq-e2e-wsl.mjs`) | **117/117 通过**,连跑 2 次 |
| pre-fix 对照(`git checkout HEAD -- src` + 重建 + 专用副本) | **81/103**;新增判据基本全红(见 9.3) |

改动文件:`format.ts`、`shared.ts`、`ui/BlockRow.vue`、`ui/JournalView.vue`、**新增 `ui/MarkdownTable.vue`**、
`tests/logseqFormat.test.ts`、`tests/logseqShared.test.ts`、`README.md`、`docs/ARCHITECTURE.md`。

### 9.2 §1 的假设更正(重要)

「`Ctrl+Enter` 今天其实已经能用(靠 textarea 默认行为)」**没能证实**:

- 用 CDP 合成按键试过(**既在 E2E 里,也在用户真实的 bow 里**):`Ctrl+Enter` 不换行,**连裸 `Enter` 也不换行** ——
  CDP 的 `Input.dispatchKeyEvent` 只喂 keydown 处理器,**不执行 textarea 的默认编辑动作**。
- 所以 pre-fix 那条 `Ctrl+Enter 在块内插入换行` 的红,有一部分是 CDP 假象,不能推出「真机 Ctrl+Enter 也不换行」。
- **能确定的**:① 页面侧此前没有任何 `Ctrl+Enter` 分支 ⇒ 现在这条绑定是显式、确定的;
  ② `[[` 补全下拉打开时,Ctrl+Enter 以前会被吞成「采纳建议」(`[[md` → `[[md-render]]`),已修(pre-fix 实测红);
  ③ 输入法组合中的 Enter 现在放行给 IME(无法用 CDP 复现,只能靠代码审查+真机)。
- `Shift+Enter` 的真机症状(新建块 + 失焦)**仍未在真机上证实**是输入法吃掉 Shift;本次保留该分支,主推 `Ctrl+Enter`。

### 9.3 pre-fix 红测(证明判据不是空的)

pre-fix 用 `/tmp/logseq-e2e-prefix.mjs`(由 `/tmp/patch-prefix-e2e.mjs` 从正式脚本生成:只把 `waitFor` 超时改成
「记 FAIL 不抛」、给 §Q 的单元格判据加 `row` 守卫,以便跑完全程)。**81/103**,红的正好是新能力:

- **§Q 表格**:`.md-table` 等不到(超时)→ 行数/表头/对齐/`data-line`/点单元格落行尾全红;
  只有「块数没被吃掉 / 不改写文件 / 点单元格不产生写入」三条是平凡 PASS(两边都成立)。
- **§R**:`Ctrl+Enter` 换行红(CDP 假象,见 9.2)、**`补全打开时 Ctrl+Enter 仍然换行` 红(`[[md-render]]`,有效判据)**;
  `Shift+Enter` 绿(回归项,预期两边都绿)。
- **§S**:拖选后 `selectedKeys` 为 `undefined`、`.block-row.selected` = 0、chip 为空、剪贴板没被写入、整组缩进等不到
  → 全红;「拖选不会进编辑态」是平凡 PASS(pre-fix 本来也不会有选区)。

### 9.4 顺带修的测试设施 bug

E2E §N 的「外部改动到达渲染层」把日期**写死**成 `journals/2026-09-19.md`,而脚本里的 `YESTERDAY` 是动态的 ——
今天(09-21)一跑就超时,把整个脚本带走(与本次改动无关)。已改成用 `${YESTERDAY}` 拼。

跑 E2E 前必须 `npm run build`(脚本跑的是 `out/`);pre-fix 跑完必须把 `src/` 还原**并重建**
(否则 `out/` 会留在 pre-fix 状态)—— 本次照做,还原后用 `diff -r` 校验过。

### 9.5 仍未验证 / 真机待办

- **Windows 真机**:需 `wsync` → Windows 侧 `npm run build` → 重启 bow;重点手测 ①中文输入法下 `Ctrl+Enter`
  是否稳定换行 ②从圆点拖选的手感与「点圆点 = 折叠」是否互相干扰 ③表格拿**用户真实的表**(含 `\|` / 反引号内 `|` 的)
  看一眼会不会断列。
- **macOS**:未跑(`Ctrl+Enter` 走的是 `metaKey` 分支,只有代码审查)。
- **IME 组合期间的 Enter 放行**:CDP 复现不了,只能真机试。
