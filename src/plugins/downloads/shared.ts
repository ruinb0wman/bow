/**
 * 下载插件:纯逻辑(三端安全,**不 import electron / node:fs**)。
 *
 * 分工:
 * - 本文件:记录模型、设置归一、动作可用性、启动归一、裁剪排序、重名去重、展示格式化 —— 全部可单测;
 * - `main.ts`:唯一接触 electron 的地方(will-download 宿主 / shell / dialog / 落盘);
 * - `ui/*.vue`:只调 IPC 与渲染,不自己判断状态语义(文案与可用动作都从这里来)。
 *
 * ⚠️ 两条边界:
 * 1. 纯逻辑必须留在这里 —— vitest 跑在 node 环境,import electron 会让整份测试无法加载;
 * 2. `uniqueFileName` 的存在性判定是**注入**的(`exists`),`node:fs` 的调用留在 main.ts。
 */

/** 记录状态。Electron 只给 progressing/completed/cancelled/interrupted,`paused` 由 `item.isPaused()` 推出 */
export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadRecord {
  id: string
  /** item.getURL():本次下载的**原始**地址(重定向前的那个) */
  url: string
  /** item.getURLChain():含重定向的完整链,重新下载与将来的续传都要它 */
  urlChain: string[]
  /** item.getFilename() || 'download' */
  filename: string
  /**
   * 目标路径。**询问保存位置时,用户确认对话框之前这里是空串** ——
   * Electron 没有「对话框结束」事件(见 electron#41640),只能在 done 时补齐。
   */
  savePath: string
  mimeType: string
  /** 0 = 服务器没给 Content-Length(未知大小) */
  totalBytes: number
  receivedBytes: number
  state: DownloadState
  /**
   * **观测到的**事实:恢复下载后 Chromium 丢弃了已收字节(进度从 0 重新计)。
   * 为什么不预判:`item.canResume()` 在下载进行中恒为 false、暂停时又恒为 true(实测),
   * 不能用来回答「服务器支不支持续传」。
   * 而实测「支持 Range + ETag」与「不接受 Range、只返回 200」两种服务器在恢复时都**不会**回退
   * (后者 Chromium 会重发请求但保留已收字节、继续追加,最终文件仍正确)—— 所以这个字段绝大多数
   * 时候是 undefined,只在真的观测到字节回退时置位。
   */
  restarted?: boolean
  startedAt: number
  endedAt?: number
  /** 失败原因(浏览器给的文案:已取消 / 下载中断 / 服务器错误…) */
  error?: string
  /** 来源页面 URL(webContents.getURL()) */
  pageUrl?: string
  /** 由「重新下载」产生时指向原记录 id */
  retriedFrom?: string
  /** 速度快照(字节/秒),仅进行中项有 */
  bytesPerSecond?: number
  /**
   * **仅 `list` 响应里现算**,不落盘:completed 项的 savePath 是否还在磁盘上。
   * 为 `false` 时 UI 不提供「打开」,只留「显示文件夹」。
   */
  fileExists?: boolean
}

export interface DownloadsSettings {
  /** true(默认)= 不介入 Electron 的原始流程,弹保存对话框;false = 静默保存到 downloadDir */
  askWhereToSave: boolean
  /** 空串 = 用 app.getPath('downloads')(由 main.ts 解析) */
  downloadDir: string
  maxRecords: number
}

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadsSettings = {
  askWhereToSave: true,
  downloadDir: '',
  maxRecords: 500
}

export const MAX_RECORDS_MIN = 1
export const MAX_RECORDS_MAX = 5000

/** 插件广播事件名(经 ctx.ipc.emit,面板与工具栏按钮都收) */
export const DOWNLOADS_EVENT = {
  /** 记录的增删或状态迁移(创建/暂停/恢复/完成/取消/中断/删除) */
  changed: 'changed'
} as const

/** 设置 + 已解析目录(设置页与面板头部共用) */
export interface DownloadsSettingsState {
  settings: DownloadsSettings
  /** 实际生效的保存目录(downloadDir 为空时是 app.getPath('downloads')) */
  dir: string
  /** dir 是否来自系统默认(downloadDir 为空) */
  dirIsDefault: boolean
}

/** `list` IPC 的返回体 */
export interface DownloadsListResult extends DownloadsSettingsState {
  /** 已排序:非终态在前 */
  records: DownloadRecord[]
  /** 仍在主进程内存里的 id(action 可用性要它:`live` 决定「继续」还是「重新下载」) */
  live: string[]
}

