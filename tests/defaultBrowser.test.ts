/**
 * 默认浏览器插件:注册计划、mimeapps 合并、状态判定与注册/撤销编排。
 *
 * 关键点是**在 Linux 上也能测 Windows 分支** —— `registration.ts` 的 I/O 全部可注入
 * (fs / reg.exe 执行器),所以这里用内存 fs 与假注册表跑完整流程。
 */

import { describe, expect, it } from 'vitest'
import * as win from '../src/plugins/default-browser/windowsRegistry'
import * as linux from '../src/plugins/default-browser/linuxDesktop'
import {
  desktopStatus,
  openPlatformSettings,
  registerDesktop,
  unregisterDesktop,
  type FsLike,
  type RegResult,
  type RegistrationDeps
} from '../src/plugins/default-browser/registration'
import { statusBadge } from '../src/plugins/default-browser/shared'

const EXE = 'C:\\Program Files\\bow\\bow.exe'
const plan = win.buildWindowsRegistration({ exe: EXE })
const findOp = (predicate: (op: win.RegOp) => boolean) => plan.adds.find(predicate)

// ---------------------------------------------------------------- Windows 注册计划

describe('windowsRegistry:注册内容', () => {
  it('命令行指向 bow.exe,且用 %1 收文件 / URL', () => {
    expect(plan.openCommand).toBe(`"${EXE}" "%1"`)
    expect(findOp((o) => o.key.endsWith('bowHTML\\shell\\open\\command'))?.data).toBe(`"${EXE}" "%1"`)
    expect(findOp((o) => o.key.endsWith('bowURL\\shell\\open\\command'))?.data).toBe(`"${EXE}" "%1"`)
  })

  it('URL 协议 ProgID 带空的 `URL Protocol` 值(否则系统不当协议处理程序)', () => {
    const op = findOp((o) => o.key === 'HKCU\\Software\\Classes\\bowURL' && o.name === 'URL Protocol')
    expect(op).toEqual({ key: 'HKCU\\Software\\Classes\\bowURL', name: 'URL Protocol', type: 'REG_SZ', data: '' })
  })

  it('每个扩展名都登记 OpenWithProgids(右键「打开方式」)', () => {
    for (const ext of win.DEFAULT_FILE_TYPES) {
      expect(findOp((o) => o.key === `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids` && o.name === 'bowHTML')).toBeTruthy()
    }
  })

  it('Applications 条目带 FriendlyAppName / SupportedTypes', () => {
    const app = 'HKCU\\Software\\Classes\\Applications\\bow.exe'
    expect(findOp((o) => o.key === app && o.name === 'FriendlyAppName')?.data).toBe('bow')
    expect(findOp((o) => o.key === `${app}\\SupportedTypes` && o.name === '.html')).toBeTruthy()
  })

  it('Capabilities 把 http/https 映射到协议 ProgID、扩展名映射到 html ProgID', () => {
    const caps = 'HKCU\\Software\\Clients\\StartMenuInternet\\bow\\Capabilities'
    expect(findOp((o) => o.key === `${caps}\\URLAssociations` && o.name === 'http')?.data).toBe('bowURL')
    expect(findOp((o) => o.key === `${caps}\\URLAssociations` && o.name === 'https')?.data).toBe('bowURL')
    expect(findOp((o) => o.key === `${caps}\\FileAssociations` && o.name === '.html')?.data).toBe('bowHTML')
    expect(findOp((o) => o.key === caps && o.name === 'ApplicationName')?.data).toBe('bow')
  })

  it('RegisteredApplications 指向 Capabilities(这一步才让 bow 出现在「默认应用」)', () => {
    const op = findOp((o) => o.key === 'HKCU\\Software\\RegisteredApplications' && o.name === 'bow')
    expect(op?.data).toBe('Software\\Clients\\StartMenuInternet\\bow\\Capabilities')
  })

  it('可执行文件名从路径里取(Win 路径在 Linux 上跑测试也要正确)', () => {
    expect(plan.exeName).toBe('bow.exe')
    expect(win.buildWindowsRegistration({ exe: 'D:\\bow\\bow.exe' }).applicationKey).toBe(
      'HKCU\\Software\\Classes\\Applications\\bow.exe'
    )
  })

  it('全是 HKCU(不需要管理员),没有 HKLM', () => {
    for (const op of plan.adds) expect(op.key.startsWith('HKCU\\')).toBe(true)
    expect(JSON.stringify(plan)).not.toContain('HKLM')
  })

  it('缺少 exe 直接报错(而不是写出一个空命令)', () => {
    expect(() => win.buildWindowsRegistration({ exe: '' })).toThrow()
  })
})

