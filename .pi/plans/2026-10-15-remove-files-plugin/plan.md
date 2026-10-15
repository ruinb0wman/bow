# 删除「文件管理」插件(含两个只为它存在的核心 CDP 能力)

> 目标:把 `src/plugins/files/` 及其配套(核心 CDP 能力、测试、文档)从仓库里**彻底**移除。
> 非目标:不动 `files-settings.json` 的数据(不迁移、不重命名)、不动 `browser_download` 的 `saveDir` 语义、
> 不碰 `.pi/plans/2026-10-09-file-manager-plugin/`(历史文档留档)。

## 0. 决策记录(本方案据此展开)

| 问题 | 决定 | 后果 |
| --- | --- | --- |
| 移除深度 | **彻底删源码** | MCP 工具面 **50 → 40**(插件工具 30 → 20);删 ~4400 行 |
| `fileRoots` 白名单(下载插件的 `saveDir` 还在用) | **保留现状,不搬 UI** | 白名单设置形状搬进核心;`files-settings.json` 文件名不变;删掉插件后**没有 UI 能改它** → 必须在文档里写清「手改 json」,并改掉那句指向「设置 → 文件管理」的错误提示 |
| 只为它存在的 `pages.uploadFiles` / `pages.fileChooser`(439 行 + 145 行测试) | **一起删干净** | 内核更瘦;`tabTarget.ts`、`fileOpeners.ts`、`net/content` 钩子**不动**(它们还有别的用处) |

## 1. 影响面一览(改完必须逐条核对)

