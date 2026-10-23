/**
 * 本地 HTTP 请求助手(测试专用,**不走 fetch**)。
 *
 * 为什么不用 `fetch`:这台机器设了 `HTTP_PROXY`,本机某些路径会被代理接管 ——
 * 表现是「连一个已经关掉的端口不报错,而是拿到 502」。测试要去的地方永远是 127.0.0.1,
 * 所以直接用 `node:http`,行为只取决于我们的服务本身。
 */

import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'

export interface LocalResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
  /** 解析成 JSON;不是 JSON 时给 null */
  json: <T = unknown>() => T | null
}

export function localRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<LocalResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: opts.method ?? 'GET', headers: opts.headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: <T = unknown>() => {
              try {
                return JSON.parse(body) as T
              } catch {
                return null
              }
            }
          })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}
