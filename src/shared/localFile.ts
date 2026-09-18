/**
 * 本地文件路径判定(同构纯逻辑,三端安全)。
 *
 * 地址栏输入与启动参数都要先回答同一个问题:「这是本地文件,还是搜索词 / 域名」。
 * 这里只做**形态判定**(不碰文件系统),存在性检查留在主进程的 deps.exists,
 * 于是 shared 侧可以零依赖单测,renderer 引用也安全。
 */

/** `file://` URL(只看形态,存在性检查由调用方做) */
const FILE_URL_RE = /^file:\/\//i
/** POSIX 绝对路径 */
const POSIX_ABS_RE = /^\//
/** 相对路径:./ 或 ../ */
const REL_RE = /^\.{1,2}(?:\/|$)/
/** Windows 盘符路径:打包版面向 Windows,地址栏粘贴 C:\x\y.html 也要认 */
const WIN_ABS_RE = /^[a-zA-Z]:[\\/]/
/** Windows UNC 路径:\\server\share\… */
const UNC_RE = /^\\\\[^\\/]+[\\/]/

/** 是否是 `file://` URL */
export function isFileUrl(input: string): boolean {
  return FILE_URL_RE.test(input.trim())
}

/**
 * 是否是「本地文件路径」形态:
 * - `file://…`、`/abs/…`、`~/…`、`./`、`../`、`C:\…`、`\\server\share\…`;
 * - `file.html`、`example.com` 这类**不是** —— 它们继续走域名 / 搜索判定(与现状一致)。
 *
 * ⚠️ `C:\x\a.html` 同时也是「拿 `C:` 当协议」的合法形态,所以调用方**必须先判本函数、再判带 scheme 的参数**。
 * 反例就是 `src/main/openArgs.ts` 曾经的写法:先判 scheme → Windows 盘符路径全被当成「不支持的协议」丢掉
 * → 「用 bow 打开 html」在 Windows 上完全没反应(openArgs.test.ts 有看住这个顺序的回归用例)。
 *
 * `~user` 不识别(只认 `~` 与 `~/`),避免把 `~foo` 当成家目录展开。
 */
export function looksLikeLocalPath(input: string): boolean {
  const raw = input.trim()
  if (!raw) return false
  if (raw === '~' || raw.startsWith('~/')) return true
  return (
    isFileUrl(raw) || POSIX_ABS_RE.test(raw) || REL_RE.test(raw) || WIN_ABS_RE.test(raw) || UNC_RE.test(raw)
  )
}

/** 展开开头的 `~`(只处理 `~` 与 `~/…`);剩余相对路径仍由调用方解析 */
export function expandHome(input: string, home: string): string {
  const raw = input.trim()
  if (raw === '~') return home
  if (raw.startsWith('~/')) return home.replace(/\/+$/, '') + raw.slice(1)
  return raw
}