describe('windowsRegistry:回滚清单', () => {
  it('删掉候选登记值与自己的键', () => {
    expect(plan.deletes.values).toContainEqual({ key: 'HKCU\\Software\\Classes\\.html\\OpenWithProgids', name: 'bowHTML' })
    expect(plan.deletes.values).toContainEqual({ key: 'HKCU\\Software\\RegisteredApplications', name: 'bow' })
    expect(plan.deletes.keys).toEqual([
      'HKCU\\Software\\Classes\\bowHTML',
      'HKCU\\Software\\Classes\\bowURL',
      'HKCU\\Software\\Classes\\Applications\\bow.exe',
      'HKCU\\Software\\Clients\\StartMenuInternet\\bow'
    ])
  })

  it('回滚不会碰别的程序的键', () => {
    for (const key of plan.deletes.keys) expect(key).not.toContain('firefox')
    for (const { key } of plan.deletes.values) expect(key).not.toMatch(/\\shell\\open\\command$/)
  })
})

describe('windowsRegistry:UserChoice(判断「是不是默认」的唯一依据)', () => {
  it('五类目标各查各自的 UserChoice,期望值是我们的 ProgID', () => {
    const targets = win.userChoiceTargets()
    expect(targets.map((t) => t.id)).toEqual(['http', 'https', '.html', '.htm', '.xhtml'])
    expect(targets.find((t) => t.id === 'http')?.expect).toBe('bowURL')
    expect(targets.find((t) => t.id === '.html')?.expect).toBe('bowHTML')
    expect(win.userChoiceQueryArgs(targets[0])).toEqual(['QUERY', targets[0].key, '/v', 'ProgId'])
  })

  it('（回归）协议与文件类型的 UserChoice 在两处,不能写混', () => {
    const targets = win.userChoiceTargets()
    const http = targets.find((t) => t.id === 'http')!
    const https = targets.find((t) => t.id === 'https')!
    const html = targets.find((t) => t.id === '.html')!
    // 协议在 Shell\Associations 下 —— 曾经错写成 CurrentVersion\Explorer 导致 http/https 永远「未设置」
    expect(http.key).toBe('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice')
    expect(https.key).toBe('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice')
    expect(http.key).not.toContain('CurrentVersion\\Explorer\\UrlAssociations')
    expect(http.alternateKeys).toEqual([
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UrlAssociations\\http\\UserChoice'
    ])
    // 文件类型在 CurrentVersion\Explorer\FileExts 下,并带 HKCR 合并顺序的回落键
    expect(html.key).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.html\\UserChoice')
    expect(html.legacyKeys).toEqual(['HKCU\\Software\\Classes\\.html', 'HKLM\\Software\\Classes\\.html'])
    expect(html.kind).toBe('file')
    expect(http.kind).toBe('protocol')
  })

  it('parseRegQueryFirstValue:取第一条值,(默认) 中英文都不靠值名匹配', () => {
    expect(win.parseRegQueryFirstValue('HKEY_CURRENT_USER\\K\r\n    (默认)    REG_SZ    bowHTML\r\n')).toBe('bowHTML')
    expect(win.parseRegQueryFirstValue('HKEY_CURRENT_USER\\K\r\n    (Default)    REG_SZ    ChromeHTML\r\n')).toBe('ChromeHTML')
    expect(win.parseRegQueryFirstValue('ERROR: 系统找不到指定的注册表项或值。')).toBeNull()
    expect(win.parseRegQueryFirstValue('')).toBeNull()
  })

  it('friendlyProgId:常见浏览器翻成人话,认不出的返回 undefined(不猜)', () => {
    // 实机反馈里出现过的真实 ProgID
    expect(win.friendlyProgId('FirefoxURL-308046B0AF4A39CB')).toBe('Firefox')
    expect(win.friendlyProgId('FirefoxHTML-308046B0AF4A39CB')).toBe('Firefox')
    expect(win.friendlyProgId('bowURL')).toBe('bow')
    expect(win.friendlyProgId('bowHTML')).toBe('bow')
    expect(win.friendlyProgId('ChromeHTML')).toBe('Chrome')
    expect(win.friendlyProgId('MSEdgeHTM')).toBe('Edge')
    expect(win.friendlyProgId('BraveHTML')).toBe('Brave')
    expect(win.friendlyProgId('VivaldiHTM')).toBe('Vivaldi')
    expect(win.friendlyProgId('IE.HTTP')).toBe('Internet Explorer')
    expect(win.friendlyProgId('htmlfile')).toContain('系统通用')
    expect(win.friendlyProgId('SomeVendorProgId')).toBeUndefined()
    // 实际生效者是以“程序名”报出来的,不是 ProgID
    expect(win.friendlyProgId('firefox')).toBe('Firefox')
    expect(win.friendlyProgId('msedge')).toBe('Edge')
    expect(win.friendlyProgId('chrome')).toBe('Chrome')
  })

  it('buildAssocProbeScript:调的是 shell 自己的 AssocQueryString,并带上全部目标', () => {
    const script = win.buildAssocProbeScript([{ id: '.html' }, { id: 'http' }])
    expect(script).toContain('Shlwapi.dll')
    expect(script).toContain('AssocQueryString')
    expect(script).toContain('0, 2, $t[1], "open"') // flags=0, ASSOCSTR_EXECUTABLE=2
    expect(script).toContain("@('.html', '.html')")
    expect(script).toContain("@('http', 'http')")
  })

  it('parseAssocProbeOutput:容忍 PowerShell 的杂音行,空 exe 忽略', () => {
    const out = [
      'Add-Type: 已编译',
      '.html|C:\\Program Files\\bow\\bow.exe',
      'http|',
      'https|C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      ''
    ].join('\r\n')
    expect(win.parseAssocProbeOutput(out)).toEqual({
      '.html': 'C:\\Program Files\\bow\\bow.exe',
      https: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
    })
    expect(win.parseAssocProbeOutput('')).toEqual({})
  })

  it('exeStem:从路径取程序名(带引号 / 不同大小写 / 无扩展名都行)', () => {
    expect(win.exeStem('C:\\a\\bow.exe')).toBe('bow')
    expect(win.exeStem('"C:\\Program Files\\bow\\BOW.EXE"')).toBe('bow')
    expect(win.exeStem('C:\\a\\firefox')).toBe('firefox')
  })

  it('解析 reg query 输出', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.html\\UserChoice\r\n    ProgId    REG_SZ    ChromeHTML\r\n\r\n'
    expect(win.parseRegQueryValue(out, 'ProgId')).toBe('ChromeHTML')
  })

  it('(默认) 值名与中文 Windows 的输出都能解析', () => {
    const out = 'HKEY_CURRENT_USER\\K\r\n    (默认)    REG_SZ    bowHTML\r\n'
    expect(win.parseRegQueryValue(out, '(默认)')).toBe('bowHTML')
  })

  it('没有该值 / 垃圾输入返回 null', () => {
    expect(win.parseRegQueryValue('HKEY_CURRENT_USER\\K\r\n', 'ProgId')).toBeNull()
    expect(win.parseRegQueryValue('', 'ProgId')).toBeNull()
    expect(win.parseRegQueryValue('ERROR: 系统找不到指定的注册表项或值。', 'ProgId')).toBeNull()
  })
})

