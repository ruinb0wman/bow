/**
 * 终端插件纯逻辑(同构:无 electron / DOM / node 依赖,可单测)。
 *
 * 分工:
 * - 本文件:设置模型与规范化、平台预设 shell、spawn 参数与环境、回放缓冲、会话台账投影、渲染参数;
 * - `main.ts`:node-pty 会话表 + IPC(唯一 spawn 的地方);
 * - `ui/*.vue`:xterm 与设置页。
 */

import type { AgentState } from '@shared/agentState'

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
  /** 远程控制服务(S5 起;默认关闭、只绑回环) */
  remote: TerminalRemoteSettings
}

/**
 * 远程服务的对外状态(设置页 / `remote-changed` 的负载)。
 * 只含「怎么连」与「是否在跑」——**绝不含口令或 cookie**。
 */
export interface TerminalRemoteStatus {
  enabled: boolean
  bind: 'loopback' | 'lan'
  port: number
  running: boolean
  /** 本机访问地址;没在跑时为 null */
  url: string | null
  /** 局域网访问地址(仅 lan 模式非空) */
  lanUrls: string[]
  /** 最近一次启动失败的原因 */
  error: string | null
}

/** 发给终端页的渲染参数(设置页改动后经 `settings-changed` 广播的就是这个形状) */
export interface TerminalRenderSettings {
  fontFamily: string
  fontSize: number
  scrollback: number
}

/**
 * 远程控制服务(局域网)的设置。
 *
 * `bind` 默认 `loopback`:局域网模式是**显式开关** —— 绑 0.0.0.0 等于把一台机器的交互式 shell
 * 摆给同网段所有人试口令(鉴权在 remote/auth.ts,但“默认不开”仍然是第一条防线)。
 */
export interface TerminalRemoteSettings {
  enabled: boolean
  /** `loopback` = 只本机;`lan` = 监听 0.0.0.0(同网段设备可连) */
  bind: 'loopback' | 'lan'
  port: number
  /**
   * 访问口令(明文存在 `terminal.json`)。
   * 为什么不明文:① 你需要把它拄到手机上,设置页得能显示它;② 能读这个文件的人已经能读你的
   * 整个用户目录(也就拿到了这台机器的 shell),存哈希并不提高安全边界——与 `mcp-http` 的
   * `token` 同姿态。空串 = 不允许启动(**不允许无口令开远程**)。
   */
  password: string
}

export const REMOTE_DEFAULT_PORT = 8770
/** 低于 1024 需要特权(Windows 上又会被 Hyper-V 保留段抢),不提供 */
export const REMOTE_PORT_RANGE = { min: 1024, max: 65535 } as const
/** 口令最短长度:这是打到局域网的唯一口子,太短等于没设 */
export const REMOTE_MIN_PASSWORD = 8

export function defaultRemoteSettings(): TerminalRemoteSettings {
  return { enabled: false, bind: 'loopback', port: REMOTE_DEFAULT_PORT, password: '' }
}

/** 磁盘上可能没有这个字段(老设置文件),坏值一律回落到 fallback */
export function normalizeRemote(input: unknown, fallback: TerminalRemoteSettings): TerminalRemoteSettings {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const bind = raw.bind === 'lan' ? 'lan' : raw.bind === 'loopback' ? 'loopback' : fallback.bind
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    bind,
    port: clampInt(raw.port, REMOTE_PORT_RANGE.min, REMOTE_PORT_RANGE.max, fallback.port),
    // 不做长度夹取:太短的口令应该被**拒绝启用**而不是静默改掉(用户得知道自己设了什么)
    password: typeof raw.password === 'string' ? raw.password.slice(0, 200) : fallback.password
  }
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
    profiles,
    remote: defaultRemoteSettings()
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
    profiles,
    remote: normalizeRemote(raw.remote, fallback.remote)
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
  return spawnSpecOf(profile.shell, profile.args, profile.cwd, opts.homedir)
}

/**
 * 内核事件 `terminal:run` 带来的命令 → spawn 参数。与 `buildSpawnSpec` 共用同一套归一化:
 * 可执行文件去空白、空 cwd 落主目录;参数**逐项原样**(它们在参数里合法地含空格)。
 */
