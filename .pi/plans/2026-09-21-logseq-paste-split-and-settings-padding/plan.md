# 笔记插件:按 `-` 行粘贴成块 + 设置分区内边距

日期:2026-09-21 · 上一轮:`.pi/plans/2026-09-21-logseq-table-ime-copy-fixes/plan.md`(`c13e2ea` / `e821fd0`)

## 1. 目标与假定

用户两条:

1. **设置页「笔记」分区周围加 padding,参考其他插件**。
2. **粘贴时按每行前的 `-` 自动创建块**,不再把整段复制内容全塞进一个块。

已拍板的行为(Q&A,2026-09-21):

| 问题 | 拍板 |
| --- | --- |
| 带缩进的 `- ` 行 | **保留为嵌套子块**,并把整段重新对齐到当前文件的缩进单位 |
| 不以 `-` 开头的行 | **归上一个块做块内内容行**(等价 `Ctrl+Enter` 的行);开头就是这种行 → 并入当前块(当前块是空块时它单独成块) |
| 在块中间粘贴 | **在光标处劈开**:光标前 = 原块,粘贴块插中间,光标后的文字成为最后一个粘贴块之后的新块 |
| 粘贴后光标 | **最后一个粘贴块的末尾** |

假定 / 边界:

- 只有「粘贴文本里**至少有一行**是块行(`^\s*-(\s\|$)`)」才走新路径;不含 `-` 行的纯文本粘贴**保持现状**(默认粘贴 = 全部进当前块做块内内容行)。
- 单行 `- x` 也照此规则成块(规则统一,不做「单行就内联」的特例)。
- 不做:粘贴时重写/新建 `id::`(见 §5 风险 3)、跨块的富文本(HTML)粘贴、`*`/`+` 前缀识别。

## 2. 现状与证据(读过的代码)

### 2.1 设置分区没有任何 padding,而且**不能滚动**

`src/plugins/logseq/ui/LogseqSettings.vue:169`:

```css
.logseq-settings {
  font-size: 13px;
}
```

对比其他插件:它们的每一行都是全局的 `.set-row`(`src/renderer/src/style.css:702`):

```css
.set-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; }
```

(`CorsSettings` / `TerminalSettings` / `McpHttpSettings` / `DefaultBrowserSettings` / `AdblockSettings`
的模板根节点就是一个或多个 `.set-row`;历史插件用 `.hs-list { flex: 1; min-height: 0; overflow-y: auto; }`。)

而设置页给插件分区的是(`src/renderer/src/settings/SettingsPage.vue` 的 `<style>`):

```css
.settings-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding-bottom: 16px; }
/* 插件分区:占满剩余高度,让历史/广告等长列表用足空间 */
.settings-body-plugin { overflow: hidden; padding-bottom: 0; }
```

`.logseq-settings` 既没有 `flex: 1; min-height: 0` 也没有 `overflow-y`,在 `overflow: hidden` 的父层里
**内容一长就被裁掉、滚不动**(最近图最多 5 条 + 索引统计 + `config.edn` 只读小节,在小窗口下会超出)。
所以这次不只是加 padding,还要让它像其他插件一样自己滚。

### 2.2 块编辑完全没有 paste 处理

`ui/BlockRow.vue` 的 textarea 只有 `@input` / `@keydown` / `@blur`:

```html
<textarea v-if="editing" ref="area" v-model="draft" class="block-input" rows="1" spellcheck="false"
  @input="onInput" @keydown="onKeydown" @blur="emit('action', { type: 'blur', key: block.key })"></textarea>
```

全仓库 `grep -i paste src/plugins/logseq` = 0 命中(只有剪贴板**写**的 `writeClipboardText` / 复制、剪切)。
⇒ 多行粘贴走浏览器默认行为:整段(含换行)进 textarea → `onInput` → `setBlockContentLines` ⇒
**一个块 + 一堆块内内容行** —— 这正是用户要改掉的。

### 2.3 可复用的纯逻辑(都在 `shared.ts` / `format.ts`)

