/**
 * DevTools 策略:快捷键全局拦截 + 永远以独立窗口(detach)打开。
 *
 * 背景:标签页是 WebContentsView,打开停靠(docked)的 DevTools 会被同窗口内
 * z-order 更高的标签视图/Overlay 盖住,表现为"第一次按 Ctrl+Shift+I 看不见,
 * 需要按第二次关闭再按第三次才在新窗口打开"。因此:
 *  1. 移除默认菜单的 toggleDevTools role(它会停靠打开,且目标可能不是聚焦视图);
 *  2. 对每个 webContents 拦截快捷键,统一 openDevTools({ mode: 'detach' })。
 */

import { app, Menu, webContents } from 'electron'
import type { WebContents } from 'electron'
import { isDevToolsHotkey } from '@shared/shortcuts'
import { isDevToolsFrontendUrl } from '@shared/devtools'
import { log } from './logger'

/** 找出正在被 wc 检查的 webContents(即 wc 是它的 DevTools 前端) */
function findInspectedBy(devtoolsWc: WebContents): WebContents | null {
  for (const c of webContents.getAllWebContents()) {
    if (!c.isDestroyed() && c.devToolsWebContents === devtoolsWc) return c
  }
  return null
}

/** 切换独立窗口 DevTools:已开则关,未开则以 detach 模式打开 */
function toggleDetachedDevTools(wc: WebContents): void {
  if (wc.isDestroyed()) return
  if (wc.isDevToolsOpened()) {
    wc.closeDevTools()
    log('关闭 DevTools(独立窗口)', wc.getType())
    return
  }
  wc.openDevTools({ mode: 'detach' })
  log('打开 DevTools(独立窗口)', wc.getType())
}

/**
 * 安装 DevTools 策略。必须在创建任何窗口/视图之前调用,
 * 以保证 web-contents-created 监听不会漏掉已存在的 webContents。
 */
export function setupDevTools(): void {
  // 1) 去掉默认菜单里的 DevTools 角色(停靠打开的来源)
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    )
  } else {
    // 无边框窗口本就没有菜单栏;Chromium 自带文本编辑快捷键不受影响
    Menu.setApplicationMenu(null)
  }

  // 2) 覆盖 chrome UI / 标签视图 / Overlay / DevTools 前端等所有 webContents
  app.on('web-contents-created', (_e, contents) => {
    contents.on('before-input-event', (event, input) => {
      if (!isDevToolsHotkey(input)) return
      // preventDefault 会同时阻止页面 keydown/keyup 与菜单快捷键
      const inspected = findInspectedBy(contents)
      if (inspected) {
        // 焦点在 DevTools 窗口内:按同一快捷键关闭它
        event.preventDefault()
        if (!inspected.isDestroyed()) inspected.closeDevTools()
        log('关闭 DevTools(独立窗口)', 'devtools-frontend')
        return
      }
      // 远程调试标签(设备检查插件打开的 devtools:// 前端页面)自己就是调试器界面:
      // 给它再叠一层 Electron 本地 DevTools 只会套娃,所以这里**不拦截**、把按键让给页面。
      // 注意顺序:必须先走上面的 findInspectedBy(Electron 自己的 DevTools 前端 URL 也是 devtools://,
      // 但那种情况下 contents 是「别人」的 devtoolsWebContents,由上面那一支负责关闭)。
      if (isDevToolsFrontendUrl(contents.getURL())) return
      event.preventDefault()
      toggleDetachedDevTools(contents)
    })
  })
}
