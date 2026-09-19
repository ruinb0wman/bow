# 把「注册默认浏览器」做成插件:default-browser

> ✅ **已完成(2026-09-18)**:按本计划实现并实机验证。落地差异只有两处:
> 1. 包装脚本改为直推 electron(`exec <electron> <仓库根> "$@"`),不再经 `node scripts/open-bow.mjs`
>    —— dev 模式不再依赖系统里的 node 与仓库脚本存在;
> 2. `mimeapps.list` 是共享文件,写入时不套「非我方文件拒绝覆盖」的标记守卫(desktop 文件与包装脚本才套)。

## 目标(一句话)

在 `bow://settings` 里新增「默认浏览器」分区:显示**当前是否已是默认浏览器**(逐项 http/https/.html/.htm/.xhtml 的当前默认是谁)、一键**注册/撤销**、并把「为什么不能一键设成默认」讲清楚 —— 取代 `npm run install:desktop` 这条命令行入口。

## 已定决策(用户确认)

1. **插件自己读 process 全局**推导 exe/路径,不给内核加 `ctx.app`(零内核改动)。
   - 打包:`process.execPath` 就是 bow 可执行文件(Windows 的 `bow.exe`);
   - dev:`process.defaultApp === true` → 用 `process.cwd()`(即仓库根)生成包装脚本,与现状 `~/.local/bin/bow` 行为一致。
2. **只做插件,删掉 CLI**:删 `scripts/install-desktop.mjs`、`scripts/lib/winAssociations.mjs`、`package.json` 的 `install:desktop`。
   - ⚠️ 本机已装的关联不受影响:包装脚本指向的是 `scripts/open-bow.mjs`,desktop 基名/mimeapps 键都不变,插件管理的是同一批路径 → 平滑接替。
3. **不加 MCP 工具**(工具数、SKILL.md 的计数都不动)。
4. 因为 CLI 没了,共享逻辑不再需要 `.mjs` → 全部用 **TS**,与仓库既有 `plugins/<id>/*.ts` 一致。

## 文件布局

```
src/plugins/default-browser/
  main.ts                       manifest(id: 'default-browser'; capabilities: ['ui'])
                                activate → ctx.ipc.handle('status'|'register'|'unregister')
  ui.ts                         { id, settingsSections: [DefaultBrowserSettings] }
  ui/DefaultBrowserSettings.vue 状态徽标 + 逐项表格 + 三个按钮 + 说明 + 操作日志
  windowsRegistry.ts            纯逻辑:HKCU 注册计划、reg.exe 参数、UserChoice 解析、手动步骤
  linuxDesktop.ts               纯逻辑:desktop 文件/包装脚本内容、mimeapps.list 增删查
  registration.ts               平台分发 + I/O 编排(status / register / unregister,注入 deps)
```

登记两处:`src/main/plugins/builtin.ts`(`BUILTIN_PLUGINS` 末尾)、`src/renderer/src/plugins/registry.ts`(`PLUGIN_UI` 末尾)。
UI 侧**只** import `.vue` + `window.browserAPI`(不 import 上面三个 ts,避免把 node:fs 带进渲染层 bundle);
`tests/pluginBoundaries.test.ts` 会自动覆盖新插件(它按目录枚举)。

## 状态语义(核心)

「注册了没有」与「系统当前选的是不是我」是两件事,必须分开报:

| 平台 | isDefault(唯一可靠依据) | registered |
| --- | --- | --- |
| Linux | 解析 `~/.config/mimeapps.list` 的 `[Default Applications]`,逐项比对 `com.ruinb0w.bow.desktop`;`xdg-mime` 存在时再交叉验证 | `.desktop` 与 `~/.local/bin/bow` 是否在位 |
| Windows | `reg query HKCU\...\Explorer\{UrlAssociations\http,FileExts\.html}\UserChoice` 的 `ProgId` 是否等于 `bowURL` / `bowHTML` | `bowHTML`/`bowURL`/`Capabilities`/`RegisteredApplications` 键是否存在 |

返回结构(IPC 原样交给 UI):

```ts
interface DesktopStatus {
  platform: 'linux' | 'win32' | 'other'
  supported: boolean
  registered: boolean
  isDefault: boolean            // 全部目标都是我们才算 true
  exec: string                  // 当前会注册成什么(dev:包装脚本;打包:真实二进制)
  mode: 'dev' | 'packaged'
  targets: Array<{ id: string; label: string; state: 'default' | 'other' | 'unset'; current: string | null }>
  notes: string[]               // Windows 手动步骤 / Linux 缺 xdg-utils / dev 模式提示
}
```

四种 UI 状态:`✅ 已是默认浏览器` / `⚠️ 已注册但非默认(附当前用户是谁)` / `⚪ 未注册` / `⛔ 本平台不支持(macOS)`。

## 实施顺序(每步可独立验证)

1. `linuxDesktop.ts` + `windowsRegistry.ts`(纯逻辑)→ 把现有 `tests/winAssociations.test.ts` 迁成
   `tests/defaultBrowser.test.ts`(保留原有 15 例,新增 UserChoice 解析、mimeapps 解析、desktop/包装脚本内容)。
2. `registration.ts`:平台分发 + 注入 deps(`{ platform, home, repoRoot, execPath, isPackaged, fs, runReg, run, dryRun }`)。
   - 保留 CLI 里那套稳健行为:`REG_NONE` 被拒时退化成空 `REG_SZ`;写完逐条 `reg query` 自校验;失败列表回传 UI。
   - Linux 写 mimeapps 前留 `.bow.bak`;幂等 no-op 不产生副作用(上一轮刚修的那个瑕疵别回退)。
3. `main.ts`(IPC)+ `ui.ts` + `DefaultBrowserSettings.vue` + 两处登记。
4. 删除 CLI:`scripts/install-desktop.mjs`、`scripts/lib/winAssociations.mjs`、`package.json` 的 `install:desktop`。
5. 文档:README「设为默认浏览器」整节改写为「去设置页注册」(保留 Windows 手动两步与边界说明);
   ARCHITECTURE:文件地图 + `§5.8` 插件贡献矩阵 + `§9` IPC 表(插件 IPC 走 `plugins:invoke`,说明方法名)+ `§11` 删脚本行 + 测试基线计数。
6. 测试:`npm run typecheck` / `npm test`(31 文件 / 448 例 → 预计 1 个文件改名 + 新增用例);
   `npm run build`;真机(隔离 HOME)走一遍 dev 模式注册 → 状态显示「已是默认」→ 撤销 → 状态回到「未注册」。

## 风险与注意

- **插件停用 ≠ 撤销注册**:停用只是拿掉 UI,系统关联仍在 → 说明文案必须写清,并保留「撤销注册」入口。
- **dev 模式注册的是包装脚本**(`node <repo>/scripts/open-bow.mjs`),打包模式注册的是真实二进制;两者写入的是**同一个路径/同一个 desktop id**,所以模式切换时应当 `注册/更新` 一次以纠正 Exec。
- macOS 不支持(需要 `.app` 包 + `LSSetAssociationStatus`/`LSSetDefaultHandlerForURLScheme`)→ 状态直接报 `⛔ 不支持`。
- Windows 侧所有写入仅在**打包版**可用;dev 模式下界面明确提示「先 `npm run dist`」而不是写一个指向 electron.exe 的键。
