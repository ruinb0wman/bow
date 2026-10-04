# 书签 / 密码插件导出功能

日期：2026-10-04　模式：plan（只读调查）→ build

## 1. 目标与假设

给两个内置插件各加一个「导出」入口：

- **书签插件**：把整棵书签树导出为 **JSON 文件**（无损，等于 `bookmarks.json` 的内容）。
- **密码插件**：把密码库导出为 **加密备份副本**（即 `passwords.json` 的密文内容，**不导出任何明文**）。

用户已确认的决策（本次问答）：

| 决策点 | 选择 |
| --- | --- |
| 书签格式 | 只做 JSON（不做 Netscape HTML） |
| 密码格式 | 只做加密备份副本（不做 CSV / 明文 JSON） |
| 保存位置 | 直接写到 **bow 下载目录**，不弹「另存为」对话框 |
| 密码门禁 | 仅确认弹窗即可；因导出物是密文，**不要求重新输入主密码** |

假设 / 由此推导：

1. 「bow 下载目录」= 下载插件设置里的 `downloadDir`（空串时 = `app.getPath('downloads')`），即下载面板显示的那个目录。
2. 密码备份是密文，所以**锁定时也可导出**（按钮只在「已初始化」时可点）。这比用户问题里「已解锁」的前提更宽，是刻意的：密文导出不需要主密码。
3. 不新增任何 MCP 工具：密码插件「刻意不贡献 MCP 工具：与 AI 隔离」（`docs/ARCHITECTURE.md:537`）这条不变式必须保持；书签导出也保持一致，只走 UI。
4. 导出文件**不**进入下载面板的记录列表（那不是 `will-download` 触发的）。见 §8。

## 2. 现状（实际读到的代码）

### 2.1 书签插件

`src/plugins/bookmarks/main.ts`：数据由 `ctx.storage<BookmarkTree>({ file: 'bookmarks.json', defaults: [] })` 持有，
现有 IPC 方法 `list / add / addFolder / update / remove / move / findByUrl`（行 ~46–99），
另有 `suggest.register` 与两个 MCP 工具 `browser_add_bookmark` / `browser_list_bookmarks`。
`BookmarkTree = BookmarkNode[]`（`src/shared/types.ts:53`），所以导出就是 `JSON.stringify(store.get(), null, 2)`。

导出入口的落点——`src/plugins/bookmarks/ui/BookmarksModal.vue` 底部工具条（当前）：

```html
<div class="la-foot">
  <button class="btn" @click="startAddBookmark"><Plus :size="13" /> 新建书签</button>
  <button class="btn" @click="startAddFolder"><Plus :size="13" /> 新建文件夹</button>
  <span class="la-hint">单击目录进入; Ctrl+点击目录后台打开全部页面</span>
  <span v-if="notice" class="la-notice">{{ notice }}</span>
</div>
```

`lucide-vue-next` 的 import 里目前没有 `Download`；`showNotice(text)` 固定 2 秒（`noticeTimer`）。

### 2.2 密码插件

`src/plugins/passwords/main.ts`：
- 密文文件是 `ctx.storage<VaultFile>({ file: 'passwords.json', defaults: EMPTY_VAULT })`（行 ~137）。
- `isInitialized(vault())` 判定是否已建库；`vault()` 返回内存里的 `VaultFile`（`{version,kdf,verifier,data}`，`data` 是密文）。
- 现有 IPC 方法（`docs/ARCHITECTURE.md:537`）：`status setup unlock lock list getEntry save remove copy readPageFields fillEntry beginFill changeMaster getSettings setSettings wipe`，**没有导出**。
- 只 import 了 electron 的 `clipboard`；没有任何 MCP 工具。

`src/plugins/passwords/ui/PasswordsSettings.vue` 已有「密码库 / 修改主密码 / 危险操作」三段，危险操作用 `wipeArmed` 的内联确认模式：
```html
<template v-if="wipeArmed">
  <span class="pw-settings-hint">…</span>
  <button class="btn danger" @click="wipe">确认清空</button>
  <button class="btn" @click="wipeArmed = false">取消</button>
</template>
<button v-else class="btn danger" @click="wipeArmed = true">清空…</button>
```
底部提示写着「整份复制就是备份」——新导出按钮应放在它上面，并更新这句。

### 2.3 编辑日志里的既有约定

