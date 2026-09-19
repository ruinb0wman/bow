/**
 * 终端插件纯逻辑(同构:无 electron / DOM / node 依赖,可单测)。
 *
 * 分工:
 * - 本文件:设置模型与规范化、平台预设 shell、spawn 参数与环境、回放缓冲、渲染参数;
 * - `main.ts`:node-pty 会话表 + IPC(唯一 spawn 的地方);
 * - `ui/*.vue`:xterm 与设置页。
 */

// ---------- 数据模型 ----------

/** 一套 shell 配置(设置页里可增删改,选一套作默认) */
export interface TerminalProfile {
  id: string
  name: string
  /** 可执行文件:Windows 如 `powershell.exe` / `wsl.exe`;Linux 如 `/bin/bash` */
  shell: string
  /** 参数(逐项传给 node-pty,不做 shell 拼接) */
  args: string[]
  /** 工作目录;空串 = 用户主目录(见 buildSpawnSpec) */
  cwd: string
}

export interface TerminalSettings {
  version: number
  defaultProfileId: string
  fontFamily: string
  /** 字号(px),夹紧到 FONT_SIZE_RANGE */
  fontSize: number
  /** xterm scrollback 行数,夹紧到 SCROLLBACK_RANGE */
  scrollback: number
  /** 至少一条 */
  profiles: TerminalProfile[]
}

/** 发给终端页的渲染参数(设置页改动后经 `settings-changed` 广播的就是这个形状) */
export interface TerminalRenderSettings {
  fontFamily: string
  fontSize: number
  scrollback: number
}

export const SETTINGS_VERSION = 1
export const FONT_SIZE_RANGE = { min: 8, max: 32 } as const
export const SCROLLBACK_RANGE = { min: 200, max: 50_000 } as const
export const DEFAULT_FONT_SIZE = 14
export const DEFAULT_SCROLLBACK = 5000

export const DEFAULT_FONT_FAMILY = 'Consolas, "Cascadia Mono", "Microsoft YaHei", monospace'

/** 同时开着的终端会话上限(每个会话是一个真实 shell 进程) */
export const MAX_SESSIONS = 12

/** 每个会话保留的回放字符数(标签刷新/重建后重放,避免丢屏) */
export const REPLAY_MAX_CHARS = 200_000

/** 与 `style.css` 的 --bg / --fg / --accent 对齐的 xterm 主题(值必须是具体颜色,xterm 不认 CSS 变量) */
export const TERMINAL_THEME = {
  background: '#1e1f24',
  foreground: '#e8e8ee',
  cursor: '#4a8ef7',
  cursorAccent: '#1e1f24',
  selectionBackground: '#3a3d48',
  black: '#2e3038',
  red: '#e5534b',
  green: '#7ec96a',
  yellow: '#e2b93d',
  blue: '#4a8ef7',
  magenta: '#b07ce8',
  cyan: '#4fc1d8',
  white: '#e8e8ee',
  brightBlack: '#9aa0ad',
  brightRed: '#ff6b62',
  brightGreen: '#9ae08a',
  brightYellow: '#f5d34f',
  brightBlue: '#6aa6ff',
  brightMagenta: '#c795f5',
  brightCyan: '#6ed3e6',
  brightWhite: '#ffffff'
} as const

// ---------- 平台预设 ----------

/** 当前平台的预设 shell 候选(设置页「添加配置」列表;也是首次启动的默认配置) */
export function platformProfiles(platform: string, loginShell?: string): TerminalProfile[] {
  if (platform === 'win32') {
    return [
      { id: 'powershell', name: 'Windows PowerShell', shell: 'powershell.exe', args: [], cwd: '' },
      { id: 'pwsh', name: 'PowerShell 7', shell: 'pwsh.exe', args: ['-NoLogo'], cwd: '' },
      { id: 'cmd', name: '命令提示符', shell: 'cmd.exe', args: [], cwd: '' },
      // WSL 的 `~` 只有 wsl.exe 认(Windows 侧的 cwd 会变成 /mnt/c/…),所以启动目录由参数表达
      { id: 'wsl', name: 'WSL', shell: 'wsl.exe', args: ['--cd', '~'], cwd: '' },
      {
        id: 'git-bash',
        name: 'Git Bash',
        shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
        args: ['--login', '-i'],
        cwd: ''
      }
    ]
  }
  return [
    { id: 'login-shell', name: '登录 shell', shell: loginShell?.trim() || '/bin/bash', args: ['-l'], cwd: '' },
    { id: 'bash', name: 'bash', shell: '/bin/bash', args: ['-l'], cwd: '' },
    { id: 'zsh', name: 'zsh', shell: '/bin/zsh', args: ['-l'], cwd: '' }
  ]
}

/** 首次启动(或设置文件损坏)时的设置 */
export function defaultSettings(platform: string, loginShell?: string): TerminalSettings {
  const profiles = platformProfiles(platform, loginShell)
  return {
    version: SETTINGS_VERSION,
    defaultProfileId: profiles[0]?.id ?? 'powershell',
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
    scrollback: DEFAULT_SCROLLBACK,
    profiles
  }
}

