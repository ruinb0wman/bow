/**
 * 默认浏览器注册:平台分发 + I/O 编排(status / register / unregister)。
 *
 * 两条平台路线完全不同,但对外只暴露同一组结果:
 * - **Linux**:写 `~/.local/bin/bow` 包装脚本(dev)/ 直接用真实二进制(打包)+
 *   `~/.local/share/applications/<appId>.desktop` + `~/.config/mimeapps.list` 默认关联;
 * - **Windows**:写 HKCU 注册表把 bow 注册成**候选**(系统不让程序自设默认)。
 *
 * 「注册了没有」与「系统当前选的是不是我」是两件事,所以状态里分开报:
 * - `registered`:我们的文件 / 键在不在;
 * - `isDefault`:系统**当前**把每一类交给谁(Windows 读 UserChoice,Linux 读 mimeapps)。
 *
 * 所有 I/O 都走可注入的 `deps`(fs / runReg / 路径),所以能在 Linux 上单测 Windows 分支,
 * 也能在测试里用假 fs 跑完整注册流程。单测见 `tests/defaultBrowser.test.ts`。
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { APP_DESKTOP_NAME, BROWSER_NAME } from '@shared/ua'
import type { DesktopActionResult, DesktopStatus, DesktopTarget, DesktopTargetState } from './shared'
import * as linux from './linuxDesktop'
import * as win from './windowsRegistry'

export type RegResult = {
  status: number | null
  stdout: string
  stderr: string
}

export interface FsLike {
  existsSync(path: string): boolean
  readFileSync(path: string): string | null
  writeFileSync(path: string, data: string, mode: number): void
  mkdirSync(path: string): void
  copyFileSync(from: string, to: string): void
  rmSync(path: string): void
}

export interface RegistrationDeps {
  platform?: string
  home?: string
  /** dev 模式:仓库根目录(包装脚本要指到它);打包模式下不用 */
  repoRoot?: string
  /** `process.execPath`:打包后是 bow 二进制,dev 是 node_modules 里的 electron */
  execPath?: string
  isPackaged?: boolean
  env?: NodeJS.ProcessEnv
  fs?: FsLike
  runReg?: (args: string[]) => RegResult
  /** 跑一段 PowerShell(默认 powershell.exe,退到 pwsh);用于 AssocQueryString 实际关联探测 */
  runPowerShell?: (script: string) => RegResult
  /** 唤醒外部程序打开 URI / 设置页(Windows:默认应用设置页);返回是否真的叫醒了 */
  openExternal?: (target: string) => boolean
}


/** Linux 上的固定路径(全是用户级,不需要 root) */
function linuxPaths(r: Resolved) {
  const desktopId = `${APP_DESKTOP_NAME}.desktop`
  return {
    desktopId,
    applicationsDir: join(r.home, '.local', 'share', 'applications'),
    desktopPath: join(r.home, '.local', 'share', 'applications', desktopId),
    mimeappsPath: join(r.home, '.config', 'mimeapps.list'),
    backupPath: join(r.home, '.config', 'mimeapps.list.bow.bak'),
    binDir: join(r.home, '.local', 'bin'),
    wrapperPath: join(r.home, '.local', 'bin', BROWSER_NAME)
  }
}

interface Resolved {
  platform: string
  home: string
  repoRoot: string
  execPath: string
  isPackaged: boolean
  env: NodeJS.ProcessEnv
  fs: FsLike
  runReg: (args: string[]) => RegResult
  runPowerShell: (script: string) => RegResult
  openExternal: (target: string) => boolean
}

function nodeFs(): FsLike {
  return {
    existsSync,
    readFileSync: (p) => {
      try {
        return readFileSync(p, 'utf-8')
      } catch {
        return null
      }
    },
    writeFileSync: (p, data, mode) => {
      writeFileSync(p, data, 'utf-8')
      chmodSync(p, mode)
    },
    mkdirSync: (p) => {
      mkdirSync(p, { recursive: true })
    },
    copyFileSync,
    rmSync: (p) => {
      rmSync(p, { force: true })
    }
  }
}

