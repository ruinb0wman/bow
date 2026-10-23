/**
 * 远程静态服务:路径穿越 / 扩展名白名单 / 目录入口 / 构建产物缺失。
 *
 * 这是「把本机目录暴露给浏览器」的唯一一道边界,所以每个拒绝分支都单独看住。
 * 纯逻辑(读文件注入),不碰真实磁盘。
 */

import { describe, expect, it } from 'vitest'
import { contentTypeOf, readStaticFile, resolveStaticPath } from '../src/plugins/terminal/remote/static'

const ROOT = '/app/out/remote'

async function read(root: string, urlPath: string, files: Record<string, string> = {}) {
  return readStaticFile(root, urlPath, async (path) => {
    if (path in files) return Buffer.from(files[path]!)
    throw new Error('ENOENT')
  })
}

describe('resolveStaticPath', () => {
  it('目录与根都落到 index.html', () => {
    expect(resolveStaticPath(ROOT, '/')).toBe(`${ROOT}/index.html`)
    expect(resolveStaticPath(ROOT, '')).toBe(`${ROOT}/index.html`)
    expect(resolveStaticPath(ROOT, '/index.html')).toBe(`${ROOT}/index.html`)
  })

  it('正常资源放行,查询串被忽略', () => {
    expect(resolveStaticPath(ROOT, '/app.js')).toBe(`${ROOT}/app.js`)
    expect(resolveStaticPath(ROOT, '/app.js?v=2')).toBe(`${ROOT}/app.js`)
    expect(resolveStaticPath(ROOT, '/app.css#x')).toBe(`${ROOT}/app.css`)
  })

  it('路径穿越一律拒(含编码形式)', () => {
    for (const bad of [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/./../../x.js',
      '//etc/passwd',
      '/a/../../b.js',
      '/x%00.js'
    ]) {
      expect(resolveStaticPath(ROOT, bad)).toBeNull()
    }
  })

  it('只给白名单扩展名', () => {
    expect(resolveStaticPath(ROOT, '/notes.txt')).toBeNull()
    expect(resolveStaticPath(ROOT, '/../../etc/passwd')).toBeNull()
    // 允许被显式扩展白名单时放行
    expect(resolveStaticPath(ROOT, '/notes.txt', ['.txt'])).toBe(`${ROOT}/notes.txt`)
  })

  it('同前缀的兄弟目录不能绕过', () => {
    expect(resolveStaticPath('/app/out/remote', '/../remote-evil/x.js')).toBeNull()
  })

  it('坏的百分号编码不抛,返回 null', () => {
    expect(resolveStaticPath(ROOT, '/%E0%A4%A')).toBeNull()
  })
})

describe('contentTypeOf', () => {
  it('常见类型有正确 MIME,未知回落 octet-stream', () => {
    expect(contentTypeOf('/x/app.js')).toContain('text/javascript')
    expect(contentTypeOf('/x/app.css')).toContain('text/css')
    expect(contentTypeOf('/x/index.html')).toContain('text/html')
    expect(contentTypeOf('/x/a.woff2')).toBe('font/woff2')
    expect(contentTypeOf('/x/a.unknown')).toBe('application/octet-stream')
  })
})

describe('readStaticFile', () => {
  it('读到的文件带 MIME 与 no-store(远程页不该被手机缓存住)', async () => {
    const res = await read(ROOT, '/app.js', { [`${ROOT}/app.js`]: 'console.log(1)' })
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body.toString()).toBe('console.log(1)')
  })

  it('不合法的路径 404,而且不带任何文件内容', async () => {
    const res = await read(ROOT, '/../secret.txt', { '/app/out/secret.txt': 'TOP SECRET' })
    expect(res.status).toBe(404)
    expect(res.body.toString()).not.toContain('TOP SECRET')
  })

  it('没跑 build:remote 时 index 给 503 + 人话', async () => {
    const res = await read(ROOT, '/')
    expect(res.status).toBe(503)
    expect(res.body.toString()).toContain('build:remote')
  })

  it('资源文件缺失给 404(不给 503:那不是构建问题)', async () => {
    const res = await read(ROOT, '/app.js')
    expect(res.status).toBe(404)
  })
})
