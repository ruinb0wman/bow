/**
 * 编辑器插件:Windows 注册计划 + 注册/撤销编排 + 状态判定。
 *
 * 与默认浏览器插件一样,**在 Linux 上也能测 Windows 分支**(`runReg` / `runPowerShell` 可注入,
 * 用内存假注册表跑完整流程)。重点看住四条:
 * ① 只注册成候选 —— 绝不写 `Classes\.<ext>` 的默认值、不碰 `RegisteredApplications\bow`;
 * ② 「编辑」动词落在 `SystemFileAssociations\.<ext>\shell\bow-edit`(与默认处理程序无关);
 * ③ 撤销只删自己写的值与自己建的键;按 `lastRegistered` 删(改过清单也不留残渣);
 * ④ 状态分开报「注册了没有」与「系统当前交给谁」。
 */

import { describe, expect, it } from 'vitest'
import {
  buildEditorRegistration,
  regLabel
} from '../src/plugins/editor/windowsRegistry'
import { editorStatus, registerEditor, unregisterEditor } from '../src/plugins/editor/registration'
import { defaultSettings, normalizeEditorSettings, type EditorSettings } from '../src/plugins/editor/shared'
import type { RegResult } from '../src/main/plugins/registryOps'

const EXE = 'C:\\Program Files\\bow\\bow.exe'
/** 探测不可用(等价于 PowerShell 被策略拦下):默认注入它,免得每条用例都真的起一次 powershell.exe */
const noPS = () => ({ status: 1, stdout: '', stderr: '' })
const settings: EditorSettings = normalizeEditorSettings({ extensions: ['.txt', '.md'] }, defaultSettings('win32'))

