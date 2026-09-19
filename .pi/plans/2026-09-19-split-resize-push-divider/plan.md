# 分屏调大小:箭头 = 「把最内层那条分隔条朝箭头方向推」

> 修用户报的两处:
> ① 左右两窗格,聚焦**左**窗格按 `Alt+Shift+←` 不缩小;② 聚焦**右**窗格按 `Alt+Shift+→` 不缩小;
> 上下分屏同理(聚焦上窗格按 `↑`、聚焦下窗格按 `↓`)。**根因不是按键没送到,是 `resizePane()` 的语义写成了
> 「只推箭头侧那条边」** —— 贴窗口边界的那三个方向根本没有候选节点,整棵树原样返回。

## 0. 目标与已拍板

**目标**:`Alt+Shift+←/→/↑/↓` 的语义从「让聚焦窗格**朝该方向扩张**」改成
「**由内向外找第一层轴一致的分隔条,把它朝箭头方向推一步**」。这是本计划唯一的行为改动(+ 文档/测试跟着改)。

**已拍板(本轮问卷)**:

| # | 决定 |
| --- | --- |
| 1 | 语义 = **永远推最近的那层分隔条**(不是上一版问卷的「箭头 = 窗格扩张方向」)。推离窗格 = 窗格变小,推向窗格 = 窗格变大 |
| 2 | 只动**最内层**那一层,**不动外层同轴 `ratio`**(即上一版「贴边就向上一层找能扩的祖先」被取消) |
| 3 | 那条已经夹到 `RATIO_MIN/RATIO_MAX` ⇒ 整棵树原样返回(**夹紧后不再向外找**,理由见 §6.1) |
| 4 | 语义变化只做这一处;`Ctrl+Shift+方向`(分屏)语义不变 |

**修订的历史决定**:`.pi/plans/2026-09-19-nested-split/plan.md` §0 表格第 3 条「箭头 = 当前窗格要扩张的方向」
自本计划起作废(那份计划是历史记录,**不改写**,只在结论层留一句交叉引用)。

## 1. 现状(实读到的代码)

`src/shared/split.ts:169-193` 现在的实现(节选):

```ts
    if (node.axis !== axis) return node
    if (inA && leading) return { ...node, ratio: clampRatio(node.ratio + step) }
    if (inB && !leading) return { ...node, ratio: clampRatio(node.ratio - step) }
    return node
```

两个 `if` 就是 bug 本体:
- `inA && leading`(聚焦子树在 `a` 侧 + 箭头朝 `b`)= 分隔条在聚焦窗格**箭头侧**才推;
- `inB && !leading` 同理。
⇒ 聚焦**左**窗格按 `←`(`inA && !leading`)、聚焦**右**窗格按 `→`(`inB && leading`)、上下同理的四种组合,
在这层拿不到候选,只能靠 `walk()` 继续向上找;两窗格时上面没有别的节点 ⇒ **整棵树原样返回**(用户看到的「没反应」)。

文档里其实早就写着「箭头指着你要推的那条边」(`README.md:394`),但实现只推得动**箭头侧**那条 —— 那条是
**窗口外边界**时(正是用户报的四种情况)就什么也不做。

调用链(都不需要改,只是确认影响面):
`before-input-event`(`src/main/tabShortcuts.ts:151-160`,接管判据 `shouldTakeSplitHotkey`)→
`TabManager.resizeFocused()`(`src/main/tabManager.ts:722-739`,`tree === active.tree` 就 `return false`)→
`resizePane()`。渲染层 `splitPane(dir)`/`resizePane(dir)`(`groups:resize`,ARCHITECTURE §9)只是兜底与 E2E 入口,
**没有任何 UI 直接吃这个语义**。

## 2. 新语义(唯一依据)

**规则**:从聚焦窗格的叶子出发,**由内向外**找第一层「轴与箭头一致」的 `split` 节点,把它的 `ratio` 朝箭头方向推一步;
没有这样的节点、或它已经夹紧 ⇒ 整棵树原样返回(引用不变)。

| dir | 轴 | `ratio` 变化 | 聚焦窗格在 `a` | 聚焦窗格在 `b` |
| --- | --- | --- | --- | --- |
| `←` | `row` | `-step` | **变小** | 变大 |
| `→` | `row` | `+step` | 变大 | **变小** |
| `↑` | `column` | `-step` | **变小** | 变大 |
| `↓` | `column` | `+step` | 变大 | **变小** |

