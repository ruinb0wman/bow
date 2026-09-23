# 笔记插件两处修复:① 文件名是页面名的别名(防「新页覆盖原文件」)② 顶层空块 Backspace 不再死键

日期:2026-09-23 · 上一轮:`.pi/plans/2026-09-23-logseq-enter-at-block-start/plan.md`(块首回车前插空块,已实现、未提交)

两个问题都是上一轮 E2E 搭台时暴露出来的,彼此独立,可以分两批做/分两次提交。

---

## 1. 问题一:用**文件名**打开「`title::` 与文件名不同」的页 → 第一次保存就把原文件覆盖掉

### 1.1 现状与证据(读过的代码)

**认页只认显示名**(`src/plugins/logseq/graph.ts:340`):

```ts
export function resolvePage(index: GraphIndex, name: string): IndexedFile | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (isJournalDay(trimmed)) return index.byDay.get(trimmed) ?? null
  return index.byTitle.get(pageKey(trimmed)) ?? null
}
```

`byTitle` 的键是**显示名**(`graph.ts:162-168`,`parseIndexedFile` 里 `title = titleProp ?? decodePageName(stem)`,
即 `title::` 优先、否则解码后的文件名)。文件名词干在 `parseIndexedFile` 里**算过但没存**
(`const stem = (toPosix(input.rel).split('/').pop() ?? '').replace(MD_RE, '')`,只用来算 `day` 与 `title`)。

于是 `readPage` 走进「新页」分支(`src/plugins/logseq/main.ts:419-431`):

```ts
    const stem = encodePageName(trimmed)
    const path = join(runtime.root, runtime.config.pagesDir, `${stem}.md`)   // ← 与已存在的文件同一个路径
    const losesTitle = decodePageName(stem) !== trimmed
    return { view: { kind: 'page', name: trimmed }, path, rel: await relOf(path), exists: false, raw: ..., mtimeMs: null, ... }
```

`exists: false` + `mtimeMs: null` 顺着两层放大成**覆盖**:

- 渲染层:`JournalView.vue:207` `if (!hasBlocks(parsed)) parsed = insertFirstBlock(parsed).file` —— 空页在内存里
  有一个空块;`doSave()`(`JournalView.vue:408-412`)把 `baseMtimeMs: meta.value.mtimeMs`(此时是 `null`)递上去;
- 主进程:`savePage`(`main.ts:448`)`if (base !== null && diskMtime !== null && ...)` —— `base === null` 时
  **冲突检查整条跳过**,直接 `writeFileAtomic()` 覆盖。

**实测**(上一轮 E2E 搭 fixture 时):`pages/enter-top-props.md`(内容 `title:: EnterTopProps\n- 甲\n`)
被写成 `- \n- \n`,`title::` 与 `- 甲` 都没了。

搜索框这条路也一样(`graph.ts:312` 的 `searchPages` 只匹配 `pageKey(file.title)`):
用户敲文件名 → **0 命中** → `JournalView.vue:839-849` 的 `runSearch()` 在没有命中时 `openPage(typed)`
→ 正是上面那条覆盖路径。

两处工程债(顺手收掉):

- `main.ts:308-320` 的 `rebuildIndex()` 手抄了一份 `buildIndex` 的四张 map(且用 `f.title.trim().toLowerCase()`
  而不是 `pageKey`)。**加索引字段时漏改它就会静默失效** —— 本次要加 `byStem`,正好合并成一处。
- `savePage` 没有任何「我以为是新文件」的表达能力:`baseMtimeMs: null` 同时表示
  「新建文件」与「强行覆盖」(E2E 里就有「强行覆盖(baseMtimeMs=null)可以写下去」这条用例)。

### 1.2 方案 A(主修):文件名 = 页面名的**别名**

页面 identity 仍是显示名(不动),但**文件名也当成一个别名**:

1. `IndexedFile` 加 `stem`(解码后的文件名词干:`decodePageName(fileStem)`),`parseIndexedFile` 直接输出它
   (它已经算过这个值)。
2. `GraphIndex` 加 `byStem: Map<string, IndexedFile>`(`pageKey(file.stem) → file`),`buildIndex` 填。
   **只收页面**(`file.day === null`):日志按日期认页(`byDay` 那条路),把 `2026_09_20` 这类文件名也塞进
   `byStem` 会与「恰好叫这个的页面」撞键。
