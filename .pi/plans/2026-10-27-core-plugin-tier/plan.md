# 终端降级为「不可停用的核心插件」+ 补齐 core 语义

日期:2026-10-27 · 状态:**已实施**(v1 + 一处补丁:终端 MCP 工具开关)
范围:`src/shared/plugins.ts`、`src/main/plugins/{core,kernel}.ts`、`src/plugins/terminal/main.ts`、
`src/renderer/src/settings/{PluginManager,SettingsPage}.vue`、`docs/ARCHITECTURE.md`、`tests/`。
**不搬代码目录、不改 internalPages、不动 TabManager/preload/vite 入口。**

## 0. 一句话

终端已经不可能是「可选插件」了(核心 6 个文件硬编码了它 21 处),但设置页还留着一个能把它关掉的开关,
关掉之后 `bow://terminal` 页永远是 `error + 重试`、编辑器插件的 nvim 起不来、5 个 `terminal_*` MCP 工具消失。
本方案新增一个**结构性**标记 `alwaysOn`(不可停用),`core` 保持原义(仅「关闭会影响核心功能」的提示),
终端同时打两个标记;内核在 `setEnabled` 里拒绝停用,持久化状态里历史遗留的 `disabled:['terminal']` 开机时滤掉。

## 1. 现状(已核实的证据)

| 事实 | 位置 |
| --- | --- |
| `PluginManifest.core` 存在,注释「关闭后会影响核心功能」 | `src/shared/plugins.ts:26` |
| `core` 只被设置页读来渲染一个灰标签,**内核从不检查** | `PluginManager.vue:62`;`kernel.ts:243` 无任何 core 判断 |
| 已有 3 个插件标了核心:`history` `bookmarks` `mcp-http` | 各自 `main.ts` 的 manifest |
| `terminal` 没标 | `src/plugins/terminal/main.ts:844` |
| 核心硬编码终端:`InternalPageId` 联合类型 / `isTerminalTab()` 决定 Ctrl+W·L·R·←→ 归属 / `releasesToTerminal()` / 快捷键组 / `RendererEntryName` / vite 入口 | `shared/internalPages.ts`、`main/tabShortcuts.ts:51`、`shared/shortcuts.ts:205`、`shared/shortcutCatalog.ts`、`main/rendererEntry.ts:9`、`electron.vite.config.ts:40` |
| 停用终端后的实际表现:`plugins.invoke('terminal', …)` 抛「插件已停用:terminal」→ 终端页 `status='error'` + 永久「重试」按钮 | `TerminalView.vue:46,202,320`;`kernel.ts:270` |
| 停用 `mcp-http`(也是 core)却**必须**继续可用:内核回收路径有测试钉着 | `tests/mcpHttpService.test.ts:135,146,180` |

最后一行决定了方案形状:**不能**把 `core` 直接改成「不可停用」——那会破坏「停用即回收能力」这条不变式,
还要改两条现有用例,并且拿走用户关掉 MCP HTTP 的合法途径(虽然它自己设置里也有开关)。

## 2. 为什么不是「搬进核心」

插件是**仓库内编译期模块**(`docs/ARCHITECTURE.md` §5.1),`src/plugins/terminal/main.ts` 直接
`import { app } from 'electron'`、直接 `import('node-pty')` —— 与 `src/main/` 没有权限差别,只有目录与 `ctx` 面的差别。
搬过去 = 改 40+ 处 import + 约 3900 行代码与测试的路径,打包/启动/权限**零变化**,功能零收益。
真正的耦合债在**内部页面是核心静态枚举**(`shared/internalPages.ts`),`logseq` 患者完全相同 —— 那是另一件事(§6)。

## 3. 改动清单

### 3.1 契约(`src/shared/plugins.ts`)

```ts
export interface PluginManifest {
  id: string
  name: string
  description: string
  version: string
  /** 关闭后会影响核心功能(设置页给出提示,仍允许关闭) */
  core?: boolean
  /** 结构性必需:随 bow 启动且不可停用(核心侧有代码/页面/快捷键直接依赖它) */
  alwaysOn?: boolean
}
```

