/**
 * Windows 注册表的**通用原语**(纯逻辑):`reg.exe` 参数拼装 / 解析、以及「系统实际用哪个程序」
 * 的 `AssocQueryString` 探测脚本。
 *
 * 这些原语原先长在默认浏览器插件的 `windowsRegistry.ts` 里,编辑器插件要一模一样的第二份,
 * 所以提到核心(`src/main/plugins/`)来共用 —— 不然两份会各自漂移,而漂移的表现是「注册看起来成功、
 * 系统就是不用它」这种最难查的故障。
 *
 * 这里只有字符串进出:不执行 reg.exe、不碰 fs、不 import electron(两个插件各自注入执行器)。
 * 真实执行见 `plugins/default-browser/registration.ts` 与 `plugins/editor/registration.ts`。
 */

import { win32 } from 'node:path'

/** `(默认)` 值用 name = null 表示 */
export const DEFAULT_VALUE = null

/** 注册表操作:一条写入 / 一个待删除的值 / 一个待删除的键 */
export interface RegOp {
  key: string
  /** null = `(默认)` 值;有名字则写具名值 */
  name?: string | null
  type?: string
  data?: string
}

/** 一次 reg.exe / PowerShell 调用的结果(执行器注入的返回形状) */
export interface RegResult {
  status: number | null
  stdout: string
  stderr: string
}

/** 跑一条 `reg.exe` 命令(插件各自注入真实现) */
export type RunReg = (args: string[]) => RegResult

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

/** 查某个 UserChoice 键「当前默认交给谁」→ `reg.exe` 参数 */
export function userChoiceQueryArgs(target: { key: string }): string[] {
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
  /** 目标 id(与调用方的目标 id 一致)兼探测参数:`.html` / `.txt` / `http` 等 */
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
