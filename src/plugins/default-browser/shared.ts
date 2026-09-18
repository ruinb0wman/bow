/**
 * 默认浏览器插件的跨端类型与文案(同构:不 import node / electron,渲染层的 .vue 直接用)。
 *
 * 状态判定与注册执行在 `registration.ts`(主进程侧,要碰 fs / reg.exe),
 * 两侧只通过这里的数据结构 + 插件 IPC 通信。
 */

export type DesktopTargetState = 'default' | 'other' | 'unset'
export type DesktopPlatform = 'linux' | 'win32' | 'other'

/** 一类关联目标(http 链接 / .html 文件 …)的当前归属 */
export interface DesktopTarget {
  id: string
  label: string
  state: DesktopTargetState
  /** 系统当前把这类交给谁(null = 没设过) */
  current: string | null
  /** `current` 的人话名(如 `Firefox`);认不出时缺省,界面就只显示原始 ProgID */
  currentLabel?: string
  /** 系统**实际**会用哪个程序打开(仅当它与记录不一致时才给):`bow` / `firefox` 这类程序名 */
  effective?: string
  /** 上面那个结论的原始 exe 路径(悬停可见,便于核对它到底指的是谁) */
  effectivePath?: string
  /** 这个结论是从哪儿读出来的(注册表键 / mimeapps 键)—— 界面作为 tooltip,也方便自证没读错位置 */
  source?: string
  /** 非默认时的针对性修法 */
  fix?: string
}

export interface DesktopStatus {
  platform: DesktopPlatform
  /** 平台本身是否支持(只有 linux / win32) */
  supported: boolean
  /** 现在能不能执行注册(Windows 必须在打包版里) */
  canRegister: boolean
  mode: 'dev' | 'packaged'
  /** 会写进 Exec / 注册表命令的目标 */
  exec: string
  /** Linux 的 .desktop 基名(与 app.setDesktopName / package.json appId 同源) */
  desktopId: string
  /** 我们的文件 / 注册表键在不在 */
  registered: boolean
  /** 系统**当前**是否把每一类都交给了我们 */
  isDefault: boolean
  targets: DesktopTarget[]
  /** 平台注意事项(直接显示) */
  notes: string[]
  /** Windows:必须由用户在系统设置里点的步骤 */
  manualSteps: string[]
  /** 不可注册 / 失败原因 */
  error?: string
}

/** 注册 / 撤销的返回:新状态 + 这次做了什么 */
export interface DesktopActionResult {
  status: DesktopStatus
  log: string[]
}

export type StatusTone = 'ok' | 'warn' | 'idle' | 'bad'

/** 顶部状态徽标(纯函数,便于单测) */
export function statusBadge(status: DesktopStatus): { text: string; tone: StatusTone } {
  if (!status.supported) return { text: '本平台暂不支持', tone: 'idle' }
  if (status.isDefault) return { text: '已是默认浏览器', tone: 'ok' }
  if (status.registered) return { text: '已注册,但系统当前用的是别的', tone: 'warn' }
  return { text: '尚未注册', tone: 'idle' }
}

export const TARGET_STATE_LABELS: Record<DesktopTargetState, string> = {
  default: '已默认',
  other: '非默认',
  unset: '未设置'
}

export const PLATFORM_LABELS: Record<DesktopPlatform, string> = {
  linux: 'Linux',
  win32: 'Windows',
  other: '其它平台'
}
