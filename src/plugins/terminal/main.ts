/**
 * 终端插件主进程侧:node-pty 会话表 + IPC 面。
 *
 * 关键设计(改代码前先看这几条):
 * 1. **会话按 tabId 绑定**,不用「谁最后 attach」推断 —— 页面自己通过核心 IPC `tab:self` 拿到 tabId 再传进来,
 *    所以后台打开的标签、分屏里的标签都不会认错。标签刷新 = 同一个 tabId 再 attach 一次 → 复用会话并回放
 *    (见 `replay`),标签关闭(`tab:closed`)才 kill。
 * 2. **node-pty 惰性加载**:它是原生模块,加载失败不能连累整个浏览器。第一次 attach 时才 `import()`,
 *    失败信息原样回给终端页显示,插件与其它功能照常。
 * 3. **输出走广播、上行用 invoke**:主进程 → 页面的数据经内核 broadcaster 到达所有内部页面标签,
 *    终端页按自己的 tabId 过滤(`TERMINAL_EVENTS.data`);页面 → 主进程的按键/resize 直接 `plugins.invoke`。
 *    插件侧对输出做 8ms 合批,避免高频输出把 IPC 打爆。
 * 4. `pty.kill()` 在 Windows(ConPTY)下会连进程树一起回收,所以这里只管调用,不做 PID 追踪。
 * 5. **别的插件可以让它在指定标签里跑一条命令**(内核事件 `terminal:run`,见 `@shared/terminalRun`)。
 *    发起方负责先拿到 tabId(`ctx.tabs.openInternal`),这里只存待办、等终端页 attach 时才 spawn ——
 *    尺寸与回放这些事因此仍然只有一条路径。
 * 6. **它是不可停用的核心插件**(manifest `core + alwaysOn`):核心侧直接依赖它的有
 *    `InternalPageId`/`isTerminalTab()`(Ctrl+W·L·R·←→ 归属)、`releasesToTerminal()`、
 *    `RendererEntryName` 与 vite 入口;编辑器插件靠 `terminal:run` 跑 nvim,5 个 `terminal_*` MCP 工具也在这里。
 *    关掉只会留下一个永远 error 的 `bow://terminal` 页,所以内核在 `setEnabled` 里直接拒绝。
 */

import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { z } from 'zod'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import { errorContent, textContent } from '../../main/plugins/mcpResult'
import { BOW_SIGNAL_VERSION, OscSignalParser } from '@shared/agentState'
import type { AgentSignal } from '@shared/agentState'
import { TERMINAL_RUN_EVENT, parseTerminalRunRequest } from '@shared/terminalRun'
import type { TerminalRunRequest } from '@shared/terminalRun'
import { installPiBridge, piBridgeStatus, uninstallPiBridge } from './piBridge'
import type { PiBridgeEnv, PiBridgeIo } from './piBridge'
import { SessionHub } from './remote/hub'
import { PiChatHub } from './remote/piChat'
import { RemoteAuth, createAuthKey } from './remote/auth'
import { startRemoteServer } from './remote/server'
import type { RemoteServerHandle } from './remote/server'
import { probeTailscale } from './remote/tailscale'
import type { RemoteSessionApi } from './remote/protocol'
import {
  MAX_SESSIONS,
  REMOTE_DEFAULT_PORT,
  REMOTE_MIN_PASSWORD,
  REPLAY_MAX_CHARS,
  SESSIONS_THROTTLE_MS,
  TERMINAL_EVENTS,
  buildCommandSpawn,
  buildSpawnSpec,
  cleanEnv,
  defaultSettings,
  defaultRemoteSettings,
  emptyReplay,
  findInPath,
  isWslPath,
  normalizeSettings,
  platformProfiles,
  pushReplay,
  renderSettingsOf,
  replayText,
  sessionSignature,
  withBowTerminalEnv,
  withWindowsExeSuffix,
  wslWrap
} from './shared'
import type {
  ReplayBuffer,
  SessionAgentState,
  SessionInfo,
  TerminalAttachResult,
  TerminalCandidate,
  TerminalProfile,
  TerminalRemoteStatus,
  TerminalSettings
} from './shared'

/** 输出合批窗口(ms):太小无意义,太大会让交互式程序显钝 */
const FLUSH_MS = 8

/** `readTail` 不传 chars 时的默认尾部长度(给 MCP 读日志用,不宜太大) */
const READ_TAIL_DEFAULT_CHARS = 4000

type PtyModule = typeof import('node-pty')

/** 插件依赖注入缝(只有单测用):替换 node-pty 的加载,好让用例能喂假 pty 输出 */
export interface TerminalPluginDeps {
  loadPty?: () => Promise<PtyModule>
  /**
   * `terminal_run` 等 spawn 结论的时长(ms,默认 3000;单测用小值)。
   * pty 是在终端页 attach 时才 spawn 的,不等一下就只能拿「标签开好了」当成功。
   */
  runWaitMs?: number
  /** 平台(默认 `process.platform`;单测要在 Linux 上验 Windows 的 WSL 包裹果) */
  platform?: NodeJS.Platform
}

interface Session {
  tabId: number
  profileId: string
  profileName: string
  proc: import('node-pty').IPty
  replay: ReplayBuffer
  cols: number
  rows: number
  /** 已产出但还没发出去的输出(合批) */
  pending: string[]
  flushTimer: NodeJS.Timeout | null
  /** 代理状态信号的流式解析器(见 `@shared/agentState`);回放缓冲里存的是**剥干净**的文本 */
  parser: OscSignalParser
  /** 上一次报出去的代理状态去重键;null = 还没报过 */
  agentKey: string | null
  /** 见过桥接信号(`1337;bow`)之后,pi 内建的 `9;4` 降级信号就不再采信 */
  sawBridge: boolean
  /** 工作目录:`profile.cwd` / `terminal_run` 给的路径;跑了代理之后以代理报的为准(见 reportAgent) */
  cwd: string
  createdAt: number
  /** 最后一次收到 pty 输出的时刻;null = 还没产出过 */
  lastOutputAt: number | null
  /** 代理状态的结构化副本(台账要看);与 `agentKey` 的区别:后者是发往内核的去重键 */
  agent: SessionAgentState | null
  /**
   * 这个会话的控制令牌:pty 环境变量 `BOW_CONTROL_TOKEN` 交给 pi 里的扩展,
   * 它拿它连 WS 的 `role=pi`。每个会话一份(同机其他进程猜不到)。
   */
  controlToken: string
}

