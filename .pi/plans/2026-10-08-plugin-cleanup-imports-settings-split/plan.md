# 夸克插件移除 + 书签/密码导入 + 设置页分屏

日期：2026-10-08　模式：plan（只读调查 + 问卷）→ build（已完成）

## 1. 目标（用户原话四条）

1. 移除「夸克网盘」插件；
2. 书签的导入/导出放进**插件设置**，书签弹窗里的导出删掉；
3. 密码插件补**导入**（原来只有导出）；
4. `bow://settings` 支持分屏。

## 2. 已拍板的决策（本次问答）

| 决策点 | 选择 |
| --- | --- |
| 设置页分屏键 | **设置页渲染层自己处理**（logseq 同款），主进程/共享逻辑零改动，输入框保留按词选择 |
| 书签导入语义 | **整树替换**（导入前内联确认） |
| 密码库导入 | **覆盖整库 + 导入前自动把当前库先导出到下载目录** |
| 导入文件来源 | **系统文件选择框**（`dialog.showOpenDialog`） |

## 3. 现状取证（关键几处）

- `src/main/plugins/builtin.ts` / `src/renderer/src/plugins/registry.ts` 是插件唯一的两个登记点；`SLOT_PLUGIN_ORDER` 本来就没列 quark。
- MCP 工具数由插件声明驱动；quark `capabilities: ['ui']`，**不贡献 MCP 工具** → 移除不影响工具计数。
- `PluginRegistry.setDisabled()` 会 `filter(id => records.has(id))` → `plugins.json` 里残留的 `quark` 是无害的。
- 书签插件**没有** `settingsSections`；导出按钮当时在 `BookmarksModal.vue` 底部工具条；`export` IPC 已存在。
- 密码插件有 `exportBackup`，无导入；`vault.ts` 只有 `isInitialized()`，没有外部文件校验。
- `shouldTakeSplitHotkey()`（`src/shared/shortcuts.ts`）对 `{internal:true, internalPageId:'settings'}` 返回 `false` —— 主进程放行后**设置页没接**这两个组合，所以按键掉在地上。
- 笔记页 `JournalView.vue` 已有「页面自己监听 + 调 `api.splitPane/resizePane`」的完整先例。

## 4. 改动清单（实际落地）

### 4.1 移除夸克

删除：`src/plugins/quark/`（7 文件）、`tests/quark{Plugin,Script,Shared}.test.ts`（855 行）、`scripts/e2e-quark-headers.mjs`。

编辑：`main/plugins/builtin.ts`、`renderer/src/plugins/registry.ts`、`package.json`（去 `test:e2e:quark`）、
`tests/settingsNav.test.ts`（夹具 id 换中性 `demo`）、`README.md`（命令表 / MCP 注 / 内置插件清单 / 整个「夸克网盘插件」节 / 离线 E2E 节 /「与设备·夸克 E2E 一样」）、
`docs/ARCHITECTURE.md`（主进程矩阵行、渲染层矩阵行、命令表行、`e2e-quark-headers.mjs` 行、spike 结论里指向 quark 的那句）。

刻意不做：`<userData>/quark.json` 不删（用户数据）；`.pi/plans/2026-09-24-quark-plugin/plan.md` 留作历史。

### 4.2 书签：导入/导出进设置页

- **新纯函数** `normalizeImportedTree(raw)`（`src/shared/bookmarkTree.ts`）：根必须数组；节点 `title` + `type`；
  书签 url 必须 `isHttpUrl` 或 `isInternalUrl`（否则丢弃计数）；folder 递归 children；
  id 缺失/重复/非字符串 → `genId()` 重发计数；末尾跑 `flattenToSingleLevel()` 保住「目录恒在根」不变量。
  返回 `{ tree, dropped, reissued }`，根不是数组返回 `null`。
- **新共享工具** `src/main/plugins/pickJsonFile.ts`：`dialog.showOpenDialog`（优先挂聚焦窗口）+ `readFileSync(path,'utf-8')`，
  返回 `{canceled, path?, text?, error?}`。把**读文件也放这里**，于是两个插件的单测只 mock 这一个模块即可（不必 mock `node:fs`）。
- `bookmarks/main.ts`：新增 `import` IPC —— 取消→`{canceled:true}`；坏 JSON / 根非数组 → 报错**不动现有树**；
  成功 → `setRaw(归一后的树)` + `emitChanged()` + 返回书签/目录数与 `dropped`/`reissued`。
- 新 `src/plugins/bookmarks/shared.ts`：`BookmarkExportResult` / `BookmarkImportResult`（纯类型，渲染层也要用）。
- 新 `BookmarksSettings.vue`（导入内联确认 + 导出 + 路径提示 + 结果提示），`ui.ts` 加 `settingsSections`。
- `BookmarksModal.vue`：删导出函数、按钮与 `Download` 图标 import。

### 4.3 密码：导入加密备份

- `vault.ts`：新增 `parseVaultFile(raw)`（只做**结构**校验，不解密）+ `IMPORT_KDF_LIMITS`。
  **上界的意义**：`unlockVault` 按备份里写的 `N/r/p` 跑 scrypt，`maxmem` 是固定的 64 MiB；
  一份声称 `N=2^30` 的文件会让解锁抛错，将来若有人调大 `maxmem` 就不再只是抛错 —— 宁可在导入这一步挡掉。