即:`ratio` 的变化量只由箭头决定(`leading ? +step : -step`),**与聚焦窗格在哪一侧无关**;在哪一侧只决定窗格是变大还是变小。

例子(用户报的两个 case,`row(左 | 右)`):

```
焦点左 + ← :推那唯一的分隔条往左 → 左 50%→45%(左窗格缩小)✅
焦点左 + → :往右推             → 左 50%→55%(今天就这样,不变)
焦点右 + ← :往左推             → 右 50%→55%(今天就这样,不变)
焦点右 + → :往右推             → 右 50%→45%(右窗格缩小)✅
```

嵌套(`row[A | row[N | N2]]`,焦点 N)—— 与今天**不同**的那一处(问卷里已明确接受):

```
N + → :内层 row 轴一致 → 推内层 → N 25%→27.5%  (今天一致)
N + ← :内层 row 轴一致 → 推内层 → N 25%→22.5%  (今天:推外层,整个右半变宽 ⇒ N 反而变宽)
```

## 3. 改动清单

### 3.1 `src/shared/split.ts`(唯一逻辑改动)

1. 文件头注释(第 6 行)与 `PaneDir` 的 doc(第 16 行)改成新语义。
2. `resizePane()`(169-193)重写为「路径 + 由内向外选层 + 只重建改动层到根这一段」。
   重写成路径式(而不是在现有递归里加分支)的原因:递归式靠「返回同一个引用」表示「这层没动」,
   而新语义里**夹紧也必须在选中的那层停下**(§6.1),需要把「不是我这层」和「是这层但夹紧了」区分开 —— 路径式最直白。

```ts
/** 内部:只取 split 那一支(路径收集用) */
type SplitNode = Extract<LayoutNode, { kind: 'split' }>

/**
 * 调整聚焦窗格的大小:**由内向外**找第一层「轴与箭头一致」的分隔条,把它**朝箭头方向**推一步
 * (箭头 = 分隔条移动的方向,与聚焦窗格在哪一侧无关):
 *
 * - `→` / `↓`:`ratio + step`;`←` / `↑`:`ratio - step`;
 * - 聚焦窗格在箭头侧 ⇒ 窗格**变小**;在反侧 ⇒ 窗格**变大**(贴窗口边界那一侧,推的就是反方向那条);
 * - **只动最内层那一层**,外层同轴 `ratio` 不受影响;
 * - 该层已夹到 `RATIO_MIN/MAX`、或整棵树里没有同轴祖先(左右并排里按 ↑/↓)⇒ 整棵树原样返回(引用不变)。
 *
 * ⚠️ 夹紧后**故意不向上找**:外层同轴的箭头侧可能相反 —— `row(A | row(N|N2))` 里 N 按 ←,内层到底后
 * 若去推外层,外层会把这支往左扩 ⇒ N 反而变宽(越按越大)。所以到夹紧就停。
 */
export function resizePane(
  root: LayoutNode,
  tabId: number,
  dir: PaneDir,
  step = SPLIT_RESIZE_STEP
): LayoutNode {
  const axis = axisOfDir(dir)
  const delta = isLeadingDir(dir) ? step : -step
  // ① 自根向下收集「通往 tabId」的路径(只读):每层记下焦点子树在 a 还是 b
  const path: { node: SplitNode; inA: boolean }[] = []
  let cur: LayoutNode = root
  while (cur.kind === 'split') {
    const inA = hasPane(cur.a, tabId)
    if (!inA && !hasPane(cur.b, tabId)) return root // tabId 不在树里
    path.push({ node: cur, inA })
    cur = inA ? cur.a : cur.b
  }
  // ② 由内向外取第一层轴一致的(最多一层会动)
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const { node } = path[i]
    if (node.axis !== axis) continue
    const ratio = clampRatio(node.ratio + delta)
    if (ratio === node.ratio) return root // 这条已推到极限(不再向外找)
    // ③ 只重建「该层 → 根」这一段,路径外的子树引用原样复用
    let next: LayoutNode = { ...node, ratio }
    for (let j = i - 1; j >= 0; j -= 1) {
      const p = path[j]
      next = p.inA ? { ...p.node, a: next } : { ...p.node, b: next }
    }
    return next
  }
  return root
}
```

