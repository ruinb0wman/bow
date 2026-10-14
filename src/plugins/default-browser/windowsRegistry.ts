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
import { DEFAULT_VALUE } from '../../main/plugins/registryOps'
import type { RegOp } from '../../main/plugins/registryOps'

/**
 * 通用原语(`reg.exe` 参数 / 解析 / Assoc 探测 / exeStem / formatRegCommand)全部在
 * `main/plugins/registryOps.ts` —— 编辑器插件要用同一份。这里 re-export,调用方(`registration.ts`
 * 的 `win.regAddArgs` 与测试的 `win.RegOp`)不用改。
 */
export {
  DEFAULT_VALUE,
  buildAssocProbeScript,
  exeStem,
  formatRegCommand,
  parseAssocProbeOutput,
  parseRegQueryFirstValue,
  parseRegQueryValue,
  regAddArgs,
  regDeleteKeyArgs,
  regDeleteValueArgs,
  regQueryArgs,
  userChoiceQueryArgs
} from '../../main/plugins/registryOps'
export type { AssocProbeTarget, RegOp, RegResult, RunReg } from '../../main/plugins/registryOps'

export const DEFAULT_FILE_TYPES = ['.html', '.htm', '.xhtml']
export const DEFAULT_URL_SCHEMES = ['http', 'https']

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
  const shellAssoc = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations'
  const explorer = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer'
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
    ...fileUserChoiceTargets(DEFAULT_FILE_TYPES, `${appName}HTML`)
  ]
}

/**
 * 文件类型的 UserChoice 目标(逐扩展名)。抽出来是为了让编辑器插件复用同一套**键路径规则**:
 * 它注册的是 .txt/.md/… 而不是 HTML,但「Windows 这一类交给谁」的判定方式完全一样 ——
 * 而且协议与文件类型的 UserChoice **不在同一个位置**(见 UserChoiceTarget.key 的注解)。
 */
export function fileUserChoiceTargets(exts: readonly string[], progId: string): UserChoiceTarget[] {
  const explorer = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer'
  const classesUser = 'HKCU\\Software\\Classes'
  const classesMachine = 'HKLM\\Software\\Classes'
  return exts.map((ext) => ({
    id: ext,
    label: `${ext} 文件`,
    kind: 'file' as const,
    key: `${explorer}\\FileExts\\${ext}\\UserChoice`,
    legacyKeys: [`${classesUser}\\${ext}`, `${classesMachine}\\${ext}`],
    expect: progId
  }))
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

/** Windows 上必须由用户点一次的部分(系统不给程序改默认关联的权限) */
export const WINDOWS_MANUAL_STEPS = [
  '让它成为默认浏览器:设置 → 应用 → 默认应用 → bow → 「设为默认值」;或在弹出「打开 http 链接」时选 bow 并勾「始终」',
  '让 .html 默认用 bow 打开:右键任意 .html → 打开方式 → 选择其它应用 → bow → 勾「始终使用此应用打开 .html 文件」',
  '之后 bow 也会一直出现在右键「打开方式」与「设置 → 默认应用」的候选列表里(撤销注册即撤掉)'
]
