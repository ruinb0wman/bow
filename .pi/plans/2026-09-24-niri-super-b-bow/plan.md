# niri:Super+B 改为启动 bow

## 0. 目标与已确认决策

**目标**:把 niri 里 `Super+B` 的启动目标从 firefox 换成 bow(打包二进制),不用 shell、不建包装脚本。

已确认(用户选择):

| 决策点 | 结论 |
| --- | --- |
| 键位 | **替换** `Mod+B`;**firefox 键位直接删除**(不再绑别的键) |
| 启动产物 | `dist/linux-unpacked/bow`(打包二进制,直接 exec) |
| 命令写法 | 绝对路径写进 keybinds.kdl,不建 `~/.local/bin/bow` |
| 窗口规则 | 不加,niri 默认平铺 |

**假设**:`Mod` 在 niri 默认就是 Super(配置里没有 `mod-key` 覆盖,已确认 `cfg/input.kdl` 无该键)。firefox 之后仍可从 noctalia launcher(`Mod+CTRL+Return`)启动。

## 1. 现状(已读到的真实代码)

- `/home/ruinb0w/.config/niri/config.kdl` 只有 8 行 `include`,其中 `include "./cfg/keybinds.kdl"`。
- `/home/ruinb0w/.config/niri/cfg/keybinds.kdl:11-13`:

```kdl
    // ─── Applications ───
    Mod+Return                          hotkey-overlay-title="Open Terminal: Alacritty" { spawn "alacritty"; }
    Mod+B                               hotkey-overlay-title="Open Browser: firefox" { spawn "firefox"; }
```

- 全仓 grep `Mod+B|Shift+B|Alt+B` 只有这一处 → `Mod+Shift+B` 等位置空闲,但本次不用。
- `cfg/rules.kdl` 里没有任何 bow / browser 相关 window-rule(只有 noctalia、steam 和两条全局 rule)→ 无需清理。
- 可执行文件确实存在且可执行:
  `-rwxr-xr-x 228MB 9月24日 17:38 /home/ruinb0w/Workspace/bow/dist/linux-unpacked/bow`
  (路径无空格,`spawn` 不需要引号转义)
- bow 侧行为(供判断,不改代码):
  - `src/main/index.ts:79-92`:单实例锁失败 → 已运行实例触发 `second-instance` → **开一个新窗口**。所以「重复按 Super+B = 多开窗口」是既有语义,不是 bug。
  - `src/main/index.ts:265-278`:HTTP MCP 端点由内置插件 `mcp-http`(默认开启,`plugins.json` 不存在即启用)拉起 → **普通启动就已经有 `http://127.0.0.1:8765/mcp`**,不需要 `MCP_HTTP=1`。
- `~/.local/share/applications/bow.desktop` 里 `Exec=/home/ruinb0w/Workspace/bow/dist/linux-unpacked/bow` 与本方案指向同一份产物,不需要改。

## 2. 要改的文件(只有 1 个)

`/home/ruinb0w/.config/niri/cfg/keybinds.kdl`(工作区之外,写它需要授权)

把第 13 行:

```kdl
    Mod+B                               hotkey-overlay-title="Open Browser: firefox" { spawn "firefox"; }
```

改为:

```kdl
    Mod+B                               hotkey-overlay-title="Open Browser: bow" { spawn "/home/ruinb0w/Workspace/bow/dist/linux-unpacked/bow"; }
```

用 `spawn`(不是 `spawn-sh`):niri 的 `spawn` 不经 shell,直接 exec 该路径,不依赖 PATH、不受 shell 解析影响。

## 3. 有序步骤

1. **备份** —— `cp ~/.config/niri/cfg/keybinds.kdl /tmp/keybinds.kdl.bak-20260924`
   (备份放 `/tmp` 而不是 `cfg/` 旁边:避免 niri 的 include 通配以后误收)
2. **改前基线校验** —— `niri validate -c /home/ruinb0w/.config/niri/config.kdl`
   先确认当前配置本身是干净的(退出码 0),否则后面的报错无法归因。
   (若该命令参数形式不对,先看 `niri --help` / `niri validate --help`。)
3. **原子写入** —— 生成 `/tmp/keybinds.kdl.new`(内容 = 原文件第 13 行换成上面那行),再 `mv /tmp/keybinds.kdl.new ~/.config/niri/cfg/keybinds.kdl`
   理由:niri 会 watch 配置文件并自动热重载;原地半写状态可能被读到。同目录 `mv` 是原子替换。
