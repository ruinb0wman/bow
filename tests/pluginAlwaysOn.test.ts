/**
 * 核心插件(`manifest.alwaysOn`)不可停用 —— 内核级验证。
 *
 * 三条验收线:
 * 1. 停用请求被拒(仍启用、仍激活,且不写持久化状态);
 * 2. 普通插件照旧能停用(不能为了锁终端把「停用即回收能力」一起废掉);
 * 3. 老版本存下的 `disabled:['terminal']` 在开机加载时被过滤(否则升级后终端仍是死的)。
 *
 * electron 只需 `app.getPath`:内核构造时就读 userData 下的 plugins.json,与 mcpHttpService.test.ts 同款 mock。
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginMain } from '../src/main/plugins/types'

let userDataDir = ''
vi.mock('electron', async () => {
  const { mkdtempSync: mk } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  userDataDir = mk(j(td(), 'plugin-always-on-test-'))
  return { app: { getPath: () => userDataDir, getVersion: () => '0.0.0' } }
})

const { PluginKernel } = await import('../src/main/plugins/kernel')

function mod(id: string, alwaysOn = false): PluginMain {
  return {
    manifest: { id, name: id, description: `${id} 描述`, version: '1.0.0', ...(alwaysOn ? { alwaysOn: true } : {}) },
    capabilities: [],
    activate: () => {},
    deactivate: () => {}
  }
}

/** 每条用例一份干净 userData;`disabled` 传入时先落盘,模拟上次运行留下的状态 */
function boot(modules: PluginMain[], disabled?: string[]): InstanceType<typeof PluginKernel> {
  if (disabled) {
    writeFileSync(join(userDataDir, 'plugins.json'), JSON.stringify({ version: 1, disabled }), 'utf-8')
  }
  const kernel = new PluginKernel()
  kernel.registerAll(modules)
  return kernel
}

function enabledOf(kernel: InstanceType<typeof PluginKernel>, id: string): boolean | undefined {
  return kernel.list().find((p) => p.id === id)?.enabled
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'plugin-always-on-'))
})

describe('核心插件不可停用', () => {
  it('停用请求是空操作:仍启用、仍激活,也不写进 disabled', async () => {
    const kernel = boot([mod('locked', true), mod('optional')])
    await kernel.activateEnabled()

    const list = await kernel.setEnabled('locked', false)
    expect(list.find((p) => p.id === 'locked')?.enabled).toBe(true)
    expect(kernel.registry.isActive('locked')).toBe(true)

    // 空操作的判据:状态没变,也没产生写盘(没有 plugins.json)
    expect(kernel.registry.disabledIds()).toEqual([])
    expect(existsSync(join(userDataDir, 'plugins.json'))).toBe(false)
  })

  it('普通插件照旧能停用并落盘(能力回收路径未被破坏)', async () => {
    const kernel = boot([mod('locked', true), mod('optional')])
    await kernel.activateEnabled()

    const list = await kernel.setEnabled('optional', false)
    expect(list.find((p) => p.id === 'optional')?.enabled).toBe(false)
    expect(kernel.registry.isActive('optional')).toBe(false)

    const saved = JSON.parse(readFileSync(join(userDataDir, 'plugins.json'), 'utf-8')) as { disabled: string[] }
    expect(saved.disabled).toEqual(['optional'])
  })

  it('历史遗留的 disabled 状态被过滤:老版本关过终端,升级后直接可用', () => {
    const kernel = boot([mod('locked', true), mod('optional')], ['locked', 'optional'])
    expect(enabledOf(kernel, 'locked')).toBe(true)
    expect(enabledOf(kernel, 'optional')).toBe(false)
  })
})
