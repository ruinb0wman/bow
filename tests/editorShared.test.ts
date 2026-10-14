/**
 * 编辑器插件的纯逻辑:`editor.json` 的规范化、路由判定、命令拼装。
 *
 * 重点看住三件事:① `{file}` 的替换与"没写占位符"的兜底;② `pathStyle: 'wsl'` 的换算与
 * 换算不出时的拒绝(不许猜路径);③ 白名单判定 —— `--edit` 一律进,否则只认清单里的扩展名。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXTENSIONS,
  buildEditorCommand,
  defaultSettings,
  extensionOf,
  normalizeEditorSettings,
  normalizeExtensions,
  shouldOpenInEditor
} from '../src/plugins/editor/shared'
import type { EditorSettings } from '../src/plugins/editor/shared'

const win = defaultSettings('win32')
const linux = defaultSettings('linux')

function withSettings(patch: Partial<EditorSettings>): EditorSettings {
  return { ...win, ...patch }
}

describe('默认设置', () => {
  it('Windows 默认是 WSL 里的 nvim,Linux 是本地 nvim', () => {
    expect(win.shell).toBe('wsl.exe')
    expect(win.args).toEqual(['-e', 'nvim', '{file}'])
    expect(win.pathStyle).toBe('wsl')
    expect(linux.shell).toBe('nvim')
    expect(linux.pathStyle).toBe('native')
  })

  it('默认清单里不含 .html / .htm(那两个归默认浏览器插件)', () => {
    expect(DEFAULT_EXTENSIONS).not.toContain('.html')
    expect(DEFAULT_EXTENSIONS).not.toContain('.htm')
    expect(DEFAULT_EXTENSIONS).toContain('.txt')
    expect(DEFAULT_EXTENSIONS).toContain('.ts')
  })
})

describe('normalizeExtensions', () => {
  it('小写、补点、去重、丢非法项、保序', () => {
    expect(normalizeExtensions(['TXT', '.Md', 'md', '  .json  ', '', 42, '.x y', 'a/b'])).toEqual([
      '.txt',
      '.md',
      '.json'
    ])
  })
})

describe('normalizeEditorSettings', () => {
  it('空/坏输入回落到 fallback,不抛', () => {
    expect(normalizeEditorSettings(null, win)).toEqual({ ...win, lastRegistered: [] })
    expect(normalizeEditorSettings({ shell: '   ' }, win).shell).toBe('wsl.exe')
    expect(normalizeEditorSettings({ args: [] }, win).args).toEqual(win.args)
    expect(normalizeEditorSettings({ pathStyle: 'wat' }, win).pathStyle).toBe('wsl')
  })

  it('空清单退回默认(注册表与路由都靠它)', () => {
    expect(normalizeEditorSettings({ extensions: [] }, win).extensions).toEqual(DEFAULT_EXTENSIONS)
  })

  it('lastRegistered 归一化(撤销按它删)', () => {
    expect(normalizeEditorSettings({ lastRegistered: ['.TXT', '.md', '.txt'] }, win).lastRegistered).toEqual([
      '.txt',
      '.md'
    ])
  })
})

describe('extensionOf', () => {
  it.each([
    ['C:\\tmp\\a.TXT', '.txt'],
    ['/tmp/a.md', '.md'],
    ['/tmp/.env', '.env'],
    ['C:\\tmp\\.gitignore', '.gitignore'],
    ['/tmp/README', ''],
    ['/tmp/a.', ''],
    ['', '']
  ])('%s → %s', (path, expected) => {
    expect(extensionOf(path)).toBe(expected)
  })
})

describe('shouldOpenInEditor', () => {
  it('--edit 一律进(右键「用 bow 编辑」)', () => {
    expect(shouldOpenInEditor(win, 'C:\\tmp\\a.exe', 'edit')).toBe(true)
  })

  it('不带 --edit 时只认清单里的扩展名', () => {
    expect(shouldOpenInEditor(win, 'C:\\tmp\\a.txt', 'open')).toBe(true)
    expect(shouldOpenInEditor(win, 'C:\\tmp\\a.html', 'open')).toBe(false)
    expect(shouldOpenInEditor(win, 'C:\\tmp\\README', 'open')).toBe(false)
  })
})

describe('buildEditorCommand', () => {
  it('默认模板:替换 {file},并用文件所在目录当 cwd(WSL 形式由 wsl.exe 自己映射)', () => {
    const result = buildEditorCommand(win, 'C:\\tmp\\a.txt')
    expect(result).toEqual({
      ok: true,
      command: { file: 'wsl.exe', args: ['-e', 'nvim', '/mnt/c/tmp/a.txt'], cwd: 'C:\\tmp' }
    })
  })

  it('盘根与其它盘符', () => {
    const result = buildEditorCommand(win, 'd:\\b.md')
    expect(result.ok && result.command).toEqual({ file: 'wsl.exe', args: ['-e', 'nvim', '/mnt/d/b.md'], cwd: 'd:\\' })
  })

  it('每一项参数里的 {file} 都会被替换', () => {
    const s = withSettings({ args: ['-e', 'bash', '-lc', 'nvim {file} +{file}'] })
    const result = buildEditorCommand(s, 'C:\\tmp\\a.txt')
    expect(result.ok && result.command.args).toEqual(['-e', 'bash', '-lc', 'nvim /mnt/c/tmp/a.txt +/mnt/c/tmp/a.txt'])
  })

  it('一项都没写 {file} 时把路径追加到末尾', () => {
    const s = withSettings({ args: ['-e', 'nvim'] })
    const result = buildEditorCommand(s, 'C:\\tmp\\a.txt')
    expect(result.ok && result.command.args).toEqual(['-e', 'nvim', '/mnt/c/tmp/a.txt'])
  })

  it('filePath = null(测试按钮):含 {file} 的参数整项去掉', () => {
    const result = buildEditorCommand(win, null)
    expect(result.ok && result.command).toEqual({ file: 'wsl.exe', args: ['-e', 'nvim'], cwd: '' })
  })

  it('native 写法原样传路径(Linux 侧)', () => {
    const result = buildEditorCommand(linux, '/home/me/a.md')
    expect(result).toEqual({ ok: true, command: { file: 'nvim', args: ['/home/me/a.md'], cwd: '/home/me' } })
  })

  it('pathStyle=wsl 但换算不出(UNC)→ 明确报错,不猜', () => {
    const result = buildEditorCommand(win, '\\\\wsl$\\archlinux\\home\\me\\a.md')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('换算不出')
  })

  it('没有配置命令 → 报错', () => {
    expect(buildEditorCommand(withSettings({ shell: '  ' }), 'C:\\a.txt').ok).toBe(false)
  })
})
