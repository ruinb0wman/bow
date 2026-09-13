/** 浏览器身份:显示名 bow + 全局 UA 签名(HTTP 头与页面侧 navigator.userAgent 一体生效) */

import { app } from 'electron'
import { join } from 'node:path'
import { BROWSER_NAME, bowUserAgent } from '@shared/ua'

// 旧数据目录名:钉住它,改名不影响书签/历史/设置/日志
// 注意:若日后 package.json name 变更,此路径常量需同步更新
const LEGACY_APP_DIR = 'mcp-browser'

/**
 * 在创建任何窗口/WebContents 之前调用一次(置于 whenReady 最前):
 * - 显示名 → bow(任务栏 / DevTools 标题等应用本体标识)
 * - userData 钉回旧路径(→ ~/.config/mcp-browser 等),既有数据零迁移
 * - app.userAgentFallback 全局替换为 bow 签名:同时生效于 HTTP 请求头、
 *   Service Worker 与页面侧 navigator.userAgent / appVersion / platform
 * 顺序要求:先取旧名再 setName;setPath('userData') 必须先于任何 getPath('userData')。
 */
export function applyBrowserIdentity(): void {
  const legacyName = app.getName() // 改名前的原始名(mcp-browser)
  const version = app.getVersion()
  app.setName(BROWSER_NAME)
  app.setPath('userData', join(app.getPath('appData'), LEGACY_APP_DIR))
  app.userAgentFallback = bowUserAgent(app.userAgentFallback, legacyName, version)
}