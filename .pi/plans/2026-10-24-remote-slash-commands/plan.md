# 手机端命令补全 + 输入框信息抽屉

日期:2026-10-24 · 状态:**方案 v3**,未动代码(按当天反馈重排两次)
v1 的四处已按你的要求改掉:**内置命令(`/compact` `/model` `/reload`)全不做**、**bash 不做**、
**命令入口从抽屉里的 `/` 按钮进,点选只补全不发送**、**顶栏只留返回 / 项目名称 / 状态 / 停止**(§1.1)。

范围:只动「手机对话」这条链路(`src/renderer/remote/` + `src/plugins/terminal/remote/piChat.ts` + pi 扩展);
终端、桌面 UI、MCP、协议消息类型都不动。

## 0. 一句话

手机发的话现在**绕过了** pi 的命令解析(`sendUserMessage` 的 `expandPromptTemplates` 默认 `false`),
`/bow` 会被当成一句普通文本喂给模型 —— 先把这个开关打开;再把 `pi.getCommands()` 随对话快照送到手机,
输入框最右边的 `⌃` 展开「信息 + 功能」抽屉,抽屉里的 `/` 弹出可模糊搜索的命令列表,点一条只把它
**填进输入框**,发送仍然走现有那条路。**不新增任何协议消息类型。**

顶栏同时收成四项:**返回 · 项目名称 · 状态 · 停止**(§1.1);原来那条模型/token/上下文的状态条
**撤掉**,数字全部进抽屉(§1.2),所以顶栏只剩一行、不占两行。

## 1. 交互长什么样

```
┌──────────────────────────────────────────────┐
│ ←  bow                   在跑 · 排队1   停止  │ header:返回/项目名称/状态/停止(只有一行)
├──────────────────────────────────────────────┤
│                    消息列表                   │
│  ┌────────────────────────────────────────┐  │  ← 点 ⌃ 展开
│  │ 信息                                   │  │
│  │ 模型     claude-sonnet-4 · anthropic   │  │
│  │ 思考     high                          │  │
│  │ 上下文   76,400 / 200,000  38.2%       │  │
│  │ 用量     ↑12k ↓3.4k   缓存 读0 写0     │  │
│  │ 会话     #3  bow-im-01                 │  │
│  │ 目录                                   │  │  ← 目录独占一行
│  │ /home/ruinb0w/Workspace/bow            │  │     整行放完整路径
│  │ 通道     已连上 · 空闲 · 无排队         │  │
│  ├────────────────────────────────────────┤  │
│  │ 功能                                   │  │
│  │ [ /  命令 ]                            │  │
│  └────────────────────────────────────────┘  │
├──────────────────────────────────────────────┤
│ [ 说点什么…                          ] 发送 ⌃ │  ← ⌃ 在最右
└──────────────────────────────────────────────┘
```

点 `/` → 抽屉收起、弹窗开(搜索框自动聚焦),输入 `bw` 能模糊命中 `bow`:

```
│  ┌────────────────────────────────────────┐  │
│  │ ╱ 搜索命令…                            │  │
│  │ /bow        bow 集成:MCP 注册状态/开关 │  │
│  │ /skill:…                               │  │
│  │ (没有匹配)                              │  │
│  └────────────────────────────────────────┘  │
```

点一条 → 输入框变成 `/bow `,光标在末尾,弹窗关,焦点回输入框,**不发送**。

## 1.1 顶栏规格(`.head`,只有这四样)

| 位置 | 内容 | 规则 |
|---|---|---|
| 左 | `←` 返回 | 不变 |
| 中 | **项目名称** | 只放一个名字:`title`(bow 给终端标签 / pi 会话起的名字),为空时退回 `basename(cwd)`;`flex:1` + 省略号。**`cwd` 不在这里** |
| 中右 | **状态** | 一个 chip,把现在的三态与排队合成一句:`在跑` / `在跑 · 排队1` / `空闲` / `没通道`;颜色沿用现有 `.badge.busy / .dead / .queue`。原来单独的「有排队」badge 并进来,省一格 |
| 右 | **停止** | 不变:`busy && live` 才出现 |

`.stats` 那一行(模型 · ↑↓ · 上下文%)**删掉** ⇒ 顶栏回到**单行**。`data-chat-stats/model/tokens/ctx`
这几个钩子挪进抽屉,`e2e-remote` 里那几条断言只需多加一步「点 ⌃」(见 §5)。
`cwd` 从 `.head` 彻底拿掉(不占顶栏任何位置),只在抽屉里出现,而且**独占一行**(§1.2)。

## 1.2 抽屉「信息」区(顶栏撤掉后,全量都在这里)

