# 设备检查面板:设备列表加内边距 + 复制「检查地址」

日期:2026-09-22 · 状态:待批准 · 影响面:仅设备检查插件的浮层 UI(+ 一句 README)

## 1. 目标

1. **弹窗里的设备/目标列表不要顶到弹窗边框**:给面板根容器加内边距。
2. **增加「复制地址」**:复制点「检查」时打开的那个 **DevTools 前端地址**(`DeviceTarget.frontendUrl`),
   而不必真的开出一个标签页。

已确认的两个前提(问过):

- 「检查页面地址」= DevTools 前端地址(`target.frontendUrl`),**不是**手机页面自身 url;
- 按钮**带文字标签**(现有 ws 复制也一并补上文字,免得并排两个图标分不清)。

## 2. 现状(读过的代码)

| 事实 | 出处 |
| --- | --- |
| 面板根 `.dvi-panel` 没有 padding:`width: min(880px, 86vw); max-height: 78vh; min-height: 320px` | `src/plugins/device-inspect/ui/DeviceInspectPanel.vue:414` |
| 全局 `.modal` 也只有 border/圆角,**没有** padding(内边距是各面板自己的事) | `src/renderer/src/style.css:628` |
| 同仓的取值先例:`.la-head` `padding: 10px 12px`;`CloseConfirmModal` `12px 14px` + `0 14px 14px`;logseq 设置分区 `4px 14px 20px` | `style.css:395`、`CloseConfirmModal.vue:51,65`、`.pi/plans/2026-09-21-logseq-paste-split-and-settings-padding/plan.md` |
| `* { box-sizing: border-box }` ⇒ padding 计入 `max-height` | `src/renderer/src/style.css:14` |
| 每行操作区目前只有 `[Copy 图标(复制 ws)] [检查]` | `DeviceInspectPanel.vue:399-406` |
| `检查` → IPC `open` → `openTarget()` → `context.pages.openDevToolsTab(target.frontendUrl, …)` | `DeviceInspectPanel.vue:82-96`、`main.ts:305-315` |
| `rows` 只映射了 `url` / `wsUrl`,**没有** `frontendUrl` | `DeviceInspectPanel.vue:238-250` |
| ws 复制用的是渲染层 `navigator.clipboard.writeText`,勾选态是 `copied !== row.wsUrl`(持久,不复位) | `DeviceInspectPanel.vue:97-104,401` |
| 主进程剪贴板:`clipboard:write-text` → `browserAPI.writeClipboardText`,注释明说「内部页面统一走主进程」 | `src/main/ipc.ts:84-88`、`src/preload/index.ts:122-123` |
| overlay view 用的是**同一份 preload**(`preload: join(__dirname, '../preload/index.js')`)⇒ overlay 里 `api.writeClipboardText` 可用 | `src/main/overlay.ts` `ensureView()` |
| 下载面板的复制就是这条路径:`await api.writeClipboardText(r.url)` + `flash('已复制下载链接')` | `src/plugins/downloads/ui/DownloadsPanel.vue:145-149` |

## 3. 改动清单

只有一个源文件 + 一句 README。

### 3.1 `src/plugins/device-inspect/ui/DeviceInspectPanel.vue` — 加内边距(CSS)

```css
.dvi-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(880px, 86vw);
  max-height: 78vh;
  min-height: 320px;
  padding: 12px 14px; /* 新增:12×14 与 .la-head / CloseConfirmModal 一致 */
}
```

- `.dvi-body` 的滚动条仍在面板内侧(`padding-right: 2px` 保留),滚到顶/底不会被 padding 切掉;
- `box-sizing: border-box` 下 padding 计入 `78vh`,`.modal` 的 `80vh` 仍然容得下(78vh + 2px 边框)。

### 3.2 `rows` 带上 `frontendUrl`

```ts
// 类型标注里加 frontendUrl: string
out.push({
  key: target.key,
  /* …原样… */
  url: target.url,
  wsUrl: target.wsUrl,
  frontendUrl: target.frontendUrl // 新增
})
```

### 3.3 复制逻辑收敛成一个函数

把 `copyWs(wsUrl)` 换成:

```ts
const copied = ref('') // 由「地址字符串」改成 `<kind>:<rowKey>`,两个按钮互不干扰
let copiedTimer: number | undefined

type CopyKind = 'ws' | 'frontend'
const isCopied = (kind: CopyKind, key: string): boolean => copied.value === `${kind}:${key}`

async function copyText(kind: CopyKind, key: string, text: string, label: string): Promise<void> {
  try {
    await api.writeClipboardText(text)
    copied.value = `${kind}:${key}`
    if (copiedTimer) window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => {
      copied.value = ''
    }, 2000)
    flash(`已复制${label}`)
  } catch {
    flash('复制失败(剪贴板被拒绝)')
  }
}
```