保留不动的导出:`axisOfDir` / `isLeadingDir` / `clampRatio` / `hasPane` / `SPLIT_RESIZE_STEP` / `RATIO_MIN/MAX`
(`splitPane()` 仍在用 `axisOfDir` + `isLeadingDir`,别删)。

### 3.2 `src/main/tabManager.ts`(只改注释)

`resizeFocused()` 的 doc(722-725):`(箭头 = 它要扩张的方向)` → `(箭头 = 把最内层那条同轴分隔条朝该方向推)`。
函数体不动(`tree === active.tree` 现在同时覆盖「没有同轴祖先」与「已夹紧」两种原样返回)。

### 3.3 `src/shared/shortcuts.ts`(只改注释)

第 99 行:`resize` = Alt+Shift+方向(向该方向扩张)` → `(把最内层同轴分隔条朝该方向推)`。
`matchSplitHotkey()` / `shouldTakeSplitHotkey()` **一行不动**(按键识别与接管判据与语义无关)。

### 3.4 `tests/split.test.ts`(`describe('resizePane')`,192-243)

需**改写**的(旧的这 4 条把「贴边不动」钉死了,现在语义相反):

| 旧用例 | 处理 |
| --- | --- |
| `'→ 在左半:ratio 增大'` / `'← 在右半:ratio 减小'` | 保留(新语义下结果一致) |
| `'贴边方向不动:→ 在右半 / ← 在左半 → 原样(引用不变)'` | **改成相反断言**:`resizePane(simple, 1, 'left')` → `0.45`、`resizePane(simple, 2, 'right')` → `0.55`(用户报的两处) |
| `'里层动不了时向上一层找可扩张的祖先'`(`row(row(1,2),3)`,焦点 2,`→`) | **改成**:内层 row 的 `ratio` 0.5→0.55、**外层 row 仍是 0.5**(新语义:永远动最内层) |
| `'tabId 不在树里 / 到顶都动不了 → 原样'` 的后半(`col(row(1,2),3)`,焦点 2,`↑` → 原样) | 前半保留;后半**改成**:`col(row(1,2),3)` 焦点 2 按 `↑` → 根 `ratio` 0.5→0.45(内层 row 轴不一致 ⇒ 向上找同轴祖先);「到顶都动不了」换成**轴全程不匹配**的 `row(1,2)` 按 `↑`/`↓` → 引用不变 |

**新增**(建议 4 条):

1. 「分隔条朝箭头方向推」四个方向的完整表:两窗格 `row`,焦点 1`→`/`←`、焦点 2`→`/`←`;`col` 同理 `↓`/`↑`;
2. 「永远动最靠近叶子的那一层」:`row(row(1,2),3)` 焦点 2 `→` ⇒ 内层 0.55、外层 0.5(钉住②);
3. 「夹紧就停,不向外找」:`row(row(1,2,RATIO_MIN), leaf(3))` 焦点 1 `←` ⇒ `toBe(tree)`(整棵树引用不变,外层不许被顺手改);
4. 「只重建改动层 → 根」:`row(leaf(1), col(leaf(2),leaf(3)))` 焦点 2 `↓` ⇒ 结果相等且 **`next.a` 与 `tree.a` 是同一个引用**。

### 3.5 文档

| 文件 | 位置 | 改成 |
| --- | --- | --- |
| `README.md` | 363(「手动使用快捷键」) | `让聚焦窗格**朝该方向扩张**(贴到边界就不动…)` → `把聚焦窗格**最内层那条分隔条朝该方向推**(推离窗格 = 它变大,推向窗格 = 它变小;长按可连续调整)` |
| `README.md` | 393-394(「标签组与嵌套分屏」) | 换掉「扩张 / 贴到边界就向上一层找能扩的祖先 / 到最外层边界就不动」三句:新规则 = 只动最内层同轴那一条,箭头指哪分隔条就往哪挪;那条已到 10%/90% 或树里没有同方向的分隔条(左右并排里按 ↑/↓)时按键不动 |
| `docs/ARCHITECTURE.md` | 188(§2 不变式 ④) | 后半句改成「**由内向外找第一层轴一致的分隔条,把它朝箭头方向推一步**(`ratio` 夹到 `RATIO_MIN..RATIO_MAX`;只动最内层)」 |
| `docs/ARCHITECTURE.md` | 789(§9 IPC 表 `groups:resize`) | `(朝该方向扩张聚焦窗格;到边界则不变)` → `(把聚焦窗格最内层同轴的分隔条朝该方向推一步;夹紧或无同轴祖先时不变)` |
| `docs/ARCHITECTURE.md` | §13「已知坑与反模式」 | 在「架构层」第 9 条后**新增一条**:第一版按「扩张」写(`inA && leading` / `inB && !leading`),导致贴外边界的那三个方向**完全没反应**;正解是「分隔条朝箭头方向移动」,并写明「夹紧后不要向外找」的理由(会越按越大) |
| `docs/ARCHITECTURE.md` | 98 / 913 / 932 | 跑完全量测试后把用例数改成**实测值**(注:现在这三处已经漂了 —— 98 写 730、913/932 写 732,HEAD 上是 **39 文件 / 737 例**,顺带对齐) |

`SplitMenu.vue:88` 的面板提示只写「`Alt+Shift+方向键` 调整当前窗格大小」,与新语义不冲突,**不动**。

### 3.6 真机 E2E 脚本(仓库外:`/mnt/d/tmp/nested-split-e2e.mjs` = Windows `D:/tmp/…`)

- 文件头第 9 行注释:`4 真实按键 Alt+Shift+方向 调整大小 + 到边界不动` → `… + 贴边反向收缩`。
- §5 的**边界块**(`到最外层边界再按同方向 → 几何不变`)语义已反,必须改写。
  当前树形(§3 依次 `t1+→`、`t2+↓`、`t3+→`)是 `row[t1 | col[t2 | row[t3 | t4]]]`,t4 在右下角:
  - 新的判据:`focus t4` + `Alt+Shift+→` ⇒ **t4 变窄**(内层 `row[t3|t4]` 的 `ratio` +)且 `t3` 变宽;再按 `←` ⇒ t4 变回原宽(推回来,不给后面小节留脏状态);
  - `focus t4` + `Alt+Shift+↓` ⇒ **t4 变矮**(外层 `col` 的 `ratio` +,整个内层行变矮,`t3` 同高变化),再按 `↑` 推回;
  - 「同层邻居被挤窄 / 不同层不受影响」原有判据保留。
- 末尾(§12 之后、汇总之前)**新增一小节**用干净的两窗格复现用户报的两处(独立新组,不扰动 §12):
  `Ctrl+T` + `splitPane('right')` ⇒ 左窗格 `focus` + `Alt+Shift+←` ⇒ 左 `innerWidth` 变小、右变大;
  `focus` 右窗格 + `Alt+Shift+→` ⇒ 右变小、左变大(再推回来);
  上下:`splitPane('down')` 后上窗格 `↑` 变小、下窗格 `↓` 变小。
  边界判据沿用脚本既有习惯:**DIP 层面精确相邻(只隔一个 4px gap)+ 与 `groups:get` 的 `panes[].rect` 对得上 + 无未捕获异常**
  (显示器 125% 时页面 `innerWidth` 允许 ±1px)。
- `terminal-pane-e2e.mjs` 的 G2(`Alt+Shift+→` 让**终端窗格**变宽)不用改:那里终端是 `row[终端 | 新窗格]` 的 `a` 侧,
  `→` 推内层分隔条向右 ⇒ `a` 变大,新旧语义结果相同。**跑一遍确认即可**。

## 4. 步骤(每步都能单独验)

1. **纯逻辑 + 单测**:改 `src/shared/split.ts`(§3.1)→ 改 `tests/split.test.ts`(§3.4)→
   只跑这一支:`bun run test tests/split.test.ts`(该文件全绿,含新改的 4 条旧用例)。
2. **注释层**:`tabManager.ts` / `shortcuts.ts` 的 doc(§3.2 / §3.3)→ `bun run typecheck`(双侧)必须过。
3. **全量**:`bun run test` → 39 文件全绿,记下实测用例数;`bun run build` 过。
4. **文档**:按 §3.5 改 README / ARCHITECTURE(含把实测用例数写进 98 / 913 / 932)。
5. **真机 E2E**:按 §3.6 改脚本 → WSL 改完 `wsync` 到 `D:\Workspace\browser` → Windows 侧 `bun run build` →
   `node D:/tmp/nested-split-e2e.mjs` **跑两遍**;
   回归 `nested-split-panel-e2e.mjs`(13/13)、`terminal-pane-e2e.mjs`(31/31)、
   `terminal-e2e.mjs`(21/21)、`terminal-clipboard-e2e.mjs`(21/21)—— 后三个只是确认接管链路没被碰坏。
6. **人工**(可省但建议):在真机上按用户原话复现一遍四个方向(左←、右→、上↑、下↓ 各缩一次),看观感;
   mac 仍是既有未验项(`Alt+Shift` 与 mac 键盘映射),不在本次范围。

## 5. 验证矩阵(改完必须成立的判据)

- 两窗格 `row`:焦点 1 按 `←` ⇒ 1 变小 / 2 变大;焦点 2 按 `→` ⇒ 2 变小 / 1 变大(**用户报的两处**)。
- 两窗格 `col`:焦点 1 按 `↑` / 焦点 2 按 `↓` ⇒ 同理(**用户报的「上下同理」**)。
- 反方向不受影响:焦点 1 按 `→` / 焦点 2 按 `←` 的结果与改动前**逐字节相同**。
- 轴不匹配(`row` 里按 `↑`/`↓`)⇒ 整棵树引用不变,`resizeFocused()` 返回 `false`,不发 `groups-changed`。
- 嵌套:`row(row(1,2),3)` 焦点 2 按 `→` 只动内层(外层 `ratio` 仍 0.5);`row(A | row(N|N2))` 焦点 N 按 `←` ⇒ N 变窄、N2 变宽。
- 夹紧:该层到 `RATIO_MIN/MAX` ⇒ 整棵树引用不变,且**外层 `ratio` 不许被改**。
- 真机:几何只在被推的那一层变化,`panes[].rect` 仍是「相邻只隔 4px gap、铺满右/下边界、互不重叠」,`dividers` 逐个吻合,主进程无 `未捕获异常`。

## 6. 风险与不确定项

1. **夹紧后不向外找**(已拍板,写在 §3.1 的注释里):若改成夹紧后继续向上找同轴祖先,会出现**越按越大**
   (`row(A | row(N|N2))` 里 N 按 `←`:内层到底后外层把整支往左扩 ⇒ N 变宽)。宁可停在夹紧。
2. **嵌套观感变化**:`row(A | row(N|N2))` 里 N 按 `←` 从「整个右半变宽(今天)」变成「N 变窄、N2 变宽」。
   已由问卷确认接受;这是本次唯一会让老用户觉得「以前能用的怎么变了」的地方。
3. **`resizeFocused()` 的返回值语义**:夹紧时从「返回新对象 ⇒ `true` + 白跑一次 `layout()`」变成
   「引用不变 ⇒ `false`」。这是顺带修掉的无意义重排,但**改变了 `groups:changed` 的推送次数**
   (夹紧的那一下不再推事件)。目前没有监听方依赖「夹一下也推一次」,风险低。
4. **`inB` 变量在新实现里已不存在**:路径收集只用 `inA`(`!inA` 就是 `inB`,因为已确认 `tabId` 在树里)。
   注意 `hasPane()` 的调用次数与旧实现相当,没有性能问题(树 ≤ 8 叶)。
5. **未验**:mac 的 `Alt+Shift+方向` 键盘映射(既有遗留);真机 125% 缩放下的 ±1px 判据沿用脚本既有容差。
6. **文档计数**:98 / 913 / 932 处的数字现在就是漂的,本次顺手对齐到实测值,避免又留一条漂移。

## 7. 不做的事

- 不给 `Alt+Shift+方向` 加「按住不放连续调整到极限后跨层」的行为(见 §6.1)。
- 不改 `Ctrl+Shift+方向`(分屏)语义、不改按键识别与接管判据(`matchSplitHotkey` / `shouldTakeSplitHotkey`)。
- 不做鼠标拖动分隔条(面板/渲染层无改动),不重排 `README` 里那段快捷键说明的结构。
- 不改写 `.pi/plans/2026-09-19-nested-split/plan.md`(历史记录),只在它 §0 前提 3 处加一句「已由
  `2026-09-19-split-resize-push-divider` 取代」的交叉引用(**可选**;若不想动历史计划就跳过这一步)。

---

## 8. 实施记录(2026-09-19 实测)

**改动文件**(与 §3 一致,无计划外改动):

| 文件 | 内容 |
| --- | --- |
| `src/shared/split.ts` | 新增内部 `type SplitNode = Extract<LayoutNode, { kind: 'split' }>`;`resizePane()` 重写为「路径收集 → 由内向外取第一层同轴 → 只重建改动层到根」;文件头 / `PaneDir` / `isLeadingDir` 的注释同步 |
| `src/main/tabManager.ts` | `resizeFocused()` 的 doc 改成新语义(函数体未动) |
| `src/shared/shortcuts.ts` | `SplitHotkey` 的 doc 改成新语义(逻辑未动) |
| `tests/split.test.ts` | `describe('resizePane')` 8 条 → 11 条(4 条改写 + 4 条新增,含「贴边反向收缩」「夹紧不向外找」「只重建改动层到根」) |
| `README.md` / `docs/ARCHITECTURE.md` | 363 / 393-394 的语义说明、§2 不变式 ④、§9 `groups:resize`、§13 新增第 10 条坑;用例数对齐到 **39 文件 / 740 例**(98 / 913 / 935 三处,顺带修掉原来 730/732 的漂移) |
| `/mnt/d/tmp/nested-split-e2e.mjs`(仓库外) | 文件头第 9 行 + §5 的边界块改成「贴边推得动(推出去再推回来)」+ 新增 §13 两窗格复现 |

**静态与单测**:

- `bun run typecheck` 过(node + web 两套);`bun run build` 过(WSL 与 Windows 两侧都跑过)。
- `bun run test` → **39 文件 / 740 用例全绿**(改动前 737,`tests/split.test.ts` 50 → 53)。

**真机(Windows,代码 `wsync` 同步后 `bun run build`,E2E 在 `D:\tmp` 跑)**:

| 脚本 | 结果 | 关键判据 |
| --- | --- | --- |
| `nested-split-e2e.mjs` | **60/60 ×2** | §5:贴右边界再按 → ⇒ t4 286→254、邻居 t3 350→380、按 ← 推回 286;贴下边界按 ↓ ⇒ t4 高 334→298、推回 334。§13 两窗格复现:左窗格 + ← ⇒ 498→448(修前「完全没反应」)、右窗格 + → ⇒ 498→448、上窗格 + ↑ / 下窗格 + ↓ ⇒ 310→279,四个都推得回来;推完后各窗格 bounds 与 `groups:get` 仍逐个吻合 |
| `nested-split-panel-e2e.mjs` | 13/13 | 面板链路无回归 |
| `terminal-pane-e2e.mjs` | 43/43 | G2 `终端窗格确实变宽 639→702` —— 终端在 `row[终端 | 新窗格]` 的 a 侧,新语义下结果与旧语义相同(不影响既有行为) |
| `terminal-e2e.mjs` / `terminal-clipboard-e2e.mjs` | 21/21 + 21/21 | 接管链路无回归 |

**过程中出现的一次假失败(已查明与本次改动无关)**:第一次跑 `terminal-pane-e2e.mjs` 挂在**第一段**
`超时 清空标签: null`(`已跑 0 项`),此时还没碰到任何 resize 代码。写了一次性探针
`D:\tmp\clear-probe.mjs`(同样起 app → 关闭全部标签 → 轮询 `listTabs()`):当前构建下 `+500ms tabs = []`,
即「关掉全部标签」本身是正常的;重跑 `terminal-pane-e2e.mjs` 即 43/43。**结论:环境 flake**(前一个
E2E 实例的残留/端口时序),探针已删除,未留文件。

**遗留**:

- macOS 仍未验(`Alt+Shift` 与 mac 键盘映射、`⌘` 路径)—— 既有遗留,不在本次范围。
- 8 窗格挤在标签栏项里的观感、以及「按住 `Alt+Shift+方向` 连续推」的手感仍需真人看一眼(自动化只验了几何与日志)。
- `.pi/plans/2026-09-19-nested-split/plan.md` 的历史前提 3 未改动(§7 标为可选,本次跳过)。
