# 设置页新增「快捷键」参考分区

> 目标(两行):在设置页侧栏「核心分组」里新增第二项 **快捷键**(顺序变为 常规 / 快捷键 / 插件管理),
> 用**纯分类清单**(无搜索框)按组列出 bow 的全部键位:标签、地址栏与导航、分屏与布局、视图与面板、终端、笔记、窗口。
>
> 已确认的决策(用户选择):
> - 收录范围 = **核心 + 终端 + 笔记**(README 的「手动使用快捷键」只覆盖核心,终端/笔记的键位分散在各自章节);
> - 查询交互 = **纯分类清单,无搜索框**(不写过滤函数、不做折叠);
> - 入口位置 = **核心分组第二项「快捷键」**(在「常规」与「插件管理」之间)。
>
> 假设:① 键位**只做展示**,不注册/不改任何 `matchTabHotkey` / 插件热键行为;
> ② macOS 上的 `Ctrl → ⌘` 由页头一行说明覆盖,只有真正平台受限的条目单独加注
> (目前只有 `Ctrl+←/→` 一条:macOS 整体不启用);③ 不收录鼠标操作与关窗确认框按钮(非键盘键位)。

## 0. 已核实的现状(读到的事实)

1. **侧栏导航是纯函数生成的固定两项** —— `src/shared/settingsNav.ts`:

   ```ts
   export const SETTINGS_GENERAL_ID = 'general'
   export const SETTINGS_PLUGINS_ID = 'plugins'
   ...
   export type SettingsNavItem =
     | { id: typeof SETTINGS_GENERAL_ID; label: '常规'; kind: 'general' }
     | { id: typeof SETTINGS_PLUGINS_ID; label: '插件管理'; kind: 'manage' }
     | { id: string; label: string; kind: 'plugin'; pluginId: string; core: boolean }
   ...
   export function buildSettingsNav(items: SettingsNavInput[]): SettingsNavItem[] {
     const nav: SettingsNavItem[] = [
       { id: SETTINGS_GENERAL_ID, label: '常规', kind: 'general' },
       { id: SETTINGS_PLUGINS_ID, label: '插件管理', kind: 'manage' }
     ]
   ```

   即:新增一项必须同时改 `SettingsNavItem` 联合类型与 `buildSettingsNav` 的初始数组。

2. **设置页按 `activeId` 分支选内容** —— `src/renderer/src/settings/SettingsPage.vue:119-129`:

   ```vue
   <template v-if="activeId === SETTINGS_GENERAL_ID">常规</template>
   <template v-else-if="activeId === SETTINGS_PLUGINS_ID">插件管理</template>
   <template v-else>{{ activePluginName }}</template>
   ...
   <GeneralSettings v-if="activeId === SETTINGS_GENERAL_ID" />
   <PluginManager v-else-if="activeId === SETTINGS_PLUGINS_ID" @configure="configurePlugin" />
   <template v-else> ... 插件分区 ... </template>
   ```

   标题与正文各加一个分支即可;`coreNav` 已经是 `nav.filter((i) => i.kind !== 'plugin')`,
   新项会自动进核心分组,无需改分组逻辑。`validActive` 回落到插件管理也不受影响。

3. **测试钉住了「固定两项」** —— `tests/settingsNav.test.ts` 两处断言:
   ```ts
   expect(nav.map((i) => i.id)).toEqual([SETTINGS_GENERAL_ID, SETTINGS_PLUGINS_ID])
   expect(nav.map((i) => i.label)).toEqual(['常规', '插件管理'])
   ...
   expect(nav).toHaveLength(2)  // 「没有可配置插件时只有两个核心项」
   ```
   新增核心项后这三处必须同步(最后一个改成 `toHaveLength(3)`)。

4. **纯数据 + 纯函数放 `src/shared`、测试放 `tests/` 且可直接 import 渲染层 `.ts`** ——
   先例:`tests/modalStack.test.ts` import `../src/renderer/src/lib/modalStack`,`tests/suggestSession.test.ts` 同理。
   `tsconfig.web.json` 的 `include` 已含 `src/shared/**/*` → 新数据模块会被 `npm run typecheck` 检查。

5. ⚠️ **`.vue` 不在 `tsc` 检查范围内**(`docs/ARCHITECTURE.md:1017` 明确写着),改完必须 `npm run build` 才能
   抓到「导入了不存在的符号」这类错误。

## 1. 要改/新增的文件与理由

