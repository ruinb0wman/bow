# 密码插件（`passwords`）实施方案

- 日期：2026-09-30
- 模式：plan（本文件只描述要做什么，未改任何源码）
- 已定决策（用户拍板）：
  1. 加密：**主密码 + scrypt + AES-256-GCM**（不依赖系统钥匙串）
  2. 交互：**页内下拉 + 快捷键**，保存走面板（显式「从当前页面保存」，不做常驻提交监听）
  3. AI：**完全不暴露 MCP 工具**
  4. 附加能力：**密码生成器**（不做导入 / TOTP / 安全审计）

---

## 1. 目标与假设

**目标**：给 bow 加一个内置插件，用一个主密码解锁的本地密码库，在登录页一键填入账号密码，并提供增删改查、搜索、生成强密码与复制（带剪贴板自动清除）。

**假设**（若与实际不符请纠正）：

- 单机自用，不同步、不联网。密码库文件就是 `userData/passwords.json` 的密文，可直接复制做备份。
- 用户接受「忘记主密码 = 密码库作废」（无恢复、无后门）。设置页提供「清空密码库」作为唯一逃生口。
- 只在 `http/https` 页面填入；`bow://` 内部页、`devtools://`、`file://` 一律跳过。
- 第一版不处理「多步登录」（先输用户名、下一页才输密码）的跨页状态，也不处理同页多个登录表单的智能消歧（取第一个可见密码框所在表单）。

---

## 2. 现状依据（读过的代码，不是猜的）

| 事实 | 出处 |
| --- | --- |
| 插件两侧契约与内核能力表 | `src/main/plugins/types.ts`、`src/shared/plugins.ts`、`docs/ARCHITECTURE.md` §5.1–5.4 |
| 插件目录边界由测试强制：`main.ts` 不得引 `.vue`/`@renderer`，`ui.ts` 不得引 `electron` | `tests/pluginBoundaries.test.ts` |
| `tsconfig.node.json` 的 `include` **只收录固定文件名**（`main.ts`/`shared.ts`/`scripts.ts`/`picker.ts`/…）；新增脚本名必须登记 | `tsconfig.node.json`、`docs/ARCHITECTURE.md` §5.7 |
| **普通网页标签没有 preload**（只有内部页有） | `src/main/tabManager.ts:241-244`（`...(internalId ? { preload } : {})`）注释「普通网页标签坚决不给 preload」 |
| 因此页面 ↔ 主进程**没有 IPC 通道**；唯一通路是 `ctx.pages.execute`（主世界执行 JS），返回值可以是**一个长期 pending 的 Promise** | `src/main/index.ts:241-266`（带 `timeoutMs`）、`src/plugins/element-fullscreen/main.ts`（picker 用 `timeoutMs: 600_000` 等用户点击） |
| 注入脚本约定：不用反引号与 `${}` 插值，数据经 `JSON.stringify` 内联，`String.raw` 保留反斜杠 | `src/plugins/element-fullscreen/scripts.ts` 顶部注释 |
| 表单填入必须用**原生 value setter + `input`/`change` 事件**（受控输入框） | `src/main/pageScripts.ts` 的 `TYPE_FN` |
| 存储 `JsonStore`：`userData` 下、`.tmp`→`rename` 原子写、浅合并默认值；接口只有 `get/set/setRaw` | `src/main/stores.ts`、`docs/ARCHITECTURE.md` §8 |
| 插件 private storage 按**文件名**缓存；`compact` 以首次请求为准 | `docs/ARCHITECTURE.md` §5.2 |
| 工具栏按钮能直接 `api.showOverlay({id:'plugin:<id>:panel', placement:'full'})`；主进程**不能**开浮层 | `src/plugins/quark/ui/QuarkButton.vue`、`src/main/overlay.ts` |
| 浮层 `close-request` 由主进程统一处理，插件不必注册 | `src/main/ipc.ts:249-252` |
| 主进程发事件到 chrome 的形状是 `{id, event, args}` | `src/main/plugins/kernel.ts:389-391`、`ElementFullscreenButton.vue:82-89` |
| `Ctrl+Shift+P` **空闲**：`matchTabHotkey` 只认 `Ctrl+Shift+T/L/E`，分屏认方向键，DevTools 认 I/F12，终端另有放行表 | `src/shared/shortcuts.ts:88-130` |
| 插件注册表：id 必须 `^[a-z][a-z0-9-]*$` 且唯一 | `src/main/plugins/core.ts:16,21-23` |
| `tsconfig.web.json` 也包含 `src/plugins/*/shared.ts` → **`shared.ts` 不能引 `node:crypto`** | `tsconfig.web.json` |
| 新插件登记三处：`BUILTIN_PLUGINS` / `PLUGIN_UI`（+可选 `SLOT_PLUGIN_ORDER`）/ 文档 | `src/main/plugins/builtin.ts`、`src/renderer/src/plugins/registry.ts:21-43`、README「新增一个插件」 |

