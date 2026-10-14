/**
 * 编辑器注册的 I/O 编排(`status` / `register` / `unregister`)。**只在 Windows 上有意义**,
 * 其它平台直接返回 `supported: false` 的说明性状态 —— Linux 侧的桌面关联不在本次范围内
 * (要做时照 `plugins/default-browser/linuxDesktop.ts` 的形状来)。
 *
 * 三条与默认浏览器插件相同的纪律:
 * 1. **幂等**:重复注册不报错(全部 `reg add /f`);
 * 2. **写完自查**:逐条 `reg query`,把没落地的列出来,而不是只说一句「成功」;
 * 3. **撤销只删自己写的**:删除清单来自注册计划,而且「注册时写了哪些扩展名」记在
 *    `settings.lastRegistered` —— 否则用户改过清单再撤销,旧的那批会永远留在注册表里。
 *
 * 所有 I/O 都走可注入的 `deps`(reg.exe / PowerShell / 平台),所以能在 Linux 上单测 Windows 分支
 * (用假注册表),见 `tests/editorRegistry.test.ts`。
 */

import { spawnSync } from 'node:child_process'
import { WINDOWS_MANUAL_STEPS } from './shared'
import type { EditorSettings, EditorStatus, EditorTargetState } from './shared'
import { buildEditorRegistration, regLabel } from './windowsRegistry'
import type { EditorRegistrationPlan } from './windowsRegistry'
import {
  buildAssocProbeScript,
  parseAssocProbeOutput,
  parseRegQueryFirstValue,
  parseRegQueryValue,
  regAddArgs,
  regDeleteKeyArgs,
  regDeleteValueArgs,
  regQueryArgs,
  userChoiceQueryArgs
} from '../../main/plugins/registryOps'
import type { RegResult, RunReg } from '../../main/plugins/registryOps'
import { fileUserChoiceTargets } from '../default-browser/windowsRegistry'
import type { UserChoiceTarget } from '../default-browser/windowsRegistry'

export interface EditorRegistrationDeps {
  platform?: string
  /** `process.execPath`(打包后是 bow.exe;dev 是 electron.exe) */
  execPath?: string
  isPackaged?: boolean
  runReg?: RunReg
  runPowerShell?: (script: string) => RegResult
}

interface Resolved {
  platform: string
  execPath: string
  isPackaged: boolean
  runReg: RunReg
  runPowerShell: (script: string) => RegResult
}

export interface EditorRegistrationResult {
  ok: boolean
  log: string[]
  /** 注册/撤销需要持久化的设置变化(目前只有 `lastRegistered`) */
  settings?: Partial<EditorSettings>
}

function resolve(deps: EditorRegistrationDeps): Resolved {
  const runReg: RunReg =
    deps.runReg ??
    ((args) => {
      const res = spawnSync('reg.exe', args, { encoding: 'utf-8', windowsHide: true })
      return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
    })
  const runPowerShell: (script: string) => RegResult =
    deps.runPowerShell ??
    ((script) => {
      // -NoProfile / -NonInteractive:用户的 profile 不该影响探测;`-` 从 stdin 读脚本,免去转义地狱
      const res = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        { input: script, encoding: 'utf-8', windowsHide: true }
      )
      return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
    })
  return {
    platform: deps.platform ?? process.platform,
    execPath: deps.execPath ?? process.execPath,
    isPackaged: deps.isPackaged ?? true,
    runReg,
    runPowerShell
  }
}

/** 生效的扩展名清单:注册按**当前设置**,撤销按 `lastRegistered`(可能已经被用户改小) */
function extensionsForRegister(settings: EditorSettings): string[] {
  return settings.extensions
}

function extensionsForUnregister(settings: EditorSettings): string[] {
  // 并集:`lastRegistered` 管「改小清单后撤销」,当前清单管「设置文件被重置/从旧版本升级上来」(它为空)
  const out: string[] = []
  for (const ext of [...settings.lastRegistered, ...settings.extensions]) if (!out.includes(ext)) out.push(ext)
  return out
}

/**
 * 查某一类扩展名「当前归谁」:UserChoice 优先,其次回落 `HKCU\Software\Classes` / `HKLM\…`
 * 的默认值(HKCR 合并顺序)。`source` 会带到界面上 —— 下次再有人怀疑「读错位置」,看一眼就知道。
 */
