# 聚焦窗格边框高亮 + 标签栏 max-width 调窄

日期:2026-09-25 · 模式:plan · 状态:待批准

## 0. 目标与前提

**目标**
1. 分屏时给**聚焦的窗格**加一圈强调色边框,一眼看出「现在在操作哪一半」。
2. 标签宽度上限调窄:单窗格 `200px → 160px`,分屏组 `300px → 240px`(标题仍走省略号)。

**从代码里读出来的两个前提(决定了方案形态)**

- 窗格是**原生 `WebContentsView`**,永远盖在 chrome 渲染层之上(Electron 的分层规则,与 CSS `z-index` 无关)。
  渲染层唯一能露出来的区域是**窗格 rect 之外、没被任何窗格盖住的地方**:窗格之间的 `SPLIT_GAP = 4` 缝隙
  (`src/shared/split.ts:46`),以及 chrome 自己的 UI 区。
  `docs/ARCHITECTURE.md:965` 已写明「主进程把**窗格 rect + 分隔条 rect** 一起回传,渲染层只画不重算」,
  `.split-divider` 就是画在那 4px 缝里的(`style.css:321-327`),现存 E2E 已确认可见。
- 窗格 rect 铺满内容区、**外侧 0px 余量**:`geometryOf()` 传的 area 是 `{x:0, y:chromeHeight, width:w, height:h-top}`
  (`src/main/tabManager.ts:672-680`)。所以**贴着窗口/工具栏的那几条边没有空间画边框** —— 这是用户已拍板的取舍
  (所选方案预览里明确写了「外边框无空间,不高亮」)。

**tab max-width 的现状(重要)**:其实**已经实现了**。`style.css:99-100` 是 `min-width:90px; max-width:200px`,
`style.css:142-147` 的 `.tab-title` 是 `flex:1 + overflow:hidden + text-overflow:ellipsis`(分屏组 `:282-284` 为 160/300px)。
2026-09-25 在真浏览器里验证过这段 CSS:长标题 `scrollWidth 381 > clientWidth 48`,`textOverflow = ellipsis`,
tab 总宽被 200px 上限钉住。**所以这一半只需要改数值,不需要补功能。**

## 1. 方案(用户已选)

**高亮 = 缝隙高亮半幅**。聚焦窗格 rect 的四条边各向外扩一条 `2px`(= `SPLIT_GAP/2`)的强调色条:

```
┌──────────────┬──────────────┐
│              ┆              │
│   页面 A     ┃   页面 B      │     ┃ = --accent 2px,只吃掉缝隙里靠聚焦窗格的那一半
│  (focus)     ┆              │
└──────────────┴──────────────┘
```

- 条画在**窗格 rect 之外**,落进 4px 缝里 → 2px 可见、2px 留作分隔条底色;
  与相邻窗格重叠的部分天然被对方 `WebContentsView` 盖住,**不需要任何裁剪/裁剪层**。
- 只在**有空间**的边产出条:贴着组边界(= 窗口/内容区边缘)的边不产出。
  两窗格左右分屏 → 只有靠聚焦那半的**一条竖线**;嵌套分屏 → 贴缝的 L 形 / 口字形。
- 不做 `box-shadow` / `clip-path` 方案:前者会把顶边的阴影画进工具栏最后 2px(与「外边框不高亮」的约定冲突),
  后者要依赖 `clip-path` 对阴影的裁剪语义(未实测)。四条显式 `div` 最可控。

## 2. 改动清单

| 文件 | 改什么 |
| --- | --- |
| `src/shared/split.ts` | 新增 `FOCUS_RING` 常量 + `focusRingBars()` 纯函数(几何仍只在这一处实现,可单测) |
| `tests/split.test.ts` | 新增 `describe('focusRingBars')`(约 5 例) |
| `src/renderer/src/App.vue` | 新增 `viewport` ref、`focusRing` computed、模板里 `v-for` 画 `.split-focus-bar` |
| `src/renderer/src/style.css` | 新增 `.split-focus-bar`;`.tab` max-width `200→160`;`.tab.group-split` max-width `300→240` |
| `README.md` | 「标签组与嵌套分屏」补一条聚焦窗格高亮的说明;标签宽度上限提一句 |
| `docs/ARCHITECTURE.md` | §7.2 分隔条那段补 `.split-focus-bar`;§11 测试基线数字 |

