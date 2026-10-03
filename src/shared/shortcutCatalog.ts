/**
 * 设置页「快捷键」分区的唯一数据源(纯数据,无 DOM/Electron 依赖 → 可单测、被 tsc 检查)。
 *
 * ⚠️ 改键位时请同步:本文件、README 的「手动使用快捷键」/「终端」/「笔记」各节,
 * 以及真正的识别逻辑(`src/shared/shortcuts.ts`、`src/main/tabShortcuts.ts`、插件热键)。
 * 本文件**只做展示**,不参与按键识别,也不注册任何热键。
 */

/** 分组 id(顺序即页面展示顺序) */
export type ShortcutGroupId = 'tabs' | 'nav' | 'split' | 'view' | 'terminal' | 'notes' | 'window'

export interface ShortcutItem {
  /** 按键段,每个元素渲染成一个 <kbd>(如 `['Ctrl', 'Shift', 'T']`);`'← / →'` 这类联合段整体渲染成一个 <kbd> */
  keys: string[]
  /** 同义备用组合(如 `Ctrl+Shift+V` 之于 `Ctrl+V`) */
  alternatives?: string[][]
  label: string
  /** 例外 / 代价 / 归属说明 */
  note?: string
  /** 平台限制说明(如「macOS 上不启用」) */
  platformNote?: string
}

export interface ShortcutGroup {
  id: ShortcutGroupId
  label: string
  /** 组级说明:作用范围 / 由谁接管 / 属于哪个插件 */
  hint?: string
  items: ShortcutItem[]
}

