/**
 * 统一备份包的信封格式与数据文件清单(**纯逻辑,不碰 fs**;gzip 与落盘在主进程 `main/backup.ts`)。
 *
 * 为什么清单是静态常量而不是「问内核要 `storageCache`」:内核只缓存**已激活插件**注册过的文件名,
 * 插件被停用就不会 activate ⇒ 它的数据文件不在缓存里 ⇒ 备份会漏。缓存只用来做交叉校验
 * (导出时发现有未登记的文件就打日志),清单本身必须是静态的,并由 `tests/backupFiles.test.ts`
 * 扫 `src/plugins/*\/main.ts` 的源码双向钉住,防止新插件加了 `ctx.storage` 却忘了登记。
 *
 * 备份包里存每个文件的**原始文本**而不是解析后的对象:还原时能逐字节写回(手改过的排版、
 * 历史遗留字段全部保住),校验也退化成「每个值能不能 `JSON.parse`」。
 */

export const BUNDLE_VERSION = 1

/** 插件侧数据文件(`src/plugins/*\/main.ts` 里 `ctx.storage({ file })` 声明的那些) */
export const PLUGIN_DATA_FILES = [
  'bookmarks.json',
  'cors.json',
  'device-inspect.json',
  'downloads.json',
  'downloads-settings.json',
  'editor.json',
  'history.json',
  'history-settings.json',
  'mcp-http.json',
  'passwords.json',
  'passwords-settings.json',
  'pomo.json',
  'services.json',
  'terminal.json'
] satisfies readonly string[]

/** 核心自己持有的 4 份(不在内核 storageCache 里,散在 stores.ts / kernel.ts / fileRoots.ts 的字面量) */
export const CORE_FILES: readonly string[] = ['settings.json', 'split-layouts.json', 'plugins.json', 'files-settings.json']

export const ALL_DATA_FILES: readonly string[] = [...PLUGIN_DATA_FILES, ...CORE_FILES]

/**
 * 还原时**必须裁掉**的字段(按文件)。
 *
 * `device-inspect.json` 的 `forwards[]` 是 **adb server 进程里的端口转发登记**:机器相关,
 * 跨机写回只会指向不存在的设备。其余字段照常还原。
 */
export const RESTORE_PRUNE: Record<string, string[]> = {
  'device-inspect.json': ['forwards']
}

export interface BackupEnvelope {
  version: typeof BUNDLE_VERSION
  appVersion: string
  createdAt: number
  /** 文件名 → 该文件的原始文本 */
  files: Record<string, string>
}

/** 备份结果(主进程 → 渲染层,三种结局互斥) */
export interface BackupExportResult {
  canceled?: true
  ok?: true
  path?: string
  error?: string
}
export interface BackupRestoreResult {
  canceled?: true
  ok?: true
  error?: string
}

export type ParseEnvelopeResult = { ok: true; envelope: BackupEnvelope } | { ok: false; error: string }

/**
 * 文件名白名单:备份包是**外来文件**,还原会按里面的键往 userData 写盘
 * ⇒ 名字必须先卡死成纯文件名,否则一个 `../../.bashrc` 就能写到任意位置。
 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/

export function buildEnvelope(
  files: Record<string, string>,
  meta: { appVersion: string; createdAt: number }
): BackupEnvelope {
  return { version: BUNDLE_VERSION, appVersion: meta.appVersion, createdAt: meta.createdAt, files }
}

/** 解析并校验一份备份包的 JSON 文本(解压后的)。错误文案要能让用户看懂是哪儿坏了。 */
export function parseEnvelope(text: string): ParseEnvelopeResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: '备份内容不是合法 JSON(文件可能已损坏)' }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '备份内容格式不对(顶层应为一个对象)' }
  }
  const src = raw as Record<string, unknown>
  if (src.version !== BUNDLE_VERSION) {
    return { ok: false, error: `不支持的备份版本:${String(src.version)}(当前 bow 只认 ${BUNDLE_VERSION})` }
  }
  const files = src.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return { ok: false, error: '备份里没有数据(files 字段缺失)' }
  }
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(files as Record<string, unknown>)) {
    if (!SAFE_NAME.test(name) || name.includes('..')) {
      return { ok: false, error: `备份里有非法文件名:${name}` }
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `备份已损坏:${name} 的内容不是文本` }
    }
    try {
      JSON.parse(value)
    } catch {
      return { ok: false, error: `备份已损坏:${name} 不是合法 JSON` }
    }
    out[name] = value
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, error: '备份里没有数据(files 是空的)' }
  }
  if (!ALL_DATA_FILES.some((f) => f in out)) {
    return { ok: false, error: '这个文件不像是 bow 备份(里面没有任何已知的数据文件)' }
  }
  return {
    ok: true,
    envelope: {
      version: BUNDLE_VERSION,
      appVersion: typeof src.appVersion === 'string' ? src.appVersion : '',
      createdAt: typeof src.createdAt === 'number' ? src.createdAt : 0,
      files: out
    }
  }
}

/** 写盘前对单个文件做裁剪(见 `RESTORE_PRUNE`);内容不合法时原样返回,由调用方决定是否继续 */
export function sanitizeOnRestore(name: string, text: string): string {
  const drop = RESTORE_PRUNE[name]
  if (!drop) return text
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text
    const obj = parsed as Record<string, unknown>
    for (const key of drop) {
      if (key in obj) obj[key] = []
    }
    return JSON.stringify(obj, null, 2)
  } catch {
    return text
  }
}
