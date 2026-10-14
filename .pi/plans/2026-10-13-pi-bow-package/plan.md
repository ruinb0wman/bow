# 方案:把 pi 侧集成抽成 `packages/pi-bow`(子包 + MCP 自动注册 + skill + /bow 命令)

> 日期:2026-10-13 · 模式:plan(只读调研产出,**未改任何源码**)
> 已定决策(2026-10-13 用户确认):① 位置 = bow 仓库内子包 ② 范围 = 状态桥 + MCP 注册 + skill + `/bow` ③ 保留设置页一键接入,源改指包内(不生成副本) ④ MCP 走 HTTP 默认端点 + 可达性探测 ⑤ skill 搬进包

## 0. 现状(读码结论)

pi 状态联动**不在终端插件里**,分三层:

| 层 | 文件 | 能否搬走 |
| --- | --- | --- |
| pi 进程内(真正的 pi 扩展) | `integrations/pi/bow-agent-state.ts`(147 行,零 bow 依赖,只 import pi 类型) | ✅ 搬进包 |
| bow 主进程 | `src/shared/agentState.ts`(OSC 解析/角标映射/通知文案)、`src/main/agentNotify.ts`(状态+定时器)、`src/main/systemNotify.ts`(Electron Notification) | ❌ 必须留 |
| bow 终端插件 | `src/plugins/terminal/{shared,main}.ts`(注入 `BOW_TERMINAL=1` + WSLENV;每会话 `OscSignalParser` → `service.agent.report`) | ❌ 必须留 |
| 安装器(重复实现 ×2) | `scripts/install-pi-agent-state.mjs`(命令行)、`src/plugins/terminal/piBridge.ts` + `ui/TerminalSettings.vue`(打包应用一键接入) | 规则同一份,源指向包 |
| bow 的 MCP「安装」 | `scripts/install-pi-mcp.mjs`(写 `~/.pi/agent/mcp.json` + 拷 `bow-browser` skill),无 UI | 被包内 `registerMcpServer` 取代(脚本保留给非 pi 客户端) |

协议(不变,包里只复制常量):`\x1b]1337;bow;<JSON>\x07`, `SIGNAL_VERSION = 1`, `state ∈ {working, blocked, idle}`,门禁 `BOW_TERMINAL === '1'`。常量源:`src/shared/agentState.ts`(`BOW_OSC_CODE=1337` / `BOW_OSC_KEY='bow'` / `BOW_SIGNAL_VERSION=1` / `BOW_OSC_PREFIX`)。

## 1. 目标形态

```
packages/pi-bow/
├─ package.json          name: pi-bow; keywords: ["pi-package"]
│                        pi: { extensions: ["./extensions/*.ts"], skills: ["./skills"] }
│                        peerDependencies: { "@earendil-works/pi-coding-agent": "*" }
├─ extensions/
│  ├─ agent-state.ts     ← 原 integrations/pi/bow-agent-state.ts 原样搬(保留 `managed by bow` 标记)
│  ├─ bow-mcp.ts         ← pi.registerMcpServer('browser', …) + 可达性探测 + 能力探测
│  └─ bow-command.ts     ← /bow [status|on|off|reload]
├─ src/
│  ├─ protocol.ts        OSC 前缀 / SIGNAL_VERSION / BOW_TERMINAL 键(= 协议唯一权威,与 bow 侧交叉测试)
│  └─ mcp-config.ts      env 解析 + 端口探测(纯逻辑,可单测)
├─ skills/bow-browser/SKILL.md   ← 从 bow 的 .pi/skills/ 搬(该目录随之删除)
├─ tests/{protocol,mcp-config}.test.ts   ← 由 bow 的 vitest 收(vitest.config 的 include 里加一条)
└─ README.md             协议 v1 表 + 安装/迁移/排查
```

- 装法(开发/个人,本机现状):`pi install ~/Workspace/bow/packages/pi-bow`
  - 本地路径 = 不复制,改了 `/reload` 即生效。
  - ⚠️ pi **不支持 git 源的子目录**,所以子包只有「本地路径」或「npm publish」两条路;v1 只承诺本地路径,发布留给以后。
