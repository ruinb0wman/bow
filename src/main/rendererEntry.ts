/**
 * 渲染层入口解析:dev 走 Vite dev server(ELECTRON_RENDERER_URL),prod 走打包产物。
 * chrome / Overlay / 内部页面(设置)三个渲染入口共用,避免各处重复判断漂移。
 */

import { join } from 'node:path'
import type { WebContents } from 'electron'

export type RendererEntryName = 'index' | 'overlay' | 'settings'

export interface RendererEntry {
  kind: 'url' | 'file'
  target: string
}

export function rendererEntry(name: RendererEntryName): RendererEntry {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) {
    // dev:index 即 dev server 根,其余为同名 html
    return { kind: 'url', target: name === 'index' ? dev : `${dev}/${name}.html` }
  }
  return { kind: 'file', target: join(__dirname, `../renderer/${name}.html`) }
}

/** 把入口加载到指定 webContents(失败只记日志,调用方无需处理) */
export function loadRendererEntry(wc: WebContents, name: RendererEntryName): void {
  const entry = rendererEntry(name)
  if (entry.kind === 'url') void wc.loadURL(entry.target)
  else void wc.loadFile(entry.target)
}