**不动**:`src/main/*`(纯渲染层改动,主进程几何/协议零改动)、`preload`、`shared/types.ts`、
`src/shared/groups.ts`、`computeLayout`(所以 `tests/split.test.ts` 里已有的 53 例几何断言**一行都不用改**)。

## 3. 分步实施(每步可独立验证)

### S1 `src/shared/split.ts`:纯几何先行

放在 `SPLIT_GAP` 常量附近(`:44-47`)与 `computeLayout` 附近,沿用该文件的文档风格:

```ts
/** 聚焦窗格高亮边框的厚度(px):吃掉缝隙里靠聚焦窗格的那一半 */
export const FOCUS_RING = SPLIT_GAP / 2

/**
 * 聚焦窗格的边框条:沿 `pane` 的四条外边各向外扩一条 `thickness` 宽的条,**只产出有空间的边**
 * (贴 `area` 边界的边没地方画 ⇒ 不产出)。调用方把这些条 `position: fixed` 画在缝隙上:
 * 与相邻窗格 rect 重叠的部分被对方的 WebContentsView 盖住,于是只有缝隙里的 `thickness` px 可见。
 * 单窗格(rect === area)恒返回 `[]`。
 */
export function focusRingBars(pane: Rect, area: Rect, thickness = FOCUS_RING): Rect[] {
  const bars: Rect[] = []
  if (pane.y - area.y >= thickness)
    bars.push({ x: pane.x, y: pane.y - thickness, width: pane.width, height: thickness })
  if (area.y + area.height - (pane.y + pane.height) >= thickness)
    bars.push({ x: pane.x, y: pane.y + pane.height, width: pane.width, height: thickness })
  if (pane.x - area.x >= thickness)
    bars.push({ x: pane.x - thickness, y: pane.y, width: thickness, height: pane.height })
  if (area.x + area.width - (pane.x + pane.width) >= thickness)
    bars.push({ x: pane.x + pane.width, y: pane.y, width: thickness, height: pane.height })
  return bars
}
```

验证:`npx tsc --noEmit -p tsconfig.node.json`(该文件在两个 tsconfig 下都编译,web 侧见 S3)。

### S2 `tests/split.test.ts`:钉住四条边「有空间才产出」

在 `computeLayout` 那个 describe 之后加一个 describe(import 补 `FOCUS_RING`, `focusRingBars`):

| 用例 | 输入 | 断言 |
| --- | --- | --- |
| 单窗格(rect === area) | `focusRingBars(area, area)` | `[]` |
| 两窗格左右、聚焦左 | area `{0,0,1004,400}`,pane `{0,0,500,400}` | `[{x:500,y:0,w:2,h:400}]`(只有靠缝那一条竖线) |
| 两窗格左右、聚焦右 | pane `{504,0,500,400}` | `[{x:502,y:0,w:2,h:400}]`(在缝的另一半,与上例互斥) |
| 嵌套(右半的上半) | area `{0,0,1004,400}`,pane `{504,0,248,400}` | 左条 `x:502` + 右条 `x:752`(两条都靠缝;上下贴边界不产出) |
| 贴上边、下边有缝 | area `{0,0,300,800}`,pane `{0,0,300,398}` | 只有底条 `{x:0,y:398,w:300,h:2}`,无顶条 |

验证:`npx vitest run tests/split.test.ts`。

### S3 `src/renderer/src/App.vue`

**a. import**(现有 import 区,`@shared/types` 之后):

```ts
import { focusRingBars } from '@shared/split'
```

