# pi-bow

在 [pi](https://pi.dev) 里接入本地 [bow](../../) 浏览器的插件包。装一次拿到四件事:

| 能力 | 扩展 | 依赖 |
| --- | --- | --- |
| 终端里的 pi 把「正在执行 / 等待确认 / 已完成」写成 OSC,bow 的终端标签显示角标、弹系统通知 | `extensions/bow-agent-state.ts` | 只在 bow 的终端里工作(`BOW_TERMINAL=1` 门禁) |
| bow 的 MCP 服务器注册进 pi(不用改 `mcp.json`、不用重启) | `extensions/bow-mcp.ts` | bow 正在跑(HTTP 端点可达) |
| `/bow` 命令:看注册状态、临时开/关、重连 | `extensions/bow-command.ts` | — |
| 能力索引 skill(工具的选型表与反模式) | `skills/bow-browser/SKILL.md` | — |

## 安装

```bash
pi install <bow 仓库>/packages/pi-bow     # 本机:`pi install ~/Workspace/bow/packages/pi-bow`
```

本地路径 = **不复制**、从仓库直接加载,改了 `/reload` 即生效。pi 不支持 git 源的子目录,所以没有「一行从 GitHub 装」的形态;要发布就 `npm publish` 这个目录。

不想整包装:`bow 设置页 → 终端 → Pi 联动 → 安装` 会把 `extensions/bow-agent-state.ts` 单独复制进 pi 的扩展目录(离线可用)。**两种方式二选一** —— 同时用会让同一个 pi 进程里有两个扩展都发 OSC,状态变化会重复上报一遍(bow 侧幂等,只是噪音)。

## 配置(bow MCP 注册)

默认连 `http://127.0.0.1:8765/mcp`(bow 的 `mcp-http` 插件默认开启)。用环境变量覆盖:

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `BOW_MCP_URL` | `http://127.0.0.1:8765/mcp` | 改过端口,或 pi 在 WSL、bow 在 Windows 且网络不是 mirrored 时 |
| `BOW_MCP_TOKEN` | 空 | bow 的 mcp-http 设了令牌时才需要 |
| `BOW_MCP` | `1` | `0` = 本次会话完全不注册(等价 `/bow off`) |

探测不到端口时**不注册**(也不会报错),用 `/bow` 看状态、`/bow reload` 重试。若 `mcp.json` 里已有同名 `browser` 条目,它**优先于**本包的注册(迁移时删掉那条,改由本包负责)。

## 协议

`extensions/bow-agent-state.ts` 与 bow 之间唯一的耦合,是这条控制序列:

```
ESC ] 1337 ; bow ; {"v":1,"state":"blocked","title":"…","text":"…"} BEL
```

| 字段 | 说明 |
| --- | --- |
| `v` | `1`;bow 丢弃不认识的版本 |
| `state` | `working` \| `blocked` \| `idle`(三态;完成与否由 `done` 表示) |
| `done` | 仅随 `idle` 出现:这一轮真的跑完了(区别于「本来就没跑」) |
| `agent` | 固定 `pi` |
| `title` / `text` | 对话框标题 / 会话标签 |

权威定义(bow 侧的解析与角标规则)在仓库的 `src/shared/agentState.ts`;两边的一致性由 `tests/piBridgeExtension.test.ts` 钉住。

## 约束(改这个包之前先看)

- **`extensions/bow-agent-state.ts` 必须自包含**:它会被单独复制进 `~/.pi/agent/extensions/`,只能 import `node:` 内建与 pi 的类型。`tests/piBridgeExtension.test.ts` 会检查这一点。
- 若只是要改状态机,别在 bow 的终端插件里找 —— 那边只负责解析 OSC 与画角标。
