/**
 * 把代理配置落实到 Chromium（`session.setProxy`）—— 网页请求与 `net.fetch` 都吃这一份配置。
 *
 * 为什么要写这一层（实测 2026-10-29）：Electron 主进程里 Node 的 `fetch` **不读** 系统代理，
 * 也不读 `HTTP(S)_PROXY`；而 Chromium 只认系统代理（Windows 上就是「系统代理」开关，
 * Linux 上没有系统代理时等于直连）。所以显式设一次，网页才真的走用户配的代理。
 */

import { app, net, session } from 'electron'
import { getSettingsStore } from './stores'
import { resolveProxy } from '@shared/proxy'
import type { ProxyDecision } from '@shared/proxy'
import { log } from './logger'

/** 终端里设的代理（兜底用：设置里手动配过就以设置为准） */
export function envProxy(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    undefined
  )
}

/** 当前实际生效的代理（设置页要显示「来自设置 / 来自环境变量 / 系统默认」） */
export function currentProxy(): ProxyDecision {
  return resolveProxy(getSettingsStore().get(), envProxy())
}

/** Chromium **实际**解析出来的代理（如 `PROXY 127.0.0.1:7890` / `DIRECT`）—— 排查时的唯一真相 */
export async function resolvedProxy(): Promise<string> {
  try {
    return await session.defaultSession.resolveProxy('https://clients2.google.com/')
  } catch {
    return 'UNKNOWN'
  }
}

/**
 * 应用当前代理。返回决策，方便调用方记日志。
 * 用户显式传了 `--proxy-server` 的话不动它（那是更外层的显式意图）。
 */
export async function applyProxy(): Promise<ProxyDecision> {
  const decision = currentProxy()
  const s = session.defaultSession

  if (app.commandLine.hasSwitch('proxy-server')) {
    log('检测到 --proxy-server,跳过 session 代理设置')
    return decision
  }

  try {
    if (decision.kind === 'manual') await s.setProxy({ proxyRules: decision.server })
    else if (decision.kind === 'direct') await s.setProxy({ mode: 'direct' })
    else await s.setProxy({ mode: 'system' })
  } catch (e) {
    log('设置代理失败', String(e))
  }

  log(
    '代理',
    decision.kind === 'manual'
      ? `${decision.server}（来自${decision.source === 'settings' ? '设置' : '环境变量'}）`
      : decision.kind === 'direct'
        ? '直连'
        : '跟随系统'
  )
  return decision
}

/** 把网络错误摊成人能读的一句（`net::ERR_*` 原样保留，那是排查时唯一有用的信息） */
function describeNetError(err: unknown, proxy: string | undefined): string {
  const e = (err ?? {}) as { message?: string; cause?: { code?: string; message?: string } }
  const code = e.cause?.code ?? e.cause?.message
  const base = `${e.message ?? String(err)}${code ? `(${code})` : ''}`
  return proxy ? `${base} —— 当前代理 ${proxy}` : `${base} —— 当前直连`
}

/** 设置页的「测试连接」：真实拉一次中立站点，任何 HTTP 状态都算网络通 */
export async function testProxy(): Promise<{ ok: boolean; detail: string }> {
  const started = Date.now()
  try {
    const res = await net.fetch('https://example.com/', { signal: AbortSignal.timeout(10_000) })
    return { ok: true, detail: `HTTP ${res.status} · ${Date.now() - started}ms` }
  } catch (e) {
    const decision = currentProxy()
    return { ok: false, detail: describeNetError(e, decision.kind === 'manual' ? decision.server : undefined) }
  }
}