/** 页面顶部固定说明:mac 上大部分 Ctrl 写作 ⌘;少数真正受限的条目在各自条目里加注 */
export const SHORTCUT_INTRO =
  'macOS 上大部分的 Ctrl 写作 ⌘(⌘ 与 Ctrl 的差异沿用系统习惯);真正受限的组合在条目里单独注明。'

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: 'tabs',
    label: '标签',
    hint: '由主进程拦截,任意焦点下生效(含页面内)。',
    items: [
      { keys: ['Ctrl', 'T'], label: '新建标签', note: '总是新建一个标签组,不会拆掉已有的分屏' },
      { keys: ['Ctrl', 'Shift', 'T'], label: '恢复最近关闭的标签' },
      {
        keys: ['Ctrl', 'W'],
        label: '关闭聚焦的窗格 / 标签',
        note: '终端页里也一样(终端就是普通标签);组里最后一个窗格关掉后这一项就消失'
      },
      { keys: ['Ctrl', '1..8'], label: '切到标签栏第 n 项(一个分屏组只算一项)' },
      { keys: ['Ctrl', '9'], label: '切到最后一个标签组' }
    ]
  },
  {
    id: 'nav',
    label: '地址栏与导航',
    hint: '除标注外,任意焦点下生效(页面 / 地址栏 / 弹层)。',
    items: [
      {
        keys: ['Ctrl', 'L'],
        label: '聚焦地址栏',
        note: '终端页除外 —— 那里 Ctrl+L 是 shell 的清屏'
      },
      {
        keys: ['Ctrl', 'Shift', 'L'],
        label: '聚焦地址栏(任何焦点下都生效)',
        note: '终端页里也不例外 —— 在终端里想跳去地址栏就用它'
      },
      {
        keys: ['Ctrl', 'R'],
        label: '刷新聚焦窗格',
        note: '页面里也生效;终端页除外 —— 那里 Ctrl+R 是 shell 的反向历史搜索'
      },
      { keys: ['Ctrl', ','], label: '打开设置页(bow://settings)', note: '已存在则只聚焦,不重复新建' },
      {
        keys: ['Ctrl', '← / →'],
        label: '后退 / 前进(聚焦窗格的历史)',
        note: '焦点不在任何窗格时作用于活动标签;终端页里放行给 shell(readline 的按词移动)',
        platformNote:
          'macOS 上不启用 —— 那里 Ctrl+←/→ 常被系统(Mission Control / 切换桌面)先吃掉,而 ⌘+←/→ 是「行首/行尾」'
      },
      {
        keys: ['Ctrl', 'J'],
        label: '打开 / 关闭下载面板',
        note: '再按一次关;终端页除外 —— 那里 Ctrl+J 是 shell 的 accept-line(等价回车)'
      }
    ]
  },
  {
    id: 'split',
    label: '分屏与布局',
    hint: '在普通网页标签、终端页与手机调试的 DevTools 前端标签上由主进程接管;地址栏、设置页里保持原样(按词选择 / 前端自己的快捷键)。代价:网页输入框也拿不到这两个组合。',
    items: [
      {
        keys: ['Ctrl', 'Shift', '← / → / ↑ / ↓'],
        label: '在聚焦窗格上分屏',
        note: '新窗格开一个空白标签并立刻聚焦它,方向 = 新窗格的位置;每次都嵌套一层(连按三次 → 得到 50% / 25% / 25%)'
      },
      {
        keys: ['Alt', 'Shift', '← / → / ↑ / ↓'],
        label: '推最内层那条同轴分隔条,调整窗格大小',
        note: '箭头指哪,分隔条就往哪挪;上下 / 左右都只动最内层那一层'
      }
    ]
  },
  {
    id: 'view',
    label: '视图与面板',
    items: [
      {
        keys: ['Ctrl', 'F'],
        label: '页内查找',
        note: '高亮并计数,Enter 下一个 / Shift+Enter 上一个 / Esc 关闭 / Aa 区分大小写。终端页除外 —— 那里 Ctrl+F 是 shell 的按字符前进;DevTools 前端自带查找。地址栏建议 / 分屏面板 / 下载面板打开时查找条会被替换(页内高亮仍在)'
      },
      {
        keys: ['Ctrl', 'Shift', 'E'],
        label: '在聚焦窗格开终端',
        note: '顶替当前窗格(与地址栏输 bow://terminal 同一条路);终端里也生效 —— 当前窗格已是终端则什么也不做'
      },
      {
        keys: ['Ctrl', 'Shift', 'P'],
        label: '密码:填入当前页 / 打开密码库',
        note: '有多个匹配账号时在密码框旁弹页内下拉;未创建 / 已锁定 / 当前页没有登录表单时改为打开密码面板。代价:网页 IDE(如 vscode.dev)的命令面板也是这个组合,会被浏览器先吃掉'
      },
      {
        keys: ['Ctrl', 'Shift', 'I'],
        alternatives: [['F12']],
        label: '开关当前聚焦视图的 DevTools',
        note: 'DevTools 固定以独立窗口打开;焦点在 DevTools 窗口内时按同一快捷键可关闭'
      }
    ]
  },
  {
    id: 'terminal',
    label: '终端(bow://terminal)',
    hint: '以下键位只在终端页里生效;终端页同时是普通标签,标签 / 地址栏 / 分屏键照样可用。',
    items: [
      {
        keys: ['Ctrl', 'C'],
        alternatives: [['Ctrl', 'Shift', 'C']],
        label: '复制选中内容',
        note: '有选中内容就复制,不打扰 shell;没有选中才照常发给 shell 当中断信号'
      },
      {
        keys: ['Ctrl', 'V'],
        alternatives: [['Ctrl', 'Shift', 'V']],
        label: '粘贴',
        note: '多行文本按 xterm 的括号粘贴规则送进去;都走主进程剪贴板'
      },
      { keys: ['Ctrl', 'L'], label: '清屏(归 shell)' },
      { keys: ['Ctrl', 'R'], label: '反向历史搜索(归 shell)' },
      { keys: ['Ctrl', '← / →'], label: '按词移动光标(归 shell)' },
      {
        keys: ['Ctrl', 'W'],
        label: '关闭聚焦的终端窗格(归浏览器)',
        note: '与标签上的 × 同义;shell 的「删词」因此让位 —— 想用请按各 shell 自己的绑定(如 bash / WSL 的 Alt+Backspace)'
      },
      {
        keys: ['Ctrl', 'Alt', '<可打印键>'],
        label: '一律送进 pty',
        note: '如 pi / pi-agents 的 Ctrl+Alt+P 切模式;Windows 上 xterm 会把它当 AltGr 丢掉,终端页启动时已包住那条判据'
      }
    ]
  },
  {
    id: 'notes',
    label: '笔记(bow://logseq)',
    hint: '以下键位只在笔记页里生效;分屏 / 调大小键在笔记页里也管用(由页面自己调 IPC 完成,不经主进程接管)。',
    items: [
      { keys: ['Enter'], label: '新建块 / 在块中间劈开', note: '块首按 Enter 在块前插一个空块,光标落在新空块里' },
      {
        keys: ['Ctrl', 'Enter'],
        alternatives: [['Shift', 'Enter']],
        label: '块内换行',
        note: '中文输入法下主推 Ctrl+Enter —— 不少输入法把单按 Shift 当「中/英切换」吃掉'
      },
      { keys: ['Tab / Shift+Tab'], label: '整组缩进 / 反缩进' },
      { keys: ['↑ / ↓'], label: '切换当前块' },
      { keys: ['Esc'], label: '退出编辑态 / 取消多块选中' },
      {
        keys: ['Ctrl', 'Z'],
        alternatives: [['Ctrl', 'Shift', 'Z']],
        label: '撤销(整篇快照,上限 50 步)',
        note: 'Ctrl+Shift+Z 是重做'
      },
      { keys: ['Backspace'], label: '块首合并到上一个块', note: '顶层第一块若是空块则删掉自己' },
      {
        keys: ['Ctrl', 'C'],
        label: '把选中块按 Logseq markdown 写入剪贴板',
        note: '多块选区:在块左侧的圆点上按住鼠标往下拖'
      },
      {
        keys: ['Ctrl', 'X'],
        label: '剪切选中块',
        note: '先确认复制成功再删 —— 剪贴板写不进去就不删,宁可不删也不丢内容'
      },
      { keys: ['Ctrl', '点击 [[链接]]'], label: '在右侧新窗格里打开它' }
    ]
  },
  {
    id: 'window',
    label: '窗口',
    items: [
      {
        keys: ['Alt', 'F4'],
        label: '关闭窗口',
        note: '还有 2 个及以上标签时先弹应用内确认框;确认框开着时再按一次 = 直接关闭'
      },
      { keys: ['Esc'], label: '取消关窗确认框' }
    ]
  }
]