/** 动作类 IPC 的统一返回体 */
export interface DownloadActionResult {
  ok: boolean
  error?: string
}

export const DOWNLOAD_STATE_LABELS: Record<DownloadState, string> = {
  progressing: '下载中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  interrupted: '已中断'
}

export function isTerminal(state: DownloadState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'interrupted'
}

export function clampMaxRecords(value: unknown, fallback: number = DEFAULT_DOWNLOAD_SETTINGS.maxRecords): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_RECORDS_MAX, Math.max(MAX_RECORDS_MIN, Math.floor(n)))
}

/** 设置归一:坏字段一律回退 `prev`(不跳默认值),只有 maxRecords 走夹紧 */
export function normalizeSettings(patch: unknown, prev: DownloadsSettings): DownloadsSettings {
  const raw = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
  return {
    askWhereToSave: typeof raw.askWhereToSave === 'boolean' ? raw.askWhereToSave : prev.askWhereToSave,
    downloadDir: typeof raw.downloadDir === 'string' ? raw.downloadDir.trim() : prev.downloadDir,
    maxRecords:
      raw.maxRecords === undefined ? prev.maxRecords : clampMaxRecords(raw.maxRecords, prev.maxRecords)
  }
}

/** 列表里的可用动作(UI 直接按这个渲染按钮,不在组件里写状态判断) */
export type DownloadAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry'
  | 'open'
  | 'showInFolder'
  | 'copyUrl'
  | 'remove'

/**
 * 该记录当前能做什么。
 * `live` = 这个 id 是否还在主进程的 in-flight 表里(决定「继续」还是「重新下载」):
 * 重启后所有未完成记录都变成 `interrupted` 且没有 live item,只能整份重下。
 */
export function actionsFor(record: DownloadRecord, live: boolean): DownloadAction[] {
  switch (record.state) {
    case 'progressing':
      return live ? ['pause', 'cancel', 'copyUrl'] : ['retry', 'remove', 'copyUrl']
    case 'paused':
    case 'interrupted':
      return live ? ['resume', 'cancel', 'copyUrl'] : ['retry', 'remove', 'copyUrl']
    case 'completed':
      return record.fileExists === false
        ? ['showInFolder', 'remove', 'copyUrl']
        : ['open', 'showInFolder', 'remove', 'copyUrl']
    case 'cancelled':
      return ['retry', 'remove', 'copyUrl']
    default:
      return ['remove', 'copyUrl']
  }
}

/**
 * 启动归一:进程内已经没有 DownloadItem 了,所有非终态记录降级成 `interrupted`。
 * 刻意**不删**这些记录(用户能看到「上次没下完」,并手动重新下载)。
 */
export function reconcileOnStart(records: DownloadRecord[]): DownloadRecord[] {
  return records.map((r) =>
    isTerminal(r.state)
      ? r
      : {
          ...r,
          state: 'interrupted' as const,
          error: '浏览器退出时中断',
          bytesPerSecond: undefined
        }
  )
}

/**
 * 按上限裁剪。两条不变式:
 * 1. **永不裁非终态**(进行中/暂停的记录必须留住,否则用户看不到正在下载的东西);
 * 2. 终态里删**最旧**的,保留原数组顺序(UI 排序由 `sortRecords` 负责)。
 */
export function trimRecords(records: DownloadRecord[], max: number): DownloadRecord[] {
  const limit = clampMaxRecords(max)
  if (records.length <= limit) return records
  const live = records.filter((r) => !isTerminal(r.state))
  const done = records
    .filter((r) => isTerminal(r.state))
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt) // 旧 → 新
  const keepDone = Math.max(0, limit - live.length)
  const kept = new Set<string>([
    ...live.map((r) => r.id),
    ...done.slice(done.length - keepDone).map((r) => r.id)
  ])
  return records.filter((r) => kept.has(r.id))
}

/** 排序:非终态在前(先来的在上),终态在后(新的在上) */
export function sortRecords(records: DownloadRecord[]): DownloadRecord[] {
  return records.slice().sort((a, b) => {
    const at = isTerminal(a.state) ? 1 : 0
    const bt = isTerminal(b.state) ? 1 : 0
    if (at !== bt) return at - bt
    return at === 0 ? a.startedAt - b.startedAt : b.startedAt - a.startedAt
  })
}

