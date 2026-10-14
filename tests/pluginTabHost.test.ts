/**
 * 内核的「插件建内部页标签」能力(ctx.tabs.openInternal)。
 *
 * 这是插件唯一的建标签入口,所以边界值得单独看住三件事:
 * ① 未注入宿主时必须**返回 null 而不是抛**(窗口就绪前 activate 是正常时序);
 * ② 宿主抛错时同样吞掉并返回 null(一个插件开不出标签不该连累别人);
 * ③ 注入后参数原样透传(插件只给内部页 id + 可选 windowId)。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return { app: { getPath: () => mkdtempSync(join(tmpdir(), 'bow-tab-host-test-')), getVersion: () => '0.0.0' } }
})

const { PluginKernel } = await import('../src/main/plugins/kernel')
type PluginContext = import('../src/main/plugins/types').PluginContext
type PluginMain = import('../src/main/plugins/types').PluginMain

/** 探针插件:activate 时建一个终端标签,把返回值留在外面的 resultRef 里 */
function probePlugin(id: string, resultRef: { value: unknown }, onCall?: (windowId?: number) => void): PluginMain {
  return {
    manifest: { id, name: id, description: '探针', version: '0.0.0' },
    capabilities: [],
    activate(ctx: PluginContext): void {
      onCall?.(7)
      resultRef.value = ctx.tabs.openInternal('terminal', { windowId: 7 })
    }
  }
}

async function activate(plugin: PluginMain): Promise<InstanceType<typeof PluginKernel>> {
  const kernel = new PluginKernel()
  kernel.registerAll([plugin])
  await kernel.activateEnabled()
  return kernel
}

describe('内核:ctx.tabs.openInternal', () => {
  it('宿主未注入时返回 null,不抛', async () => {
    const result = { value: undefined as unknown }
    await activate(probePlugin('probe-a', result))
    expect(result.value).toBeNull()
  })

  it('注入后透传内部页 id 与 windowId,并返回宿主给的 tabId', async () => {
    const result = { value: undefined as unknown }
    const calls: Array<{ page: string; windowId?: number }> = []
    const kernel = new PluginKernel()
    // 必须先注入:真实时序也是"窗口就绪后才注入",所以 activate 期间就应该能用
    kernel.setTabHost({
      openInternal: (page, opts) => {
        calls.push({ page, windowId: opts?.windowId })
        return 42
      }
    })
    kernel.registerAll([probePlugin('probe-b', result)])
    await kernel.activateEnabled()
    expect(result.value).toBe(42)
    expect(calls).toEqual([{ page: 'terminal', windowId: 7 }])
  })

  it('宿主抛错时吞掉并返回 null(不连累插件激活与其它插件)', async () => {
    const result = { value: undefined as unknown }
    const kernel = new PluginKernel()
    kernel.setTabHost({
      openInternal: () => {
        throw new Error('没有可用窗口')
      }
    })
    kernel.registerAll([probePlugin('probe-c', result)])
    await kernel.activateEnabled()
    expect(result.value).toBeNull()
  })
})