3. `resolvePage`:`byTitle → byStem`(日期分支不动)。
4. `searchPages`:同时匹配显示名与别名(前缀优先的判据也把别名算上),这样敲文件名时补全列表里能看见这一页,
   `runSearch()` 就会按**显示名**打开它。
5. `main.ts` 的 `rebuildIndex()` 改成 `return buildIndex({ root, config, format, files, tooLarge })` ——
   四张 map 只留一处。

效果:文件名与 `title::` 两个名字都指向同一个文件;`[[文件名]]` 也能点开(不再当新页)。

### 1.3 方案 C(加固,建议同批):保存时绝不静默覆盖「编辑器以为不存在」的文件

方案 A 把已知路径堵死了,但还有一类残留:**打开时文件真的不存在、保存时却已经有了**
(最现实的是日志 —— bow 里开着「今天」,Logseq 在中间把今天的日志建出来并写了模板,bow 一保存就覆盖它)。
这类只能写在**保存那一刻**:

- 保存载荷加 `expectMissing?: boolean`(渲染层:`meta.value.exists === false`);
- `savePage`:先看 `expectMissing === true && diskMtime !== null` → 与 mtime 冲突同样处理
  (`{ ok: false, conflict: true, diskRaw, mtimeMs }`),**不写**;
- 冲突横幅已经有了「用磁盘版本重载 / 强行覆盖磁盘」两个出口(`JournalView.vue:1196-1200`),
  所以「强行覆盖」必须能真的写下去:`overwriteDisk()`(`JournalView.vue:441-449`)在清 `mtimeMs` 的同时
  把 `exists` 置 `true`(否则守卫会再次拦下 → 死循环)。**这一处不改就是 bug。**

不改动既有契约:`expectMissing` 缺省时行为完全不变(老的「强行覆盖」用例、`logseqPlugin.test.ts` 里
不带该字段的保存都照旧)。

### 1.4 改动清单

| 文件 | 改什么 |
| --- | --- |
| `src/plugins/logseq/graph.ts` | `IndexedFile.stem`;`GraphIndex.byStem`;`buildIndex` 填 `byStem`(只收页面);`resolvePage` 加别名兜底;`searchPages` 匹配别名 |
| `src/plugins/logseq/main.ts` | `rebuildIndex()` 改为调用 `buildIndex`;`savePage` 支持 `expectMissing`(文件已存在 → `conflict`) |
| `src/plugins/logseq/ui/JournalView.vue` | `doSave` 传 `expectMissing: meta.value.exists === false`;`overwriteDisk` 置 `exists: true` |
| `tests/logseqGraph.test.ts` | 别名用例(独立 fixture,不动共享的 `graphFiles()`:它的文件数/读取次数被多条断言钉着) |
| `tests/logseqPlugin.test.ts` | 真实 fs:`readPage(文件名)` 拿到磁盘内容;`expectMissing` 守卫拒绝覆盖 |
| `README.md` | 「笔记」小节:文件名与 `title::` 互为别名、绝不静默覆盖 |
| `.pi/plans/2026-09-20-logseq-plugin/plan.md` | §3.4 索引结构补 `stem` / `byStem` |
| `docs/ARCHITECTURE.md` | §11 测试统计数字 |

### 1.5 步骤(每步可单独验证)

1. `graph.ts`:`parseIndexedFile` 里的局部 `stem` 改名 `fileStem`,输出 `stem: decodePageName(fileStem)`;
   `IndexedFile` 加字段注释(为什么它是别名)。
2. `graph.ts`:`GraphIndex.byStem` + `buildIndex` 填充(`if (!file.day) byStem.set(pageKey(file.stem), file)`)。
3. `graph.ts`:`resolvePage` 与 `searchPages` 接上别名。
4. `main.ts`:`rebuildIndex` 收敛到 `buildIndex`(纯重构,现有用例应全绿)。
5. `main.ts` + `JournalView.vue`:`expectMissing` 守卫 + `overwriteDisk` 清标记。
6. 测试 + 文档(见 §3)。

### 1.6 不做 / 明确遗留

