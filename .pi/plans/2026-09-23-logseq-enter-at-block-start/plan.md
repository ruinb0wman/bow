# 笔记插件:块首回车应在**块前**插一个空块

日期:2026-09-23 · 上一轮:`.pi/plans/2026-09-21-logseq-paste-split-and-settings-padding/plan.md`

## 1. 目标与假定

用户一条:

> 在某段 block 文字的最前面按回车,应该在当前 block **之前**建一个 block,
> 而不是在后面创建 block 并移动文字到后面的 block。

目标行为(与 Logseq 一致 —— Logseq 官方论坛里「块首回车」的标准做法就是
*Move cursor to beginning of block text → Press enter to create new block above*,
见 <https://discuss.logseq.com/t/keyboard-shortcuts-create-block-before-after-current-block-at-same-indentation-level/25346>):

| 场景(光标位置) | 现在 | 改后 |
| --- | --- | --- |
| 块尾 / 最后一行行尾 | 后面插同级空块(`insertSiblingAfter`),焦点在新块 | **不变** |
| 块中间 / 任意行中间 | 在光标处劈开(`splitBlock`) | **不变** |
| **块首(offset 0),块非空** | 走 `splitBlock(offset=0)`:原块被清空、文字(含多行内容)**搬到后面**的新块,焦点落到那个新块的**末尾** | **在前面插一个同级空块,焦点落在新空块里;原块(文字 / 多行内容 / 属性行 / 子块)整体不动** |
| 块首,块**本来就是空的** | 走 `insertSiblingAfter`(后面插空块) | **不变**(Logseq 也是「空块里回车 = 在下面建块」) |

假定(读代码得到,不是猜):

- 「block 文字的最前面」= `textarea` 全文偏移 `0`,即块的**第一行第一个字符**(不是「块内某一行行首」——
  那种情况必须劈开,不然光标后的文字无处可去)。
- 新空块的**缩进**与当前块同级;当前块是子块时也插在同级的兄弟位置。
- 焦点落在**新空块**(用户可以立刻输入),与 Logseq 的 `insert_block({focus:true, before:true})` 一致。

## 2. 现状与证据(读过的代码)

### 2.1 键位映射:`caret === 0` 被当成「中间劈开」

`src/plugins/logseq/ui/BlockRow.vue:206`(Enter 分支):

```ts
  if (isEnter && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault()
    // 光标在整块末尾(最后一行行尾)→ 新兄弟块;否则在光标处劈开
    const atEnd = caret >= draft.value.length
    emit('action', atEnd ? { type: 'new-sibling', key: props.block.key } : { type: 'split', key: props.block.key, offset: caret })
    return
  }
```

`caret = start`、`start = el?.selectionStart ?? 0`(`BlockRow.vue:173-176`)。所以块首回车 →
`type:'split', offset:0` →
`JournalView.vue:545` → `splitBlock(current, key, 0, unit)`。

### 2.2 `splitBlock(offset=0)` 是退化情形,而且会把子块/属性行留在空块上

`src/plugins/logseq/shared.ts:824`:

```ts
export function splitBlock(file: ParsedFile, key: string, offset: number, unit?: string): EditResult {
  ...
  } else {
    const lines = blockLinesForDisplay(target.block, unit)
    const text = lines.join('\n')
    const at = Math.max(0, Math.min(text.length, offset))
    const lineIndex = text.slice(0, at).split('\n').length - 1
    const lineStart = at === 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1
    const col = at - lineStart
    const cur = lines[lineIndex] ?? ''
    before = [...lines.slice(0, lineIndex), ...(col > 0 ? [cur.slice(0, col)] : [])]
    after = [...(col < cur.length ? [cur.slice(col)] : []), ...lines.slice(lineIndex + 1)]
    before[0] = (before[0] ?? '').replace(/\s+$/, '')
  }

  setHeadText(target.block, `${indent}- ${before[0] ?? ''}`)
  if (unit !== undefined) writeContentLines(target.block, before.slice(1), indent, unit, eol)
  const block = newBlock(after[0] ?? '', indent, eol)
  if (unit !== undefined) writeContentLines(block, after.slice(1), indent, unit, eol)
  insertAfter(next, target, block)
  reindex(next)
  return { file: next, focusKey: block.key }
}
```

`at === 0` 时:`before = []`、`after = 全部行`,`writeContentLines(target, [])` 会**丢掉**原块的
内容行(只留属性行),`insertAfter` 把新块插在**目标块的整棵子树之后**,而**子块与 `id::` /
`collapsed::` 留在被清空的原块上**。推演(块 `a` 带 `id::` 与子块,光标在块首回车):

改前

```
- a
  id:: 1111…
  - a child
- b
```

改后(现在的行为:空块占着原来的位置、挂着 `id::` 与子块;文字被搬到后面的新块,焦点在它末尾)

```
-                 ← 空块(原块),子块与 id:: 都留在它下面
  id:: 1111…
  - a child
- a               ← 文字搬到这个新块,光标落在这里的末尾
- b
```

即使块只有一行文字、没有子块(文件字节前后**完全一样**,都是 `- \n- a`),观感也是错的:
用户按下回车后光标**跳到了下面文字块的末尾**,而不是停在上面那个新空块里 —— 正是用户说的
「在后面创建 block 并移动文字到后面的 block」。

### 2.3 已有的同类命令可以直接复用

`src/plugins/logseq/shared.ts:794`(`insertSiblingAfter`)与 667(`insertTopBlock`)/703(`insertAfter`):

```ts
export function insertSiblingAfter(file: ParsedFile, key: string, text = ''): EditResult {
  const next = cloneFile(file)
  const target = locate(next, key)
  if (!target) return { file, focusKey: null }
  const eol = fileEol(next)
  ensureEolOnBlockTail(target.block, eol)
  const block = newBlock(text, indentText(target.block.head.text), eol)
  insertAfter(next, target, block)
  reindex(next)
  return { file: next, focusKey: block.key }
}
```

`insertBefore` 不能写成 `insertTopBlock(file, loc.index, block)`:那个助手在 `blockIndex <= 0` 时
是 `entries.unshift()`,而块区**前面可能有 raw 行**(页面属性 `title:: …`、空行),unshift 会把
`title::` 挤到块的**后面**(Logseq 只认页首的属性行 → 静默改坏用户的页面属性)。必须插在
「当前块那条 entry 之前」。

## 3. 改动清单

| 文件 | 改什么 | 为什么 |
| --- | --- | --- |
| `src/plugins/logseq/shared.ts` | 新增 `insertSiblingBefore(file, key, text = '')` + 私有 `insertBefore(file, loc, block)`;`splitBlock` 在 `offset <= 0` 时**委托**给它 | 规则落在纯逻辑层,能被单测钉住(本仓库没有 Vue 组件测试) |
| `src/plugins/logseq/ui/BlockRow.vue` | 只改注释(说明 `offset 0` 由 `splitBlock` 换算成「前面插空块」) | 键位/emit 分支不变:`caret 0` 且块非空 → 已经是 `split(0)`;块空 → 已经是 `new-sibling` |
| `src/plugins/logseq/ui/JournalView.vue` | **不改**(`splitBlock` 的返回值形状不变) | `commit()` 已经用 `result.focusKey` 切编辑态,`caretIntent = null` 在空块里就是 0 |
| `tests/logseqShared.test.ts` | 新增 4 例(见 §5.1) | 钉住整份文件输出 + 「原块那一行是同一份 `SourceLine`」 |
| `README.md:494-496` | 键位说明补一条「块首 `Enter` 在**块前**插空块(原块的文字、子块与属性行都不动)」 | 用户可见行为文档 |
| `.pi/plans/2026-09-20-logseq-plugin/plan.md:217-218` | §3.2 命令表补一行 `insertSiblingBefore` | 设计文档与代码同步(该表就是「命令 ↔ 键位」的索引) |
| `docs/ARCHITECTURE.md:1008-1017` | §11 测试统计:`logseqShared.test.ts` 的**行数 / 用例数**、`合计 1001`、`146 例` | 那张表是手工维护的,加了用例就得跟着改(实现后用 `wc -l` + vitest 输出重算) |

**不改**:`pasteIntoBlock`(按块粘贴在光标处劈开时,空块顶替逻辑已经把「不留空块」处理掉了,
不产生本 issue 的形态)、`mergeWithPrevious`(块首 Backspace 与新的块首回车天然互逆:
新空块上按 Backspace 会并回去)、空块回车的行为。

## 4. 实施步骤

1. **`shared.ts`:加 `insertBefore`(私有)** —— 与 `insertAfter`/`removeAt` 并排放在 703 行附近。
   `loc.parent` 有值时 `loc.parent.children.splice(loc.index, 0, block)`;顶层块**按 entry 定位**:
   遍历 `file.entries`,第 `loc.index` 个 `kind === 'block'` 的那条 entry 之前 splice。
   (顶层走到兜底分支时 `entries.push` —— 正常不会发生。)
2. **`shared.ts`:加 `insertSiblingBefore`** —— 紧挨 `insertSiblingAfter`(794 行)之后,
   同样的 `cloneFile → locate → newBlock(同缩进) → insertBefore → reindex`,返回
   `{ file: next, focusKey: block.key }`;**不要**调 `ensureEolOnBlockTail(target.block)` ——
   插在目标块**前面**时,需要行尾的是前一行,而「缺行尾的行只可能是文件最后一行」,所以前一行
   必然有行尾;给目标块补行尾反而会给「本来没有尾换行的文件」凭空加一个字节。
3. **`shared.ts`:`splitBlock` 开头加退化守卫** ——
   ```ts
   // 光标在最前面是退化情形:前半什么都没有。此时不是把整块搬到后面的新块里
   // (那会让子块与 `id::` / `collapsed::` 留在被清空的块上),而是在**前面插一个空块**,
   // 原块整体不动 —— 与 Logseq 的「块首回车 = 在上面建块」一致。
   if (offset <= 0) return insertSiblingBefore(file, key)
   ```
   同时把函数 doc 里「子块留在前半 —— 与 Logseq 一致」补一句「`offset 0` 例外,见上」。
4. **`BlockRow.vue` 注释** —— 208 行那句改成「光标在整块末尾 → 新兄弟块;块首(offset 0)→ 由
   `splitBlock` 换算成『在前面插空块』;其余在光标处劈开」。
5. **`tests/logseqShared.test.ts`** —— 在 `describe('块编辑命令')` 里加 §5.1 的四例,
   并把 `insertSiblingBefore` 加进文件顶部的 import 列表。
6. **`README.md` / 计划文档 / ARCHITECTURE.md** —— 按 §3 的表更新;ARCHITECTURE 的两个数字
   实现后重算。
7. **验证** —— `npm test`(全绿,含既有 76 例不回归)、`npm run typecheck`、手工验证(§5.2)。

## 5. 验证

### 5.1 新增单测(整份文件输出,与既有风格一致)

```ts
it('块首回车:在前面插空块,原块的文字 / 属性行 / 子块都不动', () => {
  const raw = '- a\n  id:: 11111111-1111-4111-8111-111111111111\n  - a child\n- b\n'
  const file = parseLogseqFile(raw)
  const out = splitBlock(file, '0', 0, detectIndentUnit(file))
  expect(serializeLogseqFile(out.file)).toBe('- \n- a\n  id:: 11111111-1111-4111-8111-111111111111\n  - a child\n- b\n')
  expect(blockText(topBlocks(out.file)[0])).toBe('')      // 焦点块 = 新空块
  expect(topBlocks(out.file)[1].children.length).toBe(1)  // 子块跟着原块,没被留在空块上
})

it('块首回车:页面属性不会被挤到块后面(文件第一块也一样)', () => {
  const file = parseLogseqFile('title:: T\n- a\n')
  expect(serializeLogseqFile(splitBlock(file, '0', 0, detectIndentUnit(file)).file)).toBe('title:: T\n- \n- a\n')
})

it('块首回车:子块也在它的前面插同级空块', () => {
  const file = parseLogseqFile('- a\n  - b\n')
  const out = splitBlock(file, '0.0', 0, detectIndentUnit(file))
  expect(serializeLogseqFile(out.file)).toBe('- a\n  - \n  - b\n')
  expect(out.focusKey).toBe('0.0')
})

it('insertSiblingBefore:同级空块插在目标块前面,原块逐字节不动', () => {
  const file = parseLogseqFile(FIXTURE)
  const betaHead = topBlocks(file)[1].head
  const out = insertSiblingBefore(file, '1', 'new')
  expect(serializeLogseqFile(out.file)).toBe(
    ['title:: Test', '', '- alpha', '  id:: 11111111-1111-4111-8111-111111111111', '  - alpha child', '- new', '- beta', '  collapsed:: true', '- gamma', ''].join('\n')
  )
  expect(topBlocks(out.file)[2].head).toBe(betaHead)  // 未触及的行复用同一份 SourceLine
  expect(serializeLogseqFile(file)).toBe(FIXTURE)     // 纯函数:不改动输入
})
```

### 5.2 手工验证(`npm run dev` → 打开一个 Logseq 图)

1. 找一个**有子块、有 `id::`** 的块,光标移到块首按 `Enter` → 上面多出一个空块、光标在它里面;
   原块文字、`id::` 行、子块全在原处;文件里 `title::`(若有)仍在页首。
2. 多行块(含代码围栏/表格行)块首 `Enter` → 多行内容一行不少地留在原块。
3. 块中间 `Enter`、块尾 `Enter` → 与改前一致。
4. **空块**里 `Enter` → 仍在下面建块(不变)。
5. 块首 `Enter` 后立刻 `Backspace` → **非首块**时并回原块(与既有 `mergeWithPrevious` 互逆);
   文件**第一块**的新空块是首个顶层块,`Backspace` 走既有的「顶层第一块不动作」(死键,用 `Ctrl+Z` 或
   多块选区删除)—— 见 §8.2 修正 1。
6. `Ctrl+Z` 一次 → 完全回到改前(`commit` 推的整篇快照)。

## 6. 风险与未知

1. **焦点复用依赖 Vue 的 keyed diff**:`JournalView` 的 `v-for :key="row.block.key"`,
   插入后新空块拿到的 key 正是原块的 key(如 `'0'`),所以那一行**不会被卸载**,textarea 原地复用 →
   不会在卸载时丢焦点/触发 `blur` 把 `editingKey` 清掉。这条与 `JournalView.vue:562` 那条注释
   (粘进空块时显式重挂 textarea)是同一类坑,手工验证第 1 条就是专门看它的。
2. **`splitBlock` 的 `offset <= 0` 语义变化**:仓库里 `splitBlock` 只有一个调用方 ——
   `JournalView.vue:546`(响应 `BlockRow` 的 `split` action);测试里没有 `offset 0` 的用例
   (`tests/logseqShared.test.ts:332` 用 2、408-412 用 1 / 4 / 9),所以没有既有断言会翻。
   旧的无 `unit` 调用(仅测试在用)也走同一条退化守卫。
3. **`- ` 带尾空格**:新空块沿用 `newBlock('')` = `- `(尾空格),与现有 `insertSiblingAfter`
   和 Logseq 自己写空块的形式一致,不额外处理。
4. **未触及的既有 quirk**(本次不改,先记着):块内有**选区**时按 `Enter`,`caret` 取
   `selectionStart`,选区里的文字不会被删掉(通用编辑器的行为是「回车替换选区」)。
   改后块首 + 全选时等价于「在上面插空块」,不会更糟。
5. **文档数字**:ARCHITECTURE.md §11 的行数/用例数是手工维护的(没有脚本校验,已确认),
   实现后必须重算,否则又添一条漂移。

## 7. 备选方案(为什么不用)

**UI 层加一个 `new-sibling-before` action(而不是在 `splitBlock` 里守卫)**:分工更显式,但
「光标在 0 就前插」这条规则会落在 `BlockRow.vue` 里 —— 本仓库 `vitest` 是 `environment: 'node'`
且没有任何组件测试,这条规则就**没有单测覆盖**;而放在 `splitBlock` 里,规则由
`tests/logseqShared.test.ts` 直接钉住,`BlockRow`/`JournalView` 一行逻辑都不用动。

---

## 8. 实施记录(2026-09-23)

### 8.1 落地与证据

改动文件:`src/plugins/logseq/shared.ts`(+51 行:私有 `insertBefore` + 导出的 `insertSiblingBefore` +
`splitBlock` 的 `offset <= 0` 退化守卫)、`src/plugins/logseq/ui/BlockRow.vue`(只改注释)、
`tests/logseqShared.test.ts`(+5 例)、`README.md`、`docs/ARCHITECTURE.md`、
`.pi/plans/2026-09-20-logseq-plugin/plan.md`;仓库外 `/mnt/d/tmp/logseq-e2e-wsl.mjs`(+2 个 fixture 页 + §V)。

| 验证 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| 单测(纯逻辑) | `npm test` | **46 文件 / 1006 例全绿**(基线 1001;`logseqShared.test.ts` 76→81) |
| 类型 | `npm run typecheck` | 干净 |
| **真机式 E2E**(WSL 侧真跑 Electron + 真图 + 真磁盘) | `npm run build` → `bun /mnt/d/tmp/logseq-e2e-wsl.mjs` | **154/154 通过,连跑 3 次**(基线 145;§V 新增 9 条) |
| pre-fix 对照(去掉 `offset <= 0` 守卫重跑 E2E) | 同上 | **136/139**,红点全落在新判据上(见 8.3) |

§V 实测值(节选):

```
[PASS] 光标落在块首  — {"value":"乙","caret":0}
[PASS] 回车后焦点在新空块里(不是文字块)  — {"tag":"TEXTAREA","key":"1","value":"","caret":0}
[PASS] 空块插在「乙」前面(不是后面)  — [[0,"甲"],[0,""],[0,"乙"],[1,"乙的子块"],[0,"丙"]]
[PASS] 磁盘:id:: 与子块留在原块上,空块在上面  — "- 甲\n- \n- 乙\n  id:: 1111…\n  - 乙的子块\n- 丙\n"
[PASS] 新空块可直接输入(焦点在它里面)  — 文件变成 "- 甲\n- 新条目\n- 乙\n…"
[PASS] Ctrl+Z 撤销块首回车后逐字节回到基线
[PASS] 页首 title:: 没有被挤到块后面  — "title:: EnterTopProps\n- \n- 甲\n"
```

### 8.2 两处修正 / 发现

1. **§5.2 第 5 条的修正**:「块首 `Enter` 后 `Backspace` 能并回」只对**非首个块**成立。
   新空块插在列表最前面时它就是首个顶层块,`mergeWithPrevious` 走既有的「顶层第一块不动作」
   (no-op)。这是**既有规则**(与本次改动无关,Logseq 同样不能把首块向上并),已写进 §5.2 与单测
   (`块首回车 + Backspace 合并:非首块逐字节回到原样(首块是既有的 no-op)`)。
2. **E2E 搭台时撞到一个既有隐患(不在本轮范围,已记 scratchpad)**:`resolvePage()` 只按
   **显示名**(`title::` 优先)认页。用**文件名**去开一个 `title::` 与文件名不同的页
   (`openPage('enter-top-props')`,而该页 `title:: EnterTopProps`)会被当成「不存在的新页」,
   编辑器随即以空内容打开同一个路径,**一保存就把原文件覆盖成空块** —— 本次 §V 第一次跑就是这样
   把 fixture 页写成 `- \n- \n` 的。E2E 已改成用显示名打开并在注释里写明。

### 8.3 pre-fix 红测(证明判据不是空的)

把 `shared.ts` 的 `if (offset <= 0) return insertSiblingBefore(file, key)` 临时去掉、重新 `npm run build`
后重跑 E2E,§V 立刻变红(且脚本在 V3 的 `waitFor` 超时,后续段落没跑到,所以总数是 139 而不是 154):

| 判据 | pre-fix 实测 |
| --- | --- |
| 回车后焦点在新空块里 | `{tag:'TEXTAREA', key:'2', value:'乙', caret:1}` —— 焦点跑到**下面那个有文字的块**的末尾 |
| 空块插在「乙」前面 | `[[0,'甲'],[0,''],[1,'乙的子块'],[0,'乙'],[0,'丙']]` —— 空块把**子块**留下了,文字被搬到后面 |
| 磁盘:id:: 与子块留在原块上 | `waitFor` 超时(文件形态不对) |

### 8.4 仍未验证

1. **Windows 真机**:E2E 跑的是 WSL/Linux 侧 Electron(仓库外脚本自己声明的范围)。真机需
   `wsync` → Windows `npm run build` → 重启 bow,再按 §5.2 手验一遍(重点看中文输入法下块首回车)。
2. **块内选区的 `Enter` 语义**(§6 风险 4)仍按原样保留:有选区时按 `Enter` 不删选区。
