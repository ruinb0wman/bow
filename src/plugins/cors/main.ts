/**
 * CORS 放行插件:对白名单主机的响应注入 Access-Control-Allow-* 头,名单外主机零干扰。
 *
 * 由核心 cors.ts 迁入:设置从 settings.json 的 corsBypassEnabled / corsWhitelist 一次性迁移到
 * cors.json(JsonStore 以文件内容覆盖默认值,故迁移天然幂等)。
 */

import { buildCorsResponseHeaders, isPreflightRequest, shouldBypassCors } from '@shared/cors'
import type { NetHookContext } from '@shared/plugins'
import { getSettingsStore } from '../../main/stores'
import type { PluginContext, PluginMain } from '../../main/plugins/types'

interface CorsSettings {
  enabled: boolean
  whitelist: string[]
}

/** 大小写不敏感地读请求头:Electron 对头名大小写的保留不稳定 */
function readRequestHeader(
  headers: Record<string, string> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
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

    /**
     * 预检请求记录:onHeadersReceived 阶段读不到请求头,只能靠 onBeforeSendHeaders 识别。
     * 记下请求声明的 method / headers,响应阶段原样回显 —— 带凭据时通配符不生效。
     */
    const preflights = new Map<number, { method?: string; headers?: string }>()

    ctx.net.onBeforeSendHeaders((c: NetHookContext) => {
      if (!isPreflightRequest(c.method, c.requestHeaders)) return
      preflights.set(c.requestId, {
        method: readRequestHeader(c.requestHeaders, 'access-control-request-method'),
        headers: readRequestHeader(c.requestHeaders, 'access-control-request-headers')
      })
      // 有界内存:异常请求(如 id 不复用)会让 Map 无上限增长
      if (preflights.size > 5000) preflights.clear()
    })

    ctx.net.onHeadersReceived((c: NetHookContext) => {
      const { enabled, whitelist } = store.get()
      // 取出即删:无论是否注入都不留悬挂条目
      const preflight = preflights.get(c.requestId)
      if (preflight) preflights.delete(c.requestId)
      if (!enabled) return
      // 名单外主机零干扰
      if (!shouldBypassCors(c.url, c.pageUrl, whitelist)) return
      Object.assign(
        (c.responseHeaders ??= {}),
        buildCorsResponseHeaders({
          requestedMethod: preflight?.method,
          requestedHeaders: preflight?.headers
        })
      )
      // CORS 规范要求预检响应必须 2xx;部分服务器(尤其 WebDAV)对 OPTIONS 返回 404/405
      if (preflight) c.statusLine = 'HTTP/1.1 200 OK'
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