| 已有 | 用途 |
| --- | --- |
| `matchBlockLine(text) → {indent,text} \| null`(`format.ts:97`,正则 `^([ \t]*)-(?:[ \t]([\s\S]*))?$`) | 块行判据(粘贴判定 + 解析共用) |
| `parseLogseqFile(raw)` / `cloneFile(file)` / `reindex(file)` / `fileEol(file)` / `detectIndentUnit(file)` | 解析粘贴文本成森林;共享式深拷贝;重算 key;行尾;缩进单位 |
| `locate(file,key)` / `insertAfter(file,loc,block)` / `removeAt(file,loc)` / `insertTopBlock(file,i,block)` / `locateRef(file,block)` / `insertAfter` | 结构改动的**唯一安全通路**(顶层块必须走 entries 感知的助手 —— `topBlocks()` 是派生数组,见 `shared.ts:724` 的注释) |
| `newBlock(text,indent,eol)` / `setHeadText` / `writeContentLines` | 造块与写正文(属性行保序留在原位) |
| `commit(result)`(`JournalView.vue`) | 推 undo + 置 dirty + `editingKey = focusKey` + `caretIntent = null`(⇒ 新块挂载时 caret 落**末尾**,正好是拍板要求) |

## 3. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/plugins/logseq/shared.ts` | 新增 `isBlockPaste(text): boolean` 与 `pasteIntoBlock(file, key, payload): EditResult`(纯函数,§4 详述);顺手加私有助手 `insertManyAfterByRef` / `retargetPastedIndent` |
| `src/plugins/logseq/ui/BlockRow.vue` | textarea 加 `@paste="onPaste"`;`onPaste` 用 `isBlockPaste` 快判,**只有块状粘贴才 `preventDefault()`** 并把 `{ text, before, after }`(来自 `el.value.slice(caret/selectionEnd)`)发给上层;`BlockAction` 载荷加 `text?/before?/after?` |
| `src/plugins/logseq/ui/JournalView.vue` | `onBlockAction` 加 `case 'paste'`:调 `pasteIntoBlock(...)`,**返回同一个 file 对象就当 no-op**(不推 undo),否则 `commit(res)` |
| `src/plugins/logseq/ui/LogseqSettings.vue` | `.logseq-settings` 加 `flex: 1; min-height: 0; overflow-y: auto; padding: 4px 14px 20px`(14px 与 `.set-row` 的左右内边距对齐) |
| `tests/logseqShared.test.ts` | 新增 `describe('按块粘贴')`:逐条钉整份文件输出(含嵌套、非 `-` 行、光标处劈开、空块顶替、缩进归一、纯文本返回原对象) |
| `/mnt/d/tmp/logseq-e2e-wsl.mjs` | 新增 §T(设置分区 padding / 可滚动)与 §U(合成 `paste` 事件的 9 条判据,§4.4) |
| `README.md` §笔记 | 「块编辑」那条补一句粘贴规则;边界里写明「纯文本多行粘贴仍然是块内内容行」 |
| `docs/ARCHITECTURE.md` | §7.3 笔记分区补一句「整段可滚动 + 内边距与 `.set-row` 对齐」;§13 测试统计表更新 `logseqShared.test.ts` 行数/用例数与总数 |

不动:`format.ts`(解析器已够用)、`main.ts` / 剪贴板 IPC、顶层裸行渲染(用户拍板不做)。

## 4. 实现细节

### 4.1 `isBlockPaste`(判定的唯一出处)

```ts
/** 粘贴文本里有没有块行(`- x` / `-`,允许前导空白)—— 有才走「按块粘贴」 */
export function isBlockPaste(text: string): boolean {
  return text.split(/\r\n|\r|\n/).some((line) => matchBlockLine(line) !== null)
}
```

UI 用它决定要不要 `preventDefault`;`pasteIntoBlock` 内部再判一次(返回值同一个对象 = 调用方按 no-op 处理)。

### 4.2 `pasteIntoBlock(file, key, { before, after, text }) → EditResult`

```ts
export interface PastePayload { before: string; after: string; text: string }
```

算法(全部在 `cloneFile` 出来的副本上做,除 `reindex` 外不在中途重建 key):

1. `locate(next, key)` 拿不到 → `{ file, focusKey: null }`;`!isBlockPaste(text)` → 同样返回原对象。
2. 预解析**粘贴文本**:`parseLogseqFile(normalizeEol(text) + '\n')`(补行尾,避免最后一行与下一行黏住),
   并算出**粘贴文本自己的**缩进单位 `pastedUnit = detectIndentUnit(pasted)`(没有嵌套时返回 `'  '`,可接受)。