---

## 3. 安全与数据模型

### 3.1 两个文件（沿用 downloads 插件的「数据 + 设置」双文件惯例）

| 文件 | 内容 | 是否密文 |
| --- | --- | --- |
| `passwords.json` | `VaultFile`：KDF 参数（盐非机密）+ 校验块 + 条目密文 | KDF 参数与 GCM 的 iv/tag 明文，**明文条目为零** |
| `passwords-settings.json` | `{ autoLockMinutes, clipboardClearSeconds, matchSubdomains, showGenerator }` | 非机密 |

```ts
// vault 内层明文（只在内存里以对象形态存在）
interface PasswordEntry {
  id: string            // crypto.randomUUID()
  title: string         // 展示名，默认取 origin 主机名
  origin: string        // 匹配键：URL.origin（scheme + host + port）
  username: string
  password: string
  notes?: string
  createdAt: number
  updatedAt: number
  usedAt?: number
}

// 落盘形态
interface VaultFile {
  version: 1
  kdf: { algo: 'scrypt'; salt: string /*b64*/; N: number; r: number; p: number; keyLen: number } | null
  verifier: { iv: string; tag: string; ct: string } | null   // 加密的是常量 'bow-passwords-v1'
  data: { iv: string; tag: string; ct: string } | null       // 加密的是 JSON.stringify({ entries })
}
```

### 3.2 加密细节（`vault.ts`，node:crypto）

- `scryptSync(master, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })`
  ⚠️ **必须显式给 `maxmem`**：所需内存 = `128 * N * r` = 32 MiB，正好触到 Node 的默认上限 32 MiB 会直接抛错。
- 每个新密钥用 `randomBytes(16)` 新盐；每次落盘用 `randomBytes(12)` 新 IV（GCM）。
- AES-256-GCM：`createCipheriv('aes-256-gcm', key, iv)` → `ct = update+final`、`tag = getAuthTag()`；解密时 `setAuthTag`，`final()` 会因 tag 不符抛错 → 这就是**防篡改**。
- 解锁流程：`deriveKey(master, file.kdf)` → 解 `verifier` → `timingSafeEqual` 比对常量 → 成功才解 `data`。
- 主密码**不落盘**；`key`（Buffer）与 `entries`（对象）只活在主进程内存。
- `lock()`：`key.fill(0)` 清零 + `entries = []`。
- 「修改主密码」：用旧主密码解出 entries → 新盐推导新 key → 重封 verifier+data → 覆盖写。
- 「清空密码库」：`setRaw({version:1, kdf:null, verifier:null, data:null})` + 锁。

### 3.3 站点匹配

- 页面 `new URL(tab.url).origin` 与条目 `entry.origin`：
  - 精确相等 → 命中；
  - `matchSubdomains`（默认开）时，页面 host 以 `'.' + 条目host` 结尾且**条目 host 至少两段** → 命中（`page: accounts.google.com` 命中 `entry: google.com`）。
- 反向不成立（条目 `accounts.google.com` 不会命中页面 `google.com`）。
- **不引入公共后缀表（PSL）**：后缀匹配已覆盖个人使用的主场景，多标签全等匹配可兜底；这是刻意的取舍。

### 3.4 内存与生命周期

- `locked` 初始为 true；`initialized = file.kdf != null`。
- 自动锁定：`setTimeout` 重置于每次需要解锁态的操作；`autoLockMinutes` ∈ {1,5,15,30,60,0=不锁}，默认 5。
- 剪贴板自动清除：主进程 `clipboard.writeText(secret)`，`clipboardClearSeconds`（默认 30，0=不清）后若 `clipboard.readText() === secret` 则 `clipboard.clear()` —— 用户已经复制了别的东西就不覆盖。
- `deactivate` 里：清 timer、`lock()`、清所有 pending picker 记录（本插件的自有资源）。

