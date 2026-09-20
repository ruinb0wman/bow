# Logseq 笔记插件:行级 markdown 渲染(标题 / 复选框 / 引用 / 列表 / 围栏代码块)

> 起因(用户原话):「logseq 笔记插件在渲染时由于块的存在导致先渲染了 `-`,后续的 `#` `-[]` `>` 都渲染
> 不出来,我需要一个优化方案」。

## 1. 目标

让笔记块的**每一行**都能渲染出行级 markdown 语义,而不只是现在的行内语法:

- `#`~`######` 标题、`---` 水平线;
- `[ ]` / `[x]` 复选框(含 `* [ ]`、`- [ ]`、块首裸 `[ ]`),**可点击勾选并写回文件**;
- `> ` 引用(支持 `>>` 嵌套);
- `* ` / `+ ` / `1. ` 列表标记、``` 围栏代码块;
- 渲染后点击任意一行,光标落到**该行被点中的位置**(现在第 2 行以后是落到第一行末尾)。

**假设(已与用户确认,4 个问卷全取推荐项)**:

1. 上列语法**全做**;
2. 复选框**可点击**,翻转 `[ ]`↔`[x]` 并走与打字相同的防抖保存 + undo 快照;
3. 以 `-` 开头的行被解析成**子块**属于 Logseq 文件图的固有语义,不改解析器;改为**块首文本也按标记渲染**
   (`- [ ] 甲` → 子块文本 `[ ] 甲` → 把复选框画在圆点位置);
4. 点击映射做**精确映射**,并让 `splitBlock` 支持多行劈开。

**非目标**:`TODO/DOING` 关键字、优先级、`#+BEGIN_QUOTE` 语义化(仍原样保留)、`((块引用))` /
`{{query}}`(仍当文本)、表格、脚注、图片内联。这些继续「原样显示、零丢字」。

## 2. 现状与根因(逐条对着读过的代码)

1. **只做了行内 tokenizer,没有行级**。`BlockText.vue` 收到一行文本后只调
   `tokenizeInline(props.text ?? '')`;`RULES` 里只有代码段 / 双链 / `#标签` / 链接 / 裸 URL,
   `EMPHASIS` 只管粗斜删高亮 ⇒ `# 标题`、`> 引用`、`[ ] 甲` 没有一条规则命中,全部落进普通文本。
2. **`#` 标题与 `#标签` 的冲突其实不存在**。标签规则是 ``/#(?<target>[^\s#[\]()`,，。；;]+)/``,
   要求 `#` 后**紧跟非空白**;CommonMark 式标题要求 `#` 后必须有空格 ⇒ `# 标题` 一定是标题、
   `#标签` 一定是标签,两者天然互斥。同理 `##`(无空格)不会变成标题。
3. **`- [ ]` 永远不会作为「块内多行内容」存在**。`format.ts` 的 `BLOCK_LINE_RE = /^([ \t]*)-(?:[ \t]([\s\S]*))?$/`
   会把任何缩进大于本块的 `- …` 行解析成**子块**(`parseBlock`),`blockText` 拿到的是 `[ ] 甲`。
   Logseq 官方文件图里块内的清单**只能用 `* [ ]`**(见 §7 佐证),所以这是格式语义,不该对着改。
4. **第 2 行以后的 `data-src` 是错的(潜在 bug)**。`BlockRow.vue` 对每一行都 `<BlockText :text="line">`,
   `tokenizeInline(line)` 的 `base` 是 0;`startEdit` 因此只对第 0 行用 `data-src`,
   `if (lineIndex > 0) { emit('start-edit', …无 offset…); return }` —— 第 2 行以后点击一律落到第一行末尾。
   做行级渲染(大字号标题、引用缩进)会让这个「跳位置」非常刺眼,必须一起修。
