#!/usr/bin/env node
/**
 * CORS 白名单验证服务器(无任何依赖):
 *   - 5174 / 5175 两端口,响应一律不带 Access-Control-* 头
 *   - GET /   → 探测页(从 5174 起,自动 fetch http://127.0.0.1:5175/api)
 *   - GET /api → JSON(无 CORS 头)
 *
 * 用法:
 *   node scripts/cors-test-server.mjs
 * 然后在本浏览器打开 http://127.0.0.1:5174/ 观察探测结果:
 *   - 默认白名单(含 127.0.0.1)+ 开关开 → 成功(目标侧命中)
 *   - 从白名单移除 127.0.0.1 → 失败(CORS 拦截,证明名单外目标不受影响)
 *   - 保持移除状态,改用 http://localhost:5174/ 打开 → 成功(来源侧命中:localhost
 *     页面发起的请求被放行,哪怕目标是未入名单的 127.0.0.1)
 *   - 重新加入 / 关闭总开关 → 立即恢复/拦截(实时期效)
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const probeHtml = readFileSync(join(root, 'cors-probe.html'), 'utf8')

const HOST = '127.0.0.1'
const PORT_A = 5174 // 探测页
const PORT_B = 5175 // 无 CORS 头的 API

const handler = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  // 模拟 opencode.ai 行为:OPTIONS 一律 404,GET 正常
  if (req.method === 'OPTIONS') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }))
    return
  }
  if (url.pathname === '/api') {
    // 刻意不带任何 Access-Control-* 头
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, from: req.headers.host }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(probeHtml.replaceAll('__TARGET__', `http://${HOST}:${PORT_B}/api`))
}

const serverA = createServer(handler)
const serverB = createServer(handler)

serverA.listen(PORT_A, HOST, () => {
  serverB.listen(PORT_B, HOST, () => {
    console.log(`CORS 验证服务器已就绪`)
    console.log(`  探测页 : http://${HOST}:${PORT_A}/   (目标 http://${HOST}:${PORT_B}/api,无 CORS 头)`)
    console.log(`  停止   : Ctrl+C`)
  })
})