- 主进程侧 pipeline 用 `BrowserWindow.getFocusedWindow()` + `dialog.showOpenDialog`（`logseq/main.ts:608`、`downloads/main.ts:501`）——**本方案不用对话框**，所以不涉及。
- 唯一接触 electron 的下载宿主是 `downloads/main.ts`，它把「生效目录」定义为 `settings().downloadDir || app.getPath('downloads')`（`downloads/main.ts:158`），设置存 `downloads-settings.json`。
- 跨插件复用的纯函数先例：`uniqueFileName(filename, exists, max)` 在 `src/plugins/downloads/shared.ts:241`，已有单测（`tests/downloadsShared.test.ts:221`）。
- 插件边界测试 `tests/pluginBoundaries.test.ts` 只禁止 `main.ts → .vue/@renderer` 和 `ui.ts → electron`；跨插件 import 纯模块不违规。

## 3. 设计决策

### 3.1 新增一个主进程侧共享工具 `src/main/plugins/exportFile.ts`

放在 `src/main/**`（不放进 `src/plugins/downloads/`，否则要登记进 `tsconfig.node.json` 的 include；`src/main/**/*` 已被 include）。它负责三件两插件都要的事：

```ts
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_DOWNLOAD_SETTINGS, uniqueFileName } from '@plugins/downloads/shared'

export interface ExportWriteResult { ok: boolean; path?: string; error?: string }

/** 与下载插件同源的目录解析：downloads-settings.json 的 downloadDir，空串 → 系统下载目录 */
export function resolveDownloadsDir(): string {
  try {
    const raw = readFileSync(join(app.getPath('userData'), 'downloads-settings.json'), 'utf-8')
    const dir = (JSON.parse(raw) as { downloadDir?: unknown }).downloadDir
    if (typeof dir === 'string' && dir.trim()) return dir.trim()
  } catch { /* 文件不存在 / 坏 JSON → 回退 */ }
  return DEFAULT_DOWNLOAD_SETTINGS.downloadDir || app.getPath('downloads')
}

/** 写入 bow 下载目录，同名自动加 ` (1)`；返回实际绝对路径 */
export function writeToDownloads(filename: string, content: string): ExportWriteResult { … }

/** 本地日期 YYYY-MM-DD（文件名用） */
export function dateStamp(now: Date = new Date()): string { … }
```

- 直接 `readFileSync` 而不是 `ctx.storage`：内核注释明确说「插件间共享文件名是错误用法」，且这里只需读一次、不缓存，避免与下载插件的内存副本冲突。
- 复用 `DEFAULT_DOWNLOAD_SETTINGS` / `uniqueFileName`，不复制逻辑（下载插件侧不改动，两处默认值同一来源）。
- 写入带 `mode: 0o600`（Windows 忽略），失败一律返回 `{ ok:false, error }`，不抛。

### 3.2 路由

- `bookmarks/main.ts`：`ctx.ipc.handle('export', …)` → `writeToDownloads('bow-bookmarks-<date>.json', JSON.stringify(store.get(), null, 2))`。
- `passwords/main.ts`：`ctx.ipc.handle('exportBackup', …)` → 未初始化返回 `{ ok:false, error:'尚未创建密码库' }`；否则 `writeToDownloads('bow-passwords-backup-<date>.json', JSON.stringify(vault(), null, 2))`。
- 密码备份**只序列化内存里的 `VaultFile`**（`kdf/verifier/data`），不碰明文 `entries`，不 import 新的 electron API。

### 3.3 UI

- 书签模态底部加「导出」按钮；成功 `showNotice('已导出到下载目录:' + 文件名, 5000)`，失败 `showNotice('导出失败:' + error)`；树为空时禁用。
- 密码设置页加「备份」分区：`导出加密备份` → 内联确认（照抄 `wipeArmed` 模式）→ 成功后在常驻提示行显示完整路径。按钮 `:disabled="!status?.initialized"`。

### 3.4 被否掉的替代方案

- **renderer Blob + `<a download>`**：走 `will-download`，会受下载插件 `askWhereToSave`（默认 `true`）影响而弹保存对话框，与「直接存到下载目录」矛盾；还会把密码库密文经渲染层转发。否定。
- **native `dialog.showSaveDialog`**：用户明确不要对话框。否定。
- **内核 service（`ctx.service.downloads.save`）**：更“正统”但要改 `PluginServiceApi` + kernel + 下载插件注册，收益不抵改动面。否定。