5. **`splitBlock` 只劈第一行**。`shared.ts` 里 `const text = blockText(target.block)` + 
   `at = Math.max(0, Math.min(text.length, offset))` ⇒ 一旦光标能落到第 2 行,回车会把 offset 夹到第一行末尾,
   劈出错误的结果。所以「精确映射」与「多行劈开」必须同批做。
6. **`SourceLine` 是共享对象**。`cloneFile` 只拷贝树结构,`SourceLine` 对象被输入 / 输出共享;
   改任何一行文本**必须换新对象**(`shared.ts` 的注释与 MEMORY 里的不变式)。复选框翻转命令要遵守这一条。

## 3. 设计

### 3.1 行级标记分类器(纯函数,放在 `format.ts`)

不开新文件:`src/plugins/*/format.ts` 已在 `tsconfig.node.json` 与 `tsconfig.web.json` 两处 `include` 里登记,
新文件名会踩「不登记 typecheck 看不到」的坑(见 `2026-09-20-logseq-plugin/plan.md` §3.8)。

```ts
export type LineMarkKind = 'plain' | 'heading' | 'task' | 'quote' | 'bullet' | 'ordered' | 'hr' | 'fence'

export interface LineMark {
  kind: LineMarkKind
  /** 行首被标记吃掉的**原文切片**(渲染时隐藏或替换);`plain` 为 '' */
  raw: string
  level?: number      // heading 1..6
  checked?: boolean   // task
  depth?: number      // quote 嵌套层数(`>>` = 2)
  marker?: string     // bullet 的 `*`/`+`/`-`;ordered 的 `1.`
  fence?: string      // 围栏字符(``` / ~~~),由分组函数补
  role?: 'open' | 'content' | 'close'
}

