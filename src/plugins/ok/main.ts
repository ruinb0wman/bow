/**
 * 内置 OpenKnowledge(OK)插件:bow 只是**启动器** —— 服务用机器上装的 `ok` 起,不往应用里打一份。
 *
 * 改代码前先看这四条:
 * 1. **不 import / 不 bundle OK**:命令行自己叫 `ok`,交给你装(npm / bun 全局都行);升级 OK 与
 *    升级 bow 完全无关。
 * 2. **必须走用户的登录 shell(`-lic`)+ `exec`**:`ok` 常装在 `~/.local/bin` / `~/.bun/bin`,
 *    GUI 起来的环境 PATH 里没有;`exec` 让 shell 自己被替换掉,杀子进程时服务跟着退。
 * 3. **端口现抓**:OK 每次随机分配,横幅里的 `http://127.0.0.1:<port>` 是唯一来源;原生模式
 *    再读 `.ok/local/server.lock` 交叉校验,避免抓到上一条(重启前的)横幅。
 * 4. **进程归 bow**:退出前先让它优雅停机(它会 flush 待写文档),超时才强杀。
 *    `--idle-shutdown` 保留它自己的默认 30 分钟兜底 —— 标签关了、bow 崩了,服务会自己退。
 * 5. **Windows 上起的是 WSL 里的 `ok`**(见 `VIA_WSL` 与 `spawnOk` 的注释):pi 只装在发行版
 *    里,OK 要驱动它就只能自己也待在那一侧。所以 Windows 上的项目目录是 **Linux 路径**。
 */

import { app, BrowserWindow, dialog } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import {
  DEFAULT_SETTINGS,
  OK_EVENT,
  normalizeSettings,
  okRuntime,
  parseLock,
  parsePortFromStdout,
  parseRuntimeVersion,
  toWslPath,
  type OkLock,
  type OkPhase,
  type OkSettings,
  type OkState
} from './shared'

/** 冷启动实测 ~1.1s;给 20s 是为了慢盘 / 首次建索引 */
const STARTUP_TIMEOUT_MS = 20_000
/** 停机宽限:实测 flush 待写文档 ~0.9s,给到 5s */
const SHUTDOWN_GRACE_MS = 5_000
const POLL_MS = 120

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 这里只用到「能读输出、能 kill、能等退出」这点共性:原生是 utilityProcess,Windows 是 wsl.exe 子进程 */
interface ChildLike {
  readonly pid?: number
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  kill(): boolean
  once(event: 'exit', listener: (code: number | null) => void): unknown
}

/** Windows 上 OK 服务跑在 WSL 里(理由见 `okRuntime` 的注释) */
const VIA_WSL = okRuntime(process.platform) === 'wsl'

/**
 * WSL 里 `ok` / `pi` 的 PATH 只写在**交互式** rc(`~/.zshrc`)里:实测 `wsl.exe -e /bin/sh -lc`
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

/** `ok` 不在 PATH 时的典型输出(各 shell 一句话都不一样,只用来附一句安装提示) */
const NO_OK_RE = /command not found|not found: ok|exec: ok: not found|不是内部或外部命令/

/**
 * 起一条 OK 子命令。
 *
 * 两边都经用户登录 shell —— `ok` 装在 `~/.local/bin` / `~/.bun/bin` 这种只在交互式 rc 里加进
 * PATH 的位置;`exec` 让 shell 自己被替换掉,杀掉子进程时服务跟着退(实测:杀 wsl.exe 客户端,
 * 发行版里的 node 一起消失)。
 *
 * Windows 还必须 `--cd` 给项目目录:OK 拿 cwd 当项目根,而 wsl.exe 默认落在 Windows 的路径上。
 */
function spawnOk(args: string[], cwd: string): ChildLike {
  // shortcut: args 全是固定字面量(start --no-open-browser / init),不做引号转义
  const line = `exec ok ${args.join(' ')}`
  return VIA_WSL
    ? spawn('wsl.exe', ['--cd', cwd, '-e', wslShell(), '-lic', line], { stdio: 'pipe', windowsHide: true })
    : spawn(posixShell(), ['-lic', line], { cwd, stdio: 'pipe' })
}

