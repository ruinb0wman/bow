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
 */

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import { BOW_SIGNAL_VERSION, OscSignalParser } from '@shared/agentState'
import type { AgentSignal } from '@shared/agentState'
import { installPiBridge, piBridgeStatus, uninstallPiBridge } from './piBridge'
import type { PiBridgeEnv, PiBridgeIo } from './piBridge'
import {
  MAX_SESSIONS,
  TERMINAL_EVENTS,
  buildSpawnSpec,
  cleanEnv,
  defaultSettings,
  emptyReplay,
  findInPath,
  normalizeSettings,
  platformProfiles,
  pushReplay,
  renderSettingsOf,
  replayText,
  withBowTerminalEnv
} from './shared'
import type {
  ReplayBuffer,
  TerminalAttachResult,
  TerminalCandidate,
  TerminalProfile,
  TerminalSettings
} from './shared'

/** 输出合批窗口(ms):太小无意义,太大会让交互式程序显钝 */
const FLUSH_MS = 8

type PtyModule = typeof import('node-pty')

/** 插件依赖注入缝(只有单测用):替换 node-pty 的加载,好让用例能喂假 pty 输出 */
export interface TerminalPluginDeps {
  loadPty?: () => Promise<PtyModule>
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
  }

  function enqueue(session: Session, chunk: string): void {
    session.pending.push(chunk)
    if (session.flushTimer) return
    session.flushTimer = setTimeout(() => flush(session), FLUSH_MS)
  }

  // ---------- 编码代理状态(终端里的 pi 等,见 @shared/agentState)----------

  /**
   * 把一个状态报给主进程(`service.agent`,由 `main/agentNotify.ts` 落地成角标 + 底部居中通知)。
   * 去重按「完整状态键」:同一状态重复喊(心跳 / 重复输出)不该惊动标签栏与通知栈。
   */
  function reportAgent(session: Session, signal: AgentSignal): void {
    const key = [signal.state, signal.done ? 1 : 0, signal.agent ?? '', signal.title ?? '', signal.text ?? ''].join('|')
    if (key === session.agentKey) return
    session.agentKey = key
    context?.service.agent.report({ ...signal, tabId: session.tabId })
  }

  /** 会话结束 / 标签关闭:清掉角标(`idle` 不带 `done` → 不弹「已完成」通知) */
  function clearAgent(session: Session): void {
    if (session.agentKey === null) return
    session.agentKey = null
    context?.service.agent.report({ v: BOW_SIGNAL_VERSION, state: 'idle', tabId: session.tabId })
  }

  function killSession(tabId: number, reason: string): void {
    const session = sessions.get(tabId)
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
    context?.log('会话已结束', tabId, reason, session.profileName)
  }

  function killAll(reason: string): void {
    for (const tabId of [...sessions.keys()]) killSession(tabId, reason)
  }

  /** 当前默认配置(找不到就退到第一条 —— 设置文件被手改坏也不会崩) */
  function defaultProfile(settings: TerminalSettings): TerminalProfile {
    return settings.profiles.find((p) => p.id === settings.defaultProfileId) ?? settings.profiles[0]
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
      existing.cols = cols
      existing.rows = rows
      try {
        existing.proc.resize(cols, rows)
      } catch (e) {
        context?.log('复用会话时 resize 失败', tabId, String(e))
      }
      return { ...describe(existing), reused: true }
    }

    if (sessions.size >= MAX_SESSIONS) {
      return { ok: false, error: `最多同时开 ${MAX_SESSIONS} 个终端,先关掉一个再开` }
    }

    const settings = store!.get()
    const profile = defaultProfile(settings)
    const spec = buildSpawnSpec(profile, { homedir: homedir() })

    let mod: PtyModule
    try {
      mod = await loadPty()
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }

    try {
      const proc = mod.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: spec.cwd,
        // wsl.exe 的 profile 还要把 BOW_TERMINAL 列进 WSLENV —— 否则 Windows 侧的变量进不了发行版,
        // 终端里的 pi 扩展会认不出「自己在 bow 里」(见 withBowTerminalEnv 的注释与实测表)
        env: withBowTerminalEnv(cleanEnv(process.env), spec.file)
      })
      const session: Session = {
        tabId,
        profileId: profile.id,
        profileName: profile.name,
        proc,
        replay: emptyReplay(),
        cols,
        rows,
        pending: [],
        flushTimer: null,
        parser: new OscSignalParser(),
        agentKey: null,
        sawBridge: false
      }
      sessions.set(tabId, session)
      proc.onData((data) => {
        // 剥掉代理写的控制序列:文本走原路(回放 + 合批下发),信号只用来算状态
        const parsed = session.parser.feed(data)
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
        context?.log('shell 退出', tabId, profile.name, 'code=', exitCode)
      })
      context?.log('会话已创建', tabId, profile.name, spec.file, spec.args.join(' '), 'cwd=', spec.cwd)
      return describe(session)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      context?.logError('启动 shell 失败', profile.name, spec.file, message)
      return { ok: false, error: `启动 ${profile.name} 失败:${message}` }
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
      version: '1.0.0'
    },
    capabilities: ['ui'],

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
        return next
      })
      ctx.ipc.handle('listCandidates', () => candidates())

      // ---------- pi 状态桥的一键接入(设置页 → 终端)----------
      // 源取自应用根目录下的 `integrations/pi/bow-agent-state.ts`(必须进 build.files,
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

      onBeforeQuit = (): void => killAll('app-quit')
      app.on('before-quit', onBeforeQuit)
      ctx.log('终端已就绪', `平台=${process.platform}`, `默认 shell=${defaultProfile(store.get()).shell}`)
    },

    deactivate(): void {
      if (onBeforeQuit) {
        app.removeListener('before-quit', onBeforeQuit)
        onBeforeQuit = null
      }
      // 插件被停用:所有会话都要收掉,已开着的终端页会收到 session-closed 并显示提示
      killAll('plugin-disabled')
      sessions.clear()
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
