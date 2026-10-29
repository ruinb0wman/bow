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
      },
      // @ruinb0w/ui 是 node_modules 里的软链(link:../ui),
      // 它自己的 node_modules 里也有一份 vue / @lucide/vue —— 不去重就会打两份运行时
      dedupe: ['vue', '@lucide/vue']
    },
    server: {
      // 开发期要读项目根之外的 ui 仓产物(软链被 vite 解析成真实路径)
      fs: { allow: [resolve('.'), resolve('../ui')] }
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