3. 把解析结果收成森林 `roots: BlockNode[]`:
   - `kind:'block'` 的条目直接入森林;
   - `kind:'raw'` 的裸行:
     - **第一个块之前**的裸行 → 攒起来,遇到第一个块时**单独成一块**(`head = 裸行[0]`,`writeContentLines(其余)`)插在它前面
       (保证顺序:粘贴开头就是正文时不会凭空多出一个空头块);
     - **块之后**的裸行 → 追加到「当前森林里**最后一个块**」(递归取最后一个子块)的 `extra`,
       `kind = propertyOf(line) ? 'prop' : 'content'`(顺序不变:写回时 `extra` 在 `children` 之前,落到最深最后一块才是最接近原文的位置)。
4. **缩进归一**(`retargetPastedIndent(block, unit, indent, pastedUnit)` 递归):
   - 块头:`head.text = indent + head.text.slice(oldIndent.length)`;
   - `extra` 每一行:`text = indent + unit + text.slice(min(oldIndent.length, oldIndent.length + pastedUnit.length))`
     → 相对缩进(代码围栏里的缩进)保留,整体落到本文件的缩进体系;
   - 子块:`indent + unit` 往下递归。
   顶层 `indent = indentText(target.block.head.text)`(粘进子块就跟着子块的缩进)。
5. 锚点(当前正在编辑的块)怎么处理:
   - `beforeLines = before.split('\n')`;`afterLines = after === '' ? [] : after.split('\n')`;
   - `keepAnchor = beforeLines.some(l => l.trim() !== '') || target.block.children.length > 0
                  || target.block.extra.some(x => x.kind === 'prop')`
     (**有隐藏属性行 / 有子块就不能顶替**,否则会静默丢掉 `id::` 或整棵子树);
   - `keepAnchor`:`setHeadText(target.block, baseIndent + '- ' + beforeLines[0].replace(/\s+$/,''))`
     + `writeContentLines(target.block, beforeLines.slice(1), baseIndent, unit, eol)`(与 `splitBlock` 同一套写法);
   - 不 `keepAnchor`:**先**把森林插到锚点之后,**再** `removeAt(next, loc)` 把空锚点摘掉(不留空块)。
6. 插入森林:`insertManyAfter(next, loc, roots)` ——
   `loc.parent ? loc.parent.children.splice(loc.index + 1, 0, ...roots)
   : roots.forEach((b, i) => insertTopBlock(next, loc.index + 1 + i, b))`
   (顶层必须走 `insertTopBlock`,直接 `loc.list.splice` 改不到 `entries`,这是 `shared.ts` 里写明的坑)。
7. 光标后有文字 → 造尾块(`newBlock(afterLines[0], baseIndent, eol)` + `writeContentLines(afterLines.slice(1), …)`),
   用 `locateRef(next, 最后一个粘贴块)` 定位后 `insertAfter` 插在森林之后。
8. `reindex(next)`,返回 `{ file: next, focusKey: 最后一个粘贴块的 key }`。
   `JournalView.commit()` 会把 `editingKey` 切到它、`caretIntent = null` ⇒ 新 textarea 挂载时 caret 落**末尾**。

一个来回的判据:把 `blocksToMarkdown()` 的输出(即文件原文)粘回同一页,应逐字节还原原文(嵌套/属性行都在)。

### 4.3 `BlockRow.onPaste` / `JournalView` 接线

```ts
function onPaste(event: ClipboardEvent): void {
  const el = area.value
  if (!el) return
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!isBlockPaste(text)) return // 纯文本:交给浏览器默认粘贴(全部进当前块做内容行)
  event.preventDefault()
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  emit('action', { type: 'paste', key: props.block.key, text, before: el.value.slice(0, start), after: el.value.slice(end) })
}
```

⚠️ `before`/`after` 取 **`el.value`**(DOM 真值)而不是 `draft.value`(v-model 在输入法组合期间可能落后一拍)。
默认粘贴被 `preventDefault` 拦掉,所以 `input` 事件不会再来一次 → 不会有「粘一遍 + 我们插一遍」的双写。

```ts
case 'paste': {
  const res = pasteIntoBlock(current, payload.key, {
    before: payload.before ?? '', after: payload.after ?? '', text: payload.text ?? ''
  })
  if (res.file === current) return // 非块状 / 找不到块:no-op(不推 undo)
  commit(res)
  return
}
```

