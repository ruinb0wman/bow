/** CORS 放行:对白名单主机的响应注入 Access-Control-Allow-* 头,名单外主机零干扰 */

import { randomUUID } from 'node:crypto'
import { session } from 'electron'
import type { OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails } from 'electron'
import { isOpenCodeHost, isPreflightRequest, shouldBypassCors } from '@shared/cors'
import { getSettingsStore } from './stores'
import { getBowUserAgent } from './ua'
import { log, logError } from './logger'

const ACAO = 'Access-Control-Allow-Origin'
const ACAM = 'Access-Control-Allow-Methods'
const ACAH = 'Access-Control-Allow-Headers'

/** 预检请求 id 记录:onHeadersReceived 阶段读不到请求头,只能靠 onBeforeSendHeaders 识别 */
const preflightIds = new Set<number>()

/** Opencode Go/Zen 要求请求携带每个会话稳定不变的 x-opencode-session(2026-09-06 起强制) */
const opencodeSessionIds = new Map<number, string>()
const FALLBACK_SESSION = randomUUID()

/** 每个标签页(≈一个会话)一个稳定 UUID;无 webContentsId 时回退到全局 ID */
function sessionIdFor(wcId: number | undefined): string {
  if (wcId == null) return FALLBACK_SESSION
  let id = opencodeSessionIds.get(wcId)
  if (!id) {
    id = randomUUID()
    opencodeSessionIds.set(wcId, id)
    // 惰性清理:残留的 id 只会占内存;重开标签页会生成新 id(可借此避开坏分片)
    if (opencodeSessionIds.size > 4096) opencodeSessionIds.clear()
  }
  return id
}

/**
 * 在 defaultSession 上注册 CORS 放行(标签页 / 浏览器 UI / Overlay 共用该 session)。
 * 开关与白名单每次请求实时读取,改设置立即生效;必须在任何窗口/视图创建前调用。
 */
export function setupCorsBypass(): void {
  // 观察阶段:标记预检(OPTIONS + Access-Control-Request-Method),并向 opencode.ai
  // 的请求注入会话头(官方要求,缺失会 400 MissingSessionID)
  session.defaultSession.webRequest.onBeforeSendHeaders(
    (details: OnBeforeSendHeadersListenerDetails, callback) => {
      try {
        if (isPreflightRequest(details.method, details.requestHeaders)) {
          preflightIds.add(details.id)
          // 惰性清理:请求 id 全局唯一,残留只会占内存不会误判;超阈值整体清空
          if (preflightIds.size > 5000) preflightIds.clear()
        }

        const headers = { ...details.requestHeaders }
        if (getSettingsStore().get().corsBypassEnabled && isOpenCodeHost(details.url)) {
          headers['x-opencode-session'] = sessionIdFor(details.webContentsId)
          // 统一以 bow 签名单向 opencode(与全局 UA 一致)
          headers['User-Agent'] = getBowUserAgent()
        }
        callback({ requestHeaders: headers })
      } catch (e) {
        logError('CORS 预检识别失败', e)
        callback({ requestHeaders: details.requestHeaders })
      }
    }
  )

  session.defaultSession.webRequest.onHeadersReceived(
    (details: OnHeadersReceivedListenerDetails, callback) => {
      try {
        const { corsBypassEnabled, corsWhitelist } = getSettingsStore().get()
        if (!corsBypassEnabled) {
          callback({ responseHeaders: details.responseHeaders })
          return
        }
        // 来源页 URL:fetch 等子资源请求的发起页面(如本地开发页 localhost:8517)
        const wc = details.webContents
        const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : undefined
        if (!shouldBypassCors(details.url, pageUrl, corsWhitelist)) {
          preflightIds.delete(details.id)
          callback({ responseHeaders: details.responseHeaders })
          return
        }
        const isPreflight = preflightIds.delete(details.id)
        const headers = { ...details.responseHeaders }
        headers[ACAO] = ['*']
        headers[ACAM] = ['GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS']
        headers[ACAH] = ['*']
        const response: { responseHeaders: Record<string, string[]>; statusLine?: string } = {
          responseHeaders: headers
        }
        // CORS 规范要求预检响应必须 2xx;部分服务器对 OPTIONS 返回 404/405,需把状态覆盖为
        // 200(cors-anywhere 同款做法)。非预检响应保持原状态,让应用看到真实错误码。
        if (isPreflight) {
          response.statusLine = 'HTTP/1.1 200 OK'
        }
        callback(response)
      } catch (e) {
        logError('CORS 白名单注入失败', e)
        callback({ responseHeaders: details.responseHeaders })
      }
    }
  )
  log('CORS 白名单注入已启用(含 opencode.ai 会话头)')
}