/** 只看行首前缀,不管围栏状态;不产生 'fence'(围栏要跨行判断) */
export function matchLineMark(text: string): LineMark
```

匹配**顺序即优先级**(每条都锚在 `^`):

1. heading:`/^(#{1,6})(?:[ \t]+|$)/` → `level = m[1].length`, `raw = m[0]`;
2. hr:`/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/` → `raw = 整行`,`rest = ''`;
3. task:`/^([-*+][ \t]+)?\[([ xX])\](?:[ \t]+|$)/` → `checked = m[2].toLowerCase() === 'x'`, `raw = m[0]`
   (**必须在 bullet 之前**,否则 `* [ ]` 会被当成列表项);
4. quote:`/^(>+)[ \t]?/` → `depth = m[1].length`, `raw = m[0]`;
5. bullet:`/^([-*+])[ \t]+/` → `marker = m[1]`;
6. ordered:`/^(\d+[.)])[ \t]+/` → `marker = m[1]`;
7. 否则 `plain`(`raw = ''`)。

**硬不变式(要写单测)**:对任意输入行,`mark.raw + token 的 raw 拼接 === 原文` —— 这是现有
「渲染零丢字」从行内扩展到行级的形态,行内那半条已经由 `tokenizeInline` 保证。

### 3.2 围栏分组 + 全局偏移(`analyzeBlockLines`)

```ts
export interface RenderedLine {
  index: number
  text: string
  /** 本行在 `displayLines.join('\n')`(也就是 textarea 全文)里的起始偏移 */
  base: number
  mark: LineMark
  /** 行首标记之后的剩余文本(已 token 化;围栏内容是纯文本,不 token 化) */
  tokens: Token[]
}

export function analyzeBlockLines(lines: readonly string[]): RenderedLine[]
```

- 顺序遍历,维护 `open: { char: '`' | '~'; len: number } | null`:
  - 未开围栏且本行匹配 `/^[ \t]*(`{3,}|~{3,})(.*)$/` → `mark = { kind:'fence', role:'open', fence:m[1] }`,
    `raw = 整行`,`tokens = []`,记下 char/len;
  - 开着围栏:本行匹配**同字符且长度 ≥ 开启长度**的闭合行 → `role:'close'`,`tokens = []`;
    否则 `role:'content'`,`raw = ''`,`tokens = []`(代码里不解析双链/标签,避免把代码画成可点链接);
  - 其他行 → `matchLineMark`,`tokens = tokenizeInline(text.slice(raw.length), base + raw.length)`;
    `hr` / `fence` 行 `tokens = []`。
- `base` 逐行累加 `text.length + 1`,`index` 即显示行号。
- **未闭合围栏**:后面所有行都按 `content` 处理(CommonMark 行为),不再需要现在 `BlockRow.vue`
  的 `fenced` / `.codeish` 整块等宽字体兜底。

### 3.3 渲染(新组件 `ui/MarkdownLine.vue`)

`BlockRow.vue` 把 `displayLines` 换成 `analyzeBlockLines(displayLines)`;每行仍然是
`<div class="block-line" :data-line="i" :data-base="l.base">`,里面换成
`<MarkdownLine :line="l" :line-index="i" @open-page @open-url @toggle-task @…>`。
`MarkdownLine` 按 `mark.kind` 分派(全部用 `BlockText` 递归渲染行内 token,**继续不 `v-html`**):

| kind | 结构 |
| --- | --- |
| `heading` | `<div class="md-h md-h{level}">` + `BlockText`(字号 1.5/1.3/1.15em,h4~h6 = 1em 加粗) |
| `task` | `<label class="md-task"><input type="checkbox" :checked @change @click.stop> <span :class="{done:checked}">` + `BlockText` |
| `quote` | `<blockquote class="md-quote" :style="{marginLeft:(depth-1)*12+'px'}">` + `BlockText` |
| `bullet` | `<div class="md-li"><span class="md-marker">•</span>` + `BlockText` |
| `ordered` | 同上,`md-marker` 显示 `mark.marker`(`1.`) |
| `hr` | `<hr class="md-hr">` |
| `fence` | `role==='content'` → `<div class="md-code-line">` + `BlockText`(等宽 + 底色);`open`/`close` → 不渲染(围栏行隐藏) |
| `plain` | 直接 `BlockText`(与今天一致) |

- 「块首也按标记渲染」在此自然成立:`- [ ] 甲` 解析出的子块 `blockText` 是 `[ ] 甲`,`matchLineMark`
  命中 task ⇒ 复选框画在**圆点位置**(圆点被替换成复选框),`[ ]` 标记隐藏。`BlockRow` 的圆点
  需要一处判断:块首是 task 时把 `.bullet` 换成同一颗复选框(`props.block` 首行 `blockText` 走
  `matchLineMark`),或者更简单 —— 保留圆点、把复选框画在文本前(见 §6 风险 1,实施时二选一,默认后者)。
- 删掉 `BlockRow.vue` 的 `fenced` computed 与 `.codeish` 类(围栏已由行级分组负责)。

### 3.4 点击映射(精确 + 多行)

- `BlockText.vue` 增加可选 `base?: number` prop,透传给 `tokenizeInline(props.text ?? '', props.base ?? 0)`;
  行级渲染时 `BlockRow` 已经把 `rest` token 化,直接传 `:tokens`,不重复 token 化。
- `BlockRow.startEdit` 改为:
  `const raw = target?.closest('[data-src]')?.getAttribute('data-src') ?? target?.closest('[data-line]')?.getAttribute('data-base')`,
  然后照旧 emit `{type:'start-edit', key, offset: raw ? Number(raw) : undefined}`;**删掉 `lineIndex > 0`
  就退回「无 offset」的分支**。`data-base` 兜住「点在行首空白 / 引用左边框 / 被隐藏的标记行上」的情况。
- `offset` 是 `draft`(`displayLines.join('\n')`)里的偏移,与 `caretIntent → setSelectionRange` 一致。

### 3.5 复选框写回(纯命令 + 一条渲染层动作)

`shared.ts` 新增(遵守「换新对象」不变式):

```ts
/**
 * 翻转块内某一行的任务标记(`[ ]` ↔ `[x]`)。
 * lineIndex 0 = 块头(`- ` 之后,可能是 `[ ] x` 或 `* [ ] x`);>0 = 第 N 条**内容行**。
 * 找不到标记、行号越界、块不存在 → 原样返回同一个 file(调用方据此判断 no-op)。
 */