/** 假注册表:记住写入过的 (键,值) 供 QUERY 命中;DELETEs 只删值(键删除按前缀清) */
function fakeRegistry(
  { seed = {}, failNone = false }: { seed?: Record<string, string>; failNone?: boolean } = {}
): { run: (args: string[]) => RegResult; calls: string[][]; written: Map<string, string> } {
  const written = new Map<string, string>(Object.entries(seed))
  const calls: string[][] = []
  const k = (args: string[]): string => {
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
      const value = written.get(k(args))
      if (value === undefined) return { status: 1, stdout: '', stderr: 'ERROR: 找不到' }
      const name = args.includes('/v') ? args[args.indexOf('/v') + 1] : '(默认)'
      return { status: 0, stdout: `HKEY_CURRENT_USER\\x\r\n    ${name}    REG_SZ    ${value}\r\n`, stderr: '' }
    }
    if (args[0] === 'DELETE') {
      const i = args.indexOf('/v')
      if (i >= 0) {
        const kk = `${args[1]}|${args[i + 1]}`
        if (!written.has(kk)) return { status: 1, stdout: '', stderr: 'ERROR: 找不到' }
        written.delete(kk)
        return { status: 0, stdout: '', stderr: '' }
      }
      const prefix = `${args[1]}|`
      const hit = [...written.keys()].filter((x) => {
        const keyPart = x.slice(0, x.lastIndexOf('|'))
        // 真实 reg.exe 的 `DELETE /f` 删整个子树
        return keyPart === args[1] || keyPart.startsWith(`${args[1]}\\`)
      })
      if (hit.length === 0) return { status: 1, stdout: '', stderr: 'ERROR: 找不到' }
      for (const x of hit) written.delete(x)
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { run, calls, written }
}

const plan = buildEditorRegistration({ exe: EXE, extensions: settings.extensions })
const has = (predicate: (op: (typeof plan.adds)[number]) => boolean): boolean => plan.adds.some(predicate)

describe('editorRegistry:注册内容', () => {
  it('「编辑」动词用 --edit,「打开方式」的 open 用普通参数', () => {
    expect(plan.editCommand).toBe(`"${EXE}" --edit "%1"`)
    expect(plan.openCommand).toBe(`"${EXE}" "%1"`)
    expect(has((o) => o.key.endsWith('bowEditor\\shell\\edit\\command') && o.data === plan.editCommand)).toBe(true)
    expect(has((o) => o.key.endsWith('bowEditor\\shell\\open\\command') && o.data === plan.editCommand)).toBe(true)
  })

  it('每个扩展名登记:候选 + 右键动词(含命令)+ 默认应用列表项 + SupportedTypes', () => {
    for (const ext of settings.extensions) {
      expect(has((o) => o.key === `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids` && o.name === 'bowEditor')).toBe(
        true
      )
      expect(
        has(
          (o) =>
            o.key === `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\bow-edit\\command` &&
            o.data === plan.editCommand
        )
      ).toBe(true)
      expect(has((o) => o.key === plan.capsKey && o.name === ext && o.data === 'bowEditor')).toBe(true)
      expect(has((o) => o.key.endsWith('Applications\\bow.exe\\SupportedTypes') && o.name === ext)).toBe(true)
    }
  })

  it('**只**注册成候选:不写 Classes\\.<ext> 的默认值,也不碰 RegisteredApplications', () => {
    expect(plan.adds.some((o) => /^HKCU\\Software\\Classes\\\.[a-z]+$/.test(o.key))).toBe(false)
    expect(plan.adds.some((o) => o.key === 'HKCU\\Software\\RegisteredApplications')).toBe(false)
  })

  it('撤销清单只含自己写的值与自己建的键', () => {
    expect(plan.deletes.keys).toContain('HKCU\\Software\\Classes\\bowEditor')
    expect(plan.deletes.keys).toContain('HKCU\\Software\\Classes\\Applications\\bow.exe')
    for (const ext of settings.extensions) {
      expect(plan.deletes.keys).toContain(`HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\bow-edit`)
      expect(plan.deletes.values).toContainEqual({
        key: `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`,
        name: 'bowEditor'
      })
    }
    // 不含别人的位置
    expect(plan.deletes.keys.some((key) => key === 'HKCU\\Software\\Classes\\SystemFileAssociations\\.txt')).toBe(false)
    expect(plan.deletes.keys).not.toContain('HKCU\\Software\\RegisteredApplications')
  })

  it('regLabel 能把三类键说成人话', () => {
    expect(regLabel({ key: 'HKCU\\Software\\Classes\\SystemFileAssociations\\.txt\\shell\\bow-edit\\command' })).toBe(
      '右键动词 .txt'
    )
    expect(regLabel({ key: 'HKCU\\Software\\Classes\\.md\\OpenWithProgids' })).toBe('打开方式候选 .md')
    expect(regLabel({ key: plan.capsKey, name: '.txt' })).toBe('默认应用列表 .txt')
  })
})

describe('editorRegistry:注册 / 撤销', () => {
  const deps = (reg: ReturnType<typeof fakeRegistry>, extra: Record<string, unknown> = {}) => ({
    platform: 'win32',
    execPath: EXE,
    isPackaged: true,
    runReg: reg.run,
    runPowerShell: noPS,
    ...extra
  })

  it('注册幂等:两次注册的写入集合一致,且自校验全过', () => {
    const reg = fakeRegistry()
    const first = registerEditor(deps(reg), settings)
    const afterFirst = new Set(reg.written.keys())
    const second = registerEditor(deps(reg), settings)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.log.some((l) => l.includes('已校验'))).toBe(true)
    expect(new Set(reg.written.keys())).toEqual(afterFirst)
  })

  it('某版 reg.exe 不收空 REG_NONE → 退化成空 REG_SZ,仍算成功', () => {
    const reg = fakeRegistry({ failNone: true })
    const result = registerEditor(deps(reg), settings)
    expect(result.ok).toBe(true)
    expect(result.log.some((l) => l.includes('REG_NONE'))).toBe(true)
  })

  it('撤销:自己的键/值没了,别人的默认值一个字不动,lastRegistered 清空', () => {
    const reg = fakeRegistry({ seed: { 'HKCU\\Software\\Classes\\.txt|': 'txtfile' } })
    registerEditor(deps(reg), settings)
    const result = unregisterEditor(deps(reg), settings)
    expect(result.ok).toBe(true)
    expect(result.settings?.lastRegistered).toEqual([])
    // 我们写的没了
    expect(reg.written.has('HKCU\\Software\\Classes\\bowEditor|')).toBe(false)
    expect(reg.written.has('HKCU\\Software\\Classes\\.txt\\OpenWithProgids|bowEditor')).toBe(false)
    expect(reg.written.has('HKCU\\Software\\Classes\\SystemFileAssociations\\.txt\\shell\\bow-edit|')).toBe(false)
    // 别人的默认值还在
    expect(reg.written.get('HKCU\\Software\\Classes\\.txt|')).toBe('txtfile')
  })

  it('改过扩展名清单再撤销:按 lastRegistered 删,旧的不残留', () => {
    const reg = fakeRegistry()
    registerEditor(deps(reg), settings) // 注册了 .txt/.md
    const smaller: EditorSettings = { ...settings, extensions: ['.txt'], lastRegistered: ['.txt', '.md'] }
    unregisterEditor(deps(reg), smaller)
    expect(reg.written.has('HKCU\\Software\\Classes\\.md\\OpenWithProgids|bowEditor')).toBe(false)
    expect(reg.written.has('HKCU\\Software\\Classes\\SystemFileAssociations\\.md\\shell\\bow-edit\\command|')).toBe(false)
  })

  it('非 Windows / 开发模式:明确拒绝而不是假装成功', () => {
    const reg = fakeRegistry()
    expect(registerEditor(deps(reg, { platform: 'linux' }), settings).ok).toBe(false)
    expect(registerEditor(deps(reg, { isPackaged: false }), settings).ok).toBe(false)
  })
})

