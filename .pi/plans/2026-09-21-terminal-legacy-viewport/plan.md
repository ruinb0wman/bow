# 终端页里 xterm 的遗留 `.xterm-viewport` 造成样式异常(隐藏它)

## 0. 目标

让 `bow://terminal` 里 xterm 生成的 `div.xterm-viewport` **不再参与渲染**(`display: none`),
消掉它自带的原生滚动条与纯黑底带 —— 不动会话 / 按键 / 滚动逻辑,不改主题。

**假设**(从代码推出来的,见 §1/§2):用户说的「样式异常」= 这个节点在 xterm 6 里已是**遗留空节点**,
却仍带着 `xterm.css` 硬编码的 `overflow-y: scroll` + `background-color: #000`(v6 不再给它上色)。
若真机上看到的不是这两样,先按 §5.3 用 `getComputedStyle` 取证,不要盲改。

## 1. 取证:xterm 6.0.0 里 `.xterm-viewport` 已经没用了

- 仍然创建:`node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts:426-428` 照旧
  `createElement('div')` + `classList.add('xterm-viewport')`,**但此后没有任何代码往里写内容**。
- 真正管滚动与底色的是新的 `Viewport`(`src/browser/Viewport.ts`):它 `new SmoothScrollableElement(screenElement, …)`,
  把那个节点的 DOM append 到 `.xterm`,并
  `_scrollableElement.getDomNode().style.backgroundColor = themeService.colors.background.css`
  —— 主题底色现在长在 `.xterm-scrollable-element` 上。真实 DOM:

```
.xterm
  .xterm-viewport                 ← 遗留空节点(本计划要隐藏的)
  .xterm-scrollable-element       ← xterm 自己的滚动条 + 主题底色
    .xterm-screen …               ← 行/选区/IME textarea 都在这下面
```

- 全仓库引用它的只剩两处,且都**不要求它可见**:
  - `renderer/dom/DomRenderer.ts:151`
    `this._selectionContainer.style.height = this._viewportElement.style.height` —— v6 里没人再给它设
    `height` ⇒ 该值恒为 `''`,这次赋值本来就是空操作;
  - `decorations/OverviewRulerRenderer.ts:65`
    `this._viewportElement.parentElement?.insertBefore(this._canvas, this._viewportElement)` ——
    overview ruler 的**插入锚点**(bow 没开,见 §7)。
- 但 `xterm.css` 对它的老规则还在(`node_modules/@xterm/xterm/css/xterm.css:93-104`):

```css
.xterm .xterm-viewport {
    background-color: #000;   /* 不再被主题覆盖: v6 只给 .xterm-scrollable-element 上色 */
    overflow-y: scroll;       /* 与内容是否溢出无关,永远画原生滚动条   */
    position: absolute; right: 0; left: 0; top: 0; bottom: 0;
}
```

- 终端页全局引入了这份 CSS(`src/renderer/src/terminal/main.ts:3`),所以这些规则在我们页面里生效;
  `TerminalView.vue` 目前只覆盖过 `.xterm { height: 100% }`(`<style scoped>` 第 279 行起,294 行那条)。

## 2. 会看到什么(为什么算「样式异常」)

1. **底部一条纯黑带**:`.xterm` 高度是 `.terminal-host` 的 100%,而屏幕高 = 行高 × 行数(取整向下),
   二者最多差**一行高**(`@xterm/addon-fit` 的 `Math.floor`),这一截正好被绝对定位 `inset: 0` 的
   `.xterm-viewport` 用 `#000` 填住;而终端主题底色是 `#1e1f24`(= `style.css:2` 的 `--bg`,
   `shared.ts` 的 `TERMINAL_THEME.background` 同值)⇒ 肉眼可辨的黑边,余量接近一行时最明显。
   ⚠️ 实测(§8):这个余量在 **-10px ~ +一行高** 之间摆动(甚至为负 = 屏幕反而比 `.xterm` 高),
   所以它**只在某些窗格高度下**手能看见 —— 根因是 `FitAddon` 读到了 `.terminal-host` 的**边框盒**高。
2. **右侧原生滚动条**:`overflow-y: scroll` 在 Chromium 里无论有没有溢出都画轨道。它在屏幕范围内被上层
   `.xterm-scrollable-element` 的不透明底色盖住,只在那条黑带的纵向范围里露出来;页面从未声明
   `color-scheme`(全仓库搜不到)⇒ 这门滚动条走的是默认(浅色)配色,和深色终端反差极大。
