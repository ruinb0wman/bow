# 笔记插件修复第二轮:表格单 `-` 判据 / 复制·剪切安全 / `Ctrl+Enter` 与行高

日期:2026-09-21 · 上一轮:`.pi/plans/2026-09-21-logseq-table-block-select/plan.md`(`719d4f7` / `b86777b`)

## 1. 用户实测反馈(跑的是 `dist/win-unpacked/bow.exe`,16:06 构建 = 含上一轮全部改动)

1. **表格渲染不生效**。
2. **多块选中复制不生效;剪切的删除生效但没复制内容**。
3. **`Ctrl+Enter` / `Shift+Enter` 有时生效、有时失去焦点**;「**有时确实换行了但是行高没有变化导致块内的换行被下一行遮挡**」;
   「**创建块内行后点击 backspace 块内行没有被删除**」。
4. 拍板:**只修块里的表**(顶层裸行渲染不做)。终端复制正常 ⇒ 系统剪贴板与 `browserAPI.writeClipboardText` 通路本身没坏。

## 2. 根因(全部有代码/文件证据)

### R1 表格:分隔行判据太严(用户文件是**单个 `-`**)

`format.ts` 现在要求每个分隔单元格 `-{2,}`:

```ts
const TABLE_DELIM_CELL_RE = /^[ \t]*:?-{2,}:?[ \t]*$/
```

你图里的真实表格(`D:\Documents\Knowledge1`)是:

```
| 项 | 现在 |
|-|-|
| 阶段 | [[交易学习阶段]] 阶段一（0-6 个月） |
```

(`pages/交易-进度.md`、`哲学-进度.md`、`学习.md`、`计算机科学-进度.md`、`daily规划.md` 全是 `|-|-|` / `|-|-|-|`)
**GFM / Logseq 只要求「至少一个 `-`」**,`-{2,}` 是我写严了 ⇒ 这些表全部退回 `plain`。

### R2 顶层裸行不渲染(用户拍板不动,但要说明)

`JournalView.visibleRows` 只走 `topBlocks(file)`,而 `parseLogseqFile` 把非 `- ` 行归进 `raw` 条目 ⇒
**顶层裸 markdown 一行都不显示**。`交易-进度.md` 的整张表(含 `# 标题` / `## 小节` / 段落)因此永远看不到 ——
这不是表格的 bug,是「bow 只编辑 `- ` 块」的既有边界。

### R3 复制 / 剪切:剪切会「删了但没复制」+ 失败原因被静默吞掉

```ts
async function copySelected(): Promise<string> {
  ...
  const text = blocksToMarkdown(current, keys)
  if (!text) return ''
  try {
    const ok = await api.writeClipboardText(text)
    if (!ok) message.value = '复制失败'          // ← ① 失败只写进 message
  } catch (e) { message.value = ... }           //    message 会被下一次保存清空
  return text                                    // ← ② 无论成败都返回 text
}
...
if (cut && text && current) commit(deleteBlocks(current, selectedKeys.value))  // ← ③ 不看 ok 就删
```

三条叠加就是用户看到的:复制失败没人看见(400ms 后 `doSave()` 成功时 `message.value = ''` 把它冲掉),
**剪切照样删块** —— 内容既没进剪贴板又没了。

另外键位匹配用的是 `event.key`:

```ts
if (mod && !event.altKey && (event.key.toLowerCase() === 'c' || event.key.toLowerCase() === 'x')) { ... }
```

Windows 输入法把按键路由成 `VK_PROCESSKEY` 时,Chromium 给的是 `key: 'Process'` / `keyCode: 229` ——
`key.toLowerCase()` 不等于 `'c'`/`'x'`,**整个分支不成立**(终端里 `Ctrl+C` 走的是 xterm 自己的 keydown,不受影响)。

### R4 块内换行:**自动增高从来没在换行/输入时调用**

```ts
function autoGrow(): void { const el = area.value; el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
```
只在 `onFocus()` 与「进入编辑态」的 `nextTick` 里调用;**`onInput()` 与换行分支都没有调**。
`.block-input` 是 `rows="1"` + `overflow: hidden` ⇒ 换行后 textarea 高度不变,第二行被裁掉/被下一个块盖住 ——
与用户「换行了但行高没变、被下一行遮挡」逐字吻合(也顺带解释了「backspace 删不掉块内行」:
第二行根本看不见,光标落点与预期不一致)。

同时:

```ts
if (event.isComposing || event.keyCode === 229) return     // ← 输入法活跃时 Ctrl+Enter 一起被放行给 IME
if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey)) { ...换行... }
```
`keyCode === 229` 时整个函数直接 return,`Ctrl+Enter` 什么都不会发生;而 `event.key === 'Enter'` 在 IME 路由下也可能变成 `'Process'`。

(`Shift+Enter` 在微软拼音下 Shift 被当切中英键吃掉,是平台限制 —— 代码侧无法补救,只能继续主推 `Ctrl+Enter`。)

