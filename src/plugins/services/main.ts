/**
 * 自定义本地服务插件:每条服务 = 命令 + 图标 + 前端地址。工具栏点一下 —— 没起就起,起了就开标签。
 *
 * 三条从 `ok/main.ts` 搬来的硬经验(那边踩过,别改成别的写法):
 * 1. **走用户的登录 shell**(`-lic`):`bun` / `ok` 装在 `~/.bun/bin`,GUI 进程的 PATH 里没有。
 * 2. **Windows 上服务跑在 WSL 里**(`wsl.exe --cd ~ -e <shell> -lic <cmd>`):bun / pi 只在发行版里,
 *    而 `Workspace/*` 的项目目录也是 Linux 路径。
 * 3. **只停自己起的进程**:探活发现已经在跑(终端里手动起的)记成 running 且 owned=false,
 *    退出清理时不动它 —— 用户自己起的东西不该被插件杀掉。
 *
 * 与 ok 插件的差异只有一个:这里一个插件管 N 条服务,状态按 id 分开存;没有端口嗅探
 * (前端地址是用户填的,探活即判据)。
 */

import { app } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import {
  DEFAULT_SETTINGS,
  SERVICES_EVENT,
  checkMatches,
  commandChanged,
  normalizeSettings,
  type EnsureResult,
  type ServiceConfig,
  type ServicePhase,
  type ServicesSettings,
  type ServicesState,
  type ServiceStatus
} from './shared'

const PROBE_TIMEOUT_MS = 1_000
/** dev server 首启(vite 预构建依赖)比 ok 慢得多:冷启动实测能到十几秒 */
const STARTUP_TIMEOUT_MS = 60_000
/** SIGTERM 之后的宽限;dev server 没有需要刷盘的脏状态,短一点没关系 */
const SHUTDOWN_GRACE_MS = 3_000
const POLL_MS = 250
/** stdout/stderr 尾巴:设置页展开时看启动报错(端口占用之类) */
const LOG_LIMIT = 4_000

/** 只用到「能读输出、能 kill、能等退出」这点共性(wsl.exe 与本地 shell 都一样) */
interface ChildLike {
  readonly pid?: number
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  kill(): boolean
  once(event: 'exit', listener: (code: number | null) => void): unknown
  /** spawn 本身失败(找不到 wsl.exe / shell)走这条,不会触发 exit */
  once(event: 'error', listener: (error: Error) => void): unknown
}

/** Windows 上服务在 WSL 里(理由见文件头第 2 条) */
const VIA_WSL = process.platform === 'win32'

/**
 * WSL 里 bun / ok 的 PATH 只写在**交互式** rc(`~/.zshrc`)里:实测 `wsl.exe -e /bin/sh -lc`
 * 拿不到 `~/.bun/bin`,得用用户的登录 shell 加 `-lic`。探测一次就缓存(约 200ms)。
 */
let cachedWslShell: string | null = null
function wslShell(): string {
  if (cachedWslShell !== null) return cachedWslShell
  const probe = spawnSync('wsl.exe', ['-e', '/bin/sh', '-lc', 'printf %s "$SHELL"'], {
    encoding: 'utf8',
    timeout: 5_000
  })
  const shell = (probe.stdout ?? '').trim()
  cachedWslShell = /^\/[\w./-]+$/.test(shell) ? shell : '/bin/bash'
  return cachedWslShell
}

/** Linux/mac:GUI 进程的 `SHELL` 一般由 pam 设好;没有就按惯例回落到 bash */
function posixShell(): string {
  const shell = (process.env.SHELL ?? '').trim()
  return /^\/[\w./-]+$/.test(shell) ? shell : '/bin/bash'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 起一条服务命令。
 *
 * 命令作为**一个 argv 元素**交给 shell,所以 `cd X && bun dev` 里的 `&&` 只会被目标 shell
 * 解析一次,插件这边不需要任何引号转义。
 *
 * `--cd ~` 是必要的:不给的话 wsl.exe 会继承父进程的 Windows cwd,在发行版里可能是个
 * 让人意外的目录(`/mnt/c/...`);服务自己的 `cd` 则照常生效。
 */
function spawnService(config: ServiceConfig): ChildLike {
  return VIA_WSL
    ? spawn('wsl.exe', ['--cd', '~', '-e', wslShell(), '-lic', config.command], {
        stdio: 'pipe',
        windowsHide: true
      })
    : spawn(posixShell(), ['-lic', config.command], { stdio: 'pipe' })
}

/** stderr 尾巴:报错只给最后两行,免得把一个 vite 栈全灌进设置页 */
function lastLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' | ')
    .slice(0, 300)
}