**b. 状态**(放在 `activeGroupDividers` computed 附近,`:83-89` 那一带):

```ts
// ---------- 聚焦窗格的边框高亮(只在窗格间的缝隙里可见) ----------
/** chrome 渲染层的视口尺寸(= 窗口内容区 CSS px,与窗格 rect 同一坐标系) */
const viewport = ref({ w: 0, h: 0 })

/** 活动组聚焦窗格的 rect;单窗格组没有「分屏边框」可谈 */
const focusedPaneRect = computed(() => {
  const g = activeGroup.value
  if (!g || !isSplitGroup(g)) return null
  return g.panes.find((p) => p.tabId === focusedTabId(g))?.rect ?? null
})

/** 聚焦窗格的高亮条:主进程给的窗口坐标直接用,渲染层不重算几何(算法在 shared/split.ts) */
const focusRing = computed(() => {
  const r = focusedPaneRect.value
  if (!r) return []
  const area = {
    x: 0,
    y: chromeHeight.value,
    width: viewport.value.w,
    height: Math.max(0, viewport.value.h - chromeHeight.value)
  }
  return focusRingBars(r, area)
})
```

**c. 视口尺寸跟手**:在 `report()`(`:196-201`)里补一行 —— `report()` 已经由 `ResizeObserver` +
`window.resize` + 挂载后 300ms 三重触发,窗口缩放时 `groups:changed` 也会让 computed 重算,再加这一行是双保险:

```ts
const report = (): void => {
  viewport.value = { w: window.innerWidth, h: window.innerHeight }
  const height = Math.ceil(chromeRoot.value?.getBoundingClientRect().height ?? 0)
  ...
}
```

**d. 模板**(紧跟在 `.split-divider` 的 `v-for` 之后,`</div>` 之前 —— **必须在分隔条之后**,同为 `z-index:0` 时靠 DOM 顺序压在上面):

```html
<!-- 聚焦窗格的边框:只在窗格之间的缝隙里有空间,贴窗口的四条边画不出来 -->
<div
  v-for="(b, i) in focusRing"
  :key="`fr-${i}`"
  class="split-focus-bar"
  :style="{ left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px` }"