- 单一真相源:`packages/pi-bow/extensions/agent-state.ts` **是唯一副本**。bow 的「一键接入」直接读它(见 §2),**没有生成副本、没有同步脚本**。

## 2. 源的定位切换(替代「同步生成副本」)

| 位置 | 旧 | 新 |
| --- | --- | --- |
| `src/plugins/terminal/piBridge.ts` | `PI_BRIDGE_SOURCE_REL = ['integrations','pi',PI_BRIDGE_FILENAME]` | `['packages','pi-bow','extensions','agent-state.ts']` |
| `package.json build.files` | `"integrations/**/*"` | `"packages/pi-bow/extensions/**/*"` |
| `scripts/install-pi-agent-state.mjs` | `join(root,'integrations','pi','bow-agent-state.ts')` | `join(root,'packages','pi-bow','extensions','agent-state.ts')` |
| `integrations/` 目录 | 存在 | **删除**(`git rm -r integrations`) |

不变的:`PI_BRIDGE_FILENAME = 'bow-agent-state.ts'`、`PI_BRIDGE_MARKER = 'managed by bow'`(扩展文件里那行注释仍在)、安装到 `~/.pi/agent/extensions/bow-agent-state.ts` 的行为、拒写别人的文件/幂等/卸载、WSL hint(`windowsPathToWsl` + `wslHint`)。
→ 一键接入装上的是**包内那个文件的副本**,不是 `pi install` 的注册;两者等价但**不要同时用**(见 §7)。

## 3. `extensions/bow-mcp.ts`

```ts
// 形态说明(实现时按 pi 类型落)
export default function bowMcp(pi: ExtensionAPI) {
  if (typeof pi.registerMcpServer !== 'function') return   // 老 pi:静默降级(只有状态桥)
  const cfg = readConfig(process.env)                      // src/mcp-config.ts
  if (!cfg.enabled) return
  if (!(await reachable(cfg.url, 400))) return             // 连不上就不注册,不刷错误
  pi.registerMcpServer('browser', {
    url: cfg.url,
    ...(cfg.token ? { headers: { Authorization: `Bearer ${cfg.token}` } } : {}),
    description: '本地 bow 浏览器(Electron 多标签)的 MCP 服务器;操作对用户实时可见',
    toolExposure: { browser_navigate:'direct', browser_snapshot:'direct', browser_read:'direct',
                    browser_wait:'direct', browser_click:'direct', browser_eval:'direct' }
  })
}
```

配置(`src/mcp-config.ts`),默认值即当前 `~/.pi/agent/mcp.json` 的内容:

| env | 默认 | 说明 |
| --- | --- | --- |
| `BOW_MCP_URL` | `http://127.0.0.1:8765/mcp` | WSL 非 mirrored / 改过端口时用它 |
| `BOW_MCP_TOKEN` | 空 | bow 的 mcp-http 设了令牌时才需要 |
| `BOW_MCP` | `1` | `0` = 本次会话完全不注册(等价 `/bow off`) |

要点与理由:

- **探测用 `net.connect(host, port)`**(或 `fetch` 带超时后兼容 405/406),`/mcp` 是 streamable HTTP,`HEAD` 不一定被接受;超时 ~400ms。
- **async 工厂**:pi 会等工厂返回再启动,所以「探测完再决定注册」不会导致连接错误刷屏;探测失败不阻塞会话。
- **注册时机**:工厂内注册 → `session_start` 时与 `mcp.json` 服务器一起连接。
- **优先级**:`mcp.json` 同名 `browser` 条目**优先于**扩展注册(`/mcp` 里会显示被覆盖)。所以已装过的机器行为不变,迁移时删掉该条目才由包接管(§7)。
- **不做** stdio 注册(路径敏感:打包版/仓库/WSL 三套),需要时由 `BOW_MCP_URL` 指 HTTP。
- **不读 bow 的配置文件**(WSL 双系统下路径是雷);令牌/端口只从 env 来。

## 4. `extensions/bow-command.ts`