export function buildCommandSpawn(request: TerminalRunSpec, opts: { homedir: string }): SpawnSpec {
  return spawnSpecOf(request.file, request.args, request.cwd ?? '', opts.homedir)
}

/** `terminal:run` 里真正与 spawn 有关的三项(与 @shared/terminalRun 的请求同形,只是去掉名字) */
export interface TerminalRunSpec {
  file: string
  args: string[]
  cwd?: string
}

function spawnSpecOf(file: string, args: readonly string[], cwd: string, homedir: string): SpawnSpec {
  return { file: file.trim(), args: [...args], cwd: cwd.trim() || homedir }
}

/**
 * Electron 进程里继承来的这几个变量会污染 shell(典型表现:shell 里执行 `node` 或再起 Electron 时行为异常),
 * 必须剔除;`TERM`/`COLORTERM` 则要显式补上,否则 WSL/Git Bash 里的程序按无终端处理,不输出颜色。
 * 另外补一个 `BOW_TERMINAL=1`(终端插件与 pi 桥接扩展之间的约定)。
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
  // 告诉终端里的编码代理「你在 bow 的终端里」:pi 的桥接扩展用它做门禁
  // (见 `packages/pi-bow/extensions/bow-agent-state.ts`),别的终端不会收到这条,所以不会乱发 OSC。
  out.BOW_TERMINAL = '1'
  return out
}

/** 「你在 bow 的终端里」标记名(pi 桥接扩展的门禁;见 cleanEnv) */
export const BOW_TERMINAL_ENV = 'BOW_TERMINAL'

/** 这个 shell 是不是 WSL(`wsl.exe` / 带全路径的 `wsl.exe` / 没有后缀的 `wsl`) */
export function isWslShell(shell: string): boolean {
  const base = shell.trim().split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return base === 'wsl' || base === 'wsl.exe'
}

/**
 * 把 spawn 环境补成「桥接扩展能认出 bow」的形状。
 *
 * 为什么要为 wsl.exe 额外加一手:Windows 侧进程的环境变量**默认不会进 WSL 发行版**,
 * 只有列进 `WSLENV` 的才会被带进去。实测(wsl.exe 从 Windows 侧启动、命令是 `--cd ~ -e zsh -lc`):
 *
 * | 只看 wsl.exe 的 env | 加上 WSLENV | 结果 |
 * | --- | --- | --- |
 * | `BOW_TERMINAL=1` | — | 发行版里是空 |
 * | `BOW_TERMINAL=1` | `WSLENV=BOW_TERMINAL` | 发行版里是 `1` |
 * | `BOW_TERMINAL=1` | `WSLENV=PATH/l:PROXY/p:BOW_TERMINAL` | 发行版里是 `1`(用户原有的条目原样保留) |
 *
 * 不带 flag 的条目是「原样共享」(带 `/p` 会做路径翻译;我们的值是 `1`,不需要)。
 * 不是 wsl.exe 的 profile 一律原样返回(同一个对象引用),不引入任何额外变量。
 */