/>
```

验证:`npx tsc --noEmit -p tsconfig.web.json`。

### S4 `src/renderer/src/style.css`

**a. 新增**(放在 `.split-divider` 块之后、`.addressbar` 之前,`:328` 附近):

```css
/* 聚焦窗格的高亮边框:画在缝隙里、靠聚焦窗格那一侧;与相邻窗格重叠的部分被它的 WebContentsView 盖住 */
.split-focus-bar {
  position: fixed;
  z-index: 0;
  pointer-events: none;
  background: var(--accent);
}
```

**b. 调窄两处上限**:

- `:100` `.tab { max-width: 200px }` → `160px`
- `:284` `.tab.group-split { max-width: 300px }` → `240px`

`.tab` 的 `min-width: 90px` 与 `.tab.group-split` 的 `min-width: 160px` 都**不动**(`90 < 160`、`160 < 240`,约束仍成立)。

验证:`npx electron-vite build`(或 `npm run build`)。

### S5 文档

- `README.md`「标签组与嵌套分屏」(`:447` 起)在 `:462` 那条「标签栏里只占一项」之后补:

  > - 聚焦窗格在窗格之间的**缝隙里有强调色描边**(左右分屏 = 靠聚焦那半的一条竖线;嵌套分屏 = 贴缝的 L 形/口字形)。
  >   贴在窗口或工具栏边缘的那几条边**没有可画的空间**,不高亮。

  在 `:447` 附近对标签宽度补一句:`标签宽 90~160px(分屏组 160~240px),超长标题用省略号截断`。

- `docs/ARCHITECTURE.md:751`:把「分隔条是 `v-for="d in activeGroupDividers"` …(不重算)」这句扩一句 ——
  `.split-focus-bar` 由 `focusRingBars(paneRect, area)`(`shared/split.ts` 的纯函数,单测在 `tests/split.test.ts`)现算,
  **只产出有空间的边**,所以只在缝隙里可见。
- `docs/ARCHITECTURE.md §11`:跑完 `npm test` 后更新 —— `:1030` 的 `split(53, …)` 改成新数字,
  以及所有把它算进去的合计(`:1031` 合计 773、`:1038` 合计 1012、`:105` 的 46 文件/1001 用例)。
  **以 vitest 实际输出为准**,别手算。
- 本计划文件追加「实施记录」。

## 4. 验证(收尾)

| 项 | 命令 / 手法 | 期望 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | 两个 tsconfig 都过 |
| 单测 | `npm test` | 全绿;`split` 用例数 = 53 + 新增 |
| 构建 | `npm run build` | 过 |
| 真机视觉 | Windows 侧跑 bow:左右分屏 → 点左/右页,看缝里竖线跟着换边;嵌套分屏 → 看 L 形/口字形;取消分屏 → 线消失;拉窗口/改分屏比例 → 线跟着几何走 | 见下 |
| 真机 tab | 打开几个超长标题的页面 | 标题省略号截断,tab 不超过 160px(分屏组 240px) |

真机可复用 2026-09-19 的手法(`.pi/plans/2026-09-19-split-view/plan.md` §10.3):
隔离 profile(`XDG_CONFIG_HOME=/tmp/...`)+ `--remote-debugging-port`,`spawn node_modules/electron/dist/electron`(别用 `bunx`),
收尾杀进程组。**不需要新写 E2E** —— 高亮是纯视觉,页面 target 里量不到(条画在 chrome 渲染层、不在页面 viewport 内);
要自动化只能连 chrome target 读 `.split-focus-bar` 的 `getBoundingClientRect()` 与 `.split-divider` 比对,可选。

## 5. 风险与未知

1. **外边缘不高亮是刻意的**:用户已确认。若真机看着「框不完整」难受,升级路径是给分屏组的内容区加 2px 内边距
   (`geometryOf()` 里 area 内缩,不动 `computeLayout`,所以 `tests/split.test.ts` 仍不受影响),那样四边都能画;
   代价是分屏时页面宽高各少 4px。
2. **2px 是否够显眼**未知,只有真机能判断。厚度集中在 `FOCUS_RING` 一处,调它是改一个常量
   (注意上限:`FOCUS_RING <= SPLIT_GAP` 才能在缝里放得下)。
3. **HiDPI(125%/150%)下 2px 与 4px 缝的舍入**:`setBounds` 用 DIP、CSS px 也是 DIP,理论上对齐;
   若真机发现某条线被切掉 1px,把 `FOCUS_RING` 降到 1.5 或把条改成「贴缝中线的 2px」即可,不影响结构。
4. **焦点同步延迟**:主进程 `wc.on('focus') + wc.on('input-event')` 驱动 `activeId`,既有记录里点另一半后
   标签栏标题要 25~31ms 才追上。框的高亮跟同一个信号,所以同样会有这几十毫秒的延迟 —— 可接受。
5. **浮层遮挡**:`below-chrome` 浮层(建议下拉、分屏面板)是更高的原生视图,展开时会把扫过区域的框线盖住。正常。
6. **已知但不修的**:标签多到超过栏宽时(`min-width` 合计溢出),末尾标签与「+」按钮会被 `overflow:hidden` 裁掉
   (已实测:12 个标签 + 900px 栏宽 → 「+」被推到 x=1108,点不到)。用户本次只选了「调窄」,这条留作后续
   (要修就是给 `.tabstrip-left` 换成可横向滚动,或按剩余宽度压缩 min-width)。

---

## 6. 实施记录(2026-09-25)

按计划落地,无偏差。改动:`src/shared/split.ts`(`FOCUS_RING` + `focusRingBars`)、`tests/split.test.ts`(+7 例)、
`src/renderer/src/App.vue`(`viewport` ref + `focusedPaneRect` / `focusRing` computed + 模板 `v-for`)、
`src/renderer/src/style.css`(`.split-focus-bar`、两处 max-width)、`README.md`、`docs/ARCHITECTURE.md`(§7.2 + §11 数字)。

验证:

| 项 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.web.json` + `tsconfig.node.json` | 过 |
| `npx vitest run tests/split.test.ts` | **60/60 过**(原 53 + 新增 7) |
| `npx electron-vite build` | 过(`out/renderer/assets/style-*.css` 里能看到 `.split-focus-bar`) |
| `npx vitest run`(全量) | 50 文件 / 1097 例;**1 例失败** = `mcpHttp.test.ts`「DNS rebinding 防护」,与本改动无关(本机 Node 26 的 `http.request` 直接拒绝与连接地址不符的 `Host` 头,测试自己在 client 端抛错) |
| 真浏览器校验(Chromium,精确复刻新 CSS) | 长标题普通 tab 宽 **160**、短标题 **90**(min)、分屏组 **240**;省略号生效;`.split-focus-bar` = 2px `#4a8ef7` 且完全落在 4px 分隔条 rect 内 |
| **真组件挂载**(构建产物 + 桩 `browserAPI` + 本地 HTTP → bow 的 Chromium) | `App.vue` 真挂载(⚠️ 此行为**修正前**的数字,修正后见 §7:现在是完整四边)。当时:左右分屏聚焦左半 → 1 条 `x=1374`;聚焦右半 → `x=1376`;嵌套 → L 形;贴边条数 0 |
| 真机视觉 | ⚠️ **未做** —— 本机 WSL 跑不了 Electron(`libnspr4.so` 缺失,`/usr/lib/libnss3.so` 也没有),需在 Windows 侧 `npm run dev` 目测:左右分屏点两半点缝里竖线是否换边、嵌套分屏的 L 形/口字形、贴边不高亮 |