// ---------- 规范化 ----------

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  // 只接受数字与非空数字字符串:null / undefined / '' / 布尔 / 对象一律走 fallback。
  // (不能用 `Number(value)`,那会把 null 与 '' 悄悄变成 0 —— 对字号是「8px」而不是「用户没填」。)
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && value.trim()) n = Number(value)
  else return fallback
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((a): a is string => typeof a === 'string')
}

function normalizeProfiles(value: unknown, fallback: TerminalProfile[]): TerminalProfile[] {
  if (!Array.isArray(value)) return fallback.map((p) => ({ ...p, args: [...p.args] }))
  const seen = new Set<string>()
  const out: TerminalProfile[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const shell = str(item.shell).trim()
    if (!shell) continue // 没有可执行文件的配置无意义,直接丢弃
    const id = str(item.id).trim() || `profile-${out.length + 1}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: str(item.name).trim() || shell,
      shell,
      args: normalizeArgs(item.args),
      cwd: str(item.cwd).trim()
    })
  }
  if (out.length === 0) return fallback.map((p) => ({ ...p, args: [...p.args] }))
  return out
}

/**
 * 把任意输入(磁盘上的旧文件 / 渲染层传来的 patch)夹成合法设置。
 * `fallback` 既提供缺省值,也提供 profiles 为空时的兜底。
 */
export function normalizeSettings(input: unknown, fallback: TerminalSettings): TerminalSettings {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const profiles = normalizeProfiles(raw.profiles, fallback.profiles)
  const wantedId = str(raw.defaultProfileId).trim()
  const defaultProfileId = profiles.some((p) => p.id === wantedId) ? wantedId : profiles[0].id
  return {
    version: SETTINGS_VERSION,
    defaultProfileId,
    fontFamily: str(raw.fontFamily).trim() || fallback.fontFamily || DEFAULT_FONT_FAMILY,
    fontSize: clampInt(raw.fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max, fallback.fontSize),
    scrollback: clampInt(raw.scrollback, SCROLLBACK_RANGE.min, SCROLLBACK_RANGE.max, fallback.scrollback),
    profiles
  }
}

/** 设置 → 终端页需要的渲染参数(广播时只发这三项,不发整份配置) */
export function renderSettingsOf(settings: TerminalSettings): TerminalRenderSettings {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    scrollback: settings.scrollback
  }
}

/** 生成不与现有 id 冲突的新配置 id(`p1`、`p2`…) */
export function newProfileId(existing: readonly string[]): string {
  const taken = new Set(existing)
  for (let i = 1; i < 1000; i++) {
    const id = `p${i}`
    if (!taken.has(id)) return id
  }
  return `p${Date.now()}`
}

// ---------- spawn 与环境 ----------

export interface SpawnSpec {
  file: string
  args: string[]
  cwd: string
}

/** 配置 → node-pty 的 spawn 参数(空 cwd 落到主目录) */
export function buildSpawnSpec(profile: TerminalProfile, opts: { homedir: string }): SpawnSpec {
  return {
    file: profile.shell.trim(),
    args: [...profile.args],
    cwd: profile.cwd.trim() || opts.homedir
  }
}

/**
 * Electron 进程里继承来的这几个变量会污染 shell(典型表现:shell 里执行 `node` 或再起 Electron 时行为异常),
 * 必须剔除;`TERM`/`COLORTERM` 则要显式补上,否则 WSL/Git Bash 里的程序按无终端处理,不输出颜色。
 */
const DROPPED_ENV_KEYS = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS'])

export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue
    if (DROPPED_ENV_KEYS.has(key)) continue
    out[key] = value
  }
  out.TERM = 'xterm-256color'
  out.COLORTERM = 'truecolor'
  return out
}

// ---------- 回放缓冲 ----------

export interface ReplayBuffer {
  chunks: string[]
  /** 字符数(不是字节数):只用来做上限裁剪,精确到字节没有收益 */
  chars: number
}

export function emptyReplay(): ReplayBuffer {
  return { chunks: [], chars: 0 }
}

/** 追加一段输出并裁到 `maxChars`(保留尾部 —— 最近的输出才是有用的) */
export function pushReplay(buffer: ReplayBuffer, chunk: string, maxChars = REPLAY_MAX_CHARS): ReplayBuffer {
  if (!chunk) return buffer
  const chunks = [...buffer.chunks, chunk]
  let chars = buffer.chars + chunk.length
  while (chars > maxChars && chunks.length > 1) {
    chars -= chunks[0].length
    chunks.shift()
  }
  return { chunks, chars }
}

export function replayText(buffer: ReplayBuffer): string {
  return buffer.chunks.join('')
}

// ---------- 设置页辅助 ----------

/**
 * 从 PATH 里找可执行文件(纯函数:拼接与存在性判断都由调用方注入,好在两端复用)。
 * - 带路径分隔符的 shell 按给定的绝对/相对路径判断;
 * - 否则逐个 PATH 项拼路径(Windows 上要靠 shell 名里写明的 `.exe` 后缀,PATHEXT 不展开)。
 */
export function findInPath(
  shell: string,
  pathValue: string,
  opts: { pathSeparator: string; joinPath: (dir: string, name: string) => string; exists: (candidate: string) => boolean }
): string | null {
  const name = shell.trim()
  if (!name) return null
  if (name.includes('/') || name.includes('\\')) return opts.exists(name) ? name : null
  for (const dir of pathValue.split(opts.pathSeparator)) {
    if (!dir) continue
    const candidate = opts.joinPath(dir, name)
    if (opts.exists(candidate)) return candidate
  }
  return null
}

/**
 * 设置页里一行参数文本 → argv(支持单/双引号包裹)。
 * 目的是让用户能写 `-NoLogo` 或 `--cd "~/my dir"` 这种,而不是实现完整 shell 解析。
 */
export function parseArgsLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (has) {
        out.push(current)
        current = ''
        has = false
      }
      continue
    }
    current += ch
    has = true
  }
  if (has) out.push(current)
  return out
}

/** argv → 设置页里的一行文本(有空格或引号的项加双引号) */
export function formatArgsLine(args: readonly string[]): string {
  return args
    .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')
}

// ---------- 键盘:复制 / 粘贴 ----------

/** 识别复制/粘贴所需的按键字段(与 DOM `KeyboardEvent` 结构化兼容,好让单测直接构造) */
export interface TerminalKeyLike {
  type: string
  /** 字符键(受 Shift/布局影响,如 `'C'`) */
  key?: string
  /** 物理键(`'KeyC'`),布局无关,优先用它 */
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** 终端页对 `Ctrl/⌘ + C/V` 的处置意图 */
export type TerminalClipboardIntent = 'copy' | 'copy-if-selection' | 'paste'

/** 主键字符:优先物理 code(AZERTY 等布局下 `key` 可能是符号),退化用 key */
function clipboardKeyChar(input: TerminalKeyLike): string {
  const code = (input.code ?? '').toLowerCase()
  if (/^key[a-z]$/.test(code)) return code.slice(3)
  return (input.key ?? '').toLowerCase()
}

/**
 * 终端里 `Ctrl/⌘+C`、`Ctrl/⌘+V` 的意图;返回 `null` = 不接管,交给 xterm / shell。
 *
 * 三条语义:
 * - `copy-if-selection`(`Ctrl+C`):**有选区才复制**,没有选区放行 —— xterm 会把 `\x03` 送进 pty,
 *   shell 于是收到中断信号(这才是终端里 Ctrl+C 的本义);
 * - `copy`(`Ctrl+Shift+C`):强制复制(无选区则什么都不做),绝不会误发中断;
 * - `paste`(`Ctrl+V` / `Ctrl+Shift+V`)。
 *
 * 两个不能省的细节:
 * - mac 上复制粘贴用 ⌘,而 `Ctrl+C` 在 mac 上仍是中断信号(`Ctrl+V` 在 bash 里是 quoted-insert,
 *   所以 mac 上也不接管它);
 * - **带 Alt 一律不接管** —— 部分键盘布局(AltGr)把特殊字符编码成 Ctrl+Alt,抢了会打断输入。
 */
export function matchClipboardKey(input: TerminalKeyLike, isMac: boolean): TerminalClipboardIntent | null {
  if (input.type !== 'keydown') return null
  if (input.altKey) return null
  const primary = isMac ? input.metaKey : input.ctrlKey
  // 带 Shift 时 Ctrl/⌘ 都认,兼容 Ctrl+Shift+C/V 这个老习惯(mac 上是 ⌃⇧C / ⌃⇧V)
  const shifted = input.shiftKey && (input.ctrlKey || input.metaKey)
  if (!primary && !shifted) return null
  const key = clipboardKeyChar(input)
  if (key === 'c') return input.shiftKey ? 'copy' : 'copy-if-selection'
  if (key === 'v') return 'paste'
  return null
}

// ---------- 插件 IPC / 广播契约(主进程与终端页共用同一份形状) ----------

/** 设置页「添加配置」列表项:预设 shell + 本机是否真的找得到 */
export interface TerminalCandidate {
  profile: TerminalProfile
  available: boolean
  /** 实际命中的绝对路径(PATH 命中的才有) */
  resolved: string | null
}

export interface TerminalAttachResult {
  ok: boolean
  error?: string
  profileId?: string
  profileName?: string
  /** true = 复用了该标签已有的会话(页面刷新) */
  reused?: boolean
  /** 该会话此前的输出(重放用) */
  replay?: string
  render?: TerminalRenderSettings
}

/** 主进程 → 终端页的广播事件名(`plugins.onEvent` 的 event 字段) */
export const TERMINAL_EVENTS = {
  data: 'data',
  exit: 'exit',
  settingsChanged: 'settings-changed',
  sessionClosed: 'session-closed'
} as const

export interface TerminalDataMessage {
  tabId: number
  chunk: string
}

export interface TerminalExitMessage {
  tabId: number
  code: number
}

export interface TerminalSessionClosedMessage {
  tabId: number
  reason: string
}
