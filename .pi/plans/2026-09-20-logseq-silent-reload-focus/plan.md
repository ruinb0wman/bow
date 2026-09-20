# 笔记插件:保存后的「静默重载」把编辑器顶掉(焦点丢失)

- 状态:计划待批
- 日期:2026-09-20
- 涉及:`src/plugins/logseq/main.ts`、`src/plugins/logseq/ui/JournalView.vue`(可能 + `ui/BlockRow.vue` 注释)、
  `tests/logseqPlugin.test.ts`、`/mnt/d/tmp/logseq-e2e-wsl.mjs`、`README.md`

## 1 目标

用户报:「笔记插件有一个问题,换行时有一瞬间有焦点,但似乎是换行会触发保存,然后输入就失去焦点了」。

要达成:编辑过程中**任何自动保存都不再让编辑器退出**;停顿 ≥0.5s、回车换行、外部改文件这几种情况下,
正在编辑的块保持编辑态与键盘焦点(光标不丢),`Ctrl+Z` 的历史不再被清掉。

### 假设(需要用户/环境确认,不改判定)

- 用户真机 = **Windows**(已用 live bow 的 `navigator.userAgent` 确认:`Windows NT 10.0`,Chrome/152);
  代码工作区在 WSL `/home/ruinb0w/Workspace/browser`,靠 `.wsync.config.js` 同步到 `/mnt/d/Workspace/browser`
  后在 Windows 侧 `npm run build` 运行。
- 因此 **WSL 的 E2E 只是代理**,最后一步必须在 Windows 真机手动复核。

## 2 根因(已确认:每次保存后都发生,不是回车特有)

用户观察:

| 问题 | 回答 | 推论 |
| --- | --- | --- |
| 光标消失时块的样子 | **退回渲染态**(textarea 消失、显示渲染后的 markdown) | 说明 `editingKey` 被清成了 `null` |
| 不按回车、只打字停 ≥0.5s 再继续 | **也会** | 说明与「换行/新块」无关,是**每次防抖保存之后**都发生 |

`editingKey` 只有两个地方会被清(:148 `loadResult`、:377 blur 分支),而 blur 分支要求真的发生 blur。
页面里没有任何元素被点开、也没有卸载触发的 blur(见下方实验),所以只剩 **`loadResult()`** ⇒
**每一次自动保存都会引发一次「静默重载」**。

链路(全部引自现码):

1. 打字 → `scheduleSave()` 400ms 防抖 → `savePage` 写盘;
2. 写盘走原子写(`main.ts:312-324`):`.tmp-<rand>` → rename;
3. **写完才记账**(`main.ts:426-427`):

   ```
   const mtimeMs = (await io.mtimeMs(path)) ?? Date.now()
   const rel = await relOf(path)
   noteRecentWrite(rel)
   ```

   而「回声」的抑制是**在 watcher 事件到达的那一刻**查这张表(`main.ts:186-189`):

   ```
   const rel = filename ? String(filename).split(sep).join('/') : ''
   const written = rel ? runtime.recentWrites.get(rel) : undefined
   if (written && now - written < SELF_WRITE_MS) return
   ```

   文件系统在 rename 那一刻就已经产生通知,而 `noteRecentWrite` 还要等 `await io.mtimeMs()` 那一轮线程池
   往返 ⇒ **通知几乎必然先到**,回声照旧进 `pending`;
4. 250ms 后 `flushWatch()`(:202-219)把自家路径放进 `graph-changed`;
5. 页面侧 `subscribe()`(`JournalView.vue:595-608`)判定 `p === meta.rel` 为「相关」,而这时 `dirty` 已经是
   `false`(保存刚成功)⇒ 走 `reloadFromDisk()`;
6. `openView()`(:176-196)把 `status` 置成 `loading` ⇒ `<main>` 整块被卸载重建;`loadResult()` 里
   `editingKey.value = null`(:148)、`undoStack/redoStack = []`(:154-155)⇒ **textarea 消失、块退回渲染态、
   焦点丢、撤销历史清空**;
7. 整条链路在一次 IPC 往返内跑完(< 一帧),所以看不到「正在载入…」的闪;`.blocks` 的
   `getBoundingClientRect().top` 不变,所以 §M 的「不推动正文」判据也看不出问题 —— 这就是它一直没被抓到的原因。