- **反链面板不认别名**:`backlinksOf()` 按链接原文的小写 key 匹配,所以手写的 `[[文件名]]` 虽然现在能打开页面,
  但不会出现在那个页面的反链里。加别名匹配会引入误报(甲页文件名恰好等于乙页的显示名时,
  `[[乙]]` 会被算成甲的反链),要做得先给别名加「没有被别的显示名占用」的判据 —— 单独一轮再说。
- **`readPage` 的「磁盘兜底」**(索引没认出这个名字、但目标路径上已有文件 → 按磁盘打开):能覆盖
  `MAX_FILE_STEM`(160 字符)截断撞名这类极端情况。方案 A+C 下这类会**变成冲突横幅**(数据不丢,但要人工处理),
  所以不是必须;要做再加 8 行,连同 §3.2 的 E2E 判据一起。

---

## 2. 问题二:块首回车建出来的**顶层空块**,按 Backspace 是死键

### 2.1 现状与证据

上一轮加了「块首回车 → 在块前插空块」(`shared.ts:840` `insertSiblingBefore`)。在**文件第一块**上回车时,
新空块就是**首个顶层块**;此时按 Backspace(`BlockRow.vue:240-244`:块首 Backspace → `preventDefault()` +
emit `merge`)走到 `shared.ts:1054`:

```ts
export function mergeWithPrevious(file: ParsedFile, key: string): EditResult {
  const probe = locate(file, key)
  if (!probe) return { file, focusKey: null }
  const hasPrev = probe.index > 0
  const prevHasChildren = hasPrev && probe.list[probe.index - 1].children.length > 0
  if (!hasPrev || (prevHasChildren && probe.parent !== null)) return outdentBlock(file, key)
  ...
```

`hasPrev === false` → 交给 `outdentBlock`,`而 outdentBlock` 对**顶层块**直接返回 no-op
(`shared.ts:1030-1032`:`if (!target || !target.parent) return { file, focusKey: null }`)。

于是:没有上一个兄弟 + 顶层 ⇒ 既并无可并、又反缩不掉 ⇒ **按下去什么都不发生**(`file` 原样返回,
`commit()` 见 `result.file === file.value` 直接 return)。既有用例
「顶层第一块无法缩进 / 无法再反缩进(原样返回)」把这条 no-op 钉着;上一轮新加的
「块首回车 + Backspace 合并」用例也显式钉了首块这一支是 no-op。

(注:上一轮 plan §8.2 已把「块首回车后 Backspace 能并回」修正为**只对非首块成立**;非首块那支是好的。)

### 2.2 方案:顶层第一块若是**空块**就删掉自己

只在「outdent 也无事可做」这一支里补一条:

```ts
  if (!hasPrev || (prevHasChildren && probe.parent !== null)) {
    const out = outdentBlock(file, key)
    if (out.file !== file) return out            // 第一个子块:反缩进成功,就是它(行为不变)
    // 顶层第一块:并无可并、也反缩不掉。**空块**直接删掉自己(块首回车建出来的空块靠这条收掉),
    // 焦点交给下一块;非空块 / 页面上唯一的块保持原样(与 Logseq 一致,不能删掉最后一块)
    if (probe.list.length > 1 && isEmptyBlock(probe.block)) return deleteBlock(file, key)
    return { file, focusKey: null }
  }
```

配一个判据 `isEmptyBlock`(放在 `shared.ts` 的块助手区):

```ts
/** 空块:没有正文、没有内容行 / 属性行、没有子块 —— 删掉它不会丢任何东西 */
function isEmptyBlock(block: BlockNode): boolean {
  return blockText(block).trim() === '' && block.extra.length === 0 && block.children.length === 0
}
```

要点与边界:

- `extra.length === 0` 意味着带 `id::` / `collapsed::` 的块**永不**被这条删掉(属性行也算东西);
- `list.length > 1` 保证不会把页面清空(唯一块时维持原样);`deleteBlock` 的 fallback 恰好是
  「下一个兄弟」(`shared.ts:1079-1089`),焦点落点不用另写;
- 只影响「无上一个兄弟 + 顶层 + 空块」这一格;第一个**子块**仍走既有的「反缩进」语义(不动它);
- 与上一轮的功能天然闭合:块首回车建空块 → Backspace 收掉 → 文件逐字节回到原样。

### 2.3 步骤

