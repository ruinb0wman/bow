/**
 * 夸克网盘插件(主进程侧)。
 *
 * 两件事:
 * 1. **读页面**(`ctx.pages.execute` + `EXTRACT_JS`)拿当前目录的 fid / 文件名 / 大小;
 * 2. **取直链并推给 aria2**:`net.fetch` POST 官方接口(伪装 PC 客户端 UA + cookie 域罐里的登录态),
 *    再用 JSON-RPC `aria2.addUri` 把「直链 + UA/Referer/Cookie」交给 aria2。
 *
 * 为什么下载是 aria2 而不是 bow 自己的下载器:aria2 是独立进程,**拿不到浏览器的 cookie 域罐**,
 * 所以三个请求头必须由这里显式传过去 —— 也就更需要域名白名单把关(见 `isCookieHostAllowed`)。
 * 详见 `.pi/plans/2026-09-24-quark-plugin/plan.md`。
 */

import { net, session } from 'electron'
import type { PluginContext, PluginMain, PluginStorage } from '../../main/plugins/types'
import { EXTRACT_JS } from './scripts'
import {
  DEFAULT_QUARK_SETTINGS,
  QUARK_API_URL,
  QUARK_BATCH_DELAY_MS,
  QUARK_BATCH_SIZE,
  aria2RpcUrl,
  buildApiHeaders,
  buildAria2Headers,
  buildAria2RpcBody,
  buildDownloadBody,
  chunk,
  cookieHeaderFrom,
  describeLinkHosts,
  formatBytes,
  isCookieHostAllowed,
  isQuarkHomeUrl,
  normalizePageSnapshot,
  normalizeQuarkSettings,
  parseDownloadResponse,
  selectFiles,
  type QuarkDiagnostics,
  type QuarkFile,
  type QuarkLink,
  type QuarkPageSnapshot,
  type QuarkSettings
} from './shared'

/** 页面脚本超时 */
const PAGE_SCRIPT_TIMEOUT_MS = 5_000

interface PageRead {
  ok: true
  tabId: number
  snapshot: QuarkPageSnapshot
}

type PageReadFailure = { ok: false; error: string; diagnostics?: QuarkDiagnostics }

interface LinkResult {
  ok: true
  links: QuarkLink[]
}