---

## 4. 文件清单

### 新增

| 文件 | 作用 |
| --- | --- |
| `src/plugins/passwords/vault.ts` | node:crypto 加解密 + KDF + `VaultFile` 类型（**main-only**） |
| `src/plugins/passwords/shared.ts` | 同构纯逻辑：`PasswordEntry` 类型、origin 匹配、条目归一化/去重、密码生成器（**不引 node 模块**） |
| `src/plugins/passwords/scripts.ts` | 注入脚本字符串：探测 / 下拉 / 填入 / 读字段 / 拆除 |
| `src/plugins/passwords/main.ts` | `PluginMain`：状态机 + IPC + 快捷键 + `pages.execute` 编排 |
| `src/plugins/passwords/ui.ts` | UI 贡献：toolbar 按钮 + `plugin:passwords:panel` 全窗浮层 + 设置分区 |
| `src/plugins/passwords/ui/PasswordsButton.vue` | 工具栏按钮（点击走 `beginFill`；监听 `open-panel` 事件开浮层） |
| `src/plugins/passwords/ui/PasswordsPanel.vue` | 主面板：解锁/创建 → 列表/搜索/编辑/生成器/填充/保存当前页 |
| `src/plugins/passwords/ui/EntryEditor.vue` | 条目表单（含生成器、显示/隐藏密码） |
| `src/plugins/passwords/ui/PasswordsSettings.vue` | 设置分区（自动锁定 / 剪贴板 / 子域匹配 / 改主密码 / 清空） |
| `tests/passwordVault.test.ts` | 加解密往返、错主密码、篡改检测、改主密码 |
| `tests/passwordShared.test.ts` | origin 匹配、归一化、生成器字符集/长度/去偏 |
| `tests/passwordScript.test.ts` | 注入脚本语法 + 内联安全 + 关键结构 |
| `tests/passwordPlugin.test.ts` | fake ctx：IPC 表、能力声明、锁定时拒绝、存取往返 |

### 修改

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `src/main/plugins/builtin.ts` | `BUILTIN_PLUGINS` 末尾追加 `passwords` | 只贡献 UI + 快捷键，不参与网络钩子/建议源顺序（与 `device-inspect`/`terminal`/`logseq`/`downloads`/`quark` 同款注释） |
| `src/renderer/src/plugins/registry.ts` | `PLUGIN_UI` 追加 `passwordsUi`；`SLOT_PLUGIN_ORDER.toolbar` 追加 `'passwords'` | 新插件默认追加末尾，但 toolbar 是显式白名单，不写就不会显示 |
| `tsconfig.node.json` | `include` 追加 `"src/plugins/*/vault.ts"` | 否则 `tsc -p tsconfig.node.json` 看不到它（§5.6 的硬约束） |
| `src/shared/shortcutCatalog.ts` | `view` 组加一条 `Ctrl+Shift+P` | 设置页「快捷键」是唯一展示源；冲突代价必须写在这里 |
| `README.md` | 插件体系一节加「密码插件」；「手动使用快捷键」加一行；开头内置插件清单加「密码」 | 文档与实现同步 |
| `docs/ARCHITECTURE.md` | §5.8 贡献矩阵加行；§8 存储表加两行 | 同上 |

---

## 5. 详细设计

### 5.1 `vault.ts`（纯 node，可单测，不引 electron）

```ts
export const KDF_DEFAULTS = { algo: 'scrypt', N: 1 << 15, r: 8, p: 1, keyLen: 32 } as const
export const SCRYPT_MAXMEM = 64 * 1024 * 1024
export const VERIFIER_TEXT = 'bow-passwords-v1'

export type VaultFile = { version: 1; kdf: KdfParams | null; verifier: Sealed | null; data: Sealed | null }
export const EMPTY_VAULT: VaultFile = { version: 1, kdf: null, verifier: null, data: null }

export function deriveKey(master: string, p: KdfParams): Buffer
export function createVault(master: string, entries: PasswordEntry[]): { file: VaultFile; key: Buffer }
export function unlockVault(file: VaultFile, master: string): Buffer | null   // 校验失败返回 null
export function openEntries(key: Buffer, file: VaultFile): PasswordEntry[]
export function sealEntries(key: Buffer, entries: PasswordEntry[]): Sealed
export function reseal(file: VaultFile, key: Buffer, entries: PasswordEntry[]): VaultFile
export function changeMaster(file: VaultFile, oldKey: Buffer, entries: PasswordEntry[], newMaster: string): { file: VaultFile; key: Buffer }
```