export function toggleTaskMarker(file: ParsedFile, key: string, lineIndex: number): ParsedFile
```

- 标记正则 `TASK_MARK_RE = /^([-*+][ \t]+)?\[([ xX])\]/`;
- 块头:用 `setHeadText(block, `${indentText(head.text)}- ${flipped}`)`;
- 内容行:`extra` 里按 `kind === 'content'` 计数定位,**替换 `item.line` 为 `{ text: flipped, eol }` 新对象**
  (绝不能原地改 `item.line.text` —— 那个对象是和调用方共享的);
- `JournalView.onBlockAction` 增 `case 'toggle-task'`:
  `const next = toggleTaskMarker(current, payload.key, payload.lineIndex ?? 0); if (next === current) return; commit({ file: next, focusKey: null })`
  —— 复用 `commit()` 的 `pushUndo()` + `dirty` + `scheduleSave()`,undo 语义与打字一致。

### 3.6 多行劈开(`splitBlock` 扩展)

`splitBlock(file, key, offset, unit?)` 增加**可选**第 4 参:

- `unit === undefined`:**保持现有行为**(只劈第一行),现有单测 `splitBlock(file,'1',2)` 不动;
- 传入 `unit` 时,把 `offset` 当成 `blockLinesForDisplay(block, unit).join('\n')` 的偏移:

```
lineIndex = (text.slice(0, at).match(/\n/g) ?? []).length
lineStart = at === 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1
col       = at - lineStart
cur       = lines[lineIndex] ?? ''
before    = [...lines.slice(0, lineIndex), ...(col > 0 ? [cur.slice(0, col)] : [])]
after     = [...(col < cur.length ? [cur.slice(col)] : []), ...lines.slice(lineIndex + 1)]
```

- 左块保留属性行与子块,head = `before[0]`,content = `before.slice(1)`;右块(新块)head = `after[0]`,
  content = `after.slice(1)`;`col === 0` 与 `col === cur.length` 都自然落成「在两行之间劈开」。
- 从 `setBlockContentLines` 里**抽出私有 helper** `writeContentLines(block, lines, indent, unit, eol)`
  (现在的逻辑:插在第一条原有 content 行位置,原有 props 保序留在原位),两个函数共用。
- `JournalView` 调用改成 `splitBlock(current, payload.key, payload.offset ?? 0, unit.value)`。

### 3.7 与块语法的边界(为什么这样切)

- `- ` 行 = 子块(Logseq 语义),`* ` / `+ ` / `1. ` 行可以留在块内做多行内容 —— 所以「块内清单」
  在两边都成立:in-session 时 `* [ ] 甲` 是**内容行**渲染成复选框;`- [ ] 甲` 是**内容行**渲染成
  「复选框」但保存后重新解析会变成**子块**(文本 `[ ] 甲`)—— 因为「块首也按标记渲染」,视觉上仍是复选框,
  只是层级不同。这个「保存前后树结构变了、字节没变」的差异**不做处理**(见 §6 风险 2),写进文档。
- 行级标记只在**行首**生效;`正文里的 > 引用` 不渲染成引用(与 CommonMark 一致)。

## 4. 逐文件改动清单

| 文件 | 改动 |
| --- | --- |
| `src/plugins/logseq/format.ts` | 新增 `LineMark` / `matchLineMark()` / `RenderedLine` / `analyzeBlockLines()`(纯,无 DOM);不改 `tokenizeInline` |
| `src/plugins/logseq/shared.ts` | 新增 `toggleTaskMarker()`;抽出 `writeContentLines()`;`splitBlock()` 增可选 `unit` 参数(多行劈开) |
| `src/plugins/logseq/ui/BlockText.vue` | 新增可选 `base?: number` prop 透传给 `tokenizeInline`(其余不动) |
| `src/plugins/logseq/ui/MarkdownLine.vue`(新) | 按 `kind` 渲染标题/复选框/引用/列表/水平线/代码行 + scoped 样式 |
| `src/plugins/logseq/ui/BlockRow.vue` | `displayLines` → `analyzeBlockLines`;每行加 `:data-base`;`startEdit` 用 `data-src ?? data-base`;新增 `toggle-task` 转发;删 `fenced`/`.codeish` |
| `src/plugins/logseq/ui/JournalView.vue` | `BlockAction` 加 `lineIndex?`;新增 `case 'toggle-task'`(走 `commit`);`splitBlock` 传 `unit.value` |
| `tests/logseqFormat.test.ts` | +`describe('行级标记')`:分类结果、`mark.raw + raw 拼接 === 原文`、`base` 累积、围栏分组(正常/未闭合/`~~~`)、`#标签` 与 `# 标题` 的区分 |
| `tests/logseqShared.test.ts` | +`toggleTaskMarker`(块头 / `* [ ]` 内容行 / 无标记 no-op / 输入文件不被改);+多行 `splitBlock` 用例;display→set 恒等语料加 `* [ ] 甲` 这类行 |
| `README.md` | 「笔记」小节:实时 markdown 描述补行级语法与可点击复选框;「不做的事」里 `TODO` 一句澄清「只有 `[ ]` 复选框,不支持 TODO/DOING 关键字」 |
| `docs/ARCHITECTURE.md` | §5.8 笔记不变式表补一行「行级标记 raw 拼接 === 原文」;§11 用例基线(830 → 实际数)与 `logseqFormat`/`logseqShared` 行的描述 |
| `.pi/plans/2026-09-20-logseq-line-markdown/plan.md` | 本文件(实施后补 §实施记录 + 实测数据) |