## 3. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/plugins/logseq/format.ts` | `TABLE_DELIM_CELL_RE` 改 `:?-+:?`(GFM:至少一个 `-`);注释写清「单 `-` 也算,和 Logseq/GFM 一致」 |
| `src/plugins/logseq/ui/BlockRow.vue` | ① 键位改用 **`event.code` 优先**(`Enter`/`NumpadEnter`、`KeyC`/`KeyX`),`key` 作为兜底 —— 输入法把 `key` 变成 `'Process'` 也认得出;② IME 守卫改成「组合中放行给 IME,**但 `Ctrl/Cmd+Enter` 永远归我们**」;③ 换行分支 `nextTick` 里补 `autoGrow()` + 把光标滚进视野;④ `onInput()` 补 `autoGrow()`;⑤ `trace('key:soft-newline')` / `key:new-sibling`(排障用) |
| `src/plugins/logseq/ui/JournalView.vue` | ① `copySelected()` → `{ text, ok }`,成功后用 `readClipboardText()` **复核一次**;② 剪切**只在 `ok === true` 时删除**;③ 复制结果写进**独立的 `clipboardNotice`**(不被 `doSave()` 清掉):成功「已复制 N 块」约 1.5s、失败「复制失败:<原因>」保留到下次复制;④ 选区键位改用 code 匹配;⑤ 右下角浮层加这个 chip;⑥ (小)顶部 `.meta` 加一条弱提示「本页有 N 行不在 `- ` 块里的内容(不渲染)」,让 R2 不再被误当成表格 bug |
| `tests/logseqFormat.test.ts` | 分隔行用例改成真实形态:`\|-\|-\|`、`\|-\|-\|-\|`、`\|------\|------\|:--:\|:--:\|:--:\|:--:\|`,并保留「只有一个 `-` 也算」的正例 |
| `/mnt/d/tmp/logseq-e2e-wsl.mjs` | §Q 的 fixture 换成 `\|-\|-\|` 真实形态(另留一张多 `-` 的表);§R 加 **IME 模拟判据**(`{key:'Process', code:'Enter', keyCode:229, modifiers:2}` 必须换行)+ **行高判据**(换行后 `textarea.offsetHeight` > 单行);§S 加「第二行行首 Backspace → 两行合一、仍是同一个块」 |
| `README.md` §笔记 | 表格判据写「分隔行≥1 个 `-`」;边界里写明**顶层非 `- ` 行不渲染**(这类页只能看到 `- ` 行);`Ctrl+Enter` 与输入法的说明按实测更新 |

不动:`shared.ts`(批量命令逻辑没有 bug)、`main.ts` / 剪贴板 IPC(终端已验证通路正常)、顶层裸行渲染(用户拍板不做)。

## 4. 步骤(每步可独立验证)

1. **表格判据**(`format.ts` + 单测):`npx vitest run tests/logseqFormat.test.ts`,新增真实分隔行用例全绿。
2. **BlockRow 键位 + autoGrow**(`BlockRow.vue`):`npm run typecheck` + `npm run build`。
3. **JournalView 复制/剪切安全 + 提示**(`JournalView.vue`)。
4. **E2E 扩写并跑**(先 `npm run build`,再 `bun /mnt/d/tmp/logseq-e2e-wsl.mjs`):新判据 + 既有 117 条回归。
5. **pre-fix 红测**:`cp -a src /tmp/src-postfix` → `git checkout HEAD -- src` → `npm run build` → 跑副本(`waitFor` 超时不抛的 `/tmp/logseq-e2e-prefix.mjs`,同上一轮)→ 记录红点 → **还原 src 并重建**。
6. **全量回归**:`bun run test`(基线 45 文件 / 906 例)、`npm run typecheck`。
7. **文档 + 计划回写**:README、本文件 §5 实施记录。
8. **提交**:`fix(logseq): ...` + `docs(logseq): ...`(沿用上一轮的提交习惯)。

## 5. 风险 / 未知

1. **复制失败的最终原因还没实证**:可能是输入法把 `Ctrl+C` 变成 `Process`(code 匹配可解),也可能是 IPC 拒绝(复核+提示可暴露)。
   本轮先把「删了但没复制」这条**数据安全问题**堵死,并把失败原因做成**看得见**的;若仍失败,下一轮用 `__bowLogseq.trace` 里的 `copy:*` + 右下角提示文本定位。
2. **`Shift+Enter` 在中文输入法下仍可能被吃掉**(平台行为,不修)。
3. `autoGrow` 之后块会变高,下方内容下移 —— 这是预期(现在的问题是它**不**下移)。
4. 顶层裸行仍然不渲染(用户拍板),只加一条提示;`交易-进度.md` 那类页在 bow 里依旧不完整。

## 6. 不做的事