### 支撑实验(在用户 live bow / Chromium 152 上实测)

1. 把 focused `textarea`(或其祖先容器)从 DOM 摘掉:**blur / focusout 一个都不发**(window 捕获阶段监听
   也没有);`document.activeElement` 直接变成 `BODY`。
2. 「先摘旧的 → 再建新的 → 在 flush 之后的微任务里 `focus()`」(Vue 的 `nextTick` 语义)⇒ 新 textarea 稳稳拿到
   焦点,并在 0ms / 50ms / 300ms 三个采样点都还在。

   推论:**浏览器既没抢焦点、也没在卸载时发 blur** —— 代码里「textarea 被卸下会触发 blur」的说法是错的
   (当年那个「重载后冲突横幅又弹回来」的真凶是点横幅按钮时 mousedown 引起的**真** blur)。
   于是「块退回渲染态」只能由 `loadResult()` 解释。

### 顺带被同一根因带坏的两件事(修完自动好)

- 每次保存后 `undoStack` 被清空 ⇒ **停顿一下之后 `Ctrl+Z` 无效**;
- 每次保存后编辑器退出 ⇒ 必须重新点一次块才能继续写(就是用户报的这个)。

### 未确认的细节(不影响修法)

具体是哪条漏网路径在 Windows 上触发,可能存在三条,都靠 §3 的第 2 层兜住:

1. 通知比 `noteRecentWrite` 早到(上面的 race);
2. 原子写的 `.tmp-<rand>` 兄弟路径与真路径落进同一个 250ms 批次,真路径若没被吞掉就 `related`;
3. 拿不到文件名的目录级事件被 `!path` 当成了 related(`JournalView.vue:603`)。

## 3 方案(四层,任一层单独就能让症状消失;一起做是为了不再复发)

### 层 1:把自家回声吞干净(根因,`main.ts`)

- `noteRecentWrite(rel)` **提到 `writeFileAtomic` 之前** —— 先记「我马上要写这个路径」,通知不可能比记录更早;
- 写失败时把记录删掉(避免 phantom 记录在 3s 内误吞真的外部改动);
- `flushWatch()` 里再加一道**按时刻无关的过滤**:仍在 `SELF_WRITE_MS` 内、且命中
  `p === rel || p.startsWith(rel + '.tmp-')` 的路径一律剔除;
- 过滤后 `paths` 为空 ⇒ 直接 return(不 `emit`、不刷索引;索引在 `savePage` 里已经就地更新过)。

### 层 2:「内容没变就不算改动」(渲染层,最硬的一层)

- `openView(next, opts?: { silent?: boolean })` 增加 silent 语义:silent 时**只有**在
  `viewKey(res.view) === viewKey(view.value)` 且 `res.raw === currentRaw()` 的情况下做**无操作返回**
  —— 只刷新 `meta.exists / meta.mtimeMs`(冲突基线要跟着磁盘走),**不动 `status`、不动 `file`、不动 DOM**;
- `reloadFromDisk()` 改用 silent 路径(`graph-changed` 处理器与标题栏「重新载入」按钮都走它);
- 效果:任何自家回声(包括空文件名事件、平台通知语义差异)都退化成 no-op ⇒ 焦点、编辑态、undo 栈全保留;
  **内容真的不同**(真外部改动)照旧重载。
- trace 记号:`open:journal:silent` + `reload:noop`(E2E 断言用)。

### 层 3:同页的真实重载也要保住编辑器(渲染层)

- `loadResult(res)` 里先算 `sameView`,再决定要不要清 `editingKey`:

  ```
  const sameView = viewKey(res.view) === viewKey(view.value)   // 要在 view.value = res.view 之前算
  const keep = sameView ? editingKey.value : null
  ...
  editingKey.value = keep && findBlock(file.value!, keep) ? keep : null
  ```

  (`findBlock` 由 `@plugins/logseq/shared` 再导出;块没了才清空。)
- 为什么需要:Logseq 桌面端同时开着、或外部编辑器改了正在看的文件时,现在会把编辑器关掉;保留后
  编辑器不关、内容更新(Logseq 自己的手感),`<main>` 重建时 `BlockRow` 的 `{immediate:true}` watcher
  会重新 `focus()`(`BlockRow.vue:180-201`),光标自然回来;