**不动**:`main.ts`、`graph.ts`、`ui.ts`、渲染入口、`tsconfig.*`、`src/shared/*`、其他插件。

## 5. 分步实施(每步可独立验证)

| 步骤 | 内容 | 验证 |
| --- | --- | --- |
| **S1** | `format.ts`:`LineMark` / `matchLineMark` / `analyzeBlockLines` + `logseqFormat.test.ts` 新用例 | `bun run test` 里 `logseqFormat` 全绿(含行级零丢字与 base 断言) |
| **S2** | `shared.ts`:`writeContentLines` 抽取、`splitBlock(…, unit)`、`toggleTaskMarker` + `logseqShared.test.ts` 新用例(含「输入文件是纯函数不改动」) | `bun run test` 里 `logseqShared` 全绿;现有 `splitBlock` 用例逐字节不变 |
| **S3** | `MarkdownLine.vue` + `BlockText.vue` 的 `base` + `BlockRow.vue` 接线(含 `data-base`、`startEdit`) | `bun run typecheck` 与 **`bun run build`**(`.vue` 只有 build 会报错)都要过 |
| **S4** | `JournalView.vue`:`toggle-task` 动作 + `splitBlock` 传 `unit` | `bun run build` 过;真机点复选框 → 文件里 `[ ]`↔`[x]`,`Ctrl+Z` 能回退 |
| **S5** | 真机 E2E:在 `/mnt/d/tmp/logseq-e2e-wsl.mjs` 加一段(块内 `# 标题` 字号变大、`> 引用` 有左边框、`* [ ] 甲` 出现 checkbox、点勾选后**磁盘文件**含 `[x]`、点第 3 行标题后回车在正确位置劈开) | E2E 脚本全绿 ×2;主进程日志无 `未捕获异常` |
| **S6** | 文档(README + ARCHITECTURE §5.8/§11)+ 全量回归 + 本文件 §实施记录 | `bun run test` 全绿;`terminal-e2e` / `nested-split-e2e` / `terminal-pane-e2e` 无回归 |

