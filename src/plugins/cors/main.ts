/**
 * CORS 放行插件:对白名单主机的响应注入 Access-Control-Allow-* 头,名单外主机零干扰。
 *
 * 由核心 cors.ts 迁入:设置从 settings.json 的 corsBypassEnabled / corsWhitelist 一次性迁移到
 * cors.json(JsonStore 以文件内容覆盖默认值,故迁移天然幂等)。
 */

import { isPreflightRequest, shouldBypassCors } from '@shared/cors'
import type { NetHookContext } from '@shared/plugins'
import { getSettingsStore } from '../../main/stores'
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
    description: '为白名单主机的跨域请求注入放行头',
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

    ctx.net.onBeforeSendHeaders((c: NetHookContext) => {
      if (isPreflightRequest(c.method, c.requestHeaders)) {
        preflightIds.add(c.requestId)
        if (preflightIds.size > 5000) preflightIds.clear()
      }
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