`PluginInfo` 继承 manifest,`registry.list()` 是 `...r.manifest` spread,所以 IPC/preload/渲染层**不需要改一行**。

### 3.2 内核(`src/main/plugins/core.ts`、`kernel.ts`)

```ts
// core.ts —— 纯逻辑,可单测
isAlwaysOn(id: string): boolean {
  return this.records.get(id)?.manifest.alwaysOn === true
}

// setDisabled:历史状态里若有 alwaysOn 插件(老版本关过终端),开机直接忽略
setDisabled(ids: string[]): void {
  this.disabled = new Set(
    ids.filter((id) => this.records.has(id) && !this.isAlwaysOn(id))
  )
}
```

```ts
// kernel.ts setEnabled:可信边界在 IPC 之后,不能只靠 UI 置灰
async setEnabled(id: string, enabled: boolean): Promise<PluginInfo[]> {
  if (!this.registry.has(id)) return this.list()
  if (!enabled && this.registry.isAlwaysOn(id)) {
    log('插件为核心插件,忽略停用请求', id)
    return this.list()
  }
  …现有逻辑不变
}
```

`setEnabledState` 不加拦截 —— 它是纯状态投影,校验只留一处(`setEnabled`),避免两套语义各自漂移。

### 3.3 终端插件(`src/plugins/terminal/main.ts:844`)

```ts
manifest: {
  id: 'terminal',
  name: '终端',
  description: '…',
  version: '1.0.0',
  core: true,     // 关掉会连带编辑器插件 / 5 个 MCP 工具 / bow://terminal 页
  alwaysOn: true  // 核心侧硬编码了它的页面、快捷键、渲染入口
}
```

顶部注释补一行「为什么 alwaysOn」,与 `tabShortcuts.isTerminalTab()` 互指。

### 3.4 设置页(`PluginManager.vue`)

- 复选框:`:disabled="p.alwaysOn"`,tooltip「核心插件,随 bow 启动,不能停用」。
- 「核心」徽标沿用 `p.core`(不动);`alwaysOn` 的插件天然也带 `core`,所以视觉上只有一处变化:开关灰掉。
- `togglePlugin` 不用改(IPC 被拒时返回原列表,`plugins.value` 直接吸收)。

### 3.5 文档

- `docs/ARCHITECTURE.md` §5.8 矩阵 `core` 列改为 `core / alwaysOn`;§5.2 manifest 字段说明;§5.6 边界表补一条
  「`alwaysOn` 由内核拒绝停用,持久化状态开机过滤」。
- `README.md` 插件管理一节若写「插件都可运行时启停」,补「核心插件除外,见设置页置灰项」。

## 4. 迁移

无存储版本号变更。`plugins.json` 形状不变(`{version:1,disabled:[]}`),过滤发生在 `setDisabled()`,
所以老用户的 `disabled:['terminal']` 首次启动即失效并保持启用;下一次任意启停操作会把它自然写掉。
不主动写盘(避免启动期产生写操作)。

## 5. 测试与验收

| 项 | 断言 |
| --- | --- |
| `tests/pluginRegistry.test.ts` | `isAlwaysOn` 认 manifest;`setDisabled(['always-on-x'])` 保持启用;普通插件不受影响 |
| 新 `tests/pluginAlwaysOn.test.ts`(或并入 `pluginTabHost.test.ts` 的 fakeKernel) | `setEnabled(alwaysOnId,false)` → `enabled===true` 且仍 `active`;`setEnabled(非alwaysOnId,false)` → 正常停用(顺带守住 mcp-http 那条) |
| 回归 | `tests/mcpHttpService.test.ts` 三条「停用插件」用例**必须原样绿**(这是本方案不改 `core` 语义的验收线) |
| 命令 | `npm run typecheck`、`npm test`(基线 78 文件 / 1500+ 用例)、`npm run build` |
| 真机 | ① 设置 → 插件管理:终端开关灰掉、悬停有说明;② 手改 `plugins.json` 成 `disabled:["terminal"]` → 重启后终端仍可用;③ 地址栏 `bow://terminal` + `Ctrl+Shift+E` 行为不变;④ 关掉 `mcp-http` 仍能关(能力回收不变) |

