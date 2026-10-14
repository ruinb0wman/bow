/**
 * 编辑器插件纯逻辑(设置模型 + 命令拼装 + 路由判定)。**不 import electron / node:path / DOM**,可单测,
 * 也允许被 `.vue` 引用(渲染层只从它取默认清单与类型,不会因此拖进 Node 能力)。
 *
 * 这个插件不做编辑器本体:它只把「一个本地文件」翻译成「终端插件里的一条命令」
 * (见 `@shared/terminalRun`),编辑器是 nvim 或用户在设置页填的任何东西。
 */

import { windowsPathToWsl } from '@shared/localFile'

/** Windows 上注册表用的 ProgID(所有扩展名共用一个) */
export const PROG_ID = 'bowEditor'
/** 「设置 → 默认应用」里显示的名字 */
export const FRIENDLY_NAME = 'bow 文本编辑器'
/** 「编辑」动词(右键菜单里的项)。固定名字便于撤销时精确删掉自己那一个子键 */
export const EDIT_VERB = 'bow-edit'

export const SETTINGS_VERSION = 1

/** 路径怎么写给编辑器:'wsl' = `C:\a\b.txt` → `/mnt/c/a/b.txt`;'native' = 原样 */
export type PathStyle = 'wsl' | 'native'

export interface EditorSettings {
  version: number
  /** 可执行文件(Windows 默认 `wsl.exe`) */
  shell: string
  /** 参数模板,`{file}` 是唯一占位符 */
  args: string[]
  pathStyle: PathStyle
  /** 路由白名单,同时也是注册表要写的扩展名(小写、带点、去重) */
  extensions: string[]
  /**
   * **上一次真的写进注册表的**扩展名清单。撤销按它删 —— 否则用户改完清单再撤销,
   * 旧的那批 `OpenWithProgids` / 右键动词会永远留在注册表里。
   */
  lastRegistered: string[]
}

/** 纯文本 + 常见代码。**不含** .html/.htm/.xhtml —— 那两个归默认浏览器插件 */
export const DEFAULT_EXTENSIONS = [
  '.txt',
  '.md',
  '.markdown',
  '.log',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.csv',
  '.conf',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.vue',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.lua',
  '.sql',
  '.css',
  '.scss',
  '.xml',
  '.env',
  '.gitignore'
]

export function defaultSettings(platform: string): EditorSettings {
  const windows = platform === 'win32'
  return {
    version: SETTINGS_VERSION,
    shell: windows ? 'wsl.exe' : 'nvim',
    // WSL 里跑 nvim:bow 在 Windows、nvim 在发行版里(本机就是这种)。用 `-e` 让参数逐项直传,
    // 不经过 shell 解析 —— 文件名里有空格/引号也不会走样。
    args: windows ? ['-e', 'nvim', '{file}'] : ['{file}'],
    pathStyle: windows ? 'wsl' : 'native',
    extensions: [...DEFAULT_EXTENSIONS],
    lastRegistered: []
  }
}

// ---------- 规范化 ----------

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 扩展名归一化:小写、补前导点、只留 [a-z0-9.]、去重、保序 */
export function normalizeExtensions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    let ext = str(item).trim().toLowerCase()
    if (!ext) continue
    if (!ext.startsWith('.')) ext = `.${ext}`
    if (!/^\.[a-z0-9][a-z0-9.+_-]*$/.test(ext)) continue
    if (seen.has(ext)) continue
    seen.add(ext)
    out.push(ext)
  }
  return out
}

function normalizeArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  // 参数原样保留(可以合法地含空格);只丢掉非字符串与空串
  return value.filter((a): a is string => typeof a === 'string' && a !== '')
}

export function normalizeEditorSettings(input: unknown, fallback: EditorSettings): EditorSettings {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const pathStyle = raw.pathStyle === 'native' || raw.pathStyle === 'wsl' ? raw.pathStyle : fallback.pathStyle
  const extensions = normalizeExtensions(raw.extensions)
  return {
    version: SETTINGS_VERSION,
    shell: str(raw.shell).trim() || fallback.shell,
    args: normalizeArgs(raw.args).length > 0 ? normalizeArgs(raw.args) : [...fallback.args],
    pathStyle,
    // 空清单没有意义(注册表与路由都靠它),退回默认;允许用户以后改
    extensions: extensions.length > 0 ? extensions : [...fallback.extensions],
    lastRegistered: normalizeExtensions(raw.lastRegistered)
  }
}

// ---------- 注册表状态(设置页显示) ----------

/** 一个扩展名当前归谁 */
export interface EditorTargetState {
  ext: string
  /** 系统记录里当前的处理程序(ProgID);null = 没查到 */
  effective: string | null
  /** 查到记录的键(下次怀疑“读错位置”时看一眼) */
  source?: string
  /** 系统**实际**会用哪个程序(AssocQueryString);拿不到就没有这个字段 */
  actualExe?: string
  /** 当前是不是我们 */
  isDefault: boolean
  /** 非默认时的针对性修法 */
  fix: string
}