## 6. 风险 / 未知

1. **块首复选框的位置有两种画法**:① 复选框**取代**圆点(任务块手感,但会动 `BlockRow` 的 gutter 结构);
   ② 保留圆点、把复选框画在文本前(改动最小)。默认取 ②,若真机看起来别扭再换 ①。两种都不改数据。
2. **`- [ ] 甲` 保存前后树结构不同**(in-session 内容行 → 重新解析后子块)。
   字节不变、视觉都是复选框,只是层级不同。这是 Logseq 文件格式的固有语义,**本次不修**,
   写进 README「与 Logseq 共用同一个图的规矩」附近;想要「块内清单」时用 `* [ ]`(官方推荐写法)。
3. **`> 引用` 与块首 task 的组合**(如 `> [ ] x`)按「引用优先」渲染,不递归识别引用内部的标记 ——
   CommonMark 允许嵌套,但收益低、解析复杂度高。明确记为限制。
4. **列表/引用的标记被隐藏后无法用鼠标点在标记上**:`data-base` 兜底把光标放到行首,符合预期;
   但 `hr`(`---`)整行隐藏,点击只能落到行首,细看可能有点怪(与 Logseq 一致,`---` 就是一条线)。
5. **`splitBlock` 的 `unit===undefined` 分支与新分支行为不同**(旧分支把多行内容留在左块,新分支按光标
   切成两半)。旧分支只被单测使用,UI 一律传 `unit`;要在 `logseqShared.test.ts` 里把这条差异钉进注释/用例。
6. **`.vue` 不在 `tsc` 范围内**:`MarkdownLine.vue` / `BlockRow.vue` / `BlockText.vue` 的错误只有
   `bun run build` 会报(ARCHITECTURE §11 已有记录),本计划把 build 列进每一步验证。
7. **Windows 真机 E2E 仍跑不了**:`D:\Workspace\browser` 是另一份落后检出(见 `2026-09-20-logseq-plugin`
   §9.4);本次 E2E 走 WSL/Linux 的 Electron(WSLg),Windows/mac 未验的老遗留不变。
8. **性能**:`analyzeBlockLines` 每块每次渲染跑一遍正则,行数量级是「一个块几十行」,可忽略;
   不做跨块缓存(否则又多一套失效逻辑)。

## 7. 佐证(为什么 `* [ ]` 是块内清单的正解)

- Logseq 官方文件格式文档 `logseq/logseq:docs/logseq-markdown-syntax.md`:「Blocks are Markdown list items
  that use `-`」,属性用 `*`;任务状态编码为块行的 `TODO` / `DONE`。
- Logseq 社区帖「How to create a checklist in Logseq without TODO status」:块内清单必须写成
  `* [ ] point`,并明确「`- [ ]` 会被 Logseq 解释成 bullet points / 报错」。
  ⇒ 我们**不改**「`- ` 即子块」的解析语义;块内清单靠 `* [ ]`,而 `- [ ]` 落到子块后靠「块首按标记渲染」
  一样能画成复选框。

---

## 8. 实施记录(2026-09-20 完成)

### 8.1 落地了什么