describe('editorRegistry:状态', () => {
  it('注册前后 registered 分开报;UserChoice 指到我们 → isDefault', () => {
    const reg = fakeRegistry()
    const before = editorStatus(
      { platform: 'win32', execPath: EXE, isPackaged: true, runReg: reg.run, runPowerShell: noPS },
      settings
    )
    expect(before.registered).toBe(false)
    expect(before.targets.map((t) => t.ext)).toEqual(['.txt', '.md'])
    expect(before.targets.every((t) => !t.isDefault)).toBe(true)

    registerEditor({ platform: 'win32', execPath: EXE, isPackaged: true, runReg: reg.run, runPowerShell: noPS }, settings)
    // 用户去系统设置里把 .txt 选成 bow(模拟 UserChoice)
    reg.written.set('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.txt\\UserChoice|ProgId', 'bowEditor')
    const after = editorStatus(
      { platform: 'win32', execPath: EXE, isPackaged: true, runReg: reg.run, runPowerShell: noPS },
      settings
    )
    expect(after.registered).toBe(true)
    expect(after.misses).toEqual([])
    expect(after.targets.find((t) => t.ext === '.txt')).toMatchObject({ isDefault: true, effective: 'bowEditor' })
    expect(after.targets.find((t) => t.ext === '.md')?.isDefault).toBe(false)
  })

  it('实际生效的程序(AssocQueryString)与修法都带出来', () => {
    const reg = fakeRegistry({ seed: { 'HKCU\\Software\\Classes\\.txt|': 'txtfile' } })
    const st = editorStatus(
      {
        platform: 'win32',
        execPath: EXE,
        isPackaged: true,
        runReg: reg.run,
        runPowerShell: () => ({ status: 0, stdout: '.txt|C:\\Windows\\notepad.exe\r\n', stderr: '' })
      },
      settings
    )
    const txt = st.targets.find((t) => t.ext === '.txt')
    expect(txt).toMatchObject({ effective: 'txtfile', actualExe: 'C:\\Windows\\notepad.exe', isDefault: false })
    expect(txt?.source).toContain('HKCU\\Software\\Classes\\.txt → (默认值)')
    expect(txt?.fix).toContain('打开方式')
  })

  it('开发模式给出 error,非 Windows 给出说明', () => {
    const reg = fakeRegistry()
    const dev = editorStatus(
      { platform: 'win32', execPath: EXE, isPackaged: false, runReg: reg.run, runPowerShell: noPS },
      settings
    )
    expect(dev.error).toContain('npm run dist')
    const linux = editorStatus(
      { platform: 'linux', execPath: '/usr/bin/bow', isPackaged: true, runReg: reg.run, runPowerShell: noPS },
      settings
    )
    expect(linux.notes.some((n) => n.includes('当前不是 Windows'))).toBe(true)
  })
})