describe('windowsRegistry:reg.exe 参数生成', () => {
  it('默认值用 /ve,具名值用 /v', () => {
    expect(win.regAddArgs({ key: 'K', name: null, type: 'REG_SZ', data: 'x' })).toEqual(['ADD', 'K', '/t', 'REG_SZ', '/ve', '/d', 'x', '/f'])
    expect(win.regAddArgs({ key: 'K', name: 'v', type: 'REG_SZ', data: 'x' })).toEqual(['ADD', 'K', '/t', 'REG_SZ', '/v', 'v', '/d', 'x', '/f'])
  })

  it('删除值 vs 删除整键的参数不同(整键不能带 /ve)', () => {
    expect(win.regDeleteValueArgs({ key: 'K', name: 'v' })).toEqual(['DELETE', 'K', '/v', 'v', '/f'])
    expect(win.regDeleteKeyArgs('K')).toEqual(['DELETE', 'K', '/f'])
  })

  it('query 用于写后自校验', () => {
    expect(win.regQueryArgs({ key: 'K', name: null })).toEqual(['QUERY', 'K', '/ve'])
    expect(win.regQueryArgs({ key: 'K', name: 'v' })).toEqual(['QUERY', 'K', '/v', 'v'])
  })

  it('打印出来的命令带引号(路径含空格也能直接复制去跑)', () => {
    const line = win.formatRegCommand(win.regAddArgs({ key: 'K', name: null, type: 'REG_SZ', data: `"${EXE}" "%1"` }))
    const quoted = `"\\"${EXE}\\" \\"%1\\""`
    expect(line).toBe(`reg ADD K /t REG_SZ /ve /d ${quoted} /f`)
  })
})

// ---------------------------------------------------------------- Linux 纯逻辑