### 4.4 设置分区 padding

```css
.logseq-settings {
  flex: 1;              /* 与 .hs / adblock 的根节点同款:占满剩余高度 */
  min-height: 0;
  overflow-y: auto;     /* 父层是 overflow:hidden,不自己滚就会把下半截裁掉 */
  padding: 4px 14px 20px; /* 左右 14px 与全局 .set-row 的 12px 14px 对齐 */
  font-size: 13px;
}
```

`.section-title:first-child { margin-top: 0 }` 保留(顶部 4px 由 padding 提供)。

## 5. 步骤(每步可独立验证)

1. **`shared.ts` 纯函数**(`isBlockPaste` / `pasteIntoBlock` + 两个私有助手):
   `npx vitest run tests/logseqShared.test.ts` 全绿。用例至少覆盖:
   ① 空块粘 `- 甲\n  - 甲子\n- 乙` → `- 甲\n  - 甲子\n- 乙`,focus = 最后一块的 key;
   ② 4 空格缩进粘进 2 空格文件 → 归一成 2 空格;tab 文件里粘进 tab 缩进;
   ③ `- 甲\n续行\n- 乙` → `- 甲\n  续行\n- 乙`(裸行归上一个块);
   ④ 开头就是裸行 `正文\n- 甲` → `- 正文\n- 甲`(不留空头块);
   ⑤ 光标处劈开:块 `甲乙丙` + before `甲` / after `乙丙` + 粘两行 → `- 甲` / 两新块 / `- 乙丙`;
   ⑥ 有 `id::` 属性的空块不被顶替(属性行保住);
   ⑦ 纯文本 → `res.file === file`(同一对象,调用方据此 no-op);
   ⑧ 粘贴是纯函数:不改动输入 file;未触及的行复用同一份 `SourceLine`;
   ⑨ 复制→粘贴往返:`blocksToMarkdown` 的输出粘回同一页 = 原文。
2. **`BlockRow.vue` + `JournalView.vue` 接线**:`npm run typecheck` && `npm run build`。
3. **`LogseqSettings.vue` padding/滚动**:同上(typecheck + build)。
4. **E2E 扩写**(`/mnt/d/tmp/logseq-e2e-wsl.mjs`,新 fixture `pages/paste.md`):
   - §T 设置分区:经 `chrome` 目标 `go('bow://settings')` → 连 settings target → 点侧栏「笔记」→
     断言 `getComputedStyle('.logseq-settings').paddingLeft === '14px'`、`overflowY === 'auto'`,
     且 `.settings-body` 里的第一行文字左边缘 = 导航右边缘 + 14px(比「贴边」可证);
   - §U 粘贴:用 `new ClipboardEvent('paste', { clipboardData: dt })`(`dt = new DataTransfer(); dt.setData('text/plain', …)`)
     在 textarea 上 `dispatchEvent`,并读返回值(`false` = 被我们 `preventDefault`):
     ① 块状粘贴 `dispatchEvent` 返回 `false`;② 落盘出现嵌套 `- 一\n  - 一子\n- 二\n`;③ 空块被顶替(块数不残留空块);
     ④ focus 落到最后一个粘贴块且 caret = 文本长度;⑤ `Ctrl+Z` 一次回滚粘贴;
     ⑥ 非 `-` 行成块内内容行;⑦ 4 空格 → 2 空格归一;⑧ 纯文本 `dispatchEvent` 返回 `true`(没被吃掉)且文件不变;
     ⑨ 光标处劈开的三段顺序。
   跑法:先 `npm run build`,再 `bun /mnt/d/tmp/logseq-e2e-wsl.mjs`(基线 125/125,连跑两次)。
5. **pre-fix 红测**:`cp -a src /tmp/src-postfix` → `git checkout HEAD -- src` → `npm run build` →
   跑副本(`waitFor` 超时不抛、改成记 FAIL 的 `/tmp/logseq-e2e-prefix.mjs`)→ 记录红点 →
   **`git checkout` 还原不行,必须 `cp -a /tmp/src-postfix/. src/` 还原并重建**(上一轮的教训)。
6. **全量回归**:`bun run test`(基线 45 文件 / 909 例)、`npm run typecheck`、`npm run build`。
7. **文档**:README §笔记 + `docs/ARCHITECTURE.md` §7.3 / §13 测试统计表(用例数与总数按实测改)。
8. **提交**:`feat(logseq): 粘贴按 `-` 行拆块 + 设置分区内边距`、`docs(logseq): …`(沿用前几轮习惯)。