| 命令 | 行为 |
| --- | --- |
| `/bow` | 打印:插件版本 / MCP 注册状态(已注册·被 mcp.json 覆盖·未注册) / URL / 可达性 / 错误；旧扩展文件是否并存(`existsSync(~/.pi/agent/extensions/bow-agent-state.ts)`) |
| `/bow on` | 本次会话注册(`registerMcpServer`) |
| `/bow off` | `unregisterMcpServer('browser')`(仅扩展注册;mcp.json 的条目不受影响) |
| `/bow reload` | 重新探测 + 重注册 |

用 `ctx.ui.notify` 输出；排查「为什么连不上」一条命令搞定。

## 5. skill

`.pi/skills/bow-browser/SKILL.md` → `packages/pi-bow/skills/bow-browser/SKILL.md`,bow 仓库的那个目录删除。
`SKILL.md` 顶部补一句:「本文件随包分发;bow 的工具面变化时改**这里**,不要再在 bow 仓库里建副本」。
理由:它描述的是 bow 的 MCP 工具面(50 个工具、插件启停),跟 pi 包一起发更合理;同仓库改动成本低。

## 6. bow 侧逐文件改动

| 文件 | 改动 |
| --- | --- |
| `package.json` | `build.files`:`integrations/**/*` → `packages/pi-bow/extensions/**/*`;新增 `"pi:sync"`(不需要了)/`"pi:install-status"` 路径不变;可选加 `"pi:install-plugin": "pi install ./packages/pi-bow"`(方便文档引用) |
| `src/plugins/terminal/piBridge.ts` | `PI_BRIDGE_SOURCE_REL` 改指包路径;**文件头注释**里的 `app.getAppPath()/integrations/…` 同步改 |
| `src/plugins/terminal/shared.ts` | 注释里两处 `integrations/pi/bow-agent-state.ts` 的引用改路径;`PiBridgeStatus.source` 的注释同改 |
| `src/plugins/terminal/main.ts` | 第 408 行附近的来源注释改路径 |
| `src/plugins/terminal/ui/TerminalSettings.vue` | 文案补一句「若已用 `pi install packages/pi-bow`,不必再点这里(二选一)」 |
| `scripts/install-pi-agent-state.mjs` | 源路径 + 文件头注释里的用法示例路径 |
| `scripts/e2e-agent-status.mjs` | 第 55 行注释里的 `integrations` 说法 + 第 398 行「源码能从 asar 读到」的判据路径 |
| `tests/piBridge.test.ts` | 假 `appPath` 下的 `integrations/pi/` → `packages/pi-bow/extensions/`(5 处) |
| `tests/piBridgeExtension.test.ts` | 重写判据:①源存在且含 marker ②`PI_BRIDGE_FILENAME` 一致 ③包内 `src/protocol.ts` 与 `@shared/agentState` 的 OSC 前缀/v/key 一致 ④`build.files` 含 `packages/pi-bow/extensions/**/*` ⑤包 manifest 的 `pi.extensions` 指向它 |
| `tests/terminalShared.test.ts:148` | 注释路径 |
| `vitest.config.ts` | `include: ['tests/**/*.test.ts', 'packages/pi-bow/tests/**/*.test.ts']` |
| `tsconfig.node.json` | **不**加包(包 import 的是 pi 类型);包自身不参与 bow 的 `tsc --noEmit` |
| `.gitignore` | 无变化(包不是构建产物) |
| `README.md` | 终端/MCP 两节:新增 `pi install ./packages/pi-bow` 的用法、`/bow`、迁移;562/572/1025/1079 行的 `integrations/...` 路径改掉 |
| `docs/ARCHITECTURE.md` | 126(目录地图)、1057(`BOW_TERMINAL` 消费方路径)、1101(脚本与一键接入的源路径)、1259(块注释里写 `**/` 的坑——条目里引用的 `integrations/**/*` 换成新路径) |

**不动**:`src/shared/agentState.ts`、`src/main/agentNotify.ts`、`src/main/systemNotify.ts`、终端插件的解析与 env 注入、`scripts/install-pi-mcp.mjs`(保留给非 pi 客户端;README 里注明 pi 用户改走包)。

## 7. 迁移(已装过的机器)

