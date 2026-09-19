import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

// electron-vite 5:外部化依赖为配置驱动且默认开启(build.externalizeDeps=true),
// 不再需要 externalizeDepsPlugin 插件

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@plugins': resolve('src/plugins')
      }
    }
  },
  preload: {}, 
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@plugins': resolve('src/plugins')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          overlay: resolve('src/renderer/overlay.html'),
          settings: resolve('src/renderer/settings.html'),
          terminal: resolve('src/renderer/terminal.html')
        }
      }
    }
  }
})