## 4. 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/main/plugins/exportFile.ts` | **新增**：`resolveDownloadsDir` / `writeToDownloads` / `dateStamp` + `ExportWriteResult` |
| `src/plugins/bookmarks/main.ts` | import `writeToDownloads/dateStamp`；新增 `ctx.ipc.handle('export', …)` |
| `src/plugins/bookmarks/ui/BookmarksModal.vue` | import `Download` 图标；加 `exporting` 状态 + 导出按钮 + 成功/失败提示 |
| `src/plugins/passwords/shared.ts` | 新增同构类型 `ExportBackupResult extends OkResult { path?: string }` |
| `src/plugins/passwords/main.ts` | import `writeToDownloads/dateStamp` 与 `ExportBackupResult`；新增 `ctx.ipc.handle('exportBackup', …)` |
| `src/plugins/passwords/ui/PasswordsSettings.vue` | import `Download` 图标；新增「备份」分区 + 内联确认 + 路径提示；更新底部「整份复制就是备份」文案 |
| `tests/exportFile.test.ts` | **新增**：目录解析 + 唯一命名 + 写入内容 + 目录自建 |
| `tests/passwordPlugin.test.ts` | 路由清单加 `exportBackup`；新增导出用例；`vi.mock` 掉 `exportFile` |
| `tests/bookmarkExport.test.ts` | **新增**：最小 fake ctx 激活书签插件，断言 `export` 注册与写入内容 |
| `README.md` | 顶部特性行、数据文件说明、§密码插件「想备份就整份复制 passwords.json」文案 |
| `docs/ARCHITECTURE.md` | §5.8 两行 IPC 列表；src 树 `main/plugins/` 加 `exportFile.ts`；密码/书签导出说明 |

## 5. 实施步骤（每步可独立验证）

1. **写 `src/main/plugins/exportFile.ts`**（§3.1 三函数 + 类型）。
   - 验证：`tests/exportFile.test.ts` 全绿；`bun run typecheck`（node 侧）通过。
2. **接书签路由**：`src/plugins/bookmarks/main.ts` 注册 `export`。
   - 验证：`tests/bookmarkExport.test.ts` 断言 `rec.routes` 含 `export`，且写入的字符串 `JSON.parse` 后等于树。
3. **接密码路由 + 类型**：`passwords/shared.ts` 加 `ExportBackupResult`；`passwords/main.ts` 注册 `exportBackup`（未初始化拒绝、已初始化输出密文）。
   - 验证：改完 `tests/passwordPlugin.test.ts`（§6）后全绿；断言导出内容里**不含**测试明文密码。
4. **书签 UI**：`BookmarksModal.vue` 加导出按钮与提示。
   - 验证：`bun run build` 通过；开发态手点一次（或 `bunx vite` + bow 浏览器）看到一个 `.json` 落到下载目录。
5. **密码 UI**：`PasswordsSettings.vue` 加「备份」分区 + 内联确认 + 路径提示。
   - 验证：同上；导出后文件与 `passwords.json` 内容一致、明文密码搜不到。
6. **文档同步**（§7）。
   - 验证：`grep` 核对 IPC 列表两处、README 文案一处。
7. **全量验证**：`bun run typecheck && bun test && bun run build`。
   - 无 MCP 工具变化，`npm run test:mcp` 预期不变（可选跑）。

## 6. 测试细节

### 6.1 `tests/exportFile.test.ts`（新）

用 `mcpHttpService.test.ts` 那套「每次 `app.getPath()` 读可变目录」的 mock：

- `vi.mock('electron', () => ({ app: { getPath: (k) => (k === 'userData' ? userDataDir : downloadsDir) } }))`，两个 temp 目录用 `mkdtempSync`。
- 用例：
  1. 无 `downloads-settings.json` → `resolveDownloadsDir() === downloadsDir`；
  2. `{downloadDir:'<custom>'}` → 返回 custom；
  3. `{downloadDir:''}` → 返回 downloadsDir；
  4. 坏 JSON → 返回 downloadsDir；
  5. `writeToDownloads('a.json','{}')` 写入内容正确、返回绝对路径；
  6. 目标目录不存在时自动创建；
  7. 已存在同名文件 → 落成 `a (1).json`（复用 `uniqueFileName` 语义）。

### 6.2 `tests/passwordPlugin.test.ts`（改）