- `openEntries` 解出的 JSON 必须过 `normalizeEntries()`（来自 `shared.ts`）：过滤缺字段、补时间戳、`id` 去重 —— 坏数据不炸面板。
- 解密失败一律抛统一错误，`main.ts` 翻译成「主密码不正确或文件已损坏」。

### 5.2 `shared.ts`（同构纯逻辑，**不引 node: / electron**）

```ts
export interface PasswordEntry { /* 见 §3.1 */ }
export type EntryMeta = Omit<PasswordEntry, 'password'>

export function originOf(url: string): string | null          // 仅 http/https 返回 origin
export function entryMatchesOrigin(entryOrigin: string, pageOrigin: string, subdomains: boolean): boolean
export function matchEntries(entries: PasswordEntry[], pageOrigin: string, subdomains: boolean): PasswordEntry[]
export function normalizeEntries(raw: unknown): PasswordEntry[]
export function normalizeSettings(raw: unknown): PasswordSettings
export function generatePassword(opts: GenerateOptions, randomBytes?: (n: number) => Uint8Array): string
```

- `generatePassword`：默认 `{length:20, upper:true, lower:true, digits:true, symbols:true, avoidAmbiguous:true}`；字符集拼接后用 **拒绝采样**（`limit = 256 - (256 % charset.length)`）消除取模偏差；随机源默认 `globalThis.crypto.getRandomValues`（Node ≥19 与浏览器都有），测试注入确定性随机。
- `normalizeSettings` 夹紧：`autoLockMinutes` 限定在允许集合、`clipboardClearSeconds` 0–600、布尔兜底。

### 5.3 `scripts.ts`（注入脚本，主世界执行；遵循 `String.raw` + `JSON.stringify` 约定）

| 脚本 | 输入 → 返回 | 要点 |
| --- | --- | --- |
| `DETECT_JS` | `→ { ok, url, hasPassword, hasUsername, fields:[{kind,selector,name,autocomplete}] }` | **绝不返回任何字段的值**；只认可见元素；密码框取第一个可见的 |
| `buildPickerScript(candidates, anchorKind)` | `Promise<{entryId}|{cancelled:true}>` | Shadow DOM（closed 优先 `attachShadow`）+ `adoptedStyleSheets` 躲 CSP；锚在密码框（无密码框则用户名字段）下方，`getBoundingClientRect` + fixed 定位；↑/↓/Enter/Esc 与点选；滚动/缩放时重定位；`candidates` 只含 `{id,title,username}`（**不含密码**） |
| `buildFillScript({username, password})` | `{ ok, filled:{username,password}, error? }` | 重新探测字段；用 `HTMLInputElement.prototype` 的原生 setter 赋值 + 派发 `input`/`change`（照 `TYPE_FN` 的做法，兼容 React/Vue 受控框）；填完 focus 密码框 |
| `READ_FIELDS_JS` | `{ ok, url, username, password, hasPassword }` | 唯一读取密码值的脚本，只由面板的「从当前页面保存」显式触发 |
| `PICKER_TEARDOWN_JS` | `→ true` | 移除 picker host；切标签/导航/超时时调用 |

- 脚本内**禁止反引号与 `${}`**；一切值经 `JSON.stringify` 内联（`picker`/`fill` 都是 `buildXxx` 函数拼接）。
- 已知边界（写进 README）：跨域 iframe 内、closed shadow root 内的密码框找不到（与 adblock/元素全屏同款限制）。

### 5.4 `main.ts`：状态机与 IPC

内部状态：
```ts
let store: PluginStorage<VaultFile> | null
let settingsStore: PluginStorage<PasswordSettings> | null
let key: Buffer | null          // 解锁后存在
let entries: PasswordEntry[] = []
let lockTimer: NodeJS.Timeout | null
let pickerTab: number | null    // 同一时刻只允许一个 picker
```

