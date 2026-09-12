/** 字母头像与主题色:标签条、收藏磁贴共用 */

/** 标题首字母大写;空标题返回占位符 */
export function faviconLetter(title: string): string {
  const t = title?.trim() ?? ''
  return t ? t[0].toUpperCase() : '·'
}

/** 域名哈希 → 色相(0-360),同一域名字母头像颜色稳定 */
export function domainHue(url: string): number {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = url
  }
  let h = 0
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0
  return h % 360
}