export function withBowTerminalEnv(
  env: Record<string, string>,
  shell: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  const vars: Record<string, string> = { [BOW_TERMINAL_ENV]: env[BOW_TERMINAL_ENV] ?? '1', ...extra }
  // 没有额外变量时保持原样(与旧行为一致:非 WSL 的 shell 不动环境)
  if (!isWslShell(shell)) return Object.keys(extra).length === 0 ? env : { ...env, ...vars }
  const entries = (env.WSLENV ?? '')
    .split(':')
    .filter(Boolean)
  // 已经列过(哪怕带 flag,如 `BOW_TERMINAL/u`)就不重复加
  const listed = new Set(entries.map((entry) => entry.split('/')[0]))
  const add = Object.keys(vars).filter((name) => !listed.has(name))
  return {
    ...env,
    ...vars,
    ...(add.length ? { WSLENV: [...entries, ...add].join(':') } : {})
  }
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

// ---------- 会话台账(对外投影) ----------

/**
 * 一个会话的对外投影:`listSessions` 的返回值、`sessions-changed` 广播的负载。
 *
 * 为什么不让调用方直接看 `Session`:那是主进程内部结构(pty 句柄、解析器、回放缓冲、合批队列),
 * 而面板 / 远程页 / MCP 工具要的只是「能渲染出来的最小集合」。
 *
 * `id` 现在**就是 tabId**(会话与标签 1:1,见 plans/2026-10-16-herder-remote 的 D1);
 * 将来若要解耦成「服务端持有的会话」,改这一处投影即可,三个调用方都不必动。
 */
export interface SessionInfo {
  id: number
  /** 标签标题的来源:profileName,或 `terminal:run` 带来的命令名 */
  title: string
  profileId: string
  /** 实际 spawn 的工作目录(`profile.cwd` 为空时是用户主目录) */
  cwd: string
  pid: number
  cols: number
  rows: number
  createdAt: number
  /** 最后一次收到 pty 输出的时刻;null = 还没产出过(刚 spawn 完) */
  lastOutputAt: number | null
  /** 代理状态(终端里的 pi 上报,见 @shared/agentState);null = 这个会话没跑代理 */
  agent: SessionAgentState | null
}

/** 会话上的代理状态:协议字段 + 收到时刻(面板要展示「多久前」) */
export interface SessionAgentState {
  state: AgentState
  done?: boolean
  title?: string
  text?: string
  at: number
}

/** 台账变化的合并窗口(ms):输出很密,合并后再广播 */
export const SESSIONS_THROTTLE_MS = 250

/**
 * `lastOutputAt` 在指纹里的分桶粒度(ms)。
 *
 * 不分桶的话,一个持续输出的会话(装依赖、跑测试)会让每次结算都算「变了」,
 * 广播就退化成「输出多快就播多快」—— 节流窗口形同虚设。分桶后最坏 5s 一次,
 * 而面板展示「最后活跃」到 5 秒精度完全够用。
 */
export const SESSION_ACTIVITY_BUCKET_MS = 5000

/**
 * 台账的指纹:只有它变了才值得广播(避免每个输出 chunk 都惊动渲染层)。
 *
 * 刻意**不包含** `createdAt`(不变,没有信息量)与精确的 `lastOutputAt`(见分桶说明)。
 * `\u0001` / `\u0002` 是分隔符:正常标题 / 路径里不会出现,不会把两个不同台账拼成同一个指纹。
 */
export function sessionSignature(infos: readonly SessionInfo[]): string {
  return infos
    .map((info) =>
      [
        info.id,
        info.title,
        info.profileId,
        info.cwd,
        info.pid,
        info.cols,
        info.rows,
        info.lastOutputAt === null ? '-' : Math.floor(info.lastOutputAt / SESSION_ACTIVITY_BUCKET_MS),
        info.agent
          ? [info.agent.state, info.agent.done ? 1 : 0, info.agent.title ?? '', info.agent.text ?? '', info.agent.at].join('~')
          : '-'
      ].join('\u0001')
    )
    .join('\u0002')
}

/**
 * Windows 上的可执行名补全:**裸命令名要带 `.exe`**,否则 node-pty 的 spawn 会报 `File not found`。
 *
 * 为什么需要它:node-pty 在 Windows 上把名字直接交给 `CreateProcess`,**不会**像 shell 那样补 PATHEXT 扩展名。
 * 实测(2026-10-16):`terminal_run {command:"node"}` → `File not found`,而同一个 `node` 在那个终端里
 * 手敲是能跑的(`node.exe` 版本号正常),`{command:"node.exe"}` 也正常 —— 这个不一致会让 AI 难受。
 *
 * 带路径或已经带扩展名的一律不动(`wsl.exe` / `C:\\Program Files\\nodejs\\node.exe`)。
 * 注:`.cmd` / `.bat` 这类 shim 补 `.exe` 没用(CreateProcess 不能直接跑),必须走 `cmd.exe /c`。
 */
export function withWindowsExeSuffix(file: string, platform: string = process.platform): string {
  if (platform !== 'win32') return file
  const name = file.trim()
  if (!name || name.includes('\\') || name.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(name)) return name
  return `${name}.exe`
}

/**
 * 面板排序用的「注意力等级」:越小越该被先看到。
 * 这是 herder 那个东西的全部意义 —— 「一眼看出谁在等我」,而不是按开场顺序排。
 */
export function attentionRank(info: SessionInfo): number {
  switch (info.agent?.state) {
    case 'blocked':
      return 0
    case 'working':
      return 1
    case 'idle':
      return info.agent.done ? 2 : 3
    default:
      return 4
  }
}

/** 最后活跃时刻(排序与展示共用):代理状态优先,其次 pty 输出,都没有就看创建时间 */
export function lastActiveAt(info: SessionInfo): number {
  return info.agent?.at ?? info.lastOutputAt ?? info.createdAt
}

/** 排序:等用户的 → 在跑的 → 刚跑完的 → 空着的 → 没跑代理的;同级按最后活跃新→旧,再按 id */
export function sortSessionsByAttention(infos: readonly SessionInfo[]): SessionInfo[] {
  return [...infos].sort((a, b) => {
    const rank = attentionRank(a) - attentionRank(b)
    if (rank !== 0) return rank
    const byTime = lastActiveAt(b) - lastActiveAt(a)
    return byTime !== 0 ? byTime : a.id - b.id
  })
}

/**
 * 「多久前」文案。负值(时钟回拨、或信号比本地时钟还新)一律说「刚刚」—— 显示 `-3 秒前` 很傻。
 * 粒度只到「天」:面板上没有人关心 37 小时还是 38 小时。
 */
export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 5000) return '刚刚'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/**
 * 路径缩略:只留给尾部足够的信息量(`/home/u/very/long/project` → `…/long/project`)。
 * 面板上把整条 cwd 铺出来会把其它列挤没 —— 完整路径放 `title`。
 */
