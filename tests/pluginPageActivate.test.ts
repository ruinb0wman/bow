/**
 * 内核的「把某个标签带到眼前」能力(`ctx.pages.activate`)。
 *
 * 为什么这条要单独看住:它与 `focus` 只差一个词,选错的表现是「面板点了没反应」——
 * 而后台标签 / 别的分屏窗格这两种最常见的场景**恰好**是 `focus` 不生效的场景。
 * 另外它是 P0 面板唯一新增的核心面,所以顺便把「插件方法能不能从渲染层调通」
 * (`plugins:invoke` → `kernel.invoke` → 插件 handler)一并看住。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return { app: { getPath: () => mkdtempSync(join(tmpdir(), 'bow-page-activate-test-')), getVersion: () => '0.0.0' } }
})

const { PluginKernel } = await import('../src/main/plugins/kernel')
type PluginContext = import('../src/main/plugins/types').PluginContext
type PluginMain = import('../src/main/plugins/types').PluginMain

/** 探针插件:把 `activate` 暴露成一个可 invoke 的方法,就像终端插件的 focusSession */
function probePlugin(): PluginMain {
  return {
    manifest: { id: 'probe', name: 'probe', description: '探针', version: '0.0.0' },
    capabilities: [],
    activate(ctx: PluginContext): void {
      ctx.ipc.handle('activate', (tabId: unknown) => ctx.pages.activate(Number(tabId)))
    }
  }
}

async function kernelWith(plugin: PluginMain): Promise<InstanceType<typeof PluginKernel>> {
  const kernel = new PluginKernel()
  kernel.registerAll([plugin])
  await kernel.activateEnabled()
  return kernel
}

describe('内核:ctx.pages.activate', () => {
  it('页面 API 未注入时返回 false(窗口就绪前 activate 是正常时序,不能抛)', async () => {
    const kernel = await kernelWith(probePlugin())
    await expect(kernel.invoke('probe', 'activate', [7])).resolves.toBe(false)
  })

  it('注入后把 tabId 原样交给宿主,返回值透传', async () => {
    const calls: number[] = []
    const kernel = new PluginKernel()
    kernel.setPageApi({
      activeTabId: () => null,
      focus: () => {},
      activate: (tabId) => {
        calls.push(tabId)
        return true
      },
      execute: async () => ({}),
      openDevToolsTab: () => 0
    })
    kernel.registerAll([probePlugin()])
    await kernel.activateEnabled()

    await expect(kernel.invoke('probe', 'activate', [42])).resolves.toBe(true)
    expect(calls).toEqual([42])
  })

  it('宿主说「没这个标签」时把 false 透传给调用方(面板据此跳过焦点切换)', async () => {
    const kernel = new PluginKernel()
    kernel.setPageApi({
      activeTabId: () => null,
      focus: () => {},
      activate: () => false,
      execute: async () => ({}),
      openDevToolsTab: () => 0
    })
    kernel.registerAll([probePlugin()])
    await kernel.activateEnabled()
    await expect(kernel.invoke('probe', 'activate', [999])).resolves.toBe(false)
  })
})
