/** 测试用假 TabManager:只实现 mcp.ts / mcpHttp.ts 真正调用到的面 */

import type { TabInfo } from '../src/shared/types'
import { FakeWc } from './fakeWc'

export interface Rec {
  info: TabInfo
  view: { webContents: FakeWc }
  internalId: string | null
}

export class FakeTabs {
  recs = new Map<number, Rec>()
  activeId: number | null = null
  lastBrowsingId: number | null = null
  nextId = 1

  create(url = 'about:blank', activate = true, internal = false): TabInfo {
    const id = this.nextId++
    const wc = new FakeWc()
    wc.url = url
    const info: TabInfo = {
      id,
      url,
      title: url,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      active: false,
      crashed: false,
      ...(internal ? { internal: true } : {})
    }
    this.recs.set(id, { info, view: { webContents: wc }, internalId: internal ? 'settings' : null })
    if (activate) this.activate(id)
    return { ...info }
  }

  activate(id: number): void {
    const rec = this.recs.get(id)
    if (!rec) return
    this.activeId = id
    if (!rec.info.internal) this.lastBrowsingId = id
  }

  getView(id: number): Rec | null {
    return this.recs.get(id) ?? null
  }

  /** 与真实实现一致:由 webContents 反查标签 id(多窗口 byWebContents 路由用) */
  findTabIdByWebContents(wc: unknown): number | null {
    for (const [id, rec] of this.recs) {
      if (rec.view.webContents === wc) return id
    }
    return null
  }

  getActiveView(): Rec | null {
    return this.activeId == null ? null : (this.recs.get(this.activeId) ?? null)
  }

  getActiveBrowsingView(): Rec | null {
    if (this.lastBrowsingId != null) {
      const hit = this.recs.get(this.lastBrowsingId)
      if (hit) return hit
    }
    const active = this.getActiveView()
    return active && !active.info.internal ? active : null
  }

  listTabs(): TabInfo[] {
    return [...this.recs.values()].map((r) => ({ ...r.info }))
  }

  close(id: number): { ok: boolean } {
    if (!this.recs.has(id)) return { ok: false }
    this.recs.delete(id)
    if (this.activeId === id) this.activeId = null
    if (this.lastBrowsingId === id) this.lastBrowsingId = null
    return { ok: true }
  }

  /** 与真实实现一致:就地导航;跨「内部页面 ↔ 普通网页」边界一律拒绝 */
  navigate(id: number, url: string): boolean {
    const rec = this.recs.get(id)
    if (!rec) return false
    if (rec.internalId) return false
    rec.info.url = url
    rec.view.webContents.url = url
    return true
  }

  /** 与真实实现一致:活动标签可承载则就地导航,否则新建标签 */
  openUrl(url: string, activate = true): TabInfo {
    const active = this.getActiveView()
    if (active && !active.info.internal) {
      this.navigate(active.info.id, url)
      return { ...active.info, active: true }
    }
    return this.create(url, activate)
  }

  back(): void {}
  forward(): void {}
  reload(id: number): void {
    const rec = this.recs.get(id)
    if (rec) rec.view.webContents.loading = true
  }
  stop(): void {}
}