export function shortPath(path: string, max = 32): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed.length <= max) return trimmed
  const separator = trimmed.includes('/') ? '/' : '\\'
  const parts = trimmed.split(/[\\/]+/).filter(Boolean)
  const tail: string[] = []
  for (let i = parts.length - 1; i >= 0; i--) {
    // 至少保留最后一段(否则一个超长目录名会被缩成「…/」)
    const candidate = [parts[i], ...tail].join(separator)
    if (tail.length > 0 && candidate.length > max) break
    tail.unshift(parts[i]!)
  }
  return `…${separator}${tail.join(separator)}`
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

// ---------- 键盘:Ctrl+Alt 组合(Windows 上的 AltGr 误判) ----------

/**
 * 判定「真的是 Ctrl+Alt 组合」需要的字段(与 DOM `KeyboardEvent` 结构化兼容,便于单测;
 * 唯一在 DOM 上取不到的是 `altGraph`,由调用方从 `getModifierState('AltGraph')` 取好传进来)。
 */
export interface CtrlAltChordLike {
  type: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  /** `ev.getModifierState('AltGraph')` —— 真实 AltGr 在打字符时为 true */
  altGraph: boolean
  isComposing?: boolean
}

/**
 * 这次按键是不是「看得出真的是 Ctrl+Alt 组合」(而不是 AltGr 在打字符)?
 *
 * 背景:Windows 上 AltGr 就是 `Ctrl+Alt` 的别名,唯一能从 DOM 侧分开的信号是 Chromium 在
 * **该组合能变成字符时**才置上的 `AltGraph` 修饰键(`ui/events/keycodes/platform_key_map_win.cc` 的
 * `ReplaceControlAndAltWithAltGraph`)。xterm.js 的 `CoreBrowserTerminal._isThirdLevelShift()` 却只看
 * `isWindows && altKey && ctrlKey`,把**所有** Ctrl+Alt 组合都当成第三级 shift 丢掉 ——
 * 连它自己刚算好的字节(`ESC + 控制字符`)一起吞,`Ctrl+Alt+P`(pi 切模式)这类键就永远进不了 pty。
 * 包装函数(`ui/xtermCtrlAltChord.ts`)只在返回 true 时把那条判据削弱成 false。
 *
 * 判据:
 * - 必须真的按着 Ctrl+Alt;
 * - `AltGraph` 必须**没**激活 —— 布局里这次组合能打出字时 Chromium 会置上它,所以没置上就证明打不出字;
 * - 带 Meta(⌘/Win)的不算(那不是 AltGr 的编码方式);
 * - 输入法组合中(`isComposing`)不算;
 * - 只看 keydown(keyup / keypress 不该再产出数据)。
 *
 * 已知边界:AltGr 布局(德语/法语/波兰语…)里 Chromium 会给 Ctrl+Alt 组合置上 `AltGraph`,
 * 真组合因此仍分不出来(维持现状:xterm 照旧吞掉)。这是 Windows 上 `Ctrl+Alt ≈ AltGr` 的固有歧义,
 * Windows Terminal 用 `KEY_EVENT_RECORD.uChar` 的 codepoint 猜,同样是启发式。
 */
