/** MCP 工具返回体构造助手(核心工具与插件共用) */

import type { McpToolResult } from './types'

export function textContent(obj: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }
}

export function imageContent(pngBase64: string): McpToolResult {
  return { content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }] }
}