- 不会误抢焦点:用户点了别处会先触发**真** blur ⇒ blur 分支(:374-379)已经把 `editingKey` 清成 `null`。

### 层 4(可选,体验补齐):同页重载时把 caret 也带回去

- 在 `openView` 顶部(任何 `await` 之前)读一次
  `document.activeElement instanceof HTMLTextAreaElement ? selectionStart : null`,
  sameView 重载时作为 `caretIntent` 交给 `loadResult` ⇒ 光标不再被甩到块尾。
- 层 2 生效后这条只在**真外部改动**时用得上;不做也不影响正确性。

### 注释/文档更正(防复发)

- `JournalView.vue:87-88` 与 :253-255 附近「textarea 被卸下会触发 blur」的说法要改掉,写明实测结论:
  Chromium 卸载 focused 元素**不发 blur**;`loadingView` 守卫挡的是**点击引起的真 blur**;
- `main.ts` 顶部第 5 条注释补上「回声抑制要在**写之前**记账,且不能依赖事件到达时刻」;
- README 的笔记插件小节补一条不变式:**自家写入绝不能让页面重载;同页静默重载必须做到「内容相同 = 不动 DOM」**。

## 4 步骤(每步独立可验证)

1. **探针先行(先跑现状,记录真实结果,不改判据)**
   - `tests/logseqPlugin.test.ts`:把 harness 的 `ipc.emit` 从 `emit: () => {}` 改成记录
     `{ event, args }`(现有 harness 里已有 `subscriptions` 结构,改动很小),加三条用例:
     a. 写**已存在**的日志文件后 800ms 内不得出现 `graph-changed`;
     b. 写**新建**文件(会经过 `.tmp-` 兄弟路径)同样不得出现;
     c. 对照组:`writeFileSync` 外部改动必须在 ~1.5s 内出现一次 `graph-changed`(证明 watcher 活着)。
   - `/mnt/d/tmp/logseq-e2e-wsl.mjs` 加 §N(焦点判据):
     - 回车后 `document.activeElement` 是**新块的 textarea**,且 1.5s 后仍是它(覆盖 400ms 防抖 + 250ms watch);
     - Enter 之后的 `window.__bowLogseq.trace` 里没有 `open:` 条目;
     - 对照组:聚焦某块打一个字、等 1.2s,`dirty === false` 且 textarea 仍在焦点上;
     - 层 2 判据:用 `writeFileSync` 把**逐字节相同**的内容写回磁盘 ⇒ 焦点仍在、trace 里出现 `reload:noop`;
     - 层 3 判据:写入**不同**内容 ⇒ 内容更新、焦点仍在原块上(编辑器没退出)。
   - 记录:WSL 上 a/b 可能本来就通过(平台时序不同)⇒ 如实记在 §8,这种情形以 Windows 手动复核为准。
2. **层 1**(`main.ts`):记账前移 + 失败回滚 + `flushWatch` 过滤 + `.tmp-` 剔除 → 跑步骤 1 的 a/b/c。
3. **层 2**(`JournalView.vue`):`openView({silent})` 的无操作返回 + `reloadFromDisk` 改走 silent
   → 跑 §N 的「相同内容 = 无操作」判据。
4. **层 3**(+ 可选层 4):`loadResult` 保留 `editingKey`(sameView + `findBlock`)、caret 带回
   → 跑 §N 的「不同内容 = 内容更新但编辑器不退出」判据。
5. **注释 / README 更正**(§3 末),`bun run build` 必须过(`.vue` 不在 `tsc` 检查范围内)。
6. **全量验证 + 提交**(feat / docs / docs(plans) 三段式,与最近几轮一致)+ 回填本文件 §8 实施记录。

## 5 验证清单