| 类别 | 文件 |
| --- | --- |
| 行级分类器 + 分组 | `src/plugins/logseq/format.ts`:`LineMark` / `matchLineMark()` / `RenderedLine` / `analyzeBlockLines()`(纯,无 DOM) |
| 编辑命令 | `src/plugins/logseq/shared.ts`:`toggleTaskMarker()`、抽出 `writeContentLines()`、`splitBlock()` 增可选 `unit`(多行劈开) |
| 渲染层 | `ui/MarkdownLine.vue`(新)、`ui/BlockText.vue`(加 `base` prop)、`ui/BlockRow.vue`(`analyzeBlockLines` + `data-base` + `toggle-task` 转发,删 `fenced`/`.codeish`)、`ui/JournalView.vue`(`toggle-task` 动作 + `splitBlock(..., unit.value)`) |
| 单测 | `logseqFormat.test.ts` +6(22 例)、`logseqShared.test.ts` +2(36 例) |
| E2E | `/mnt/d/tmp/logseq-e2e-wsl.mjs` 新增 §L(9 + 4 = 13 条断言) |
| 文档 | `README.md`(「渲染」小节 + 「不做的事」澄清 TODO)、`docs/ARCHITECTURE.md`(§5.8 不变式 +1 行、§11 基线 830 → 838 与两个 logseq 测试行) |

### 8.2 与计划的偏差(实施中改的)

1. **分类器放在 `format.ts`,没开 `lines.ts`**。`tsconfig.node.json` / `tsconfig.web.json` 都登记了
   `src/plugins/*/format.ts`,新文件名要改两处 include(计划 §3.1 已写明这个取舍)。
2. **块首复选框画在文本前,没有取代圆点**(计划 §6 风险 1 的 ②)。真机看下来效果可接受,改动也最小。
3. **空标题 `##` 被当成 heading(空文本)**,而不是 plain —— CommonMark 就是这样,`HEADING_RE` 的 `$`
   分支保留;单测按这个行为钉住。
4. **E2E 的专用页一开始写了 `title:: Md Render`**,结果 `openPage('md-render')` 找不到它 ——
   索引的 `title` 以 `title::` 优先(`graph.ts` 的 `buildFileEntry`),`resolvePage` 按 `pageKey(title)` 查。
   去掉 `title::` 后文件名即标题。这是**既有语义**(不是本次引入的 bug),顺手在 E2E 里踩实了一遍。
5. **`toggleTaskMarker` 的 `TASK_MARK_RE` 允许前导空白**:文件里的内容行带缩进(`  * [ ] x`),
   块头文本(经 `blockText`)没有;同一条正则两侧都能用。

### 8.3 验证(实测)

- `bun run typecheck` / `bun run build` 过(`out/renderer/logseq.html` 独立 chunk 正常)。
- `bun run test` → **43 个文件 / 838 个用例全绿**(基线 830:+8:format +6、shared +2)。
- **真机式 E2E:`/mnt/d/tmp/logseq-e2e-wsl.mjs` → 46/46 通过,连跑多次稳定**
  (基线 33/33;新增 §L:标题字号大于正文(h1=19.5 / base=13)、引用、复选框两种状态、
  围栏代码内容不 token 化、有序列表标记、水平线;点复选框 → 磁盘 `* [x] 甲任务` 且其它行逐字节未变;
  光标落在第 2 行行尾回车 → 正确劈成 `- split-base\n  第一行\n- 第二行`)。
- 回归:`terminal-e2e` / `nested-split-e2e` / `terminal-pane-e2e` 本次未跑(需要 Windows 真机;
  见 `2026-09-20-logseq-plugin/plan.md` §9.4 的同一条遗留);但本次改动只落在笔记插件目录内,
  唯一被碰的核心面是 `format.ts` / `shared.ts` 的纯函数(单测覆盖)。

### 8.4 仍未验证(如实记录)

- **Windows / mac 真机没跑**(与前几份计划同样的遗留);本次 E2E 跑在 WSL/Linux 的 Electron(WSLg)。
- 引用内部的嵌套标记(`> * [ ] x`)按「引用优先」只渲染一层(计划 §6 风险 3,明确限制)。
- `- [ ]` 保存前后树结构不同(in-session 内容行 → 重载后子块):语料已进 `display → set` 恒等测试,
  视觉都是复选框;README 已写明「块内清单用 `* [ ]`」。
