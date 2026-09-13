/** 广告/追踪拦截参考插件的纯逻辑:静态主机清单匹配(可单测) */

import { hostMatches, hostOf } from '@shared/pluginMatch'

/** 小型静态清单(演示用,非 EasyList):apex 域名同时覆盖其子域 */
export const DEFAULT_BLOCKLIST: string[] = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagservices.com',
  'googleadservices.com',
  'adservice.google.com',
  'scorecardresearch.com',
  'adnxs.com',
  'criteo.com',
  'taboola.com',
  'outbrain.com',
  '2mdn.net',
  'moatads.com',
  'adsafeprotected.com'
]

/** 用于隐藏常见广告位的 CSS(内容注入演示) */
export const HIDE_ADS_CSS = [
  '.adsbygoogle',
  'ins.adsbygoogle',
  '[id^="google_ads_"]',
  '[id^="div-gpt-ad"]',
  '[class*="sponsored-ad"]',
  'iframe[src*="doubleclick.net"]'
].join(',\n') + ' { display: none !important; }'

/** 内容注入标记:便于页面侧/调试观察插件是否生效 */
export const MARK_ADS_JS = "document.documentElement.setAttribute('data-bow-adblock', '1')"

export function matchBlockedHost(host: string, rules: string[]): boolean {
  return rules.some((rule) => hostMatches(host, rule))
}

export function isBlockedUrl(url: string, rules: string[]): boolean {
  const host = hostOf(url)
  if (!host) return false
  return matchBlockedHost(host, rules)
}
