/**
 * Windows(每用户 HKCU,**不需要管理员**)注册计划与状态探测 —— 纯逻辑,不碰注册表。
 *
 * 为什么不能像 Linux 那样一步到位:Windows 10/11 的默认关联带 UserChoice 哈希保护,
 * **任何程序都无法自行把自己设成默认浏览器 / 默认打开方式**;能程序化做的、也是
 * Chrome/Firefox 安装器实际做的,是把自己注册成**候选**:
 *
 *   1. 文件类型 ProgID（`HKCU\Software\Classes\bowHTML`：图标 + `shell\open\command`）
 *   2. URL 协议 ProgID（`…\bowURL`，含空的 `URL Protocol` 值 —— 没有它系统不当协议处理程序）
 *   3. `…\.html\OpenWithProgids` → 右键「打开方式」里出现 bow
 *   4. `…\Applications\bow.exe`（`FriendlyAppName` + `SupportedTypes`）→「选择其它应用」里的候选
 *   5. `HKCU\Software\Clients\StartMenuInternet\bow\Capabilities` + `RegisteredApplications`
 *      → bow 出现在「设置 → 默认应用」里（浏览器列表读的正是 StartMenuInternet + URLAssociations）
 *
 * 最后由用户在系统设置里点一次确认。**本模块只产出「要写哪些键 / 要查哪些键」**,
 * 真正的执行在 `registration.ts`(默认浏览器插件),单测见 `tests/defaultBrowser.test.ts`。
 */

import { win32 } from 'node:path'

export const DEFAULT_FILE_TYPES = ['.html', '.htm', '.xhtml']
export const DEFAULT_URL_SCHEMES = ['http', 'https']

/** `(默认)` 值用 name = null 表示 */
const DEFAULT_VALUE = null

/** 注册表操作:一条写入 / 一个待删除的值 / 一个待删除的键 */
export interface RegOp {
  key: string
  /** null = `(默认)` 值;有名字则写具名值 */
  name?: string | null
  type?: string
  data?: string
}

export interface UserChoiceTarget {
  id: string
  label: string
  kind: 'file' | 'protocol'
  /** UserChoice 注册表键 */
  key: string
  /** 属于我们时应当等于的 ProgID */
  expect: string
}

export interface WindowsRegistrationPlan {
  exe: string
  exeName: string
  appName: string
  progIdHtml: string
  progIdUrl: string
  openCommand: string
  clientKey: string
  capsKey: string
  applicationKey: string
  adds: RegOp[]
  deletes: {
    values: Array<{ key: string; name: string }>
    keys: string[]
    /** 带条件的值删除:reg query 确认当前值等于 expect 才删 */
    guardedValues: Array<{ key: string; name: string | null; expect: string }>
  }
}

export interface UserChoiceTarget {
  id: string
  label: string
  kind: 'file' | 'protocol'
  /**
   * 主查询键(UserChoice)。⚠️ 协议与文件类型的 UserChoice **不在同一个位置**:
   * - 协议:`HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\<scheme>\UserChoice`;
   * - 文件:`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\<.ext>\UserChoice`。
   * 曾经把协议写成 `...\CurrentVersion\Explorer\UrlAssociations\http\UserChoice`(该键不存在)
   * → http/https 永远显示「未设置」(实机踩过;tests 里有键路径回归断言)。
   */
  key: string
  /** 备用键:个别 Windows 构建上 URL 关联曾在 Explorer 下 */
  alternateKeys?: string[]
  /** UserChoice 缺席时的回落键(HKCR 合并顺序:HKCU\Software\Classes → HKLM\…),读的是**默认值** */
  legacyKeys?: string[]
  /** 属于我们时应当等于的 ProgID */
  expect: string
}

/**
 * 「系统当前把这一类交给谁」的注册位置。
 * 这是**判断「是不是默认浏览器」的唯一可靠依据** —— 只查我们自己的键只能知道「注册没注册」。
 *
 * 注意 Windows 判定「默认浏览器」看的是 **`.htm(l)` + http(s)**(不只是 .html),
 * 所以任何一项落在别人手里,都可能与系统设置页显示的「默认浏览器: bow」不一致。
 */