3. 顺带的既有行为:那一小截黑带是 `.xterm` 上的命中区,滚轮落在这里不会进
   `.xterm-scrollable-element` 的滚轮监听(隐藏后事件落到 `.xterm` 本身,而 xterm 的鼠标协议 wheel 监听
   本来就挂在 `.xterm` 上 ⇒ 行为与现状一致,不是回归)。

## 3. 方案:一行 CSS `display: none`(不做 `remove()`)

在 `TerminalView.vue` 的 scoped 样式里,紧跟既有的 `.terminal-host :deep(.xterm)` 规则加:

```css
/* xterm 6 的遗留空节点:xterm.css 硬编码了 overflow-y: scroll + #000,
   会在右侧画出原生滚动条、在屏幕下方铺一条纯黑底带(远离主题底色 #1e1f24)。
   只 display:none,不 remove() —— 它还是 OverviewRulerRenderer 的插入锚点。 */
.terminal-host :deep(.xterm-viewport) {
  display: none;
}
```

- **为什么不是 `remove()`**:上面两处引用(§1)都靠这个节点**仍在 DOM 里**才成立。`remove()` 之后
  `_viewportElement.parentElement` 为 `null`,`insertBefore` 被可选链**静默跳过** ⇒ 以后一开
  `overviewRuler` 就是「查不出来的功能失踪」;而视觉收益与 `display:none` 完全一样。
  `display:none` 保节点 ⇒ 两处语义都不变,还顺手把它从渲染里摘掉。
- **为什么不是 `overflow: hidden`**:能去掉滚动条,但问题 1 的 `#000` 底带还在;而且把 `.xterm` 变成
  滚动容器还会牵连装饰层( `.xterm-scrollable-element` 是**故意**留 `overflow: visible` 的,见其构造函数里
  注释掉的 HACK)。要动就整个节点隐藏。
- **不动的部分**:fit / cols 计算(`addon-fit` 预留的 `ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH = 14`
  是 xterm **自己**那条 overlay 滚动条的宽度,与这个原生滚动条无关,`SCROLLBACK_RANGE.min = 200`
  ⇒ scrollback 永不为 0、这 14px 永远预留);主题;`.xterm` 的 overflow。

## 4. 改动清单

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `src/plugins/terminal/ui/TerminalView.vue` | `<style scoped>` 里 `.terminal-host :deep(.xterm)`(294 行)之后 | 新增 `:deep(.xterm-viewport) { display: none }` + 说明注释 |
| `docs/ARCHITECTURE.md` | §12「终端层」第 25 条之后(现 1140 行后、`**MCP 层**` 之前) | 新增第 26 条:xterm 6 的 `.xterm-viewport` 是遗留空节点、**为什么隐藏而不是 remove** |
| (可选)`tests/xtermViewportSeam.test.ts` | 新增 | 契约测试:断言 `node_modules/@xterm/xterm/css/xterm.css` 里仍有 `.xterm .xterm-viewport` + `overflow-y: scroll`(升级 xterm 后这条覆盖成了哑弹时提醒我们去删) |

## 5. 实施步骤

1. 按 §4 第 1 行改 `TerminalView.vue`。验证:`npm run typecheck`、`npm run build` 过;
   `bun run test` **维持 45 文件 / 930 例**(纯 CSS 不该动任何用例)。
2. Windows 侧生效:`wsync` → `D:\Workspace\browser` → `npm run build` → **重启**
   `dist/win-unpacked/bow.exe`(或跑 dev)。
3. 真机取证(DevTools / CDP 控制台,页面 = `bow://terminal`):
   - 修前(可选,确认诊断):`const v=document.querySelector('.xterm-viewport');
     [getComputedStyle(v).display, getComputedStyle(v).backgroundColor, getComputedStyle(v).overflowY]`
     → 期望 `['block','rgb(0, 0, 0)','scroll']`;
   - 修后:`getComputedStyle(v).display === 'none'` 且 `v.getBoundingClientRect().height === 0`;
   - 观感:底部黑带消失(那一截改成 `--bg`)、右侧不再有浅色原生滚动条。
4. (可选)补 `docs/ARCHITECTURE.md` 第 26 条;5. (可选)加契约测试。
6. 提交(按仓库惯例分开):`fix(terminal): 隐藏 xterm 6 的遗留 .xterm-viewport` /
   `docs(...)` / `docs(plans)`。

## 6. E2E 判据(Windows CDP 脚本,形如 `D:\tmp\terminal-e2e.mjs`)