1. `shared.ts`:加 `isEmptyBlock`;`mergeWithPrevious` 按上面改那一支(函数 doc 同步:
   「顶层第一块若是空块则删掉自己」)。
2. `tests/logseqShared.test.ts`:3 例(空块被删 + 焦点交给下一块 / 非空首块仍是 no-op / 唯一空块仍是 no-op)。
3. `README.md` 键位行(`块首 Backspace 合并` 补一句)与 `2026-09-20-logseq-plugin/plan.md` §3.2 的
   `mergeWithPrev` 行同步。
4. `docs/ARCHITECTURE.md` 测试统计数字。

---

## 3. 验证

### 3.1 单测

- `tests/logseqGraph.test.ts`(独立 fixture,不用共享的 `graphFiles()`):

  ```ts
  it('页面名的别名:文件名与 title:: 不同时两个名字都解析到同一个文件', async () => {
    const io = memIo({ '/graph/pages/enter-top-props.md': { content: 'title:: EnterTopProps\n- 甲\n', mtimeMs: 2 } })
    const index = await scanGraph(io, ROOT, DEFAULT_GRAPH_CONFIG, null)
    expect(index.files[0].stem).toBe('enter-top-props')
    expect(resolvePage(index, 'EnterTopProps')?.rel).toBe('pages/enter-top-props.md')
    expect(resolvePage(index, 'enter-top-props')?.rel).toBe('pages/enter-top-props.md') // 旧行为:null ⇒ 被当成新页
    expect(searchPages(index, 'enter-top').map((h) => h.name)).toEqual(['EnterTopProps'])
  })
  ```

  再加一条:日志**不**进 `byStem`(键不被页面别名抢走),以及 `resolvePage(index, '没有这个页')` 仍是 `null`。

- `tests/logseqShared.test.ts`(问题二 3 例):

  ```ts
  it('块首 Backspace:顶层第一块是空块 → 删掉自己,焦点交给下一块', () => {
    const out = mergeWithPrevious(parseLogseqFile('- \n- 甲\n'), '0')
    expect(serializeLogseqFile(out.file)).toBe('- 甲\n')
    expect(out.focusKey).toBe('0')
  })
  it('块首 Backspace:非空的首块 / 唯一的空块 → 仍是 no-op(不删内容、不删空页)', () => {
    const nonEmpty = parseLogseqFile('- 甲\n- 乙\n')
    expect(mergeWithPrevious(nonEmpty, '0').file).toBe(nonEmpty)
    const only = parseLogseqFile('- \n')
    expect(mergeWithPrevious(only, '0').file).toBe(only)
    const withProp = parseLogseqFile('- \n  id:: x\n- 甲\n')   // 带属性行 = 有东西,不删
    expect(mergeWithPrevious(withProp, '0').file).toBe(withProp)
  })
  ```

- `tests/logseqPlugin.test.ts`(真实临时目录,问题一的**写盘**那一层):

  ```ts
  it('用文件名打开 title:: 不同的页:读到磁盘内容,保存后文件一个字节不变', async () => {
    write(join(graph, 'pages', 'enter-top-props.md'), 'title:: EnterTopProps\n- 甲\n')
    await call('rebuildIndex')
    const read = await call<FileRead>('readPage', 'enter-top-props')
    expect(read.exists).toBe(true)                 // 旧行为:false ⇒ 空页
    expect(read.raw).toBe('title:: EnterTopProps\n- 甲\n')
    expect(read.view).toEqual({ kind: 'page', name: 'EnterTopProps' })
    const saved = await call<SaveResult>('savePage', { path: read.path, raw: read.raw, baseMtimeMs: read.mtimeMs })
    expect(saved.ok).toBe(true)
    expect(readFileSync(join(graph, 'pages', 'enter-top-props.md'), 'utf8')).toBe('title:: EnterTopProps\n- 甲\n')
  })

  it('expectMissing:文件在打开之后才出现 → 报冲突而不是覆盖', async () => {
    const path = join(graph, 'pages', 'race.md')
    write(path, '- Logseq 先建的\n')
    const res = await call<SaveResult>('savePage', { path, raw: '- bow 以为新建的\n', baseMtimeMs: null, expectMissing: true })
    expect(res.ok).toBe(false)
    expect(res.conflict).toBe(true)
    expect(res.diskRaw).toBe('- Logseq 先建的\n')
    expect(readFileSync(path, 'utf8')).toBe('- Logseq 先建的\n')   // 一个字节没动
    // 缺省(不传 expectMissing)时行为不变:仍是「强行覆盖」
    const forced = await call<SaveResult>('savePage', { path, raw: '- 强行覆盖\n', baseMtimeMs: null })
    expect(forced.ok).toBe(true)
  })
  ```

