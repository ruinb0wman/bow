/**
 * 终端插件:内核事件 `terminal:run`(让别的插件请求「在这个标签里跑这条命令」)。
 *
 * 这里用**假 pty** 走真代码路径(`createTerminalPlugin({ loadPty })`),看住五件事:
 * ① 有 pending 时用命令 spec spawn,且 `profileName` 变成命令名(标签标题靠它);
 * ② 没有 pending 时仍是默认 shell profile(回归);
 * ③ 命令用掉即删:第二次 attach 复用会话,不重复 spawn;
 * ④ 非法负载被忽略且不抛;目标标签已有会话时也忽略(不许把命令塞进运行中的 shell);
 * ⑤ spawn 失败时 pending 保留 —— 刷新一下能重试。
 */

import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => ({
  app: { on: () => {}, removeListener: () => {}, getPath: () => '/tmp', getVersion: () => '0.0.0' }
}))

const { createTerminalPlugin } = await import('../src/plugins/terminal/main')
const { defaultSettings } = await import('../src/plugins/terminal/shared')
const { TERMINAL_RUN_EVENT } = await import('../src/shared/terminalRun')
type PluginContext = import('../src/main/plugins/types').PluginContext

interface SpawnCall {
  file: string
  args: string[]
  cwd: string
}

class FakePty {
  written: string[] = []
  onData(): void {}
  onExit(): void {}
  write(data: string): void {
    this.written.push(data)
  }
  resize(): void {}
  kill(): void {}
}

interface Harness {
  spawns: SpawnCall[]
  /** 第 0 个假 pty(spawn 之后可以看写进去了什么) */
  pty: FakePty
  /** 让第 n 次 spawn 抛错(从 1 开始) */
  failNextSpawn: () => void
  run: (payload: unknown) => void
  attach: (tabId: number) => Promise<{ ok: boolean; error?: string; profileName?: string; reused?: boolean }>
  errors: string[]
}

async function harness(platform = 'win32'): Promise<Harness> {
  const spawns: SpawnCall[] = []
  const ptys: FakePty[] = []
  const errors: string[] = []
  let failOnce = false
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const runHandlers: Array<(payload: unknown) => void> = []
  const settings = defaultSettings(platform, '/bin/bash')

  const ctx = {
    id: 'terminal',
    log: () => {},
    logError: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
    storage: () => ({ get: () => settings, set: () => settings, setRaw: () => settings }),
    ipc: { handle: (m: string, fn: (...a: never[]) => unknown) => handlers.set(m, fn), emit: () => {} },
    events: {
      on: (name: string, cb: (payload: unknown) => void) => {
        if (name === TERMINAL_RUN_EVENT) runHandlers.push(cb)
      },
      emit: () => {}
    },
    service: { agent: { report: () => {} } },
    // 插件现在也贡献 MCP 工具(S4);这个 harness 只看 terminal:run,给个同位空实现即可
    mcp: { tool: () => {} }
  } as unknown as PluginContext

  const plugin = createTerminalPlugin({
    platform: platform as NodeJS.Platform,
    loadPty: async () =>
      ({
        spawn: (file: string, args: string[], opts: { cwd: string }) => {
          if (failOnce) {
            failOnce = false
            throw new Error('spawn 失败(测试)')
          }
          spawns.push({ file, args, cwd: opts.cwd })
          const pty = new FakePty()
          ptys.push(pty)
          return pty
        }
      }) as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof createTerminalPlugin>[0]>['loadPty']>>
  })
  await plugin.activate(ctx)

  return {
    spawns,
    get pty() {
      return ptys[0]!
    },
    failNextSpawn: () => {
      failOnce = true
    },
    run: (payload) => {
      for (const cb of runHandlers) cb(payload)
    },
    attach: (tabId) =>
      (handlers.get('attach') as (i: unknown) => Promise<{ ok: boolean; error?: string; profileName?: string; reused?: boolean }>)({
        tabId,
        cols: 80,
        rows: 24
      }),
    errors
  }
}