export function isGenuineCtrlAltChord(input: CtrlAltChordLike): boolean {
  if (input.type !== 'keydown') return false
  if (input.isComposing) return false
  return input.ctrlKey && input.altKey && !input.metaKey && !input.altGraph
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
  sessionClosed: 'session-closed',
  /** 台账变化(负载 = 完整的 SessionInfo[]);见 SessionInfo 与 sessionSignature */
  sessionsChanged: 'sessions-changed',
  /** 远程服务的启停/端口/地址变化(负载 = RemoteStatus) */
  remoteChanged: 'remote-changed'
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

// ---------- pi 状态桥(设置页「一键接入」的跨端契约)----------

/**
 * 终端里的 pi 把状态写成 OSC(`@shared/agentState`),而**这条 OSC 得由 pi 进程里的一个扩展发出** ——
 * 所以「让 pi 认识 bow 的终端」这件事需要往 pi 的扩展目录里放一个文件。
 * 设置页 → 终端 → 「Pi 状态联动」的安装/卸载按钮就是在做这件事。
 *
 * 契约放 shared 而不放 `./piBridge` 的原因:`./piBridge` 是主进程侧模块(用 node:path + 注入的 fs),
 * 渲染层不该 import 它;设置页要的只是下面这几个类型。
 * 两侧共享的不变式(文件名 `bow-agent-state.ts` / 归属标记 `managed by bow` / 源路径
 * `packages/pi-bow/extensions/`)由 `tests/piBridgeExtension.test.ts` 钉住 —— 改一处必须同步改脚本与这里。
 */
export interface PiBridgeStatus {
  /** pi 的 agent 目录(默认 `~/.pi/agent`,可被 `PI_CODING_AGENT_DIR` 覆盖) */
  agentDir: string
  /** 安装目标:`<agentDir>/extensions/bow-agent-state.ts` */
  target: string
  /** 源文件:`<appPath>/packages/pi-bow/extensions/bow-agent-state.ts` */
  source: string
  /** pi 的 agent 目录存在吗(pi 装过没有) */
  agentDirExists: boolean
  installed: boolean
  /** 已安装内容与 bow 自带的一致 */
  upToDate: boolean
  /** 目标存在但不是 bow 装的(没有归属标记) */
  foreign: boolean
  /** 读得到 bow 自带的源(打包漏配 `build.files` 时是 false) */
  sourceAvailable: boolean
  error?: string
  /**
   * 「bow 在 Windows、pi 跑在 WSL2」时给的那行命令(设置页显示 + 可复制)。
   * 不适用时没有这个字段:bow 自己就跑在同一个系统里、或平台不是 Windows、或路径算不出来。
   */
  wsl?: PiBridgeWslHint
}

/** 把扩展也装进 WSL2 发行版的一行命令(见 `piBridge.wslHint`) */
export interface PiBridgeWslHint {
  /** 源:Windows 家目录里那份(`C:\Users\…` 在 WSL 里的样子,即 `/mnt/<盘>/…`) */
  from: string
  /** 目标:发行版里的扩展目录(`~` 在 WSL2 终端里就是发行版的家目录) */
  to: string
  /** 直接可复制粘贴进 WSL2 终端的一条命令 */
  command: string
}

export type PiBridgeAction = 'installed' | 'updated' | 'unchanged' | 'removed' | 'absent' | 'refused' | 'failed'

export interface PiBridgeResult {
  ok: boolean
  action: PiBridgeAction
  /** 给用户看的一句话(直接显示在设置页里) */
  message: string
  status: PiBridgeStatus
}