export function userChoiceTargets({ appName = 'bow' } = {}): UserChoiceTarget[] {
  const explorer = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer'
  const shellAssoc = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations'
  const classesUser = 'HKCU\\Software\\Classes'
  const classesMachine = 'HKLM\\Software\\Classes'
  return [
    {
      id: 'http',
      label: 'http 链接',
      kind: 'protocol',
      key: `${shellAssoc}\\UrlAssociations\\http\\UserChoice`,
      alternateKeys: [`${explorer}\\UrlAssociations\\http\\UserChoice`],
      expect: `${appName}URL`
    },
    {
      id: 'https',
      label: 'https 链接',
      kind: 'protocol',
      key: `${shellAssoc}\\UrlAssociations\\https\\UserChoice`,
      alternateKeys: [`${explorer}\\UrlAssociations\\https\\UserChoice`],
      expect: `${appName}URL`
    },
    {
      id: '.html',
      label: '.html 文件',
      kind: 'file',
      key: `${explorer}\\FileExts\\.html\\UserChoice`,
      legacyKeys: [`${classesUser}\\.html`, `${classesMachine}\\.html`],
      expect: `${appName}HTML`
    },
    {
      id: '.htm',
      label: '.htm 文件',
      kind: 'file',
      key: `${explorer}\\FileExts\\.htm\\UserChoice`,
      legacyKeys: [`${classesUser}\\.htm`, `${classesMachine}\\.htm`],
      expect: `${appName}HTML`
    },
    {
      id: '.xhtml',
      label: '.xhtml 文件',
      kind: 'file',
      key: `${explorer}\\FileExts\\.xhtml\\UserChoice`,
      legacyKeys: [`${classesUser}\\.xhtml`, `${classesMachine}\\.xhtml`],
      expect: `${appName}HTML`
    }
  ]
}