`capabilities: ['ui', 'shortcut']`（声明性，仅影响设置页标签）。

IPC（`ctx.ipc.handle`，渲染层用 `plugins.invoke('passwords', method, ...args)`）：

| method | 签名 → 返回 | 说明 |
| --- | --- | --- |
| `status` | `→ { initialized, locked, count, settings }` | 面板/按钮挂载时拉 |
| `setup` | `(master) → {ok, error?}` | 首次创建（要求 `!initialized`） |
| `unlock` | `(master) → {ok, error?}` | scrypt 失败给统一文案；连续失败 5 次后加 1s 退避（内存计数，可选加固） |
| `lock` | `→ {ok}` | |
| `list` | `→ EntryMeta[]` | 不含密码；未解锁 → `{ok:false,error:'已锁定'}` 形状统一为 `{ok,data,error}` |
| `getEntry` | `(id) → PasswordEntry \| null` | 编辑用，需解锁 |
| `save` | `({id?, title, origin, username, password, notes?}) → {ok, id}` | id 存在=更新（`password` 为空串表示保留原值），否则新建；`usedAt` 不在这里改 |
| `remove` | `(id) → {ok}` | |
| `copy` | `(id, 'username'\|'password') → {ok, clearsIn}` | 主进程 `clipboard`；更新 `usedAt` |
| `readPageFields` | `(tabId?) → {ok, origin, title, username, password, hasPassword}` | 面板「从当前页面保存」 |
| `fillEntry` | `(id, tabId?) → {ok, filled?, error?}` | 二次校验：解锁 + origin 匹配 + `http/https`；不匹配直接拒绝 |
| `beginFill` | `(tabId?) → {ok, mode, error?}` | 按钮/快捷键主流程，见下 |
| `changeMaster` | `(oldMaster, newMaster) → {ok, error?}` | |
| `getSettings` / `setSettings` | `→ PasswordSettings` | 同时重置 lockTimer |
| `wipe` | `→ {ok}` | 面板/设置里二次确认后调用 |
| `overlay-event` | `(overlayId, event, args)` | 目前只为「面板想主动关自己」留位；`close-request` 由主进程统一处理，不注册也行 |

`beginFill` 流程（按钮点击与 `Ctrl+Shift+P` 共用）：

```text
tab = tabId ?? ctx.pages.activeTabId()           // 无活动标签 → {ok:false, mode:'no-tab'}
!isHttp(tab.url)                                 → {ok:false, mode:'unsupported'}
!initialized                                     → emit('open-panel', {mode:'setup'});  返回 {ok:false,mode:'setup'}
locked                                           → emit('open-panel', {mode:'unlock'}); 返回 {ok:false,mode:'locked'}
detect = pages.execute(tab.id, DETECT_JS)
!detect.hasPassword && !detect.hasUsername       → emit('open-panel', {mode:'save'});   返回 {ok:false,mode:'no-form'}
matched = matchEntries(entries, originOf(tab.url), settings.matchSubdomains)
matched.length === 0                             → emit('open-panel', {mode:'save'});   返回 {ok:false,mode:'no-match'}
matched.length === 1 && picker 未占用            → 直接 buildFillScript 填入 → {ok:true, mode:'filled'}
否则                                             → pages.execute(buildPickerScript(...), {timeoutMs:120_000})
                                                     await {entryId} / {cancelled}
                                                     解锁态仍成立才填（自动锁定竞态）
                                                     → {ok:true, mode:'picked'} / {ok:false, mode:'cancelled'}
```

- `emit('open-panel', payload)` 是「主进程想开浮层」的唯一通路：`PasswordsButton.vue` 常驻 chrome 并监听该事件，收到后 `api.showOverlay({ id:'plugin:passwords:panel', payload, placement:'full' })`。
- 事件：`ctx.ipc.emit('state-changed', { initialized, locked, count })` 在 setup/unlock/lock/save/remove/wipe 后发；`settings-changed` 单独发。
- `tab:navigated` / `tab:closed`：清 `pickerTab`，并对仍在 picker 的标签补一次 `PICKER_TEARDOWN_JS`（尽力而为，页面可能已销毁）。
- 快捷键：`ctx.shortcuts.register({ key:'p', code:'KeyP', ctrl:true, shift:true }, () => void beginFill())`。
- `deactivate`：清 timer、`lock()`、清 `pickerTab`。

