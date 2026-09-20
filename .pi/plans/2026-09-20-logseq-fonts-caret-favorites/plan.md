# 笔记插件:字号可配 + 点击落行尾 + 收藏页面 + 修「全选删行变成合并上一行」

日期:2026-09-20 · 模式:plan · 目标插件:`src/plugins/logseq/`(`bow://logseq`)

## 1. 目标与假设

1. **字号可配**:设置页「笔记」分区加一个字号控件,作用于**整个笔记正文**(块正文 / 编辑框 / 行内标题按 em 比例);页头控件(标题栏、搜索框、按钮)保持固定大小。
2. **点击落行尾**:渲染态点某一行 → 进编辑态后光标落在**被点那一行的行尾**(多行块就是那一行,不是整块末尾);点击 `[[链接]]` / `#标签` / URL / 复选框的既有跳转与勾选行为不变。
3. **收藏页面**:参考 Logseq 的「收藏」——在笔记页里收藏当前日志/页面,再一键打开。
4. **Bug**:选中某行全部文本后按 Backspace,内容没有消失,而是被并进了上一行末尾 → 必须变成「删掉选中的内容」。

**关键假设(需要确认)**:收藏数据存在**插件自己的配置文件** `<userData>/logseq.json` 里(按图分开记),**不写**图里的 `logseq/config.edn`。
理由:`config.edn`「只读、永不写回」是本插件写在 README 与 `ARCHITECTURE.md` 里的不变式(它是用户笔记仓库的一部分,而且我们刻意没写真的 EDN 解析器,回写有改坏用户配置的风险)。
代价:Logseq Desktop 看不到 bow 里加的收藏。若你要的是「Logseq 侧也能看到同一份收藏」,那需要新开一批改动去写 `:favorites`(并接受上面那条风险),请现在说。

## 2. 现状(读过的代码与要改的行为)

### 2.1 Bug 根因(hard 确认)

`src/plugins/logseq/ui/BlockRow.vue` 的 `onKeydown`:

```ts
const caret = el?.selectionStart ?? 0
...
if (event.key === 'Backspace' && caret === 0) {
  event.preventDefault()
  emit('action', { type: 'merge', key: props.block.key })
  return
}
```

全选后 `selectionStart === 0`(选区的**起点**是 0),于是这条分支抢先 `preventDefault` 并走合并;
`mergeWithPrevious` 的实现正是 `prev.text + target.text`(`shared.ts`),所以内容「跑到上一行末尾」。
修复:只有**选区折叠**(`selectionStart === selectionEnd`)且 `caret === 0` 时才合并;有选区时把默认 Backspace 交还浏览器去删选区。

### 2.2 点击落点现状

`BlockRow.vue`:`startEdit` 优先落被点的 token 的 `data-src` 偏移,点在空白/行首时退到 `[data-line]` 的 `data-base`(= **行首偏移**):

```ts
const src = target?.closest('[data-src]')?.getAttribute('data-src')
  ?? target?.closest('[data-line]')?.getAttribute('data-base')
emit('action', { type: 'start-edit', key: props.block.key, offset: src ? Number(src) : undefined })
```

`analyzeBlockLines()`(`format.ts`)已经给每行算出全局 `base`(`textarea` 全文偏移),行情末偏移 = `base + line.text.length`;模板里 `.block-line` 现在只挂了 `data-base`。
→ 加 `data-end`,`startEdit` 改读它即可,不用改 tokenizer。

### 2.3 设置与收藏的现状

`shared.ts`:

```ts
export interface LogseqSettings { version: number; graphPath: string; recentGraphs: string[] }
export function defaultSettings(): LogseqSettings { return { version: SETTINGS_VERSION, graphPath: '', recentGraphs: [] } }
export function withGraph(settings, graphPath) {
  ...
  return normalizeSettings({ graphPath: path, recentGraphs: recent })   // ← 只挑了这两个字段
}
```

⚠️ `withGraph` **丢弃**它没显式带上的字段。加 `fontSize` / `favorites` 后必须改成 `{ ...settings, graphPath, recentGraphs }`,否则每次切图都会把字号和收藏清空(现有 `tests/logseqShared.test.ts` 的 `withGraph` 精确断言也要一起更新)。

`main.ts` 已有 `store = ctx.storage<LogseqSettings>({ file: 'logseq.json', defaults: defaultSettings() })`,`activate` 里会 `normalizeSettings(store.get())` 后回写一次;IPC 面目前只有图 / 读写 / 视图,没有 `getSettings`,也没有收藏。
`JournalView.vue` 已经订阅 `api.plugins.onEvent`(现在只处理 `graph-changed`),适合复用同一处接收新事件。
`LogseqSettings.vue` 目前只 `invoke('getState')`,是只读展示。

