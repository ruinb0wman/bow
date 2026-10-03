/**
 * pi 状态桥的安装逻辑(设置页「一键接入」):归属标记、幂等、拒写别人的文件、卸载。
 *
 * 用**真 fs + 临时目录**跑(不用假 fs):这段逻辑本身就是 fs 语义(存在性、编码、目录创建),
 * 假 fs 只能测出我自己写的那套假设。`package.json` 的 `build.files` 是否真的把源打进产物,
 * 由 `npm run dist` 后的人工/脚本核对负责(见计划 §10 与 README)。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PI_BRIDGE_MARKER, bridgePaths, installPiBridge, piBridgeStatus, uninstallPiBridge, windowsPathToWsl, wslHint } from '../src/plugins/terminal/piBridge'

/** 真 fs 的 I/O 适配(与 terminal/main.ts 里的 realPiBridgeIo 同一形态) */
const io = {
  exists: (path: string) => existsSync(path),
  readFile: (path: string) => {
    try {
      return readFileSync(path, 'utf-8')
    } catch {
      return null
    }
  },
  writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
  mkdirp: (path: string) => void mkdirSync(path, { recursive: true }),
  remove: (path: string) => rmSync(path)
}

const SOURCE = `/** ${PI_BRIDGE_MARKER}; reinstall overwrites this file */\nexport default function () {}\n`