const NO_COMMAND_RE = /command not found|not found:|不是内部或外部命令/

interface Runtime {
  child: ChildLike
  exited: Promise<void>
  /** spawn 本身的失败(不是进程跑完退出的那种),由 'error' 事件填 */
  spawnError: Error | null
}

interface Entry {
  phase: ServicePhase
  error: string | null
  /** 非 null = 这个进程是 bow 起的,能停 */
  runtime: Runtime | null
  starting: Promise<EnsureResult> | null
  stopRequested: boolean
  log: string
}

function createServicesPlugin(): PluginMain {
  let context: PluginContext | null = null
  let store: PluginStorage<{ settings: ServicesSettings }> | null = null
  let settings: ServicesSettings = { ...DEFAULT_SETTINGS }
  const entries = new Map<string, Entry>()
  let onBeforeQuit: ((event: Electron.Event) => void) | null = null

  function configOf(id: string): ServiceConfig | null {
    return settings.services.find((service) => service.id === id) ?? null
  }

  function entryOf(id: string): Entry {
    const existing = entries.get(id)
    if (existing) return existing
    const created: Entry = {
      phase: 'stopped',
      error: null,
      runtime: null,
      starting: null,
      stopRequested: false,
      log: ''
    }
    entries.set(id, created)
    return created
  }

  function statuses(): ServiceStatus[] {
    return settings.services.map((config) => {
      const entry = entryOf(config.id)
      return {
        id: config.id,
        phase: entry.phase,
        owned: entry.runtime !== null,
        error: entry.error
      }
    })
  }

  function state(): ServicesState {
    return { settings: { services: settings.services.map((s) => ({ ...s })) }, statuses: statuses() }
  }

  function announce(): ServicesState {
    const snapshot = state()
    context?.ipc.emit(SERVICES_EVENT.changed, snapshot)
    return snapshot
  }

  function persist(): void {
    store?.set({ settings: { services: settings.services.map((s) => ({ ...s })) } })
  }

  function appendLog(entry: Entry, chunk: Buffer | string): void {
    entry.log = (entry.log + String(chunk)).slice(-LOG_LIMIT)
  }

  function fail(id: string, message: string): EnsureResult {
    const entry = entryOf(id)
    entry.phase = 'error'
    entry.error = message
    entry.runtime = null
    context?.logError('本地服务', message)
    announce()
    return { phase: 'error', url: null, error: message }
  }

  /**
   * 探活:`ok` = 这条服务就绪,`mismatch` = 端口有人占但不像这条服务(过不了 check),`down` = 没人。
   *
   * 只为 check 读一小段响应体,别为了认一个标题把整个 main.js 拉进来。
   */
  async function probe(config: ServiceConfig): Promise<'ok' | 'mismatch' | 'down'> {
    try {
      const res = await fetch(config.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      if (!res.ok) return 'down'
      if (!config.check) return 'ok'
      return checkMatches((await res.text()).slice(0, 64_000), config.check) ? 'ok' : 'mismatch'
    } catch {
      return 'down'
    }
  }

  /** 服务已经在跑(可能不是 bow 起的):记下端口状态,`owner` 为 null 表示不接管进程 */
  function adopt(id: string, runtime: Runtime | null): EnsureResult {
    const config = configOf(id)
    const entry = entryOf(id)
    entry.phase = 'running'
    entry.error = null
    entry.runtime = runtime
    announce()
    return { phase: 'running', url: config?.url ?? null, error: null }
  }

  async function shutdown(entry: Entry): Promise<void> {
    const current = entry.runtime
    entry.runtime = null
    if (!current) return
    current.child.kill()
    await Promise.race([current.exited, delay(SHUTDOWN_GRACE_MS)])
    // 没退就再来一次;已经退了的进程上调用是空操作
    current.child.kill()
  }

  async function start(id: string): Promise<EnsureResult> {
    const config = configOf(id)
    if (!config) return { phase: 'error', url: null, error: '没有这条服务(设置里已被删除)' }

    if (!config.command) return fail(id, '还没填命令(设置页 → 本地服务)')
    if (!config.url) return fail(id, '还没填前端地址(设置页 → 本地服务)')

    const entry = entryOf(id)
    entry.error = null
    entry.stopRequested = false

    // 先探一次:终端里已经 `bun dev` 过了,就直接开标签,不要起第二个
    const first = await probe(config)
    if (first === 'ok') return adopt(id, null)

    entry.phase = 'starting'
    entry.log = ''
    announce()

    let child: ChildLike
    try {
      child = spawnService(config)
    } catch (e) {
      return fail(id, e instanceof Error ? e.message : String(e))
    }

    let markExited: () => void = () => {}
    let exitCode: number | null = null
    const exited = new Promise<void>((resolve) => {
      markExited = resolve
    })
    const runtime: Runtime = { child, exited, spawnError: null }
    entry.runtime = runtime

    // spawn 失败(ENOENT 之类)只发 'error' 不发 'exit':不接的话启动轮询会干等 60 秒,
    // 用户看到的就是「点了没反应、日志空白」。
    child.once('error', (error) => {
      runtime.spawnError = error
      appendLog(entry, `启动失败:${error.message}\n`)
      if (entry.runtime === runtime) entry.runtime = null
      markExited()
    })
    child.stdout?.on('data', (chunk: Buffer | string) => appendLog(entry, chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => appendLog(entry, chunk))
    child.once('exit', (code) => {
      exitCode = code
      markExited()
      if (entry.runtime !== runtime) return // 已经被 stop / 退出清理换掉了
      entry.runtime = null
      // 还没就绪就退了 = 交给下面的启动轮询收尾:可能只是「这个地址上已经有服务」
      if (entry.phase === 'starting') return
      entry.phase = code === 0 ? 'stopped' : 'error'
      entry.error = code === 0 ? null : `进程退出(exit ${code})`
      announce()
    })

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let mismatch = false
    let childGone = false
    while (Date.now() < deadline) {
      if (entry.stopRequested) return { phase: 'stopped', url: null, error: null }
      const seen = await probe(config)
      if (seen === 'ok') return adopt(id, runtime)
      if (seen === 'mismatch') mismatch = true
      if (entry.runtime !== runtime) {
        childGone = true
        break
      }
      if (seen === 'down') mismatch = false
      await delay(POLL_MS)
    }
    if (entry.stopRequested) return { phase: 'stopped', url: null, error: null }

    // 子进程刚退也可能是「地址上已经有服务」:它可能是守护式启动器(自己 fork 完就退了)
    if (childGone && (await probe(config)) === 'ok') return adopt(id, null)

    await shutdown(entry)
    if (runtime.spawnError !== null) {
      return fail(id, `命令起不来:${runtime.spawnError.message}(命令:${config.command})`)
    }
    if (mismatch) {
      return fail(
        id,
        `${config.url} 上有东西在跑,但过不了 check(${config.check})—— 可能是别的服务占着这个端口`
      )
    }
    if (!childGone) {
      const tail = lastLine(entry.log)
      return fail(
        id,
        `${STARTUP_TIMEOUT_MS / 1000} 秒内 ${config.url} 没起来${tail ? `:${tail}` : ';命令:' + config.command}`
      )
    }
    const tail = lastLine(entry.log) || '看设置页里的日志'
    const hint = NO_COMMAND_RE.test(entry.log)
      ? ' —— 命令不在 PATH 里:确认装的时候用的是同一个 shell(登录 shell)'
      : ''
    return fail(id, `服务没起来(exit ${exitCode}):${tail}${hint}`)
  }

  async function ensure(id: string): Promise<EnsureResult> {
    const config = configOf(id)
    if (!config) return { phase: 'error', url: null, error: '没有这条服务(设置里已被删除)' }
    const entry = entryOf(id)
    if (entry.starting) return entry.starting
    // 状态可能过期(用户在终端里停了):running 也再探一次,探不通就当没起
    if (entry.phase === 'running' && (await probe(config)) === 'ok') {
      return { phase: 'running', url: config.url, error: null }
    }
    const task = start(id).finally(() => {
      entry.starting = null
    })
    entry.starting = task
    return task
  }

  async function stop(id: string): Promise<ServicesState> {
    const entry = entryOf(id)
    // 先立旗:正在启动的轮询会在下一轮自己收手,不用等它跑满 60s
    entry.stopRequested = true
    if (entry.starting) await entry.starting.catch(() => undefined)
    if (!entry.runtime) {
      // 不是 bow 起的(比如终端里 `bun dev`):只把状态同步回来,绝不去动别人的进程
      const config = configOf(id)
      entry.phase = config && (await probe(config)) === 'ok' ? 'running' : 'stopped'
      entry.error = null
      entry.log = entry.phase === 'running' ? entry.log : ''
      return announce()
    }
    await shutdown(entry)
    entry.phase = 'stopped'
    entry.error = null
    entry.log = ''
    return announce()
  }

  async function stopAllOwned(): Promise<void> {
    const owned = [...entries.entries()].filter(([, entry]) => entry.runtime !== null)
    await Promise.all(owned.map(([id]) => stop(id)))
  }

  function hasOwned(): boolean {
    for (const entry of entries.values()) if (entry.runtime !== null) return true
    return false
  }

  async function addLog(id: string): Promise<string> {
    return entryOf(id).log
  }

  return {
    manifest: {
      id: 'services',
      name: '本地服务',
      description: '自定义的本地服务(dev server 等):工具栏一个图标,没起就起、起了就打开它的前端',
      version: '1.0.0'
    },
    capabilities: ['ui', 'service'],

    activate(ctx: PluginContext): void {
      context = ctx
      store = ctx.storage<{ settings: ServicesSettings }>({
        file: 'services.json',
        defaults: { settings: { ...DEFAULT_SETTINGS } }
      })
      settings = normalizeSettings(store.get().settings)
      persist()

      ctx.ipc.handle('getState', (): ServicesState => state())
      ctx.ipc.handle('ensure', (id: unknown): Promise<EnsureResult> => ensure(String(id)))
      ctx.ipc.handle('stop', (id: unknown): Promise<ServicesState> => stop(String(id)))
      ctx.ipc.handle('restart', async (id: unknown): Promise<EnsureResult> => {
        await stop(String(id))
        return ensure(String(id))
      })
      ctx.ipc.handle('logs', (id: unknown): Promise<string> => addLog(String(id)))
      ctx.ipc.handle('setSettings', (patch: unknown): ServicesState => {
        const before = settings
        settings = normalizeSettings(patch)
        persist()

        for (const [id, entry] of entries) {
          // 设置里删掉了这条:它自己起的进程不能留成孤儿
          if (!configOf(id) && entry.runtime) void stop(id)
        }
        for (const next of settings.services) {
          const prev = before.services.find((service) => service.id === next.id)
          // 命令或地址变了 = 现在进程跑的已经不是这条配置;停掉,下次点按钮按新配置起
          if (prev && commandChanged(prev, next) && entries.get(next.id)?.runtime) void stop(next.id)
        }
        return announce()
      })

      // 退出前把自己起的服务收掉;没有就立刻放行 —— ok 插件也挂了 before-quit,
      // 两边都必须「没事就 return」,否则两个 preventDefault 会互相把 quit 顶回来
      onBeforeQuit = (event) => {
        if (!hasOwned()) return
        event.preventDefault()
        void stopAllOwned().finally(() => {
          app.quit()
        })
      }
      app.on('before-quit', onBeforeQuit)

      for (const config of settings.services) if (config.autoStart) void ensure(config.id)
    },

    async deactivate(): Promise<void> {
      if (onBeforeQuit) {
        app.off('before-quit', onBeforeQuit)
        onBeforeQuit = null
      }
      await stopAllOwned()
      entries.clear()
      context = null
      store = null
    }
  }
}

/** 便于测试:每次调用得到一份独立实例(模块级单例的记忆由内核管理) */
export function createServicesPluginInstance(): PluginMain {
  return createServicesPlugin()
}

export default createServicesPlugin()
