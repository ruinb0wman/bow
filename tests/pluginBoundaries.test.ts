/**
 * 插件目录边界约束:
 * - main.ts(主进程侧)不得引入 .vue 组件或 @renderer 代码;
 * - ui.ts(渲染层侧)不得引入 electron。
 * 这两条保证了 electron-vite 的 main / renderer 两个独立构建不会互相拖入非法依赖。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pluginsDir = fileURLToPath(new URL('../src/plugins', import.meta.url))
const pluginIds = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

function readIfExists(file: string): string {
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

describe('插件目录边界', () => {
  it('至少存在一个插件目录', () => {
    expect(pluginIds.length).toBeGreaterThan(0)
  })

  it('main.ts 不得引用 .vue 或 @renderer', () => {
    for (const id of pluginIds) {
      const src = readIfExists(join(pluginsDir, id, 'main.ts'))
      if (!src) continue
      expect(src, `${id}/main.ts 不应引用 .vue`).not.toMatch(/\.vue['"]/)
      expect(src, `${id}/main.ts 不应引用 @renderer`).not.toMatch(/@renderer/)
    }
  })

  it('ui.ts 不得引用 electron', () => {
    for (const id of pluginIds) {
      const src = readIfExists(join(pluginsDir, id, 'ui.ts'))
      if (!src) continue
      expect(src, `${id}/ui.ts 不应引用 electron`).not.toMatch(/from ['"]electron['"]/)
    }
  })
})