let root = ''
let appPath = ''
let home = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bow-pi-bridge-'))
  appPath = join(root, 'app')
  home = join(root, 'home')
  mkdirSync(join(appPath, 'integrations', 'pi'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(appPath, 'integrations', 'pi', 'bow-agent-state.ts'), SOURCE, 'utf-8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const env = () => ({ home, appPath })

describe('bridgePaths', () => {
  it('默认落 ~/.pi/agent/extensions;PI_CODING_AGENT_DIR 优先', () => {
    const a = bridgePaths(env())
    expect(a.target).toBe(join(home, '.pi', 'agent', 'extensions', 'bow-agent-state.ts'))
    expect(a.source).toBe(join(appPath, 'integrations', 'pi', 'bow-agent-state.ts'))
    const b = bridgePaths({ ...env(), env: { PI_CODING_AGENT_DIR: join(root, 'custom') } })
    expect(b.target).toBe(join(root, 'custom', 'extensions', 'bow-agent-state.ts'))
  })
})

describe('piBridgeStatus', () => {
  it('未安装:installed=false、agentDirExists=false、源可读', () => {
    const s = piBridgeStatus(io, env())
    expect(s.installed).toBe(false)
    expect(s.upToDate).toBe(false)
    expect(s.foreign).toBe(false)
    expect(s.agentDirExists).toBe(false)
    expect(s.sourceAvailable).toBe(true)
    expect(s.error).toBeUndefined()
  })

  it('打包漏配 build.files 时 sourceAvailable=false 且给出原因(不静默)', () => {
    rmSync(join(appPath, 'integrations'), { recursive: true, force: true })
    const s = piBridgeStatus(io, env())
    expect(s.sourceAvailable).toBe(false)
    expect(s.error).toContain('读不到 bow 自带的扩展源码')
  })

  it('目标存在但不是 bow 装的 → foreign + 说明', () => {
    mkdirSync(join(home, '.pi', 'agent', 'extensions'), { recursive: true })
    writeFileSync(join(home, '.pi', 'agent', 'extensions', 'bow-agent-state.ts'), '// 别人写的\n', 'utf-8')
    const s = piBridgeStatus(io, env())
    expect(s.installed).toBe(true)
    expect(s.foreign).toBe(true)
    expect(s.error).toContain('不是 bow 装的')
  })
})

describe('installPiBridge', () => {
  it('首次安装:建目录 + 落文件,action=installed,再装一次是 unchanged', () => {
    const first = installPiBridge(io, env())
    expect(first.ok).toBe(true)
    expect(first.action).toBe('installed')
    expect(readFileSync(join(home, '.pi', 'agent', 'extensions', 'bow-agent-state.ts'), 'utf-8')).toBe(SOURCE)

    const second = installPiBridge(io, env())
    expect(second.action).toBe('unchanged')
    expect(second.status.upToDate).toBe(true)
  })

  it('源变了 → action=updated(内容被覆盖)', () => {
    installPiBridge(io, env())
    const next = `${SOURCE}// v2\n`
    writeFileSync(join(appPath, 'integrations', 'pi', 'bow-agent-state.ts'), next, 'utf-8')
    const again = installPiBridge(io, env())
    expect(again.action).toBe('updated')
    expect(readFileSync(join(home, '.pi', 'agent', 'extensions', 'bow-agent-state.ts'), 'utf-8')).toBe(next)
  })

  it('读了同类项目里的同名文件:拒写,除非 force', () => {
    const target = join(home, '.pi', 'agent', 'extensions', 'bow-agent-state.ts')
    mkdirSync(join(home, '.pi', 'agent', 'extensions'), { recursive: true })
    writeFileSync(target, '// 别人的扩展\n', 'utf-8')

    const refused = installPiBridge(io, env())
    expect(refused.ok).toBe(false)
    expect(refused.action).toBe('refused')
    expect(readFileSync(target, 'utf-8')).toBe('// 别人的扩展\n')

    const forced = installPiBridge(io, env(), { force: true })
    expect(forced.ok).toBe(true)
    expect(forced.action).toBe('updated')
    expect(readFileSync(target, 'utf-8')).toBe(SOURCE)
  })

  it('读不到源时失败且不建任何目录', () => {
    rmSync(join(appPath, 'integrations'), { recursive: true, force: true })
    const res = installPiBridge(io, env())
    expect(res.ok).toBe(false)
    expect(res.action).toBe('failed')
    expect(existsSync(join(home, '.pi'))).toBe(false)
  })
})

describe('windowsPathToWsl / wslHint:给「bow 在 Windows、pi 在 WSL2」用户的提醒', () => {
  it('盘符路径换算成 /mnt/<小写盘符>(兼容 / 与 \\、大小写盘符)', () => {
    expect(windowsPathToWsl('C:\\Users\\me\\.pi\\x.ts')).toBe('/mnt/c/Users/me/.pi/x.ts')
    expect(windowsPathToWsl('d:\\pi-agent\\x.ts')).toBe('/mnt/d/pi-agent/x.ts')
    expect(windowsPathToWsl('C:/Users/me/x.ts')).toBe('/mnt/c/Users/me/x.ts')
  })

  it('不是盘符路径就给不出命令(UNC 的 \\\\wsl$\\…、POSIX 路径、光秃秃的 C:)', () => {
    expect(windowsPathToWsl('\\\\wsl$\\archlinux\\home\\x\\.pi')).toBeNull()
    expect(windowsPathToWsl('/home/me/.pi/agent')).toBeNull()
    expect(windowsPathToWsl('C:')).toBeNull()
    expect(windowsPathToWsl('')).toBeNull()
  })

  it('Windows 上给出一条从 bow 那边拷进 WSL2 家目录的命令', () => {
    const hint = wslHint({ home: 'C:\\Users\\ruinb', appPath: 'C:\\apps\\bow', platform: 'win32' })
    expect(hint?.command).toBe(
      'mkdir -p ~/.pi/agent/extensions && cp "/mnt/c/Users/ruinb/.pi/agent/extensions/bow-agent-state.ts" ~/.pi/agent/extensions/'
    )
  })

  it('PI_CODING_AGENT_DIR 为盘符路径时跟着换算(比如指到 D 盘)', () => {
    const hint = wslHint({
      home: 'C:\\Users\\ruinb',
      appPath: 'C:\\apps\\bow',
      platform: 'win32',
      env: { PI_CODING_AGENT_DIR: 'D:\\pi-agent' }
    })
    expect(hint?.from).toBe('/mnt/d/pi-agent/extensions/bow-agent-state.ts')
  })

  it('不适用的时候一个字也不说:非 Windows、或路径是 UNC', () => {
    expect(wslHint({ home, appPath, platform: 'linux' })).toBeUndefined()
    expect(wslHint({ home, appPath, platform: 'darwin' })).toBeUndefined()
    // 平台没注入时按 process.platform 判(vitest 跑在 linux 上)
    expect(wslHint({ home, appPath })).toBeUndefined()
    expect(
      wslHint({
        home: 'C:\\Users\\ruinb',
        appPath: 'C:\\apps\\bow',
        platform: 'win32',
        env: { PI_CODING_AGENT_DIR: '\\\\wsl$\\archlinux\\home\\ruinb\\.pi\\agent' }
      })
    ).toBeUndefined()
  })

  it('状态里带上/不带这个字段(设置页据此决定显不显示那段说明)', () => {
    const onWindows = piBridgeStatus(io, { home: 'C:\\Users\\ruinb', appPath, platform: 'win32' })
    expect(onWindows.wsl?.to).toBe('~/.pi/agent/extensions')
    const onLinux = piBridgeStatus(io, env())
    expect(onLinux.wsl).toBeUndefined()
    expect(Object.hasOwn(onLinux, 'wsl')).toBe(false)
  })
})

describe('uninstallPiBridge', () => {
  it('删掉 bow 装的那个文件;没装时是 no-op', () => {
    expect(uninstallPiBridge(io, env()).action).toBe('absent')
    installPiBridge(io, env())
    const removed = uninstallPiBridge(io, env())
    expect(removed.action).toBe('removed')
    expect(removed.status.installed).toBe(false)
  })

  it('不动不是 bow 装的同名文件', () => {
    const target = join(home, '.pi', 'agent', 'extensions', 'bow-agent-state.ts')
    mkdirSync(join(home, '.pi', 'agent', 'extensions'), { recursive: true })
    writeFileSync(target, '// 别人的扩展\n', 'utf-8')
    const res = uninstallPiBridge(io, env())
    expect(res.ok).toBe(false)
    expect(res.action).toBe('refused')
    expect(existsSync(target)).toBe(true)
  })
})