模型 · provider · 思考等级 / 上下文 tokens + 窗口 + %(>70% 黄、>90% 红,沿用现有 `ctxClass`)/
模型 · provider · 思考等级 / 上下文 tokens + 窗口 + %(>70% 黄、>90% 红,沿用现有 `ctxClass`)/
↑输入 ↓输出 / 缓存读 · 写 / 会话 id · 名称 / 控制通道 · 忙闲 · 排队。

**目录(与别的行不同)**:别的行是「小标签 + 右侧值」两栏(`flex` 到右),**目录独占一整行** ——
上排小标签「目录」,下面一行等宽、`--muted`、**完整路径不截断**(太长就换行,不省略号),
路径可长按复制(`user-select:text`)。标 `data-chat-cwd` 供 E2E。

全部复用已有 props 与已有 computed,**不新增数据、不新增计算逻辑**(这些数字只有一个来源,就是抽屉)。
旧扩展没有 `status` 时,这一块显示「这个 pi 没上报状态」,其余行照常。

## 2. 三个承重事实(读 pi 源码确认,决定了为什么这么做)

1. `AgentSession.prompt()` 里 `expandPromptTemplates` **默认 true**,而 `sendUserMessage()` 显式传
   `false`(`dist/core/agent-session.js:1933`)—— 这就是现在手机发 `/bow` 变成 prompt 的唯一原因。
   改成 `true` 之后,扩展命令 / 技能命令 `/skill:x` / prompt 模板全部按桌面语义生效。
2. `prompt()` 里**扩展命令在 streaming 判定之前**执行(`:1640`)⇒ 忙的时候 `/bow` 也能立刻跑;
   技能与模板走排队 —— 桥已经会带 `deliverAs:'followUp'`,不用改。
3. `pi.getCommands()` 只有 **extension / prompt / skill** 三类,**内置命令不在里面,也不会通过 prompt 执行**
   (RPC 文档明写)。⇒ 「不做内置命令」的代价只是菜单里没有它们(不出现点了没反应的假项),这点与你
   的决定正好一致。

## 3. 数据流(零新协议)

```
pi.getCommands() ──snapshot.commands──▶ PiChatHub 缓存 ──chat 快照.commands──▶ 抽屉/弹窗
                                              ▲
   点选 → 只在手机端拼 draft,用户按发送 → 现有 {t:'prompt'} → sendUserMessage(…{expandPromptTemplates:true})
```

- **pi → bow**:不加消息类型。命令表搭已有的 `{type:'snapshot'}` 顺风车(`session_start` 与断线重连各发一次;
  `/reload` 会让扩展重连 ⇒ 命令表自动刷新)。
- **bow → 手机**:不加消息类型。`server.ts:337` 已经是 `{t:'chat', ...piChat.snapshot(id)}`,
  给 `ChatSnapshot` 加一个 `commands` 字段就自动带出去。
- **手机 → pi**:不加消息类型 —— 点选只改 `draft`,发送走现有 `prompt`。

## 4. 改动清单(4 个文件 + 测试)

### 4.1 `packages/pi-bow/extensions/bow-agent-state.ts`(承重)

1. 手机上来的 `prompt`:`pi.sendUserMessage(text, { expandPromptTemplates: true, ...(deliverAs ? {deliverAs} : {}) })`
   (三处调用点合成一处)。
2. `snapshot()` 里加 `commands: pi.getCommands().map(c => ({name, description, source}))`,
   用 try/catch 包住(老 pi 没这个接口就发空数组);在文件里补一个自包含的 `CmdInfo` 类型(理由同文件头:
   这个文件会被单独拷贝进 `~/.pi/agent/extensions/`,只能 import `node:`)。
3. `ui.notify` 也转发到手机:现在只包了 `custom/confirm/select/input/editor`(`wrapDialogs`)。
   命令的反馈全靠 `notify`(比如 `/bow` 的报告),手机上否则一片安静。加 `notify(message, type)` →
   `{type:'message', message:{role:'notice', text}}`,**终端里原方法照旧调**(与对话框同一条原则:双路并存)。
4. 手打的未知命令:`text.startsWith('/')` 且命令名不在 `pi.getCommands()` 里 → 回一条 notice
   (`没有 /xxx 这个命令`),不发出去 —— 否则拼错的 `/modle` 变成一句 LLM prompt,手机上还看不出哪错了。
   (3 行,不想要就删掉这一条,其余不受影响。)

### 4.2 `src/plugins/terminal/remote/piChat.ts`

- `ChatCommand { name; description?; source? }` + `sanitizeCommands()`:逐字段截断
  (name ≤ 40 / description ≤ 120)、按 name 去重、上限 200 条 —— 与现有 `sanitizeChatMessage/Status` 同一套口径
  (上行走廊一律当不可信输入)。
- `ChatState` 加 `commands`,**只由 `snapshot` 分支写入**(与 `status` 同寿命,不被 `state` 事件清掉);
  `ChatSnapshot` 带出去。旧版扩展不发这个字段 ⇒ `[]`,手机不显示 `/` 按钮(不用写兼容分支,`?? []` 即可)。

