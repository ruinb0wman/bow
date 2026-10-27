# 异地访问 bow(手机看/回 pi)· Tailscale 方案

日期:2026-10-27 · 状态:采用 · 取代原计划的 Cloudflare 隧道(S9–S11)

## 1. 这套方案解决什么

你在外面(4G / 别人家 Wi-Fi),用手机浏览器打开 bow 的远程页,看到**会话列表**,点进去**对话**:
发消息、插话、停止、答 pi 的提问、翻历史、用 `/` 命令 —— 和电脑上那套是同一份会话台账。

**不是**端口转发、**不是**公网暴露:手机和 PC 先在 WireGuard 层组成一个私有网,tailnet 之外的人根本
连不到那个端口。

## 2. 拓扑

```
手机(bow 远程页 / PWA)
   │  WireGuard(100.64.0.0/10,DERP 中继兜底)
   ▼
Windows: tailscaled  ← 一份,装在这里
   │  mirrored 模式下 Windows 与 WSL2 共用 127.0.0.1
   ▼
WSL2 里的 bow:8770  (/  /healthz  /login  /api/sessions  /ws)
   │  会话台账 + WS 扇出
   ▼
pty 里的 pi(扩展用本会话令牌连 /ws?role=pi)
```

关键点:**Tailscale 只装 Windows 侧**。理由见 `docs/ARCHITECTURE.md` 之外的三条:

1. mirrored 模式下 Windows 与 WSL2 的 `127.0.0.1` 双向通 → 不必做端口转发;
2. Tailscale 官方把「装在 WSL2 里」标为 advanced concept,还挂着 MTU 的已知 issue;
3. Windows 防火墙规则会自动套到 WSL(Win11 22H2 + WSL 2.0.9 起)→ 只在一处放行。

## 3. 一次性搭建

### 3.1 Windows 装 Tailscale

```powershell
winget install --id Tailscale.Tailscale -e   # 或官网 msi
```

托盘登录(同一个账号后面手机也用)。登录后 `100.64.0.0/10` 就在 Windows 路由里了,**不改默认路由**,
所以你现有的 `127.0.0.1:7890` 代理照常工作。

### 3.2 关掉 WSL 里那份(本机此前装过)

```bash
sudo systemctl disable --now tailscaled   # 或 sudo apt remove tailscale
```

两份 tailscaled 各建一张 TUN、各推 MagicDNS,典型症状是解析变慢、时好时坏。

### 3.3 打开 bow 的远程服务

设置页 → 终端 → 远程控制:

| 项 | 填什么 |
| --- | --- |
| 启用 | 开 |
| 绑定 | **`lan`**(0.0.0.0) —— WSL 里的 pi 扩展要从 `/proc/net/route` 取网关连回来,`loopback` 下它会连不上 |
| 端口 | 默认 `8770`,被占就换(1024–65535) |
| 口令 | **必须设,长一点**。见 §6 |

绑 `lan` 后本机所有地址都能连,**但只有 tailnet 和局域网能到达它**。

### 3.4 先验证「Windows → WSL 的 8770」通不通

装 tailscale 之前就该跑这一步,它不通的话后面的链路白搭:

```powershell
# PowerShell 里 `curl` 是 Invoke-WebRequest 的别名(输出是对象表格),要写 curl.exe
curl.exe -s http://127.0.0.1:8770/healthz
# → {"ok":true,"service":"bow-terminal-remote","bind":"lan","sessions":3}
# 不用 curl 也行:Windows 浏览器开 http://127.0.0.1:8770 应出现登录界面
```

必须**在 Windows 里**跑:要验的就是「Windows → WSL」那一跳。在 WSL 里 curl 127.0.0.1 只能证明 bow 活着。
前提是设置页已经**启用**远程(否则没人监听)。`/healthz` 不鉴权,`bind` 与 `sessions` 会回显实际状态。

通 → 继续。不通 → 退路:直接对 LAN IP 建服务,`curl http://192.168.1.20:8770/healthz`
(mirrored 模式下 WSL 有真实 LAN IP;`192.168.1.20` 是本机 · 换机器看 `ip -4 addr`)。

✅ **本机已验(2026-10-27)**:`bind=lan` + Windows 侧 `curl.exe -s http://127.0.0.1:8770/healthz`
→ `{"ok":true,"service":"bow-terminal-remote","bind":"lan","sessions":2}`。
WSL2-mirrored 的 localhost 双向转发在本机成立,不用走 LAN IP 退路。

### 3.5 手机装 Tailscale 并登录

Android / iOS 商店搜 Tailscale,登录同一账号。**它会占掉系统唯一的 VPN 槽** —— 手机上跑着的
Clash / Surge / Shadowrocket 这类以 VPN 形式工作的代理要关掉(切着用)。

### 3.6 两种访问方式,选一个

**A. 直接连 IP(零配置,先跑通用这个)**

```
http://100.x.y.z:8770        # 100.x.y.z = Windows 那台的 tailnet IP(tailscale ip -4)
```

**B. HTTPS + 固定名字(推荐长期用)**

