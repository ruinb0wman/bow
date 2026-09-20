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
  isGenuineCtrlAltChord,
  newProfileId,
  normalizeSettings,
  parseArgsLine,
  platformProfiles,
  pushReplay,
  renderSettingsOf,
  replayText,
  matchClipboardKey
} from '../src/plugins/terminal/shared'
import { installWindowsCtrlAltChordRepair } from '../src/plugins/terminal/ui/xtermCtrlAltChord'

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

/** 构造按键事件:默认 keydown + 无修饰,按需覆盖 */
function key(patch: Partial<Parameters<typeof matchClipboardKey>[0]>): Parameters<typeof matchClipboardKey>[0] {
  return { type: 'keydown', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...patch }
}

describe('matchClipboardKey(终端里的复制/粘贴)', () => {
  describe('Windows / Linux(Ctrl)', () => {
    it('Ctrl+C = 有选区才复制,没选区放行给 shell 发中断', () => {
      expect(matchClipboardKey(key({ code: 'KeyC', key: 'c', ctrlKey: true }), false)).toBe('copy-if-selection')
    })

    it('Ctrl+V / Ctrl+Shift+V 都是粘贴', () => {
      expect(matchClipboardKey(key({ code: 'KeyV', key: 'v', ctrlKey: true }), false)).toBe('paste')
      expect(matchClipboardKey(key({ code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true }), false)).toBe('paste')
    })

    it('Ctrl+Shift+C 是强制复制(没选区也不会误发中断)', () => {
      expect(matchClipboardKey(key({ code: 'KeyC', key: 'C', ctrlKey: true, shiftKey: true }), false)).toBe('copy')
    })

    it('不带 Ctrl 的 C / Shift+C / Ctrl+其它键 都不接管', () => {
      expect(matchClipboardKey(key({ code: 'KeyC', key: 'c' }), false)).toBeNull()
      expect(matchClipboardKey(key({ code: 'KeyC', key: 'C', shiftKey: true }), false)).toBeNull()
      expect(matchClipboardKey(key({ code: 'KeyZ', key: 'z', ctrlKey: true }), false)).toBeNull()
    })
  })

  describe('macOS(⌘)', () => {
    it('⌘C / ⌘V 接管', () => {
      expect(matchClipboardKey(key({ code: 'KeyC', key: 'c', metaKey: true }), true)).toBe('copy-if-selection')
      expect(matchClipboardKey(key({ code: 'KeyV', key: 'v', metaKey: true }), true)).toBe('paste')
    })

    it('Ctrl+C 在 mac 上仍然归 shell(中断信号不能被抢)', () => {
      expect(matchClipboardKey(key({ code: 'KeyC', key: 'c', ctrlKey: true }), true)).toBeNull()
    })

    it('⌃⇧C / ⌃⇧V(带 Shift)也认,兼容老习惯', () => {
      expect(matchClipboardKey(key({ code: 'KeyC', key: 'C', ctrlKey: true, shiftKey: true }), true)).toBe('copy')
      expect(matchClipboardKey(key({ code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true }), true)).toBe('paste')
    })
  })

  it('带 Alt 一律不接管:AltGr 在部分键盘布局上就是 Ctrl+Alt', () => {
    expect(matchClipboardKey(key({ code: 'KeyC', key: 'c', ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(matchClipboardKey(key({ code: 'KeyV', key: 'v', ctrlKey: true, altKey: true }), false)).toBeNull()
    expect(matchClipboardKey(key({ code: 'KeyV', key: 'v', metaKey: true, altKey: true }), true)).toBeNull()
  })

  it('只认 keydown(keyup / keypress 都不接管)', () => {
    expect(matchClipboardKey(key({ code: 'KeyC', key: 'c', ctrlKey: true, type: 'keyup' }), false)).toBeNull()
    expect(matchClipboardKey(key({ code: 'KeyV', key: 'v', ctrlKey: true, type: 'keypress' }), false)).toBeNull()
  })

  it('code 缺失时用 key 兜底(合成事件/异常输入法)', () => {
    expect(matchClipboardKey(key({ key: 'c', ctrlKey: true }), false)).toBe('copy-if-selection')
    expect(matchClipboardKey(key({ key: 'V', ctrlKey: true }), false)).toBe('paste')
    expect(matchClipboardKey(key({ key: '', code: '', ctrlKey: true }), false)).toBeNull()
  })

  it('大写 key 与 code 一致处理(Shift 场景)', () => {
    expect(matchClipboardKey(key({ key: 'C', code: 'KeyC', ctrlKey: true }), false)).toBe('copy-if-selection')
  })
})

/** 判据的输入形状与 DOM `KeyboardEvent` 结构化兼容,单测里造一个最小对象即可 */
function chord(patch: Partial<Parameters<typeof isGenuineCtrlAltChord>[0]>): Parameters<typeof isGenuineCtrlAltChord>[0] {
  return { type: 'keydown', ctrlKey: false, altKey: false, metaKey: false, altGraph: false, ...patch }
}

describe('isGenuineCtrlAltChord(Windows 上分得开真 Ctrl+Alt 组合与 AltGr)', () => {
  it('Ctrl+Alt 且 AltGraph 未激活 = 真组合(Ctrl+Alt+P 这类键必须送进 pty)', () => {
    expect(isGenuineCtrlAltChord(chord({ ctrlKey: true, altKey: true }))).toBe(true)
  })

  it('AltGraph 激活 = AltGr 在打字符,不算(继续交给 xterm 的第三级 shift 判定)', () => {
    expect(isGenuineCtrlAltChord(chord({ ctrlKey: true, altKey: true, altGraph: true }))).toBe(false)
  })

  it('带 Meta(⌘/Win)/ 只有 Ctrl / 只有 Alt / 都没有 → 不算', () => {
    expect(isGenuineCtrlAltChord(chord({ ctrlKey: true, altKey: true, metaKey: true }))).toBe(false)
    expect(isGenuineCtrlAltChord(chord({ ctrlKey: true }))).toBe(false)
    expect(isGenuineCtrlAltChord(chord({ altKey: true }))).toBe(false)
    expect(isGenuineCtrlAltChord(chord({}))).toBe(false)
  })

  it('只认 keydown,输入法组合中不算', () => {
    expect(isGenuineCtrlAltChord(chord({ ctrlKey: true, altKey: true, type: 'keyup' }))).toBe(false)
    expect(isGenuineCtrlAltChord(chord({ ctrlKey: true, altKey: true, type: 'keypress' }))).toBe(false)
    expect(isGenuineCtrlAltChord(chord({ ctrlKey: true, altKey: true, isComposing: true }))).toBe(false)
  })
})

describe('installWindowsCtrlAltChordRepair(包住 xterm 的 AltGr 误判判据)', () => {
  /** 假的 xterm core:只带我们要包的那一个私有方法 */
  function fakeTerm(browser?: { isWindows?: boolean }) {
    const calls: Array<unknown> = []
    const term = {
      _core: {
        browser,
        _isThirdLevelShift(this: unknown, b: unknown, ev: unknown): boolean {
          calls.push(ev)
          return true // 真实 xterm 在 Windows 上对 Ctrl+Alt+可打印键就是这个结果
        }
      }
    }
    return { term, calls }
  }

  const ev = (patch: Partial<Record<'type' | 'ctrlKey' | 'altKey' | 'metaKey', unknown>> & { altGraph?: boolean }) =>
    ({
      type: 'keydown',
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      getModifierState: (name: string) => (name === 'AltGraph' ? !!patch.altGraph : false),
      ...patch
    }) as unknown as KeyboardEvent

  it('装上了:真组合返回 false(不再吞键),且没有走原判据', () => {
    const { term, calls } = fakeTerm({ isWindows: true })
    expect(installWindowsCtrlAltChordRepair(term as never)).toBe(true)
    expect(term._core._isThirdLevelShift({ isWindows: true }, ev({ ctrlKey: true, altKey: true, altGraph: false }))).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('AltGr 打字(AltGraph 激活)仍走原判据,返回值原样透传', () => {
    const { term, calls } = fakeTerm({ isWindows: true })
    installWindowsCtrlAltChordRepair(term as never)
    expect(term._core._isThirdLevelShift({ isWindows: true }, ev({ ctrlKey: true, altKey: true, altGraph: true }))).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('非 Windows 平台原样透传(不削弱 mac / Linux 的判定)', () => {
    const { term, calls } = fakeTerm({ isWindows: false })
    installWindowsCtrlAltChordRepair(term as never)
    expect(term._core._isThirdLevelShift({ isWindows: false }, ev({ ctrlKey: true, altKey: true }))).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('拿不到内部判据 → 返回 false 且不抛(行为退化成现状,不会发错字节)', () => {
    expect(installWindowsCtrlAltChordRepair({} as never)).toBe(false)
    expect(installWindowsCtrlAltChordRepair({ _core: {} } as never)).toBe(false)
    expect(installWindowsCtrlAltChordRepair({ _core: { _isThirdLevelShift: 42 } } as never)).toBe(false)
  })
})
