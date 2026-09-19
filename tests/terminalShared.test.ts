/**
 * 终端插件纯逻辑单测(设置规范化 / 平台预设 / spawn 参数 / 环境 / 回放缓冲 / PATH 查找 / 参数文本)。
 * xterm 与 node-pty 都需要真实运行时,不在这里测 —— 它们由真机 CDP E2E 覆盖。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_SCROLLBACK,
  FONT_SIZE_RANGE,
  MAX_SESSIONS,
  SCROLLBACK_RANGE,
  buildSpawnSpec,
  cleanEnv,
  defaultSettings,
  emptyReplay,
  findInPath,
  formatArgsLine,
  newProfileId,
  normalizeSettings,
  parseArgsLine,
  platformProfiles,
  pushReplay,
  renderSettingsOf,
  replayText
} from '../src/plugins/terminal/shared'

const WIN = defaultSettings('win32', undefined)
const POSIX = defaultSettings('linux', '/bin/zsh')

describe('平台预设', () => {
  it('Windows 给 powershell / pwsh / cmd / wsl / git-bash', () => {
    expect(platformProfiles('win32').map((p) => p.shell)).toEqual([
      'powershell.exe',
      'pwsh.exe',
      'cmd.exe',
      'wsl.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe'
    ])
  })

  it('WSL 用 wsl.exe 的参数表达启动目录(不是 cwd)', () => {
    const wsl = platformProfiles('win32').find((p) => p.shell === 'wsl.exe')
    expect(wsl?.args).toEqual(['--cd', '~'])
    expect(wsl?.cwd).toBe('')
  })

  it('非 Windows 优先用登录 shell', () => {
    expect(platformProfiles('linux', '/usr/bin/fish')[0]).toMatchObject({ shell: '/usr/bin/fish', args: ['-l'] })
    expect(platformProfiles('linux')[0].shell).toBe('/bin/bash')
  })

  it('defaultSettings 的默认配置是候选里的第一条', () => {
    expect(WIN.defaultProfileId).toBe('powershell')
    expect(WIN.profiles[0].id).toBe(WIN.defaultProfileId)
    expect(POSIX.defaultProfileId).toBe('login-shell')
    expect(WIN.fontFamily).toBe(DEFAULT_FONT_FAMILY)
  })
})

describe('normalizeSettings', () => {
  it('空/垃圾输入回落到 fallback', () => {
    expect(normalizeSettings(null, WIN)).toEqual(WIN)
    expect(normalizeSettings('nope', WIN)).toEqual(WIN)
    expect(normalizeSettings({}, WIN)).toEqual(WIN)
  })

  it('字号与滚动缓冲被夹进范围内', () => {
    expect(normalizeSettings({ fontSize: 999 }, WIN).fontSize).toBe(FONT_SIZE_RANGE.max)
    expect(normalizeSettings({ fontSize: 1 }, WIN).fontSize).toBe(FONT_SIZE_RANGE.min)
    expect(normalizeSettings({ scrollback: 1 }, WIN).scrollback).toBe(SCROLLBACK_RANGE.min)
    expect(normalizeSettings({ scrollback: 9_999_999 }, WIN).scrollback).toBe(SCROLLBACK_RANGE.max)
    expect(normalizeSettings({ fontSize: 'abc' }, WIN).fontSize).toBe(WIN.fontSize)
  })

  it('非整数与 NaN 走 fallback', () => {
    expect(normalizeSettings({ fontSize: Number.NaN }, WIN).fontSize).toBe(DEFAULT_FONT_SIZE)
    expect(normalizeSettings({ scrollback: null }, WIN).scrollback).toBe(DEFAULT_SCROLLBACK)
  })

  it('profiles:丢弃没有 shell 的项、去重 id、补齐 name', () => {
    const next = normalizeSettings(
      {
        profiles: [
          { id: 'a', shell: '  cmd.exe  ', args: ['/k', 42] },
          { id: 'a', shell: 'dup.exe' },
          { id: '', shell: 'bash', name: '' },
          { shell: '   ' },
          'not-an-object'
        ]
      },
      WIN
    )
    expect(next.profiles.map((p) => p.id)).toEqual(['a', 'profile-2'])
    expect(next.profiles[0]).toMatchObject({ shell: 'cmd.exe', name: 'cmd.exe', args: ['/k'] })
    expect(next.profiles[1]).toMatchObject({ shell: 'bash', name: 'bash' })
  })

  it('profiles 全非法时回落到 fallback 的候选', () => {
    expect(normalizeSettings({ profiles: [] }, WIN).profiles).toHaveLength(WIN.profiles.length)
  })

  it('defaultProfileId 不存在时落到第一条', () => {
    const next = normalizeSettings({ defaultProfileId: 'ghost' }, WIN)
    expect(next.defaultProfileId).toBe(next.profiles[0].id)
  })

  it('version 恒为当前版本(便于以后迁移)', () => {
    expect(normalizeSettings({ profiles: undefined }, WIN).version).toBe(WIN.version)
  })
})

describe('buildSpawnSpec', () => {
  it('空 cwd 落到主目录,args 是拷贝', () => {
    const profile = WIN.profiles[0]
    const spec = buildSpawnSpec(profile, { homedir: 'C:\\Users\\x' })
    expect(spec.cwd).toBe('C:\\Users\\x')
    expect(spec.args).not.toBe(profile.args)
  })

  it('显式 cwd 优先,shell 两端空白被去掉', () => {
    const spec = buildSpawnSpec(
      { id: 'x', name: 'x', shell: '  /bin/bash ', args: ['-l'], cwd: ' /home/me ' },
      { homedir: '/root' }
    )
    expect(spec).toEqual({ file: '/bin/bash', args: ['-l'], cwd: '/home/me' })
  })
})

describe('cleanEnv', () => {
  it('剔除 Electron 注入的变量,补 TERM / COLORTERM', () => {
    const env = cleanEnv({
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      NODE_OPTIONS: '--max-old-space-size=4096',
      TERM: 'dumb',
      EMPTY: undefined
    })
    expect(env).toEqual({ PATH: '/usr/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
  })
})

describe('回放缓冲', () => {
  it('空缓冲拼接为空串', () => {
    expect(replayText(emptyReplay())).toBe('')
  })

  it('空 chunk 不改变缓冲(保持引用)', () => {
    const buf = emptyReplay()
    expect(pushReplay(buf, '')).toBe(buf)
  })

  it('超过上限时从头裁剪,保留最近的输出', () => {
    let buf = emptyReplay()
    for (const chunk of ['aaaa', 'bbbb', 'cccc']) buf = pushReplay(buf, chunk, 8)
    expect(replayText(buf)).toBe('bbbbcccc')
    expect(buf.chars).toBe(8)
  })

  it('单个超长 chunk 不被裁掉(否则屏幕会全空)', () => {
    const buf = pushReplay(emptyReplay(), 'x'.repeat(100), 10)
    expect(replayText(buf)).toBe('x'.repeat(100))
  })
})

describe('newProfileId', () => {
  it('跳过已占用的 id', () => {
    expect(newProfileId([])).toBe('p1')
    expect(newProfileId(['p1', 'p3'])).toBe('p2')
  })
})

describe('findInPath', () => {
  const opts = (existing: string[]) => ({
    pathSeparator: ':',
    joinPath: (dir: string, name: string) => `${dir}/${name}`,
    exists: (candidate: string) => existing.includes(candidate)
  })

  it('PATH 命中返回拼接后的路径', () => {
    expect(findInPath('bash', '/bin:/usr/bin', opts(['/usr/bin/bash']))).toBe('/usr/bin/bash')
  })

  it('未命中返回 null', () => {
    expect(findInPath('zsh', '/bin', opts(['/usr/bin/bash']))).toBe(null)
  })

  it('带分隔符的名字按路径判断,不走 PATH', () => {
    const target = 'C:\\Program Files\\Git\\bin\\bash.exe'
    expect(findInPath(target, 'D:\\nowhere', opts([target]))).toBe(target)
    expect(findInPath(target, 'D:\\nowhere', opts([]))).toBe(null)
  })

  it('空名字与空 PATH 项被跳过', () => {
    expect(findInPath('   ', '/bin', opts(['/bin/x']))).toBe(null)
    expect(findInPath('x', ':/bin:', opts(['/bin/x']))).toBe('/bin/x')
  })
})

describe('参数文本', () => {
  it('按空白切分,支持引号包裹', () => {
    expect(parseArgsLine('-NoLogo')).toEqual(['-NoLogo'])
    expect(parseArgsLine('--cd "~/my dir" -x')).toEqual(['--cd', '~/my dir', '-x'])
    expect(parseArgsLine("  -a  'b c'  ")).toEqual(['-a', 'b c'])
  })

  it('空行的结果是空数组', () => {
    expect(parseArgsLine('   ')).toEqual([])
    expect(parseArgsLine('')).toEqual([])
  })

  it('formatArgsLine 给带空格的项加引号,并能被 parse 回去', () => {
    expect(formatArgsLine(['--cd', '~/my dir'])).toBe('--cd "~/my dir"')
    expect(parseArgsLine(formatArgsLine(['a b', 'c']))).toEqual(['a b', 'c'])
  })
})

describe('renderSettingsOf', () => {
  it('只取渲染需要的三项', () => {
    expect(renderSettingsOf(WIN)).toEqual({
      fontFamily: WIN.fontFamily,
      fontSize: WIN.fontSize,
      scrollback: WIN.scrollback
    })
  })
})

describe('常量', () => {
  it('会话上限是正整数', () => {
    expect(Number.isInteger(MAX_SESSIONS)).toBe(true)
    expect(MAX_SESSIONS).toBeGreaterThan(0)
  })
})
