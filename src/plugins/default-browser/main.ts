/**
 * 默认浏览器插件:把 bow 注册成系统默认浏览器与 html「打开方式」,并显示**现在究竟是不是**默认。
 *
 * 两条平台路线(详见 registration.ts):
 * - Linux:写 `~/.local/bin/bow` 包装脚本(dev)/ 直接指向真实二进制(打包)+
 *   `.desktop` + `mimeapps.list` 默认关联 —— 这部分是**真能一步到位**的;
 * - Windows:只能写 HKCU 把 bow 注册成**候选**(系统不允许程序自设默认),
 *   最后由用户在「设置 → 默认应用」点一次 —— 界面会把这几步明确列出来。
 *
 * 为什么只读 `process` 全局而不 import electron:插件的边界是「用内核注入的能力」,
 * 而这里需要的三件事(可执行文件路径 / 是否打包 / 仓库根)都在 process 上现成就有:
 * - 打包后 `process.execPath` 就是 bow 二进制;
 * - dev 下 `process.defaultApp === true`,`process.execPath` 是仓库里的 electron、
 *   `process.cwd()` 是仓库根 → 正好够生成包装脚本。
 */

import type { DesktopActionResult, DesktopStatus } from './shared'
import {
  desktopStatus,
  openPlatformSettings,
  registerDesktop,
  unregisterDesktop,
  type RegistrationDeps
} from './registration'
import type { PluginContext, PluginMain } from '../../main/plugins/types'

/** Electron 在 dev 模式会置 `process.defaultApp = true`(类型定义在 electron.d.ts,插件不 import 它) */
function isDev(): boolean {
  return (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true
}

function deps(): RegistrationDeps {
  return {
    platform: process.platform,
    isPackaged: !isDev(),
    execPath: process.execPath,
    repoRoot: process.cwd()
  }
}

const plugin: PluginMain = {
  manifest: {
    id: 'default-browser',
    name: '默认浏览器',
    description: '把 bow 注册为系统默认浏览器与 html 打开方式,并显示当前是否已是默认',
    version: '1.0.0'
  },
  capabilities: ['ui'],

  activate(ctx: PluginContext): void {
    ctx.ipc.handle('status', (): DesktopStatus => desktopStatus(deps()))
    ctx.ipc.handle('register', (): DesktopActionResult => {
      const res = registerDesktop(deps())
      for (const line of res.log) ctx.log(line)
      return res
    })
    ctx.ipc.handle('unregister', (): DesktopActionResult => {
      const res = unregisterDesktop(deps())
      for (const line of res.log) ctx.log(line)
      return res
    })
    /** 跳系统设置页(Windows) —— 候选≠默认,最后那一下必须用户点 */
    ctx.ipc.handle('openSettings', (): { ok: boolean; message: string } => openPlatformSettings(deps()))
  }
}

export default plugin