1. `pi install ~/Workspace/bow/packages/pi-bow`
2. 删 `~/.pi/agent/extensions/bow-agent-state.ts`(否则**双份扩展并存**:同一 pi 进程里两个扩展各自去重表 → 每次状态变化重复一条;bow 侧对同状态幂等,只是噪音)。包内 `agent-state.ts` 加载时 `existsSync` 该路径 → 一次性 `stderr` 警告。
3. 可选:从 `~/.pi/agent/mcp.json` 删 `browser` 条目(不删也工作,它优先)。
4. WSL:包必须装在**跑 pi 的那个系统**里;`BOW_MCP_URL` 处理非 mirrored 网络。
5. bow 设置页一键接入保留,适合同一台机器、不想用 `pi install` 的场景。

## 8. 实施阶段(每步可独立验证)

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| A | 建 `packages/pi-bow` 骨架;搬 `agent-state.ts`;写 `src/protocol.ts` + 交叉测试 | `pi -e ./packages/pi-bow` 在 bow 终端跑长任务:角标 + 系统通知照旧;`npm test -- piBridgeExtension protocol` |
| B | `bow-mcp.ts` + `mcp-config.ts` + 探测单测 | 临时把 `mcp.json` 的 `browser` 改名 → `/mcp` 显示来源=扩展、`browser_read` 可用;bow 未启动时 pi 启动无错误刷屏 |
| C | `bow-command.ts` | `/bow`、`/bow off`、`/bow reload` 输出正确 |
| D | 搬 skill,删 bow 的 `.pi/skills/bow-browser/` | `/skill:bow-browser` 可加载 |
| E | bow 侧路径切换(§2)+ 测试重写 + 文档 | `npm run typecheck && npm test`;`npm run dist` 后产物内 `/packages/pi-bow/extensions/agent-state.ts` 存在(可用 `scripts/verify-dist.mjs` 的手法解析 asar);`npm run test:e2e:agent` 仍全绿(它不依赖真扩展) |
| F | 文案 + 迁移 + README/ARCHITECTURE + 本机实测 | 按 §7 在本机走一遍;记 memory |

## 9. 风险

| 风险 | 对策 |
| --- | --- |
| `packages/**` 被 vite/electron-builder 误收 | `build.files` 是白名单;`electron.vite.config.ts` 只按 entry 打包;E 阶段做产物断言 |
| vitest 扫到包内测试(或反之漏掉) | 显式加 include 一条 |
| 双份扩展重复发信号 | 加载时 `existsSync` 警告 + §7 迁移文档 |
| `registerMcpServer` 被别的 MCP 扩展接管(如 pi-mcp-adapter)→ 注册被报成扩展错误 | 能力探测(`typeof … === 'function'`)+ `/bow` 里说明;注册失败不 throw 到会话 |
| 探测增加启动延迟 | 超时 400ms 封顶;失败不阻塞 |
| pi 版本下限(`registerMcpServer` 较新才有一说一) | 用能力探测,老 pi 上退化成「只有状态桥」,不报错 |
| 包 README 与 pi 语法漂移 | bow 的 docs 只链接包 README,不复制协议表 |
| WSL 双系统装错侧 | README + 设置页已有的 WSL hint 保持不变 |

## 10. 明确不做

- 不改 OSC 协议(v1 原样);不搬 bow 侧解析/角标/通知。
- 不做 bow→pi 方向。
- 不做 npm 发布流程、不支持 git 子目录安装。
- 不把 `packages/pi-bow` 纳入 bow 的 `tsc --noEmit`。
- 不删 `scripts/install-pi-mcp.mjs`(非 pi 客户端仍需要)。

---

## 11. 执行记录(2026-10-13,已实现)

按 §8 的 A→E 做完了(阶段 F 的「本机迁移」留给你确认后再做,因为它会动 `~/.pi/agent/`)。

**实际新增**