| 文件 | 动作 | 理由 |
| --- | --- | --- |
| `src/shared/shortcutCatalog.ts` | 新增 | 分类清单的唯一数据源(纯数据,无 DOM/Electron 依赖 → 可单测、被 tsc 检查) |
| `src/renderer/src/settings/ShortcutsHelp.vue` | 新增 | 渲染清单;复用全局 `.set-row` / `.pbm-tools.hint` 等既有样式,少量本地样式画 `<kbd>` |
| `src/shared/settingsNav.ts` | 改 | 加 `SETTINGS_SHORTCUTS_ID`、联合类型成员、`buildSettingsNav` 的第二项 |
| `src/renderer/src/settings/SettingsPage.vue` | 改 | 标题分支 + 正文分支 + import 组件 |
| `tests/shortcutCatalog.test.ts` | 新增 | 钉住「覆盖关键键位 / 分组非空 / 无重复项」 |
| `tests/settingsNav.test.ts` | 改 | 三处断言同步为三项 |
| `README.md`(§设置页,约 629-631 行) | 改 | 侧栏描述「固定为『常规 / 插件管理』」已过期,补上快捷键项 |
| `docs/ARCHITECTURE.md`(§7.3,约 798 行) | 改 | `[常规, 插件管理]` 的侧栏模型描述同步;`渲染层` 段可提一句新分区 |
| `docs/ARCHITECTURE.md`(测试表,约 1026 行) | 改 | 新增测试文件会进「其余」列表,该表是按文件逐项列的(否则文档漂移) |

## 2. 数据模型(`src/shared/shortcutCatalog.ts`)

```ts
/** 一条键位。keys 的每个元素渲染成一个 <kbd> 段;alternatives 是同义备用组合。 */
export interface ShortcutItem {
  keys: string[]
  alternatives?: string[][]
  label: string
  /** 代价 / 例外 / 归属说明(如「终端页除外 —— 那里 Ctrl+L 是 shell 的清屏」) */
  note?: string
  /** 平台限制说明(如「macOS 上不启用」);无则为空 */
  platformNote?: string
}

export interface ShortcutGroup {
  id: 'tabs' | 'nav' | 'split' | 'view' | 'terminal' | 'notes' | 'window'
  label: string
  /** 组级说明:作用范围 / 由谁接管 / 属于哪个插件 */
  hint?: string
  items: ShortcutItem[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [ /* 见下 */ ]
```

分组内容(全部从 README 已核实,`README.md:403-430 / 495-520 / 540-595 / 761`):

- **标签 `tabs`**:`Ctrl+T` 新标签(总是新建一个标签组)、`Ctrl+Shift+T` 恢复最近关闭、
  `Ctrl+W` 关闭聚焦的窗格/标签(终端页里也一样)、`Ctrl+1..8` 切到标签栏第 n 项、`Ctrl+9` 最后一项。
- **地址栏与导航 `nav`**:`Ctrl+L` 聚焦地址栏(终端页除外)、`Ctrl+Shift+L`(终端里也生效)、
  `Ctrl+R` 刷新聚焦窗格(终端页除外)、`Ctrl+,` 打开设置、`Ctrl+←/→` 后退/前进(**macOS 不启用**,终端页放行给 shell)、
  `Ctrl+J` 下载面板(终端页除外)。
- **分屏与布局 `split`**:`Ctrl+Shift+←/→/↑/↓` 在聚焦窗格上分屏、
  `Alt+Shift+←/→/↑/↓` 推最内层分隔条;hint 写明「在普通网页 / 终端 / 手机 DevTools 窗格上接管,地址栏与设置页除外」。
- **视图与面板 `view`**:`Ctrl+F` 页内查找(终端页放行给 shell,DevTools 前端自带查找)、
  `Ctrl+Shift+E` 在聚焦窗格开终端、`Ctrl+Shift+F` 元素全屏、
  `Ctrl+Shift+I` / `F12` 开关 DevTools。
- **终端 `terminal`**(hint:作用域仅 `bow://terminal`):`Ctrl+C`(有选中复制,否则当中断)、
  `Ctrl+V` 粘贴(`Ctrl+Shift+C` / `Ctrl+Shift+V` 为 alternatives)、`Ctrl+L` / `Ctrl+R` / `Ctrl+F` / `Ctrl+←/→` 归 shell、
  `Ctrl+Alt+<可打印键>` 一律送进 pty;`Ctrl+W` 归浏览器(关聚焦窗格)在此组用 note 复述一次。
- **笔记 `notes`**(hint:作用域仅 `bow://logseq`):`Enter` / 块首 `Enter` / `Ctrl+Enter` / `Shift+Enter`、
  `Tab` / `Shift+Tab`、`↑` `↓` 换块、`Esc` 退出编辑、`Ctrl+Z` / `Ctrl+Shift+Z`、块首 `Backspace` 合并、
  选中后的 `Ctrl+C` / `Ctrl+X`、`Ctrl+点击 [[链接]]` 右侧新窗格打开。
- **窗口 `window`**:`Alt+F4` 关闭窗口(还有 ≥2 个标签时先弹应用内确认)、`Esc` 取消确认框。

