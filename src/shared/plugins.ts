/**
 * 插件体系跨端契约(同构:无 electron / DOM 依赖,main / renderer / tests 均可引用)。
 *
 * 插件是仓库内编译期模块,分为两侧:
 * - 主进程侧 `src/plugins/<id>/main.ts`(见 @main/plugins/types 的 PluginMain);
 * - 渲染层侧 `src/plugins/<id>/ui.ts`(见 renderer/src/plugins/types 的 PluginUiContribution)。
 * 二者通过本文件的 PluginManifest / PluginInfo / 事件与建议契约通信。
 */

import type { Suggestion, TabInfo } from './types'

export type PluginCapability = 'ui' | 'suggest' | 'mcp' | 'net' | 'content' | 'shortcut'

export const PLUGIN_CAPABILITY_LABELS: Record<PluginCapability, string> = {
  ui: '界面',
  suggest: '地址栏建议',
  mcp: 'MCP 工具',
  net: '网络拦截',
  content: '内容注入',
  shortcut: '快捷键'
}

export interface PluginManifest {
  /** kebab-case 全局唯一,兼作 IPC 命名空间与浮层 id 前缀 */
  id: string
  name: string
  description: string
  version: string
  /** 关闭后会影响核心功能(设置页给出提示) */
  core?: boolean
}

export interface PluginInfo extends PluginManifest {
  builtin: true
  enabled: boolean
  capabilities: PluginCapability[]
}

// ---------- 地址栏建议源 ----------

export interface SuggestItem extends Suggestion {
  /** 排序分(0 表示不匹配),同分按 visitedAt 降序 */
  score: number
}

export interface SuggestProvider {
  id: string
  /** 仅在「同 URL 冲突」时决定胜负(书签 20 > 历史 10) */
  priority: number
  provide(query: string, limit: number): SuggestItem[]
}

// ---------- 网络钩子 ----------

export type NetPhase = 'onBeforeRequest' | 'onBeforeSendHeaders' | 'onHeadersReceived'

/** 插件网络钩子上下文:一次请求按阶段在插件间顺序传递,可累积修改 */
export interface NetHookContext {
  phase: NetPhase
  /** Electron webRequest 的请求 id(onHeadersReceived 是终态) */
  requestId: number
  url: string
  method: string
  resourceType: string
  webContentsId?: number
  /** 发起请求的页面 URL(fetch 等子资源尤其需要) */
  pageUrl?: string
  /** 请求头(onBeforeSendHeaders 阶段可改写) */
  requestHeaders?: Record<string, string>
  /** 响应头(onHeadersReceived 阶段可改写) */
  responseHeaders?: Record<string, string[] | string>
  /** 状态行(onHeadersReceived 阶段可改写,如预检覆盖为 200) */
  statusLine?: string
  readonly canceled: boolean
  readonly redirectURL?: string
  /** 取消请求并短路后续插件 */
  cancel(): void
  /** 重定向并短路后续插件 */
  redirect(url: string): void
}

export type NetHook = (ctx: NetHookContext) => void

// ---------- 内容注入 ----------

export interface ContentScriptSpec {
  /** 插件内唯一 id(用于卸载时移除已注入 CSS) */
  id: string
  /** URL 通配模式,如 `*://*.example.com/` 后接星号;<all_urls> 等价于通配全部 URL */
  matches: string[]
  excludeMatches?: string[]
  runAt?: 'dom-ready' | 'did-finish-load'
  js?: string
  /** 静态 CSS 字符串,或按页面 URL 动态生成(返回空串/undefined 则跳过本页) */
  css?: string | ((url: string) => string | undefined)
}

// ---------- 插件可用的只读标签 API ----------

export interface PluginTabApi {
  list(): TabInfo[]
  getActive(): TabInfo | null
}
