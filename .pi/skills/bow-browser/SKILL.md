---
name: bow-browser
description: 用本地 bow 浏览器(MCP 服务器 browser)做只有真浏览器能做的事:需要登录态/Cookie 的页面、SPA 或 JS 渲染的内容、真实点击与输入、视觉确认、读取页面 DOM。适用于抓取 fetch_content 拿不到的页面、验证前端交互、填表提交、截图核对。不适用于静态文档或公开 API —— 那些用 fetch_content 或 curl 更快更省。
---

# bow 浏览器(MCP 服务器 `browser`)

本地 Electron 多标签浏览器,42 个工具(19 核心 + 23 插件,随插件启停浮动);**你的每次操作用户都实时可见**,所以破坏性操作前先说明意图。

## 第一步:确认工具怎么调

| 情况 | 做法 |
| --- | --- |
| 工具列表里已有 `browser_*` | 直接调用 |
| 只有一部分(常见:核心几个在,其余不在) | 在的直接调,不在的走下面的代理三步 |
| 一个都没有(默认代理模式) | `mcp({search:"browser"})` → `mcp({describe:"<工具名>"})` → `mcp({tool:"<工具名>", args:{...}})` |

**永远不要凭记忆猜参数** —— 代理模式下的 schema 不在上下文里。工具名可能被加了前缀(如 `bow_browser_navigate`),以实际列表为准。

## 工具选型