1. Tailscale admin console → DNS → 打开 **Enable HTTPS Certificates**;
2. Windows 上:
   ```powershell
   tailscale serve --bg 8770
   ```
3. 手机打开 `https://<机器名>.<tailnet>.ts.net`。

✅ **全链路已验(2026-10-27,除手机那一跳)**:
`tailscale serve status` → `https://<机器>.tail<id>.ts.net (tailnet only) |-- / proxy http://127.0.0.1:8770`;
Windows 侧 `curl.exe https://<机器>.tail<id>.ts.net/healthz` → `200` + `{"ok":true,...,"sessions":4}`,
首页 `200 text/html`(登录页)。`curl.exe http://100.x.y.z:8770/healthz` 也 `200` —— 两种访问方式都通。

B 的好处:浏览器不把口令当不安全页面警告、能加成主屏 PWA、WS 走 wss。
`serve` 只在 tailnet 内可见;别用 `tailscale funnel`(那是公开到互联网,等价于回到隧道方案)。

## 4. 日常使用

1. 电脑开着、bow 开着、远程控制在启用状态(设置是持久的);
2. 手机打开那个地址 → 输口令(设了 `HttpOnly` cookie,一段时间内免输);
3. 首页是**会话列表**,按注意力排序(等你的 → 在跑的 → 刚跑完的 → 空着的);
4. 点一行进对话:
   - 对话里的输入框:**发送**(等这一轮完)/ **插话**(`steer`,不等)/ 顶栏 **停止**(`ctx.abort()`,顺带清队列);
   - 顶部那张卡片:pi 的权限询问 / `ask_user_question` / plan 批准,允许·拒绝 / 选项 / 输入框;
     终端里那个框同一时刻也在,谁先答用谁;
   - 输入框右边 **⌃ 抽屉**:模型/上下文/token/会话 id、`/` 命令补全(只填不发);
   - 软键盘上方那条**按键条**:Ctrl / Alt / Tab / Esc / 方向 / Paste;
5. 顶部 **返回** 回会话列表;**×** 关掉那个会话。

## 5. 排障

| 症状 | 先查 |
| --- | --- |
| 手机打不开地址 | `tailscale status` 看两台都在、都是 `active`;手机 Tailscale 开关是否被别的 VPN 顶掉 |
| 能打开但页面白 / WS 断 | `/healthz`;再看 bow 设置页远程状态里的实际地址;`tailscale serve status` |
| 手机显示「没有控制通道」 | 那个终端是升级前开的 → 重开终端(要带 `BOW_SESSION_ID` / `BOW_CONTROL_TOKEN`) |
| Windows 上 curl 8770 不通 | mirrored 的 localhost 转发没生效 → 改用 `192.168.1.20:8770`(这条通就说明是转发问题,不是服务没起) |
| 局域网其它设备连不上(bind=lan 时) | Windows 防火墙放行 8770(WSL 继承 Windows 规则) |
| WSL 里 `curl 100.x.y.z` 不通 | **正常,别修**。mirrored 会镜像出 eth4(`100.x/32`)但 WSL 进程连不进那个地址(监听都在 Windows 侧)→ 手机路径走的是 `Windows → 127.0.0.1:8770`,不经过它 |
| WSL 里 git/curl 对外变慢 | 那份 tailscaled 没关干净,或 DNS 被两份 MagicDNS 抢 |
| 自己在 WSL 里访问 tailnet | 直接用 `100.x.y.z`;WSL 里的 `tailscale` 命令连的是本地 socket,Windows 的 daemon 不共享给它 |

## 6. 安全边界(必读)

这个端口后面是**一台机器的交互式 shell + 一个能改代码的 agent**。

1. **别用 Funnel**。Funnel 会把 8770 公开到互联网,那时口令就是唯一防线 —— 那正是这回要避开的局面。
2. **口令仍然要设、要长**。tailnet 里的设备(你以后加的每一台:工作机、朋友的?)都能连到这个端口,
   S6 那套 HMAC cookie / 同源校验 / 失败退避是第二道门,不是摆设。
3. **8765(MCP HTTP)绝不出网、也绝不给 serve**。它能执行任意页面 JS。
4. **tailnet 的成员 = 授权**。加设备前想一下这台机器要不要能敲你电脑的 shell;可以在 admin 里用 ACL
   把 `:8770` 限到特定设备。
5. 用完想彻底断:设置页关掉远程控制(端口立刻停止监听);`tailscale down` 只切网络,不停服务。

## 7. 这一版没做的事

- **cloudflared 监督(S9–S11)不做**:`src/plugins/terminal/remote/tunnel.ts`、设置页隧道块、二维码,都不写。
- **tailscale 不集成进 bow**:不 spawn、不管理、不在设置页显示状态。它是个系统级常驻服务,
  bow 只需要 `bind=lan` 就够了 —— 把「把自己的进程托管给别人的客户端」写进代码只会多一处会坏的连接。
- **固定域名 / DDNS / 自建 frps**:不做,除非哪天要暴露给非 tailnet 的人。