- `main.ts` 新增 `importBackup`：结构校验 → 当前库已初始化则**先导出** `bow-passwords-preimport-<日期>.json`
  （这一步失败就**中止**，绝不先毁后写）→ `setRaw` → `clearKey()` → `emitState()`（**强制锁定**）。
- `shared.ts` 加 `ImportBackupResult`；`PasswordsSettings.vue` 备份分区加导入（内联确认 + preimport 路径提示）。

### 4.4 设置页分屏

- 新 `src/renderer/src/lib/splitKeys.ts`：`isEditableTarget()` + `keyInputFromEvent()` + `splitHotkeyFromEvent()`
  —— **复用主进程的 `matchSplitHotkey()`**，于是「分屏忽略自动重复 / resize 允许自动重复 / 输入法组合不接管」逐条一致
  （笔记页那份手写 `ARROWS` 表没有这几条，属可选后续小重构）。
- `src/renderer/src/settings/main.ts`：挂 `window` keydown —— 可编辑元素直接 return；命中则 `preventDefault()` 后调 `splitPane`/`resizePane`。
- 主进程与 `@shared` **零改动**；`shouldTakeSplitHotkey()` 对设置页继续返回 false（这是刻意的，输入框要保住按词选择），
  只更新了它的文档注释与 README / ARCHITECTURE / shortcutCatalog 里「设置页保持原样」的说法。

## 5. 测试（新增 / 改造）

| 文件 | 内容 |
| --- | --- |
| `tests/bookmarkTree.test.ts` | +7 例 `normalizeImportedTree`（非数组 / 空数组 / 空标题兜底 / 丢弃计数 / id 重发 / 深层压一级 / 缺 children） |
| `tests/bookmarkImportExport.test.ts`（原 `bookmarkExport.test.ts` 改名） | 路由注册；import 的取消 / 坏 JSON / 根非数组 / 读失败 / 整树替换计数 / 丢弃与重发 |
| `tests/passwordVault.test.ts` | +5 例 `parseVaultFile`（往返可解锁 / 三件套缺失 / Sealed 字段 / 算法与数字 / KDF 上界） |
| `tests/passwordPlugin.test.ts` | 路由清单加 `importBackup`；5 例（未初始化导入 / 已初始化先备份再覆盖且旧密码失效 / 备份失败即中止 / 取消与坏文件 / 密文逐字一致） |
| `tests/splitKeys.test.ts`（新） | `isEditableTarget` 4 类；`keyInputFromEvent` 映射；`splitHotkeyFromEvent` 分屏/resize/自动重复/输入法/无修饰 |
| `tests/pickJsonFile.test.ts`（新） | 取消 / 读到文本 / 读失败带 error / 有聚焦窗口时挂成子窗口 |

## 6. 验证

```bash
bun run typecheck   # node + web 两侧
bun run test        # 64 文件 / 1219 用例
bun run build       # 三个 bundle
```

真机（headless Electron + CDP，脚本 `/tmp/bow-verify-settings-split.mjs`，未入库）：
夸克从插件清单消失 → 设置页侧栏出现「书签」「密码」→ 设置页里 `Ctrl+Shift+→` **真的分屏成 2 窗格** →
输入框里同组合**不分屏**（按键留给输入框）→ `Alt+Shift+←` 真的改变了窗格 widths →
`passwords.importBackup` 路由可达（headless 下文件框直接返回取消；`exportBackup` 仍报「尚未创建密码库」）。

## 7. 遗留 / 未覆盖

1. **`pickJsonFile` 的真对话框**只被单测（mock dialog）覆盖；真机上「选文件 → 读到内容」这一步靠 `logseq.pickGraph` 同一套
   `showOpenDialog` 先例，未在 headless 里验（headless 无真实文件框）。
2. 书签/密码导入的**真机全流程**（手动点按钮 → 选文件 → 落盘）未验；需要人机交互。
3. 笔记页 `JournalView.vue` 的分屏键是手写表，未复用 `matchSplitHotkey` → **分屏也吃自动重复**（长按方向键会连续嵌套）。
   本次不动（跨出本条需求）。
4. `.wsync/state.json` 在本次会话中被同步守护进程改写（内容含旧 `out/` 哈希与已删的 adblock 文件），**与本次改动无关**，未处理。

## 8. 文档同步点（易漏）

- 「设置页保持原样」这类措辞共 5 处：`README.md:437`、`README.md:504`、`docs/ARCHITECTURE.md:816`、`:832`、`src/shared/shortcutCatalog.ts:96`。
  （`README:428` / `ARCHITECTURE:826` 说的是 `Ctrl+←/→` 历史前进后退，它**确实**在设置页也接管，不要误改。）
- 矩阵：`ARCHITECTURE §5.8` 的 `bookmarks` 行（+`import`、settingsSections `BookmarksSettings`）与 `passwords` 行（+`importBackup`）；
  src 树加 `pickJsonFile.ts` 与 `renderer/src/lib/splitKeys.ts`。