- 顶层裸行(非 `- ` 行)的渲染 —— 用户明确选择不做。
- 表格单元格内的 `\|` 转义语义(`[[页#块\|别名]]` 的点击目标会带一个尾部 `\`,渲染文字正确;只影响点进去的页面名)。
- 输入法/平台的逐家适配;`Shift+Enter` 的补救。

---

## 7. 实施记录(2026-09-21)

### 7.1 结果

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` | 通过 |
| `bun run test` | **45 文件 / 909 例**(基线 906,+3:表格真实分隔行 / 多列对齐 / 表格里的 `\|`) |
| WSL E2E(`/mnt/d/tmp/logseq-e2e-wsl.mjs`) | **125/125 通过**,连跑 2 次 |
| pre-fix 对照(基线 = 上一轮 `719d4f7`) | **109/124**;红点全部落在本轮判据上(见 7.3) |

改动文件:`format.ts`、`ui/BlockRow.vue`、`ui/JournalView.vue`、`tests/logseqFormat.test.ts`、`README.md`。

### 7.2 逐条

1. **表格**:`TABLE_DELIM_CELL_RE` 由 `:?-{2,}:?` 放宽为 `:?-+:?`(GFM 只要求 ≥1 个 `-`),
   并加了三条针对真实文件的用例(`|-|-|`、`|------|------|:--:|…|`、表格里的 `\|` 别名)。
   E2E 的 fixture 也改成真实形态 `|-|--:|`。
2. **键位改看物理 code**:`isEnter = key==='Enter' || code==='Enter' || code==='NumpadEnter'`;
   选区的 `Ctrl+C/X` 同时认 `key` 与 `code === 'KeyC'/'KeyX'`。
3. **输入法守卫**:`if ((event.isComposing || event.keyCode === 229) && !modEnter) return` ——
   `Ctrl/Cmd+Enter` 不再被 `keyCode 229`(Windows 的 `VK_PROCESSKEY`)拦掉。
4. **自动增高**:`onInput()` 里调 `autoGrow()`;换行分支在 `nextTick` 里先 `autoGrow()` 再设光标并
   `scrollIntoView({block:'nearest'})`。pre-fix 实测 `height 22 / scrollHeight 42` —— 第二行被裁掉,
   与你描述的「行高没变、被下一行遮挡」完全一致。
5. **复制/剪切**:
   - `copySelected()` 返回 `{ text, ok }`;写完用 `readClipboardText()` **复核**(比对前归一化 CRLF ——
     Windows 剪贴板存的是 CRLF,不归一化会假报失败);
   - `Ctrl+X` **只在 `ok === true` 时删除**;
   - 结果写进**独立的 `clipboardNotice`**(`doSave()` 成功不再把它冲掉):成功「已复制 N 块」1.5s、
     失败「复制失败:<原因>」6s,并记进 `trace`(`copy:ok/fail/err`)。
6. **测试接缝**:新增 `__bowLogseq.forceCopyFailure(bool)`。`window.browserAPI` 是 contextBridge 暴露的
   **不可写**对象(实测赋值静默无效),所以「剪贴板写入失败」这条路径在页面里伪造不出来 ——
   留这个显式开关,才能把「复制没成功就绝不删块」变成可重复的红/绿判据(内部页面才有这个把手)。
7. **顶层裸行提示**:`.meta` 里挂一条「本页有 N 行不在块里(不渲染)」,把 R2 从「表格坏了」里摘出去。

### 7.3 pre-fix 红测(证明判据不是空的)

pre-fix 用 `/tmp/logseq-e2e-prefix.mjs`(`waitFor` 超时改成记 FAIL 不抛 + §Q 单元格判据加 `row` 守卫),
**109/124**。红点:

| 判据 | pre-fix 实测 |
| --- | --- |
| 表格(§Q 全部) | `|-|--:|` 判不出分隔行 ⇒ `.md-table` 等不到,行数/表头/对齐/`data-line` 全红 |
| 换行后自动增高 | `22 → {"h":22,"scroll":42}`(高度不变、内容有 42px)**← 用户症状被复现成判据** |
| `Process`/`229` 下的 `Ctrl+Enter` | `{"value":"甲","caret":1}` —— 什么都没发生 |
| 第二行行首 Backspace 合并 | `{"value":""}`(旧行为下压根没有第二行,Backspace 把字删了) |
| 复制成功后右下角提示 | `null`(HEAD 上还没有这个提示) |
| `forceCopyFailure` 开关 | HEAD 上不存在 ⇒ 明写一条 FAIL |

### 7.4 未验证 / 下一轮

1. **「复制不生效」的真机原因仍未实证**:WSL 里剪贴板写入总是成功,所以只能在**强制失败**下验证「不删」。
   本轮已经把失败做成**看得见 + 可追溯**(右下角提示文本 + `__bowLogseq.trace` 的 `copy:*`),
   下一次真机若还失败,直接看这两处就能定位是「写入没生效」还是「按键没到」。
2. **真机复测**(需 `wsync` → Windows `npm run build` / `npm run dist` → **重启** bow):
   ① 你图里的表(`|-|-|` 形态)是否渲染;② 中文输入法下 `Ctrl+Enter` 是否稳定换行、换行后行高是否正常;
   ③ 多块复制/剪切与右下角提示。
3. `Shift+Enter` 在中文输入法下仍可能被吃掉(平台限制)。
4. 顶层裸行依旧不渲染(你拍板只修块里的表),只多了一条提示。
