/**
 * 元素全屏插件:框选页面任意元素(视频/图片等)使其铺满网页视口。
 *
 * - ui:工具栏「元素全屏」按钮;
 * - shortcut:Ctrl/Cmd+Shift+F 进入框选 / 退出全屏(主进程全局热键,页面内也生效);
 * - mcp:browser_fullscreen_element / browser_exit_fullscreen;
 * - pages:通过内核页面执行 API 注入框选与全屏脚本(仅 http/https 标签)。
 *
 * 状态仅保存在内存且只对当前页面有效:页面刷新/跳转后自动清零;不落盘。
 */

import { z } from 'zod'
import type { TabInfo } from '@shared/types'
import { textContent } from '../../main/plugins/mcpResult'
import type { PluginContext, PluginMain } from '../../main/plugins/types'
import { PICK_JS, PICK_TEARDOWN_JS, RESTORE_JS, buildApplyScript } from './scripts'

interface PickResult {
  selector?: unknown
  tag?: unknown
  cancelled?: unknown
}

interface ApplyResult {
  ok?: unknown
  selector?: unknown
  tag?: unknown
  count?: unknown
  error?: unknown
}

export interface ElementFullscreenState {
  tabId: number | null
  fullscreen: boolean
  picking: boolean
}

function createElementFullscreenPlugin(): PluginMain {
  const picking = new Set<number>()
  const fullscreen = new Set<number>()

  return {
    manifest: {
      id: 'element-fullscreen',
      name: '元素全屏',
      description: '框选页面任意元素(视频/图片等)铺满网页视口,支持快捷键与 AI 调用',
      version: '1.0.0'
    },
    capabilities: ['ui', 'shortcut', 'mcp'],

    activate(ctx: PluginContext): void {
      const isSupported = (url: string): boolean => /^https?:/i.test(url)
      const activeTab = (): TabInfo | null => ctx.tabs.getActive()
      const findTab = (tabId: number): TabInfo | null => ctx.tabs.list().find((t) => t.id === tabId) ?? null

      const emitChanged = (tabId: number, on: boolean, selector?: string): void => {
        ctx.ipc.emit('fullscreen-changed', { tabId, fullscreen: on, selector })
      }

      const clearTab = (id: number): void => {
        const changed = fullscreen.has(id) || picking.has(id)
        picking.delete(id)
        fullscreen.delete(id)
        // 导航/关闭导致页面态丢失时通知 UI 复位(避免按钮停留在全屏态)
        if (changed) emitChanged(id, false)
      }

      const cancelPick = (tabId: number): void => {
        if (!picking.has(tabId)) return
        void ctx.pages.execute(tabId, PICK_TEARDOWN_JS, { timeoutMs: 2000 }).catch(() => {})
      }

      ctx.events.on('tab:navigated', (p: { tabId: number }) => clearTab(p.tabId))
      ctx.events.on('tab:closed', (p: { id: number }) => clearTab(p.id))
      ctx.events.on('tab:activated', (p: { id: number }) => {
        for (const id of [...picking]) {
          if (id !== p.id) cancelPick(id)
        }
      })

      const applySelector = async (tabId: number, selector: string): Promise<ApplyResult> => {
        const raw = (await ctx.pages.execute(tabId, buildApplyScript(selector), {
          timeoutMs: 5000
        })) as ApplyResult | null
        const res = raw ?? {}
        if (res.ok) {
          fullscreen.add(tabId)
          emitChanged(tabId, true, typeof res.selector === 'string' ? res.selector : selector)
        }
        return res
      }

      const restore = async (tabId: number): Promise<boolean> => {
        const was = fullscreen.has(tabId)
        fullscreen.delete(tabId)
        try {
          await ctx.pages.execute(tabId, RESTORE_JS, { timeoutMs: 3000 })
        } catch {
          // 页面已关闭/导航中:忽略
        }
        if (was) emitChanged(tabId, false)
        return was
      }

      const pickAndFullscreen = async (): Promise<{
        ok: boolean
        selector?: string
        tag?: string
        cancelled?: boolean
        error?: string
      }> => {
        const tab = activeTab()
        if (!tab) return { ok: false, error: '没有活动标签页' }
        if (!isSupported(tab.url)) return { ok: false, error: '当前页面不支持(仅 http/https 页面)' }
        if (picking.has(tab.id)) return { ok: false, error: '该标签页已在框选中' }
        picking.add(tab.id)
        try {
          if (fullscreen.has(tab.id)) await restore(tab.id)
          ctx.pages.focus(tab.id)
          const raw = await ctx.pages.execute(tab.id, PICK_JS, { timeoutMs: 600_000 })
          const res = (raw ?? {}) as PickResult
          if (res.cancelled) return { ok: false, cancelled: true }
          const selector = String(res.selector ?? '').trim()
          if (!selector) return { ok: false, error: '未生成有效选择器' }
          const applied = await applySelector(tab.id, selector)
          if (!applied.ok) return { ok: false, error: String(applied.error ?? '全屏失败') }
          const tag = typeof res.tag === 'string' ? res.tag : undefined
          ctx.ipc.emit('pick-done', { ok: true, tabId: tab.id, selector, tag })
          return { ok: true, selector, tag }
        } catch (e) {
          void ctx.pages.execute(tab.id, PICK_TEARDOWN_JS, { timeoutMs: 2000 }).catch(() => {})
          const msg = e instanceof Error ? e.message : String(e)
          ctx.ipc.emit('pick-done', { ok: false, tabId: tab.id, error: msg })
          return { ok: false, error: msg }
        } finally {
          picking.delete(tab.id)
        }
      }

      const exitFullscreen = async (
        tabId?: number
      ): Promise<{ ok: boolean; wasFullscreen: boolean; error?: string }> => {
        const tab = tabId != null ? findTab(tabId) : activeTab()
        if (!tab) return { ok: false, wasFullscreen: false, error: '没有活动标签页' }
        if (!isSupported(tab.url)) {
          return { ok: false, wasFullscreen: false, error: '当前页面不支持(仅 http/https 页面)' }
        }
        return { ok: true, wasFullscreen: await restore(tab.id) }
      }

      // ---------- IPC(工具栏按钮) ----------

      ctx.ipc.handle('getState', (): ElementFullscreenState => {
        const tab = activeTab()
        return {
          tabId: tab?.id ?? null,
          fullscreen: tab ? fullscreen.has(tab.id) : false,
          picking: tab ? picking.has(tab.id) : false
        }
      })

      ctx.ipc.handle('pickAndFullscreen', () => pickAndFullscreen())

      ctx.ipc.handle('exitFullscreen', (tabId?: unknown) =>
        exitFullscreen(typeof tabId === 'number' ? tabId : undefined)
      )

      // ---------- 快捷键:Ctrl/Cmd+Shift+F ----------

      ctx.shortcuts.register({ key: 'f', code: 'KeyF', ctrl: true, shift: true }, () => {
        const tab = activeTab()
        if (!tab || !isSupported(tab.url)) return
        if (fullscreen.has(tab.id)) {
          void exitFullscreen(tab.id)
          return
        }
        if (picking.has(tab.id)) return
        void pickAndFullscreen()
      })

      // ---------- MCP ----------

      const mcpTarget = (tabId?: number): { tab?: TabInfo; error?: string } => {
        if (tabId != null) {
          const t = findTab(tabId)
          if (!t) return { error: `标签 ${tabId} 不存在` }
          if (!isSupported(t.url)) return { error: `标签 ${tabId} 不是可操作的网页(http/https)` }
          return { tab: t }
        }
        const t = activeTab()
        if (!t) return { error: '没有活动标签页' }
        if (!isSupported(t.url)) return { error: '当前标签不是可操作的网页(http/https),可显式传入 tabId' }
        return { tab: t }
      }

      ctx.mcp.tool(
        'browser_fullscreen_element',
        {
          description:
            '让页面中匹配选择器的元素铺满网页视口(仅当前页面有效,可用 browser_exit_fullscreen 退出)',
          inputSchema: {
            selector: z.string().describe('目标元素的 CSS 选择器,取首个匹配'),
            tabId: z.number().optional().describe('目标标签页 id,缺省为活动标签')
          }
        },
        async (args) => {
          const target = mcpTarget(typeof args.tabId === 'number' ? args.tabId : undefined)
          if (target.error) return textContent({ ok: false, error: target.error })
          const selector = String(args.selector ?? '').trim()
          if (!selector) return textContent({ ok: false, error: 'selector 不能为空' })
          try {
            const res = await applySelector(target.tab!.id, selector)
            if (!res.ok) return textContent({ ok: false, error: String(res.error ?? '全屏失败') })
            return textContent({
              ok: true,
              tabId: target.tab!.id,
              selector: res.selector ?? selector,
              tag: res.tag ?? '',
              count: res.count ?? 1
            })
          } catch (e) {
            return textContent({ ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        }
      )

      ctx.mcp.tool(
        'browser_exit_fullscreen',
        {
          description: '退出元素全屏并还原页面(仅当前页面有效)',
          inputSchema: { tabId: z.number().optional().describe('目标标签页 id,缺省为活动标签') }
        },
        async (args) => {
          const target = mcpTarget(typeof args.tabId === 'number' ? args.tabId : undefined)
          if (target.error) return textContent({ ok: false, error: target.error })
          try {
            const wasFullscreen = await restore(target.tab!.id)
            return textContent({ ok: true, tabId: target.tab!.id, wasFullscreen })
          } catch (e) {
            return textContent({ ok: false, error: e instanceof Error ? e.message : String(e) })
          }
        }
      )
    },

    deactivate(ctx: PluginContext): void {
      // best-effort:插件停用时还原所有已记录的全屏标签(页面已重载则无副作用)
      for (const id of [...fullscreen]) {
        void ctx.pages.execute(id, RESTORE_JS, { timeoutMs: 2000 }).catch(() => {})
      }
      picking.clear()
      fullscreen.clear()
    }
  }
}

export default createElementFullscreenPlugin()