/**
 * Windows:先按**进程树** taskkill,再把剩下的事交给 node-pty。
 *
 * 为什么要多这一步:node-pty 的 `kill()` 在 ConPTY 下会 fork 一个 `conpty_console_list_agent`
 * 去枚举控制台进程列表,而那个 agent 需要 `AttachConsole` —— 在 GUI 进程里会失败
 * (`Error: AttachConsole failed`,实测每次关终端一条),兜底退化成 5s 超时后只 kill innerPid。
 * 结果是:shell 内的子进程树(典型的 `npm run dev` dev server)可能留在那里占着端口。
 * taskkill /T 能把整棵树带走;shell 已经自己退出(用户敲了 exit)时它只报错一次,静默忽略。
 */
function killTree(pid: number): void {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return
  try {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {
      /* 没有这个进程,忽略 */
    })
    child.unref()
  } catch {
    /* taskkill 不可用也不影响 pty.kill() 的主路径 */
  }
}

/** 目录不合法时返回人话,能用就返回 null(spawn 前先验,否则失败只会落在那个终端标签里) */
function dirProblem(dir: string): string | null {
  // Windows 上的 POSIX 路径(手机新建 pi 到 WSL 目录):Windows 的 statSync 会把它解析成
  // `C:\home\…` 然后 ENOENT,只能进发行版问一声(实测 ~180ms,按钮点一次可以接受)
  if (isWslPath(dir)) {
    const probe = spawnSync('wsl.exe', ['-e', 'test', '-d', dir.trim()], { timeout: 5000 })
    return probe.status === 0 ? null : `目录不存在(不在这台机器的 WSL 里):${dir}`
  }
  try {
    return statSync(dir).isDirectory() ? null : `不是目录:${dir}`
  } catch {
    return `目录不存在:${dir}`
  }
}

function toPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 「一键接入 pi 状态桥」的真 fs 适配(纯逻辑在 `./piBridge`,I/O 从这里注入)。
 * `readFile` 失败返回 null(而不是抛),因为上层先 `exists` 再读,读不到只可能是权限/编码问题。
 */
function realPiBridgeIo(): PiBridgeIo {
  return {
    exists: (path) => existsSync(path),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf-8')
      } catch {
        return null
      }
    },
    writeFile: (path, content) => writeFileSync(path, content, 'utf-8'),
    mkdirp: (path) => void mkdirSync(path, { recursive: true }),
    remove: (path) => rmSync(path)
  }
}

