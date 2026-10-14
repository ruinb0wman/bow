/**
 * 编辑器插件主进程侧:把「一个本地文件」变成「终端插件里的一个 nvim 标签」。
 *
 * 这个插件**不做编辑器本体**(没有 CodeMirror / Monaco,也不开自己的内部页面):
 * 它只做两件事,而且都在别的插件/核心已经有的能力上:
 * 1. **认领本地文件**(`ctx.fileOpeners`):启动参数里的 `file://` 目标先问它一把,认领了就不开浏览器标签;
 * 2. 认领成功 → `ctx.tabs.openInternal('terminal')` 建标签 → `ctx.events.emit(TERMINAL_RUN_EVENT)` 让
 *    终端插件在那个标签里跑 `wsl.exe -e nvim <file>`(见 `@shared/terminalRun`)。
 *
 * 边界(改代码前先看):
 * - 插件拿不到 webContents、不能建任意标签,所以这条链上每一环都是核心/终端插件出的窄能力;
 * - **路径换算不出时明确拒绝**(不认领 → 回落成浏览器标签),不猜路径、不静默失败;
 * - 认领只影响「启动参数里的本地文件」这一条通路(双击 / 右键 / `bow.exe <file>` / `--edit`),
 *   地址栏输入与网页里的本地链接不经过这里。
 *
 * Windows 注册表部分在 `./windowsRegistry`(纯逻辑)与 `./registration`(I/O 编排);
 * 「编辑」动词的落点是 `HKCU\Software\Classes\SystemFileAssociations\.<ext>\shell\bow-edit`
 * —— per-extension、与该扩展名的默认处理程序无关,这是不做全局 `*\shell` 还能右键编辑的正路。
 */

import { BrowserWindow, dialog, shell } from 'electron'
import { basename } from 'node:path'
import type { OpenDialogOptions } from 'electron'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import { TERMINAL_RUN_EVENT } from '@shared/terminalRun'
import {
  buildEditorCommand,
  defaultSettings,
  normalizeEditorSettings,
  shouldOpenInEditor,
  type EditorSettings
} from './shared'
import { editorStatus, registerEditor, unregisterEditor } from './registration'
import type { EditorActionResult, EditorStatus } from './shared'