export function buildWindowsRegistration({
  exe,
  appName = 'bow',
  description = 'AI 可操纵的简易浏览器(多标签 + MCP)',
  fileTypes = DEFAULT_FILE_TYPES,
  urlSchemes = DEFAULT_URL_SCHEMES
}: {
  exe: string
  appName?: string
  description?: string
  fileTypes?: string[]
  urlSchemes?: string[]
}): WindowsRegistrationPlan {
  if (!exe || typeof exe !== 'string') throw new Error('buildWindowsRegistration 需要 exe 路径')
  const exeName = win32.basename(exe) // bow.exe
  const progIdHtml = `${appName}HTML`
  const progIdUrl = `${appName}URL`
  const openCommand = `"${exe}" "%1"`
  const icon = `${exe},0`

  const classes = 'HKCU\\Software\\Classes'
  const clientKey = `HKCU\\Software\\Clients\\StartMenuInternet\\${appName}`
  const capsKey = `${clientKey}\\Capabilities`
  const applicationKey = `${classes}\\Applications\\${exeName}`
  const registeredApplications = 'HKCU\\Software\\RegisteredApplications'

  const adds: RegOp[] = [
    // 1) 文件类型 ProgID
    { key: `${classes}\\${progIdHtml}`, name: DEFAULT_VALUE, type: 'REG_SZ', data: 'bow HTML Document' },
    { key: `${classes}\\${progIdHtml}`, name: 'FriendlyTypeName', type: 'REG_SZ', data: 'bow HTML Document' },
    { key: `${classes}\\${progIdHtml}\\DefaultIcon`, name: DEFAULT_VALUE, type: 'REG_SZ', data: icon },
    { key: `${classes}\\${progIdHtml}\\shell\\open\\command`, name: DEFAULT_VALUE, type: 'REG_SZ', data: openCommand },

    // 2) URL 协议 ProgID(空的 `URL Protocol` 是「这是协议处理程序」的标记,不能省)
    { key: `${classes}\\${progIdUrl}`, name: DEFAULT_VALUE, type: 'REG_SZ', data: 'bow URL' },
    { key: `${classes}\\${progIdUrl}`, name: 'URL Protocol', type: 'REG_SZ', data: '' },
    { key: `${classes}\\${progIdUrl}\\DefaultIcon`, name: DEFAULT_VALUE, type: 'REG_SZ', data: icon },
    { key: `${classes}\\${progIdUrl}\\shell\\open\\command`, name: DEFAULT_VALUE, type: 'REG_SZ', data: openCommand },

    // 3) 各扩展名的「打开方式」候选
    ...fileTypes.map((ext) => ({
      key: `${classes}\\${ext}\\OpenWithProgids`,
      name: progIdHtml,
      type: 'REG_NONE',
      data: ''
    })),

    // 3b) 传统回落:`HKCU\Software\Classes\.<ext>` 的默认值 = 实际生效的处理程序
    //     (HKCR 合并顺序:UserChoice → HKCU\Software\Classes → HKLM\Software\Classes)。
    //     不写这一条时,用户没单独选过的类型(如 .xhtml、常被落下的 .htm)仍指向系统旧值。
    ...fileTypes.map((ext) => ({
      key: `${classes}\\${ext}`,
      name: DEFAULT_VALUE,
      type: 'REG_SZ',
      data: progIdHtml
    })),

    // 4) Applications 条目(「选择其它应用」列表 + 支持的类型)
    { key: applicationKey, name: 'FriendlyAppName', type: 'REG_SZ', data: appName },
    { key: `${applicationKey}\\shell\\open\\command`, name: DEFAULT_VALUE, type: 'REG_SZ', data: openCommand },
    ...fileTypes.map((ext) => ({
      key: `${applicationKey}\\SupportedTypes`,
      name: ext,
      type: 'REG_NONE',
      data: ''
    })),

    // 5) 浏览器候选(Capabilities + RegisteredApplications)
    { key: clientKey, name: DEFAULT_VALUE, type: 'REG_SZ', data: appName },
    { key: capsKey, name: 'ApplicationName', type: 'REG_SZ', data: appName },
    { key: capsKey, name: 'ApplicationDescription', type: 'REG_SZ', data: description },
    { key: capsKey, name: 'ApplicationIcon', type: 'REG_SZ', data: icon },
    ...fileTypes.map((ext) => ({
      key: `${capsKey}\\FileAssociations`,
      name: ext,
      type: 'REG_SZ',
      data: progIdHtml
    })),
    ...urlSchemes.map((scheme) => ({
      key: `${capsKey}\\URLAssociations`,
      name: scheme,
      type: 'REG_SZ',
      data: progIdUrl
    })),
    {
      key: registeredApplications,
      name: appName,
      type: 'REG_SZ',
      data: `Software\\Clients\\StartMenuInternet\\${appName}\\Capabilities`
    }
  ]

  const deletes = {
    // 值:候选登记(删掉即可从「打开方式 / 默认应用」列表里消失)
    values: [
      ...fileTypes.map((ext) => ({ key: `${classes}\\${ext}\\OpenWithProgids`, name: progIdHtml })),
      { key: registeredApplications, name: appName }
    ],
    // 键:我们自己的 ProgID 与客户端条目(整键删除,含子键)
    keys: [`${classes}\\${progIdHtml}`, `${classes}\\${progIdUrl}`, applicationKey, clientKey],
    // 只在我们确实写过时才删的值:撤销前先 reg query 核对,避免删掉别的程序写的默认值
    guardedValues: fileTypes.map((ext) => ({ key: `${classes}\\${ext}`, name: DEFAULT_VALUE, expect: progIdHtml }))
  }

  return { exe, exeName, appName, progIdHtml, progIdUrl, openCommand, clientKey, capsKey, applicationKey, adds, deletes }
}

