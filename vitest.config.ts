import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/pi-bow/tests/**/*.test.ts'],
    environment: 'node',
    // 本机设了 HTTP_PROXY,而 Node 会把它应用到 http/fetch —— loopback 请求也被转给代理,
    // 表现是「连已关闭的端口也拿到 502」与莫名其妙的超时。测试一律直连。
    env: {
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost'
    }
  },
  resolve: {
    alias: {
      '@shared': new URL('./src/shared', import.meta.url).pathname,
      '@plugins': new URL('./src/plugins', import.meta.url).pathname
    }
  }
})