## 3. 改动清单

### A. `src/plugins/logseq/shared.ts`

1. 常量与类型:

```ts
export const LOGSEQ_FONT_SIZE_RANGE = { min: 12, max: 24 } as const
export const DEFAULT_LOGSEQ_FONT_SIZE = 13   // 与全局 body 一致:默认不改观感
export const MAX_FAVORITES_PER_GRAPH = 30

export const LOGSEQ_EVENT = {
  graphChanged: 'graph-changed',
  settingsChanged: 'settings-changed',
  favoritesChanged: 'favorites-changed'
} as const

export interface LogseqSettings {
  version: number
  graphPath: string
  recentGraphs: string[]
  fontSize: number
  /** 图目录(规范化后的绝对路径)→ 该图的收藏(最近收藏在前) */
  favorites: Record<string, LogseqView[]>
}

/** 渲染页面需要的偏好(IPC 面) */
export interface LogseqClientSettings { fontSize: number; favorites: LogseqView[] }
```

2. `defaultSettings()` 补 `fontSize: DEFAULT_LOGSEQ_FONT_SIZE, favorites: {}`。
3. `normalizeSettings()`:字号用 `Number.isFinite` 判 + 夹到 `[min,max]`(坏输入落回默认);`favorites` 逐图规范化——键非空、值是数组、每项走 `parseView`、按 `viewKey` 去重、每图截到 `MAX_FAVORITES_PER_GRAPH`、空数组不保留键。
4. `withGraph()` 改成 `normalizeSettings({ ...settings, graphPath: path, recentGraphs: recent })`(**否则丢字段**)。
5. 视图工具重构 + 新助手:

```ts
export function parseView(input: unknown): LogseqView | null   // 由现有 normalizeView 抽出
export function normalizeView(input, fallback) { return parseView(input) ?? fallback }
export function favoritesFor(settings: LogseqSettings, graphPath: string): LogseqView[]
```

### B. `src/plugins/logseq/main.ts`

1. `clientSettings()`:`{ fontSize, favorites: favoritesFor(store.get(), runtime.root) }`(没图时收藏为空)。
2. 新增 IPC:
   - `getSettings` → `clientSettings()`
   - `setSettings(patch)` → 只认 `fontSize`(`normalizeSettings({ ...store.get(), fontSize: patch.fontSize })`),`store.setRaw`,广播 `LOGSEQ_EVENT.settingsChanged`(payload = `clientSettings()`),返回它。
   - `toggleFavorite(view)` → `parseView` 校验;在当前图列表里在/不在决定加/删(加时插到最前、截断到上限),`store.setRaw`,广播 `favoritesChanged`,返回 `{ favorites, on }`。**不需要单独的 remove**:下拉里的 × 就是对已收藏项再 `toggle` 一次。
3. 现有 `graph-changed` 的字符串换成 `LOGSEQ_EVENT.graphChanged`(与页面共用一处常量);`openGraph` 里的 `store!.set({ ...withGraph(...) })` 不改调用形式。

### C. `src/plugins/logseq/ui/BlockRow.vue`(需求 2 + bug)

1. `onKeydown` 开头取选区状态:

```ts
const start = el?.selectionStart ?? 0
const end = el?.selectionEnd ?? start
const caret = start
const hasSelection = start !== end
```

2. Backspace 分支加 `&& !hasSelection`;有选区时不拦,浏览器删掉选区 → `onInput` → `setBlockContentLines`(块内容变空)。
   顺带把 `ArrowUp && caret===0` / `ArrowDown && caret>=len` 也加 `&& !hasSelection`(有选中文本时按方向键不该跳块;这是同类误判,不属于本次 bug 报告但零风险)。
3. 模板 `.block-line` 加 `:data-end="line.base + line.text.length"`。
4. `startEdit` 改读行尾:

```ts
const line = target?.closest('[data-line]')
const offset = line?.getAttribute('data-end')
emit('action', { type: 'start-edit', key: props.block.key, offset: offset != null ? Number(offset) : undefined })
```

(落不到具体行时 `offset = undefined` → `caretIntent` 为 null → watcher 落到整块末尾,即原兜底行为。)
注释里「点哪落哪」「退回行首偏移」的说明同步改掉。

### D. `src/plugins/logseq/ui/JournalView.vue`(需求 1 + 3)