| 项 | 命令 / 做法 | 基线 |
| --- | --- | --- |
| 类型 | `bun run typecheck` | 过 |
| 构建 | `bun run build`(`.vue` 只在这里被检查) | 过 |
| 单测 | `bun run test` | 43 文件 / 838 例(本计划新增 3 例) |
| E2E(WSL) | `bun /mnt/d/tmp/logseq-e2e-wsl.mjs` | 54/54 ×2(本计划新增 §N ≈ 6 条) |
| **Windows 真机** | `wsync` → `/mnt/d/Workspace/browser` → Windows 侧 `npm run build` → 重启 bow;手动:①打字停 1s 编辑器不退出 ②回车后能接着打字 ③停顿后 `Ctrl+Z` 有效 ④外部改同一文件时编辑器不退出且内容更新 | 唯一硬证据 |

## 6 风险 / 未知

- **平台差异**:WSL 走 inotify(Node 的递归实现)/ Windows 走 `ReadDirectoryChangesW`,通知时序不同
  ⇒ 步骤 1 的探针在 Linux 上可能不复现;这种情况下 Windows 手动复核是唯一证据,不能因为探针绿了就收工。
- **Windows 侧是副本**:`/mnt/d/Workspace/browser` 是 wsync 过去的代码,历史上曾落后本工作区;
  同步后要在 Windows 侧重新 `npm run build` 才生效(用户 live bow 现在跑的就是那份)。
- **层 3 的取舍**:外部改动了正在编辑的块时会保留编辑态,光标落块尾(做层 4 才精确)。
- **层 2 的相等判据**用 `serializeLogseqFile()` 的输出比较:磁盘是**空文件**时 `loadRaw` 会塞一个内存空块
  (`JournalView.vue:130-139`),`res.raw !== currentRaw()` ⇒ 那一种情况会走一次真重载(只会多一次重载,
  不会漏改),可接受。
- **残留**:若真的有回声在 `dirty === true` 时漏过(层 1 失效),用户会看到一次「外部已改动」浮层 chip;
  它在下次保存成功时被清掉。不额外处理,但要在 §8 里记下这个已知残余。

## 7 明确不改(边界)

- `blur` 分支 `if (editingKey.value === payload.key) editingKey.value = null` 保留 —— 它挡的是真 blur;
- `loadingView` 守卫保留 —— 点「前一天/今天/搜索」等按钮引发的真 blur 依然会在换页期间触发 `saveNow()`;
- `subscribe()` 里 `!path → related` 的保守策略保留(靠层 2 兜底),不引入「空文件名就不相关」的新启发式;
- 不动 400ms 防抖、不动右下角状态浮层、不加「已保存」提示、不动 `graph-changed` 的广播面。

## 8 实施记录(2026-09-20)

### 先取证:根因两条独立证据

1. **单测探针(pre-fix,HEAD 的 `main.ts` + 新用例)**:自己保存后 900ms 内 `graph-changed` 的载荷是

   ```
   ["journals/2026-09-19.md.tmp-163t93ofm", "journals/2026-09-19.md"]
   ```

   即 `.tmp` 兄弟路径与**真路径**都进了同一个 250ms 批次 ⇒ 页面侧 `p === meta.rel` 命中 ⇒ 静默重载。
   两条回声用例 pre-fix 全红、两条对照组全绿;修后 4 条全绿。
2. **E2E §N 红测(pre-fix 构建,`/tmp/e2e-red.log`)**:打字 → 等 1.6s →

   ```
   [FAIL] 等过「保存 + watcher」窗口后焦点仍在同一块  — {"tag":"BODY","key":null,"editing":false}
   [FAIL] 这段窗口里一次静默重载都没发生  — 实际=1 期望=0
   ```

   `activeElement=BODY` + `editing=false` = 块退回渲染态 —— 与用户描述的「有一瞬间有焦点,然后输入就失去焦点」
   逐字对应。修后同一条判据绿(64/64)。

另外实测推翻了代码里的旧结论(Chromium 152 / Electron,已在 live bow 里验证):**卸载 focused 元素不会触发
`blur`/`focusout`**(window 捕获阶段也收不到),`activeElement` 直接变 BODY;且「卸载旧的 → 建新的 → flush 后
微任务里 focus」之后焦点稳稳留在新元素上。所以 `loadingView` 挡的是**点击**引起的真 blur,与「卸载」无关 ——
两处注释已改正。

### 与计划的偏差(4 处)