/** 一条写入 → `reg.exe` 参数 */
export function regAddArgs(op: RegOp): string[] {
  return ['ADD', op.key, '/t', op.type ?? 'REG_SZ', ...(op.name ? ['/v', op.name] : ['/ve']), '/d', op.data ?? '', '/f']
}

/** 删一个值 → `reg.exe` 参数(name = null 表示 `(默认)` 值) */
export function regDeleteValueArgs({ key, name }: { key: string; name: string | null }): string[] {
  return ['DELETE', key, ...(name ? ['/v', name] : ['/ve']), '/f']
}

/** 删整键(含子键) → `reg.exe` 参数 */
export function regDeleteKeyArgs(key: string): string[] {
  return ['DELETE', key, '/f']
}

/** 校验一条写入是否落地 → `reg.exe` 参数 */
export function regQueryArgs(op: RegOp): string[] {
  return ['QUERY', op.key, ...(op.name ? ['/v', op.name] : ['/ve'])]
}

/** 查「当前默认交给谁」→ `reg.exe` 参数 */
export function userChoiceQueryArgs(target: UserChoiceTarget): string[] {
  return ['QUERY', target.key, '/v', 'ProgId']
}

/**
 * 解析 `reg query` 的输出,取某个值的数据:
 * ```
 * HKEY_CURRENT_USER\...\UserChoice
 *     ProgId    REG_SZ    ChromeHTML
 * ```
 * 找不到返回 null(键不存在 / 值不存在 / 输出格式异常都算)。
 * 注:中文 Windows 的 `reg query` 会输出「(默认)」而不是 `(Default)`,所以匹配的是类型列而不是值名。
 */
export function parseRegQueryValue(output: string, valueName: string): string | null {
  if (typeof output !== 'string') return null
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('HKEY')) continue
    // 值名与类型之间是空白,类型与数据之间也是;数据本身可能含空格 → 只切前两段
    const m = /^(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/.exec(line)
    if (!m) continue
    if (m[1] !== valueName) continue
    return m[3].trim()
  }
  return null
}

/**
 * 解析 `reg query` 输出里**第一条值**的数据。
 * 用于 `(默认)` 值 —— 中文 Windows 打印「(默认)」、英文打印「(Default)」,
 * 所以这里不按值名匹配,直接取第一行值。
 */
export function parseRegQueryFirstValue(output: string): string | null {
  if (typeof output !== 'string') return null
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('HKEY')) continue
    const m = /^(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/.exec(line)
    if (!m) continue
    return m[3].trim()
  }
  return null
}

/**
 * 常见浏览器的 ProgID 特征 → 便于阅读的名字(**只为显示**;认不出就原样展示 ProgID,
 * 绝不按“像不像”猜)。实机反馈里 http/.htm 归 Firefox 时注册表写的是
 * `FirefoxURL-308046B0AF4A39CB` 这种带随机后缀的 ProgID —— 直接丢给用户看很劝退。
 */
const KNOWN_PROGIDS: Array<[RegExp, string]> = [
  [/^bow(URL|HTML)$/i, 'bow'],
  [/firefox/i, 'Firefox'],
  [/chromehtml/i, 'Chrome'],
  [/msedge/i, 'Edge'],
  [/bravehtml/i, 'Brave'],
  [/vivaldi/i, 'Vivaldi'],
  [/operastable/i, 'Opera'],
  [/^appxq0fevzme2pys62n3e0fbqa7peapykr8v$/i, 'Edge(旧版)'],
  [/^ie\.(http|html)$/i, 'Internet Explorer'],
  [/^htmlfile$/i, '系统通用 HTML 处理程序'],
  [/^http$/i, '系统通用 http 处理程序'],
  // 实际生效者是以“程序名”报出来的(exeStem → `chrome` / `brave` …),不是 ProgID
  [/^chrome$/i, 'Chrome'],
  [/^brave$/i, 'Brave'],
  [/^opera$/i, 'Opera'],
  [/^iexplore$/i, 'Internet Explorer']
]

/** ProgID → 人话;认不出返回 undefined(调用方原样显示 ProgID) */
export function friendlyProgId(progId: string): string | undefined {
  for (const [re, name] of KNOWN_PROGIDS) if (re.test(progId)) return name
  return undefined
}

