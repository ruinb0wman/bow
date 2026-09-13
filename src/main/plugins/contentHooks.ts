/**
 * 内容注入宿主:由 TabManager 显式登记「标签页 webContents」,在其
 * dom-ready / did-finish-load 时按 URL 匹配注入 CSS/JS(preload 无关,主世界执行)。
 *
 * CSS 支持静态字符串或按 URL 动态生成;`refresh()` 可在规则变更后对指定标签页
 * 重新应用 CSS(只重跑 CSS,不重跑 JS),用于元素框选等即时反馈场景。
 *
 * 不用 webContents.getType() 区分标签页:Electron 44 下 WebContentsView 的
 * getType() 也返回 'window',无法与 chrome 窗口区分,因此采用显式登记。
 */

import { webContents } from 'electron'
import type { WebContents } from 'electron'
import type { ContentScriptSpec } from '@shared/plugins'
import { matchUrl } from '@shared/pluginMatch'
import { logError } from '../logger'

interface ContentReg {
  pluginId: string
  spec: ContentScriptSpec
}

interface CssKey {
  wcId: number
  pluginId: string
  specId: string
  key: string
}

export class ContentHookHost {
  private regs: ContentReg[] = []
  private cssKeys: CssKey[] = []
  private tracked = new Set<number>()

  /** 登记一个标签页 webContents:此后其 dom-ready / did-finish-load 才会执行注入 */
  track(wc: WebContents): (() => void) | undefined {
    if (wc.isDestroyed() || this.tracked.has(wc.id)) return undefined
    this.tracked.add(wc.id)
    const run = (phase: 'dom-ready' | 'did-finish-load'): void => this.runFor(wc, phase)
    wc.on('dom-ready', () => run('dom-ready'))
    wc.on('did-finish-load', () => run('did-finish-load'))
    const onDestroyed = (): void => {
      this.tracked.delete(wc.id)
      this.cssKeys = this.cssKeys.filter((k) => k.wcId !== wc.id)
    }
    wc.on('destroyed', onDestroyed)
    return () => {
      if (!wc.isDestroyed()) wc.removeListener('destroyed', onDestroyed)
      this.tracked.delete(wc.id)
    }
  }

  add(pluginId: string, spec: ContentScriptSpec): () => void {
    const reg: ContentReg = { pluginId, spec }
    this.regs.push(reg)
    return () => {
      const i = this.regs.indexOf(reg)
      if (i >= 0) this.regs.splice(i, 1)
      this.removeSpec(pluginId, spec.id)
    }
  }

  removeByPlugin(pluginId: string): void {
    this.regs = this.regs.filter((r) => r.pluginId !== pluginId)
    for (const k of this.cssKeys.filter((k) => k.pluginId === pluginId)) {
      this.removeCssKey(k)
    }
  }

  /**
   * 重新按当前 URL 应用 CSS(不含 JS);省略 tabId 表示全部已登记标签页。
   * 已插入的同一 (标签页, 插件, spec) CSS 会先移除,避免重复。
   */
  refresh(tabId?: number): void {
    const ids = tabId != null ? [tabId] : [...this.tracked]
    for (const id of ids) {
      if (!this.tracked.has(id)) continue
      const wc = webContents.fromId(id)
      if (!wc || wc.isDestroyed()) continue
      const url = wc.getURL()
      if (!url) continue
      for (const { pluginId, spec } of this.regs) {
        if (!matchUrl(url, spec.matches, spec.excludeMatches)) continue
        const css = this.resolveCss(spec, url)
        if (!css) {
          this.removeCss(id, pluginId, spec.id)
          continue
        }
        this.insertCss(wc, pluginId, spec.id, css)
      }
    }
  }

  /** 供日志/诊断 */
  stats(): { tracked: number; rules: number } {
    return { tracked: this.tracked.size, rules: this.regs.length }
  }

  // ---------- 内部 ----------

  private runFor(wc: WebContents, phase: 'dom-ready' | 'did-finish-load'): void {
    if (wc.isDestroyed()) return
    const url = wc.getURL()
    if (!url) return
    for (const { pluginId, spec } of this.regs) {
      if ((spec.runAt ?? 'dom-ready') !== phase) continue
      if (!matchUrl(url, spec.matches, spec.excludeMatches)) continue
      const css = this.resolveCss(spec, url)
      if (css) this.insertCss(wc, pluginId, spec.id, css)
      if (spec.js) {
        wc.executeJavaScript(spec.js, true).catch((e) => logError('内容注入 JS 失败', pluginId, spec.id, e))
      }
    }
  }

  private resolveCss(spec: ContentScriptSpec, url: string): string | undefined {
    const css = typeof spec.css === 'function' ? spec.css(url) : spec.css
    return css && css.trim() ? css : undefined
  }

  private insertCss(wc: WebContents, pluginId: string, specId: string, css: string): void {
    this.removeCss(wc.id, pluginId, specId)
    wc.insertCSS(css)
      .then((key) => {
        this.cssKeys.push({ wcId: wc.id, pluginId, specId, key })
      })
      .catch((e) => logError('内容注入 CSS 失败', pluginId, specId, e))
  }

  private removeSpec(pluginId: string, specId: string): void {
    for (const k of this.cssKeys.filter((k) => k.pluginId === pluginId && k.specId === specId)) {
      this.removeCssKey(k)
    }
  }

  private removeCss(wcId: number, pluginId: string, specId: string): void {
    for (const k of this.cssKeys.filter((k) => k.wcId === wcId && k.pluginId === pluginId && k.specId === specId)) {
      this.removeCssKey(k)
    }
  }

  private removeCssKey(k: CssKey): void {
    try {
      const wc = webContents.fromId(k.wcId)
      if (wc && !wc.isDestroyed()) void wc.removeInsertedCSS(k.key)
    } catch {
      // 内容已销毁:忽略
    }
    this.cssKeys = this.cssKeys.filter((x) => x !== k)
  }
}