function probeTarget(r: Resolved, t: UserChoiceTarget): { value: string | null; source?: string } {
  for (const key of [t.key, ...(t.alternateKeys ?? [])]) {
    const res = r.runReg(userChoiceQueryArgs({ key }))
    if (res.status !== 0) continue
    const value = parseRegQueryValue(res.stdout, 'ProgId')
    if (value !== null) return { value, source: `${key} → ProgId` }
  }
  for (const key of t.legacyKeys ?? []) {
    const res = r.runReg(['QUERY', key, '/ve'])
    if (res.status !== 0) continue
    const value = parseRegQueryFirstValue(res.stdout)
    if (value) return { value, source: `${key} → (默认值)` }
  }
  return { value: null }
}

/** 实际会用哪个程序(AssocQueryString);拿不到返回空对象,调用方退化为只看记录 */
function probeEffective(r: Resolved, exts: readonly string[]): Record<string, string> {
  if (r.platform !== 'win32') return {}
  const script = buildAssocProbeScript(exts.map((ext) => ({ id: ext })))
  const res = r.runPowerShell(script)
  if (!res || res.status !== 0) return {}
  return parseAssocProbeOutput(res.stdout)
}

/**
 * 当前状态。「注册了没有」与「系统当前是不是交给我」分开报 —— 这正是默认浏览器插件踩过的坑:
 * 只查自己的键只能知道注册没注册。
 */
export function editorStatus(deps: EditorRegistrationDeps, settings: EditorSettings): EditorStatus {
  const r = resolve(deps)
  const exts = settings.lastRegistered.length > 0 ? settings.lastRegistered : settings.extensions
  const plan = buildEditorRegistration({ exe: r.execPath, extensions: exts })
  // 非 Windows 没有任何注册表可查:跳过全部 reg.exe / PowerShell 调用。
  // (不跳的话在 Linux/mac 上会白跑上百次 spawnSync —— 实测 80 次就要 3 秒,设置页会卡住)
  const windows = r.platform === 'win32'

  // 「注册了没有」先查一条(ProgID 的默认值);命中才逐条核对其它键 —— 没注册时不白查 2N 次
  const registered = windows && r.runReg(regQueryArgs(plan.probes[0])).status === 0
  const misses = registered ? plan.probes.filter((op) => r.runReg(regQueryArgs(op)).status !== 0).map(regLabel) : []
  const effective = windows ? probeEffective(r, exts) : {}
  const targets: EditorTargetState[] = fileUserChoiceTargets(exts, plan.progId).map((t) => {
    const probed = windows ? probeTarget(r, t) : { value: null as string | null }
    const actualExe = effective[t.id]
    const isDefault = probed.value === plan.progId
    return {
      ext: t.id,
      effective: probed.value,
      ...(probed.source ? { source: probed.source } : {}),
      ...(actualExe ? { actualExe } : {}),
      isDefault,
      fix: `右键任意 ${t.id} 文件 → 打开方式 → 选择其它应用 → bow → 勾「始终使用此应用打开 ${t.id} 文件」`
    }
  })

  const notes: string[] = [
    'Windows 只允许把 bow 注册成候选 + 加一个「编辑」动词,默认关联必须你在「设置 → 默认应用」里点一次',
    'Win11 的传统右键动词落在「显示更多选项」里(主菜单需要 MSIX 打包的 shell 扩展,本插件不做)'
  ]
  if (!windows) notes.push('当前不是 Windows,注册功能不可用(上面的「系统当前交给谁」也就没得查)')
  if (Object.keys(effective).length === 0) {
    notes.push('没能调起系统关联查询(PowerShell 不可用或被策略拦下),上面的状态仅依据注册表记录')
  }
  let error: string | undefined
  if (r.platform === 'win32' && !r.isPackaged) {
    error = '开发模式没有稳定的 bow.exe 可注册:先 `npm run dist` 打包,再用打包版执行注册'
  }

  return {
    platform: r.platform,
    exe: r.execPath,
    registered,
    registeredExtensions: exts,
    targets,
    misses,
    steps: WINDOWS_MANUAL_STEPS,
    notes,
    ...(error ? { error } : {})
  }
}