export interface EditorStatus {
  platform: string
  /** 注册命令里用的可执行文件 */
  exe: string
  /** 我们自己的键在不在(「注册了没有」) */
  registered: boolean
  /** 已注册的扩展名(取 `lastRegistered`,不是当前设置里的清单) */
  registeredExtensions: string[]
  targets: EditorTargetState[]
  /** 注册自校验没命中的键(便于排错) */
  misses: string[]
  /** 必须由用户点一次的那几步 */
  steps: string[]
  /** 当前状态下的注意事项(开发模式 / 探测不可用等) */
  notes: string[]
  error?: string
}

export interface EditorActionResult {
  ok: boolean
  log: string[]
  status: EditorStatus
}

/** Windows 上必须由用户点一次的部分(系统不给程序改默认关联的权限) */
export const WINDOWS_MANUAL_STEPS = [
  '让它出现在「默认应用」里:设置 → 应用 → 默认应用 → bow(注册已完成,这一步只是去确认它在那里)',
  '把要交给编辑器的扩展名选成 bow:展开 bow → 逐个点 .txt / .md / …;Windows 不允许程序代改(Hash + UserChoice Protection Driver 会把直接改注册表的改回)',
  '之后右键任意白名单内的文件 →「显示更多选项」→「用 bow 编辑」;白名单外的文件用工具栏的「用编辑器打开…」'
]

/** 路径里的一小段(不 import node:path,免得把 Node 依赖带进渲染层) */
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/**
 * 扩展名(小写、带点);没有扩展名返回 ''。
 * 点开头的文件按「整名就是扩展名」处理(`.env` / `.gitignore`),这样才能被清单命中。
 */
export function extensionOf(path: string): string {
  const base = baseName(path).toLowerCase()
  if (!base) return ''
  if (base.startsWith('.') && base.indexOf('.', 1) === -1) return base
  const i = base.lastIndexOf('.')
  return i <= 0 || i === base.length - 1 ? '' : base.slice(i)
}

/** 取目录(同 baseName:纯字符串处理,Windows / 可移植路径都能用) */
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i < 0) return '.'
  if (i === 0) return '/'
  if (i === 2 && /^[a-zA-Z]:/.test(p)) return p.slice(0, 3) // `C:\`
  return p.slice(0, i)
}

/**
 * 这个文件该不该进编辑器?
 * - `mode === 'edit'`(命令行带 `--edit` = 右键「用 bow 编辑」/ 工具栏按钮)→ 一律算;
 * - 否则看扩展名是否在白名单里(双击、文件管理器「用 bow 打开」那条路)。
 */
export function shouldOpenInEditor(settings: EditorSettings, path: string, mode: 'open' | 'edit'): boolean {
  if (mode === 'edit') return true
  const ext = extensionOf(path)
  return ext !== '' && settings.extensions.includes(ext)
}

// ---------- 命令拼装 ----------

export interface EditorCommand {
  file: string
  args: string[]
  cwd: string
}

/**
 * 设置 + 文件 → node-pty 的 spawn 参数。
 *
 * - `{file}` 在**每一项**参数里替换(允许 `--cmd 'e {file}'` 这种写法);一项都没含 `{file}` 时
 *   把路径追加到末尾(比"静默忽略用户选的文件"更符合直觉);
 * - `filePath === null` = 测试按钮:含 `{file}` 的参数**整项**去掉(于是 `-e nvim {file}` 变成 `-e nvim`);
 * - `pathStyle === 'wsl'` 但换算不出(UNC `\\wsl$\…` 等)→ 报错而不是猜一个假路径;
 * - `cwd` 一律用**文件所在目录的本机形态**:wsl.exe 自己会把 `C:\tmp` 映射成 `/mnt/c/tmp`,
 *   于是 nvim 的工作目录正好是文件目录(`:e` / `gf` 的相对路径能用)。
 */
export function buildEditorCommand(
  settings: EditorSettings,
  filePath: string | null
): { ok: true; command: EditorCommand } | { ok: false; error: string } {
  const shell = settings.shell.trim()
  if (!shell) return { ok: false, error: '没有配置编辑器命令(设置 → 编辑器)' }

  let forEditor = ''
  if (filePath !== null) {
    if (settings.pathStyle === 'wsl') {
      // 换算规则只有一份实现(@shared/localFile,与终端插件的 pi 桥接提示共用)
      const converted = windowsPathToWsl(filePath)
      if (!converted) {
        return { ok: false, error: `路径写法是 WSL,但换算不出这个路径:${filePath}(只支持盘符路径,如 C:\\a\\b.txt)` }
      }
      forEditor = converted
    } else {
      forEditor = filePath
    }
  }

  const withFile = settings.args.filter((a) => a.includes('{file}'))
  let args: string[]
  if (filePath === null) {
    args = settings.args.filter((a) => !a.includes('{file}'))
  } else if (withFile.length === 0) {
    args = [...settings.args, forEditor]
  } else {
    args = settings.args.map((a) => a.split('{file}').join(forEditor))
  }

  return {
    ok: true,
    command: {
      file: shell,
      args,
      cwd: filePath === null ? '' : dirOf(filePath)
    }
  }
}