4. **改后校验** —— 再跑一次 `niri validate -c /home/ruinb0w/.config/niri/config.kdl`,退出码 0。
   niri 在此期间会自动重载配置(不需要 `niri msg action reload-config`)。
5. **功能验证(人工)** —— 按一次 `Super+B`:
   - 期望:bow 窗口出现(平铺,落在当前 workspace)。
   - 已开着 bow 时再按:现有实例**新开一个窗口**,不重启、不丢标签。
   - 辅助确认:`niri msg --json windows` 里应出现 `app_id: "com.ruinb0w.bow"`
     (`app.setDesktopName('com.ruinb0w.bow')`,见 `src/main/ua.ts:13`)。
6. **回滚** —— 真出问题(hot reload 报错 / 按 Super+B 无反应且 `niri validate` 对着新文件报错):
   `cp /tmp/keybinds.kdl.bak-20260924 ~/.config/niri/cfg/keybinds.kdl` → 再 `niri validate -c ...`。

每步只碰 `~/.config/niri/cfg/keybinds.kdl` 一个文件,可独立验证。

## 3.5 实施与验证记录（2026-09-24 已完成）

改动落地：`cfg/keybinds.kdl:13` 替换（`diff` 与本计划第 2 节逐字一致，只有这一行变）。备份留在 `/tmp/keybinds.kdl.bak-20260924`。

| 检查 | 手段 | 结果 |
| --- | --- | --- |
| 语法 | `niri validate -c ~/.config/niri/config.kdl`（改前 / 改后各一次） | `config is valid`，exit 0 / 0 |
| **热重载真的生效**（live 合成器，不只是文件合法） | `journalctl --user -b`：`17:46:00.436 albedo niri[1009]: DEBUG niri_config: loaded config from "…/config.kdl"` —— 正是 `mv` 覆盖（09:46:00 UTC）之后由 inotify 触发的重载；其后再无 niri error/warn | ✅ |
| 键位命令真能起 bow | `niri msg action spawn -- /home/ruinb0w/Workspace/bow/dist/linux-unpacked/bow`（与键位同一条 argv、同一个 niri spawn 代码路径）→ `niri msg --json windows` 出现新窗口 `id=118 app_id=com.ruinb0w.bow`（原有实例 pid 60214 的 112/113 不动）⇒ 重复启动 = 现有实例新开窗口 | ✅ |
| 桌面复原 | `niri msg action close-window --id 118` | 剩余 112/113，无残留 |
| 键位分发（按下 Super+B → 动作） | 无 `wtype`/`ydotool` 可用 ⇒ **无法合成按键**；试过 `niri msg action show-hotkey-overlay`（exit 0）但两次截屏里都没看到浮层 ⇒ 该路无法作证据 | ⚠️ 只能由用户按一次 |

## 4. 风险 / 未知

1. **路径写死**:以后若 `rm -rf dist`、改装 AppImage、或仓库搬家,这一行会失效。重新 `npm run dist` 后 `dist/linux-unpacked/bow` 路径不变,不需要改配置。
2. **`~/.local/share/applications/bow.desktop` 缺 `StartupWMClass=com.ruinb0w.bow` 且基名是 `bow`**(不是 `com.ruinb0w.bow`):niri 按 `app_id` 找 `.desktop` 拿图标/分组,可能会找不到图标。这是本次改动之前就有的现象,**与键位无关**,本方案不动它。
3. **userData 共用**:打包版和 `npm run dev` 都写 `~/.config/mcp-browser`,共用同一把单实例锁。若 dev 实例正在跑,按 Super+B 只会让 **dev 实例**开新窗口(不会起打包版)。当前该目录里残留 `SingletonLock -> albedo-60214` / `SingletonSocket -> /tmp/scoped_dirdwYcmX/...`(`npm run test:mcp` 冒烟测试留下的)。若按 Super+B「毫无反应」,先确认是不是这个锁被别的 bow 实例持有。
4. **没有「聚焦已有窗口」语义**:niri 键位只能 spawn。要做到「首次开、之后聚焦」得写脚本(用 `niri msg --json windows` 匹配 `app_id` + `niri msg action focus-window`)并改用 `spawn-sh`,本次不做。
5. **未能在计划阶段验证的**:niri 热重载对**第 13 行替换**的实际行为(按经验会即时生效;memory 里 2026-09-24 那次改 layout 确认过自动重载)。`niri validate` 的确切 CLI 参数形式也只按既有经验("已用 niri validate 逐个确认")假定为 `-c <file>`,执行时先看 `--help`。
6. **写工作区外文件需要授权**:build 模式对 `~/.config/niri/...` 的写入会走 external-directory 授权提示,属预期。