/** 注册:`reg add` 全量写入 + 逐条自查;返回 `lastRegistered`(撤销要按它删) */
export function registerEditor(deps: EditorRegistrationDeps, settings: EditorSettings): EditorRegistrationResult {
  const r = resolve(deps)
  const log: string[] = []
  if (r.platform !== 'win32') {
    return { ok: false, log: ['只有 Windows 需要注册(其它平台无需这一步)'] }
  }
  if (!r.isPackaged) {
    return { ok: false, log: ['开发模式不支持注册:先 `npm run dist` 打包,再用打包版注册'] }
  }

  const extensions = extensionsForRegister(settings)
  const plan = buildEditorRegistration({ exe: r.execPath, extensions })
  let failed = 0
  for (const op of plan.adds) {
    const res = r.runReg(regAddArgs(op))
    if (res.status === 0) continue
    // 某些 Windows 的 reg.exe 不接受 `/t REG_NONE /d ""`(OpenWithProgids / SupportedTypes 用的就是它),
    // 退化成空 REG_SZ —— 系统同样接受候选登记,只是值的类型标记不同。
    if (op.type === 'REG_NONE' && r.runReg(regAddArgs({ ...op, type: 'REG_SZ' })).status === 0) {
      log.push(`· ${regLabel(op)}:该版本的 reg.exe 不收空 REG_NONE,已用空 REG_SZ 代替`)
      continue
    }
    failed += 1
    log.push(`✗ 写入失败:${regLabel(op)}${res.stderr.trim() ? ` (${res.stderr.trim()})` : ''}`)
  }

  const misses = plan.adds.filter((op) => r.runReg(regQueryArgs(op)).status !== 0).map(regLabel)
  if (misses.length === 0) log.push(`✅ ${plan.adds.length} 条注册表写入已校验(reg query 全部命中)`)
  else log.push(`✗ 有 ${misses.length} 条没落地:${misses.slice(0, 5).join('、')}${misses.length > 5 ? ' …' : ''}`)

  log.push(`· 已登记 ${extensions.length} 个扩展名;最后一步请在系统里点一次(见下方步骤)`)
  return {
    ok: failed === 0 && misses.length === 0,
    log,
    settings: { lastRegistered: extensions }
  }
}

/** 撤销:删自己写的值与自己建的键(按 `lastRegistered`,不是当前清单) */
export function unregisterEditor(
  deps: EditorRegistrationDeps,
  settings: EditorSettings
): EditorRegistrationResult {
  const r = resolve(deps)
  const log: string[] = []
  if (r.platform !== 'win32') return { ok: false, log: ['只有 Windows 有注册表可撤'] }

  const extensions = extensionsForUnregister(settings)
  const plan = buildEditorRegistration({ exe: r.execPath, extensions })
  let removed = 0

  for (const { key, name } of plan.deletes.values) {
    if (r.runReg(regDeleteValueArgs({ key, name })).status === 0) removed += 1
  }
  for (const key of plan.deletes.keys) {
    if (r.runReg(regDeleteKeyArgs(key)).status === 0) removed += 1
  }

  if (extensions.length === 0) {
    log.push('· 没有记录过注册过的扩展名(可能没注册过):只撤了 ProgID / 应用条目这两个整键')
  }
  log.push(`· 撤销清单 = lastRegistered ∪ 当前清单,共 ${extensions.length} 个扩展名`)
  log.push(
    removed === 0
      ? '没删到任何键(可能本来就没注册)'
      : `✅ 已删掉 ${removed} 项(自己的 ProgID、右键动词、候选登记、默认应用列表项)`
  )
  log.push('· 没动别人的键:`Classes\\.<ext>` 的默认值、`RegisteredApplications\\bow` 都不是我们写的')
  log.push('· 系统「默认应用」里可能仍显示 bow(直到你改掉那一项),这是正常的:我们只撤注册')
  return { ok: true, log, settings: { lastRegistered: [] } }
}

/** 计划内容(设置页可回显要写哪些键;不执行) */
export function editorPlanFor(deps: EditorRegistrationDeps, settings: EditorSettings): EditorRegistrationPlan {
  const r = resolve(deps)
  return buildEditorRegistration({ exe: r.execPath, extensions: settings.extensions })
}
