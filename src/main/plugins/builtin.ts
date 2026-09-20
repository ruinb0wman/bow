/** 内置插件清单(固定顺序:决定网络钩子链与建议源的稳定次序) */

import type { PluginMain } from './types'
import history from '@plugins/history/main'
import bookmarks from '@plugins/bookmarks/main'
import cors from '@plugins/cors/main'
import adblock from '@plugins/adblock/main'
import elementFullscreen from '@plugins/element-fullscreen/main'
import mcpHttp from '@plugins/mcp-http/main'
import defaultBrowser from '@plugins/default-browser/main'
import deviceInspect from '@plugins/device-inspect/main'
import terminal from '@plugins/terminal/main'
import logseq from '@plugins/logseq/main'

export const BUILTIN_PLUGINS: PluginMain[] = [
  history,
  bookmarks,
  cors,
  adblock,
  elementFullscreen,
  mcpHttp,
  defaultBrowser,
  // 放末尾:不参与网络钩子链与地址栏建议源的次序(它只贡献 UI 与 MCP 工具)
  deviceInspect,
  // 同上(只贡献 UI,且它带来的 bow://terminal 页面走内部页面那条独立通路)
  terminal,
  // 同上(只贡献 UI,带着 bow://logseq 内部页面;同样不参与网络钩子与建议源顺序)
  logseq
]
