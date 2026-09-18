/** 浏览器签名纯逻辑(三端安全,无 Electron 依赖):把默认 UA 改写为 bow 签名 */

export const BROWSER_NAME = 'bow'

/**
 * Linux 桌面集成标识(`app.setDesktopName` 的值,也是已安装 .desktop 文件的基名)。
 * 三处必须逐字一致:这里、`package.json` 的 `build.appId`、
 * `src/plugins/default-browser/linuxDesktop.ts` 生成的 `~/.local/share/applications/<id>.desktop`。
 * 不一致的后果:Wayland `app_id` / X11 `WM_CLASS` 对不上 .desktop 文件 → 图标与窗口分组错乱。
 */
export const APP_DESKTOP_NAME = 'com.ruinb0w.bow'

/**
 * 把 Electron 真实默认 UA(appName/appVersion + Electron 令牌)改写为 bow 签名:
 * - 删除 `Electron/<version>` 令牌(网站据此识别 Electron)
 * - 把 `<appName>/<appVersion>` 产品令牌替换为 `bow/<appVersion>`
 *   (UA 中不存在该令牌时为 no-op)
 * - 折叠改写产生的连续空格
 * 平台段、AppleWebKit、Chrome、Safari 令牌保持原样,与真实引擎一致,
 * 避免「UA 声称的版本」与「实际 Chromium 引擎」不一致反而被风控识别。
 */
export function bowUserAgent(baseUa: string, appName: string, appVersion: string): string {
  const withoutElectron = baseUa.replace(/Electron\/[\d.]+/g, '')
  // 按名称匹配 app 令牌、版本跟随传入值(appName 可能含正则元字符,先转义)
  const appNameEsc = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const withBow = withoutElectron.replace(new RegExp(`${appNameEsc}\\/[\\d.]+`), `${BROWSER_NAME}/${appVersion}`)
  return withBow.replace(/\s{2,}/g, ' ').trim()
}