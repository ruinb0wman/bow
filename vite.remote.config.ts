import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

/**
 * 远程页的独立构建(输出到 `out/remote/`,由终端插件在 127.0.0.1 上静态提供)。
 *
 * 为什么不走 electron-vite 的 renderer 入口:
 * 1. 远程页**不能**依赖 preload(`window.browserAPI` 在普通浏览器里不存在);
 * 2. 它要在**任何**浏览器里打开 —— 包括手机,所以产物必须是相对路径、单入口、无 hash 文件名
 *    (静态服务按白名单给文件,写死名字比维护一张 manifest 简单)。
 */
export default defineConfig({
  root: resolve('src/renderer/remote'),
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@plugins': resolve('src/plugins')
    },
    // 同 electron.vite.config.ts:软链进来的 ui 仓有自己的 vue / @lucide/vue
    dedupe: ['vue', '@lucide/vue']
  },
  build: {
    outDir: resolve('out/remote'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: resolve('src/renderer/remote/index.html'),
      output: {
        // 单 chunk:没有动态 import,文件名可预测(静态服务不需要目录清单)
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]'
      }
    }
  }
})