- `navigator.clipboard.writeText` → `api.writeClipboardText`:主进程剪贴板不受 secure context / 焦点影响,且与下载面板同一套写法;
- `onBeforeUnmount`(`DeviceInspectPanel.vue:268`)里补 `if (copiedTimer) window.clearTimeout(copiedTimer)`;
- 顺带修一处旧的小别扭:ws 复制的勾以前**一直留着**,现在 2s 后还原(与新的 flash 提示同时结束)。

### 3.4 模板:两个复制按钮都带文字

```html
<div class="dvi-target-actions">
  <button
    class="btn"
    :title="`复制 WebSocket 地址:${row.wsUrl}`"
    @click="copyText('ws', row.key, row.wsUrl, ' WebSocket 地址')"
  >
    <Check v-if="isCopied('ws', row.key)" :size="13" />
    <Copy v-else :size="13" />
    复制 ws
  </button>
  <button
    class="btn"
    :title="`复制检查地址(DevTools 前端):${row.frontendUrl}`"
    @click="copyText('frontend', row.key, row.frontendUrl, '检查地址')"
  >
    <Check v-if="isCopied('frontend', row.key)" :size="13" />
    <Copy v-else :size="13" />
    复制地址
  </button>
  <button class="btn primary" :disabled="busyKey === row.key" @click="inspect(row.key)">检查</button>
</div>
```

不引入新图标(继续 `Copy` / `Check`),`lucide-vue-next` 的导入行不动。

### 3.5 `README.md:687` — 一句话

> 工具栏「设备检查」按钮(手机图标)→ 全窗面板:设备 → 套接字 → 可调试目标,点「检查」就把该目标接进 DevTools 前端
> (在 bow 的**标签页**里打开,不是新窗口)。每行也可**复制 ws 地址**与**复制检查地址**(即点「检查」会打开的那个
> DevTools 前端地址;bow 自带那份是 `devtools://…`、只有 bow 自己能开,设备指定那份是 appspot 的 `https://…`、
> 任何浏览器都能开,前提是 bow 的转发/中继还活着)。

`docs/ARCHITECTURE.md` §12 的插件 UI 表按「浮层 id」记录、不列按钮 ⇒ 不改;MCP 工具数与 SKILL.md 也不变(仍 44 个)。

## 4. 步骤(每步可独立验证)

| # | 步骤 | 文件 | 验证 |
| --- | --- | --- | --- |
| 1 | 加 `padding: 12px 14px` | `DeviceInspectPanel.vue`(`.dvi-panel`) | dev 模式下打开面板,`getComputedStyle` 的 `paddingTop/paddingLeft === 12px/14px`;目标行与弹窗边框有 14px 间隙 |
| 2 | `rows` 加 `frontendUrl`(+ 类型标注) | 同上 | typecheck 通过;模板里 `row.frontendUrl` 不再报未定义 |
| 3 | 复制函数重写 + `copiedTimer` + `onBeforeUnmount` 清理 | 同上 | typecheck 通过;面板里点两个复制按钮,勾只出现在被点的那一个 |
| 4 | 模板换成带文字的两个按钮 | 同上 | 视觉检查(见 §5) |
| 5 | README 补一句 | `README.md` | 读一遍措辞 |
| 6 | 全量验证 | — | `npm run typecheck` / `npm run test` / `npm run build` |

## 5. 验证

必跑(仓库既有基线):

- `npm run typecheck`(tsc node + web 两份);
- `npm run test` —— 预期仍是 **45 文件 / 965 例**,本次没有可单测的纯逻辑(面板无组件测试基建,改动全在 `.vue`);
- `npm run build`;
- `npm run test:e2e:device` —— 已有的「假手机」harness 不碰面板,但能证明主进程链路没被带坏(它顺带给出一份「真有目标行」的环境,可用于下面的手工检查)。

手工(真机或假手机 harness 均可):

1. 打开面板:目标行不再顶到弹窗左右/下边框,表头按钮(刷新/设置/关闭)也不再贴右上角;
2. 点某行「复制地址」→ 贴进文本编辑器,字符串应与点「检查」后新标签的地址**完全一致**(含 `ws=127.0.0.1:<relayPort>/…`);
3. 点「复制 ws」→ 贴出来是 `ws://127.0.0.1:<relayPort>/…`;两个按钮的勾各自独立、2s 后还原;
4. 复制后等两秒再点「检查」,确认端口没变(如果变了,说明 §6.3 那条要写进 README)。

