# Herder 式终端/代理管理 + Cloudflare 隧道远程控制

日期:2026-10-16 · 状态:**已批准**(四项决策已与用户确认,见 §6;代码尚未动)
v1 范围 = P0 + P1 + P2 + P3;P4(会话与标签解耦)**不在 v1**,待单独立项。

## 进度

- [x] **S1 会话台账**(2026-10-16):`SessionInfo` / `SessionAgentState` / `sessionSignature`(5s 分桶)在 `terminal/shared.ts`;`Session` 加 `cwd/createdAt/lastOutputAt/agent`;`notifySessions()` 250ms 合并 + 指纹去重;`sessionsChanged` 事件
- [x] **S2 会话 IPC 面**(2026-10-16):`listSessions` / `readTail` / `sendText` / `createSession` / `focusSession` / `closeSession`;新增核心能力 `ctx.pages.activate`
- [x] **S3 本地面板**(2026-10-16):工具栏「牧群」按钮(总 / 待办数 + 高亮)+ `full` 浮层面板(注意力排序、点行跳转、行内关闭、新终端);纯展示函数 `attentionRank` / `sortSessionsByAttention` / `formatAgo` / `shortPath` 在 `shared.ts`(P1 的远程页直接复用)
- [x] **S3 端到端**:`scripts/e2e-herd.mjs`(`npm run test:e2e:herd`,真 Electron + 真 pty + 真台账,15 项全绿)
- [x] **S4 MCP 工具 ×5**(2026-10-16):`terminal_list_sessions` / `terminal_read` / `terminal_send` / `terminal_run` / `terminal_close`;`capabilities` 加 `'mcp'`。实跑 `npm run test:mcp` 工具数 40 → **45**、全部通过
- [x] **文档同步**(2026-10-16):README(工具一览 5 行 + 终端一节的牧群面板/AI 管终端 + 牧群 E2E 一节)、`docs/ARCHITECTURE.md`(目录地图 / 插件两张表 / `pages.activate` / `plugin:event` / E2E 脚本表)、`packages/pi-bow/skills/bow-browser/SKILL.md`(工具数 45 + 选型行 + 两条反模式)。⚠️ 本机已安装的那份 skill(`~/.pi/agent/skills/bow-browser/SKILL.md`)要跑 `npm run mcp:install` 才会刷新;正在跑的 pi 会话要重连 MCP 才能看到这 5 个新工具
- [x] **S5 服务骨架**(2026-10-16):`ws@8` 依赖;`remote/hub.ts`(扇出 + 慢消费者断开)、`remote/server.ts`(`/healthz` / 双向绑 / `lanUrls`);设置加 `remote.{enabled,bind,port}`;插件接线(flush/台账/exit/closed → hub;activate/设置变更/停用 → 启停)
- [ ] S6 鉴权 · [ ] S7 WS 协议 · [ ] S8 远程页+手机按键条
- [ ] S9–S11 隧道(**暂不做**,见 D6) · [ ] S12 移动端打磨

**D6(2026-10-16 用户拍板)**:没有 Cloudflare 域名 → **先只做局域网**(S5–S8),隧道三步(S9–S11)搁置。
后果:鉴权(S6)仍然是承重墙(同网段任何设备都能试兑,不是“内网就可信”),只是不需要公网那层的加固;
`bind: 'lan'`(0.0.0.0)是显式开关,默认回环。

**D7(2026-10-27 用户拍板)**:隧道改成 **Tailscale**(只装 Windows 侧,PC 与手机同 tailnet),S9–S11 不做;
`remote/tunnel.ts`、设置页隧道块、二维码从范围里划掉。搭建与使用见 `docs/REMOTE-ACCESS.md`。
理由:没有 CF 域名、不能 SSH 到主机 → 身份放在设备层比自建口令省事;mirrored 模式下 Windows 与 WSL 共用
`127.0.0.1`,所以 `bind=lan` 之后 `tailscale serve` 一条命令可达,核心代码零改动。

**P0 完成**(S1–S4 + 文档)。P1 开工前先做一次人工真机确认(计划 §7):开几个终端、跑一个真 pi、看按钮与面板、试试点行跳转与关闭。

### 待办:文档同步(P0 结束时一起做)

`docs/ARCHITECTURE.md` §1 目录地图与 §5 插件体系要补:终端插件新增的 `ui/HerdButton.vue`、
`ui/HerdPanel.vue`、`shared.ts` 的台账投影、`ctx.pages.activate`,以及 `scripts/e2e-herd.mjs`;
README 的功能表(终端那一段)要提「牧群」面板。**先做完 S4 再一次性改**,免得改两轮。

### S1+S2 落地时的四处偏离(都是有意为之)

1. **多了一个核心能力 `ctx.pages.activate(tabId)`**(§10 里曾写「kernel/types 不动」)。原因:面板的
   「点一项跳过去」必须复用 `main/agentActivate.ts` —— 后台标签、别的分屏窗格、最小化的窗口这三种情况
   `ctx.pages.focus()` 都不生效(它只把键盘焦点交给 webContents,不会把标签显示出来)。增量:types 里
   一个方法 + kernel 的 EMPTY 实现 + index 里一行转发,共 15 行。
2. **没做 `toSessionInfo` 纯函数**:在主进程里直接映射(`describeSession`)。它只是一次字段搬运,
   多一层函数只增加跨文件跳转;投影形状由 `SessionInfo` 类型看住,行为由假 pty 用例看住。
3. **测试文件叫 `tests/terminalSessions.test.ts`**(计划里写的 `terminal-sessions.test.ts`):跟仓库现有
   约定(camelCase)一致。另加 `tests/pluginPageActivate.test.ts` 看住第 1 条那条新能力。
4. **`readTail` 默认 4000 字符、硬上限 `REPLAY_MAX_CHARS`**;`createSession` 不带 `command` 时**忽略
   `cwd`**(v1 不为「默认 shell + 指定目录」扩展 `TerminalRunRequest`)。

### 自己引入又修掉的一个 bug(值得记住)