## 6. 风险 / 未知

1. **合成的 `ClipboardEvent` 不等于真机 `Ctrl+V`**:WSL 侧 E2E 只能验「paste 事件处理器」这一跳
   (CDP 的 `Input.dispatchKeyEvent` 不执行默认编辑动作 —— 上一轮已实测),**真正的系统剪贴板 → Ctrl+V 通路仍需真机复测**。
   若 Electron 里 `new ClipboardEvent(..., { clipboardData })` 构造失败,退路是 `Object.defineProperty(ev, 'clipboardData', { value: dt })`
   再 dispatch(E2E 里加一处兜底,不污染生产代码)。
2. **`id::` 会被原样粘一份**:复制一个带 `id::` 的块再粘,会出现两个同 id 的块(Logseq 的块引用会困惑)。
   本轮选择「粘贴就是保留原文」,不做去重/重发 id —— 需要的话下一轮单独做(改的是用户文件里的属性行,得有明确拍板)。
3. **光标处劈开会新增一个尾块**:光标后有文字时块数 +1(与 `Enter` 劈块同语义)。用户拍板接受。
4. **粘贴文本里 `-` 行之外的行会改变当前块的内容行数**(归上一个块):若用户本意是把纯文本原样插进去,观感会不同。
   判据是 `Ctrl+Z` 一步可回滚。
5. `detectIndentUnit` 对「只有一个顶层块、没有嵌套」的粘贴文本返回兜底 `'  '`,4 空格来源会被当成 2 空格层 ——
   仅影响纯内容行(块头缩进只由森林深度决定),用例里钉住。
6. 设置分区的 `overflow-y: auto` 会在内容超高时出现滚动条(此前是**被裁掉**),属修正而非回归;
   其他插件分区不受影响(只改了 `.logseq-settings` 这个局部类)。

## 7. 不做的事

- 顶层裸行(非 `- ` 行)渲染 —— 用户上一轮已明确不做。
- `*` / `+` / `1.` 前缀当块行(只认 `-`,与用户表述一致;Logseq 的块就是 `- `)。
- 富文本(HTML)粘贴:一律取 `text/plain`,不解析剪贴板里的 HTML。
- 粘贴时改写 `id::` / 去重块 id(见风险 2)。

---

## 8. 实施记录(2026-09-21)