/** 设置页读写的设置(不含注册表状态;状态在 `status()` 里现算) */
type EditorSettingsPatch = Partial<EditorSettings>

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const plugin: PluginMain = {
  manifest: {
    id: 'editor',
    name: '编辑器',
    description:
      '用终端里的编辑器(nvim)打开本地文本文件;Windows 上可注册成「编辑」动词,出现在「打开方式 / 默认应用」里',
    version: '0.1.0'
  },
  capabilities: ['ui'],

  activate(ctx: PluginContext): void {
    const platform = process.platform
    const defaults = (): EditorSettings => defaultSettings(platform)
    const store: PluginStorage<EditorSettings> = ctx.storage<EditorSettings>({
      file: 'editor.json',
      defaults: defaults()
    })
    // 磁盘上的旧文件 / 手改坏的文件一次性夹正(与终端插件同款做法)
    const normalized = normalizeEditorSettings(store.get(), defaults())
    if (JSON.stringify(normalized) !== JSON.stringify(store.get())) store.setRaw(normalized)

    function settings(): EditorSettings {
      return normalizeEditorSettings(store.get(), defaults())
    }

    /**
     * 唯一的「开编辑器」入口:算命令 → 建终端标签 → 把命令交给终端插件。
     * 返回 false 表示**这次没打开**(调用方据此决定是否回落成浏览器标签)。
     */
    function openInEditor(path: string): boolean {
      const built = buildEditorCommand(settings(), path)
      if (!built.ok) {
        ctx.logError('编辑器命令算不出来,不认领这个文件', path, built.error)
        return false
      }
      const tabId = ctx.tabs.openInternal('terminal')
      if (tabId === null) {
        ctx.logError('没有可用窗口,开不出编辑器标签', path)
        return false
      }
      ctx.events.emit(TERMINAL_RUN_EVENT, {
        tabId,
        file: built.command.file,
        args: built.command.args,
        cwd: built.command.cwd,
        // 标签标题(`终端 — a.txt`);终端插件用 profileName 渲染,前端不用改
        name: basename(path)
      })
      ctx.log('已在编辑器里打开', path, '→', built.command.file, built.command.args.join(' '))
      return true
    }

    /** 认领启动参数里的本地文件(`--edit` 一律认;否则看扩展名白名单) */
    ctx.fileOpeners.register({
      match: (path, mode) => shouldOpenInEditor(settings(), path, mode),
      open: (path) => openInEditor(path)
    })

    /** 注册表相关操作要的可注入依赖(与默认浏览器插件同构:平台 / 可执行文件 / reg.exe) */
    const registrationDeps = () => ({ platform, execPath: process.execPath, isPackaged: !isDev() })

    function isDev(): boolean {
      return (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true
    }

    function commit(next: EditorSettings): EditorSettings {
      store.setRaw(normalizeEditorSettings(next, defaults()))
      return settings()
    }

    // ---------- IPC(设置页与工具栏按钮) ----------

    ctx.ipc.handle('getSettings', (): EditorSettings => settings())

    ctx.ipc.handle('setSettings', (patch: unknown): EditorSettings => {
      const raw = (patch && typeof patch === 'object' ? patch : {}) as EditorSettingsPatch
      // `lastRegistered` 是注册流程自己维护的,不许渲染层改(改了撤销就会漏删)
      const { lastRegistered: _ignored, ...rest } = raw
      return commit({ ...settings(), ...rest })
    })

    ctx.ipc.handle('status', (): EditorStatus => editorStatus(registrationDeps(), settings()))

    ctx.ipc.handle('register', (): EditorActionResult => {
      const result = registerEditor(registrationDeps(), settings())
      for (const line of result.log) ctx.log(line)
      const next = commit({ ...settings(), ...result.settings })
      return { ok: result.ok, log: result.log, status: editorStatus(registrationDeps(), next) }
    })

    ctx.ipc.handle('unregister', (): EditorActionResult => {
      const result = unregisterEditor(registrationDeps(), settings())
      for (const line of result.log) ctx.log(line)
      const next = commit({ ...settings(), ...result.settings })
      return { ok: result.ok, log: result.log, status: editorStatus(registrationDeps(), next) }
    })

    /** 候选 ≠ 默认:最后那一步只能用户自己在系统设置里点 */
    ctx.ipc.handle('openSystemSettings', (): { ok: boolean; message: string } => {
      if (platform !== 'win32') return { ok: false, message: '只有 Windows 需要这一步' }
      void shell.openExternal('ms-settings:defaultapps')
      return { ok: true, message: '已打开「设置 → 默认应用」,在那里把 .txt 等扩展名选成 bow' }
    })

    /** 「测试」:开一个不带文件的编辑器标签,用来确认命令模板能起来 */
    ctx.ipc.handle('test', (): { ok: boolean; error?: string } => {
      const built = buildEditorCommand(settings(), null)
      if (!built.ok) return { ok: false, error: built.error }
      const tabId = ctx.tabs.openInternal('terminal')
      if (tabId === null) return { ok: false, error: '没有可用窗口' }
      ctx.events.emit(TERMINAL_RUN_EVENT, {
        tabId,
        file: built.command.file,
        args: built.command.args,
        name: `${built.command.file}(测试)`
      })
      return { ok: true }
    })

    /**
     * 「用编辑器打开…」:不做全局右键菜单的代价就要靠这个入口补回来 ——
     * 白名单之外的文件(比如 .html、无扩展名)也能手动送进编辑器。
     */
    ctx.ipc.handle('pickFile', async (): Promise<{ ok: boolean; opened?: number; canceled?: boolean; error?: string }> => {
      const options: OpenDialogOptions = {
        title: '用编辑器打开',
        properties: ['openFile', 'multiSelections']
      }
      const parent = BrowserWindow.getFocusedWindow()
      let result
      try {
        result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      } catch (e) {
        return { ok: false, error: describeError(e) }
      }
      if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true }
      let opened = 0
      for (const path of result.filePaths) if (openInEditor(path)) opened += 1
      return { ok: opened > 0, opened, ...(opened > 0 ? {} : { error: '一个都没打开成功(看日志)' }) }
    })
  }
}

export default plugin