/** stderr 尾巴:报错只给最后两行,免得把一个 Node 栈全灌进设置页 */
function lastLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' | ')
    .slice(0, 300)
}

interface OkRuntime {
  child: ChildLike
  exited: Promise<void>
}

function createOkPlugin(): PluginMain {
  let context: PluginContext | null = null
  let store: PluginStorage<{ settings: OkSettings }> | null = null
  let settings: OkSettings = { ...DEFAULT_SETTINGS }
  let phase: OkPhase = 'stopped'
  let port: number | null = null
  let runtimeVersion: string | null = null
  let error: string | null = null
  /** 非 null = 这个服务是 bow 起的,能停 */
  let runtime: OkRuntime | null = null
  let starting: Promise<OkState> | null = null
  /** start() 的轮询靠它区分「用户要停」与「子进程自己退了」—— 后者可能只是已有服务 */
  let stopRequested = false
  let stdout = ''
  let stderr = ''
  let onBeforeQuit: ((event: Electron.Event) => void) | null = null

  function state(): OkState {
    return {
      settings: { ...settings },
      phase,
      port,
      url: port === null ? null : `http://127.0.0.1:${port}`,
      // WSL 模式下能拿到的是 wsl.exe 客户端的 Windows pid —— 它不在发行版的进程表里,
      // 拿去 `ps` 只会让人怀疑服务没跑。真要 pid:`ss -ltnp | grep <port>`（WSL 里）
      pid: VIA_WSL ? null : (runtime?.child.pid ?? null),
      runtimeVersion,
      error
    }
  }

  function announce(): OkState {
    const snapshot = state()
    context?.ipc.emit(OK_EVENT.changed, snapshot)
    return snapshot
  }

  function fail(message: string): OkState {
    phase = 'error'
    error = message
    port = null
    context?.logError('OpenKnowledge', message)
    return announce()
  }

  function persist(): void {
    store?.set({ settings: { ...settings } })
  }

  function readLock(): OkLock | null {
    // WSL 模式:项目目录是 Linux 路径,Windows 侧的 fs 摸不到(要经 \\wsl.localhost UNC);
    // lock 只用来交叉校验端口与版本,这两样都能从横幅里拿到,不值得为此再添一条访问路径
    if (VIA_WSL || !settings.projectPath) return null
    try {
      return parseLock(readFileSync(join(settings.projectPath, '.ok/local/server.lock'), 'utf8'))
    } catch {
      return null // 还没写出来(或正被写)
    }
  }

  async function probe(target: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${target}/`, { signal: AbortSignal.timeout(1000) })
      return res.ok
    } catch {
      return false
    }
  }

  /** 丢掉对当前进程的所有权,并等它真的退出(优雅停机);超时才强杀 */
  async function shutdown(): Promise<void> {
    stopRequested = true
    const current = runtime
    runtime = null
    port = null
    runtimeVersion = null
    if (!current) return
    current.child.kill()
    await Promise.race([current.exited, delay(SHUTDOWN_GRACE_MS)])
    current.child.kill() // 没退就再来一次;已经退了的进程上调用是空操作
  }

  async function start(): Promise<OkState> {
    error = null
    if (!settings.projectPath) return fail('还没设置 OpenKnowledge 项目目录(设置页 → OpenKnowledge)')

    phase = 'starting'
    stopRequested = false
    stdout = ''
    stderr = ''
    announce()

    let child: ChildLike
    try {
      child = spawnOk(['start', '--no-open-browser'], settings.projectPath)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }

    let markExited: () => void = () => {}
    let exitCode: number | null = null
    const exited = new Promise<void>((resolve) => {
      markExited = resolve
    })
    const current: OkRuntime = { child, exited }
    runtime = current

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = (stdout + String(chunk)).slice(-8000)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-4000)
    })
    child.once('exit', (code) => {
      exitCode = code
      markExited()
      if (runtime !== current) return // 已经被 stop / 退出清理换掉了
      runtime = null
      port = null
      runtimeVersion = null
      // 还没就绪就退了 = 交给下面的启动轮询收尾:很可能只是「这个项目里已有服务」
      if (phase === 'starting') return
      phase = code === 0 ? 'stopped' : 'error'
      error = code === 0 ? null : `OpenKnowledge 退出(exit ${code})`
      announce()
    })

    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let childGone = false
    while (Date.now() < deadline) {
      if (stopRequested) return state() // 被 stop 打断
      const found = parsePortFromStdout(stdout)
      if (found !== null && (await probe(found))) return adopt(found, child)
      if (runtime !== current) {
        childGone = true
        break
      }
      await delay(POLL_MS)
    }

    // 子进程刚退也有可能是「项目里已经有服务」(它打印 already running 后立刻 exit 0):
    // 再从它的输出里找一次端口,活着就接管状态(不接管进程)
    if (childGone) {
      const found = parsePortFromStdout(stdout)
      if (found !== null && (await probe(found))) return adopt(found, null)
    }
    if (stopRequested) return state()

    await shutdown()
    if (!childGone) return fail(`OpenKnowledge ${STARTUP_TIMEOUT_MS / 1000} 秒内没起来${stderr ? `:${lastLine(stderr)}` : ''}`)
    const detail = lastLine(stderr) || lastLine(stdout) || '看服务日志'
    // 最常见的失败就是没装 ok:它只是一条 “command not found”,用户不会到那里找包名
    const hint = NO_OK_RE.test(stderr + stdout)
      ? ' —— 先装 ok(npm i -g @inkeep/open-knowledge;Windows 上装在 WSL 里)'
      : ''
    return fail(`OpenKnowledge 没起来(exit ${exitCode}):${detail}${hint}`)
  }

  /**
   * 服务在跑:记下端口与版本。
   *
   * `owner` 传 null 或「lock 里的 pid 与我们 fork 的不一致」时**不接管进程** ——
   * 那是别人(终端里 `ok start`)起的服务,我们不该去停它。
   */
  function adopt(found: number, owner: ChildLike | null): OkState {
    const lock = readLock()
    port = found
    runtimeVersion = lock?.runtimeVersion ?? parseRuntimeVersion(stdout)
    if (owner === null || (lock !== null && lock.pid !== owner.pid)) runtime = null
    phase = 'running'
    error = null
    context?.log('OpenKnowledge 已就绪', `http://127.0.0.1:${found}`)
    return announce()
  }

  async function ensure(): Promise<OkState> {
    if (runtime && phase === 'running' && port !== null) return state()
    if (starting) return starting
    starting = start().finally(() => {
      starting = null
    })
    return starting
  }

  async function stop(): Promise<OkState> {
    // 先立旗:正在启动的轮询会在下一个 POLL_MS 内自己收手,不用等它跑完 20s
    stopRequested = true
    if (starting) await starting.catch(() => undefined)
    if (!runtime) {
      // 服务不是 bow 起的(比如终端里 `ok start`):只把状态同步回来,绝不去动别人的进程
      if (port !== null && (await probe(port))) return announce()
      phase = 'stopped'
      port = null
      runtimeVersion = null
      error = null
      return announce()
    }
    await shutdown()
    phase = 'stopped'
    error = null
    return announce()
  }

  /**
   * 一次性跑一条 OK 子命令(`ok init`)。
   *
   * shortcut: OK 的 init 在部分情况下会问交互式问题,这里没有 stdin —— 用 30s 超时兜住,
   * 真卡住就当失败报给设置页,要精细控制就改成给 stdin 喂应答。
   */
  async function runOnce(args: string[], cwd: string): Promise<{ code: number; output: string }> {
    let child: ChildLike
    try {
      child = spawnOk(args, cwd)
    } catch (e) {
      return { code: -1, output: e instanceof Error ? e.message : String(e) }
    }
    let output = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output = (output + String(chunk)).slice(-4000)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      output = (output + String(chunk)).slice(-4000)
    })
    const code = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve(-1)
      }, 30_000)
      child.once('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode ?? -1)
      })
    })
    return { code, output }
  }

  async function initProject(): Promise<{ ok: boolean; error?: string }> {
    if (!settings.projectPath) return { ok: false, error: '先选一个目录' }
    const res = await runOnce(['init'], settings.projectPath)
    if (res.code !== 0) {
      const detail = lastLine(res.output) || `ok init 失败(exit ${res.code})`
      return { ok: false, error: NO_OK_RE.test(res.output) ? `${detail} —— 先装 ok` : detail }
    }
    return { ok: true }
  }

  return {
    manifest: {
      id: 'ok',
      name: 'OpenKnowledge',
      description: 'OpenKnowledge 知识库(用你自己装的 ok):随 bow 启动服务,工具栏一键打开它的 web 前端',
      version: '1.0.0'
    },
    capabilities: ['ui', 'service'],

    activate(ctx: PluginContext): void {
      context = ctx
      store = ctx.storage<{ settings: OkSettings }>({
        file: 'ok.json',
        defaults: { settings: { ...DEFAULT_SETTINGS } }
      })
      settings = normalizeSettings(store.get().settings)
      // 老设置里存的是 Windows 路径(那时服务跑在 bow 里):换成同一批文件的 Linux 路径,
      // 否则升级后目录变成「不是 OK 项目」
      if (VIA_WSL) {
        const migrated = toWslPath(settings.projectPath)
        if (migrated !== null) settings = { ...settings, projectPath: migrated }
      }
      persist()

      ctx.ipc.handle('getState', (): OkState => state())
      ctx.ipc.handle('ensure', (): Promise<OkState> => ensure())
      ctx.ipc.handle('stop', (): Promise<OkState> => stop())
      ctx.ipc.handle('pickProject', async (): Promise<OkState> => {
        const options: Electron.OpenDialogOptions = {
          title: '选择 OpenKnowledge 项目目录',
          properties: ['openDirectory', 'createDirectory']
        }
        const parent = BrowserWindow.getFocusedWindow()
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) return state()
        // 服务在 WSL 里,`cwd` 只能是 Linux 路径
        const projectPath = VIA_WSL ? toWslPath(result.filePaths[0]) : result.filePaths[0]
        if (projectPath === null) {
          error = `这个目录换算不到 WSL 里的路径:${result.filePaths[0]}(只认盘符路径 C:\\… 或 Linux 路径 /home/…)`
          return announce()
        }
        settings = { ...settings, projectPath }
        error = null
        persist()
        await stop()
        if (settings.autoStart) void ensure()
        return announce()
      })
      ctx.ipc.handle('initProject', (): Promise<{ ok: boolean; error?: string }> => initProject())
      ctx.ipc.handle('setSettings', async (patch: unknown): Promise<OkState> => {
        const before = settings.projectPath
        const obj = patch && typeof patch === 'object' ? patch : {}
        settings = normalizeSettings({ ...settings, ...obj })
        persist()
        if (settings.projectPath !== before) {
          await stop()
          if (settings.autoStart && settings.projectPath) void ensure()
        }
        return announce()
      })

      // 退出前让它优雅停机:OK 会把待写文档刷盘(~1s),直接杀会丢最后几笔编辑
      onBeforeQuit = (event) => {
        if (!runtime) return
        event.preventDefault()
        void shutdown().finally(() => {
          app.quit()
        })
      }
      app.on('before-quit', onBeforeQuit)

      if (settings.autoStart && settings.projectPath) void ensure()
    },

    async deactivate(): Promise<void> {
      if (onBeforeQuit) {
        app.off('before-quit', onBeforeQuit)
        onBeforeQuit = null
      }
      await shutdown()
      phase = 'stopped'
      context = null
      store = null
    }
  }
}

/** 便于测试:每次调用得到一份独立实例(模块级单例的记忆由内核管理) */
export function createOkPluginInstance(): PluginMain {
  return createOkPlugin()
}

export default createOkPlugin()