/**
 * 「系统**实际**会用哪个程序打开这类东西」的探测(比 UserChoice 记录更权威)。
 *
 * 为什么需要它:UserChoice 带 Hash 保护,当 Hash 与内容不匹配时(陈旧记录、被别的安装器改写、
 * 系统升级等)Windows **会忽略这条记录**,按 HKCR 合并顺序回落到 HKCU/HKLM `Software\Classes`。
 * 实测场景:`.html` 的 UserChoice 写着 Firefox,但双击却用 bow 打开 —— 因为回落到我们注册里写的
 * `HKCU\Software\Classes\.html = bowHTML`。只看记录的检测会把这种情况误报成「非默认」。
 *
 * `AssocQueryString` 是 shell 自己用的那个 API,它返回的就是真实会执行的命令。
 * 通过 PowerShell 的 `Add-Type` 调一次(不需管理员,不改任何东西);拿不到就退化为只依据记录。
 */
export interface AssocProbeTarget {
  /** 目标 id(与 `userChoiceTargets` 一致)兼探测参数:`.html` / `http` 等 */
  id: string
}

/** 生成一段 PowerShell 脚本:逐个目标调 `AssocQueryString`,输出 `<id>|<exe 路径>` 行 */
export function buildAssocProbeScript(targets: AssocProbeTarget[]): string {
  const list = targets.map((t) => `  @('${t.id}', '${t.id}')`).join(',\r\n')
  return [
    '$ErrorActionPreference = "Stop"',
    '$src = @"',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public static class BowAssoc {',
    '  [DllImport("Shlwapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern uint AssocQueryString(int flags, int str, string pszAssoc, string pszExtra, StringBuilder pszOut, ref uint pcchOut);',
    '}',
    '"@',
    'Add-Type -TypeDefinition $src',
    `foreach ($t in @(\r\n${list}\r\n)) {`,
    '  $sb = New-Object System.Text.StringBuilder 4096',
    '  $n = [uint32]4096',
    '  try {',
    '    [void][BowAssoc]::AssocQueryString(0, 2, $t[1], "open", $sb, [ref]$n)',
    '    Write-Output ($t[0] + "|" + $sb.ToString())',
    '  } catch {',
    '    Write-Output ($t[0] + "|")',
    '  }',
    '}'
  ].join('\r\n')
}

/** 解析探测输出(`<id>|<exe>`);忽略 PowerShell 的杂音行,拿不到 exe 的行忽略 */
export function parseAssocProbeOutput(output: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof output !== 'string') return out
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    const i = line.indexOf('|')
    if (i <= 0) continue
    const id = line.slice(0, i).trim()
    const exe = line.slice(i + 1).trim()
    if (id && exe) out[id] = exe
  }
  return out
}

/** 从可执行文件路径取出便于对比 / 展示的程序名(`D:\x\bow.exe` → `bow`) */
export function exeStem(exePath: string): string {
  const base = win32.basename(exePath.trim().replace(/^"|"$/g, ''))
  return base.replace(/\.exe$/i, '').toLowerCase()
}

/** 打印给人看的 `reg.exe` 命令行(设置页回显用,不执行) */
export function formatRegCommand(args: string[]): string {
  return 'reg ' + args.map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
}

/** Windows 上必须由用户点一次的部分(系统不给程序改默认关联的权限) */
export const WINDOWS_MANUAL_STEPS = [
  '让它成为默认浏览器:设置 → 应用 → 默认应用 → bow → 「设为默认值」;或在弹出「打开 http 链接」时选 bow 并勾「始终」',
  '让 .html 默认用 bow 打开:右键任意 .html → 打开方式 → 选择其它应用 → bow → 勾「始终使用此应用打开 .html 文件」',
  '之后 bow 也会一直出现在右键「打开方式」与「设置 → 默认应用」的候选列表里(撤销注册即撤掉)'
]
