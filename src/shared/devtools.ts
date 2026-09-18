/**
 * DevTools 前端的 URL 构造(同构纯逻辑:main / 插件 / 测试都用它)。
 *
 * 为什么单独一个文件:这个「事实」有两个使用方 ——
 * 1. `main/tabManager.ts` 的 `createInspectorTab()`(把远程 CDP 目标接进前端);
 * 2. `plugins/device-inspect/shared.ts`(`frontendUrlFor()`,UI 里复制的链接与 MCP 返回体)。
 * 之前这类常量一旦写两遍就会漂移(仓库自己的教训:同一个事实只能有一份)。
 *
 * 三个不变式(写错任何一个的表现都是「白屏」,很难查):
 * 1. 入口是 `devtools://devtools/bundled/devtools_app.html` —— Electron 自带的前端资源,
 *    `inspector.html` 是历史别名(`chrome://inspect` 走的是别名),用主入口更稳;
 * 2. `ws=` 参数**必须是不带 scheme 的 host+path**(前端自己补 `ws://`);
 * 3. 远端目标要能被这个前端连上,还受目标侧 Origin 白名单限制(见计划 §1.2),
 *    这里只负责拼地址,不做连通性判断。
 */

/** Electron 自带的 DevTools 前端入口 */
export const DEVTOOLS_FRONTEND_ENTRY = 'devtools://devtools/bundled/devtools_app.html'

/** `ws://host:port/path` → `host:port/path`(devtools 前端要求的 `ws=` 形态) */
export function wsParamOf(wsUrl: string): string {
  return wsUrl.replace(/^wss?:\/\//, '')
}

/** CDP 目标地址 → 可直接 `loadURL` 的 DevTools 前端地址 */
export function devtoolsFrontendUrl(wsUrl: string): string {
  return `${DEVTOOLS_FRONTEND_ENTRY}?ws=${wsParamOf(wsUrl)}`
}

/** 是否是 DevTools 前端页面(用于快捷键策略:这类页面不该再被套一层本地 DevTools) */
export function isDevToolsFrontendUrl(url: string): boolean {
  return url.startsWith('devtools://')
}
