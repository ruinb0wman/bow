/** 内置插件清单(固定顺序:决定网络钩子链与建议源的稳定次序) */

import type { PluginMain } from './types'
import history from '@plugins/history/main'
import bookmarks from '@plugins/bookmarks/main'
import cors from '@plugins/cors/main'
import adblock from '@plugins/adblock/main'
import elementFullscreen from '@plugins/element-fullscreen/main'
import mcpHttp from '@plugins/mcp-http/main'
import defaultBrowser from '@plugins/default-browser/main'

export const BUILTIN_PLUGINS: PluginMain[] = [
  history,
  bookmarks,
  cors,
  adblock,
  elementFullscreen,
  mcpHttp,
  defaultBrowser
]
