/**
 * 统一备份 / 还原(核心,无插件参与)。
 *
 * 做法:把 `<userData>` 下 18 份配置与数据打**一个 gzip 的 JSON 信封**(格式见 `@shared/backup`),
 * 路径由用户在保存对话框里指定;还原 = 整包校验 → 存现态快照 → 冻结落盘 → 逐文件原子写 → 自动重启。
 *
 * 三条不能改的约束:
 *
 * 1. **还原前先做完整校验,校验不过一个字节都不写**。还原是破坏性操作,半写状态只能靠快照救。
 * 2. **`freezeStores(true)` 必须在写盘之前**。否则还原进行中任何一个事件(tab:navigated 写 history、
 *    番茄钟状态迁移、下载进度)都会把**旧的内存快照**盖回刚还原的文件 —— 用户看到的是「还原了但没生效」。
 * 3. **`app.exit()` 必须晚于 IPC 响应**。紧跟 `return` 退出会掐掉在途的响应,渲染层永远等不到结果。
 *    所以重启挂在 `setTimeout(…, 300)` 上,本函数先把结果回给调用方。
 *
 * 为什么还原必须重启而不是热重载:`JsonStore` 的实例活着、内存里各持一份快照;让 16 个插件各自
 * 实现 `reload()` 是另一个量级的事,而且插件还有内存态(终端会话、下载 live map、密码库解锁态)。
 */

import { app, BrowserWindow, dialog } from 'electron'
import { writeFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import {
  ALL_DATA_FILES,
  buildEnvelope,
  parseEnvelope,
  sanitizeOnRestore,
  type BackupEnvelope,
  type BackupExportResult,
  type BackupRestoreResult
} from '@shared/backup'
import { freezeStores } from './stores'
import { pickFile, pickSaveFile } from './plugins/fileDialogs'
import { dateStamp, resolveDownloadsDir } from './plugins/exportFile'
import { log, logError } from './logger'

/** 还原前自动存一份现态;固定文件名,每次覆盖 —— 不堆积 */
export const PRE_RESTORE_FILE = 'backup-before-restore.json.gz'

/** 解压上限:真实包解压后只有几 KB,64 MiB 足够挡住压缩炸弹 */
const MAX_INFLATE_BYTES = 64 * 1024 * 1024

const BACKUP_FILTER: Electron.FileFilter = { name: 'bow 备份', extensions: ['gz'] }

function pathOf(name: string): string {
  return join(app.getPath('userData'), name)
}

/** 读取全部已知数据文件(读不到的跳过:塞默认值等于用旧默认覆盖用户没碰过的配置) */
export function gatherFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of ALL_DATA_FILES) {
    try {
      files[name] = readFileSync(pathOf(name), 'utf-8')
    } catch {
      // 文件不存在:跳过
    }
  }
  return files
}

/** 信封 → gzip 字节 */
export function encodeBackup(files: Record<string, string>): Buffer {
  const envelope: BackupEnvelope = buildEnvelope(files, {
    appVersion: app.getVersion(),
    createdAt: Date.now()
  })
  return gzipSync(Buffer.from(JSON.stringify(envelope), 'utf-8'))
}

/** 原子写(与 `JsonStore.save()` 同一套:`.tmp` → rename) */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, file)
}

function parentWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow()
}

/**
 * 导出备份。
 * `registered` = 内核已注册的数据文件名,仅用于交叉校验:清单是静态的,这里能发现「新插件加了
 * `ctx.storage` 却忘了登记 `PLUGIN_DATA_FILES`」——只打日志,不阻断(漏登记不该让用户导不出备份)。
 */
export async function exportBackup(registered: string[] = []): Promise<BackupExportResult> {
  const files = gatherFiles()
  const names = Object.keys(files)
  if (names.length === 0) return { error: '没有可备份的数据' }

  const missing = registered.filter((f) => !names.includes(f))
  if (missing.length > 0) {
    logError('备份清单漏登记(插件数据文件未进 PLUGIN_DATA_FILES)', missing.join(','))
  }

  let buf: Buffer
  try {
    buf = encodeBackup(files)
  } catch (e) {
    logError('备份打包失败', e)
    return { error: `打包失败:${e instanceof Error ? e.message : String(e)}` }
  }

  const picked = await pickSaveFile({
    title: '保存 bow 备份',
    defaultPath: join(resolveDownloadsDir(), `bow-backup-${dateStamp()}.json.gz`),
    filters: [BACKUP_FILTER]
  })
  if (picked.canceled || !picked.path) return { canceled: true }

  try {
    writeFileSync(picked.path, buf, { mode: 0o600 })
  } catch (e) {
    return { error: `写入失败:${e instanceof Error ? e.message : String(e)}` }
  }
  log('备份已导出', picked.path, names.length, '个文件')
  return { ok: true, path: picked.path }
}

/** 还原备份(成功后进程会自己重启,所以渲染层不需要再做什么) */
export async function restoreBackup(): Promise<BackupRestoreResult> {
  const picked = await pickFile({ title: '选择 bow 备份', filters: [BACKUP_FILTER] })
  if (picked.canceled) return { canceled: true }
  if (!picked.data) return { error: `读不到备份文件:${picked.error ?? '未知原因'}` }

  let text: string
  try {
    text = gunzipSync(picked.data, { maxOutputLength: MAX_INFLATE_BYTES }).toString('utf-8')
  } catch {
    return { error: '这个文件不是有效的 bow 备份(gzip 解不开,或文件已损坏)' }
  }

  const parsed = parseEnvelope(text)
  if (!parsed.ok) return { error: parsed.error }
  const files = parsed.envelope.files
  const names = Object.keys(files)

  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['取消', '还原并重启'],
    defaultId: 0,
    cancelId: 0,
    message: `用这份备份覆盖当前的配置与数据?(${names.length} 个文件)`,
    detail:
      '会覆盖:插件启停、书签、浏览历史、密码库、终端与下载设置、MCP HTTP 端口与令牌、核心设置。\n' +
      '不含:cookies 与登录态、已下载的文件、日志。\n' +
      '还原成功后 bow 会自动重启;当前状态会先自动存一份,免得还原错了没退路。'
  }
  const win = parentWindow()
  const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  if (answer.response !== 1) return { canceled: true }

  // 现态快照:失败就中止(没有退路的破坏性操作不做)
  try {
    writeFileSync(pathOf(PRE_RESTORE_FILE), encodeBackup(gatherFiles()), { mode: 0o600 })
  } catch (e) {
    logError('还原前存档失败', e)
    return { error: `还原前存档失败,已中止:${e instanceof Error ? e.message : String(e)}` }
  }

  freezeStores(true)
  try {
    for (const name of names) writeAtomic(pathOf(name), sanitizeOnRestore(name, files[name]))
  } catch (e) {
    // 这里必须解冻:已写的文件是半成品,但继续冻结会让应用**静默地不再保存任何东西**
    // (比半写更糟)。用户手上的退路是上面那份现态快照。
    freezeStores(false)
    logError('还原写入失败', e)
    return {
      error: `写入失败,已中止:${e instanceof Error ? e.message : String(e)}(还原前的状态已存到 ${pathOf(PRE_RESTORE_FILE)})`
    }
  }

  log('还原完成,准备重启', names.length, '个文件')
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 300)
  return { ok: true }
}