### 4.3 `src/renderer/remote/ws.ts` + `App.vue`

- `ServerMessage` 的 `chat` 加 `commands?: ChatCommand[]`;`App.vue` 的 `chat` reactive 加 `commands`,
  在 `t==='chat'` 分支赋值,透传给 `ChatView`(与 `status` 完全同一套写法,3 行)。

### 4.4 `src/renderer/remote/ChatView.vue`(UI 全在这里)

- 状态:`moreOpen`(抽屉)、`cmdOpen`(弹窗)、`cmdQuery`(搜索词)。三个 ref,互斥由两个函数保证
  (`toggleMore()` / `openCommands()` / `closeCommands()`),不引状态机。
- 输入行:`<button class="more" data-chat-more>⌃</button>` 加在「发送 / 插话」之后(**最右**);
  抽屉用 `position:absolute; bottom:100%` 挂在 `.composer` 上方的容器里,最大高 60vh 可滚动,不顶走消息列表。
- 顶栏按 §1.1 收成四项:`cwd` 从 `.head` 删掉、`有排队` 并进状态 chip、`.stats` 整块删掉;
  抽屉信息区按 §1.2 用已有的 `status` / `ctxText` / `ctxClass` / `fmt` / `busy` / `pending` / `live` /
  `title` / `cwd` / `sessionId` 排版出来。**顶栏与抽屉共用同一批 computed**,不另算。
- 状态 chip 文案:`!live` → `没通道`;`busy && pending>0` → `在跑 · 排队{n}`;`busy` → `在跑`;否则 `空闲`。
  现有 `statusLabel` 扩展成这一个 computed,别再加第二个。
- 命令弹窗:`<input>` 自动聚焦 + 列表。排序直接复用 `@shared/suggest` 的 `fuzzyScore`
  (地址栏那套,`tests/suggest.test.ts` 已有覆盖),空 query 按名字全列,最多 40 行、可滚动、
  行高 ≥40px、search 输入 `font-size:16px`(`style.css` 里已经写明这条:避免 iOS 聚焦放大)。
- 点选:`draft = (draft.trimEnd() ? draft.trimEnd() + ' ' : '') + '/' + name + ' '`,关弹窗,
  `textarea.focus()` + 光标移到末尾。**不触发 send**。
- 命令来源标记:名字前不加徽标(手机上一行要窄);description 一行截断,长按看到全文不做。
- 输入框里手打 `/` **不**自动弹(只认按钮;以后想加也只是 `@input` 里 3 行)。

## 5. 测试

- `tests/terminalRemoteChat.test.ts`(vitest,现有 527 行里加法):快照带 commands、清洗
  (超长/非字符串/重复/非数组)、`state` 事件不清命令表、**旧扩展不发 commands 时快照是 `[]`**。
- `tests/piBridgeExtension.test.ts`:自包含不变式(只能 import `node:` 与 pi 类型)—— 新代码必须过这条。
- `scripts/e2e-remote.mjs`(真 Electron + 真远程页 + `window.__bowRemote.handle/sent`,已有脚手架):
  ① 顶栏只有四项:`cwd` 不在 `.head` 里、`.stats` 不存在、状态 chip 文案对得上懒/忙两种快照;
  ② `chat` 快照带两条命令 → 点 `[data-chat-more]` → 抽屉出现,里面有模型名与上下文
  (原来的 `data-chat-model/tokens/ctx` 断言原样搬到这里,只多一步点 ⌃),`[data-chat-cwd]`
  的文本是**完整** cwd(不是省略号缩过的);
  ③ 点 `/` → 弹窗出现、搜索框聚焦 → 输 `bw` → 只剩 `/bow` → 点它 → **textarea 值变成 `/bow `**;
  ④ 断言 `sent` 里**没有** `{t:'prompt'}`(证明「只补全不发送」这条被钉住)。
- `npm run test:pi:chat`(真 pi + 真扩展)加 2 条断言:快照里出现 `bow` 命令;
  手机发 `/bow` → 收到一条 notice、且**没有**新的 user 消息(证明真被当命令执行,而不是喂给模型)。
  这是 `expandPromptTemplates` 唯一可靠的验证。
- `npm run test:pi:ask` 回归(同样走 `prompt` 路径,改了会连坐)。
- 真机手测(手机浏览器):展开抽屉看数字、`/` 搜命令、点选后接着打参数、横竖屏各一次。

## 6. 风险 / 边界

- **老扩展没有命令表**:`/` 按钮不显示(或点了说「这个 pi 没上报命令,升级 bow 的 pi 扩展」)。零兼容成本。
- **notice 样式是红的**(现在只给错误用),命令反馈("已重载 MCP")也用它会像报错。
  先复用,真机看着别扭再给 `ChatMessage` 加 `level` —— 那时只动两处。