- **本轮判据**:`document.querySelector('.xterm-viewport')` 仍存在(证明是 CSS 隐藏、不是删节点),
  且 `getComputedStyle(...).display === 'none'`、`getBoundingClientRect().height === 0`。
- **无回归**:终端仍可滚动(往 pty 送 200+ 行后 `__bowTerminal` 侧 `buffer.viewportY` 有变化)、
  选区/复制仍可用、`Ctrl+Alt+P` 仍到 pty(`__bowTerminal.ctrlAltRepaired === true`)。
- **可选加强**:截图取终端区右下角一像素断言 ≈ `#1e1f24`(修前是 `#000`);要否取决于脚本现有的
  截图能力,不做也成立。

## 7. 风险与未知

- **无法单测**:jsdom 不跑 layout,仓库也没有 CSS/视觉测试 ⇒ 这类改动只能真机/E2E 验收(§6)。
- **症状是从代码推出来的**:若用户看到的「异常」不是黑边/原生滚动条(例如以为是字号、光标或选区问题),
  先按 §5.3 取证再改;本计划对那两样是确定有效的(xterm.css:93-104 + v6 不再给该节点上色)。
- **可选契约测试**只是「升级 xterm 后覆盖变哑弹」的提醒,不是功能保护;嫌噪音可以不做。
- **反向风险很小**:唯一依赖该节点的可见功能是 overview ruler,而 bow 未启用(默认 `overviewRuler: {}`
  ⇒ 宽度 0 ⇒ `OverviewRulerRenderer` 根本不创建),且 `display:none` 连这个锚点也不影响。

## 8. 实施记录

- **改动**(只两处,与 §4 一致):
  - `src/plugins/terminal/ui/TerminalView.vue`:`<style scoped>` 里在 `.terminal-host :deep(.xterm)` 之后
    加 `.terminal-host :deep(.xterm-viewport) { display: none }` + 4 行注释(指向 ARCHITECTURE §12-26);
  - `docs/ARCHITECTURE.md` §12「终端层」新增第 26 条(遗留空节点的来龙去脉 + 为什么隐藏而不是 `remove()`)。
  - **没做** §4 第 3 行那个可选的契约测试:它的价值只是「升级 xterm 后这条覆盖成了哑弹时提醒我们删 CSS」,
    而上游真把节点删掉时这行死 CSS 无害 —— 判据写在 ARCHITECTURE 里够了,不值一个测试文件的噪音。
- **验证**:
  - `npm run typecheck` 过;`npm run build` 过;
  - `bun run test` **45 文件 / 930 例**(与基线一致,纯 CSS 没碰到任何用例);
  - 产物核对:`out/renderer/assets/terminal-*.css` 里 `.terminal-host[data-v-…] .xterm-viewport { display: none }`
    (行 24)与 xterm 自己的 `.xterm .xterm-viewport`(行 150)共存 —— 特异性 (0,3,0) > (0,2,0),
    覆盖成立(不靠顺序产物的先后)。⚠️ scope id 与 chunk 文件名每次都变(改一行注释
    `ca00ec06` → `89d1234d`),不要拿它们当判据。
- **真实终端页 E2E(本轮做掉了,19/19 通过)**:脚本 `D:\tmp\terminal-viewport-e2e.mjs`(仿 `terminal-e2e.mjs`:
  `electron . --remote-debugging-port=9367 --user-data-dir=D:\tmp\bow-term-vp-run`,跑的就是刚 build 出来的 `out/`,
  端口/profile 都与用户正在跑的 bow 隔离),断言全部落在**真实的 `bow://terminal` 页面**上:
  - 修好后:`display === 'none'`、原生滚动条 **0px**、`viewportInDom === true`(锚点没坏)、
    `.xterm-scrollable-element` 底色仍是 `rgb(30,31,36)`、它自己的 overlay 滚动条节点还在、rows/cols 正常;
  - **同一页 A/B**(把 inline `display:block` 打回去复现「没修」,测完去掉):`nativeScrollbarPx` 0 → **14px**;
    同一个余量带(zoom 1.04 找到 band=4px 的几何,zoom 会触发 ResizeObserver → refit)里
    `elementFromPoint` 命中 **`.xterm-viewport`** → 去掉 inline 后命中 **`.xterm`**;
    `scrollableBox=[1269,732]` / `viewportBox=[1269,736]` ⇒ 差的那 4px 就是露出来的那一截;
  - 截图 `D:\tmp\vp-before.png` / `D:\tmp\vp-after.png`:**before 底部一条纯黑带 + 最右一根浅色原生滚动条残段,
    after 干干净净**(底色与主题一致),肉眼可辨;
  - 无回归:真 PowerShell 回显正常;写 120 行后 `baseY=86`,`scrollLines(-5)` 把 `viewportY` 移到 81,
    而 `.xterm-viewport` 的 `scrollTop` 恒为 0(它本来就不参与滚动)。
  - ⚠️ E2E 里踩到一条:**xterm 的 `write` 是排队异步解析的** —— 写完立刻读 `baseY` 还是 0,
    要用 `t.write('', cb)`(回调排在前面那些写之后)或等一帧再读。