| 文件 | 内容 |
| --- | --- |
| `packages/pi-bow/package.json` | `pi` manifest(`extensions` / `skills`)、`keywords: ["pi-package"]`、peer = pi 包 |
| `packages/pi-bow/extensions/bow-agent-state.ts` | 状态桥(原 `integrations/pi/bow-agent-state.ts` 搬来,内容未变 + 自包含说明) |
| `packages/pi-bow/extensions/bow-mcp.ts` | 工厂:探测 + `pi.registerMcpServer('browser', …)` |
| `packages/pi-bow/extensions/bow-command.ts` | `/bow [status\|on\|off\|reload]` |
| `packages/pi-bow/src/bow-mcp.ts` | 配置解析、HTTP 探测、注册/注销、`mcp.json` 覆盖检测、`/bow` 文案(纯逻辑可测) |
| `packages/pi-bow/skills/bow-browser/SKILL.md` | 从 `.pi/skills/` 搬来(唯一的 skill 副本) |
| `packages/pi-bow/README.md` | 装法、env 配置、协议表、自包含约束 |
| `packages/pi-bow/tests/{bow-agent-state,bow-mcp}.test.ts` | 23 条:**pi 侧状态机此前完全没有测试**;另有配置/探测/注册分派/文案/与安装脚本一致 |

**实际修改**:`src/plugins/terminal/piBridge.ts`(源路径 + 注释)、`scripts/install-pi-agent-state.mjs`(源路径)、
`scripts/install-pi-mcp.mjs`(skill 源 → 包内)、`package.json`(`build.files` + `pi:install-plugin`)、
`vitest.config.ts`(收包内测试)、`tests/{piBridge,piBridgeExtension,terminalShared}.test.ts`、
`src/plugins/terminal/{main,shared}.ts` 与 `scripts/e2e-agent-status.mjs` 的注释、`README.md`、`docs/ARCHITECTURE.md`。
`integrations/` 目录已删除。

**与计划的五处偏离(都是有意的)**

1. **没有 `src/protocol.ts`**:`bow-agent-state.ts` 必须**自包含**(一键接入会把**单个文件**复制进 pi 的扩展目录,
   相对导入会在那里找不到)。常量留在文件里,「与 bow 侧逐字一致」由 `tests/piBridgeExtension.test.ts` 钉住,
   并加了一条「扩展只能 import `node:` 与 pi 类型」的不变式测试。
2. **包内文件名是 `bow-agent-state.ts`**(计划里写的是 `agent-state.ts`):与 `bow-mcp.ts` / `bow-command.ts` 齐,
   而且**源名 == 安装后的目标名**,`PI_BRIDGE_SOURCE_REL` 继续复用 `PI_BRIDGE_FILENAME`。
3. **探测从 TCP connect 改成 HTTP 探测**:实测这台机器(有 TUN/代理)连一个刚释放的空闲端口**也「连接成功」**,
   TCP 连上不等于有服务 —— 原方案会让探测永远为真。现在发 `GET`(刻意只 `Accept: application/json`),
   活着的 MCP 端点会立刻回 `406`(不会挂成 SSE 长流),200 还要求 content-type 像 JSON。
4. **`build.files` 只收 `bow-agent-state.ts` 一个文件**:另外两个扩展只有 pi 会加载,把半个包打进产物没意义。
5. **skill 与包同批搬**(计划排在 D 阶段):顺手把 `install-pi-mcp.mjs` 的 skill 源指到包里,不留第二份副本。

**验证(全部实跑)**

- `npm run typecheck` 干净;`npm test` **1434 passed**(包内新增 23 条)。
- 用 **pi 自己的加载器(jiti)** 真加载三个扩展:全部成功,假 pi 上看到 `on:session_start…on:session_shutdown`、
  `mcp:browser:http://127.0.0.1:8765/mcp`、`cmd:/bow`(探测真的连上了本机在跑的 bow)。
- `npm run dist` → 解析 `app.asar` 确认条目 `/packages/pi-bow/extensions/bow-agent-state.ts`(旧 `integrations` 已无)。
- `npm run test:e2e:agent` 开发产物 **全绿**;`BOW_E2E_BIN=dist/linux-unpacked/bow` 打包版 **全绿**
  (含「源码能从 asar 读到」与设置页一键接入的装/卸)。
- `node scripts/install-pi-mcp.mjs --dry-run` 仍能找到 skill 源;`install-pi-agent-state.mjs --print/--dry-run` 指向新路径。
