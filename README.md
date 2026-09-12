# MCP Browser — AI 可操纵的简易 Electron 浏览器

多标签页浏览器:地址栏搜索(输历史/书签实时模糊建议)、浏览历史、书签(文件夹分组)、设置;内置 **MCP 服务器(stdio)**,AI 编码工具(pi / Claude Code / Cursor 等)可以实时操纵这个浏览器:导航、搜索、点击、输入、滚动、切换标签、截图、读取页面快照。

## 技术栈

- Electron(≥ 33,WebContentsView 每标签一实例)+ TypeScript
- Vue 3 + Vite(electron-vite 组织 main / preload / renderer 三端)
- `@modelcontextprotocol/sdk`(stdio transport)

## 启动

```bash
npm install
npm run dev        # 开发(HMR)
npm run build      # 构建到 out/
npm run mcp        # 构建后以 MCP 模式启动(供 AI 工具以子进程方式拉起)
npm test           # 单元测试
npm run typecheck  # 类型检查
```

## 给 AI 工具配置 MCP

以本地 stdio 方式接入。假设项目路径为 `$PROJECT`:

- **Claude Code**
  ```bash
  claude mcp add --transport stdio browser -- bash -lc "cd $PROJECT && npm run mcp"
  ```
- **其他支持 MCP 的工具**(如 pi / Cursor):在 MCP 配置里添加服务器
  ```json
  {
    "mcpServers": {
      "browser": {
        "command": "npm",
        "args": ["run", "mcp"],
        "cwd": "$PROJECT"
      }
    }
  }
  ```

MCP 模式下浏览器窗口照常弹出,AI 的所有操作你都能实时看到。AI 断开连接后浏览器保持运行,可继续手动使用。

## MCP 工具一览

| 工具 | 说明 |
| --- | --- |
| `browser_navigate {url}` | 当前标签跳转(仅 http/https) |
| `browser_search {query, engine?}` | 用默认或指定引擎搜索 |
| `browser_eval {code, tabId?}` | 在页面上下文执行任意 JavaScript,返回最后一个表达式的值 |
| `browser_snapshot {tabId?, maxElements?}` | 页面可操作元素快照(title/url + 可点击输入元素列表,含稳定 CSS 选择器) |
| `browser_click {selector, tabId?}` | 点击元素(注入真实事件序列) |
| `browser_type {selector?, text, clear?, tabId?}` | 输入文字(React 兼容),省略 selector 输入到当前聚焦元素 |
| `browser_press_key {key, tabId?}` | 按键:Enter / Tab / Escape / ArrowDown / Ctrl+W / F5 等 |
| `browser_scroll {direction, selector?, amount?, tabId?}` | 滚动页面或元素 |
| `browser_back / forward / reload / stop` | 历史导航(可选 tabId) |
| `browser_new_tab {url?, activate?}` | 开新标签 |
| `browser_close_tab {tabId}` / `browser_switch_tab {tabId}` / `browser_list_tabs` | 标签管理 |
| `browser_screenshot {tabId?}` | 当前页面截图,以 PNG 图片内容返回给 AI |
| `browser_get_info {tabId?}` | 当前标签标题 / URL / 加载状态 |
| `browser_add_bookmark {title?, url, folderId?}` / `browser_list_bookmarks` | 书签维护 |

典型 AI 工作流:`browser_new_tab` → `browser_search` → `browser_snapshot` 找到结果链接的选择器 → `browser_click` → `browser_screenshot` 确认 → `browser_type`/`browser_click` 填表。

## 手动使用快捷键

- `Ctrl+T` 新标签、`Ctrl+W` 关闭、`Ctrl+Shift+T` 恢复
- `Ctrl+L` 聚焦地址栏、`Ctrl+R` 刷新
- `Ctrl+D` 收藏当前页
- `Ctrl+Shift+I` / `F12`:为**当前聚焦的视图**(页面 / 浏览器 UI)打开或关闭 DevTools。
  DevTools 固定以**独立窗口**打开(不会停靠、也不会被标签页遮挡);焦点在 DevTools 窗口内时,
  按同一快捷键可关闭它。

## 数据存储

- 书签:`<userData>/bookmarks.json`
- 浏览历史(最近 5000 条,按 URL 去重):`<userData>/history.json`
- 设置(默认搜索引擎/主页):`<userData>/settings.json`
- MCP 模式下日志:`<userData>/browser.log`

## 环境注意事项

- **Linux 依赖**:Electron 需要 `libasound.so.2`(ALSA)。精简容器若缺失,可在运行时指定
  `LD_LIBRARY_PATH=<包含 libasound.so.2 的目录>`,或安装 `libasound2` 系统包。
- **无 GPU/无显示环境**:在无合成管线的容器里(如 ssh/CI),浏览器功能(导航/点击/输入/快照/MCP)均正常,
  但 `browser_screenshot` 可能返回黑色帧——截图请在实际桌面环境使用。
- **MCP 模式日志**写入 `<userData>/browser.log`,不会污染 stdio 协议。

## MCP 冒烟测试

```bash
npm run test:mcp   # 拉起 MCP 模式浏览器并自动跑关键流程(新标签→导航→快照→截图→搜索→点击→输入→书签)
```

需要显示环境;Linux 缺 ALSA 时:`SMOKE_LD_LIBRARY_PATH=<目录> npm run test:mcp`。
截图会保存到 `/tmp/mcp-shot.png`(可用 `SMOKE_SHOT_PATH` 覆盖)。

## 架构速览

```
src/
  main/          主进程:窗口、TabManager(每标签 WebContentsView)、
                 MCP 服务器、注入式页面操作执行器、JSON 存储、IPC
  preload/       contextBridge 暴露 window.browserAPI
  renderer/      Vue 3 chrome UI(标签栏/地址栏/书签栏/管理/设置弹层)
  shared/        三端共享:类型、URL 解析、书签树/历史/模糊匹配纯逻辑
tests/           vitest 单元测试(url 解析、书签树、历史、模糊建议)
```

WebContentsView 的布局顶部偏移量由 chrome UI 实测高度通过 `ui:chrome-height` IPC 上报,标签栏/书签栏高度变化时自动跟随。