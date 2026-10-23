/**
 * 远程静态服务:URL 路径 → 磁盘文件,**只允许** `root` 目录内的已知扩展名。
 *
 * 纯逻辑(注入读文件),因为这是「把本机目录暴露给浏览器」的边界,必须能单测:
 * 路径穿越(`..`、编码后的 `%2e%2e`)、绝对路径、符号链接、未知扩展名全部拒。
 */

import { extname, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

export interface StaticFile {
  status: number
  /** 响应头(content-type / cache-control) */
  headers: Record<string, string>
  body: Buffer
}

/**
 * URL 路径 → 允许的绝对路径。不合法返回 null。
 *
 * 判定顺序刻意「先归一化再比较」:解码 → 拼到 root → `resolve` 掉 `..` → 再看是否仍在 root 里。
 * 只比字符串前缀会被 `../remote-evil` 绕过,所以比较时要带分隔符。
 */
export function resolveStaticPath(root: string, urlPath: string, knownExtensions = Object.keys(MIME)): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null // 坏的百分号编码
  }
  if (decoded.includes('\0')) return null
  const clean = decoded.split('?')[0].split('#')[0]
  // 目录 → index.html;'/' 也当目录
  const rel = clean === '/' || clean === '' ? 'index.html' : clean.replace(/^\/+/, '')
  if (!rel || rel.includes('..')) return null
  const rootAbs = resolve(root)
  const target = resolve(rootAbs, rel)
  // 必须仍在 root 下(带分隔符比较,避免同前缀的兄弟目录)
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null
  if (!knownExtensions.includes(extname(target).toLowerCase())) return null
  return target
}

export function contentTypeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 读一个静态文件。`readFile` 注入(单测给假函数)。
 * `root` 不存在(没跑 `build:remote`)时给 503 + 一句人话,而不是空 404。
 */
export async function readStaticFile(
  root: string,
  urlPath: string,
  readFile: (path: string) => Promise<Buffer>
): Promise<StaticFile> {
  const target = resolveStaticPath(root, urlPath)
  if (!target) return { status: 404, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":false}') }
  try {
    const body = await readFile(target)
    return {
      status: 200,
      headers: {
        'content-type': contentTypeOf(target),
        // 远程页会随 bow 版本变化,文件没 hash —— 一律不缓存,免得手机上永远是旧页面
        'cache-control': 'no-store'
      },
      body
    }
  } catch {
    const message = JSON.stringify({ ok: false, error: '远程页还没构建:先跑 npm run build:remote' })
    return {
      status: target.endsWith('index.html') ? 503 : 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from(message)
    }
  }
}