### 8.1 结果

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` / `npm run build` | 通过 |
| `bun run test` | **45 文件 / 930 例**(基线 909,+21:`logseqShared.test.ts` 55→76) |
| WSL E2E(`/mnt/d/tmp/logseq-e2e-wsl.mjs`,新增 §T / §U) | **145/145 通过**,连跑 2 次(基线 125) |
| pre-fix 对照(基线 = `ed01e87`) | **131/145**;14 条红点全落在本轮判据上(见 8.3) |

改动文件:`shared.ts`、`ui/BlockRow.vue`、`ui/JournalView.vue`、`ui/LogseqSettings.vue`、
`tests/logseqShared.test.ts`、`README.md`、`docs/ARCHITECTURE.md`、`/mnt/d/tmp/logseq-e2e-wsl.mjs`。

### 8.2 逐条

1. **设置分区**:`.logseq-settings` 加 `padding: 4px 14px 20px` + `flex: 1; min-height: 0; overflow-y: auto`。
   E2E §T 实测 `{padLeft:'14px', padTop:'4px', overflowY:'auto', inset:14, bodyOverflow:'hidden'}` ——
   首个小标题相对分区左边缘缩进 14px,与全局 `.set-row`(`12px 14px`)对齐;同时修掉「父层 overflow:hidden
   而这一节不自己滚 ⇒ 长内容被裁掉」的既有问题(§T 单独钉住 `overflowY === 'auto'`)。
2. **按块粘贴**:`shared.ts` 新增 `isBlockPaste()` / `pasteIntoBlock()`(纯函数,内部再切 `forestFromPaste` /
   `retargetPastedIndent` / `insertManyAfter` / `insertAfterByRef`);`BlockRow` 的 `@paste` 只在「含 `- ` 行」
   时 `preventDefault` 并把 `{text, before, after}` 报给 `JournalView`;`JournalView` 走 `commit()`(推 undo +
   焦点切到最后一个粘贴块)。所有拍板行为都有单测逐字节钉住(嵌套还原、非 `-` 行归上一块、光标处劈开、
   空块顶替、`id::` 不被动、4 空格/tab 归一、CRLF、尾部空行、复制→粘贴往返、纯函数性)。
3. **光标落点**:`commit()` 把 `caretIntent` 置 null,新块挂载时落末尾;唯一例外是「焦点块 key 没变」
   (往空块里只粘了一个块,Vue 按 `row.block.key` 复用同一实例、`editing` 一直为 true)——
   这时显式把 `editingKey` 置 null 再下一 tick 置回,重挂 textarea 让 watcher 走一遍(E2E 实测
   `{key:'2', value:'二', caret:1}`)。
4. **可排障**:`JournalView` 的 `__bowLogseq` 新增 `lastPaste`(最近一次粘贴载荷)+ `trace('paste:focus=…')`;
   E2E §U 第一条判据就是「事件里的多行缩进文本原样到达处理器」——这次就是靠它把问题钉在 E2E 自己身上。

### 8.3 pre-fix 红测(证明判据不是空的)

pre-fix 用 `/tmp/logseq-e2e-prefix.mjs`(`waitFor` 超时改成记 FAIL 不抛;`lastPaste` 取值加守卫;
`focusBlock` 容忍「已经在编辑态」),**131/145**。红点:

| 判据 | pre-fix 实测 |
| --- | --- |
| 块状粘贴被接管 | `dispatchEvent` 返回 `true`(压根没有 paste 处理器) |
| 事件文本到达处理器 / 内存块树 / 嵌套可见行 | `lastPaste = null`、raw 仍是 `- 顶\n-\n- 底\n`、rows 只有 3 块 |
| 光标落在最后一个粘贴块末尾 | `{key:'1', value:'', caret:0}`(什么都没发生) |
| 粘贴留痕 / 落盘 | trace 里只有 `reload:noop`;文件仍是 fixture |
| 非 `-` 行 / 缩进归一 / 光标处劈开 | 三条落盘判据全红(文件内容不变) |
| 设置分区 padding / 滚动(§T 四条) | `{padLeft:'0px', padTop:'0px', overflowY:'visible', inset:0}` |

(有意为之的「pre-fix 也 PASS」:纯文本不拦默认行为、Ctrl+Z 空栈无操作、侧栏有「笔记」分区 —— 这些是回归项,不是新判据。)

### 8.4 E2E 侧踩到的两个真问题(都不是被测代码的 bug)

1. **`collapsed` 是页面级 ref,换页不清**(`loadResult` 只重置选区 / 撤销栈):§S 在 md-table 的圆点上点过一下
   (折叠 key `1`),§U 的 paste 页 key `1` 正好是粘贴出来的父块 ⇒ 子块被折叠、`rows` 少一行。
   **这是既有行为**(与本次改动无关),§U 里显式展开后再断言;已记进 scratchpad 待定。
2. **外部写入若与主进程刚写过的内容逐字节相同,会被当回声吞掉**(`isSelfWriteEcho` 比内容):
   §U 的 fixture 重置因此不能等 `graph-changed`,改成调调试把手 `reload()` 显式重读
   (顺带把 `meta.mtimeMs` 基线刷新到磁盘当前值,否则紧随其后的保存会**假报冲突**)。
   第一次跑 §U 就是栽在这上面(出现 `conflict:detected`,后续判据全被 `conflict` 挡住)。

### 8.5 未验证 / 下一轮

1. **真机复测**(需 `wsync` → Windows `npm run build` / `npm run dist` → **重启** bow):
   ① 从你图里复制一段带缩进的 `- ` 列表粘进日志(看层级、缩进单位、光标落点);
   ② 在块中间粘贴(看是否在光标处劈开、文字顺序);
   ③ 设置页 → 笔记:内边距与滚动条。
2. **真机 `Ctrl+V` 这一跳仍未验证**:WSL E2E 只能合成 `paste` 事件(CDP 的 `Input.dispatchKeyEvent`
   不执行默认编辑动作,按 Ctrl+V 不会真粘);系统剪贴板 → 事件的通路要在真机上确认。
3. 粘贴带 `id::` 的块会产生重复块 id(本轮按「保留原文」处理,见 §7/README 边界)。