可复用手法:构建产物用桩 `window.browserAPI` 托管到本地 HTTP(`/tmp/bow-renderer-serve.mjs`,桩里 `getGroups()` 现算几何),
再用 bow 的 MCP 浏览器 `browser_navigate` + `browser_eval` 读 DOM —— 本机唯一能真跑渲染层的路子(Electron 起不来)。

遗留:真实机上的观感(2px 会不会太细、HiDPI 下是否被切 1px)与「标签溢出挤掉 + 按钮」都还没定论。

---

## 7. 修正(2026-09-25,用户真机反馈)

**反馈**:左右分屏聚焦左边时,只有右边(中间那条缝)有高亮,上/下/左没有 —— 用户要的是**完整四边**。
这不是实现 bug,是 §1 那个「只在缝隙里画、贴边不产出」的取舍在真机上不可接受。按 §5 风险 1 预留的升级路径改。

**根因**:窗格是原生 `WebContentsView`,渲染层只能露出**没被窗格盖住**的条带。当前 `geometryOf()` 把内容区
直接铺满(`{x:0, y:chromeHeight, width:w, height:h-top}`),所以贴窗口/工具栏的边**空间为 0**,`focusRingBars`
按约定不产出条 —— 于是只剩中间那条缝能高亮。

**修法**:分屏组的内容区四周留一圈 `SPLIT_INSET`(= `FOCUS_RING` = 2px)的内边距,把外边框的位置腾出来。
**不动 `computeLayout`**(内边距是在 `geometryOf()` 里通过缩小 `area` 表达的),所以 `tests/split.test.ts`
既有 53 例几何断言仍然一行不改;`App.vue` 也不用改 —— 它算 `area` 用的是**窗口内容区**(`x:0, y:chromeHeight`),
外边的空间自然变成 `SPLIT_INSET = 2 ≥ thickness`,四边的条就都产出了。

### 改动