describe('linuxDesktop:文件内容', () => {
  it('.desktop 声明 MimeType / Exec %U / WM_CLASS,并带生成标记', () => {
    const text = linux.desktopFileContent({ exec: '/home/u/.local/bin/bow', desktopName: 'com.ruinb0w.bow' })
    expect(text).toContain('Exec=/home/u/.local/bin/bow %U')
    expect(text).toContain(`MimeType=${linux.DEFAULT_MIME_TYPES.join(';')};`)
    expect(text).toContain('StartupWMClass=com.ruinb0w.bow')
    expect(text).toContain(linux.MARKER)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('Exec 里有空格时整体加引号', () => {
    const text = linux.desktopFileContent({ exec: '/opt/my bow/bow', desktopName: 'x' })
    expect(text).toContain('Exec="/opt/my bow/bow" %U')
  })

  it('包装脚本直推 electron + 仓库目录,并带生成标记', () => {
    const text = linux.wrapperScriptContent({ electronPath: '/repo/node_modules/electron/dist/electron', appPath: '/repo' })
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    expect(text).toContain(`exec "/repo/node_modules/electron/dist/electron" "/repo" "$@"`)
    expect(linux.hasMarker(text)).toBe(true)
  })
})

describe('linuxDesktop:mimeapps.list 增删查', () => {
  const ORIGINAL = [
    '# 我的注释',
    '[Default Applications]',
    'text/html=firefox.desktop;',
    'image/png=nomacs.desktop;',
    '',
    '[Added Associations]',
    'text/html=firefox.desktop;',
    ''
  ].join('\n')

  it('解析默认段(忽略其它段与注释)', () => {
    expect(linux.parseDefaults(ORIGINAL)).toEqual({ 'text/html': 'firefox.desktop;', 'image/png': 'nomacs.desktop;' })
  })

  it('就地更新命中的键、段首补缺失的键,其余逐字保留', () => {
    const { text, previous } = linux.upsertDefaults(ORIGINAL, {
      'text/html': 'com.ruinb0w.bow.desktop;',
      'x-scheme-handler/http': 'com.ruinb0w.bow.desktop;'
    })
    expect(previous['text/html']).toBe('firefox.desktop;')
    const lines = text.split('\n')
    expect(lines[0]).toBe('# 我的注释')
    expect(lines[1]).toBe('[Default Applications]')
    expect(lines[2]).toBe('x-scheme-handler/http=com.ruinb0w.bow.desktop;')
    expect(text).toContain('text/html=com.ruinb0w.bow.desktop;')
    expect(text).toContain('image/png=nomacs.desktop;') // 别人的键不动
    expect(text).toContain('[Added Associations]\ntext/html=firefox.desktop;')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('缺段时新建[Default Applications]并保留原内容', () => {
    const { text } = linux.upsertDefaults('[Added Associations]\ntext/html=x.desktop;\n', { 'text/html': 'bow.desktop;' })
    expect(text).toContain('[Added Associations]')
    expect(text).toContain(`[Default Applications]\ntext/html=bow.desktop;`)
  })

  it('撤销只删指向我们的键,别的键与别的段保留', () => {
    const { text, removed } = linux.removeFromDefaults(
      '[Default Applications]\ntext/html=com.ruinb0w.bow.desktop;\nimage/png=nomacs.desktop;\n\n[Added Associations]\ntext/html=com.ruinb0w.bow.desktop;\n',
      'com.ruinb0w.bow.desktop'
    )
    expect(removed).toEqual(['text/html'])
    expect(text).toContain('image/png=nomacs.desktop;')
    expect(text).toContain('[Added Associations]\ntext/html=com.ruinb0w.bow.desktop;') // 非默认段不动
    expect(linux.parseDefaults(text)).not.toHaveProperty('text/html')
  })

  it('值是分号列表时也算命中我们', () => {
    expect(linux.valueTargetsUs('a.desktop;com.ruinb0w.bow.desktop;', 'com.ruinb0w.bow.desktop')).toBe(true)
    expect(linux.valueTargetsUs('a.desktop;', 'com.ruinb0w.bow.desktop')).toBe(false)
    expect(linux.valueTargetsUs(undefined, 'x')).toBe(false)
  })
})

// ---------------------------------------------------------------- 状态与注册编排(注入假 fs / 假注册表)

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const modes = new Map<string, number>()
  const fs: FsLike = {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p) ?? null,
    writeFileSync: (p, data, mode) => {
      files.set(p, data)
      modes.set(p, mode)
    },
    mkdirSync: () => {},
    copyFileSync: (from, to) => {
      const v = files.get(from)
      if (v !== undefined) files.set(to, v)
    },
    rmSync: (p) => {
      files.delete(p)
    }
  }
  return { fs, files, modes }
}

/** 假注册表:记住写入过的 (键,值) 供 QUERY 命中,并可指定失败模式 */
function fakeRegistry({ seed = {}, failNone = false, failQuery = false }: { seed?: Record<string, string>; failNone?: boolean; failQuery?: boolean } = {}) {
  const written = new Map<string, string>(Object.entries(seed))
  const calls: string[][] = []
  const k = (args: string[]) => {
    const i = args.indexOf('/v')
    return `${args[1]}|${i >= 0 ? args[i + 1] : ''}`
  }
  const run = (args: string[]): RegResult => {
    calls.push(args)
    if (args[0] === 'ADD') {
      if (failNone && args.includes('REG_NONE')) return { status: 1, stdout: '', stderr: 'ERROR: 参数无效' }
      written.set(k(args), args[args.indexOf('/d') + 1] ?? '')
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'QUERY') {
      if (failQuery) return { status: 1, stdout: '', stderr: '' }
      const value = written.get(k(args))
      if (value === undefined) return { status: 1, stdout: '', stderr: 'ERROR: 找不到' }
      return { status: 0, stdout: `HKEY_CURRENT_USER\\x\r\n    ${args.includes('/v') ? args[args.indexOf('/v') + 1] : '(默认)'}    REG_SZ    ${value}\r\n`, stderr: '' }
    }
    if (args[0] === 'DELETE') {
      // 真实 reg.exe 删不存在的值 / 键是非 0 退出码 → 插件据此判断「本来就没事可撤」
      const i = args.indexOf('/v')
      if (i >= 0) {
        const kk = `${args[1]}|${args[i + 1]}`
        if (!written.has(kk)) return { status: 1, stdout: '', stderr: 'ERROR: 找不到' }
        written.delete(kk)
        return { status: 0, stdout: '', stderr: '' }
      }
      const prefix = `${args[1]}|`
      const hit = [...written.keys()].filter((x) => x.startsWith(prefix))
      if (hit.length === 0) return { status: 1, stdout: '', stderr: 'ERROR: 找不到' }
      for (const x of hit) written.delete(x)
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { run, calls, written }
}

const LINUX_PATHS = {
  desktop: '/home/u/.local/share/applications/com.ruinb0w.bow.desktop',
  wrapper: '/home/u/.local/bin/bow',
  mimeapps: '/home/u/.config/mimeapps.list',
  backup: '/home/u/.config/mimeapps.list.bow.bak'
}

function linuxDeps(over: Partial<RegistrationDeps> & { files?: Record<string, string> } = {}) {
  const { files, ...rest } = over
  const mem = memFs(files)
  return { ...mem, deps: { platform: 'linux', home: '/home/u', repoRoot: '/repo', execPath: '/repo/node_modules/electron/dist/electron', isPackaged: false, env: { PATH: '/usr/bin' }, fs: mem.fs, ...rest } as RegistrationDeps }
}

describe('registration:Linux 状态与注册', () => {
  it('未注册:全部 unset,registered/isDefault 都是 false', () => {
    const { deps } = linuxDeps()
    const st = desktopStatus(deps)
    expect(st.platform).toBe('linux')
    expect(st.mode).toBe('dev')
    expect(st.exec).toBe(LINUX_PATHS.wrapper)
    expect(st.targets.map((t) => t.state)).toEqual(['unset', 'unset', 'unset', 'unset'])
    expect(st.registered).toBe(false)
    expect(st.isDefault).toBe(false)
  })

  it('mimeapps 指向我们 → isDefault;指向别人 → other 并带出当前值', () => {
    const ours = linuxDeps({
      files: {
        [LINUX_PATHS.mimeapps]: `[Default Applications]\n${linux.DEFAULT_MIME_TYPES.map((t) => `${t}=com.ruinb0w.bow.desktop;`).join('\n')}\n`,
        [LINUX_PATHS.desktop]: linux.desktopFileContent({ exec: LINUX_PATHS.wrapper, desktopName: 'com.ruinb0w.bow' })
      }
    })
    const stOurs = desktopStatus(ours.deps)
    expect(stOurs.isDefault).toBe(true)
    expect(stOurs.registered).toBe(true)
    expect(statusBadge(stOurs)).toEqual({ text: '已是默认浏览器', tone: 'ok' })

    const theirs = linuxDeps({ files: { [LINUX_PATHS.mimeapps]: '[Default Applications]\ntext/html=firefox.desktop;\n' } })
    const stTheirs = desktopStatus(theirs.deps)
    expect(stTheirs.targets.find((t) => t.id === 'text/html')).toMatchObject({
      id: 'text/html',
      label: '.html 文件',
      state: 'other',
      current: 'firefox.desktop;'
    })
    expect(statusBadge(stTheirs)).toEqual({ text: '尚未注册', tone: 'idle' })
  })

  it('注册:写包装脚本 + .desktop + 默认关联,并备份原 mimeapps', () => {
    const { deps, files, modes } = linuxDeps({ files: { [LINUX_PATHS.mimeapps]: '[Default Applications]\ntext/html=firefox.desktop;\n' } })
    const res = registerDesktop(deps)
    expect(res.status.isDefault).toBe(true)
    expect(res.status.registered).toBe(true)
    expect(files.get(LINUX_PATHS.wrapper)).toContain('#!/bin/sh')
    expect(modes.get(LINUX_PATHS.wrapper)).toBe(0o755)
    expect(files.get(LINUX_PATHS.desktop)).toContain(`Exec=${LINUX_PATHS.wrapper} %U`)
    expect(files.get(LINUX_PATHS.backup)).toContain('firefox.desktop')
    expect(res.log.some((l) => l.includes('原默认应用被覆盖'))).toBe(true)
    expect(res.log.some((l) => l.startsWith('✅'))).toBe(true)
  })

  it('重复注册是幂等的:不再重写,也不再备份', () => {
    const { deps, files } = linuxDeps()
    registerDesktop(deps)
    const snapshot = new Map(files)
    // 清掉备份,验证第二次不会重新产生
    files.delete(LINUX_PATHS.backup)
    const second = registerDesktop(deps)
    expect([...files.entries()].filter(([k]) => k !== LINUX_PATHS.backup)).toEqual([...snapshot.entries()].filter(([k]) => k !== LINUX_PATHS.backup))
    expect(files.has(LINUX_PATHS.backup)).toBe(false)
    expect(second.log.filter((l) => l.includes('未变化')).length).toBeGreaterThanOrEqual(3)
  })

  it('已存在但不是我们写的文件:拒绝覆盖', () => {
    const { deps, files } = linuxDeps({ files: { [LINUX_PATHS.wrapper]: '#!/bin/sh\necho not-bow\n' } })
    const res = registerDesktop(deps)
    expect(res.log.some((l) => l.includes('拒绝覆盖'))).toBe(true)
    expect(files.get(LINUX_PATHS.wrapper)).toBe('#!/bin/sh\necho not-bow\n')
  })

  it('打包模式:直接指向真实二进制,不写包装脚本', () => {
    const { deps, files } = linuxDeps({ isPackaged: true, execPath: '/opt/bow/bow' })
    const res = registerDesktop(deps)
    expect(res.status.mode).toBe('packaged')
    expect(files.get(LINUX_PATHS.desktop)).toContain('Exec=/opt/bow/bow %U')
    expect(files.has(LINUX_PATHS.wrapper)).toBe(false)
  })

  it('撤销:删掉我们的条目与关联,但保留别人的键与非默认段', () => {
    const { deps, files } = linuxDeps({ files: { [LINUX_PATHS.mimeapps]: '[Default Applications]\nimage/png=nomacs.desktop;\n' } })
    registerDesktop(deps)
    const res = unregisterDesktop(deps)
    expect(files.has(LINUX_PATHS.desktop)).toBe(false)
    expect(files.has(LINUX_PATHS.wrapper)).toBe(false)
    const text = files.get(LINUX_PATHS.mimeapps) ?? ''
    expect(text).toContain('image/png=nomacs.desktop;')
    expect(text).not.toContain('com.ruinb0w.bow.desktop')
    expect(res.status.isDefault).toBe(false)
    expect(res.status.registered).toBe(false)
  })

  it('别人的桌面条目不会被删', () => {
    const { deps, files } = linuxDeps({ files: { [LINUX_PATHS.desktop]: '[Desktop Entry]\nName=firefox\n' } })
    const res = unregisterDesktop(deps)
    expect(files.has(LINUX_PATHS.desktop)).toBe(true)
    expect(res.log.some((l) => l.includes('不动别人的文件'))).toBe(true)
  })
})

describe('registration:Windows 状态与注册', () => {
  const ucr = (id: string) => win.userChoiceTargets().find((t) => t.id === id)!

  it('http/https 读的是 Shell\\Associations 下的 UserChoice(回归:位置写错 → 永远「未设置」)', () => {
    const reg = fakeRegistry({
      seed: {
        [`${ucr('http').key}|ProgId`]: 'bowURL',
        [`${ucr('https').key}|ProgId`]: 'bowURL'
      }
    })
    const st = desktopStatus({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    expect(st.targets.find((t) => t.id === 'http')).toMatchObject({ state: 'default', current: 'bowURL' })
    expect(st.targets.find((t) => t.id === 'https')).toMatchObject({ state: 'default', current: 'bowURL' })
    // 结论是从哪个键读出来的也要报出来(下次再怀疑读错位置,看一眼就知道)
    expect(st.targets.find((t) => t.id === 'http')?.source).toContain(
      'Shell\\Associations\\UrlAssociations\\http\\UserChoice → ProgId'
    )
  })

  it('备用键也能命中(个别构建把 URL 关联放在 Explorer 下)', () => {
    const reg = fakeRegistry({ seed: { [`${ucr('http').alternateKeys![0]}|ProgId`]: 'bowURL' } })
    const st = desktopStatus({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    expect(st.targets.find((t) => t.id === 'http')?.state).toBe('default')
    expect(st.targets.find((t) => t.id === 'http')?.source).toContain('CurrentVersion\\Explorer\\UrlAssociations')
  })

  it('UserChoice 缺席时回落到 Software\\Classes 的默认值(HKCR 合并顺序)', () => {
    const reg = fakeRegistry({ seed: { 'HKCU\\Software\\Classes\\.xhtml|': 'bowHTML' } })
    const st = desktopStatus({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    const xhtml = st.targets.find((t) => t.id === '.xhtml')
    expect(xhtml).toMatchObject({ state: 'default', current: 'bowHTML' })
    expect(xhtml?.source).toContain('HKCU\\Software\\Classes\\.xhtml → (默认值)')
  })

  it('UserChoice 指向 bow → isDefault;指向别的 → other + 带出当前值与修法', () => {
    const reg = fakeRegistry({
      seed: {
        ...Object.fromEntries(win.userChoiceTargets().map((t) => [`${t.key}|ProgId`, t.expect])),
        [`${plan.adds[0].key}|`]: 'bow HTML Document'
      }
    })
    const st = desktopStatus({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    expect(st.isDefault).toBe(true)
    expect(st.registered).toBe(true)
    expect(statusBadge(st).tone).toBe('ok')

    const reg2 = fakeRegistry({ seed: { [`${ucr('.htm').key}|ProgId`]: 'FirefoxHTML-308046B0AF4A39CB' } })
    const st2 = desktopStatus({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg2.run })
    const htm = st2.targets.find((t) => t.id === '.htm')
    expect(htm).toMatchObject({ state: 'other', current: 'FirefoxHTML-308046B0AF4A39CB', currentLabel: 'Firefox' })
    expect(htm?.fix).toContain('打开方式')
    expect(st2.isDefault).toBe(false)

    // 协议项也报出人话名与针对性修法(实机反馈:http/https 被 Firefox 占着)
    const reg3 = fakeRegistry({ seed: { [`${ucr('http').key}|ProgId`]: 'FirefoxURL-308046B0AF4A39CB' } })
    const st3 = desktopStatus({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg3.run })
    const http = st3.targets.find((t) => t.id === 'http')
    expect(http).toMatchObject({ state: 'other', currentLabel: 'Firefox' })
    expect(http?.fix).toContain('系统设置页')
    // 默认项不报人话名(避免行里多一块无意义标签)
    expect(st.targets.find((t) => t.id === 'http')?.currentLabel).toBeUndefined()
  })

  it('实际生效与记录不一致时:以实际为准,并说明记录已失效(实机:记录 Firefox、双击却是 bow)', () => {
    // 记录里 .html 是 Firefox,但 Windows 实际会用 bow 打开(Hash 失效 → 回落到 Software\Classes)
    const reg = fakeRegistry({
      seed: {
        [`${ucr('.html').key}|ProgId`]: 'FirefoxHTML-308046B0AF4A39CB',
        'HKCU\\Software\\Classes\\.html|': 'bowHTML'
      }
    })
    const st = desktopStatus({
      platform: 'win32',
      isPackaged: true,
      execPath: EXE,
      runReg: reg.run,
      runPowerShell: () => ({ status: 0, stdout: '.html|C:\\Program Files\\bow\\bow.exe\r\n', stderr: '' })
    })
    const html = st.targets.find((t) => t.id === '.html')
    expect(html).toMatchObject({ state: 'default', effective: 'bow' })
    expect(html?.effectivePath).toContain('bow.exe')
    expect(html?.fix).toContain('Hash 失效')
    // 记录本身仍然展示出来(不藏证据)
    expect(html?.current).toBe('FirefoxHTML-308046B0AF4A39CB')
  })

  it('记录与实际一致时不显示「实际」标记(标记只用于不一致)', () => {
    const reg = fakeRegistry({ seed: { [`${ucr('.html').key}|ProgId`]: 'bowHTML' } })
    const st = desktopStatus({
      platform: 'win32',
      isPackaged: true,
      execPath: EXE,
      runReg: reg.run,
      runPowerShell: () => ({ status: 0, stdout: '.html|C:\\Program Files\\bow\\bow.exe\r\n', stderr: '' })
    })
    const row = st.targets.find((t) => t.id === '.html')
    expect(row?.state).toBe('default')
    expect(row?.effective).toBeUndefined()
    expect(row?.effectivePath).toBeUndefined()
  })

  it('反向不一致:记录写着 bow,实际生效是 firefox → 报非默认并说清', () => {
    const reg = fakeRegistry({ seed: { [`${ucr('.htm').key}|ProgId`]: 'bowHTML' } })
    const st = desktopStatus({
      platform: 'win32',
      isPackaged: true,
      execPath: EXE,
      runReg: reg.run,
      runPowerShell: () => ({ status: 0, stdout: '.htm|"C:\\Program Files\\Mozilla Firefox\\firefox.exe"\r\n', stderr: '' })
    })
    const htm = st.targets.find((t) => t.id === '.htm')
    expect(htm).toMatchObject({ state: 'other', effective: 'firefox', currentLabel: 'Firefox' })
    expect(htm?.fix).toContain('实际生效的是 firefox')
  })

  it('实际探测不可用时:只依据记录,并明确告知', () => {
    const reg = fakeRegistry({ seed: { [`${ucr('.html').key}|ProgId`]: 'FirefoxHTML-308046B0AF4A39CB' } })
    const st = desktopStatus({
      platform: 'win32',
      isPackaged: true,
      execPath: EXE,
      runReg: reg.run,
      runPowerShell: () => ({ status: null, stdout: '', stderr: '不可用' })
    })
    expect(st.targets.find((t) => t.id === '.html')?.effective).toBeUndefined()
    expect(st.notes.some((n) => n.includes('仅依据注册表记录'))).toBe(true)
  })

  it('dev 模式:能读状态但不可注册,并给出原因', () => {
    const reg = fakeRegistry()
    const st = desktopStatus({ platform: 'win32', isPackaged: false, execPath: 'C:\\electron.exe', runReg: reg.run })
    expect(st.canRegister).toBe(false)
    expect(st.error).toContain('npm run dist')
    const res = registerDesktop({ platform: 'win32', isPackaged: false, execPath: 'C:\\electron.exe', runReg: reg.run })
    expect(res.log.some((l) => l.includes('开发模式不支持注册'))).toBe(true)
    expect(reg.calls.filter((c) => c[0] === 'ADD')).toHaveLength(0) // 一个键都没写
  })

  it('注册:写入全部条目(含传统回落),并逐条 reg query 自校验', () => {
    const reg = fakeRegistry()
    const res = registerDesktop({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    const adds = reg.calls.filter((c) => c[0] === 'ADD')
    expect(adds).toHaveLength(plan.adds.length)
    // 传统回落:Software\Classes\.<ext> 的默认值也要写(否则没有 UserChoice 的类型不归我们)
    for (const ext of win.DEFAULT_FILE_TYPES) {
      expect(adds.some((c) => c[1] === `HKCU\\Software\\Classes\\${ext}` && c.includes('/ve'))).toBe(true)
    }
    // 每一条写入都要被 query 验证过(注:状态探测自己也会 query,所以不能直接数总数)
    for (const op of plan.adds) {
      expect(reg.calls.some((c) => c[0] === 'QUERY' && c[1] === op.key)).toBe(true)
    }
    expect(res.log.some((l) => l.includes('已校验'))).toBe(true)
    expect(res.log.some((l) => l.includes('最后一步请在系统里点一次'))).toBe(true)
    expect(res.status.manualSteps.length).toBeGreaterThan(0)
  })

  it('REG_NONE 被拒时退化成空 REG_SZ 并继续', () => {
    const reg = fakeRegistry({ failNone: true })
    const res = registerDesktop({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    expect(res.log.some((l) => l.includes('已用空 REG_SZ 代替'))).toBe(true)
    expect(res.log.some((l) => l.includes('已校验'))).toBe(true)
  })

  it('自校验失败会明确报错', () => {
    const reg = fakeRegistry({ failQuery: true })
    const res = registerDesktop({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    expect(res.log.some((l) => l.includes('没落地'))).toBe(true)
    expect(res.log.some((l) => l.includes('注册未完成'))).toBe(true)
  })

  it('撤销:只删自己那几项,传统回落值是我们的才删', () => {
    const reg = fakeRegistry()
    registerDesktop({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    reg.calls.length = 0
    const res = unregisterDesktop({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    const deletes = reg.calls.filter((c) => c[0] === 'DELETE')
    expect(deletes).toHaveLength(
      plan.deletes.values.length + plan.deletes.keys.length + plan.deletes.guardedValues.length
    )
    expect(res.log.some((l) => l.startsWith('✅ 已移除'))).toBe(true)
  })

  it('撤销时别人的默认值(Software\\Classes\.<ext>)必须留着', () => {
    const reg = fakeRegistry({ seed: { 'HKCU\\Software\\Classes\\.html|': 'htmlfile' } })
    const res = unregisterDesktop({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    expect(res.log.some((l) => l.includes('保留 HKCU\\Software\\Classes\\.html'))).toBe(true)
    expect(reg.written.get('HKCU\\Software\\Classes\\.html|')).toBe('htmlfile')
  })

  it('本来没注册也不报错', () => {
    const reg = fakeRegistry()
    const res = unregisterDesktop({ platform: 'win32', isPackaged: true, execPath: EXE, runReg: reg.run })
    expect(res.log.some((l) => l.includes('无需撤销'))).toBe(true)
  })
})

describe('registration:其它平台', () => {
  it('macOS 报「暂不支持」而不是假装成功', () => {
    const st = desktopStatus({ platform: 'darwin' })
    expect(st.supported).toBe(false)
    expect(st.canRegister).toBe(false)
    expect(st.error).toContain('macOS')
    expect(statusBadge(st)).toEqual({ text: '本平台暂不支持', tone: 'idle' })
    const res = registerDesktop({ platform: 'darwin' })
    expect(res.log.some((l) => l.includes('不支持'))).toBe(true)
  })
})

describe('registration:打开系统设置页', () => {
  it('Windows:走 ms-settings:defaultapps,并把结果告诉用户', () => {
    const opened: string[] = []
    const res = openPlatformSettings({ platform: 'win32', openExternal: (t) => (opened.push(t), true) })
    expect(opened).toEqual(['ms-settings:defaultapps'])
    expect(res.ok).toBe(true)
    expect(res.message).toContain('逐项')
  })

  it('Windows 上打不开时给出手动路径(不假装成功)', () => {
    const res = openPlatformSettings({ platform: 'win32', openExternal: () => false })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('设置 → 应用 → 默认应用')
  })

  it('Linux 上没有等价的系统页,直接说明并指向「注册」', () => {
    const res = openPlatformSettings({ platform: 'linux', openExternal: () => true })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('注册')
  })
})