可选(不建议本轮做):在 `scripts/e2e-device-inspect.mjs` 里加一小节 UI 断言 —— 通过 chrome target 跑
`window.browserAPI.showOverlay({ id: 'plugin:device-inspect:panel', placement: 'full' })`,再用脚本已有的
`chromeTargets()` 找 `overlay.html` target,断言 ① 每行 3 个按钮、第二个的 title 含 `ws=` 且与
`device_list_targets` 的目标对应 ② `getComputedStyle('.dvi-panel').paddingLeft === '14px'`。
**不要断言「点一下会变勾」**:那要真写一次系统剪贴板(headless ozone 下成败未知),会引入 flaky;
overlay 是否出现在 `/json` target 列表里也没有先例,跑不通就放弃这一节,别为它改产品代码。

## 6. 风险 / 未定

1. **复制到的地址形态取决于前端策略**:`electron-bundled`(以及 auto 在 Chromium ≥146 上)=
   `devtools://devtools/bundled/devtools_app.html?ws=…`,只有 bow 自己能开;`device-suggested` = appspot/https 地址,
   外部浏览器可开。README 要写明,免得被当成 bug —— 这也是为什么按钮叫「复制地址」而不是「复制可用的 URL」。
2. **复制的是快照**:端口是本次刷新时算出的中继端口,目标断开 / 回收转发 / 下次刷新重新分配端口后,这份地址就失效。
3. 「复制地址」**不会**趁机建立转发或中继,它只复制已存在的 `frontendUrl`;因此复制后若面板刷新,地址可能变。
4. 2s 自动还原改变了 ws 复制按钮的旧行为(勾不再长期保留)。如果你更想保留旧行为,去掉 `copiedTimer` 即可(改动更小)。
5. padding 取值 12×14;想更宽(如 16)或只加左右、不加上下,说一声即可。

## 7. 实施记录(2026-09-22,已完成)

改动与 §3 完全一致:`src/plugins/device-inspect/ui/DeviceInspectPanel.vue`(+`.dvi-panel` 的 `padding: 12px 14px`;
`rows` 加 `frontendUrl`;`copyText` / `isCopied` / `copiedTimer`;模板两个带文字按钮)+ `README.md` 一段。

验证:

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 干净(tsconfig.node + tsconfig.web) |
| `npm run test` | **46 文件 / 1001 例全绿**(与改动前基线一致,本次无新增单测) |
| `npm run build` | 成功 |
| `npm run test:e2e:device` | 全绿(假手机 harness 不受影响) |
| 面板 UI 实测 | 见下,17 条断言全绿 |

UI 实测用临时脚本 `/tmp/bow-panel-check.mjs`(未入库):复用假手机 fixture 起真 Electron →
在 chrome target 上 `window.browserAPI.showOverlay({ id: 'plugin:device-inspect:panel', placement: 'full' })`
→ 在**浮层 target** 上断言 DOM,并 `Page.captureScreenshot` 截图(`/tmp/bow-panel.png`)。结果:

- `.dvi-panel` 的 `padding` = `12px 14px`;目标行距弹窗边框左 14px / 右 16px(右侧多出的 2px 来自原有的
  `.dvi-body { padding-right: 2px }`,给滚动条留的间隙)。表头不再贴边框。
- 每行 3 个按钮、文字为 `复制 ws` / `复制地址` / `检查`;两个复制按钮的 tooltip 分别是 `ws://…` 与
  `devtools://…devtools_app.html?ws=…`(假设备 + `electron-bundled` 策略下的真实形态)。
- 点「复制地址」:按钮变勾、提示「已复制检查地址」,且**从 chrome target 用 `browserAPI.readClipboardText()`
  读回的系统剪贴板内容就是那条 `devtools://…?ws=…`**;2s 后自动还原。再点「复制 ws」:剪贴板变 `ws://…`,
  地址按钮的勾退回复制图标(两个按钮互不干扰)。
- 结论:上面 §5 里那条「可选、别断言点击会变勾」**已被推翻** —— headless ozone 下系统剪贴板照样能写,
  而且浮层是独立 target、内容可断言。

踩到的两条坑(E2E 复用这个手法时要注意):

1. **挑浮层 target 必须按 `url.includes('overlay.html')`**,不能挑「第一个非 devtools 的 target」——
   普通标签页(本次是 `https://www.google.com/`)也在列表里且顺序靠前,第一次就命中了它,
   断言全错在「Google 首页的 DOM」上。
2. 浮层 target 在 `showOverlay` 之后才出现且要等它渲染,runtime 用 `waitFor` 轮询 `.dvi-target` 的行数。

未入库的东西:`/tmp/bow-panel-check.mjs`(临时验证脚本)、`/tmp/bow-panel.png`(截图)。
要把这套面板断言收进 `scripts/e2e-device-inspect.mjs`,说一声即可(约 40 行,按上面两条坑写)。