describe('终端插件:terminal:run', () => {
  it('有 pending 时用命令 spec spawn,标签名取 name', async () => {
    const h = await harness()
    h.run({
      tabId: 7,
      file: 'wsl.exe',
      args: ['-e', 'nvim', '/mnt/c/tmp/a.txt'],
      cwd: 'C:\\tmp',
      name: 'nvim(a.txt)'
    })
    const result = await h.attach(7)
    expect(result.ok).toBe(true)
    expect(result.profileName).toBe('nvim(a.txt)')
    expect(h.spawns).toEqual([{ file: 'wsl.exe', args: ['-e', 'nvim', '/mnt/c/tmp/a.txt'], cwd: 'C:\\tmp' }])
  })

  it('没有 pending 时仍是默认 shell profile(回归)', async () => {
    const h = await harness()
    const result = await h.attach(7)
    expect(result.ok).toBe(true)
    expect(result.profileName).toBe('Windows PowerShell')
    expect(h.spawns[0]?.file).toBe('powershell.exe')
  })

  it('cwd 省略时落到用户主目录', async () => {
    const h = await harness()
    h.run({ tabId: 7, file: 'wsl.exe', args: ['-e', 'nvim'] })
    await h.attach(7)
    expect(h.spawns[0]?.cwd).toBe(homedir())
  })

  it('Windows + WSL 路径:spawn wsl.exe --cd,命令打进它的交互 shell', async () => {
    // 为什么要打进 shell 而不是 `wsl.exe -e pi`:pi 的 PATH 只配在 ~/.zshrc 里,
    // 非交互 shell 读不到 → `wsl.exe -- pi` 是 command not found(实测)
    const h = await harness('win32')
    h.run({ tabId: 7, file: 'pi', args: [], cwd: '/home/u/proj' })
    expect((await h.attach(7)).profileName).toBe('pi')
    expect(h.spawns).toEqual([{ file: 'wsl.exe', args: ['--cd', '/home/u/proj'], cwd: homedir() }])
    expect(h.pty.written).toEqual(['pi\r'])
  })

  it('非 Windows 平台照旧直接 spawn(不包 wsl.exe)', async () => {
    const h = await harness('linux')
    h.run({ tabId: 7, file: 'pi', args: [], cwd: '/home/u/proj' })
    await h.attach(7)
    expect(h.spawns).toEqual([{ file: 'pi', args: [], cwd: '/home/u/proj' }])
    expect(h.pty.written).toEqual([])
  })

  it('命令用掉即删:第二次 attach 复用会话,不重复 spawn', async () => {
    const h = await harness()
    h.run({ tabId: 7, file: 'wsl.exe', args: ['-e', 'nvim', 'a.txt'] })
    await h.attach(7)
    const second = await h.attach(7)
    expect(second.reused).toBe(true)
    expect(h.spawns).toHaveLength(1)
  })

  it('非法负载被忽略且不抛', async () => {
    const h = await harness()
    for (const bad of [null, {}, { tabId: -1, file: 'x', args: [] }, { tabId: 1, file: '', args: [] }, { tabId: 1, file: 'x' }, { tabId: 1, file: 'x', args: [1] }]) {
      expect(() => h.run(bad)).not.toThrow()
    }
    const result = await h.attach(1)
    expect(result.profileName).toBe('Windows PowerShell') // 没被任何 pending 影响
    expect(h.errors.some((e) => e.includes('负载不合法'))).toBe(true)
  })

  it('目标标签已有会话时忽略(不许把命令塞进运行中的 shell)', async () => {
    const h = await harness()
    await h.attach(7)
    h.run({ tabId: 7, file: 'wsl.exe', args: ['-e', 'nvim', 'a.txt'] })
    expect(h.errors.some((e) => e.includes('已有会话'))).toBe(true)
    expect(h.spawns).toHaveLength(1)
    expect(h.spawns[0]?.file).toBe('powershell.exe')
  })

  it('spawn 失败时 pending 保留,下一次 attach 能重试', async () => {
    const h = await harness()
    h.run({ tabId: 7, file: 'wsl.exe', args: ['-e', 'nvim', 'a.txt'], name: 'nvim(a.txt)' })
    h.failNextSpawn()
    const failed = await h.attach(7)
    expect(failed.ok).toBe(false)
    const retried = await h.attach(7)
    expect(retried.ok).toBe(true)
    expect(h.spawns).toEqual([{ file: 'wsl.exe', args: ['-e', 'nvim', 'a.txt'], cwd: homedir() }])
  })
})