### 5.5 渲染层

- `ui.ts`：
  ```ts
  export default {
    id: 'passwords',
    slots: { toolbar: [PasswordsButton] },
    overlays: [{ id: 'plugin:passwords:panel', component: PasswordsPanel, placement: 'full' }],
    settingsSections: [PasswordsSettings]
  }
  ```
- `PasswordsButton.vue`：`KeyRound` 图标；点击 `invoke('beginFill')`，返回 `mode` 属于 `setup|unlock|no-form|no-match` 时开浮层（带上 `payload.mode`）；监听 `plugins.onEvent` 的 `open-panel`。
- `PasswordsPanel.vue`：三态视图 ——
  1. 未初始化 → 「创建主密码」+ 二次确认输入；
  2. 已锁定 → 解锁输入框（`autofocus`，Enter 提交，错误内联提示）；
  3. 已解锁 → 顶部搜索（本地过滤 `title/origin/username`）+ 「新增」+ 「从当前页面保存」（调 `readPageFields`，成功则打开预填编辑器）+ 列表（行内：站点、用户名、复制用户名/密码、填入当前页、编辑、删除）+ 折叠的生成器。
  - 顶部显示自动锁定说明与「立即锁定」。
  - 复制密码后显示「已复制，N 秒后清除」。
- `EntryEditor.vue`：字段表单 + 生成器（长度滑条 8–64、四类字符开关、避开易混字符、重新生成、一键填入表单）；保存时若 `origin` 为空则由用户输入或从当前标签取。
- `PasswordsSettings.vue`：自动锁定时间、剪贴板清除秒数、子域匹配开关；修改主密码（旧/新/确认）；危险区「清空密码库」（要求手输 `DELETE` 或勾选确认）；说明文案：文件位置、**忘记主密码无法恢复**、备份就是复制 `passwords.json`。

### 5.6 快捷键与冲突

- 采用 `Ctrl/Cmd+Shift+P`。它当前空闲（见 §2 依据）。
- **已知代价**：网页 IDE（VS Code Web / vscode.dev 等）的「命令面板」也是这个组合。与元素全屏抢 `Ctrl+Shift+F` 属同一类取舍，必须在 `shortcutCatalog.ts` 的 `note` 与 README 里写明。
- 备选（若你更在意 IDE）：`Ctrl+Shift+K`（部分编辑器是插入链接）或不做全局键、只留工具栏按钮 —— 改一行即可，方案不依赖具体键位。

---

## 6. 实施步骤（每步独立可验证）

1. **`vault.ts` + `tests/passwordVault.test.ts`**
   - 往返：`createVault` → `unlockVault` → `openEntries` 恢复原 entries；
   - 错主密码返回 null；改一个字节的 `ct`/`tag` 后解锁或解 entries 抛错（GCM 防篡改）；
   - `changeMaster` 后旧主密码失效、新主密码可用、entries 不变；
   - 断言 `kdf.N === 1<<15` 且派生调用带 `maxmem`（防止日后被「优化」掉）。
   - 验证：`npx vitest run tests/passwordVault.test.ts`

2. **`shared.ts` + `tests/passwordShared.test.ts`**
   - 匹配：精确命中、子域命中、关闭子域后不命中、`accounts.google.com` 不命中条目 `google.com`、非 http(s) 返回 null；
   - `normalizeEntries` 抗坏数据；`normalizeSettings` 夹紧；
   - 生成器：长度、字符集开关、`avoidAmbiguous` 时不含 `0O1lI`、注入固定随机时结果确定、拒绝采样不越界。
   - 验证：`npx vitest run tests/passwordShared.test.ts`

3. **`scripts.ts` + `tests/passwordScript.test.ts`**
   - `new Function(code)` 对五个脚本都不抛（照 `elementFullscreenScript.test.ts` 的做法）；
   - 含引号/反斜杠/非 ASCII 的 username/title/id 经 `buildPickerScript` 内联后语法仍有效且保留原文；
   - 断言 `buildPickerScript` 结果里**不包含** `password` 值、含 `attachShadow`/`new Promise`；`buildFillScript` 含原生 setter 与 `dispatchEvent`；`READ_FIELDS_JS` 含 `.value`。
   - 验证：`npx vitest run tests/passwordScript.test.ts`