function createTerminalPlugin(deps: TerminalPluginDeps = {}): PluginMain {
  /** 每个插件实例一份状态;activate 里初始化,deactivate 里清空 */
  let store: PluginStorage<TerminalSettings> | null = null
  let defaults: TerminalSettings | null = null
  let context: PluginContext | null = null
  let ptyModule: PtyModule | null = null
  let ptyError: string | null = null
  let onBeforeQuit: (() => void) | null = null
  const sessions = new Map<number, Session>()
  /**
   * `terminal:run` 待办:标签还没 attach 时先存着,attach 时优先它。
   * 用掉即删(spawn 失败保留 —— 刷新一下就能重试);标签关闭时一并清。
   */
  const pendingRuns = new Map<number, TerminalRunRequest>()
  /**
   * `terminal_run` 的启动失败记录(tabId → 原因)。看到它的工具就能如实报错,
   * 而不是拿一个「标签开好了」回 `ok:true`。attach 重试成功时清掉。
   */
  const runFailures = new Map<number, string>()
  /** `terminal_run` 最多等多久 spawn 结论(见 TerminalPluginDeps.runWaitMs) */
  const runWaitMs = deps.runWaitMs ?? 3000
  const platform = deps.platform ?? process.platform
  /** 远程订阅扇出:pty 输出与台账的第二个出口(第一个是渲染层 IPC) */
  const hub = new SessionHub()
  /** 对话桥:pi 的结构化对话 → 手机(见 remote/piChat 的注释,为什么不渲 xterm) */
  const piChat = new PiChatHub()
  /** 远程服务句柄;null = 没在跑(未启用 / 启动失败 / 已停) */
  let remote: RemoteServerHandle | null = null
  /** 最近一次启动失败的原因(设置页要看得见,不能只进日志) */
  let remoteError: string | null = null
  /** 正在对齐的 applyRemote;并发调用合并到它(见 applyRemote 的注释) */
  let remoteApplying: Promise<TerminalRemoteStatus> | null = null
  /** 对齐期间设置又变了:结束后再对一次 */
  let remoteDirty = false
  /** 当前跑着的服务对应的口令(口令变了必须重建 auth,否则旧口令还能登录) */
  let remotePassword: string | null = null
  /** 签名密钥的存放(插件自己的文件,不进用户可编辑的设置) */
  let remoteKeyStore: PluginStorage<{ key: string }> | null = null
  /** 台账的合并定时器;deactivate 时要清掉,否则插件停用后还会往已回收的 ctx 上广播 */
  let sessionsTimer: NodeJS.Timeout | null = null
  /** 上一次广播出去的台账指纹;`null` = 还没播过 */
  //
  // 用 null 而不是空串作哨兵值:空台账的指纹**就是**空串,拿它作哨兵会把「全部会话都关光了」
  // 这一次广播吞掉(一个会话都没建过时尤其明显)。
  let lastSessionsSignature: string | null = null

  // ---------- node-pty ----------

  async function loadPty(): Promise<PtyModule> {
    if (ptyModule) return ptyModule
    if (ptyError) throw new Error(ptyError)
    try {
      const mod: PtyModule & { default?: PtyModule } = deps.loadPty
        ? await deps.loadPty()
        : ((await import('node-pty')) as unknown as PtyModule & { default?: PtyModule })
      const resolved = typeof mod.spawn === 'function' ? mod : mod.default
      if (!resolved || typeof resolved.spawn !== 'function') throw new Error('node-pty 导出形状不符合预期')
      ptyModule = resolved
      return resolved
    } catch (e) {
      ptyError = e instanceof Error ? e.message : String(e)
      context?.logError('node-pty 加载失败', e)
      throw new Error(`终端后端不可用(node-pty 加载失败):${ptyError}`)
    }
  }

  // ---------- 会话 ----------

  function flush(session: Session): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (session.pending.length === 0) return
    const chunk = session.pending.join('')
    session.pending = []
    context?.ipc.emit(TERMINAL_EVENTS.data, { tabId: session.tabId, chunk })
    // 同一口数据喂给远程订阅者(合批后的,不是每个 chunk 都搬一次)
    hub.publish({ t: 'data', id: session.tabId, chunk })
  }

  function enqueue(session: Session, chunk: string): void {
    session.pending.push(chunk)
    if (session.flushTimer) return
    session.flushTimer = setTimeout(() => flush(session), FLUSH_MS)
  }

  // ---------- 编码代理状态(终端里的 pi 等,见 @shared/agentState)----------

  /**
   * 把一个状态报给主进程(`service.agent`,由 `main/agentNotify.ts` 落地成角标 + 系统通知)。
   * 去重按「完整状态键」:同一状态重复喊(心跳 / 重复输出)不该惊动标签栏、也不该重复弹通知。
   */
  function reportAgent(session: Session, signal: AgentSignal): void {
    const key = [signal.state, signal.done ? 1 : 0, signal.agent ?? '', signal.title ?? '', signal.text ?? ''].join('|')
    if (key === session.agentKey) return
    session.agentKey = key
    // 台账侧要的是结构化副本 + 收到时刻(面板展示「多久前」),与去重键各存一份
    session.agent = {
      state: signal.state,
      ...(signal.done ? { done: true } : {}),
      ...(signal.title ? { title: signal.title } : {}),
      ...(signal.text ? { text: signal.text } : {}),
      at: Date.now()
    }
    // 代理报的 cwd 才是真目录(WSL 里是 `/home/…`,而启动 pty 的是 `C:\Users\…` 那个壳)
    if (signal.cwd) session.cwd = signal.cwd
    context?.service.agent.report({ ...signal, tabId: session.tabId })
    notifySessions()
  }

  /** 会话结束 / 标签关闭:清掉角标(`idle` 不带 `done` → 不弹「已完成」通知) */
  function clearAgent(session: Session): void {
    if (session.agent === null) return
    session.agent = null
    notifySessions()
    if (session.agentKey === null) return
    session.agentKey = null
    context?.service.agent.report({ v: BOW_SIGNAL_VERSION, state: 'idle', tabId: session.tabId })
  }

  function killSession(tabId: number, reason: string): void {
    const session = sessions.get(tabId)
    pendingRuns.delete(tabId)
    runFailures.delete(tabId)
    if (!session) return
    sessions.delete(tabId)
    if (session.flushTimer) clearTimeout(session.flushTimer)
    clearAgent(session)
    try {
      killTree(session.proc.pid)
      session.proc.kill()
    } catch (e) {
      context?.log('kill 会话失败', tabId, String(e))
    }
    context?.ipc.emit(TERMINAL_EVENTS.sessionClosed, { tabId, reason })
    hub.publish({ t: 'closed', id: tabId, reason })
    piChat.forget(tabId)
    context?.log('会话已结束', tabId, reason, session.profileName)
    notifySessions()
  }

  function killAll(reason: string): void {
    for (const tabId of [...sessions.keys()]) killSession(tabId, reason)
  }

  // ---------- 会话台账(台账 = 三个调用方共用的那一份描述:本地面板 / 远程页 / MCP)----------

  /**
   * 台账里报给外部的 cwd:Linux 上以 `/proc/<pid>/cwd` 为准(它就是那个 shell 的当前目录,
   * `cd` 立刻可见,不依赖 shell 是否发 OSC 7);其它平台沿用 `session.cwd`(OSC 7 / 9;9 / pi 报的)。
   *
   * 为什么在**投影**里读而不是在输入流里读:读的是同一份状态,但省掉「轮询 / 监听哪个事件」的决策 ——
   * 台账本来就只在 `emitSessions` 里结算(闸门是 `SESSIONS_THROTTLE_MS` 与指纹去重),
   * 而每次结算都是一次 12 个 readlink 的代价。
   */
  function liveCwd(session: Session): string {
    if (process.platform !== 'linux') return session.cwd
    try {
      return readlinkSync(`/proc/${session.proc.pid}/cwd`) || session.cwd
    } catch {
      return session.cwd
    }
  }

  function describeSession(session: Session): SessionInfo {
    return {
      id: session.tabId,
      title: session.profileName,
      profileId: session.profileId,
      cwd: liveCwd(session),
      pid: session.proc.pid,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt,
      lastOutputAt: session.lastOutputAt,
      agent: session.agent
    }
  }

  function listSessions(): SessionInfo[] {
    // 按 id 排序:Map 的插入顺序会随「关一个再开一个」错位,面板每次刷新都跳来跳去很恼人
    return [...sessions.values()].map(describeSession).sort((a, b) => a.id - b.id)
  }

  /** 结算一次:指纹相同就不发(输出密时这是唯一的去重点,见 sessionSignature) */
  function emitSessions(): void {
    const infos = listSessions()
    const signature = sessionSignature(infos)
    if (signature === lastSessionsSignature) return
    lastSessionsSignature = signature
    context?.ipc.emit(TERMINAL_EVENTS.sessionsChanged, infos)
    // 远程那边要同一份台账。与 IPC 用**同一个指纹去重**,所以远程不会比面板多播
    hub.publish({ t: 'sessions', sessions: infos })
  }

  /**
   * 「台账可能变了」:只负责合并 `SESSIONS_THROTTLE_MS`(触发点很多:每个输出 chunk、每次状态上报)。
   * 真正的去重在看指纹的 `emitSessions` —— 两层都要,缺一个就是要么刷屏要么迟顿。
   */
  function notifySessions(): void {
    if (sessionsTimer) return
    sessionsTimer = setTimeout(() => {
      sessionsTimer = null
      emitSessions()
    }, SESSIONS_THROTTLE_MS)
  }

  /**
   * 等 `terminal_run` 的 spawn 结论。
   *
   * 为什么必须等:pty 是在**终端页 attach 时**才 spawn 的(那时才知道尺寸),所以 `createSession`
   * 只能先把标签开出来。不等一下的话,「命令不存在 / 权限不对」这类失败会被当成 `ok:true` 回去。
   * 三种结论:`running`(pty 起来了)/ `failed`(带了原因)/ `starting`(超时还没结论,不慌报)。
   */
  async function waitForRun(tabId: number): Promise<{ state: 'running' | 'failed' | 'starting'; error?: string }> {
    const deadline = Date.now() + runWaitMs
    for (;;) {
      const failure = runFailures.get(tabId)
      if (failure !== undefined) return { state: 'failed', error: failure }
      if (sessions.has(tabId)) return { state: 'running' }
      if (Date.now() >= deadline) return { state: 'starting' }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * 读一个会话的尾部输出(已剥 OSC 的纯文本)。给 MCP / 远程只读用 —— 不是终端网格,
   * 是原始字节流的尾部:在 xterm 里重放能正确重绘,但不带滚动历史(见 `replayText`)。
   */
  function readTail(tabId: unknown, chars: unknown): { ok: boolean; text?: string; error?: string } {
    const session = sessions.get(Number(tabId))
    if (!session) return { ok: false, error: '会话不存在' }
    const limit = toPositiveInt(chars, READ_TAIL_DEFAULT_CHARS, 1, REPLAY_MAX_CHARS)
    const text = replayText(session.replay)
    return { ok: true, text: text.length > limit ? text.slice(-limit) : text }
  }

  /**
   * 「新建会话」= 开一个 `bow://terminal` 标签;带 `command` 时再发 `terminal:run` 让终端页去 spawn 它。
   *
   * ⚠️ 返回时 pty **还没** spawn(要等终端页 attach,那时才知道 cols/rows)——所以这里只能给出 tabId。
   * 「会话真的起来了」的信号是 `sessions-changed` 里出现这个 id(计划里的 pending → created)。
   *
   * 不带 `command` 时忽略 `cwd`:v1 不为「默认 shell + 指定目录」扩展 `TerminalRunRequest`,
   * 免得给另一条通路(编辑器插件)加没人用的字段。
   */
  function createSession(input: unknown): { ok: boolean; tabId?: number; error?: string } {
    const raw = (input ?? {}) as { command?: unknown; args?: unknown; cwd?: unknown; name?: unknown }
    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    if (raw.args !== undefined && !Array.isArray(raw.args)) return { ok: false, error: 'args 必须是字符串数组' }
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : []
    if (raw.args !== undefined && args.length !== (raw.args as unknown[]).length) {
      return { ok: false, error: 'args 必须是字符串数组' }
    }
    // 目录先验一遍(**先于开标签**):spawn 时才失败的话错误只会落在那个终端标签里,手机端只看得到「没通道」
    const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : ''
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : ''
    if (command && cwd) {
      const problem = dirProblem(cwd)
      if (problem) return { ok: false, error: problem }
    }
    const tabId = context?.tabs.openInternal('terminal')
    if (tabId == null) return { ok: false, error: '无法新建终端标签(没有可用窗口)' }
    if (command) {
      // 时序不变式(见 @shared/terminalRun):openInternal → emit → 页面异步加载 → attach,
      // 所以 emit 一定早于 attach,不需要握手。
      context?.events.emit(TERMINAL_RUN_EVENT, {
        tabId,
        file: command,
        args,
        ...(cwd ? { cwd } : {}),
        ...(name ? { name } : {})
      } satisfies TerminalRunRequest)
    }
    return { ok: true, tabId }
  }

  /** 当前默认配置(找不到就退到第一条 —— 设置文件被手改坏也不会崩) */
  function defaultProfile(settings: TerminalSettings): TerminalProfile {
    return settings.profiles.find((p) => p.id === settings.defaultProfileId) ?? settings.profiles[0]
  }

  // ---------- 远程服务(S5:启停 + 状态;鉴权与 WS 协议在 S6/S7)----------

  /**
   * 远程要的会话操作(server 只认识这个窄接口,不知道 pty / 回放缓冲长什么样)。
   * 全部复用本文件里那批函数 —— 面板 / MCP / 远程三个门脸一份实现。
   */
  function remoteSessionApi(): RemoteSessionApi {
    return {
      list: () => listSessions(),
      attach: (id, cols, rows) => {
        const session = sessions.get(id)
        if (!session) return { ok: false, error: '会话不存在(可能已被关闭)' }
        // 「最后一个 resize 的客户端胜」:远程 attach 会把自己的尺寸推给 pty
        resize(id, cols, rows)
        return {
          ok: true,
          replay: replayText(session.replay),
          cols: session.cols,
          rows: session.rows,
          title: session.profileName
        }
      },
      input: (id, data) => write(id, data),
      resize: (id, cols, rows) => resize(id, cols, rows),
      readTail: (id, chars) => readTail(id, chars),
      create: (input) => {
        const created = createSession(input)
        if (!created.ok) return { ok: false, error: created.error }
        // pty 异步起:这里不阻塞等 spawn(远程页靠随后的 sessions/data 事件追状态)
        return { ok: true, id: created.tabId, state: 'starting' }
      },
      close: (id) => {
        if (!sessions.has(id)) return false
        killSession(id, 'closed-by-request')
        return true
      },
      controlToken: (id) => sessions.get(id)?.controlToken ?? null
    }
  }

  function remoteStatus(): TerminalRemoteStatus {
    const want = store?.get().remote ?? defaultRemoteSettings()
    return {
      enabled: want.enabled,
      bind: want.bind,
      port: remote?.port ?? want.port,
      running: remote != null,
      url: remote?.url ?? null,
      lanUrls: remote?.lanUrls ?? [],
      error: remoteError
    }
  }

  function notifyRemote(): TerminalRemoteStatus {
    const status = remoteStatus()
    context?.ipc.emit(TERMINAL_EVENTS.remoteChanged, status)
    return status
  }

  /**
   * 「异地访问」自检用的 CLI 执行器:异步 + 3s 硬超时,失败一律 null。
   * 不能用 spawnSync —— `tailscale.exe` 冷启动就要几百毫秒,自检要跑三条命令,同步会把主进程卡住。
   */
  function runTailscale(bin: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      let out = ''
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const finish = (value: string | null): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      const child = spawn(bin, args, { windowsHide: true })
      timer = setTimeout(() => {
        child.kill()
        finish(null)
      }, 3000)
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
      })
      // stderr 只吞掉:失败就是失败,CLI 的报错原文没有搬进 UI 的价值
      child.stderr?.on('data', () => {})
      child.on('error', () => finish(null))
      child.on('close', (code) => finish(code === 0 ? out : null))
    })
  }

  /**
   * cookie 签名密钥:首次使用生成 32 字节并落盘。
   * 单独一个文件而不是塞进 `terminal.json` —— 设置文件是用户会手改/导出的,密钥不该跟着跑。
   */
  function remoteKey(): Buffer {
    const existing = remoteKeyStore?.get().key ?? ''
    if (existing) return Buffer.from(existing, 'hex')
    const key = createAuthKey()
    remoteKeyStore?.setRaw({ key })
    return Buffer.from(key, 'hex')
  }

  async function stopRemote(): Promise<void> {
    const handle = remote
    remote = null
    remotePassword = null
    // 先告诉订阅者（S7 起有真客户端）服务要走，再关监听
    hub.clear('服务已停止')
    piChat.clear('服务已停止')
    if (!handle) return
    try {
      await handle.close()
      context?.log('远程服务已停止')
    } catch (e) {
      context?.logError('远程服务停止失败', e instanceof Error ? e.message : e)
    }
  }

  /**
   * 按当前设置把服务对齐到“应该的状态”：没开就停，已开且端口/绑定没变就不动，
   * 变了就重启。幂等：activate、设置变更、重新启用三条路都调它。
   * 启动失败**不抛**（只落到 `status.error` 与日志）—— 端口被占不该连累插件。
   */
  function applyRemote(): Promise<TerminalRemoteStatus> {
    // 并发必须合并:设置变更与 activate 的对齐可能撞在一起,两个 startRemoteServer 同时跑
    // 会抢同一个端口(EADDRINUSE 报的是自己刚开的那个)。在飞的调用只加一个「脏」标记,
    // 结束后再对一次 —— 最终状态一定与设置一致。
    if (remoteApplying) {
      remoteDirty = true
      return remoteApplying
    }
    remoteApplying = applyRemoteNow().finally(() => {
      remoteApplying = null
      if (remoteDirty) {
        remoteDirty = false
        void applyRemote()
      }
    })
    return remoteApplying
  }

  async function applyRemoteNow(): Promise<TerminalRemoteStatus> {
    const want = store?.get().remote ?? defaultRemoteSettings()
    if (!want.enabled) {
      await stopRemote()
      return notifyRemote()
    }
    if (remote && remote.port === want.port && remote.bind === want.bind && remotePassword === want.password) {
      return notifyRemote()
    }
    await stopRemote()
    // 无口令 / 口令太短一律不启动 —— 不允许把一个 shell 挂在局域网上等别人试
    if (!RemoteAuth.isUsablePassword(want.password, REMOTE_MIN_PASSWORD)) {
      remoteError = `口令至少 ${REMOTE_MIN_PASSWORD} 位(现在${want.password ? '太短' : '是空的'})`
      return notifyRemote()
    }
    try {
      remote = await startRemoteServer({
        port: want.port,
        bind: want.bind,
        hub,
        auth: new RemoteAuth({ password: want.password, key: remoteKey() }),
        // 探活/登录后首屏/WS 上行全部走这一份会话操作
        sessions: remoteSessionApi(),
        // 对话桥:手机读 pi 的消息对象而不是终端字节(见 remote/piChat)
        piChat,
        // 远程页的构建产物(`npm run build:remote` → out/remote)。
        // 打包后同样在 app 根目录下(build.files 已含 out/**)。目录不存在时 / 会给 503 + 提示。
        staticDir: join(app.getAppPath(), 'out', 'remote')
      })
      remotePassword = want.password
      remoteError = null
      context?.log(
        '远程服务已启动',
        remote.url,
        remote.bind === 'lan' ? `局域网 ${remote.lanUrls.join(' ') || '(未检测到地址)'}` : '仅本机'
      )
    } catch (e) {
      remote = null
      remotePassword = null
      remoteError = e instanceof Error ? e.message : String(e)
      context?.logError('远程服务启动失败', remoteError)
    }
    return notifyRemote()
  }

  function describe(session: Session): TerminalAttachResult {
    return {
      ok: true,
      profileId: session.profileId,
      profileName: session.profileName,
      replay: replayText(session.replay),
      render: renderSettingsOf(store!.get())
    }
  }

  async function attach(input: { tabId?: unknown; cols?: unknown; rows?: unknown } = {}): Promise<TerminalAttachResult> {
    const tabId = Number(input?.tabId)
    if (!Number.isInteger(tabId) || tabId <= 0) return { ok: false, error: '缺少有效的 tabId' }
    const cols = toPositiveInt(input?.cols, 80, 2, 500)
    const rows = toPositiveInt(input?.rows, 24, 2, 300)

    const existing = sessions.get(tabId)
    if (existing) {
      // 页面刷新/重建:复用会话,顺手把尺寸对齐回去
      const changed = existing.cols !== cols || existing.rows !== rows
      existing.cols = cols
      existing.rows = rows
      try {
        existing.proc.resize(cols, rows)
      } catch (e) {
        context?.log('复用会话时 resize 失败', tabId, String(e))
      }
      // 分屏/换窗口尺寸后刷新页面:台账里的 cols/rows 要跟着变(指纹会自己去掉无变化的噪声)
      if (changed) notifySessions()
      return { ...describe(existing), reused: true }
    }

    if (sessions.size >= MAX_SESSIONS) {
      return { ok: false, error: `最多同时开 ${MAX_SESSIONS} 个终端,先关掉一个再开` }
    }

    const settings = store!.get()
    const profile = defaultProfile(settings)
    // 内核事件 `terminal:run` 指定的命令优先(编辑器插件用这条路开 nvim);没有就用默认 shell profile,即今天的行为。
    const run = pendingRuns.get(tabId)
    // Windows + WSL 路径:目录交给 `wsl.exe --cd`,命令打进它的交互 shell(见 wslWrap:
    // `wsl.exe -e pi` 找不到 pi,PATH 只配在不被非交互 shell 读的 rc 里)
    const wrap = run ? wslWrap(run.file, run.args, run.cwd ?? '', platform) : null
    const spec = wrap
      ? { file: 'wsl.exe', args: wrap.args, cwd: homedir() }
      : run
        ? buildCommandSpawn(
            // Windows 上裸命令要补 `.exe`,否则 node-pty 直接报 File not found(见 withWindowsExeSuffix)
            { ...run, file: withWindowsExeSuffix(run.file, platform) },
            { homedir: homedir() }
          )
        : buildSpawnSpec(profile, { homedir: homedir() })
    // 标签标题用命令名(`nvim(a.txt)`):终端页拿 `profileName` 当标题,前端不用改一行
    const profileId = run ? 'command' : profile.id
    const profileName = run ? (run.name ?? run.file) : profile.name

    let mod: PtyModule
    try {
      mod = await loadPty()
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }

    try {
      const controlToken = randomBytes(16).toString('hex')
      const proc = mod.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spec.cwd,
        // wsl.exe 的 profile 还要把 BOW_* 列进 WSLENV —— 否则 Windows 侧的变量进不了发行版,
        // 终端里的 pi 扩展会认不出「自己在 bow 里」(见 withBowTerminalEnv 的注释与实测表)
        // BOW_* 三件套是对话桥的接头暗号:会话 id + 服务地址 + 本会话的控制令牌
        env: withBowTerminalEnv(cleanEnv(process.env), spec.file, {
          BOW_SESSION_ID: String(tabId),
          BOW_REMOTE_URL: `ws://127.0.0.1:${settings.remote.port}/ws`,
          BOW_CONTROL_TOKEN: controlToken
        })
      })
      const session: Session = {
        tabId,
        profileId,
        profileName,
        proc,
        replay: emptyReplay(),
        cols,
        rows,
        pending: [],
        flushTimer: null,
        parser: new OscSignalParser(),
        agentKey: null,
        sawBridge: false,
        cwd: spec.cwd,
        createdAt: Date.now(),
        lastOutputAt: null,
        agent: null,
        controlToken
      }
      sessions.set(tabId, session)
      runFailures.delete(tabId)
      // 包裹时命令要自己敲进交互 shell(tty 的行缓冲会先存着,和手敲一样)
      if (wrap) proc.write(wrap.type)
      notifySessions()
      proc.onData((data) => {
        // "活跃"看的是 pty 有没有产出 —— 带着 OSC 信号的 chunk 也算(代理在跑 = 肯定活跃)
        session.lastOutputAt = Date.now()
        notifySessions()
        // 剥掉代理写的控制序列:文本走原路(回放 + 合批下发),信号只用来算状态
        const parsed = session.parser.feed(data)
        // shell 报的目录(OSC 7 / 9;9):下一轮台账结算就会带上它(签名里已含 cwd)
        if (parsed.cwd) session.cwd = parsed.cwd
        if (parsed.text) {
          session.replay = pushReplay(session.replay, parsed.text)
          enqueue(session, parsed.text)
        }
        for (const signal of parsed.signals) {
          session.sawBridge = true
          reportAgent(session, signal)
        }
        // 降级路径(没装桥接扩展):pi 内建的 `9;4` 只区分「在跑 / 不在跑」,所以**不报 done**
        // (压缩结束也会发一次 clear,报 done 会变成假「已完成」通知)
        if (!session.sawBridge && parsed.progress) {
          reportAgent(session, { v: BOW_SIGNAL_VERSION, state: parsed.progress === 'active' ? 'working' : 'idle' })
        }
      })
      proc.onExit(({ exitCode }) => {
        flush(session)
        if (sessions.get(tabId) === session) sessions.delete(tabId)
        clearAgent(session)
        context?.ipc.emit(TERMINAL_EVENTS.exit, { tabId, code: exitCode })
        hub.publish({ t: 'exit', id: tabId, code: exitCode })
        context?.log('shell 退出', tabId, profileName, 'code=', exitCode)
        notifySessions()
      })
      context?.log('会话已创建', tabId, profileName, spec.file, spec.args.join(' '), 'cwd=', spec.cwd)
      // 命令已交出去:用掉即删(spawn 失败会走到下面的 catch,pending 留着等下一次 attach 重试)
      if (run) pendingRuns.delete(tabId)
      return describe(session)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      context?.logError('启动 shell 失败', profileName, spec.file, message)
      // 只对 `terminal:run` 记:调用方(编辑器 / terminal_run)可能正等着结论。
      // pendingRuns 仍然保留 —— 刷新一下页面就能重试。
      if (run) runFailures.set(tabId, message)
      return { ok: false, error: `启动 ${profileName} 失败:${message}` }
    }
  }

  function write(tabId: unknown, data: unknown): boolean {
    const session = sessions.get(Number(tabId))
    if (!session || typeof data !== 'string') return false
    try {
      session.proc.write(data)
      return true
    } catch (e) {
      context?.log('写入会话失败', tabId, String(e))
      return false
    }
  }

  function resize(tabId: unknown, cols: unknown, rows: unknown): boolean {
    const session = sessions.get(Number(tabId))
    if (!session) return false
    const nextCols = toPositiveInt(cols, session.cols, 2, 500)
    const nextRows = toPositiveInt(rows, session.rows, 2, 300)
    if (nextCols === session.cols && nextRows === session.rows) return true
    session.cols = nextCols
    session.rows = nextRows
    try {
      session.proc.resize(nextCols, nextRows)
      notifySessions()
      return true
    } catch (e) {
      context?.log('resize 失败', tabId, String(e))
      return false
    }
  }

  /** 设置页「添加配置」用的候选:平台预设 + PATH 命中情况 */
  function candidates(): TerminalCandidate[] {
    const pathValue = process.env.PATH ?? process.env.Path ?? ''
    return platformProfiles(process.platform, process.env.SHELL).map((profile) => {
      const resolved = findInPath(profile.shell, pathValue, {
        pathSeparator: delimiter,
        joinPath: (dir, name) => join(dir, name),
        exists: (candidate) => existsSync(candidate)
      })
      return { profile, available: resolved !== null, resolved }
    })
  }

  /** patch → 规范化设置:`undefined` 键不参与覆盖(否则会被 fallback 抢掉用户已存的值) */
  function applyPatch(patch: unknown): TerminalSettings {
    const current = store!.get()
    const clean: Record<string, unknown> = {}
    if (patch && typeof patch === 'object') {
      for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        if (value !== undefined) clean[key] = value
      }
    }
    return normalizeSettings({ ...current, ...clean }, defaults!)
  }

  return {
    manifest: {
      id: 'terminal',
      name: '终端',
      description: '在标签页里开一个连到本机 shell 的终端(xterm + node-pty);shell 与字体可在设置页配置',
      version: '1.0.0',
      core: true,
      alwaysOn: true
    },
    capabilities: ['ui', 'mcp'],

    activate(ctx: PluginContext): void {
      context = ctx
      defaults = defaultSettings(process.platform, process.env.SHELL)
      store = ctx.storage<TerminalSettings>({ file: 'terminal.json', defaults })
      // 磁盘上的旧文件/手改坏的文件都在这里一次性夹正;首次启动会顺带写入 version
      const normalized = normalizeSettings(store.get(), defaults)
      if (normalized.version !== store.get().version || JSON.stringify(normalized) !== JSON.stringify(store.get())) {
        store.setRaw(normalized)
      }

      // ---------- IPC 面(终端页与设置页都走 plugins.invoke) ----------
      ctx.ipc.handle('getSettings', () => store!.get())
      ctx.ipc.handle('setSettings', (patch: unknown) => {
        const next = applyPatch(patch)
        store!.setRaw(next)
        const render = renderSettingsOf(next)
        // 已开着的终端页据此即时改字体/字号/scrollback
        ctx.ipc.emit(TERMINAL_EVENTS.settingsChanged, render)
        // 远程服务的端口/绑定/开关可能变了:异步对齐(启动失败只落到 status.error,不影响设置保存)
        void applyRemote()
        return next
      })
      ctx.ipc.handle('listCandidates', () => candidates())
      // 远程登录 cookie 的签名密钥(首次生成)
      remoteKeyStore = ctx.storage<{ key: string }>({ file: 'terminal-remote.json', defaults: { key: '' } })

      // ---------- pi 状态桥的一键接入(设置页 → 终端)----------
      // 源取自应用根目录下的 `packages/pi-bow/extensions/bow-agent-state.ts`(必须进 build.files,
      // 否则打包版里 sourceAvailable 为 false —— 设置页会把这句话显示出来,不静默失败)。
      const bridgeIo = realPiBridgeIo()
      const bridgeEnv = (): PiBridgeEnv => ({
        home: homedir(),
        appPath: app.getAppPath(),
        env: process.env,
        // 只有 Windows 上才存在「bow 在 Windows、pi 在 WSL2」这种两个系统的情况(见 piBridge.wslHint)
        platform: process.platform
      })
      const asForce = (opts: unknown): boolean => !!(opts as { force?: boolean } | undefined)?.force
      ctx.ipc.handle('piBridgeStatus', () => piBridgeStatus(bridgeIo, bridgeEnv()))
      ctx.ipc.handle('piBridgeInstall', (opts: unknown) => installPiBridge(bridgeIo, bridgeEnv(), { force: asForce(opts) }))
      ctx.ipc.handle('piBridgeUninstall', (opts: unknown) =>
        uninstallPiBridge(bridgeIo, bridgeEnv(), { force: asForce(opts) })
      )
      ctx.ipc.handle('attach', (input: { tabId?: unknown; cols?: unknown; rows?: unknown }) => attach(input ?? {}))
      ctx.ipc.handle('write', (tabId: unknown, data: unknown) => write(tabId, data))
      ctx.ipc.handle('resize', (tabId: unknown, cols: unknown, rows: unknown) => resize(tabId, cols, rows))

      // ---------- 会话台账面(本地面板 / 远程页 / MCP 工具共用）----------
      ctx.ipc.handle('listSessions', () => listSessions())
      // 远程服务:端口/绑定/开关都存在设置里,启停决策也全在插件里
      ctx.ipc.handle('remoteStatus', () => remoteStatus())
      ctx.ipc.handle('applyRemote', () => applyRemote())
      // 「异地访问(Tailscale)」自检:只读 CLI,不碰系统状态;本地 IPC 专用(不进远程页)
      ctx.ipc.handle('tailscaleStatus', () =>
        probeTailscale(runTailscale, (store?.get().remote ?? defaultRemoteSettings()).port)
      )
      ctx.ipc.handle('readTail', (tabId: unknown, chars: unknown) => readTail(tabId, chars))
      ctx.ipc.handle('sendText', (tabId: unknown, data: unknown) => write(tabId, data))
      ctx.ipc.handle('createSession', (input: unknown) => createSession(input))
      // 「跳过去」用内核的 activate,而不是只为终端保留的 focus:后台标签 / 别的分屏窗格 /
      // 最小化的窗口都要一并处理。它与点系统通知是同一条实现(`main/agentActivate.ts`),
      // 所以行为一致 —— 再写一份焦点逻辑必然漂移。
      ctx.ipc.handle('focusSession', (tabId: unknown) => {
        const id = Number(tabId)
        if (!sessions.has(id)) return false
        return ctx.pages.activate(id)
      })
      ctx.ipc.handle('closeSession', (tabId: unknown) => {
        const id = Number(tabId)
        if (!sessions.has(id)) return false
        killSession(id, 'closed-by-request')
        return true
      })

      // ---------- MCP 工具(herdr 那种 automation 面:一个 pi 能管它的同类)----------
      //
      // 与上面的 IPC 面用的是**同一批函数**,所以面板 / 远程页 / AI 看到的是同一份台账 ——
      // 三个门脸一份事实,不存在「工具说有两个会话、面板说有三个」。
      //
      // ⚠️ `terminal_send` 是**无确认的键盘注入**:可以敲开任意会话(包括正在等用户确认的那个),
      // 所以描述里必须明说。`terminal_close` 在 Windows 上会连进程树一起收掉。
      //
      // 设置里的「向 AI 暴露终端工具」默认开;关掉后 5 个工具一律回错误(终端本身照用) ——
      // 这是插件变成 `alwaysOn`(不可停用)之后,收回 AI 控制权的唯一出口。
      const mcpAllowed = (): boolean => store!.get().mcpTools !== false
      const mcpBlocked = () => errorContent('终端 MCP 工具已关闭(设置页 → 终端 → 向 AI 暴露终端工具)')
      ctx.mcp.tool(
        'terminal_list_sessions',
        {
          description:
            '列出全部终端会话(标签页里的 shell)。给出 id、标题、工作目录、尺寸、最后活跃时间与代理状态(state: working 在跑 / blocked 在等用户 / idle 空闲 —— 终端里的 pi 会上报)。其它 terminal_* 工具都用 id 寻址',
          inputSchema: {}
        },
        () => (mcpAllowed() ? textContent({ ok: true, sessions: listSessions() }) : mcpBlocked())
      )
      ctx.mcp.tool(
        'terminal_read',
        {
          description:
            '读一个终端会话的尾部输出(纯文本,已剥掉 bow/pi 的私有控制序列)。是原始字节流的尾部而不是终端网格:最近的内容一定看得到,但滚不到很早的历史',
          inputSchema: {
            id: z.number().int().positive().describe('会话 id(见 terminal_list_sessions)'),
            chars: z.number().int().positive().optional().describe('最多返回多少字符(默认 4000,上限 200000)')
          }
        },
        (args) => {
          if (!mcpAllowed()) return mcpBlocked()
          const result = readTail(args.id, args.chars)
          return result.ok ? textContent(result) : errorContent(result.error ?? '读不到这个会话')
        }
      )
      ctx.mcp.tool(
        'terminal_send',
        {
          description:
            '往一个终端会话麦输入,等同人工敲键盘(**无确认,请先确认目标 id**)。文本原样送上去,不自动补回车 —— 要执行命令就自己带上 \\r',
          inputSchema: {
            id: z.number().int().positive().describe('会话 id'),
            text: z.string().describe('要送上去的字符(要回车就带上 \\r,如 "ls\\r")')
          }
        },
        (args) => {
          if (!mcpAllowed()) return mcpBlocked()
          return write(args.id, args.text) ? textContent({ ok: true }) : errorContent('这个会话不存在或已关闭')
        }
      )
      ctx.mcp.tool(
        'terminal_run',
        {
          description:
            '开一个新的终端会话并跑一条命令(如 pi / npm test)。会等一小会儿 pty 的启动结论:state=running 才是真的跑起来了,failed 会带原因(如命令不存在),starting 表示还没结论(再用 terminal_list_sessions 确认)。⚠️ Windows 上 .cmd/.bat shim 要自己包一层 cmd.exe /c',
          inputSchema: {
            command: z.string().describe('可执行文件,如 pi / npm / wsl.exe(Windows 裸名会自动补 .exe)'),
            args: z.array(z.string()).optional().describe('参数(逐项传递,不做 shell 拼接)'),
            cwd: z.string().optional().describe('工作目录;省略为用户主目录'),
            name: z.string().optional().describe('标签标题(如 "pi");省略则用命令名')
          }
        },
        async (args) => {
          if (!mcpAllowed()) return mcpBlocked()
          const created = createSession({ command: args.command, args: args.args, cwd: args.cwd, name: args.name })
          if (!created.ok || created.tabId == null) return errorContent(created.error ?? '开不了新会话')
          const settled = await waitForRun(created.tabId)
          if (settled.state === 'failed') {
            return errorContent(`命令没起来:${settled.error ?? '未知原因'}(标签 ${created.tabId} 还在,可以重试)`)
          }
          return textContent({
            ok: true,
            id: created.tabId,
            state: settled.state,
            ...(settled.state === 'starting' ? { note: 'pty 仍在启动,稍后用 terminal_list_sessions / terminal_read 确认' } : {})
          })
        }
      )
      ctx.mcp.tool(
        'terminal_close',
        {
          description: '结束一个终端会话(Windows 上连进程树一起收)。会真杀掉里面跑着的东西,不确定时先用 terminal_list_sessions 核对 id',
          inputSchema: { id: z.number().int().positive().describe('会话 id') }
        },
        (args) => {
          if (!mcpAllowed()) return mcpBlocked()
          const id = Number(args.id)
          if (!sessions.has(id)) return errorContent('这个会话不存在或已关闭')
          killSession(id, 'closed-by-request')
          return textContent({ ok: true, id })
        }
      )
      // detach 只表示「页面走了」:会话与回放缓冲都留着,刷新回来还能接上
      ctx.ipc.handle('detach', (tabId: unknown) => {
        const session = sessions.get(Number(tabId))
        if (session) flush(session)
        return true
      })

      // 标签关闭 → 回收该标签的 shell(按 id 匹配,和标签栏/分屏怎么动无关)
      ctx.events.on('tab:closed', (tab: { id?: unknown } | null | undefined) => {
        const id = Number(tab?.id)
        if (Number.isInteger(id)) killSession(id, 'tab-closed')
      })

      // 别的插件(目前是编辑器)要求「在这个标签里跑这条命令」——见 @shared/terminalRun。
      // 只存不跑:真正 spawn 要等终端页 attach(那时才知道尺寸),时序不变式在模块注释里。
      ctx.events.on(TERMINAL_RUN_EVENT, (payload: unknown) => {
        const request = parseTerminalRunRequest(payload)
        if (!request) {
          ctx.logError('terminal:run 负载不合法,已忽略', payload)
          return
        }
        if (sessions.has(request.tabId)) {
          // 那个标签已经跑着 shell 了:没法把一条命令塞进正在运行的会话,说清楚而不是默默丢掉
          ctx.logError('terminal:run 的目标标签已有会话,已忽略', request.tabId)
          return
        }
        pendingRuns.set(request.tabId, request)
        ctx.log('待办命令已登记', request.tabId, request.file, request.args.join(' '))
      })

      onBeforeQuit = (): void => {
        killAll('app-quit')
        // 退出前把监听关掉——不关的话下次启动可能撞上端口占用
        void stopRemote()
      }
      app.on('before-quit', onBeforeQuit)
      ctx.log('终端已就绪', `平台=${process.platform}`, `默认 shell=${defaultProfile(store.get()).shell}`)
      // 插件被启用 = 应当运行:按设置把远程服务对齐一次(默认关闭,所以这里通常什么也不做)
      void applyRemote()
    },

    async deactivate(): Promise<void> {
      pendingRuns.clear()
      // 合并定时器必须清:否则插件停用后它还会拿着已回收的 ctx 广播一次台账
      if (sessionsTimer) {
        clearTimeout(sessionsTimer)
        sessionsTimer = null
      }
      lastSessionsSignature = null
      if (onBeforeQuit) {
        app.removeListener('before-quit', onBeforeQuit)
        onBeforeQuit = null
      }
      // 插件被停用:所有会话都要收掉,已开着的终端页会收到 session-closed 并显示提示
      killAll('plugin-disabled')
      sessions.clear()
      // 监听必须真的关掉:否则插件重新启用时会 EADDRINUSE(报的是自己上次没关的端口)
      await stopRemote()
      hub.clear('插件已停用')
      remoteError = null
      remoteKeyStore = null
      store = null
      defaults = null
      context = null
      ptyError = null
      ptyModule = null
    }
  }
}

export { createTerminalPlugin }
export default createTerminalPlugin()