## 3. 组件(`src/renderer/src/settings/ShortcutsHelp.vue`)

- `<script setup>` 只 import `SHORTCUT_GROUPS`,无 `browserAPI` 调用 → 纯展示、无副作用。
- 模板:页头一行固定说明(mac 上 `Ctrl` 写作 `⌘`;`Ctrl+Alt+<键>` 见终端组),
  然后 `v-for` 每个 group:分组标题 + `hint`,组内 `v-for` item(左侧 `<kbd>` 序列、右侧 label 与 `note`/`platformNote`)。
- 复用全局样式类(`.pbm-tools.hint`、`.set-row` 风格),`<style scoped>` 只加 `<kbd>` 徽标、分组标题、备注色;
  不往 `style.css` 里加新全局类,避免影响其它分区。

## 4. 步骤(每步可独立验证)

1. **新增 `src/shared/shortcutCatalog.ts`** —— 定义 `ShortcutItem` / `ShortcutGroup` 与 `SHORTCUT_GROUPS`(§2 内容)。
   验证:`npm run typecheck` 通过。
2. **新增 `tests/shortcutCatalog.test.ts`** —— 断言:7 个分组 id 齐全且 label/items 非空;组内与全局无重复
   (按 `keys.join('+') + label` 去重);三个关键条目在册(`Ctrl+T`、`Ctrl+Shift+E`、`Alt+F4`);
   每个 item 的 `keys` 与 `label` 非空。验证:`npx vitest run tests/shortcutCatalog.test.ts`。
3. **`src/shared/settingsNav.ts`** 加 `SETTINGS_SHORTCUTS_ID = 'shortcuts'`、联合类型
   `{ id: typeof SETTINGS_SHORTCUTS_ID; label: '快捷键'; kind: 'shortcuts' }`、初始数组第二项。
   验证:`npm run typecheck`(此处会先把 `settingsNav.test.ts` 的红暴露出来)。
4. **`tests/settingsNav.test.ts`** 三处断言同步为三项(含 `toHaveLength(3)`)。
   验证:`npx vitest run tests/settingsNav.test.ts`。
5. **新增 `ShortcutsHelp.vue`**,按 §3 渲染。
6. **`SettingsPage.vue`** 接线:`import ShortcutsHelp from './ShortcutsHelp.vue'` +
   标题 `<template v-else-if="activeId === SETTINGS_SHORTCUTS_ID">快捷键</template>` +
   正文 `<ShortcutsHelp v-else-if="activeId === SETTINGS_SHORTCUTS_ID" />`,并 import `SETTINGS_SHORTCUTS_ID`。
   验证:`npm run build` 必须跑(`.vue` 不在 tsc 范围内,见 §0.5)。
7. **文档同步**:`README.md` 设置页那段的「固定为『常规 / 插件管理』」→ 加「快捷键」;
   `docs/ARCHITECTURE.md` §7.3 的 `[常规, 插件管理]` 与测试表同步。
   验证:`grep -rn "常规 / 插件管理\|\[常规, 插件管理\]" README.md docs/ARCHITECTURE.md` 无残留。
8. **整体回归**:`npx vitest run`(全套)+ `npm run typecheck` + `npm run build`。

## 5. 风险 / 未知

- **清单会随代码漂移**:hint/note 是手工文本,键位再改(如 README 里那些「2026-09-xx 用户拍板」的调整)
  不会自动更新本清单。缓解:测试只钉结构与少量关键项,不钉全部文案;`shortcutCatalog.ts` 顶部写一句
  「改键位时同步 README『手动使用快捷键』与本文件」。
- **`settingsNav` 联合类型新增 kind 的影响面**:`SettingsPage.vue:38-42` 的 `coreNav`/`pluginNav` 用
  `kind !== 'plugin'` 过滤,新 kind 无需改动;但若别处有 `switch (item.kind)` 穷尽匹配会编译失败 ——
  已 grep 只有上述一处消费方,风险低。
- **`README` 里已知的既有漂移**(`Ctrl+D` 已删除、adblock 说是「参考插件」等)不在本次范围内,不动。
- **`tests/settingsNav.test.ts` 的名字「固定以『常规 / 插件管理』开头」**在加第三项后语义变化,
  计划改成「常规 / 快捷键 / 插件管理」;若用户更希望新项排在「插件管理」之后,只需调初始数组顺序。

## 6. 不在本次范围

- 不注册/修改任何快捷键行为(`src/shared/shortcuts.ts`、`src/main/tabShortcuts.ts`、插件热键一律不动)。
- 不做搜索框 / 折叠 / 一键复制 / 可视化键盘示意(用户已选「纯分类清单」)。
- 不从 README 自动生成清单(会引入构建期依赖,收益不抵复杂度)。