1. 状态:`const fontSize = ref(DEFAULT_LOGSEQ_FONT_SIZE)`、`const favorites = ref<LogseqView[]>([])`、`const favOpen = ref(false)`、`const favWrap = ref<HTMLElement | null>(null)`;`isFavorite = computed(() => favorites.value.some(f => viewKey(f) === viewKey(view.value)))`。
2. `refreshClientSettings()`:`invoke<LogseqClientSettings>('getSettings')` → 写 `fontSize` / `favorites`;在 `boot()` 的 `attach` 之后调用。
3. `toggleFavorite()`:`invoke<{ favorites: LogseqView[]; on: boolean }>('toggleFavorite', view.value)` → 写回 `favorites`。
4. `openFavorite(v)`:`favOpen=false; await saveNow(); await openView(v)`。
5. 模板根节点加 `:style="{ fontSize: `${fontSize}px` }"`(字号向下继承,`em` 标题按比例;页头固定 px 不受影响)。
6. `head-main` 里 `<h1 class="head-title">` 之后加星标按钮(`Star`,`:fill` 表示已收藏,`title` 收藏/取消收藏)。
7. `head-side` 加收藏下拉(容器 `ref="favWrap"`,按钮显示星 + 数量;`ul.fav-hits` 复用 `.search-hits` 的浮层样式,每项 `@mousedown.prevent` 打开、右侧 × `@click.stop` 取消收藏;点容器外或 `Esc` 关闭 —— 用 `document` mousedown 监听 + `favWrap.contains(target)` 判断,挂载时注册、`onBeforeUnmount` 移除)。
8. `subscribe()` 里按 `payload.event` 分派:`graphChanged` 走原逻辑;`settingsChanged` → 只更新 `fontSize`(payload 不含收藏,避免误覆盖);`favoritesChanged` → 只更新 `favorites`(payload 是该图的列表)。
9. `exposeDebugHandle()` 补 E2E 把手:`get fontSize`、`get favorites`、`toggleFavorite`、`openFavorite`。

### E. `src/plugins/logseq/ui/LogseqSettings.vue`(需求 1)

`onMounted` 里除 `getState` 再 `invoke<LogseqClientSettings>('getSettings')`;加一个「字号」`range`(`LOGSEQ_FONT_SIZE_RANGE`,显示 `N px`),`@change` 调 `setSettings({ fontSize })` 并回填返回值(与终端分区同款交互,即时保存无按钮)。
文案里那句「这一节是**只读**的」需要限定到 `config.edn` 那几条,**不能再说整个分区只读**。

### F. 测试

- `tests/logseqShared.test.ts`:
  - `normalizeSettings`:字号越界/非数字/NaN 的夹紧与兜底;`favorites` 去重、坏项丢弃、每图截断、空数组不保留、非对象输入兜底。
  - `parseView`:日志合法/非法日期、页面名空、null。
  - `favoritesFor`:按图取、切图互不影响。
  - 更新现有 `withGraph` 的精确断言(现在要带 `fontSize: 13, favorites: {}`),并**新增一条**:`withGraph` 不能丢 `fontSize`/`favorites`(这是本次最容易回归的点)。
- `tests/logseqPlugin.test.ts`(复用现有真文件系统 harness):
  - `getSettings`/`setSettings`:默认值、越界夹紧、写进 `h.settings.value`(等于落盘)。
  - `toggleFavorite`:`on → off → on`;按图分开(切到另一个图后收藏为空,切回来还在);重复收藏同页不产生两条;上限截断。
- 组件行为(点击落行尾、全选 Backspace)靠 E2E,不在单测里(仓库的 vitest 只跑 `tests/**/*.test.ts`、node 环境)。

### G. 文档