| 类别 | 位置 |
| --- | --- |
| 删目录 | `src/plugins/files/**`(8 文件 / 2578 行) |
| 删核心实现 | `src/main/pageUpload.ts`(439 行) |
| 删测试 | `tests/filesPlugin.test.ts`(843/58 例)、`tests/filesChooser.test.ts`(250/18 例)、`tests/pageUpload.test.ts`(145/11 例);`tests/filesShared.test.ts`(150/25 例)**部分保留** |
| 登记点(main) | `src/main/plugins/builtin.ts`(import + 数组项 + 注释) |
| 登记点(renderer) | `src/renderer/src/plugins/registry.ts`(import + 数组项 + `SLOT_PLUGIN_ORDER.toolbar` 里的 `'files'`) |
| 内核面 | `src/main/plugins/kernel.ts`(`EMPTY_PAGE_API` 的 `uploadFiles`/`fileChooser`、`ctx.pages` 的同名转发) |
| 类型面 | `src/main/plugins/types.ts`(第 17 行 `pageUpload` 类型 import;`PluginPageApi.uploadFiles` 与 `.fileChooser` 两大段) |
| 装配点 | `src/main/index.ts`(第 19–24 行 import;第 356–383 行 `uploadFiles` 与 `fileChooser` 两个宿主实现) |
| **必须搬走的核心依赖** | `src/main/plugins/fileRoots.ts` 第 23 行 `import { DEFAULT_FILES_SETTINGS, normalizeFilesSettings, type FilesSettings } from '@plugins/files/shared'` —— **这是删目录的唯一硬依赖** |
| LLM 行为契约 | `src/main/mcp.ts` 的 `MCP_INSTRUCTIONS`:三段(`browser_upload` / `browser_fs_*` / 下载段里那句「必须落在 `browser_fs_roots` 列出的工作目录里」) |
| 用户可见文案 | `src/main/plugins/fileRoots.ts:125`(报错里写「可在 bow://settings 的『文件管理』里添加」)、`src/plugins/downloads/ui/DownloadsSettings.vue:133`(「『文件管理』的工作目录」) |
| 注释 | `src/plugins/downloads/main.ts:23-24`(提到「文件管理」插件与 `browser_fs_*`) |
| 文档 | `README.md`(第 3 行功能清单、MCP 工具表 10 行、第 429 行 `saveDir` 行的互引、第 757 行数据文件、第 785 行插件清单、第 838–870 行「文件管理插件」整节)、`docs/ARCHITECTURE.md`(§src 树 73–78、§5.x 能力表 407–408、§5.8 贡献矩阵 567、§5.9 UI 矩阵 585、工具清单 679–680 + 计数、静态计数来源 688、§8 数据文件 981、§13 第 18/36 条、微隔离表相关行)、`packages/pi-bow/skills/bow-browser/SKILL.md`(第 11 行计数、第 39–40 行两行能力索引) |

不需要动的:`.pi/plans/**`(历史)、`<userData>/files-settings.json` 与 `plugins.json` 里可能残留的 `files` 项(与上次删 quark 一样,残留无害)。

## 2. 关键设计:`fileRoots` 的自包含化(先做,否则一删目录就编译不过)

现在 `fileRoots.ts` 从插件目录借三样东西:`FilesSettings` 类型、`DEFAULT_FILES_SETTINGS`、`normalizeFilesSettings()`(它又依赖 `MAX_ROOTS` / `clampListLimit` / `LIST_LIMIT_*`)。

做法:把这**一小撮**搬进 `src/main/plugins/fileRoots.ts` 自身(它本来就负责读这个文件),插件里其余的纯函数(`formatSize` / `sortEntries` / `matchGlob` / `globToRegExp` / `isHiddenName`)随插件一起删。

```ts
// ---------- 设置形状(原在 plugins/files/shared.ts;插件删除后搬进核心) ----------
/** 工作目录数量上限(不让设置文件无限膨胀) */
const MAX_ROOTS = 32

export interface FilesRootsSettings {
  version: number
  roots: string[]
}

export const DEFAULT_FILES_ROOTS_SETTINGS: FilesRootsSettings = { version: 1, roots: [] }

/** 只做**形状**清洗:去空、去首尾空格、去重、丢非字符串、截断上限;路径合法性由 sanitizeRoots() 管 */
export function normalizeFilesRootsSettings(input: unknown): FilesRootsSettings { /* 从 normalizeFilesSettings 摘出 roots 那半 */ }
```

- 文件名**仍是 `files-settings.json`**(零迁移,`tests/fileRoots.test.ts` 的 fixture 不用改)。
- 旧字段 `allowPermanentDelete` / `listLimit` / `interceptFileChooser` 从此**只读不认**(归一化直接丢掉)。因为**删除后已无任何写入方**(全仓库唯一 writer 是插件自己的 `store.setRaw`),这三个键只会在老 json 里静静躺着,不影响判定。
- 后果写进文档:想再加工作目录 → 手改 `<userData>/files-settings.json` 的 `roots` 数组(生效白名单 = `roots` ∪ 下载目录)。

## 3. 执行顺序(每步做完都应能编译)

**步骤 1 — 核心自包含化**
1. `fileRoots.ts`:按 §2 内联类型与归一化,删掉对 `@plugins/files/shared` 的 import。
2. `fileRoots.ts:125` 的 `checkPath` 报错文案改成不指向已不存在的设置页,例:`路径不在允许的工作目录内:${abs}(白名单见 <userData>/files-settings.json)`。
3. `tests/fileRoots.test.ts`:把 `tests/filesShared.test.ts` 里 `normalizeFilesSettings` 那个 describe(5 例)改写 3 条核心版用例并入(坏输入退化 / roots 清洗 / roots 上限),然后删除 `tests/filesShared.test.ts`。

**步骤 2 — 摘登记点**
4. `src/main/plugins/builtin.ts`:删 `import files`、数组里的 `files,` 及其上方那行注释。
5. `src/renderer/src/plugins/registry.ts`:删 `import filesUi`、数组项 `filesUi,`、`SLOT_PLUGIN_ORDER.toolbar` 末尾的 `'files'`。

**步骤 3 — 删两个核心 CDP 能力**
6. `src/main/index.ts`:删第 19–24 行整段 import;删 `pages` 宿主里的 `uploadFiles` 与 `fileChooser` 两个成员(第 356–383 行,注意保留对象字面量的逗号结构;`openDevToolsTab` 前后邻居不动)。
7. `src/main/plugins/types.ts`:删第 17 行 `import type { ArmResult, FileChooserOpenedInfo, PageUploadResult } from '../pageUpload'`;删 `PluginPageApi.uploadFiles` 与 `.fileChooser` 两段(含注释)。
8. `src/main/plugins/kernel.ts`:`EMPTY_PAGE_API` 里删 `uploadFiles` 与 `fileChooser` 两项;`ctx.pages`(约 529–534 行)删同名两项。
9. 删 `src/main/pageUpload.ts` 与 `tests/pageUpload.test.ts`。

**步骤 4 — 删插件与它的测试**
10. 删 `src/plugins/files/**`、`tests/filesPlugin.test.ts`、`tests/filesChooser.test.ts`。

**步骤 5 — 契约与文案**
11. `src/main/mcp.ts`:删 `上传本地文件到网页(browser_upload)` 与 `本地文件(browser_fs_*)` 两段;下载段那句 `**saveDir 必须落在 browser_fs_roots 列出的工作目录里**` → 改成「必须落在 bow 的下载目录或 `files-settings.json` 里配置的工作目录内(越界会被拒)」。
12. `src/plugins/downloads/main.ts:23-24` 注释:`落盘位置必须过「文件管理」插件那份白名单(与 browser_fs_* 同一套策略)` → 「落盘位置必须过核心的路径白名单(`main/plugins/fileRoots.ts`)」。
13. `src/plugins/downloads/ui/DownloadsSettings.vue:133`:「它指定的 `saveDir` 必须在『文件管理』的工作目录里」→ 改成指向 `files-settings.json` 的表述(否则用户找不到入口)。

**步骤 6 — 文档**
14. `README.md`:第 3 行功能清单去掉「文件管理(工具栏「文件」面板…)」;MCP 工具表删 10 行、并把 `browser_download` 那行的 `browser_fs_roots` 互引改掉;第 757 行数据文件条目改成 **核心** 拥有(写明「生效白名单 = `roots` ∪ 下载目录;没有设置 UI,改 `roots` 需手改此文件」);第 785 行插件清单去掉「文件管理」;删「### 文件管理插件」整节(约 838–870 行)。
15. `docs/ARCHITECTURE.md`:§src 树删 `pageUpload.ts` 行、`fileRoots.ts` 说明改「核心拥有,唯一写入方已随文件管理插件删除,现只读」;能力表删 `pages.fileChooser` / `pages.uploadFiles` 两行;§5.8 与 §5.9 删 `files` 行;工具清单删 `browser_fs_*` / `browser_upload` 与静态计数里的 `files/main.ts:…` 一行,计数 `30 个 / 合计 50` → `20 个 / 合计 40`;§8 数据文件表的 owner 列 `files` → `核心(fileRoots.ts)`,并把字段说明改成「只认 `{version, roots}`」;§13 第 18 条与第 36 条改成历史注记(「该能力已随文件管理插件于 2026-10-15 删除;若将来重建,按此思路:核心出窄能力、插件只做决策」);顺便核对 §13 前的「文档漂移」表里测试文件数/用例数的旧数字。
16. `packages/pi-bow/skills/bow-browser/SKILL.md`:第 11 行 `50 个工具(20 核心 + 30 插件…)` → `40 个工具(20 核心 + 20 插件…)`;删第 39 行(本地磁盘那行)与第 40 行(`browser_upload` 那行)。

## 4. 验证

自动化(按序):
```bash
bun run typecheck                       # 0 错
bun run test                            # 删掉的用例数应当正好对上;不允许新增失败
bun run build                           # electron-vite 绿
npm run test:mcp                        # 冒烟:listTools 里没有 browser_fs_* / browser_upload,总数 40
```
门禁 grep(除文档与 `.pi/plans` 外应为空):
```bash
grep -rn "plugins/files\|browser_fs_\|browser_upload\|pageUpload\|uploadFiles\|fileChooser" src tests scripts
```
真机手验(headless 或直接开 dev,清单要全):
1. 工具栏**没有**「文件」按钮;设置页侧栏**没有**「文件管理」分区;设置 → 插件管理列表**没有** files 行(且插件数 13 → 12)。
2. `browser_download {saveDir: <白名单外目录>}` 仍被拒(错误文案是新版,不再提「设置 → 文件管理」)。
3. 把某个目录写进 `<userData>/files-settings.json` 的 `roots` → 重启 → 同一条 `saveDir` **成功**(证明核心自包含化真的接上了);再删掉该 root → 又被拒。
4. 白名单里的 `browser_download` 不传 `saveDir` 照常落到下载目录。
5. 接管文件选择框的行为应当**完全消失**:点网页上传按钮 → 弹的是系统对话框(不再出现 can't-find 的错误或被吞掉)。

## 5. 回滚

单次 commit(`chore(plugins): 删除文件管理插件…`)里做完 1–6 步;回滚 = `git revert`。没有任何数据迁移,`files-settings.json` 内容与 `plugins.json` 残留都不回滚也安全。

## 6. 风险与已知副作用

- **白名单从「可配」变成「手改」**:这是刻意接受的代价(决策 §0)。文档必须写清楚,否则用户会以为功能坏了。
- `files-settings.json` 变成**只读配置** → 顺手在 `fileRoots.ts` 顶部注释里写明「写入方已删除,只读」,避免将来有人以为哪里有 UI。
- 删掉 `pageUpload.ts` 后,`tabTarget.ts` 的注释仍会自称「核心 MCP 工具与插件 pages.uploadFiles 共用」→ 一并改掉(第 76 行的 ARCHITECTURE 说明同理),否则就是新的文档漂移。