### 3.2 真机式 E2E(`/mnt/d/tmp/logseq-e2e-wsl.mjs`,仓库外)

在 §V 后面加 §W(现成 fixture 就是 `pages/enter-top-props.md`):

| # | 判据 | 期望 |
| --- | --- | --- |
| W1 | `openPage('enter-top-props')`(**文件名**) | `view.name === 'EnterTopProps'`、`rows` 是 `['甲']`(不是空页) |
| W2 | 接着 `save()` | 文件仍是 `title:: EnterTopProps\n- 甲\n`(旧行为:被写成 `- \n- \n`) |
| W3 | `window.__bowLogseq.search('enter-top')` | 命中 `EnterTopProps`(补全列表里看得见) |
| W4 | 首页块上 `Enter` → 再 `Backspace` | 文件逐字节回到 `title:: EnterTopProps\n- 甲\n`,焦点在「甲」 |

跑法不变:`npm run build` → `bun /mnt/d/tmp/logseq-e2e-wsl.mjs`(基线 **154/154**,连跑 2 次);
按仓库惯例做一次 **pre-fix 对照**(只回退被测的那一处,确认新判据变红)证明判据不是空的。

### 3.3 全量

`npm test`(基线 1006 例)、`npm run typecheck`。

---

## 4. 风险与未知

1. **`byStem` 的撞键**:同一目录下不可能有两个同名文件,所以 `pages/` 内不会撞;跨目录(日志 vs 页面)
   已按「只收页面」排除。剩下的是**页面名**撞键:`a/b`(文件 `a___b.md`)与页面 `a___b` 其实是同一个文件
   (编码是双射),不构成新问题。
2. **`resolvePage` 的行为变化是「从 null 变成有文件」**:调用方只有 `readPage`,没有别的分支依赖 null;
   `[[文件名]]` 从「新建页」变成「打开已有页」,正是本次目的。
3. **`expectMissing` 必须配 `overwriteDisk` 的 `exists: true`**,否则「强行覆盖」会被守卫反复拦下(§1.3 已标)。
4. **冲突文案**:现有横幅写的是「磁盘上的文件在你编辑期间被改过(可能是 Logseq 自己写的)」——
   对「新建时文件已存在」也算贴切,先复用;要更准可再补一句(可选,不动逻辑)。
5. **仍未验证**:Windows 真机(与上一轮同一限制),以及中文输入法下的块首回车 + Backspace 连击。

## 5. 建议的落地顺序

1. 问题二(3 处改动 + 3 例单测,纯逻辑、风险最低)→ 单独提交;
2. 问题一 A(别名)+ 步骤 4 的重构 → 提交;
3. 问题一 C(`expectMissing` 守卫)→ 与 A 同批或紧随其后(它单独存在时也有价值:日志竞态)。

---

## 6. 实施记录(2026-09-23)

### 6.1 落地与证据

改动文件:`src/plugins/logseq/graph.ts`(stem / byStem / resolvePage / searchPages)、
`src/plugins/logseq/main.ts`(rebuildIndex 收敛到 `buildIndex`、`savePage` 的 `expectMissing` 守卫)、
`src/plugins/logseq/shared.ts`(`isEmptyBlock` + `mergeWithPrevious` 的空块自删)、
`src/plugins/logseq/ui/JournalView.vue`(`doSave` 传 `expectMissing`、`overwriteDisk` 置 `exists: true`)、
`tests/logseqShared.test.ts`(+2 例,改 1 例)、`tests/logseqGraph.test.ts`(+2 例)、
`tests/logseqPlugin.test.ts`(+2 例)、`README.md`、`docs/ARCHITECTURE.md`、`.pi/plans/2026-09-20-logseq-plugin/plan.md`;
仓库外 `/mnt/d/tmp/logseq-e2e-wsl.mjs`(+§W 11 条判据)。