`lastSessionsSignature` 起初用空串作「还没播过」的哨兵 —— 而**空台账的指纹就是空串**,于是「一个会话
都没建过就全关光」或「attach 后立即 close」时最后一次广播被吞掉(面板会留着幽灵条目)。
改用 `null` 作哨兵;`tests/terminalSessions.test.ts` 里专门有一条用例看住它。
参考物:[herdr.dev](https://herdr.dev/)(server 持有真终端 + 多 client attach + agent 三态汇总 + 通知)

> 一句话结论:**可行,而且 bow 已经做完了最难的那一半**(pty 会话、agent 三态协议、回放缓冲、xterm 前端、
> 「资源在核心、插件只做决策」的服务宿主模式)。真正的新东西只有三块:① 会话台账/API(现在没有)
> ② 127.0.0.1 上的 HTTP+WS 服务(现在只有 /mcp) ③ cloudflared 子进程监督。**风险集中在安全,不在工程量。**

## 0. 目标与非目标

**目标(v1)**

1. 一个「牧群」面板:列出全部终端会话(名字/cwd/agent 三态/最后活跃),一键聚焦、关闭、新建;
2. 远程控制:手机/另一台机器打开一个网页,能看到同一批会话、接管输入输出(attach);
3. 隧道:不暴露公网 IP、不改路由,用 cloudflared 出一个 HTTPS 地址;
4. 复用既有 agent 状态协议:`working / blocked / idle(done)` 在远程页上也显示,blocked 要能在手机上看到标题。

**非目标(v1 明确不做)**

- 不做 workspace/tab/pane 三层拓扑(herdr 的 workspaces)——bow 的标签页 + 嵌套分屏已经是这个语义,不另造;
- 不做多机(machine)路由、不做 22 种 agent 检测(只认**主动上报**的 pi,见 §3.4);
- 不做协作/多用户/权限分级:口令后面就是**一个**管理员;
- 不改终端插件与标签页的绑定语义(已定:P4 不做,见 §6 与 §4)。

## 1. 可行性:已有 / 缺失

### 1.1 已经有的(直接复用,别重写)

| 能力 | 位置 | 备注 |
| --- | --- | --- |
| node-pty 会话表(按 tabId 绑) | `src/plugins/terminal/main.ts:140` `sessions` | 惰性加载 node-pty;Windows 走 `taskkill /T` 收进程树 |
| 输出合批(8ms)+ 回放缓冲 | `main.ts:169` `flush()` / `shared.ts:312` `pushReplay` | 上限 `REPLAY_MAX_CHARS = 200_000`(`shared.ts:55`) |
| attach/write/resize/detach IPC 面 | `main.ts:443-447` | 远程服务可以**复用同一批函数**,不需要新写 pty 逻辑 |
| agent 三态协议 + OSC 解析 | `src/shared/agentState.ts` | `1337;bow;{...}` 流式剥离;`9;4` 降级 |
| agent 落地(角标 + 系统通知) | `src/main/agentNotify.ts`、`systemNotify.ts` | 权威身份是 tabId |
| 进程内事件总线 / 广播 | `ctx.events`、`ctx.ipc.emit` | 输出现在是广播给所有内部页,页面按 tabId 过滤 |
| 「开一个终端并跑指定命令」 | `@shared/terminalRun.ts` + `terminal:run` 事件 | **编辑器插件已在用**(`src/plugins/editor/main.ts:78,83`)。herder 的「新建会话」走同一条路 |
| 插件建内部页标签的窄能力 | `ctx.tabs.openInternal('terminal')` | 与 `terminal:run` 的时序不变式已在 `terminalRun.ts` 注释里写明 |
| 后台服务的宿主范式 + 安全姿态 | `src/main/plugins/mcpHttpHost.ts`、`src/main/mcpHttp.ts` | 只监听 127.0.0.1、Host 白名单、可选 Bearer、`clientError` 直接 destroy |
| TCP 中继/裸 WS 转发先例 | `src/plugins/device-inspect/relay.ts` | 需要手写协议时的参考实现 |
| e2e 手法(真 Electron + CDP + 测试缝) | `scripts/e2e-agent-status.mjs` | 远程服务的 e2e 照着它写 |

### 1.2 缺的(要新写)

| 缺口 | 说明 |
| --- | --- |
| **会话台账** | `Session` 里只有 `agentKey: string`(去重键),没有结构化状态、cwd、pid、创建时间、最后活跃;外部(IPC/MCP/远程)拿不到列表 |
| **输出扇出到非 Electron 客户端** | 输出只走 `ctx.ipc.emit`,渲染层 IPC;远程 WS 客户端收不到。需要在 `flush()` 旁加一个进程内 hub |
| **HTTP+WS 服务** | 仓库里没有 `ws` 依赖(实测 `node_modules/ws` 不存在;Node 只有**客户端** WebSocket)。需要新增依赖或手写服务端帧 |
| **远程 Web UI** | 现有 5 个渲染入口全部依赖 `window.browserAPI`(preload),普通浏览器打不开。需要第 6 个「无 preload」入口 |
| **cloudflared 监督** | 本机没装(`which cloudflared` 空)。需要:探测路径、spawn、从输出解析 URL、重连、退出清理 |
| **鉴权** | MCP HTTP 只有回环 + 可选 Bearer;**远程必须自己有一套**(口令 → cookie) |
| **终端 MCP 工具** | 终端插件 `capabilities: ['ui']`,目前 **0 个 MCP 工具**(`main.ts:402`)。herdr 的 automation 面(pane send/read)在这里是空的 |

## 2. 建议架构(v1)

```
                    ┌─────────────────────── Electron main ───────────────────────┐
手机/另一台机 ──TLS──► cloudflared ──► 127.0.0.1:PORT  (终端插件)                │
  (浏览器)        quick/named          ├─ http: /login /static/* /healthz        │
                                      ├─ ws:   /ws  ← 复用 attach/write/resize    │
                                      └─ RemoteHub: 订阅 Session 输出 + agent 事件 │
                                            │                                   │
  bow 窗口(本地)                            │ 同一进程内,无 IPC 开销              │
  ├─ HerdPanel(overlay) ── plugins.invoke ──┤                                   │
  └─ bow://terminal 页 ──── ipc broadcast ──┤  pty sessions(node-pty)           │
                                            │                                   │
  pi / MCP 客户端 ── terminal_* 工具 ────────┘                                   │
                    └───────────────────────────────────────────────────────────┘
```

三条通道到同一份会话表:**本地面板(IPC)、远程(WS)、MCP(工具)**。都调终端插件里同一批函数 ——
这是唯一的防漂移点,`tabTarget.ts` 的教训(两处各写一份必漂移)在这里同样适用。

### 2.1 会话台账(P0,所有后续都依赖它)

`Session` 增字段,并新增只读投影 `SessionInfo`:

```ts
interface SessionInfo {
  id: number            // = tabId(v1)
  title: string         // profileName / run.name
  cwd: string
  pid: number
  profileId: string
  createdAt: number
  lastOutputAt: number
  agent: { state: AgentState; done?: boolean; title?: string; text?: string; at: number } | null
  attachedLocal: boolean  // 本地终端页是否挂着
  viewers: number         // 远程订阅者数
}
```

- 新 IPC:`listSessions()`、`focusSession(tabId)`、`closeSession(tabId)`、`sendText(tabId, text)`、
  `readTail(tabId, chars)`、`createSession({ cwd?, command?, name? })`。
- 推送:`ctx.ipc.emit('sessions-changed', infos)`,**必须节流**(建议 250ms 合并),否则 `lastOutputAt`
  会让每条输出都触发一次广播。
- `createSession` = `ctx.tabs.openInternal('terminal')` + `ctx.events.emit(TERMINAL_RUN_EVENT, ...)`,
  **零新机制**(`src/plugins/editor/main.ts:78,83` 的同一套)。不传 command 时就是默认 shell profile。

### 2.2 远程服务(P1)

- **位置**:`src/plugins/terminal/remote/{server.ts,auth.ts,hub.ts}`。放终端插件内、不放内核:
  hub 要直接挂 `Session`,跨插件就得再发明一套插件间 API(`ctx.events` 是弱类型全局总线,不适合搬
  pty 数据)。内核只保留「资源在核心」的那条边界:默认**只监听 127.0.0.1**(隧道模式下的唯一正确值)。
  LAN 直连需要 `0.0.0.0`,做成**显式开关 + 警告**(P1 的验收必须能在局域网另一台设备上打开,
  否则每次都得先开隧道),但这会把 shell 暴露给同网段所有人 —— 开关默认关。
- **依赖**:`ws`(纯 JS、无原生模块)。若不想加依赖,退路是 SSE(`text/event-stream`)+ POST 输入,
  但每个按键一次 HTTP 往返,隧道下延迟明显 —— 不建议。
- **协议**(单条 WS,多路复用;JSON 文本帧,v1 不做二进制):

  | 方向 | 消息 |
  | --- | --- |
  | C→S | `hello`(带 token,若走子协议则可省)、`list`、`attach {id, cols, rows, readonly?}`、`detach {id}`、`input {id, data}`、`resize {id, cols, rows}`、`create {cwd?, command?}`、`kill {id}`、`read {id, chars}` |
  | S→C | `hello {ok, version, render}`、`sessions [...]`、`attached {id, replay, cols, rows}`、`data {id, chunk}`、`exit {id, code}`、`closed {id, reason}`、`agent {id, state, done, title, text}`、`error {message}` |

  每个字段都当**不可信输入**校验(端口/尺寸夹取用 `toPositiveInt` 同一套:`main.ts:106` 已是纯函数)。
- **输出扇出**:`flush()` 里除 `ctx.ipc.emit` 外再 `hub.publish(session, chunk)`。订阅者在 `attach` 时
  先拿 `replayText(session.replay)`(上限 200k 字符,够手机滚动)。
- **多 viewer 的尺寸**:明确策略 ——「**最后一个显式 resize 的客户端胜**」;远程可选只读模式(不 resize)。
  不采用「取最小」(会在手机竖屏时把桌面终端压成 40 列)。
- **静态页**:`out/remote/`(相对路径引用,服务端白名单 MIME)。开发/打包都不受影响:`build.files` 已含 `out/**`。

### 2.3 远程 Web UI(P1/P3)

- 新增第 6 个渲染入口 `remote`(Vue + `@xterm/xterm`,**无 preload、无 browserAPI**),
  用独立 `vite.remote.config.ts` 构建(单入口 + `inlineDynamicImports` → 1 JS + 1 CSS),不经 electron-vite,
  免得 dev server(5173)与隧道冲突(`ELECTRON_RENDERER_URL` 是 localhost,远程浏览器打不开)。
- 复用 `@plugins/terminal/shared` 的 `TERMINAL_THEME` / 默认字号 / `matchClipboardKey`(纯逻辑,三端可用)。
- P3 移动端打磨:`visualViewport` 适配软键盘、字号、PWA manifest。**(按键条已并入 P1/S8,见 §6.2 D5。)**

### 2.4 Cloudflare 隧道(P2)

`src/plugins/terminal/remote/tunnel.ts`,两种模式:

| 模式 | 命令 | URL | 前提 |
| --- | --- | --- | --- |
| quick | `cloudflared tunnel --url http://127.0.0.1:PORT --no-autoupdate` | `https://<random>.trycloudflare.com` | 无账号;**每次启动都变** |
| named | `cloudflared tunnel run --token <TUNNEL_TOKEN>` | 固定域名 | CF 上有域名 + 在 Dashboard 配好 public hostname → `http://localhost:PORT` |

- 从 stderr 正则抓 `https://[a-z0-9-]+\.trycloudflare\.com`(cloudflared 把 URL 打在**日志**里);
- 进程监督:退避重启、日志环形缓冲(最近 N 行给设置页看)、`before-quit` 与插件 deactivate 时先杀;
- **二进制不进 Electron 包**(~40MB,多数用户用不到):v1 = 探测 PATH + 设置里手填路径 + 「下载到 userData」按钮
  (GitHub release,校验 sha256);打包成 extraResource 是 v2。

### 2.5 本地面板(P0)

herdr 的信息架构在 bow 里的对应物是「**一个常驻面板**」:工具栏加一个「牧群」按钮 → overlay
(`OverlayPlacement: 'full'`,已有四种位:`src/main/overlay.ts:1-9`),列表同 §2.1。点击一项 = `focusSession`。
本地面板的价值在于「哪个 agent 在等我」一眼可见 —— 现在这件事只体现在标签角标上,标签一多就看不见。

### 2.6 MCP 工具(P0,几乎免费且正是 herdr 的 automation 面)

终端插件 `capabilities` 加 `'mcp'`,新增:

| 工具 | 用途 |
| --- | --- |
| `terminal_list_sessions` | 列出会话(id/标题/cwd/agent 状态/最后活跃) |
| `terminal_read` | 读某个会话的尾部输出(纯文本,已剥 OSC) |
| `terminal_send` | 往会话送输入(**默认要求 `id` 显式给出**,不猜「活动会话」) |
| `terminal_run` | 新建会话并跑命令(cwd + command) |
| `terminal_close` | 关掉会话 |

这让「一个 pi 管理它的同类」成立(herdr 的 skill 也是这个思路)。⚠️ `terminal_send` 是**无确认的键盘注入**,
工具描述里必须写清;`terminal_close` 会真的杀进程树。

## 3. 安全模型(最重要的一节)

**本质**:这个端口的背后是一台机器的**交互式 shell**。隧道 URL + 口令泄露 = 对方拿到 RCE。
凡是「方便」的选项都在削弱这一条,所以要显式选择削弱到哪一档。

| 威胁 | 缓解 |
| --- | --- |
| 公网暴力猜口令 | 默认只监听 127.0.0.1(绑 `0.0.0.0` 是显式开关);口令 ≥ 16 字符随机;constant-time 比较;失败指数退避 + 封禁;不建议自己写「记住我」 |
| 口令经 URL/日志泄露 | 口令走 `POST /login` 或 WS 子协议(`Sec-WebSocket-Protocol: bow.<token>` —— 浏览器**不能**给 WS 设自定义头);不放进 query(会进 cloudflared 日志、浏览器历史) |
| 会话固定/CSRF | 登录成功**换发**新 `HttpOnly; Secure; SameSite=Strict` cookie(HMAC 签名 + 过期) |
| DNS rebinding / 本机恶意网页 | 校验 `Host` 与 `Origin`(照 `mcpHttp.ts` 的 `allowedHosts` 写法);非白名单直接 403 |
| 隧道被开放给全网 | **推荐 Cloudflare Access**(Zero Trust):`cloudflared` 前挂一层 IdP/OTP,应用口令降级为第二道;quick tunnel 下 CF 不收 Access 策略 → 只能靠口令 |
| 误把别的端点暴露出去 | 隧道**只**指向 remote 端口;`MCP HTTP`(8765)能执行任意页面 JS,**绝不**给它开隧道 |
| 手滑/失控 | 设置页一个「立即停止并断开隧道」按钮;默认**关闭**远程;`before-quit` 强制清理 child |
| 只读场景 | 提供 `readonly` 会话模式(可看不可敲),给「只想在手机上看进度」的情况 |

## 4. 分阶段实施

| 阶段 | 内容 | 新增/改动文件(估) |
| --- | --- | --- |
| **P0 台账 + 本地面板 + MCP** | `SessionInfo`、`listSessions/focus/close/sendText/readTail/createSession`、`sessions-changed` 推送(节流)、`HerdPanel.vue`、5 个 MCP 工具 | 改 `terminal/main.ts`、`terminal/shared.ts`、`terminal/ui.ts`、新增 `ui/HerdPanel.vue` + `ui/HerdButton.vue`;`tests/terminal-sessions.test.ts` |
| **P1 远程服务(仅 LAN)** | `ws` 依赖、`remote/{server,hub,auth}.ts`、`remote/index.html + src/renderer/remote/*`、`vite.remote.config.ts`、设置页「远程」分区 | 新增 6-8 文件;改 `package.json`、`electron.vite.config.ts`(或独立 config)、`plugins/terminal/ui.ts` |
| **P2 隧道** | `remote/tunnel.ts`、设置页隧道块、URL + 二维码、二进制探测/下载 | 新增 `remote/tunnel.ts` + 设置 UI;无核心改动 |
| **P3 移动端打磨** | 软键盘适配、PWA、字体/主题(按键条已在 S8 交付) | 只在 `src/renderer/remote/` |
| **P4(不做,移出 v1)** | 会话与标签解耦(sessionId 为一等身份、headless 会话、多 viewer 尺寸策略) | 若将来要做:改 `terminal/main.ts` 的 attach 协议 + `tab:closed` 语义 + 角标归属;单独立项 |

P0+P1 是可独立交付的:先能「本地看见全部 agent」,再能「LAN 内手机接管」,最后才出公网。

## 5. 风险与已知坑(每条都能对上代码)

1. **双 viewer 尺寸冲突** —— 本地终端页 `attach` 时会 `resize`(`main.ts:242` 附近),远程 attach 也会。
   必须显式定策略(§2.2),否则手机一挂上去桌面终端就被压窄。
2. **关标签 = 杀会话** —— `ctx.events.on('tab:closed')` → `killSession`(`main.ts:454`,`reason='tab-closed'`)。
   v1 远程会话依附于标签,所以「本地关掉那个标签」会把远程一起断掉。接受(并在 UI 上明说),或做 P4。
3. **`MAX_SESSIONS = 12`**(`shared.ts:52`)—— 手机想同时盯 10 个 agent 时会顶到上限。
4. **回放是原始字节流,不是终端网格** —— `replayText` 上限 200k 字符;大输出(`npm i`)之后新 attach 的
   客户端只看到尾部。实测可用(重放流会在 xterm 里重绘),但要预期「滚不到很早的历史」。
5. **`9;4` 降级路径不报 done**(`agentState.ts` 注释)—— 只认内建进度时,手机上看不到「刚跑完」。
6. **只有 pi 会主动上报** —— 其它 agent(claude code / codex)的 `working/idle` 在 bow 里是空白。
   可选启发式(输出静默 N 秒 → idle)是**猜**,会误报,建议不进 v1。
7. **移动端 xterm** —— 中文 IME、多行粘贴、软键盘顶起视口,在本地终端页已经留了一堆待真机验的坑
   (SCRATCHPAD 2026-09-19 三条);远程手机版只会更明显。
8. **机器休眠/网络切换** —— 隧道会断,cloudflared 自带重连;但 agent 若在跑,pty 不受影响(bow 在主进程里)。
9. **打包** —— `ws` 无原生模块,`npmRebuild:false` 不受影响;remote 静态资源要在 `build.files` 内(`out/**` 已覆盖);
   `asarUnpack` 已有 `node-pty`。
10. **`MCP_INSTRUCTIONS` 是模板字符串** —— 往里加工具说明时**别用反引号**做代码引用(`docs` 里记过这个坑,
    2026-10-15 删 files 插件时踩到)。

## 6. 决策记录(2026-10-16 已确认)

| # | 决策 | 结论 | 后果 |
| --- | --- | --- | --- |
| D1 | 会话与标签 | **保持 tabId 绑定**,远程 attach 已有会话 | 复用现有 attach 协议,零破坏性改动;代价 = 关本地标签会杀会话、`MAX_SESSIONS=12`;P4 不做 |
| D2 | 隧道 + 鉴权 | **两种都做**:quick 先打通 + named tunnel + Cloudflare Access 长期档 | 设置页需要模式选择与两条命令路径;quick 靠自建口令,长期档靠 CF Access |
| D3 | 本地面板 | **工具栏按钮 + overlay 全窗面板** | 不动内部页体系;`OverlayPlacement: 'full'` 已够用 |
| D4 | 终端控制类 MCP 工具 | **全做**,含无确认的 `terminal_send` | 描述里必须写明 send 是键盘注入、close 会杀进程树 |
| D5 | 客户端形态 | **浏览器**(手机为主);做 TUI 客户端(**2026-10-16**) | 见 §6.2 |

### 6.2 D5:为什么是浏览器,以及 TUI 为什么不做(但也不删)

用户侧的实情:**远端只有手机**,而且**不能 SSH 到跑 bow 的机器**。这两条合起来把 TUI 的优势全抽掉了:
TUI 最便宜的地方正是「安全与身份交给 SSH」,而这条路不通;剩下的只有「手机打不开」这一个缺点。
所以 P1 的客户端就是 Web。

但协议(§2.2 的 WS 多路复用)**与客户端形态无关** —— 将来想要 TUI 时它就是同一协议上的第二个客户端:
~200 行、零新依赖(Node 22 自带 WebSocket 客户端),而且「列会话 + 读尾部 + 发命令」现在已经能由任意 MCP
客户端做到(S4 已交付)。所以不是「不做 TUI」,而是「不把它当第一个客户端」。

两个直接后果(已改进计划):

1. **手机按键条并入 P1 的完成判据**(原 S12)。手机软键盘发不出 `Ctrl+C` / `Tab` / `Esc` / 方向键 ——
   没有它连中断一个跑飞的命令都做不到,交互式程序(`pi`)基本没法用。「手机上真的能用」才算 P1 完。
2. **S6 鉴权是承重墙**:不能 SSH 就不能「以后用 SSH 替掉自建口令」。默认档定为 **named tunnel +
   Cloudflare Access**(CF 门口验身份,应用口令退成第二道 —— 自建的 cookie/退避/封禁代码从此不承担
   唯一防线);quick tunnel 只当「第一次十分钟打通」。⚠️ named tunnel 需要你在 Cloudflare 上有一个域名,
   没有就先 quick。

**备注(不做,但记下备选)**:同样因为不能 SSH,**Tailscale** 比 cloudflared 更能省事 —— 身份在设备层,
S6 那整套口令代码可以直接不写(监听绑到 tailnet 接口即可)。D2 仍按用户选择走 Cloudflare;哪天觉得口令那套
不值得写,换 Tailscale 是砍掉它的正路(见 §8)。

## 6.1 原决策点(存档)

| # | 决策 | 当时选项 | 建议 |
| --- | --- | --- | --- |
| D1 | 会话与标签 | (a) tabId 绑定 (b) 解耦为服务端会话 | **(a)** |
| D2 | 隧道 + 鉴权 | (a) quick (b) named+Access (c) 两者都做 | **(c)** |
| D3 | 本地面板 | (a) overlay (b) 设置页 (c) `bow://herd` | **(a)** |
| D4 | MCP 工具 | (a) 全做 (b) 只读 | **(a)** |

## 7. 验证方案

- **单测(纯逻辑)**:cookie 签名/过期/篡改、Host/Origin 判定、WS 消息校验、cloudflared 输出 URL 解析、
  `SessionInfo` 归约与节流合并、尺寸夹取。全部可喂假 clock / 假字符串,无 Electron。
- **e2e**(照 `scripts/e2e-agent-status.mjs` 的缝):真 Electron + 真 pty + 假 pi → 起 remote 服务(随机端口)
  → 假 WS 客户端:无口令被拒 → 登录拿 cookie → `list` → `attach` → `input "echo hi\r"` → 断言收到 `hi`
  → `resize` 生效 → 关标签收到 `closed`。新增 npm script `test:e2e:remote`。
- **真机(只有人能验)**:手机浏览器经 quick tunnel 打开、输口令、看 replay、跑 `pi`、看 blocked 卡片、
  中文输入、锁屏后回来重连;两台客户端同时 attach 时尺寸表现。

## 8. 备选方案(为什么不是它们)

| 方案 | 优点 | 代价 / 不合适的原因 |
| --- | --- | --- |
| **Tailscale + `tailscale serve`/`funnel`** | 身份在设备层,零口令,最省心的鉴权;**不能 SSH 到 bow 主机时,它比 cloudflared 更能省事:身份在设备层,S6 那一整套口令代码可以不写**(把监听绑到 tailnet 接口即可,见 §6.2 备注) | 每台客户端都要装 Tailscale;funnel 仍会暴露到公网 |
| **Cloudflare Workers + Durable Object 中继** | URL 稳定、天生可接 Access、无需本地二进制 | 要写 DO 中继 + bow 主动 dial-out 的长连接(方向反过来),工程量最大;cloudflared 已经为这件事存在 |
| **ngrok / frp / 自建** | 换供应商 | 同样的口令问题,cloudflared 免费且够用 |
| **纯 LAN + mTLS** | 不出网,最安全 | 需要在同一网段/自建内网穿透 —— 如果「远程」= 家里局域网,这其实是**最好的**选择,可作为 D2 的第四档 |

## 9. 第一步做什么(批准后)

1. `SessionInfo` + `listSessions` + `sessions-changed`(节流)+ 单测 —— 不碰 UI,先让台账可测;
2. `HerdPanel.vue` + 工具栏按钮 —— 本地闭环,肉眼可见;
3. `terminal_*` MCP 工具 —— 顺手,且让后续 e2e 能脚本化;
4. 再动 `ws` 与远程服务(P1)。

## 10. 模块地图(谁新增、谁改动)

**新增文件**

| 文件 | 职责 | 纯度 |
| --- | --- | --- |
| `src/plugins/terminal/remote/hub.ts` | 进程内会话事件扇出(订阅者集合 + 慢消费者不阻塞生产) | 纯逻辑,可单测 |
| `src/plugins/terminal/remote/protocol.ts` | WS 消息形状 + 逐字段校验 + 尺寸夹取 | 纯函数 |
| `src/plugins/terminal/remote/auth.ts` | 口令 → HMAC cookie、Host/Origin 判定、失败退避 | 纯逻辑为主(时钟注入) |
| `src/plugins/terminal/remote/server.ts` | http + ws 装配、静态服务、把消息翻译成会话函数调用 | I/O 薄壳 |
| `src/plugins/terminal/remote/tunnel.ts` | cloudflared 监督:URL 解析 / 状态机 / 退避重启 / 日志环 | 解析与状态机纯化 |
| `src/plugins/terminal/ui/HerdButton.vue` | 工具栏入口按钮 | — |
| `src/plugins/terminal/ui/HerdPanel.vue` | 本地面板(overlay `full`) | — |
| `src/plugins/terminal/ui/RemoteSettings.vue` | 设置页「远程」分区(端口/口令/隧道) | — |
| `src/renderer/remote/{index.html,main.ts,RemoteApp.vue,RemoteTerminal.vue,SessionList.vue,KeyBar.vue,ws.ts}` | 远程页(**无 preload**) | — |
| `vite.remote.config.ts` | 独立构建 → `out/remote/`(单 chunk) | — |
| `tests/terminal-sessions.test.ts` `tests/terminal-remote.test.ts` `scripts/e2e-remote.mjs` | 验证 | — |

**改动的地方**

| 文件 | 改什么 |
| --- | --- |
| `src/plugins/terminal/main.ts` | `Session` 增字段;会话函数(create/send/read/focus/close);hub 接线;新 IPC;MCP 工具;隧道启停 |
| `src/plugins/terminal/shared.ts` | `SessionInfo` 类型 + `toSessionInfo` / `sessionSignature` 纯函数 |
| `src/plugins/terminal/ui.ts` | 注册 toolbar 按钮 + overlay 面板 + 设置分区 |
| `package.json` | 加 `ws`;`build` 串联 `build:remote` |
| `scripts/dist.mjs` | 打包前确认 `out/remote/` 存在(否则打包版远程页 404) |

**刻意不动的**:`kernel.ts` / `types.ts` / `internalPages.ts` / `preload` / `builtin.ts`。理由:P0 只用已有的
`ctx.ipc` / `ctx.mcp` / `ctx.pages.focus` / `ctx.tabs.openInternal`;远程服务是插件自己的 Node 资源,
不是 Electron 资源,不需要内核代持。**若哪天别的插件也要用这套服务,才需要往内核提一层。**

## 11. 分步实施(每步单独可验收)

依赖顺序:`S1 → S2 → {S3, S4}` ,然后 `S5 → S6 → S7 → S8` ,再 `S9 → S10` 与 `S12` 。

### P0 台账 + 本地面板 + MCP

| # | 步骤 | 做什么 | 完成判据 |
| --- | --- | --- | --- |
| S1 | **会话台账** | `shared.ts` 加 `SessionInfo` / `toSessionInfo` / `sessionSignature`(指纹**不含** `lastOutputAt`,否则永远"变了");`main.ts` 的 `Session` 加 `cwd/pid/createdAt/lastOutputAt/agent/agentAt`,`notifySessions()` 250ms 合并 + 指纹比对 | `npm test` / `npm run typecheck` 绿;新单测:同输入同指纹、假 clock 下连触发 10 次只广播 1 次 |
| S2 | **会话 IPC 面** | `main.ts` 加 `listSessions` / `focusSession` / `closeSession` / `sendText` / `readTail` / `createSession` + `sessions-changed` 推送 | 临时 CDP 脚本:开两个终端 → list 两个 → `readTail` 非空 → `sendText('echo hi\r')` 读回 hi → `closeSession` → 少一个 |
| S3 | **本地面板** | 新 `HerdButton.vue` + `HerdPanel.vue`;`ui.ts` 注册(toolbar + `plugin:terminal:herd`,placement `full`)—— 三件套照 `src/plugins/pomo/ui.ts` + `PomoButton.vue` 的写法 | 开 3 个终端;跑假 pi 发一条 `blocked` → 面板红点;点一项跳到那个标签;关标签后列表少一项 |
| S4 | **MCP 工具 ×5** | `main.ts`:`capabilities: ['ui','mcp']` + `terminal_list_sessions/read/send/run/close` | `npm run test:mcp` 工具数 +5;pi 能调 `terminal_list_sessions` 并读回一个会话的尾部 |

### P1 远程服务(先只在 LAN 用)

| # | 步骤 | 做什么 | 完成判据 |
| --- | --- | --- | --- |
| S5 | **hub + 服务骨架** | `package.json` 加 `ws`;新 `remote/hub.ts`(纯)+ `remote/server.ts`(`/healthz` + 占位静态);`main.ts` 在 `flush()`/`reportAgent()`/spawn/`killSession()` 四处接 hub;设置增 `remote.{enabled,host,port}` | `curl 127.0.0.1:PORT/healthz` 200;停用后端口关闭;hub 单测:订阅/退订/慢消费者不阻塞生产 |
| S6 | **鉴权** | 新 `remote/auth.ts`:口令 → HMAC-SHA256 cookie(密钥随机 32B 存 `terminal.json`;`HttpOnly;Secure;SameSite=Strict`;有效期 7d)、constant-time 比较、`Origin.host === Host`(隧道下即 trycloudflare 域)、失败退避表 | 单测:篡改/过期/坏 Origin 全拒;无 cookie 打 `/ws` → 拒;`POST /login` 对口令 → 拿 cookie 后 `/ws` 通 |
| S7 | **WS 协议** | 新 `remote/protocol.ts`(纯校验)+ server 处理;复用 S2 的会话函数;`attach` 先回 `replayText` | 新 `scripts/e2e-remote.mjs`:假客户端 `list → attach → input → 读回 → resize → 关标签收 closed`;无口令分支必须被拒 |
| S8 | **远程页 + 手机按键条** | `vite.remote.config.ts` + `src/renderer/remote/*`(含 **`KeyBar.vue`**:Ctrl/Alt/Shift/Tab/Esc/方向/Paste);server 静态服务(白名单 MIME、防路径穿越、`index.html` 不缓存);`npm run build:remote` | 浏览器开 `http://127.0.0.1:PORT` → 登录 → 列表 → attach → 能打字;**能发 Ctrl+C 中断一个跑飞的命令**;同网段手机能开(需 `host=0.0.0.0` 开关,仅开发期自测用) |

### P2 隧道(P1 完成后)

| # | 步骤 | 做什么 | 完成判据 |
| --- | --- | --- | --- |
| S9 | **隧道监督** | 新 `remote/tunnel.ts`:探测二进制(PATH → 设置项 → userData)、quick/named 两种命令、从输出抓 URL、退避重启、日志环、状态推给设置页 | 单测:从真实 cloudflared 日志样本里抓 URL;状态机 stopped→starting→running→error 跳转;启停幂等 |
| S10 | **设置页隧道块** | `RemoteSettings.vue` 加块:模式选择、token、二进制路径/下载按钮、URL + 复制、(可选)二维码、日志尾、「立即停止并断开」 | 手机扫/点 URL 能进;点「停止」后公网地址立刻不可达 |
| S11 | **退出清理** | `deactivate` 与 `before-quit` 先杀 cloudflared;`killTree` 从 `main.ts` 提到共享 helper 复用 | 退出 bow 后 `cloudflared` 进程不存在(Windows 上查任务管理器/`tasklist`) |

### P3 手机 UX(按键条已并入 S8,这里只剩打磨)

| # | 步骤 | 做什么 | 完成判据 |
| --- | --- | --- | --- |
| S12 | **移动端打磨** | `visualViewport` 适配软键盘、字号/主题、只读模式开关、PWA manifest(加到主屏) | 真机:软键盘弹出不遵输入行;中文输入能上屏;锁屏回来自动重连;主屏图标进去就是会话列表 |

> 按键条(Ctrl/Alt/Shift/Tab/Esc/方向/Paste)已从 S12 **提到 S8**,与远程页一起交付 ——
> 手机是唯一客户端,没有它远程页等于半成品(见 §6.2 D5)。

**可提前交付的组合**:S1+S2(台账 + API,无 UI)、S1–S4(P0 完整=「本地牧群面板+MCP」)、S5–S8(P1 完整=「局域网远程接管 + 手机可用」)。
P2 可以延后而不影响前面任何一步 —— 在那之前用 `ssh -L PORT:127.0.0.1:PORT` 或 LAN 开关也能远程用(注意:
后者对本用户不适用,见 §6.2 —— 那条只能当开发期自测手段)。

## 12. 人工测试发现的两个缺陷(2026-10-16 已修)
用户在真机按 §7 的清单测试,报了「面板里点 × 后牧群列表去掉了,但分屏窗口还在」。顺着这条
在 Windows 侧跑了一遍 AI 面,又抓出两个:

1. **`closeSession` 只杀 pty,不关标签**(用户报的)。标签里留着一个「会话已结束」的死页面,
   在分屏窗格里尤其明显。修法:`session-closed` 带 `reason: 'closed-by-request'` 时**终端页关自己的标签**
   (用户的心智:一个终端标签就是一个会话;`exit` / 插件停用仍然留着页面显示原因)。
   顺带发现「关掉最后一个标签会让窗口空掉」—— `TabManager.close()` 现在补一个空白页
   (渲染层的 `listTabs()` 是**跨窗口**的,在这里判"最后一个"会漏判,所以放在主进程)。
   `scripts/e2e-herd.mjs` 加了三项断言:被关会话的标签真的没了、窗口里仍有标签。
2. **Windows 上裸命令必须带 `.exe`**,而 `terminal_run` 会把「标签开好了」当成功。实测:
   同一个 `node` 在那个终端里手敲是能跑的,但 `{command:"node"}` → `File not found`(node-pty 把名字
   直接交给 `CreateProcess`,不补 PATHEXT);而且工具仍然回 `ok:true`,AI 完全看不出命令没起来。
   修法:`withWindowsExeSuffix()`(shared.ts,纯函数,已有单测)+ `terminal_run` 现在**等 spawn 结论**
   (`waitForRun`,最多 3s):`state: running | failed | starting`,失败带原因并标 `isError`。

顺带核实的环境事实(给以后的 Windows 排错):
- **`pi` 不在 Windows 的 PATH 上**(它在 WSL 里)→ Windows 上要用 `wsl.exe -e pi`。
- `.cmd` / `.bat` shim(npm 全局装的那种)**不能**直接 spawn,必须 `cmd.exe /c`;补 `.exe` 也没用。
- **从 WSL 驱动 Windows 版的 MCP stdio 走不通**:WSL interop 只透传列在 `WSLENV` 里的环境变量
  (不写 `WSLENV=MCP` 的话 `MCP=stdio` 根本传不过去,应用会按普通模式启动、日志走 stdout 把协议冲坏);
  就算传过去了,Electron 全量启动时 stdin 也不可用(纯 `ELECTRON_RUN_AS_NODE` 模式可以)。
  **正确做法**:用 Windows 自己的 node 跑脚本,或走 HTTP MCP(`MCP_HTTP=1 MCP_HTTP_PORT=...`)。

## 13. S5 落地记录(2026-10-16)

**加了什么**:`ws@8`(唯一新依赖)、`remote/hub.ts`、`remote/server.ts`、`TerminalRemoteSettings`、
`remote-changed` 事件、`remoteStatus` / `applyRemote` 两个 IPC。

**三个设计决定**:

1. **慢消费者断开,不丢字节**。丢一个 chunk 终端画面就**永久错位**(光标位置/转义序列全乱),
   而断开后重连时 `attach` 会先发回放,画面能重建 —— 所以「超过 4MB 积压就踢掉」是这里唯一自洽的
   策略。单测里专门验了「一个字节都没给它,但它被 drop 了」。
2. **台账复用同一个指纹去重**。`emitSessions()` 里 `ipc.emit` 之后顺手 `hub.publish`,
   所以远程不会比本地面板多播一次;代理状态也不需要单独的事件类型(它在 `SessionInfo.agent` 里)。
3. **`/healthz` 不带内容**。S6 之前它没有鉴权,所以只回 `ok/service/bind/sessions 数量`,
   不回标题、路径、输出。

**测试抓到的一个真缺陷(值得记)**:`applyRemote` 原来没有串行化 —— `setSettings` 触发的
对齐与随后显式调用的 `applyRemote` 撞在一起,两个 `startRemoteServer` 抢同一个端口,
报的是**自己上一次刚开的那个** EADDRINUSE。修法:在飞的调用只加「脏」标记、结束后再对一次
(合并 + 收敛),`terminalSessions.test.ts` 里三条用例看住启停/端口占用/停用释放。

另一个环境坑:本机配了 HTTP 代理,**`fetch` 到一个已关闭的端口会拿到 502 而不是拒绝** ——
所以「端口真的释放了」这条必须用裸 TCP 连接判,不能用 fetch。

## 14. S6 落地记录(2026-10-16)

**加了什么**:`remote/auth.ts`(`RemoteAuth` + `LoginThrottle`)、`POST /login`、鉴权守卫、
`GET /api/sessions`、口令字段(设置里,明文,空/太短拒绝启动)。

三个决定:
1. **浏览器走 HttpOnly cookie,脚本走 Bearer**。浏览器没法给 WS 设自定义头,所以握手只能靠 cookie;
   命令行/将来 TUI 用 `Authorization: Bearer <口令>`。**口令绝不进 query**(会进日志与浏览器历史)。
2. **cookie 里装 `<过期>.<口令指纹>` 再签名**,不是口令本身 —— 换口令时旧 cookie 自动失效,不用轮换密钥;
   密钥单独存 `terminal-remote.json`,不混进用户会手改的 `terminal.json`。
3. **前 5 次失败只记账,第 6 次起翻倍退避(30s → 封顶 5min)**;成功一次清零。

⚠️ 局域网是 **http**:口令在链路上是明文(同 WiFi 的人抓到就能用)。所以「局域网模式」只适合自己家/可信网络;
公共 WiFi 要么走 Tailscale,要么等隧道(https)。这条要写进 README。

**踩到的两个环境/测试坑(都记在这里免得重犯)**:
- **本机 `HTTP_PROXY` 会被 Node 应用到 loopback**:`fetch` 与 `http.request` 都可能被转给代理,
  表现是「连已关闭的端口拿到 502」而不是拒绝。修法有两层:`vitest.config.ts` 里清空代理变量(测试一律直连),
  以及测试内用 `tests/localHttp.ts`(直接 `node:http`)而不是 `fetch`。
- **测试替身把两个存储返回成了同一个对象**:插件写 `terminal-remote.json` 的签名密钥时把
  `terminal.json` 的设置冲掉了,表现是「远程服务启动后又被自己关掉」。真 `JsonStore` 是按 filename
  隔离的 —— 替身现在也按 filename 隔离,并在注释里写明为什么。

## 15. S7 落地记录(2026-10-16)

**加了什么**:`remote/protocol.ts`(上行消息逐字段校验 + `RemoteSessionApi` 窄接口)、
`/ws` 升级(路径 + 鉴权 + Origin 三道都在握手阶段判)、hub → WS 的 `HubSink` 适配、
`ws@8` 的类型(`@types/ws`,devDep)、`scripts/e2e-remote.mjs`。

四个决定:
1. **一条连接多路复用所有会话**。手机切来切去不该反复握手;订阅是**连接级**的(hub),
   所以 `detach` 在服务端目前是空操作 —— 留着是为了协议完整,将来要做「按会话退订」再说。
2. **远程 attach 不 spawn**,只订阅已存在的会话(那是 `create` 的事)。`attach` 会把自己的
   `cols/rows` 推给 pty,沿用 D1 定的「最后一个 resize 者胜」。
3. **服务端不自己发 `closed`**:`close` 成功后由插件 `killSession` publish 到 hub
   (与面板的 × 同一条路径)。写测试时踩到过这点 —— 假实现不发就会「等消息超时」。
4. **握手里的三道闸**:路径是 `/ws`、`auth.verifyRequest`(cookie 或 Bearer)、跨站 Origin 拒。
   任一不过直接回 401 并销毁 socket,不进 WS 世界。

**e2e 覆盖(24 项全绿)**:设置开关 → 监听 → `/healthz` 公开 → 未登录 401 → 错口令 401 →
口令 204 + cookie(且不带 Secure)→ 带 cookie 读台账 → 无 cookie 握手被拒 → 跨站 Origin 握手被拒 →
hello 带服务名与台账 → create → 台账推送 → attach 拿回放/尺寸 → input 经真 pty 回显 →
read 尾部 → resize 落到台账 → close 事件 → 标签一起关掉 → 会话清零 → 关开关停服 → 端口放开。

## 16. S8 落地记录(2026-10-16)—— 局域网这条路通了

**加了什么**:`vite.remote.config.ts`(独立构建 → `out/remote/`,单 chunk,无 hash)、
`src/renderer/remote/`(登录 → 会话列表 → 终端 + 手机按键条)、`remote/static.ts`(静态文件白名单)、
`ui/RemoteSettings.vue`(设置页「远程控制」分区)。

四个决定:
1. **远程页完全不用 preload**,也不进 electron-vite 的 renderer 入口 —— 它跑在**普通浏览器**里。
   产物是相对路径 + 固定文件名(`app.js` / `app.css`),静态服务按白名单给文件,不需要 manifest。
2. **静态页公开、API/WS 要鉴权**:页面本身就是登录页,里面没有秘密;这样手机第一次打开时
   不需要先带 cookie。
3. **按键条用「粘滞修饰键 + 快捷序列」**:软键盘发不出 `Ctrl+C`,所以既能一键发 `C-c`/`Esc`/方向,
   也能点亮 Ctrl 后敲任意字母(`applyModifiers` 把 `c` 变成 `\x03`)。多字符(粘贴)不被改写。
4. **断线重连 + 重新 attach**:手机锁屏/切后台回来,WS 退避重连,成功后重新 attach,
   靠服务端回放重建画面(客户端不缓存字节)。

**e2e(`scripts/e2e-remote.mjs`,29 项全绿)** 新增的最后一段是「手机上真的能用」的证据:
在 **bow 自己的普通标签页**里打开 `http://127.0.0.1:port/`(无 preload 的浏览器上下文)→
登录表单渲染 → 页面里真提交口令 → 连上 WS(显示「已连接」)→ 电脑端新建终端 → 手机页列表出现该行 →
点进去 xterm 与按键条都渲染出来。

顺手修掉的:设置页的两个分区(`TerminalSettings` + `RemoteSettings`)在 `ui.ts` 里按顺序注册。

## 17. Windows 侧复验(2026-10-16)

在用户真实环境(Windows 的 bow + Windows node)上把整条链路跑了一遍:

- `e2e-remote.mjs` **29/29 全绿**(含普通浏览器上下文里的远程页、xterm、按键条);
- 真机 `bind: 'lan'` 探针:启动成功,`lanUrls = ["http://192.168.1.20:8899"]` —— 地址来自操作系统网卡枚举;
- 顺手确认:Windows 侧需要 `bun install`(`ws` 是运行时依赖,electron-vite 默认外部化),
  以及 `out/remote/` 必须一起同步/重建。

至此 **P0 + S5–S8(局域网远程)完成**。S9–S11(隧道)因无域名搁置,S12(移动端打磨)未做。

### S8 补丁:手机自己能开终端

原先 WS 的 `create` 强制要 `command`,于是手机在**空列表**时是死胡同(只能回电脑上开一个)。
现在 `command` 可省 = 「开一个默认 shell profile」(与面板的「新终端」同一条路径),
远程页列表头有 `＋`、空状态有大按钮。`command: '   '`(空串)仍然拒 —— 省略与空串是两回事。

## 18. 手机首轮实测的三个问题(2026-10-16,已修)

用户在同一 WiFi 上真机测出三条,根因各不相同:

1. **点 Ctrl 软键盘就收起**。按键条是 `<button>`,点它 → 焦点从 xterm 的隐藏 textarea 移走 →
   系统收键盘,后面敲的字也进不去。修法:所有键 `tabindex="-1"` + `pointerdown` 上 `preventDefault`
   (只拦焦点,动作仍绑 `click`),并在动作后 `term.focus()` 兜底。
   ⚠️ 这条只有**真鼠标事件**才验得出来(合成 click 不触发焦点变化),所以 e2e 里用 CDP
   `Input.dispatchMouseEvent` 真点一下再断言 `document.activeElement` 还是那个 textarea。
2. **缺 `/`**。手机输入法把斜杠压到第二页,而路径几乎每行都要打 → 按键条补 `/`。
   用户明确选了「只补这一个」,所以没有加整排符号。
3. **翻不了历史**。**不是没开 scrollback,是结构性的**:xterm 的可滚动层在 canvas **下面**,
   手指按在文字上根本落不到滚动容器里,原生滑动永远不生效。
   用户选了「只做浮动按钮,不做手势」→ 终端右侧浮动 `▲`(始终有)/`▼`/`最新`,
   用 `term.scrollPages()` / `scrollToBottom()` 做**本地回看**(不往 shell 发任何字节)。
   翻着历史时来了新输出:视口**不拽走**,只在按钮上显示「新输出」。

顺带两件事:
- 按键条加了 `PgUp`/`PgDn`(发 `\x1b[5~`/`\x1b[6~`)—— 本地回看对 vim/less/tmux **没意义**,
  它们要的是把翻页键发进去。不想留就删两行。
- 回看 / 回底会**熄灭粘滞修饰键**:否则「点了 Ctrl → 滚动 → 打字」会意外变成 Ctrl+那个字符。

**e2e 覆盖(38 项全绿,WSL 与 Windows 两侧)**:真鼠标点 Ctrl 后焦点仍在终端且 Ctrl 点亮、
按键条有 `/`、缓冲区有历史、`▲` 能进历史、翻着历史时新输出不拽视口且提示「新输出」、
`最新` 回到底部。回看这一段**不依赖 shell**(Windows 默认 PowerShell,`seq` 不存在 ——
早先按 Linux 写的断言在 Windows 上直接假阴)。

## 19. 尺寸归属:改成「谁刚碰过,尺寸归谁」(2026-10-16,已修)

用户实测:手机上点进一个会话后,**电脑那个终端一直是手机宽度**,只有拖一下窗口才恢复。

根因不是 bug,是 D1 那条 `resize: 最后一个 resize 者胜` 的必然结果 —— 一个 pty 只有一个
cols/rows,手机 attach 时把它改小了;而电脑端的终端页**只在容器尺寸变化时**重新 fit,
所以没有任何东西会把它抢回来。

用户选的解法不是 A/B/C(改归属模型 / 两端同步),而是更划算的一条:
**让「交互」成为一个重新认领的信号**。

- 电脑端终端页:`window focus` / `pointerdown` / `keydown`(capture)/ 标签重新可见(`visibilitychange`)
  → 都调一次 `refit()`。点一下终端、切回这个标签、直接开始敲,都会把宽度抢回电脑的。
- 手机端终端:`pointerdown` 也 refit —— 手机上碰一下,宽度又归手机。两边互相抢得回来,
  模型从「最后 resize 者胜」升级成「最后**碰过**的那端胜」,不需要登记 viewer,也不需要恢复逻辑。

e2e(42 项,WSL + Windows 两侧全绿)直接复现用户的现场:
手机用 40 列 attach(pty 变 40)→ **在电脑的终端页上发一个真鼠标事件** →
`listSessions` 里的 cols 回到电脑原来的值。

⚠️ 一个诚实的残留:被手机改小期间已经折行的那些行,xterm **不会重新回绕**(它没有 reflow,
tmux 有)。新输出正常,旧行要等滚出屏幕。这是 xterm 的既有限制,不是这次的改动引入的。

## 20. 手机端不再渲染 xterm:换成「对话 + 队列」(2026-10-16)

用户在手机上实测后的结论:**不是尺寸问题,是数据源问题**。`working` 动画是「光标移动 + 局部重绘」,
每一帧都会留在 pty 字节流里;宽度一变,pi 按新宽度重排、历史还是旧宽度画的 —— 手机上怎么渲染都是乱的。
所以这一轮把手机端从「终端镜像」换成「结构化对话」,顺手把 S12(移动端打磨)作废。

### 20.1 先验证「能不能绕过终端」(实测,不是猜)

| 问题 | 结论 |
| --- | --- |
| pi 有结构化读写 API 吗 | 有:`pi --mode rpc`(JSONL)+ 扩展 API。`get_state` / `get_messages` / `get_commands` 零模型调用就有结构化回包 |
| 在 TUI 里(bow 的形态)能注入消息不碰键盘吗 | 能:扩展调 `pi.sendUserMessage()` → `agent_start → message_start/end → agent_end → agent_settled`,一个按键都没用 |
| 能读到结构化回复吗 | 能:扩展事件的 `message_end` 带完整 `message`(role/content);另有 session JSONL 与 RPC 的 `get_messages` |
| 审批能被外部回答吗 | 能:`pi.on('tool_call', async …)` 是异步钩子,可 `await` 外部回答并返回 `{block:true}` |

**一个被自己探针坑过的点**:第一版探针在 agent 跑到一半时 `sendUserMessage(text)`(不带参数),
那条消息**凭空消失**。原因不是 API 不可靠 —— `agent-session.d.ts` 写明「streaming 且没给
`streamingBehavior` 时**抛错**」,而扩展 API 的 `sendUserMessage` 返回 `void`、把异常吞了。
正确用法是 `{ deliverAs: 'steer' | 'followUp' }`(pi-phone 的 `parent-session-worker.ts:458` 就是这么写的)。
⇒ **队列不自己造**:忙的时候一律发 `followUp`,让 pi 排队;`steer` 给「插话」按钮。

### 20.2 调研过的三个项目(照抄它们的调用方式,不照抄产品)

- **pi-phone**(57★,面向 pi 0.58.4):扩展内镜像当前 TUI 会话 + 并行 `pi --mode rpc` 子进程。
  我们借:`sendUserMessage({deliverAs})` / `ctx.abort()` / `sessionManager.buildContextEntries()` / 事件集。
  不借:5168 行手机前端、Tailscale Serve、单写者 owner 模型。
- **pi-mobile**(0.4.0):E2E 加密 + 锁屏答扩展弹框 + 语音,功能最全但依赖 Tailscale(用户明确不要)。
- **remote-pi / Cockpit**(0.7.0):Flutter + Rust 中继 + SSH-only 主机;本地 agent mesh(`list_peers`/`agent_send`)
  正是用户不要的「工头」那一层。
- 结论:**不要自己再写手机端产品**;但 bow 的壳(多标签 + 会话台账 + 局域网鉴权)已经写完了,
  所以只补一条「控制通道」,把对话搬进去。

### 20.3 落地(改了什么)

1. **扩展**(`packages/pi-bow/extensions/bow-agent-state.ts`,仍是自包含单文件,合并进已有 OSC 桥):
   - 门禁:在 `BOW_TERMINAL=1` 之上再要 `BOW_SESSION_ID` / `BOW_REMOTE_URL` / `BOW_CONTROL_TOKEN`(老 bow 不注入 = 静默不做事);
   - 上行:`message_end` → 一行行 `ChatMessage`(工具调用与它的 `toolResult` 共用 `toolCallId` 作 id);
     `agent_start/settled` → `busy`;收到 `history` → 用 `sessionManager.buildContextEntries()` 回 `snapshot`;
   - 下行:`prompt`(忙时缺省 `followUp`)/ `abort`(`ctx.abort()`);
   - 用 Node 内建 `WebSocket`(pi 的 engines 是 node ≥22.19),断线 3s→30s 退避;
   - **WSL2**:bow 在 Windows、pi 在发行版时,`127.0.0.1` 是发行版自己的回环 —— 扩展会从
     `/proc/net/route` 取默认网关再补一个候选 URL(所以要 `remote.bind = lan` 才通,而手机上用远程本来就是 lan)。
2. **bow 侧**:`remote/piChat.ts`(纯逻辑:`sanitizeChatMessage` / 缓存 / 工具行合并 / 慢 viewer 跳过 / 路由)、
   `protocol.ts` 三条上行(`chat` / `prompt` / `abort`)与三条下行(`chat` / `chat-message` / `chat-state`)、
   `RemoteSessionApi.controlToken(id)`(每会话随机令牌,`role=pi` 的 WS 只认它,不用口令也不用 cookie)。
3. **pty**:spawn 时经 `withBowTerminalEnv(env, shell, extra)` 注入三件套(非 WSL 合并、
   WSL 一并列进 `WSLENV`),每个会话一个新令牌。
4. **手机页**:删掉 `TerminalView.vue` / `KeyBar.vue` / `keys.ts`(−400 行),新增 `ChatView.vue`:
   气泡(用户右 / pi 左)、工具单行(点开看参数与结果)、`发送` / `插话` / `停止`、「有排队」标记、
   没有控制通道时输入框禁用并给一句「重开终端即可」。
5. **协议里的终端部分全部保留**(`attach/input/resize/read`):MCP 工具、本地终端页、e2e 都还在用,
   只是手机页不再发它们。

### 20.4 验证

- vitest:`tests/terminalRemoteChat.test.ts` 16 例(校验 / 缓存 / 工具合并 / 上限 / 慢消费者 / 路由 / 令牌握手 / 真 WS 往返);
  `tests/terminalShared.test.ts` 补 WSLENV 三件套;全库 **82 文件 / 1513 例**。
- e2e(`npm run test:e2e:remote`,WSL 侧跑):**37 项全绿** —— 其中手机页那 5 项换成
  「点会话进对话视图 / 没有 xterm 与按键条 / 没有控制通道时给提示且输入框禁用 / 返回列表」。
- 真 pi 冒烟(**新增** `npm run test:pi:chat` → `scripts/pi-chat-smoke.mjs`):7 项全绿 ——
  扩展带令牌连上 / 回 snapshot / 发话后 busy / 用户消息回显 / 助手结构化回复 / 回到 idle。

### 20.5 已知边界(别当 bug)

1. **已折行的旧行不会重新回绕**(xterm 没有 reflow)—— 但这一条对手机端**不再适用**:它不渲染终端了。
2. `ctx.hasPendingMessages()` 只有布尔值 → 手机上只显示「有排队」,数不出几条。
3. 历史只回最近 60 条、单条正文 4000 字符、工具输出 1200 字符(超出截断)。更早的去电脑上看。
4. 本次改动**之前**就开着的终端里没有三件套 → 手机上显示「没有控制通道」,重开终端即可。
5. WSL 那条依赖 `remote.bind = lan`(默认 loopback);Windows 原生 pi 则 loopback 就够。
6. 审批仍未接管(P3):pi 问问题,手机看得见(`ui_prompt_start` 走 OSC 那条老路,列表上有「等你」),
   但要回答还是得在电脑上点。`ctx.ui` 包装是下一步,pi-mobile 证明可行,我们没验。

## 21. 远程控制的缺口盘点与优化计划(2026-10-16)

S13 之后手机端已经是「对话」,能读能写能排队能中断。剩下的洞按「会不会把人卡住」排:

| # | 缺口 | 现状 | 影响 |
| --- | --- | --- | --- |
| 1 | pi 的提问手机答不了 | 列表显示「等你」,对话里什么都没有;`ask_user_question` / 权限门 / plan 批准都得回电脑 | **最大**:一次问答就把人从手机前拽走 |
| 2 | 没有流式 | 只在 `message_end` 推 | 长回答期间屏幕只有「在跑」,看不出它在写什么 |
| 3 | 发送失败丢草稿 | 红条报错但输入框已清空 | 长 prompt 白打 |
| 4 | 断线是静默的 | WS 后台重连,界面无提示 | 以为发出去了,其实没有 |
| 5 | 「没有控制通道」不区分原因 | 一句话 | 实测踩过:扩展旧版 / 装错系统 / env 没进 / 连不上,全靠猜 |
| 6 | `/compact`、切分支后缓存不刷新 | 仍显示旧对话 | 会怀疑它没在干活 |
| 7 | 工具输出截断 1200 字符 | 点开也只有 1200 | 看报错不够 |
| 8 | 对话页没有 cwd | 只有列表里有 | 多项目时容易聊错会话 |
| 9 | 手机不能换行 | Enter 直接发 | 多段 prompt 只能一次发 |

### 21.1 计划

- **P1 手机回答 pi 的提问**(约 1 天):pi 的对话框就四个(`ctx.ui.select/confirm/input/editor`,
  都返回 Promise、都支持 `signal` 与 `timeout`)。扩展把这四个包一层:
  `Promise.race([原始调用, 手机回答])` —— 原始调用照旧让**终端**弹框,手机先答就用
  `opts.signal` 把终端那个框程序化关掉。协议加 `ask` / `answer` / `ask-done`;
  手机上是按钮组 / 输入框 / 「去电脑上答」。`custom()` 不接管(直接落到终端)。
  ⚠️ 前置 spike:确认四个方法能包住(pi 是否解构调用)、`signal` 真能关掉终端对话框。
- **P2 流式输出**(约 0.5 天):`message_update` 的 `text_delta` 节流 ~10 次/秒,
  手机上「正在写…」临时气泡,`message_end` 到达后以最终文本替换。
- **P3 小修一批**(约 2 小时):失败保草稿 / 断线横幅 / compact·切分支后重发快照 /
  对话页显示 cwd / 把「没有控制通道」分成四种原因(扩展未装或旧、env 没进、连不上服务、会话已关)。
- **可选**:推送(把已有的 `blocked`/`done` 信号接到 ntfy / Bark / Server酱 —— 局域网 http 上
  浏览器通知拿不到权限,这是唯一不折腾的路);换行键;加载更早历史;代码块等宽底纹。

### 21.2 明确不做

手机新开 pi / 新开终端(用户已定:PC 起终端和 pi)、HTTPS 与隧道(无域名且不要 Tailscale)、
图片附件与语音、手机切模型/思考档/压缩、markdown 渲染库。

### 21.3 顺序

P1 → P3 → P2。每档都要过 `npm run test:pi:chat`(真 pi,会调一次模型)、
`npm run test`、`test:e2e:remote`、`test:e2e:agent`,再加手机上的清单。

### 21.4 P1 落地记录(2026-10-16)

**Spike 先做,结论全绿**(`npm run test:pi:ask`,8 项,不花模型调用):

| 问题 | 结果 |
| --- | --- |
| 别的扩展发起的 `ctx.ui.confirm` 会被我们的包装拦到吗 | ✅ 会(题面 title/message 都到了手机) |
| 终端那一路还在吗 | ✅ 原始调用照旧被请求(终端里那个框不会消失不见) |
| 手机先答 | ✅ `confirm` 的返回值就是手机的 `true` |
| 手机不答、终端答 | ✅ 返回值来自终端(`false`) |

做法:扩展把 `ctx.ui` 的 `select / confirm / input / editor` 包一层,
`Promise.race([原始调用, 手机回答])`;手机先答就用 `opts.signal` `abort` 掉终端那个框
(`ExtensionUIDialogOptions.signal` 的语义就是「程序化 dismiss」)。`editor` 没有 opts,
关不掉终端的框(不影响结果,那个框晚点被点掉)。`custom()` 不接管,直接落到终端。

**踩到的坑(重要)**:第一次跑 spike 时一次提问出现**两条** `extension_ui_request`、结果随机。
原因不是 API,是 pi 同时加载了**两份**扩展(`~/.pi/agent/extensions/` 里装的那份 + 冒烟里
`--extension` 加的那份),两份各自包了一层。两条修法都留了:

- 包装函数**自己身上打 `Symbol.for('bow.chat.uiWrapped')` 标记**再跳过 —— 不能按 `ctx.ui`
  的对象身份去重,pi 每次给的 `ctx`(连带 `ui`)可能是新对象;
- bow 侧 `PiChatHub` 对同一条消息按 `(role, id)` **就地更新**而不是追加 —— 顺带解决
  「同一个扩展被加载两次时消息翻倍」;
- 冒烟里用空的 `PI_CODING_AGENT_DIR` 隔离,只加载 `--extension` 指定的那份。

**已知边界**:`editor` 的终端框关不掉;`timeout` 由 pi 自己掌握(到点它按默认值走,手机上的卡片
会在 `ask-done` 时消失);手机上的「×」只是本地收起卡片(pi 那边继续等终端)。

### 21.5 P1 补丁:`ctx.ui.custom` 的绕法(2026-10-16)

实测发现手机仍然拿不到卡片。原因不是链路,是 `ask_user_question`(rpiv)走的是
**`ctx.ui.custom`** —— 任意 TUI 浮层,搬不到手机上;我们只接管了 `select/confirm/input/editor`。

它在 `rpc-fallback.ts` 里自带一条回退:`custom()` 解析为 `undefined` 时改用 `select`/`input`
逐个问。于是扩展在 bow 里把 `custom` 换成 `async () => undefined`;
想保留浮层就设 `BOW_PI_CUSTOM_UI=native`(代价是手机答不了那种弹框)。

验证(`npm run test:pi:ask`,场景 C):探针先 `custom()` → `undefined` → 再 `select(['甲','乙'])`
→ 手机选中「乙」→ `select` 返回「乙」。

真机侧用**模拟器**(Windows 的 AVD `api35`)+ `adb reverse` + Chrome DevTools 验了页面:
卡片(需要确认 / 题面 / 允许·拒绝)渲染正常,点「允许」发出
`{t:'answer',id,requestId,value:true}`,卡片随即消失。

顺带记两条环境事实(WSL 里踩到的):
- 模拟器**到不了** WSL 里监听的服务(Windows 侧 8770 能开,WSL 的 45173 打不开);
  要验就用 `adb reverse tcp:<port> tcp:<port>` 后在模拟器里开 `http://localhost:<port>/`;
- 同一个会话的 pty 可能被 **attach 两次**都触发 spawn(`createSession` 之后页面再挂一次),
  后写的 Session 覆盖前一个 → 前一个进程的令牌就失效了。排查时以
  `/api/sessions` 里的 `pid` 为准去读 `/proc/<pid>/environ`,别猜。

### 21.6 P3 落地记录(2026-10-16)

五条一次做完:

1. **发送失败保草稿**:`ChatView` 记住刚发的那句,收到服务端 `error` 就把它还回输入框
   (用 `errorAt` 时间戳当身份 —— 同一个原因重复出现时也要触发);
2. **断线横幅**:WS 不是 `open` 时,对话页顶部一条「连接断了,正在重连……(没接上的话,消息不会发出去)」;
3. **compact / 切分支后重发快照**:扩展监听 `session_compact` 与 `session_tree` → `snapshot()`;
4. **对话页显示 cwd**:头部多一行小的 mono 路径(来自台账,列表刷新时跟着变);
5. **「没有控制通道」分两种原因**(客户端就能判断,不用新增协议):
   - 台账里有 `agent` 状态 = 终端里的 pi 确实装了扩展(它在发 OSC),那问题在控制通道本身
     → 「重开这个终端(让它拿到 `BOW_*` 变量),或在 pi 里 `/reload` 升级扩展」;
   - 台账里也没有 = 「这个终端里没检测到 pi(或者没装扩展:设置页 → 终端 → Pi 联动)」。

**顺带修了 e2e 自己两个 bug**(它们才是「偶发超时」的真凶):

- `connectWs().next()` 超时后没把 waiter 从数组里摘掉 —— 那个已拒绝的 waiter 继续存在,
  之后**把匹配到的消息吞掉**,表现为「明明收到了 sessions 却一直等不到」;
- resize 断言没考虑「电脑端终端页挂载时的 fit 晚于远程 resize」这条既有约定(最后一个赢),
  现在允许重试。

结果:`test:e2e:remote` 连跑 6 次全绿(42 项);vitest 1520;`test:pi:ask` 11;`test:pi:chat` 7。

### 21.7 软键盘遮住输入框(2026-10-16)

布局是 `html/body/#app { height: 100% }` 的 flex 列。键盘一弹:
Android Chrome(108+)默认 `resizes-visual` —— 只缩视觉视口,布局视口不变,输入框被盖住;
iOS Safari 布局视口根本不动,只能自己量。

- `index.html` 的 viewport 加 `interactive-widget=resizes-content`:让 Android 连**布局**一起缩
  (`height:100%` 自然变矮);
- `keyboardInset.ts`:量 `innerHeight - visualViewport.height - offsetTop` 写进 `--kb-inset`
  (iOS / 旧 Chrome 的兜底),`.app` 高度是 `calc(100% - var(--kb-inset, 0px))`;
  两条路**叠加安全** —— 上了 `resizes-content` 后 innerHeight 一起缩,差额算出来就是 0;
- `.kb-open` 时 composer 去掉 `env(safe-area-inset-bottom)`(键盘顶掉了 home indicator 那条);
- 聚焦 composer / 提问卡片输入框后 320ms:`scrollIntoView({block:'nearest'})` + 列表回底。

**实测(模拟器 api35,`show_ime_with_hard_keyboard=1`,CDP 发真触摸点输入框)**:
`innerHeight` 762 → **450**,`.app` 高度 450,composer 底边 450 = 可见区底边 —— 输入框正好落在键盘上方。

⚠️ 验的时候踩到一个前提:**会话没有控制通道时 composer 是 `disabled` 的,点不出键盘**,
所以要用提问卡片里的输入框(或一个有 pi 的会话)来验。
数学部分抽成 `keyboardInsetOf()` 纯函数,`tests/terminalRemoteChat.test.ts` 里 5 个用例
(没开 / resizes-content / iOS 偏移 / 工具栏收起 / 怪异输入)。

### 21.8 对话页状态栏:模型 / 上下文 / 输入输出(2026-10-16)

缺口盘点的第 10 条(当时没列):手机上能看对话,但看不到「用的哪个模型、还剩多少上下文」。

数据全在 pi 的扩展 API 里,不用新端点、不用新连接、更不解析 TUI 屏幕:

| 要显示 | 来源 |
| --- | --- |
| 模型 / 思考等级 | `ctx.model.id`、`ctx.thinkingLevel`;切换时 `model_select` / `thinking_level_select` 事件 |
| 上下文数量与百分比 | `ctx.getContextUsage()` → `{ tokens, contextWindow }`(compact 后 `tokens` 为 `null`) |
| 输入输出 token | 遍历 `ctx.sessionManager.getEntries()` 累加 `usage`(assistant + toolResult + `usage` 条目 + compaction/分支摘要)—— 与 pi 桌面 footer 同一套口径 |

协议只加两种帧,走现有那条 WS:

```
扩展 ──{type:'snapshot', …, status?} / {type:'status', status}──▶ PiChatHub(校验+缓存)
      ──{t:'chat', …, status?} / {t:'chat-status', id, status}──▶ 手机状态条
```

- **百分比不在线上传**:两端拿同一对 `(contextTokens, contextWindow)` 各算一次,少一个要校验的字段;
- **缓存在服务端**(进 `ChatState`):手机切走再切回、重连都不用等 pi 再喊一次;
- 扩展侧按 `JSON.stringify` 去重,数字没变就不发;
- 触发点:`onopen`(随快照)、`session_start`、`agent_settled`、`message_end`(仅 assistant —— 工具结果也去遍历整会话没必要)、
  `model_select`、`thinking_level_select`;`session_compact` / `session_tree` 由既有的大快照覆盖;
- 手机上:`模型 · ↑12k ↓3.4k · 38.2%/200k`,11px mono 一行贴在 header 下面,超长模型名省略号;
  `?` 表示 token 未知,>70% 黄、>90% 红(与桌面同一组阈值)。

**踩到的坑**:`ChatView` 里早有一个 `const status = computed(...)`(头部徽标文字),
新加的 `status` prop 在模板里被它遮住了 —— 表现是状态条**永远显示**,而且 `↑NaN ↓NaN`。
徽标那个 computed 改名 `statusLabel`,模板里两个名字各归各位。

**明确不做**(与 §21.2 一致):手机上切模型 / 切思考档 / 手动 compact;成本 `$0.042`;
缓存读写 `R`/`W`(那一行在手机上放不下,输入输出保留的是与桌面同口径的数字)。

验证:`test:pi:chat` 11 项(真 pi:快照带模型名与窗口、跑完一轮后收到带 `input>0 && output>0` 的 status);
`test:e2e:remote` 49 项(无 status 时不占位、模型名+`12k`/`3.4k`、`38.2%/200k`、95% 变红、`?/200k`);
vitest 1528(新增 `sanitizeStatus` 夹取/拒绝、status 广播+进快照、snapshot 带 status 三例)。