function realRunReg(args: string[]): RegResult {
  const r = spawnSync('reg.exe', args, { encoding: 'utf-8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 跑 PowerShell 脚本(Windows 上 powershell.exe;装了 PowerShell 7 就试 pwsh) */
function realRunPowerShell(script: string): RegResult {
  // 该探测只在 Windows 上有意义:非 Windows 直接报“不可用”,绝不 spawn 任何东西
  if (process.platform !== 'win32') return { status: null, stdout: '', stderr: 'AssocQueryString 仅 Windows 可用' }
  const common = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]
  let last: RegResult = { status: null, stdout: '', stderr: 'PowerShell 不可用' }
  for (const exe of ['powershell.exe', 'pwsh.exe', 'pwsh']) {
    const r = spawnSync(exe, common, { encoding: 'utf-8', timeout: 20_000, windowsHide: true })
    if (r.error) {
      last = { status: null, stdout: r.stdout ?? '', stderr: String(r.error) }
      continue
    }
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  return last
}

/**
 * 唤醒外部程序打开一个设置页 URI(不经过 shell,不等它退出)。
 * Windows 先试 `explorer.exe ms-settings:…`,再退到 `cmd /c start`。
 */
function realOpenExternal(target: string): boolean {
  const attempts: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [
          ['explorer.exe', [target]],
          ['cmd.exe', ['/c', 'start', '', target]]
        ]
      : process.platform === 'darwin'
        ? [['open', [target]]]
        : [['xdg-open', [target]]]
  for (const [cmd, args] of attempts) {
    try {
      const child = spawnSync(cmd, args, { windowsHide: true, timeout: 5000 })
      if (!child.error) return true
    } catch {
      // 试下一个
    }
  }
  return false
}

function resolve(deps: RegistrationDeps = {}): Resolved {
  const platform = deps.platform ?? process.platform
  return {
    platform,
    home: deps.home ?? homedir(),
    repoRoot: deps.repoRoot ?? process.cwd(),
    execPath: deps.execPath ?? process.execPath,
    isPackaged: deps.isPackaged ?? false,
    env: deps.env ?? process.env,
    fs: deps.fs ?? nodeFs(),
    runReg: deps.runReg ?? realRunReg,
    runPowerShell: deps.runPowerShell ?? realRunPowerShell,
    openExternal: deps.openExternal ?? realOpenExternal
  }
}

// ---------------------------------------------------------------- 状态

export function desktopStatus(deps: RegistrationDeps = {}): DesktopStatus {
  const r = resolve(deps)
  if (r.platform === 'linux') return linuxStatus(r)
  if (r.platform === 'win32') return windowsStatus(r)
  return {
    platform: 'other',
    supported: false,
    canRegister: false,
    mode: r.isPackaged ? 'packaged' : 'dev',
    exec: r.execPath,
    desktopId: `${APP_DESKTOP_NAME}.desktop`,
    registered: false,
    isDefault: false,
    targets: [],
    notes: [],
    manualSteps: [],
    error: `暂不支持 ${r.platform}:macOS 需要 .app 包 + LSSetDefaultHandlerForURLScheme,还没做。`
  }
}

// ---------------------------------------------------------------- 注册 / 撤销

export function registerDesktop(deps: RegistrationDeps = {}): DesktopActionResult {
  const r = resolve(deps)
  const log: string[] = []
  try {
    if (r.platform === 'linux') linuxRegister(r, log)
    else if (r.platform === 'win32') windowsRegister(r, log)
    else log.push('当前平台不支持注册')
  } catch (e) {
    log.push(`✗ ${e instanceof Error ? e.message : String(e)}`)
  }
  return { status: desktopStatus(deps), log }
}

export function unregisterDesktop(deps: RegistrationDeps = {}): DesktopActionResult {
  const r = resolve(deps)
  const log: string[] = []
  try {
    if (r.platform === 'linux') linuxUnregister(r, log)
    else if (r.platform === 'win32') windowsUnregister(r, log)
    else log.push('当前平台不支持撤销')
  } catch (e) {
    log.push(`✗ ${e instanceof Error ? e.message : String(e)}`)
  }
  return { status: desktopStatus(deps), log }
}

/**
 * 打开系统的「默认应用」设置页。
 * 只有 Windows 能程序化跳转(`ms-settings:defaultapps`);其余平台返回一句人话 ——
 * Linux 上默认关联就是本插件写的那几行,没有需要手动点的系统页。
 */
export function openPlatformSettings(deps: RegistrationDeps = {}): { ok: boolean; message: string } {
  const r = resolve(deps)
  if (r.platform !== 'win32') {
    return { ok: false, message: '当前平台没有等价的系统设置页;Linux 上默认关联就是本插件写的那几行,点「注册」即可' }
  }
  const ok = r.openExternal('ms-settings:defaultapps')
  return ok
    ? { ok: true, message: '已打开系统「默认应用」设置页:把 http、https、.html、.htm、.xhtml 逐项都选成 bow' }
    : { ok: false, message: '打不开系统设置页,请手动进入:设置 → 应用 → 默认应用' }
}

// ---------------------------------------------------------------- Linux

/** dev 模式没有安装位置 → 用 `~/.local/bin/bow` 包装脚本代替 */
function linuxExec(r: Resolved): { exec: string; mode: 'dev' | 'packaged' } {
  if (r.isPackaged) return { exec: r.execPath, mode: 'packaged' }
  return { exec: linuxPaths(r).wrapperPath, mode: 'dev' }
}

function linuxStatus(r: Resolved): DesktopStatus {
  const p = linuxPaths(r)
  const text = r.fs.readFileSync(p.mimeappsPath)
  const defaults = text ? linux.parseDefaults(text) : {}
  const { exec, mode } = linuxExec(r)

  const targets: DesktopTarget[] = linux.DEFAULT_MIME_TYPES.map((type) => {
    const current = defaults[type] ?? null
    const state: DesktopTargetState = current === null ? 'unset' : linux.valueTargetsUs(current, p.desktopId) ? 'default' : 'other'
    return {
      id: type,
      label: MIME_LABELS[type] ?? type,
      state,
      current,
      source: `${p.mimeappsPath} → [Default Applications] ${type}`,
      fix: '点上面的「注册为默认浏览器 / 更新注册」即可(需要先关掉别处占用该类型的设置)'
    }
  })

  const desktopExists = r.fs.existsSync(p.desktopPath)
  const wrapperExists = r.fs.existsSync(p.wrapperPath)

  const notes: string[] = []
  if (mode === 'dev') {
    notes.push(
      `开发模式:注册的是包装脚本 ~/.local/bin/bow → ${r.execPath} ${r.repoRoot}(打包版会直接指向 bow 二进制)`
    )
  }
  if (!whichInPath('xdg-open', r.env)) {
    notes.push('系统里没有 xdg-utils:bow 自己能被直接调用,但别的程序用 xdg-open 拉浏览器会失败(装 xdg-utils 可解)')
  }

  return {
    platform: 'linux',
    supported: true,
    canRegister: true,
    mode,
    exec,
    desktopId: p.desktopId,
    registered: desktopExists || wrapperExists,
    isDefault: targets.length > 0 && targets.every((t) => t.state === 'default'),
    targets,
    notes,
    manualSteps: []
  }
}

function linuxRegister(r: Resolved, log: string[]): void {
  const p = linuxPaths(r)
  const { exec, mode } = linuxExec(r)

  if (mode === 'dev') {
    writeIfChanged(
      r,
      p.wrapperPath,
      linux.wrapperScriptContent({ electronPath: r.execPath, appPath: r.repoRoot }),
      0o755,
      log,
      p.binDir
    )
  }
  writeIfChanged(
    r,
    p.desktopPath,
    linux.desktopFileContent({ exec, desktopName: APP_DESKTOP_NAME }),
    0o644,
    log,
    p.applicationsDir
  )

  const existed = r.fs.existsSync(p.mimeappsPath)
  const before = r.fs.readFileSync(p.mimeappsPath) ?? ''
  const entries = Object.fromEntries(linux.DEFAULT_MIME_TYPES.map((t) => [t, `${p.desktopId};`]))
  const { text, previous } = linux.upsertDefaults(before, entries)
  const changed = !existed || text !== before

  // 只在真要改动时才备份 —— 幂等的重复注册不该产生任何副作用
  if (changed && existed && !r.fs.existsSync(p.backupPath)) {
    r.fs.copyFileSync(p.mimeappsPath, p.backupPath)
    log.push(`· 已备份 ${p.mimeappsPath} → ${p.backupPath}`)
  }
  for (const [key, value] of Object.entries(entries)) {
    const old = previous[key]
    if (old && old.trim() && !linux.valueTargetsUs(old, p.desktopId)) {
      log.push(`· ${key}: ${old} → ${value}(原默认应用被覆盖)`)
    }
  }
  // mimeapps.list 是桌面环境与其它应用共享的文件 → own: false,不套「非我方文件拒绝覆盖」
  writeIfChanged(r, p.mimeappsPath, text, 0o644, log, dirname(p.mimeappsPath), { own: false })

  log.push(`✅ 已注册为默认浏览器(${mode === 'dev' ? '开发模式包装脚本' : '当前二进制'})`)
}

function linuxUnregister(r: Resolved, log: string[]): void {
  const p = linuxPaths(r)
  let touched = false

  for (const [path, what] of [
    [p.desktopPath, '桌面条目'],
    [p.wrapperPath, '包装脚本']
  ] as const) {
    const content = r.fs.readFileSync(path)
    if (content === null) continue
    if (!linux.hasMarker(content)) {
      log.push(`· 跳过 ${path}:不是 bow 生成的(缺少标记),不动别人的文件`)
      continue
    }
    r.fs.rmSync(path)
    log.push(`· 已删除${what} ${path}`)
    touched = true
  }

  const before = r.fs.readFileSync(p.mimeappsPath)
  if (before !== null) {
    const { text, removed } = linux.removeFromDefaults(before, p.desktopId)
    if (removed.length > 0 && text !== before) {
      r.fs.writeFileSync(p.mimeappsPath, text, 0o644)
      log.push(`· 已撤掉默认关联:${removed.join(', ')}`)
      touched = true
    }
  }

  log.push(touched ? '✅ 已撤销注册' : '✅ 无需撤销(没有找到 bow 的注册痕迹)')
  if (r.fs.existsSync(p.backupPath)) log.push(`· 原始 mimeapps.list 备份仍在 ${p.backupPath}`)
}

/** 写文件;内容一致就只记一行「未变化」(幂等) */
function writeIfChanged(
  r: Resolved,
  path: string,
  content: string,
  mode: number,
  log: string[],
  dir: string,
  /** own = 这个文件完全归 bow 管(desktop / 包装脚本);共享文件(mimeapps.list)不适用标记守卫 */
  { own = true }: { own?: boolean } = {}
): void {
  const old = r.fs.readFileSync(path)
  if (old === content) {
    log.push(`· ${path} 未变化`)
    return
  }
  if (own && old !== null && !linux.hasMarker(old)) {
    throw new Error(`${path} 已存在且不是 bow 生成的,拒绝覆盖(请先自行处理)`)
  }
  r.fs.mkdirSync(dir)
  r.fs.writeFileSync(path, content, mode)
  log.push(`· 已写入 ${path}${old !== null ? '(覆盖)' : '(新建)'}`)
}

// ---------------------------------------------------------------- Windows

function windowsStatus(r: Resolved): DesktopStatus {
  const plan = win.buildWindowsRegistration({ exe: r.execPath })
  const declared = win.userChoiceTargets({ appName: BROWSER_NAME })
  const effective = probeEffectiveHandlers(r, declared)
  const ourStem = win.exeStem(r.execPath)

  const targets: DesktopTarget[] = declared.map((t) => {
    const probe = probeWindowsTarget(r, t)
    let state: DesktopTargetState =
      probe.value === null ? 'unset' : probe.value === t.expect ? 'default' : 'other'

    // 实际生效者(AssocQueryString)优先于记录:那才是双击文件时真正发生的事。
    // 两者冲突时说明 UserChoice 的 Hash 已失效、被系统忽略(实测:记录写 Firefox、双击却是 bow)。
    const effStem = effective[t.id] ? win.exeStem(effective[t.id]) : undefined
    const actualSaysUs = effStem ? effStem === ourStem : undefined
    let effectiveLabel: string | undefined
    let effectivePath: string | undefined
    let fix = winTargetFix(t)
    if (actualSaysUs !== undefined && actualSaysUs !== (state === 'default')) {
      state = actualSaysUs ? 'default' : 'other'
      effectiveLabel = actualSaysUs ? 'bow' : effStem
      effectivePath = effective[t.id]
      fix = actualSaysUs
        ? `系统记录里那条「${probe.value ?? '—'}」已被 Windows 忽略(Hash 失效),实际生效的是 bow。建议在「默认应用」里把这一项重新选一次 bow 以刷新记录。`
        : `记录写着 bow,但实际生效的是 ${effStem};建议在「默认应用」里重新选一次 bow。`
    }

    // 非默认时把人话名挂在“真正在用的那个”上
    const owner = state === 'other' ? (effStem ?? probe.value) : null
    const currentLabel = owner ? win.friendlyProgId(owner) : undefined

    return {
      id: t.id,
      label: t.label,
      state,
      current: probe.value,
      ...(currentLabel ? { currentLabel } : {}),
      ...(effectiveLabel ? { effective: effectiveLabel } : {}),
      ...(effectivePath ? { effectivePath } : {}),
      source: probe.source,
      fix
    }
  })

  const registered = r.runReg(win.regQueryArgs(plan.adds[0])).status === 0
  const notes: string[] = [
    'Windows 只允许把 bow 注册成候选,默认关联必须你在「设置 → 默认应用」里点一次(系统不允许程序代改)',
    'Windows 判定「默认浏览器」看的是 .htm(l) 文件 + http(s) 协议这几项,所以任何一项落在别人手里都会与系统设置页显示不一致'
  ]
  if (Object.keys(effective).length === 0) {
    notes.push('没能调起系统关联查询(PowerShell 不可用或被策略拦下),下面的状态仅依据注册表记录')
  }
  let error: string | undefined
  if (!r.isPackaged) {
    error = '开发模式没有稳定的 bow.exe 可注册:先 `npm run dist` 打包,再用打包版执行注册'
  }

  return {
    platform: 'win32',
    supported: true,
    canRegister: r.isPackaged,
    mode: r.isPackaged ? 'packaged' : 'dev',
    exec: r.execPath,
    desktopId: `${APP_DESKTOP_NAME}.desktop`,
    registered,
    isDefault: targets.length > 0 && targets.every((t) => t.state === 'default'),
    targets,
    notes,
    manualSteps: win.WINDOWS_MANUAL_STEPS,
    ...(error ? { error } : {})
  }
}

/**
 * 调 Windows 自己的 `AssocQueryString` 拿到「实际会用哪个程序打开」
 * (`<id>` → exe 路径)。拿不到就返回空对象,调用方退化为只依据记录。
 */
function probeEffectiveHandlers(r: Resolved, targets: win.UserChoiceTarget[]): Record<string, string> {
  if (r.platform !== 'win32') return {}
  const script = win.buildAssocProbeScript(targets.map((t) => ({ id: t.id })))
  const res = r.runPowerShell(script)
  if (!res || res.status !== 0) return {}
  return win.parseAssocProbeOutput(res.stdout)
}

/**
 * 查某一类目标「当前归谁」:UserChoice(主键→备用键)优先,
 * 其次回落 `HKCU\Software\Classes` / `HKLM\Software\Classes` 的默认值(HKCR 合并顺序)。
 * `source` 会一路带到界面上 —— 下次再有人怀疑「读错位置了」,看一眼就知道查的是哪个键。
 */
function probeWindowsTarget(
  r: Resolved,
  t: win.UserChoiceTarget
): { value: string | null; source?: string } {
  for (const key of [t.key, ...(t.alternateKeys ?? [])]) {
    const res = r.runReg(win.userChoiceQueryArgs({ ...t, key }))
    if (res.status !== 0) continue
    const value = win.parseRegQueryValue(res.stdout, 'ProgId')
    if (value !== null) return { value, source: `${key} → ProgId` }
  }
  for (const key of t.legacyKeys ?? []) {
    const res = r.runReg(['QUERY', key, '/ve'])
    if (res.status !== 0) continue
    const value = win.parseRegQueryFirstValue(res.stdout)
    if (value) return { value, source: `${key} → (默认值)` }
  }
  return { value: null }
}

/** 非默认时给用户的针对性修法(协议与文件的操作路径不一样) */
function winTargetFix(t: win.UserChoiceTarget): string {
  if (t.kind === 'protocol') {
    return `设置 → 默认应用 → bow → 把「${t.id}」这项单独点成 bow(UserChoice 带 Hash 保护,只有系统设置页能改;只点顶部的「设为默认值」按钮在 Win11 上常常只改第一项)`
  }
  return `右键任意 ${t.id} 文件 → 打开方式 → 选择其它应用 → bow → 勾「始终使用此应用打开 ${t.id} 文件」`
}

function windowsRegister(r: Resolved, log: string[]): void {
  if (!r.isPackaged) throw new Error('开发模式不支持注册:先 `npm run dist` 打包,再用打包版注册')
  const plan = win.buildWindowsRegistration({ exe: r.execPath })
  let failed = 0

  for (const op of plan.adds) {
    const res = r.runReg(win.regAddArgs(op))
    if (res.status === 0) continue
    // 某些 Windows 的 reg.exe 不接受 `/t REG_NONE /d ""`(OpenWithProgids / SupportedTypes 用的就是它),
    // 退化成空 REG_SZ —— 系统同样接受候选登记,只是值的类型标记不同。
    if (op.type === 'REG_NONE' && r.runReg(win.regAddArgs({ ...op, type: 'REG_SZ' })).status === 0) {
      log.push(`· ${regLabel(op)}:该版本的 reg.exe 不收空 REG_NONE,已用空 REG_SZ 代替`)
      continue
    }
    failed += 1
    log.push(`✗ 写入失败:${regLabel(op)}${res.stderr.trim() ? ` (${res.stderr.trim()})` : ''}`)
  }

  // 写完自查:逐条 reg query,把没落地的列出来(而不是只说一句「成功」)
  const missing = plan.adds.filter((op) => r.runReg(win.regQueryArgs(op)).status !== 0).map(regLabel)
  if (missing.length === 0) log.push(`✅ ${plan.adds.length} 条注册表写入已校验(reg query 全部命中)`)
  else log.push(`✗ 有 ${missing.length} 条没落地:${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' …' : ''}`)

  log.push('⚠ 最后一步请在系统里点一次(见下方步骤),否则默认关联不会变')
  if (failed > 0 || missing.length > 0) {
    throw new Error(`注册未完成:${failed} 条写入失败、${missing.length} 条未通过自校验`)
  }
}

function windowsUnregister(r: Resolved, log: string[]): void {
  const plan = win.buildWindowsRegistration({ exe: r.execPath })
  let removed = 0
  for (const { key, name } of plan.deletes.values) {
    if (r.runReg(win.regDeleteValueArgs({ key, name })).status === 0) removed += 1
  }
  // 带条件的值(传统回落 `Software\Classes\.<ext>` 的默认值):先核对是不是我们写的,
  // 是别人写的就留着 —— 撤销注册不该把别的程序设的关联顺手删了。
  for (const { key, name, expect } of plan.deletes.guardedValues) {
    const q = r.runReg(win.regQueryArgs({ key, name }))
    const current = q.status === 0 ? (name ? win.parseRegQueryValue(q.stdout, name) : win.parseRegQueryFirstValue(q.stdout)) : null
    if (current !== expect) {
      if (current) log.push(`· 保留 ${key} 的默认值(${current} 不是 bow 写的)`)
      continue
    }
    if (r.runReg(win.regDeleteValueArgs({ key, name })).status === 0) removed += 1
  }
  for (const key of plan.deletes.keys) {
    if (r.runReg(win.regDeleteKeyArgs(key)).status === 0) removed += 1
  }
  log.push(removed > 0 ? `✅ 已移除 bow 的注册表条目(${removed} 项)` : '✅ 无需撤销(注册表里没有 bow 的条目)')
}

function regLabel(op: win.RegOp): string {
  return `${op.key}${op.name ? `\\${op.name}` : '\\<默认值>'}`
}

// ---------------------------------------------------------------- 小工具

const MIME_LABELS: Record<string, string> = {
  'x-scheme-handler/http': 'http 链接',
  'x-scheme-handler/https': 'https 链接',
  'text/html': '.html 文件',
  'application/xhtml+xml': '.xhtml 文件'
}

/** 在 PATH 里找可执行文件(与 xdg-utils 是否安装有关,只用于提示) */
function whichInPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const dirs = (env.PATH ?? '').split(':')
  return dirs.some((d) => d && existsSync(join(d, cmd)))
}