| 验证 | 方式 | 结果 |
| --- | --- | --- |
| 单测 | `npm test` | **46 文件 / 1012 例全绿**(基线 1006;shared 81→83、graph 16→18、plugin 31→33) |
| 类型 | `npm run typecheck` | 干净 |
| **真机式 E2E** | `npm run build` → `bun /mnt/d/tmp/logseq-e2e-wsl.mjs` | **165/165,连跑 2 次**(基线 154;§W 新增 11 条) |
| pre-fix 对照(问题二) | 去掉 `mergeWithPrevious` 的空块自删 | Backspace 后 `["","甲"]`、文件 `- \n- 甲`(红) |
| pre-fix 对照(问题一 A) | 去掉 `resolvePage`/`searchPages` 的别名 | 用文件名打开得到 `- \n`;写一笔保存后**文件变成 `-  追加`(原内容全丢)**;搜索 0 命中 |
| pre-fix 对照(问题一 C) | 去掉 `expectMissing` 守卫 | 外部先建的文件被静默覆盖成 `- bow 写的`(红) |

**复核(同一会话稍后再跑一遍)**:单测 1012 全绿、`typecheck` 干净、E2E **165/165 连跑 3 次**;
另单独做了一次「只停用 `expectMissing`」的 pre-fix 对照 → **162/165**,红的正好是 W5/W6/W7
(实测:外部先建的文件被静默覆盖成 `- bow 写的`)。

§W 实测(节选):

```
[PASS] 用文件名打开:拿到的是磁盘上的真实内容  — "title:: EnterTopProps\n- 甲\n"
[PASS] 用文件名打开后编辑并保存:原有内容还在(旧实现:整页被覆盖)  — "title:: EnterTopProps\n- 甲 追加\n"
[PASS] 搜索文件名能命中这一页(显示名)  — ["enter-top","EnterTopProps"]
[PASS] 块首回车:空块在上面  — ["","甲"]
[PASS] Backspace:空块被收掉,焦点交给下一块  — ["甲"]
[PASS] 外部先建的文件 → 报冲突而不是静默覆盖 / 磁盘上外部的内容一个字节没动
[PASS] 强行覆盖磁盘能写下去(不会反复报冲突)  — 证明 `overwriteDisk` 的 `exists: true` 是必需的
```

### 6.2 实施中改掉的三处计划细节

1. **旧用例必须改**:上一轮那条「块首回车 + Backspace 合并:非首块逐字节回到原样(首块是既有的 no-op)」
   里的首块分支断言(no-op)已经过时 —— 现在首块空块会被删掉。改成
   「首块与非首块都逐字节回到原样」,顺带把这条路径变成**双向闭合**的证据。
2. **E2E W1/W2 的顺序**:原先「先等 `view.name === 'EnterTopProps'` 再保存」在 pre-fix 下会
   `waitFor` 超时中断整个 §W,后面的判据跑不到;改成「等打开落地(预/后修都成立的条件)→ 断内容 →
   **写一笔** → 保存 → 断原内容还在」。`save()` 在页面不脏时是 no-op(原来那版 W2 pre-fix 会假绿),
   所以「写一笔」是必须的 —— pre-fix 也因此实测到了真正的数据丢失(`-  追加`)。
3. **W3 的断言放宽**:图里另有一个标题恰好是查询前缀的 fixture 页(`enter-top`),
   `search('enter-top')` 命中两个是正常的 ⇒ 只断「命中里包含 `EnterTopProps`」。

### 6.3 仍未做 / 明确不做

1. **反链面板不认别名**(计划 §1.6 已列):`[[文件名]]` 现在能打开页面,但不会算进那个页的反链 ——
   要做得先给别名加「没有被别的显示名占用」的判据,单独一轮。
2. **`readPage` 的磁盘兜底**(计划 §1.6):`MAX_FILE_STEM`(160)截断撞名这类极端情况会表现为冲突横幅
   (数据不丢,但要人工处理),没做。
3. **Windows 真机**:E2E 仍是 WSL/Linux 侧;真机需 `wsync` → Windows `npm run build` → 重启 bow,
   再按 §3.2 手验一遍(重点:中文输入法下的块首回车 + Backspace、以及用文件名打开一个 `title::` 页)。
