/**
 * 网络钩子宿主:内核独占 defaultSession 的三个 webRequest 监听,
 * 按插件激活顺序链式调用插件钩子;单插件抛错只记日志、不中断其他插件。
 */

import { session, webContents } from 'electron'
import type { NetHook, NetHookContext, NetPhase } from '@shared/plugins'
import { log, logError } from '../logger'

const PHASES: NetPhase[] = ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived']

interface NetHookReg {
  pluginId: string
  phase: NetPhase
  handler: NetHook
}

interface DetailsLike {
  id: number
  url: string
  method: string
  resourceType: string
  webContentsId?: number
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[] | string>
  statusLine?: string
}

class NetContext implements NetHookContext {
  readonly phase: NetPhase
  readonly requestId: number
  readonly url: string
  readonly method: string
  readonly resourceType: string
  readonly webContentsId?: number
  readonly pageUrl?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[] | string>
  statusLine?: string
  canceled = false
  redirectURL?: string

  constructor(phase: NetPhase, details: DetailsLike, pageUrl?: string) {
    this.phase = phase
    this.requestId = details.id
    this.url = details.url
    this.method = details.method
    this.resourceType = details.resourceType
    this.webContentsId = details.webContentsId
    this.pageUrl = pageUrl
    this.requestHeaders = details.requestHeaders ? { ...details.requestHeaders } : undefined
    this.responseHeaders = details.responseHeaders ? { ...details.responseHeaders } : undefined
    this.statusLine = details.statusLine
  }

  cancel(): void {
    this.canceled = true
  }

  redirect(url: string): void {
    this.canceled = true
    this.redirectURL = url
  }
}

function pageUrlOf(details: DetailsLike): string | undefined {
  const id = details.webContentsId
  if (id == null) return undefined
  try {
    const wc = webContents.fromId(id)
    return wc && !wc.isDestroyed() ? wc.getURL() : undefined
  } catch {
    return undefined
  }
}

export class NetHookHost {
  private hooks: Record<NetPhase, NetHookReg[]> = {
    onBeforeRequest: [],
    onBeforeSendHeaders: [],
    onHeadersReceived: []
  }
  private installed = false

  /** 必须在任何窗口/视图创建前调用(defaultSession 的 chrome 窗口请求也要覆盖) */
  install(): void {
    if (this.installed) return
    this.installed = true
    const s = session.defaultSession.webRequest

    s.onBeforeRequest((details, callback) => {
      const ctx = new NetContext('onBeforeRequest', details as DetailsLike)
      this.run('onBeforeRequest', ctx)
      if (ctx.canceled) {
        callback(ctx.redirectURL ? { redirectURL: ctx.redirectURL } : { cancel: true })
        return
      }
      callback({})
    })

    s.onBeforeSendHeaders((details, callback) => {
      const ctx = new NetContext('onBeforeSendHeaders', details as DetailsLike, pageUrlOf(details as DetailsLike))
      this.run('onBeforeSendHeaders', ctx)
      callback({ requestHeaders: ctx.requestHeaders ?? details.requestHeaders })
    })

    s.onHeadersReceived((details, callback) => {
      const ctx = new NetContext('onHeadersReceived', details as DetailsLike, pageUrlOf(details as DetailsLike))
      this.run('onHeadersReceived', ctx)
      const response: Electron.HeadersReceivedResponse = {
        responseHeaders: ctx.responseHeaders ?? details.responseHeaders
      }
      if (ctx.statusLine) response.statusLine = ctx.statusLine
      callback(response)
    })

    log('插件网络钩子宿主已启用')
  }

  add(pluginId: string, phase: NetPhase, handler: NetHook): () => void {
    const reg: NetHookReg = { pluginId, phase, handler }
    this.hooks[phase].push(reg)
    return () => {
      const arr = this.hooks[phase]
      const i = arr.indexOf(reg)
      if (i >= 0) arr.splice(i, 1)
    }
  }

  removeByPlugin(pluginId: string): void {
    for (const phase of PHASES) {
      this.hooks[phase] = this.hooks[phase].filter((h) => h.pluginId !== pluginId)
    }
  }

  /** 顺序执行某一阶段的钩子;cancel/redirect 会短路后续钩子 */
  run(phase: NetPhase, ctx: NetHookContext): void {
    for (const h of this.hooks[phase]) {
      if (ctx.canceled) break
      try {
        h.handler(ctx)
      } catch (e) {
        logError('插件网络钩子失败', h.pluginId, phase, e)
      }
    }
  }
}