4. **`main.ts` + `builtin.ts` + `tests/passwordPlugin.test.ts`**
   - fake ctx（照 `elementFullscreenPlugin.test.ts` 的形状）+ 真实 `vault`；
   - 断言：manifest/`capabilities` 正确；注册的路由集合与 §5.4 表一致；`shortcuts` 注册 1 次；未初始化时 `unlock` 报错、`list` 被拒；`setup`→`save`→`list`（无 password 字段）→`getEntry`→`copy`→`remove` 往返；
   - `fillEntry` 在 origin 不匹配 / 页面非 http 时拒绝，且**不调用** `pages.execute`；
   - `beginFill` 在 locked / no-match 时发出 `open-panel` 事件。
   - 验证：`npx vitest run tests/passwordPlugin.test.ts`

5. **`ui.ts` + 四个 `.vue` + `registry.ts` + `tsconfig.node.json`**
   - 登记 `PLUGIN_UI`、`SLOT_PLUGIN_ORDER.toolbar`、`tsconfig.node.json` 的 `vault.ts`。
   - 验证：`npm run typecheck`（两个 tsconfig 都过）。

6. **`shortcutCatalog.ts`**
   - `view` 组新增 `Ctrl+Shift+P` 条目与冲突说明。
   - 验证：`npx vitest run tests/shortcutCatalog.test.ts`（若该测试对组内容有快照/数量断言，同步更新）。

7. **门禁**：`npm run typecheck` → `npm test` → `npm run build`。
   - 预期既有失败仍是那条与本功能无关的 Node 26 `mcpHttp` DNS-rebinding 用例。

8. **人工验证清单**（在真机或 `LD_LIBRARY_PATH` 方案下跑 dev）
   - 创建主密码 → 重启 → 仍锁定 → 解锁成功；
   - 新增站点条目 → 打开一个真登录页（本地起个含 password 表单的静态页最省事）→ `Ctrl+Shift+P` → 页内下拉出现且位置贴合密码框 → 选中后用户名/密码都填对、受控输入框（React 页面）也生效；
   - 工具栏按钮在无匹配页 → 打开面板并进「保存当前页」；
   - 自动锁定到点后按钮/面板回到锁定态、填充被拒；剪贴板在 N 秒后清空；「清空密码库」后回到未初始化。
   - ⚠️ 本开发容器缺 ALSA，真机验证需要 ALSA 的 `LD_LIBRARY_PATH` 方案（MEMORY.md 环境节）。

9. **文档**：README（密码插件一节 + 快捷键一行 + 内置插件清单）、`ARCHITECTURE.md` §5.8/§8。

---

## 7. 测试与门禁

- 新增 4 个测试文件（§6.1–6.4），全部走 `vitest run`，不依赖 electron。
- `tests/pluginBoundaries.test.ts` 会自动发现新目录并对 `main.ts`/`ui.ts` 施加边界断言 —— 无需改动，但**设计上必须满足**：`main.ts` 不引 `.vue`/`@renderer`，`ui.ts` 不引 `electron`。
- `tsconfig.node.json` 的 include 不登记 `vault.ts` 会让 `npm run typecheck` 失败（这是 §5.6 的硬约束，不是可选项）。

---

## 8. 风险、未知与限制