- `/reload` 在手机上属于"不存在"了(不做内置命令),但它仍会让扩展重连 → 抽屉/顶栏会短暂变灰,属预期。

## 7. 不做(明确)

- 内置命令(`/compact` `/model` `/reload` `/new` …):按你的决定全部不做;菜单只列 `getCommands()` 里
  真能跑的项,所以不会出现「点了没反应」。
- bash `!` 快捷、命令历史、参数补全(模型清单 / 文件路径)、输入框打 `/` 自动弹、
  TUI 独有命令(`/settings` `/hotkeys` `/tree` `/share` …)。

## 8. 实施记录(2026-10-24,已完成)

按本方案落地,四个文件 + 测试 + README;`§1.1` 顶栏与 `§1.2` 目录行按当天最后两条反馈定稿
(顶栏单行四项、cwd 只在抽屉里且独占一行)。

**落地清单**

- `packages/pi-bow/extensions/bow-agent-state.ts`
  - `prompt` 改成一次 `pi.sendUserMessage(text, { expandPromptTemplates: true, …deliverAs })`(三处调用合一);
  - `snapshot()` 带 `commands: commandsOf()`(`typeof pi.getCommands === 'function'` 兜老版本,失败给 `[]`);
  - `wrapDialogs()` 里额外包 `ui.notify` → 一条 `notice`(终端原方法照旧调);
  - 手打未知 `/xxx` → `notice('没有 /xxx 这个命令…')`,不发给模型;
  - 新增 `notice()` / `commandsOf()` 两个小工具,去掉原来重复的 error 帧构造。
- `src/plugins/terminal/remote/piChat.ts`: `ChatCommand` / `sanitizeCommands()`(截断、按名去重、上限
  `MAX_CHAT_COMMANDS=200`)/ `ChatState.commands`(只由 `snapshot` 写)/ `ChatSnapshot.commands`(`?? []`)。
- `src/renderer/remote/ws.ts` + `App.vue`: 类型 + reactive 字段 + prop(与 `status` 同一套写法)。
- `src/renderer/remote/ChatView.vue`: 顶栏四项(`projectName` / `statusText`+`statusClass` 合并排队);
  `.stats` 删除;`⌃` 抽屉(信息 + `/` 功能)与命令弹窗(`fuzzyScore` 排序、点选只补全);
  `.compose` 包住抽屉与输入行(`z-index` 让面板开着时输入框仍可点)。

**三处偏离 / 踩到的坑**

1. **`e2e-remote` 的旧断言搬进抽屉**:`data-chat-model/tokens/ctx` 换位置不换钩子,断言只多一步点 `⌃`;
   另加顶栏(无 cwd / 无 stats / 名称存在)、状态 chip 三态(`没通道` / `在跑 · 排队2` / `空闲`)、
   抽屉里的完整目录、命令补全(全列 → `bw` 模糊命中 `/bow` → 点选后 textarea 是 `/bow ` → `sent` 里**没有** prompt 帧)。
2. **`test:pi:chat` 必须加 `-ne`(`--no-extensions`)+ 一个临时探针扩展**:验「`/xxx` 真的被执行」需要一条
   **真命令**(bow 自己的 `/bow` 不在这个冒烟加载的扩展里)。踩了两个坑:
   ① 隔离 `PI_CODING_AGENT_DIR` 会让 pi 读不到模型配置(`model=unknown`、无凭据)→ 真跑模型那几步全挂;
   ② 不隔离时 `~/.pi/agent/extensions/` 里**已装的那份**桥会抢在 `-e` 的那份之后连上来,
   假 bow 只发最后一个 socket ⇒ `/smoke` 被旧版当普通文本喂给模型(实测)。`-ne` 只关发现、`-e` 仍生效,才干净。
   现在 15 项:快照带命令表 / `/smoke` 回 `PROBE-OK` 且没变成 prompt / `/nope` 被拦。
3. **手机装的那份扩展也要重装**:单文件安装是拷贝,`npm run pi:install-status` 已跑
   (`~/.pi/agent/extensions/bow-agent-state.ts` 更新)。正在跑的 pi 要 `/reload` 或重开终端才拿得到命令表。

**基线**:`typecheck` 干净 · `npm run build`(含 remote)· vitest **82 文件 / 1531 例** ·
`test:pi:chat` **15/15** · `test:pi:ask` **11/11** · `test:e2e:remote` **全部通过**(真 Electron + 真页面)。

**没做**:参数补全、`!` bash、内置命令、输入框打 `/` 自动弹、命令历史;真机(手机浏览器)手测待做 ——
布局只在桌面浏览器上下文里跑过 E2E,手机上的抽屉高度/键盘遮挡要眼睛看一眼。