- 文件顶部新增 `const writeToDownloads = vi.fn(() => ({ ok: true, path: '/tmp/bow-passwords-backup.json' }))` 与
  `vi.mock('../src/main/plugins/exportFile', () => ({ writeToDownloads: (...a) => writeToDownloads(...a), dateStamp: () => '2026-10-04' }))`。
- 「激活时注册 IPC…」的期望数组（现在写死了 16 个方法）加 `'exportBackup'`，否则必红。
- 新用例：
  - 未初始化 → `{ ok:false, error:'尚未创建密码库' }`，`writeToDownloads` 未被调用；
  - `setup` + `save` 后导出（含**锁定后**导出）→ `ok:true`；取 `writeToDownloads.mock.calls[0][1]`，`JSON.parse` 后有 `kdf/verifier/data`，且整串**不包含** `'s3cret'`。

### 6.3 `tests/bookmarkExport.test.ts`（新）

- `vi.mock('../src/main/plugins/exportFile', …)` 同上。
- 最小 `PluginContext`（复刻 `passwordPlugin.test.ts` 的 `memStore` + `fakeCtx` 骨架，只实现 `storage/ipc/suggest/mcp/log`）。
- 用例：`activate` 后 `call('export')` → `writeToDownloads` 被以 `bow-bookmarks-*.json` 调用，第二个参数 `JSON.parse` 后是 `[]`（空树）或预置树。

## 7. 文档同步

- `README.md:3`（顶部特性行）：书签处补「导出 JSON」、密码处补「导出加密备份」。
- `README.md:663` 附近的数据文件清单：注明导出物落在 **bow 下载目录**。
- `README.md:790`：「**忘记主密码无法恢复** —— 想备份就整份复制 `passwords.json`(它是密文)。」改为同时提设置页「导出加密备份」（写进下载目录），手工复制仍可行。
- `docs/ARCHITECTURE.md:528` bookmarks 行 IPC 列表加 `export`。
- `docs/ARCHITECTURE.md:537` passwords 行 IPC 列表加 `exportBackup`，并注明「导出的是密文、锁定时也可用」。
- `docs/ARCHITECTURE.md` src 树 `main/plugins/` 段（约行 62–68）加一行 `exportFile.ts  导出到下载目录（目录解析与下载插件同源）`。
- 不改 MCP 工具计数（§6.2 的「插件工具 19 个」等），因为不新增 MCP 工具；`.pi/skills/bow-browser/SKILL.md` 也不用动。

## 8. 风险与未知（build 时注意）

1. **目录解析漂移**：`exportFile.ts` 只读 `downloads-settings.json`。若将来下载插件改了默认目录逻辑而没有同步，就会偏。缓解：复用 `DEFAULT_DOWNLOAD_SETTINGS` + 在 `downloads/main.ts:158` 与 `exportFile.ts` 各留一条交叉引用注释；`tests/exportFile.test.ts` 用例 3 把「空串 → 系统目录」这条契约钉死。
2. **不进下载记录**：导出文件不会出现在下载面板里，用户只能靠提示里的路径 / 在下载面板点「显示文件夹」找。若要它也进记录，需要走 `will-download`（会弹框）或给下载插件加内部登记 API——**本计划不做**。
3. **同步写盘**：`writeFileSync` 在主进程同步执行；书签/密码库体积都很小（KB 级），可接受，与 `JsonStore.save()` 一致。
4. **权限位**：`mode: 0o600` 受 umask 影响、Windows 无效；这只防同机其他用户，不防同步盘。密码备份是密文，风险可控。
5. **测试里的 fs**：`exportFile.test.ts` 真的往临时目录写文件，需在 `afterAll` 清掉 temp 目录，避免 `/tmp` 堆积；`passwordPlugin.test.ts` / `bookmarkExport.test.ts` 必须 mock `exportFile`，否则 `electron.app` 未 mock 会炸。
6. **待确认的小选择**（build 前若想改口径）：文件名前缀 `bow-`；书签空树时按钮禁用；密码导出在锁定态也可用。三者都可一行改。

## 9. 验证命令

```bash
bun run typecheck          # node + web 两侧
bun test                   # 全量 vitest（新增 3 个文件）
bun run build              # electron-vite build（三个 bundle）
# 可选：npm run test:mcp   # 预期工具数不变（本次不新增 MCP 工具）
```
