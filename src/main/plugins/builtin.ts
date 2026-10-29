/** 内置插件清单(固定顺序:决定网络钩子链与建议源的稳定次序) */

import type { PluginMain } from './types'
import history from '@plugins/history/main'
import bookmarks from '@plugins/bookmarks/main'
import cors from '@plugins/cors/main'
import mcpHttp from '@plugins/mcp-http/main'
import defaultBrowser from '@plugins/default-browser/main'
import deviceInspect from '@plugins/device-inspect/main'
import terminal from '@plugins/terminal/main'
import downloads from '@plugins/downloads/main'
import passwords from '@plugins/passwords/main'
import pomo from '@plugins/pomo/main'
import editor from '@plugins/editor/main'
import services from '@plugins/services/main'

export const BUILTIN_PLUGINS: PluginMain[] = [
  history,
  bookmarks,
  cors,
  mcpHttp,
  defaultBrowser,
  // 放末尾:不参与网络钩子链与地址栏建议源的次序(它只贡献 UI 与 MCP 工具)
  deviceInspect,
  // 同上(只贡献 UI,且它带来的 bow://terminal 页面走内部页面那条独立通路)
  terminal,
  // 同上(只贡献 UI 与 MCP 工具;它接管 defaultSession 的 will-download,与网络钩子链无关)
  downloads,
  // 同上(只贡献 UI 与快捷键:主密码解锁的本地密码库,页面侧按需注入、不常驻)
  passwords,
  // 同上(只贡献 UI / MCP 工具:番茄钟计时,不参与网络钩子与建议源顺序)
  pomo,
  // 同上(只贡献 UI + 一个「认领本地文件」的注册:它把启动参数里的 file:// 目标换成终端里的 nvim,
  // 不参与网络钩子与建议源顺序;需要终端插件在场才能真的跑起来)
  editor,
  // 同上(只贡献 UI:用户自己配的 dev server —— 命令 + 图标 + 前端地址,进程归插件自己管)
  services
]