type LinkFailure = {
  ok: false
  reason: string
  message: string
  code?: number
  fid?: string
  status?: number
  raw?: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function createQuarkPlugin(): PluginMain {
  let store: PluginStorage<QuarkSettings> | null = null

  const settingsOf = (): QuarkSettings => normalizeQuarkSettings(store?.get(), DEFAULT_QUARK_SETTINGS)

  /** 读页面:先校验活动标签是夸克个人网盘页,再执行抽取脚本 */
  const readPage = async (ctx: PluginContext, tabId?: number): Promise<PageRead | PageReadFailure> => {
    const target = tabId ?? ctx.pages.activeTabId() ?? undefined
    const tab = target != null ? ctx.tabs.list().find((t) => t.id === target) : ctx.tabs.getActive()
    if (!tab) return { ok: false, error: '没有可用的标签页' }
    if (!isQuarkHomeUrl(tab.url)) {
      return { ok: false, error: `当前标签不是夸克个人网盘页(${tab.url || '空地址'})` }
    }
    let raw: unknown
    try {
      raw = await ctx.pages.execute(tab.id, EXTRACT_JS, { timeoutMs: PAGE_SCRIPT_TIMEOUT_MS })
    } catch (e) {
      return { ok: false, error: `在页面里读取文件列表失败:${e instanceof Error ? e.message : String(e)}` }
    }
    const normalized = normalizePageSnapshot(raw)
    if (!normalized.ok) {
      return {
        ok: false,
        error: normalized.error,
        ...(normalized.diagnostics ? { diagnostics: normalized.diagnostics } : {})
      }
    }
    return { ok: true, tabId: tab.id, snapshot: normalized.snapshot }
  }

  /**
   * 从 cookie 域罐里取夸克登录态。
   * 读两份并按 name 去重:页面域的 + `quark.cn` 域级的(后者才覆盖 drive-pc / CDN 子域)。
   */
  const readCookieHeader = async (): Promise<string> => {
    try {
      const ses = session.defaultSession
      const [byUrl, byDomain] = await Promise.all([
        ses.cookies.get({ url: 'https://pan.quark.cn/' }),
        ses.cookies.get({ domain: 'quark.cn' })
      ])
      const seen = new Map<string, string>()
      for (const c of [...byDomain, ...byUrl]) {
        if (c?.name && !seen.has(c.name)) seen.set(c.name, c.value)
      }
      return cookieHeaderFrom([...seen.entries()].map(([name, value]) => ({ name, value })))
    } catch {
      return ''
    }
  }

  /** 调官方接口取直链;分批 + 节流 */
  const fetchLinks = async (ctx: PluginContext, fids: string[]): Promise<LinkResult | LinkFailure> => {
    const s = settingsOf()
    const cookie = await readCookieHeader()
    const headers = buildApiHeaders({ ua: s.userAgent, cookie })
    const links: QuarkLink[] = []
    const batches = chunk(fids, QUARK_BATCH_SIZE)
    for (let i = 0; i < batches.length; i++) {
      if (i > 0) await sleep(QUARK_BATCH_DELAY_MS)
      let status = 0
      let text = ''
      try {
        const res = await net.fetch(QUARK_API_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildDownloadBody(batches[i]))
        })
        status = res.status
        text = await res.text()
      } catch (e) {
        return {
          ok: false,
          reason: 'network',
          message: `请求夸克接口失败:${e instanceof Error ? e.message : String(e)}`
        }
      }
      let json: unknown = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      const parsed = parseDownloadResponse(json)
      if (!parsed.ok) {
        return {
          ok: false,
          reason: parsed.reason,
          message: parsed.message,
          ...(parsed.code !== undefined ? { code: parsed.code } : {}),
          ...(parsed.fid !== undefined ? { fid: parsed.fid } : {}),
          status,
          raw: text.slice(0, 1000)
        }
      }
      links.push(...parsed.links)
    }
    ctx.log('取到直链', links.length, '条;域名', JSON.stringify(describeLinkHosts(links)))
    return { ok: true, links }
  }

  interface Aria2Outcome {
    fid: string
    name: string
    ok: boolean
    error?: string
  }

  interface Aria2Result {
    ok: boolean
    results: Aria2Outcome[]
    error?: string
    /** 直链域名聚合(面板诊断区) */
    hosts?: Array<{ host: string; count: number }>
    /** 接口失败时的原始响应体片段(面板诊断区) */
    raw?: string
  }

  /** 读页面 → 选文件 → 取直链 → 逐条推送 aria2 RPC */
  const pushAria2 = async (
    ctx: PluginContext,
    input: { tabId?: number; fids?: unknown; names?: unknown }
  ): Promise<Aria2Result> => {
    const page = await readPage(ctx, input.tabId)
    if (!page.ok) return { ok: false, results: [], error: page.error }
    const chosen = selectFiles(page.snapshot.files, { fids: input.fids, names: input.names })
    if (chosen.length === 0) return { ok: false, results: [], error: '没有匹配到要推送的文件' }

    const fetched = await fetchLinks(ctx, chosen.map((f) => f.fid))
    if (!fetched.ok) {
      return {
        ok: false,
        results: [],
        error: fetched.message,
        ...(fetched.raw ? { raw: fetched.raw } : {})
      }
    }

    const s = settingsOf()
    const headers = buildAria2Headers({ ua: s.userAgent })
    const cookie = await readCookieHeader()
    const url = aria2RpcUrl(s.aria2)
    const results: Aria2Outcome[] = []

    for (const link of fetched.links) {
      if (!link.url) {
        results.push({ fid: link.fid, name: link.name, ok: false, error: '接口没有返回这个文件的直链' })
        continue
      }
      // aria2 是独立进程,拿不到浏览器 cookie 域罐 → Cookie 必须显式传;
      // 而它可能会跟着重定向跑到别的域名上,所以只在白名单命中时才给(空白名单 = 不给)。
      const fullHeaders =
        cookie && isCookieHostAllowed(link.host, s.cookieHosts) ? { ...headers, Cookie: cookie } : headers
      try {
        const res = await net.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            buildAria2RpcBody({ url: link.url, filename: link.name, headers: fullHeaders, settings: s.aria2 })
          )
        })
        const text = await res.text()
        let body: unknown = null
        try {
          body = JSON.parse(text)
        } catch {
          body = null
        }
        const gid = (body as { result?: unknown } | null)?.result
        if (typeof gid === 'string' && gid) {
          results.push({ fid: link.fid, name: link.name, ok: true })
        } else {
          const err = (body as { error?: { message?: string } } | null)?.error?.message
          results.push({ fid: link.fid, name: link.name, ok: false, error: err ?? `RPC 返回异常(status=${res.status})` })
        }
      } catch (e) {
        results.push({ fid: link.fid, name: link.name, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return { ok: results.some((r) => r.ok), results, hosts: describeLinkHosts(fetched.links) }
  }

  const briefFiles = (files: QuarkFile[]): Array<Record<string, unknown>> =>
    files.map((f) => ({ fid: f.fid, name: f.name, size: f.size, sizeText: formatBytes(f.size), isFile: f.isFile }))

  return {
    manifest: {
      id: 'quark',
      name: '夸克网盘',
      description: '在夸克网盘个人页取文件直链并推送到 aria2 RPC(自动伪装 PC 客户端 UA)',
      version: '1.0.0'
    },
    capabilities: ['ui'],

    activate(ctx: PluginContext): void {
      store = ctx.storage<QuarkSettings>({ file: 'quark.json', defaults: DEFAULT_QUARK_SETTINGS })

      // ---------- IPC 面 ----------
      ctx.ipc.handle('getSettings', (): QuarkSettings => settingsOf())

      ctx.ipc.handle('setSettings', (patch: unknown): QuarkSettings => {
        const next = normalizeQuarkSettings(patch, settingsOf())
        store?.setRaw(next)
        return next
      })

      ctx.ipc.handle('listFiles', async (tabId?: number) => {
        const page = await readPage(ctx, tabId)
        if (!page.ok) {
          return { ok: false, error: page.error, ...(page.diagnostics ? { diagnostics: page.diagnostics } : {}) }
        }
        return {
          ok: true,
          url: page.snapshot.url,
          folderName: page.snapshot.folderName,
          files: briefFiles(page.snapshot.files),
          selected: page.snapshot.selected,
          diagnostics: page.snapshot.diagnostics
        }
      })

      ctx.ipc.handle('pushAria2', async (input?: { tabId?: number; fids?: unknown; names?: unknown }) =>
        pushAria2(ctx, input ?? {})
      )

      ctx.ipc.handle('testAria2', async () => {
        const s = settingsOf()
        try {
          const res = await net.fetch(aria2RpcUrl(s.aria2), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: Date.now(),
              jsonrpc: '2.0',
              method: 'aria2.getVersion',
              params: [`token:${s.aria2.token.trim()}`]
            })
          })
          const text = await res.text()
          const version = (JSON.parse(text) as { result?: { version?: string } } | null)?.result?.version
          return version ? { ok: true, version } : { ok: false, error: `RPC 返回异常(status=${res.status})` }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      })

      ctx.log('夸克插件已就绪;UA=', settingsOf().userAgent.slice(0, 60) + '…')
    },

    deactivate(): void {
      store = null
    }
  }
}

export default createQuarkPlugin()