| 目标 | 用哪个 | 理由 |
| --- | --- | --- |
| 读结构化数据、批量取值 | `browser_eval` | 最省 token,一次拿回需要的字段 |
| 定位可点/可输入元素 | `browser_snapshot` | 返回稳定 CSS 选择器,别自己猜 |
| 判断样式、布局、视觉效果 | `browser_screenshot` | 只在需要肉眼判断时 |
| 要看整页(含滚动到视口外的部分) | `browser_screenshot {fullPage:true}` | 一次截全,不用边滚边截 |
| 等异步渲染 | `browser_wait` | 等元素出现,而不是靠猜时长 |
| 标签管理 | `browser_list_tabs` / `browser_new_tab` / `browser_switch_tab` | |
| 调试**手机**上的 WebView / Chrome | `device_list_targets` → `device_snapshot` → `device_tap` / `device_type` | 这些作用于 adb 连着的真机页面,不是 bow 自己的标签页;用 `targetKey` 寻址 |
| 看手机页面的控制台 / 未捕获异常 | `device_console` | 只覆盖**调用期间**的日志(默认 800ms);要加载期日志传 `reload: true`(会重载页面) |
| 在手机页面取值 / 批量读 | `device_eval` | 与 `browser_eval` 同套路,但作用于手机页面(最省 token) |
| 让**人**看手机页面的真 DevTools | `device_inspect` | 在标签页里开出 DevTools 前端(等同 chrome://inspect 的 inspect) |

## 标准工作流

1. `browser_new_tab {url}` 或 `browser_navigate {url}` —— 默认 `waitUntil: 'load'`,返回时主文档已加载完。
2. 异步内容(SPA、懒加载、无限滚动)用 `browser_wait {selector}` 等目标元素出现;**不要**用 sleep、也不要反复截图探路。
3. `browser_snapshot {maxElements}` 拿到元素列表,然后**直接用它返回的 `selector`** 调 `browser_click` / `browser_type`。
4. 这次点击会引发跳转时传 `waitUntil: 'load'`;SPA 内部交互保持默认 `'none'`,再 `browser_wait` 等具体元素。
5. 收尾复验:`browser_eval` 取关键值,或 `browser_get_info` 看 URL/标题,别调完就不管了。

## 参数速查

- `waitUntil`:`'load'`(默认,等加载完;动作没引发跳转时约 1.5s 后以 `waited=false` 返回)/ `'none'`(立即返回)
- `waited`:只看它是不是 `true` —— `false` 表示**没有观察到这次的加载过程**(调用时页面已就绪,或这次动作根本没引发导航);给 `tabId` 导航非活动标签时 Chromium 可能推迟加载,这时 `waitUntil: 'load'` 会一直等到真结果或超时
- `createdTab`:活动标签是 `bow://` 内部页(如设置页)时会另开标签 —— 一律以返回的 `tabId` 为准
- `maxElements`:快照默认最多 200 个元素;页面很大时先调小定位,再按需扩大
- `tabId`:省略则作用于活动标签(活动标签是内部页时会退到最近浏览的页面标签;都没有则自动新建 `about:blank`)
- 超时:等加载 15s、等元素 10s,可用 `timeoutMs` 覆盖(上限 120s)
- `fullPage`(仅 `browser_screenshot`):`true` 截整页。输出分辨率是设备像素(文档 CSS 尺寸 × `devicePixelRatio`),
  所以高倍屏下的 PNG 会比 CSS 尺寸大;页面当前滚到哪里都不影响结果。页面太高会被上限拦下(见下)。
- `browser_wait` 的 `state`:`attached` / `visible`(默认)/ `hidden` / `detached`
- `device_*` 一族的公共参数:`targetKey`(省略只在「恰好一个目标」时生效;多目标必须显式给,看返回体里的 `targetKey`)。
  `device_tap` 的 `selector` 与 `x`/`y` 二选一(坐标是视口 CSS 像素,不乘 dpr);`mode` 只是起点,返回的 `mode` 才是实际生效的。
  `device_type` 传空 `text` + `clear` 默认 = 清空输入框;`device_press_key` 只接受功能键,文字用 `device_type`。
  `device_console` 看的是**调用窗口**内的新日志,不是历史 —— 别把「没有日志」当页面干净。

## 必查

每个返回体先看 `ok`。`ok:false` 时协议层同时带 `isError` —— **不要当成成功继续往下走**,先读 `error`。

## 反模式

- ❌ 手写 CSS 选择器 → ✅ 用 `browser_snapshot` 返回的 `selector`
- ❌ 每次都全量快照 200 个元素 → ✅ 先小后大,必要时配合 `browser_eval` 精确定位
- ❌ `navigate` 后立刻 `snapshot` 抓异步页 → ✅ 先 `browser_wait`
- ❌ 用截图代替取值 → ✅ `browser_eval` 更省、更准
- ❌ 页面没动就重复同一调用 → ✅ 先 `browser_wait`,或 `browser_get_info` 看 `loading`
- ❌ 连续多次 `browser_new_tab` → ✅ 复用标签,用 `tabId` 指定目标

## 边界与故障

- `bow://` 内部页面标签(设置页等)不支持页面类工具,会明确拒绝;`browser_list_tabs` 用 `internal: true` 标出它们。
- `adblock_*` 等插件工具在对应插件停用时会**从工具列表消失**,这不是故障 —— `bow://settings → 插件管理` 可重新启用。
- 无 GPU 环境(ssh/CI 容器)截图可能是黑帧,别反复重试;导航、点击、快照、`browser_eval` 都正常。
- `fullPage: true` 两条硬限制,都**不是 bug**:①该标签开着 DevTools 时会报错(整页截图要临时挂调试器,不抢别人的);
  ②超过 16000 设备像素高会明确报错 —— Chromium 在这个尺寸以上不报错而是返回内容重复的错图(实测 dpr 1.25 下
  16125 设备像素正常、16500 开始出错),所以宁可报错。这时改用 `browser_scroll` 分段截。
- 要在本机跑 `npm run dev` / `npm run test:mcp` 做图形验证时,注意 pi 的 bash 沙箱会拒绝
  unix socket(`connect` 到 X11/Wayland 都是 EPERM),即使 WSLg 正常也起不来窗口 —— 这类命令请在沙箱外的终端跑。
- stdio 实例不参与单实例锁(客户端子进程必须能独立启动):**开新会话前先关掉旧的 stdio 实例**,否则会多开;
  普通 / HTTP 启动是单实例,重复启动只会聚焦已有窗口。
- 浏览器未启动 / 连接失败:先确认 bow 在跑。HTTP 端点由内置插件「MCP HTTP 服务」提供并**默认开启**,
  只要窗口在就应当在监听;连不上就检查该插件是否被停用(bow://settings → 插件管理),
  以及端口是否被改过(插件设置分区);`npm run mcp:http` 是强制模式,不需要它也能连上。
- 地址栏右侧工具栏里有 MCP 状态灯(紧挨书签按钮;白=就绪、蓝=正在被本连接调用、灰=端点已停用)。看到灰色说明
  用户手动点停了端点(或启动失败),再次点击即可恢复;悬停能看到端点地址与最近调用的工具名。