/** 进度百分比(整数;未知大小时进行中给 0,已完成恒 100) */
export function percentOf(record: DownloadRecord): number {
  if (record.state === 'completed') return 100
  if (!Number.isFinite(record.totalBytes) || record.totalBytes <= 0) return 0
  const pct = Math.floor((record.receivedBytes / record.totalBytes) * 100)
  return Math.min(100, Math.max(0, pct))
}

/** 剩余秒数;拿不到(未在下载 / 速度或大小未知)返回 null */
export function etaSeconds(record: DownloadRecord): number | null {
  if (record.state !== 'progressing') return null
  const speed = record.bytesPerSecond ?? 0
  if (speed <= 0 || record.totalBytes <= 0) return null
  const remain = record.totalBytes - record.receivedBytes
  return remain <= 0 ? 0 : remain / speed
}

/**
 * 同名去重:`report.pdf` → `report (1).pdf`。
 * 扩展名按**最后一个点**切(与 Chromium 的 `GetUniquePath` 一致:`a.tar.gz` → `a.tar (1).gz`);
 * 以点开头(`.gitignore`)或没有点时整体当名字。
 * `exists` 由调用方注入(主进程用 `existsSync`),所以这里是纯函数。
 */
export function uniqueFileName(filename: string, exists: (name: string) => boolean, max = 1000): string {
  const name = (filename || '').trim() || 'download'
  if (!exists(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i <= max; i += 1) {
    const candidate = `${stem} (${i})${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${stem} (${Date.now().toString(36)})${ext}`
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'] as const

/** 人类可读大小;非有限数 / 负数 → `—`(未知大小由调用方决定要不要显示「未知」) */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < BYTE_UNITS.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[i]}`
}

/** 速度;<=0 / 非有限 → `—` */
export function formatSpeed(bytesPerSecond: number | undefined): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 1) return '不到 1 秒'
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`
  const total = Math.round(seconds)
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`
  if (total < 86400) return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`
  return `${Math.floor(total / 86400)} 天`
}

/** 「已收 / 总大小」文本;总大小未知时只显示已收 */
export function formatProgressBytes(record: DownloadRecord): string {
  if (record.totalBytes <= 0) return formatBytes(record.receivedBytes)
  return `${formatBytes(record.receivedBytes)} / ${formatBytes(record.totalBytes)}`
}

const STATES: DownloadState[] = ['progressing', 'paused', 'completed', 'cancelled', 'interrupted']

function isDownloadState(value: unknown): value is DownloadState {
  return typeof value === 'string' && (STATES as string[]).includes(value)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 读盘防御:数组型 JSON 存储不做字段校验(JsonStore 只保证「是数组」),
 * 用户手改过文件或旧版本残留的记录会带着缺字段进来。这里逐条过滤 + 补默认值。
 * `state` 非法的条目直接丢掉(留着会让 UI 与动作表都落到 default 分支)。
 */
export function sanitizeRecords(raw: unknown): DownloadRecord[] {
  if (!Array.isArray(raw)) return []
  const out: DownloadRecord[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const id = str(r.id)
    const url = str(r.url)
    if (!id || !url || !isDownloadState(r.state)) continue
    const chain = Array.isArray(r.urlChain) ? r.urlChain.filter((u): u is string => typeof u === 'string') : []
    out.push({
      id,
      url,
      urlChain: chain.length > 0 ? chain : [url],
      filename: str(r.filename) || 'download',
      savePath: str(r.savePath),
      mimeType: str(r.mimeType),
      totalBytes: Math.max(0, num(r.totalBytes)),
      receivedBytes: Math.max(0, num(r.receivedBytes)),
      state: r.state,
      ...(r.restarted === true ? { restarted: true } : {}),
      startedAt: num(r.startedAt, Date.now()),
      ...(r.endedAt === undefined ? {} : { endedAt: num(r.endedAt) }),
      ...(r.bytesPerSecond === undefined ? {} : { bytesPerSecond: Math.max(0, num(r.bytesPerSecond)) }),
      ...(typeof r.error === 'string' ? { error: r.error } : {}),
      ...(typeof r.pageUrl === 'string' ? { pageUrl: r.pageUrl } : {}),
      ...(typeof r.retriedFrom === 'string' ? { retriedFrom: r.retriedFrom } : {})
    })
  }
  return out
}