| 项 | 说明 | 处理 |
| --- | --- | --- |
| 主密码不可恢复 | 无后门、无找回 | 设置页显著提示；文档给「就是 `passwords.json`，复制即备份」 |
| 不处理跨域 iframe / closed shadow root 的密码框 | 与 adblock、元素全屏同款浏览器限制 | 文档写明；探测脚本找不到就当作「无表单」 |
| 多步登录（用户名 → 下一页密码） | 第一页无密码框，只有用户名字段 | v1：仍能填入用户名；第二页再按一次快捷键。文档写明 |
| 受控输入框 / 反自动化站点 | 部分站点监听 `isTrusted` 或自定义事件 | 用原生 setter + `input`/`change`；不保证 100%，失败时脚本返回 `filled:false` 并提示「请手动复制」 |
| `Ctrl+Shift+P` 抢网页 IDE 的命令面板 | 全局热键在 `before-input-event` 层就吃掉 | `shortcutCatalog` 的 `note` + README 写清代价；备选键位见 §5.6 |
| 自动锁定与 picker 竞态 | picker 打开期间到点锁定 | 填之前**再查一次解锁态**；已锁定则丢弃选择、转 `open-panel` |
| 面板在渲染层持有明文密码 | overlay 是 bow 自己的受信任渲染层（与终端/笔记同级） | 只按需 `getEntry`，列表默认不返回密码；不做持久化 |
| 多窗口 | 插件是进程级单例（`activateEnabled` 只跑一次），vault 状态全局 | 一个窗口解锁 = 全部窗口解锁；面板按窗口开。行为一致，无需额外处理 |
| scrypt 参数与内存 | `N=2^15` 约几十毫秒；忘给 `maxmem` 会抛错 | 参数写进 `KdfParams` 落盘，日后可迁移；测试钉住 `maxmem` |
| 剪贴板清除可能与用户操作打架 | 清除前比对内容 | 内容已变就不动 |

---

## 9. 明确的非目标（v1 不做）

- 不提供任何 MCP 工具（AI 完全拿不到密码库）。
- 不做导入（Chrome/Edge CSV）、导出、TOTP、安全审计、泄露检测。
- 不做同步/云、不做多设备、不做生物识别、不接系统钥匙串。
- 不做网页自动提交登录表单（只填不点）。

---

## 10. 实施记录（2026-09-30）

按 §6 的顺序落地,新增 10 个文件、改动 7 个既有文件(其余工作区改动来自更早的会话,不是本次引入):

**新增**
- `src/plugins/passwords/{shared,vault,scripts,main}.ts`、`ui.ts`、`ui/{PasswordsButton,PasswordsPanel,EntryEditor,PasswordsSettings}.vue`
- `tests/password{Vault,Shared,Script,Plugin}.test.ts`

**修改**
- `src/main/plugins/builtin.ts`(登记,末尾)、`src/renderer/src/plugins/registry.ts`(`PLUGIN_UI` + `SLOT_PLUGIN_ORDER.toolbar`)、`tsconfig.node.json`(`vault.ts` 进 include)、`src/shared/shortcutCatalog.ts`(`Ctrl+Shift+P`)、`README.md`、`docs/ARCHITECTURE.md`(§5.8 两张表 / §8 存储表 / toolbar 顺序)

**实现期修正(相对方案)**
1. Electron 44 的 `clipboard.writeText/readText` 是 **Promise 型**(W3C 风格),`copy` 处理器因此是 async;`readText()` 在 `unlock`/`copy` 里都要 `await`。
2. 「数据内联」的测试断言要针对脚本**正文**,不能对整个字符串断言 `.value` —— 共享的字段助手 `__bowPwSetValue` 里本来就有 `value`(赋值,不是读取)。

**门禁**
- `npm run typecheck` ✓(node + web 两个 project)
- `npm test`:**1231 passed**,仅剩既有的 Node 26 `tests/mcpHttp.test.ts` DNS-rebinding 失败(与本次无关)
- `npm run build` ✓;确认 `node:crypto` 的 `scryptSync`/`aes-256-gcm` **只出现在** `out/main/index.js`,渲染层与 preload 产物里没有
- **真 Electron E2E**(临时脚本,已删):`LD_LIBRARY_PATH=~/.cache/bow-alsa/usr/lib` + `--ozone-platform=headless` + 独立 `--user-data-dir`,本地起真 HTTP 登录页,CDP 驱动。27 条断言全绿:
  插件注册启用 / 工具栏按钮渲染 / 创建密码库 / 列表 2 条且投影无密码 / `passwords.json` 已写且**磁盘无明文**且有 scrypt 参数 /
  页内下拉出现且只列用户名 / 点选后用户名与密码都填对 / 下拉与 `window.__bowPasswordPicker` 已清理 /
  锁定时 `beginFill` 返回 `locked` / 错主密码拒绝、对主密码成功 / 单条匹配直接填入 / `copy` 正常。

**尚未验证(留给真机/后续)**
- 跨域 iframe / closed shadow root 的密码框(预期找不到,同款已知限制);
- 多步登录(用户名 → 下一页密码)的第二页填充;
- 浏览器自动填充/密码管理器共存场景(未做)。