- `README.md`
  - 「笔记(bow://logseq)」:块编辑一条补「点行 → 光标落**行尾**」;新增「字号(设置页笔记分区)」与「收藏(标题旁星标 + 收藏下拉,按图记)」两条;数据存储一条从「只存图目录与最近图」改成「图目录 / 最近图 / 字号 / 收藏」。
  - 「设置页」一节:`笔记` 分区不再说「只显示」,写明可改字号,收藏在笔记页里管理。
- `docs/ARCHITECTURE.md`
  - 插件表 `logseq` 行:IPC 方法补 `getSettings setSettings toggleFavorite`,事件补 `settings-changed favorites-changed`,存储描述补字号 / 收藏。
  - 「四条不变式」表最后一行里的「(点哪落哪)」改成「(按行算出 textarea 全局偏移;点击落行尾)」。

## 4. 实施步骤(每步可独立验证)

1. `shared.ts`:常量 / 类型 / `defaultSettings` / `normalizeSettings`(+字号与收藏)/ `withGraph` 的 `...settings` 修复 / `parseView` + `favoritesFor`。→ 跑 `bun run test tests/logseqShared.test.ts`(先改测试再改实现会红,红→绿)。
2. `main.ts`:`clientSettings` + 三个 IPC + 事件常量替换。→ 跑 `tests/logseqPlugin.test.ts`(补新用例)。
3. `BlockRow.vue`:`hasSelection` 守卫 + `data-end` + `startEdit`。→ `bun run typecheck`;E2E 新增的两条判据在 HEAD 上先红(见 §5)。
4. `JournalView.vue`:根节点 `font-size`、星标、收藏下拉、事件分派、调试把手。→ `bun run typecheck` + `bun run build`。
5. `LogseqSettings.vue`:字号控件 + 文案。→ 打开 `bow://settings` 手点一次(或并入 E2E 的 `settings-smoke`)。
6. `bun run test`(全量)、`bun run typecheck`、`bun run build`。
7. 扩展 `/mnt/d/tmp/logseq-e2e-wsl.mjs`(WSL 侧,见 §5)并跑通;Windows 真机脚本不存在,本次仍不覆盖 Windows。
8. `README.md` / `docs/ARCHITECTURE.md`。
9. 提交(沿用仓库习惯:feat/fix + docs + docs(plans) 三笔,或按最终改动合并)。

## 5. 测试与验证

基线(2026-09-20 日志):`bun run test` **44 文件 / 854 例**;`/mnt/d/tmp/logseq-e2e-wsl.mjs` **64/64**。

新增 E2E 判据(加到 `logseq-e2e-wsl.mjs`,新开一节 `P. 字号/落点/全选删除/收藏`):

1. **全选删除(红测)**:一个有两行的页,聚焦第 2 块 → `el.setSelectionRange(0, el.value.length)` → `pressKey(Backspace)` → `save()` → 断言磁盘文件里**不再**出现「第 2 块文本接在第 1 块末尾」;第 2 块文本消失。HEAD(未修)上必红:文件会变成合并后的单块。
2. **点击落行尾**:多行块(`split-base / 第一行 / 第二行`),对第 2 行的 `.block-line` 调 `.click()` → 断言 textarea 的 `selectionStart === ` 该行 `data-end`,且 `> ` 第 1 行行末。
3. **字号**:`invoke('logseq','setSettings',{fontSize:20})` → 断言 `getComputedStyle(.block-rendered).fontSize === '20px'`,且 `.head-title` 仍是 `16px`(页头不缩放);再设回默认,确认不变形。
4. **收藏**:进某个页面 → 点标题旁星标 → `getSettings().favorites` 含该 view 且 `on:true`;切到别的页 → 打开收藏下拉并点第一项 → `view` 回到收藏页;再点星标取消 → 列表为空;切到第二个图 → 收藏为空,切回第一个图仍在。

回归:现有 64 条判据(尤其 §D 双链点击跳转、§L 行级渲染/复选框、§N 静默重载与焦点)必须仍全绿。
`focusBlock()` 自己会把光标 `setSelectionRange(9999,9999)`,所以「点击落行尾」不会改变它的行为。

## 6. 风险 / 未决

1. **`withGraph` 丢字段**(§2.3):不加 `...settings` 就每次切图清空字号与收藏;已列为必改 + 专门测试。
2. **收藏作用域**:按图(`favorites[graphPath]`)记。同一图若被解析成不同路径字符串(大小写 / 尾斜杠)`openGraph` 会 `resolve()` 规范化,一般稳定;真机若发现分裂,再考虑按 `realpath` 归一。
3. **写入策略**:不写 `logseq/config.edn`(见 §1 假设)。若你要 Logseq Desktop 共享收藏,需要另立计划(真 EDN 读写 + 与运行中的 Logseq 抢写风险)。
4. **点击落行尾是行为变更**:放弃「点 token 落在 token 原文偏移」。现有 E2E 没有断言被点偏移,仓库也无组件单测,所以只有文档里的措辞要改;但若有用户习惯了精确落点,这是可见回退。
5. **有选区时的其它键**:本次只改 Backspace(和方向键的守卫)。「选中一段文字后按 Enter」仍按原样在选区起点劈块(选中文本不会被替换),属于未修的小瑕疵,不列入本次范围。
6. **Windows 真机**:字号 / 收藏是纯逻辑与 CSS,风险低;Backspace / 点击依赖真实输入与 DOM,与平台无关,但本仓库的 Windows E2E 脚本仍未建立(沿用旧的「未验证」状态)。

## 7. 实施记录(2026-09-20,已完成)

**改了什么**:

- `src/plugins/logseq/shared.ts`:字号常量与范围、`LOGSEQ_EVENT`、`LogseqSettings.fontSize` + `favorites: Record<graph, LogseqView[]>`、`LogseqClientSettings`;
  `clampFontSize` / `normalizeFavorites`;抽出 `parseView`(与 `normalizeView` 分开);`favoritesFor`;
  **修 `withGraph` 丢字段**(改成 `...settings` 展开)。
- `src/plugins/logseq/main.ts`:新增 `getSettings` / `setSettings` / `toggleFavorite` 三个 IPC + `clientSettings()` / `setFavorites()`;`graph-changed` 字符串换成 `LOGSEQ_EVENT.graphChanged`。
  `setSettings` 的 fallback 传 `current`(坏输入/缺字段保留上一次的好值,而不是跳回默认)。
- `src/plugins/logseq/ui/BlockRow.vue`:`.block-line` 加 `data-end`;`startEdit` 改读行尾;`onKeydown` 取 `selectionStart/End` 得 `hasSelection`,给 Backspace(以及 ArrowUp/ArrowDown)加 `!hasSelection` 守卫。
- `src/plugins/logseq/ui/JournalView.vue`:根节点 `font-size`;标题旁星标 + 页头收藏下拉(点外面/`Esc` 关);`refreshClientSettings` / `toggleFavoriteView` / `openFavorite`;订阅 `settings-changed` / `favorites-changed`;调试把手加 `fontSize` / `favorites` / `isFavorite` / `toggleFavorite` / `openFavorite`。
- `src/plugins/logseq/ui/LogseqSettings.vue`:外观分区加字号 `range`(即时保存);把「整个分区只读」的文案限定到 `config.edn` 那几条。
- 测试:`tests/logseqShared.test.ts`(+5 条:字号夹紧、收藏规范化、`parseView`、`favoritesFor`、切图不丢字段);`tests/logseqPlugin.test.ts`(+3 条:`getSettings`/`setSettings` 夹紧与落盘、`toggleFavorite` 加/删/按图分开、坏输入不写)。
- `README.md` / `docs/ARCHITECTURE.md`:补字号、收藏、点击落行尾与 `logseq.json` 存储描述。

**与计划的差异**:

- 收藏用 `Record<graph, view[]>` 按图分开存,IPC 只给当前图一份(计划里就是这么设想的,落实时确定)。
- 没做 `removeFavorite`:下拉里的 ✕ 就是对已收藏项再 `toggleFavorite` 一次(少一个接口)。
- `setSettings` 的坏输入语义定为「保留上一次」,并写了单测。
- E2E 新增了一个专用页 `pages/select-del.md`(块 0 多行、块 1 有上一个兄弟)。

**验证结果**:

- `npm run typecheck` / `npm run build` 过。
- `npm run test`:**44 文件 / 862 例**(基线 44 / 854,+8)。
- `/mnt/d/tmp/logseq-e2e-wsl.mjs`(WSL 侧隔离实例):**77/77**(基线 64,§P 新增 13 条)。
  关键实测:字号 20 → `.block-rendered` 20px 而 `.head-title` 仍 16px;点第 2 行 → `selectionStart === 10`(= `data-end`);
  收藏→跳走→从下拉点回→✕ 取消(用 mousedown+mouseup+click 的真实序列验)。
- **pre-fix 红测**:临时去掉 Backspace 的 `&& !hasSelection` 重新 build 后 **75/77** ——
  红的正好是 §P3 两条(「选中的内容被删掉了」「没有被并进上一行末尾」),实测磁盘文件变成 `- 第一块第二块`
  (与用户描述的「移动到前一行的末尾」逐字对应);跑完已把守卫改回并重新 build。
- 回归:现有 §A~§N 判据全绿(含 §D 双链跳转、§L 行级渲染、§N 静默重载/焦点)。

**仍未验证 / 边界**:

- Windows 真机未跑(本仓库的 Windows 侧 E2E 脚本尚未建立);mac 未跑。
- 收藏不写图里的 `logseq/config.edn`(维持「只读」不变式),所以 Logseq Desktop 看不到 bow 里的收藏。
- 点击落行尾是可见行为变更(放弃 token 精确落点);有选区按 Enter 仍是旧行为(在选区起点劈块)。
