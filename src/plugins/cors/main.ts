/**
 * CORS 放行插件:对白名单主机的响应注入 Access-Control-Allow-* 头,名单外主机零干扰。
 * 同时保留 opencode.ai 的稳定会话头注入(官方要求)。
 *
 * 由核心 cors.ts 迁入:设置从 settings.json 的 corsBypassEnabled / corsWhitelist 一次性迁移到
 * cors.json(JsonStore 以文件内容覆盖默认值,故迁移天然幂等)。
 */

import { randomUUID } from 'node:crypto'
import { isOpenCodeHost, isPreflightRequest, shouldBypassCors } from '@shared/cors'
import type { NetHookContext } from '@shared/plugins'
import { getSettingsStore } from '../../main/stores'
import { getBowUserAgent } from '../../main/ua'
import type { PluginContext, PluginMain } from '../../main/plugins/types'

const ACAO = 'Access-Control-Allow-Origin'
const ACAM = 'Access-Control-Allow-Methods'
const ACAH = 'Access-Control-Allow-Headers'

interface CorsSettings {
  enabled: boolean
  whitelist: string[]
}

const plugin: PluginMain = {
  manifest: {
    id: 'cors',
    name: 'CORS 放行',
    description: '为白名单主机的跨域请求注入放行头,并注入 opencode 会话头',
    version: '1.0.0'
  },
  capabilities: ['ui', 'net'],

  activate(ctx: PluginContext): void {
    const core = getSettingsStore().get()
    const store = ctx.storage<CorsSettings>({
      file: 'cors.json',
      defaults: {
        enabled: core.corsBypassEnabled ?? true,
        whitelist: core.corsWhitelist ?? []
      }
    })

    /** 预检请求 id 记录:onHeadersReceived 阶段读不到请求头,只能靠 onBeforeSendHeaders 识别 */
    const preflightIds = new Set<number>()
    /** Opencode Go/Zen 要求请求携带每个会话稳定不变的 x-opencode-session */
    const opencodeSessionIds = new Map<number, string>()
    const FALLBACK_SESSION = randomUUID()

    const sessionIdFor = (wcId: number | undefined): string => {
      if (wcId == null) return FALLBACK_SESSION
      let id = opencodeSessionIds.get(wcId)
      if (!id) {
        id = randomUUID()
        opencodeSessionIds.set(wcId, id)
        // 惰性清理:残留只占内存;重开标签页会生成新 id(可借此避开坏分片)
        if (opencodeSessionIds.size > 4096) opencodeSessionIds.clear()
      }
      return id
    }

    ctx.net.onBeforeSendHeaders((c: NetHookContext) => {
      if (isPreflightRequest(c.method, c.requestHeaders)) {
        preflightIds.add(c.requestId)
        if (preflightIds.size > 5000) preflightIds.clear()
      }
      if (!store.get().enabled) return
      if (!isOpenCodeHost(c.url)) return
      const headers = c.requestHeaders ?? {}
      headers['x-opencode-session'] = sessionIdFor(c.webContentsId)
      // 统一以 bow 签名单向 opencode(与全局 UA 一致)
      headers['User-Agent'] = getBowUserAgent()
      c.requestHeaders = headers
    })

    ctx.net.onHeadersReceived((c: NetHookContext) => {
      const { enabled, whitelist } = store.get()
      if (!enabled) return
      if (!shouldBypassCors(c.url, c.pageUrl, whitelist)) {
        preflightIds.delete(c.requestId)
        return
      }
      const isPreflight = preflightIds.delete(c.requestId)
      const headers = c.responseHeaders ?? {}
      headers[ACAO] = ['*']
      headers[ACAM] = ['GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS']
      headers[ACAH] = ['*']
      c.responseHeaders = headers
      // CORS 规范要求预检响应必须 2xx;部分服务器对 OPTIONS 返回 404/405,需覆盖为 200
      if (isPreflight) c.statusLine = 'HTTP/1.1 200 OK'
    })

    ctx.ipc.handle('getSettings', (): CorsSettings => store.get())
    ctx.ipc.handle('setSettings', (patch: Partial<CorsSettings>): CorsSettings => {
      const next = store.set(patch)
      ctx.ipc.emit('changed', next)
      return next
    })
  }
}

export default plugin
