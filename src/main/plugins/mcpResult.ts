/** MCP 工具返回体构造助手(核心工具与插件共用) */

import type { McpToolResult } from './types'

/**
 * 失败判定:返回体形如 {ok:false,...} 时,在协议层同时标记 isError,
 * 让调用方(LLM)无需解析 JSON 也能立刻察觉失败,避免把错误当成功继续往下走。
 */
function isFailure(obj: unknown): boolean {
  return typeof obj === 'object' && obj !== null && (obj as { ok?: unknown }).ok === false
}

export function textContent(obj: unknown): McpToolResult {
  const result: McpToolResult = { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }
  if (isFailure(obj)) result.isError = true
  return result
}

/** 纯错误返回体(用于拿不到 {ok:false} 结构的异常分支),同样标记 isError */
export function errorContent(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
    isError: true
  }
}

export function imageContent(pngBase64: string): McpToolResult {
  return { content: [{ type: 'image', data: pngBase64, mimeType: 'image/png' }] }
}