- **还差的一步:打包版**。`wsync sync` + Windows `npm run build` 都已做完,但
  **打包版读的是 `dist/win-unpacked/resources/app.asar`,不跑 `npm run dist` 不会跟着变** ——
  本轮没跑 dist,因为那台机器上 `bow.exe` 正从 `win-unpacked/` 里跑着,替换会被文件锁住(顺带:
  `dist/win-unpacked/bow.exe` 仍是 20:33 那一版)。用户验收前:退出 bow → `npm run dist`(跑 dev 的话
  `npm run build` 就够)→ 启动。本轮**没有**去重启用户的 bow(重启会连带关掉跑在 bow 终端里的会话)。
- **真机 Chromium 验证(本轮做掉了,不用等用户重启)**:搭了一个探针页——真实 xterm 6.0.0 +
  真实 `xterm.css`(`/tmp/xterm-probe/index.html`,静态服务于 `127.0.0.1:8899`,在**用户 bow 的临时新标签**里跑,
  测完关标签/停服务;另存了一份 `D:\tmp\xterm-vp-probe.html`,可以直接拖进 bow 看 A/B 对照)。三个用例:
  A 无覆盖 / B `display:none` / C `display:none` + `overviewRuler:{width:10}`。实测:
  - A:`overflowY="scroll"`、`backgroundColor="rgb(0,0,0)"`、**原生滚动条 `offsetWidth-clientWidth = 15px`**,
    而它自己 `scrollHeight-clientHeight = 0`(没有可滚内容 ⇒ 与滚动无关);
  - 是否看得见取决于「屏幕底 vs `.xterm` 底」的余量:host 262px 时余量 **+6px**,余量带里
    `elementFromPoint` 命中 **`.xterm-viewport`**(⇒ 那一截真的画的是纯黑底 + 原生滚动条尾巴,截图里能看到灰白残段);
    host 250px 时余量 -6px,`.xterm-scrollable-element` 把它整块盖住(命中 `.xterm-screen`),看不见;
  - B:同一个余量带命中 **`.xterm`**(底色回到主题 `#1e1f24`)、原生滚动条 **0px**、节点仍在 DOM 里;
  - C:`display:none` 下 `.xterm-decoration-overview-ruler` 仍被插进 DOM
    (`overview-ruler | xterm-viewport | xterm-scrollable-element`)且宽 10px ⇒ **锚点没坏**
    (`remove()` 会把它变成「插不进去」;这就是「隐藏而非删节点」的实证);
  - 滚动:`term.scrollLines(-5)` 在 A/B 下都把 `buffer.viewportY` 从 46 移到 40,`viewport.scrollTop` 恒为 0
    ⇒ 隐藏该节点对滚动零影响。
- **顺带查出一个既有小毛病(不在本轮范围,已记 scratchpad)**:余量为什么在 **-10px ~ +一行高** 之间摆动 ——
  `FitAddon` 读 `getComputedStyle(.terminal-host).height`,而 `.terminal-host` 是 `box-sizing: border-box`
  + `padding: 6px 4px 4px 8px`,实测该 computed 值是**边框盒**高(比 `.xterm` 的真实内容盒高 10px)⇒
  rows 的取整在两种高度间跳,终端要么底部露一条、要么溢出 10px(靠 `overflow: visible` 画到 padding 上)。
- ⚠️ MCP 的页面工具**拒绝操作 `bow://terminal`**(「浏览器内部页面不支持页面操作」)⇒ 要验真实终端页只能走
  CDP(直连 remote-debugging 端口,不受这条策略限制)—— 本轮的 `terminal-viewport-e2e.mjs` 就是这么干的;
  MCP 那条路只能用来验「跟 bow 同款的 Chromium 渲染」(探针页)。