### 5.5 补丁:terminal 的 MCP 工具开关(实施中发现)

`README.md` 原先把「插件管理里停用终端」写成收回 `terminal_send` / `terminal_close`(无确认键盘注入)的
**唯一**方法。终端不可停用后这条路没了,等于**悄悄拿掉一个安全控制** —— 所以补一个开关:

- `TerminalSettings.mcpTools: boolean`(默认 `true`,归一化只认布尔,缺省走 fallback);
- 5 个 `terminal_*` 处理器统一前置 `if (!mcpAllowed()) return mcpBlocked()`(工具照常列出,调用回错误);
  不做运行时注销/重注册 —— 那要动 `McpHost` 的热回收,收益只是「列表里少 5 行」;
- 设置页「终端」分区新增「AI 控制」行(`data-term-mcp-tools` 钩子);
- `README.md` 的收回路径改指这个开关;`ARCHITECTURE.md` §5.8 的存储列同步。

## 6. 非目标(明确不做)

1. **内部页面注册表**:让插件自己登记 `bow://<id>` + 渲染入口,消掉核心那 21 处硬编码。收益是「以后加第 4 个
   内部页不用改核心」;成本是 `TabManager.spawn` / preload / vite 多入口 / `InternalPageId` 类型枚举。单独开计划。
2. **`requires` 依赖图**:`editor` 隐式依赖终端。终端变成不可停用后这条依赖不会再崩,不需要再建一套依赖声明。
3. **`logseq` 也置为 alwaysOn**:它是自包含的可选插件,用户关掉它只影响自己。已知缺口:禁用后 `bow://logseq`
   页同样会落到 `error`(与终端同一个根因),归到第 1 条一起解。

## 7. 风险

- `core` 与 `alwaysOn` 两个字段容易被后人混用 ⇒ 靠 `shared/plugins.ts` 的注释 + §5.8 矩阵两处同时写清;
  若将来真出现「核心但可关」以外的第三态,再抽出 `PluginTier` 枚举,现在不值得。
- 内核 `setEnabled` 静默忽略而不是抛错:UI 已置灰,IPC 被直调只可能是脚本,静默 + 日志比抛错更不容易把
  设置页打进错误态。如果希望脚本能感知失败,可在返回体加 `blocked:true`(本次不做)。

## 8. 实施记录(2026-10-27)

| 文件 | 改动 |
| --- | --- |
| `src/shared/plugins.ts` | `PluginManifest.alwaysOn?` + 与 `core` 正交的注释 |
| `src/main/plugins/core.ts` | `isAlwaysOn()`;`setDisabled()` 过滤 alwaysOn |
| `src/main/plugins/kernel.ts` | `setEnabled()` 对 alwaysOn 的停用请求记日志后原样返回 |
| `src/plugins/terminal/main.ts` | manifest `core + alwaysOn`;顶部注释第 6 条;5 个 MCP 工具前置 `mcpAllowed()` |
| `src/plugins/terminal/shared.ts` | `TerminalSettings.mcpTools`(默认 true)+ 归一化 |
| `src/plugins/terminal/ui/TerminalSettings.vue` | 「AI 控制」开关行 + `.term-mcp` 样式 |
| `src/renderer/src/settings/PluginManager.vue` | 核心插件复选框 `:disabled` + tooltip |
| `tests/pluginAlwaysOn.test.ts`(新) | 停用是空操作 / 普通插件照旧可停并落盘 / 历史 disabled 被过滤 |
| `tests/pluginRegistry.test.ts` | `isAlwaysOn`、`setDisabled` 过滤、`list` 透传 |
| `tests/terminalShared.test.ts` | `mcpTools` 默认值 / 显式 false / 非布尔回落 |
| `docs/ARCHITECTURE.md` | §5.2 契约、§5.5 不变式、§5.6 边界行、§5.8 矩阵 `core / alwaysOn` 列与存储列 |
| `README.md` | 插件管理「核心插件不可停用」、收回 AI 终端工具改指新开关、编辑器依赖说明 |

基线:`mcpHttpService.test.ts` 的三条「停用插件」用例未改动仍全绿(= `core` 语义没被改坏)。