1. **层 1 加强**:计划是「写前记账 + flush 时过滤」,实现改成 **flush 时按磁盘内容比对 + 记录 3s 有效期 +
   先清过期再过滤**。理由:纯时间窗有两个坑 —— ①写完 3s 内第三方改了同名文件会被误吞(现在:内容不等 ⇒ 照常上报);
   ②过期记录若不清,会被无限期复用(现在:先 prune 再过滤,且 `isSelfWriteEcho` 自己再判一次有效期)。
   新增单测钉住了这两点(「写完 4s 后外部写回相同内容仍要广播」)。
2. **层 4(caret 带回)不做**:silent 重载根本不重建 `<main>`,textarea 是同一个 DOM 节点,光标由 DOM 自己保住;
   只有「内容真变了」那条路光标会落到块尾(接受)。
3. **新增两个 E2E 接缝**:页面 trace 增加 `graph-changed:<paths>` 条目(排「为什么重载了/为什么没重载」的唯一入口);
   调试把手增加 `reload`(= `reloadFromDisk`,走 `graph-changed` 处理器那条路)。
4. **E2E §N 的第 2/3 道闸改用 `reload()` 触发**,不靠 OS 事件:WSL/Electron 里**外部原地改 `pages/*.md` 的事件
   收不到**(同一次运行里 `journals/*.md` 收得到;系统 Node 跑同一逻辑的单测收得到)⇒ 靠它验会变成
   「什么都没发生 ⇒ 通过」的空判据。详见下面的「未决问题」。

### 验证

| 项 | 结果 |
| --- | --- |
| `bun run typecheck` / `bun run build` | 过(`.vue` 只有 build 会查) |
| `bun run test` | **43 文件 / 844 例**(基线 838,+6:回声 4 + pages 对照 1 + 过期记录 1) |
| `bun /mnt/d/tmp/logseq-e2e-wsl.mjs` | **64/64**(基线 54,§N 新增 10 条);pre-fix 红测 51/54 |
| Windows 真机 | **未验**(见 §9 的待办) |

### 改动文件

- `src/plugins/logseq/main.ts`:`recentWrites` 改成 `Map<rel, {at, raw}>`;`noteRecentWrite(rel, raw)` **前移到写之前**
  (写失败回滚记录);新增 `isSelfWriteEcho()`(内容比对 + 有效期);`flushWatch()` 先 prune 再过滤、只广播 `kept`;
  `startWatching()` 不再做到达时刻抑制;文件头第 5 条注释重写。
- `src/plugins/logseq/ui/JournalView.vue`:`openView(next, {silent})`(silent 不打 loading 态、同页同内容 = no-op);
  `loadResult(res, {keepEditing})`(同页重载保住 `editingKey`,`findBlock` 兜底);`reloadFromDisk` 走 silent;
  trace 增加 `graph-changed:`/`reload:noop`/`open:*:silent`;调试把手加 `reload`;两处「卸载触发 blur」注释改正。
- `tests/logseqPlugin.test.ts`:harness 记录 `ipc.emit`;新增「fs.watch 回声」6 例。
- `README.md`:笔记小节补「自动保存不得打断编辑(不变式)」。
- `/mnt/d/tmp/logseq-e2e-wsl.mjs`(仓库外):§N 10 条。

## 9 未决问题 / 待办

1. **Windows 真机验证(必做)**:`wsync` → `/mnt/d/Workspace/browser` → Windows 侧 `npm run build` → 重启 bow;
   手动:①打字停 1s 编辑器不退出 ②回车后能接着打字 ③停顿后 `Ctrl+Z` 有效 ④外部改同一文件时编辑器不退出且内容更新。
2. **WSL/Electron 里 `pages/*.md` 的外部原地改动收不到 watcher 事件**(本计划的 §N 因此改用调试把手):
   同一次运行里 `journals/*.md` 正常;`tests/logseqPlugin.test.ts` 用系统 Node 跑同一逻辑(pages/ 也在内)全部正常 ⇒
   更像是 **Electron 自带 Node 的递归 `fs.watch` 在 Linux 上的毛刺**(对「被 rename 覆盖过」的文件不报原地修改),
   而不是本插件的逻辑问题;Windows 走 `ReadDirectoryChangesW`,不受影响。**未定论**,已记入 scratchpad。