| 文件 | 改什么 |
| --- | --- |
| `src/shared/split.ts` | 新增 `SPLIT_INSET = FOCUS_RING`(带注释说明为什么留这一圈) |
| `src/main/tabManager.ts` | `geometryOf()`:`const inset = paneCount(group.tree) > 1 ? SPLIT_INSET : 0`,area 改成 `{x: inset, y: top + inset, width: w - inset*2, height: h - top - inset*2}`(全部 `Math.max(0, …)`);import 加 `SPLIT_INSET` |
| `tests/split.test.ts` | 新增 1 例回归:分屏 area 内缩 `SPLIT_INSET` 后,以**窗口内容区**为 area 调 `focusRingBars`,四边都产出条(钉住「外边框也能高亮」这个契约) |
| `README.md` | 把「贴窗口/工具栏的边不高亮」改成「聚焦窗格四边都有描边;分屏时页面区四周留 2px」 |
| `docs/ARCHITECTURE.md` | §7.2 那句补 `SPLIT_INSET`;§965 附近「每层扣 4px 间隔」补「分屏组内容区四周再留 2px 给外边框」 |

**只对分屏组生效**(`paneCount > 1`):单窗格/不分屏的页面区与现在**逐像素一致**,不损失任何显示面积。
代价:分屏时每个窗格的可用宽高各少 4px(每边 2px)。

### 验证

1. `npx tsc --noEmit -p tsconfig.web.json` + `tsconfig.node.json`
2. `npx vitest run tests/split.test.ts`(60 → 61)
3. `npx electron-vite build`
4. **真组件挂载测试**(§6 的桩):桩的 `getGroups()` 改成按 `SPLIT_INSET` 内缩内容区,然后断言
   左右分屏聚焦左半 → **4 条**(左 `x=0`、上 `y=chromeHeight`、右 `x=缝左半`、下 `y=h-2`);
   聚焦右半 → 4 条且贴缝那条翻到缝的右半;嵌套 → 仍是贴缝的 L 形 **加**贴外的两条边。

**已预料的观感差异**(不算缺陷,真机看一眼):外圈 2px 露的是 chrome 背景 `--bg`,中间缝露的是 `.split-divider` 的 `--bg3`,
所以外框会比中间的缝略暗一点。若看着别扭,再给外圈补一个同 `.split-divider` 样式的元素。

### 实施记录(2026-09-25,修正已落地)

改动:`src/shared/split.ts`(+`SPLIT_INSET`)、`src/main/tabManager.ts`(`geometryOf()` 分屏时内缩 area)、
`tests/split.test.ts`(+1 例回归,60 → 61)、`README.md`、`docs/ARCHITECTURE.md`(§7.2 + §11 数字)。
**`App.vue` 一行没改** —— 它算 `area` 用的是窗口内容区,外边空间自然变成 2px。

| 项 | 结果 |
| --- | --- |
| `tsc`(web + node) | 过 |
| `vitest tests/split.test.ts` | **61/61** |
| `electron-vite build` | 过 |
| `vitest run`(全量) | 1097/1098;仍只有那个无关的 `mcpHttp` DNS rebinding 例失败 |
| **真组件挂载**(桩按 `SPLIT_INSET` 内缩) | 左右分屏聚焦左半 → **4 条**:左 `x=0`、上 `y=76`(= chrome 高度,工具栏正下方)、右 `x=1374`(缝左半)、下 `y=1026`;聚焦右半 → **4 条**,贴缝那条翻到 `x=1376`(缝右半)、右边贴 `x=2750`;嵌套「左｜(右上/右下)」聚焦右下 → **4 条** = 贴缝的 L 形(`x=1376` + `y=552`)**加**贴窗口的右/下(`x=2750` + `y=1026`),合成完整一圈 |

**教训**:「只在缝隙里画」在方案阶段看着够了(用户当时也选了它),但真机一看就是缺三条边。以后这类「只能画在未遮挡条带」的高亮,
应该默认把可画空间先腾出来(内边距/留白),而不是先做半幅、指望后面再补。
