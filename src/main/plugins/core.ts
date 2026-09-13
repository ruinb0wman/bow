/**
 * 插件注册表纯逻辑(无 electron / DOM 依赖,可单测):注册校验、固定顺序、启停状态投影。
 * 实际的 activate/deactivate 由 kernel 编排,这里只维护图与状态。
 */

import type { PluginCapability, PluginInfo, PluginManifest } from '@shared/plugins'
import type { PluginMain } from './types'

export interface PluginRecord {
  module: PluginMain
  manifest: PluginManifest
  capabilities: PluginCapability[]
  active: boolean
}

const ID_RE = /^[a-z][a-z0-9-]*$/

export class PluginRegistry {
  private records = new Map<string, PluginRecord>()
  private order: string[] = []
  private disabled = new Set<string>()

  /** 注册内置插件:id 必须为 kebab-case 且全局唯一,重复直接抛错(启动即失败) */
  register(module: PluginMain): PluginRecord {
    const id = module.manifest.id
    if (!ID_RE.test(id)) throw new Error(`插件 id 非法(需 kebab-case):${id}`)
    if (this.records.has(id)) throw new Error(`插件 id 重复:${id}`)
    const record: PluginRecord = {
      module,
      manifest: module.manifest,
      capabilities: [...module.capabilities],
      active: false
    }
    this.records.set(id, record)
    this.order.push(id)
    return record
  }

  has(id: string): boolean {
    return this.records.has(id)
  }

  get(id: string): PluginRecord | undefined {
    return this.records.get(id)
  }

  /** 注册顺序(决定网络钩子与建议源的稳定次序) */
  ids(): string[] {
    return [...this.order]
  }

  enabledIds(): string[] {
    return this.order.filter((id) => !this.disabled.has(id))
  }

  isEnabled(id: string): boolean {
    return this.records.has(id) && !this.disabled.has(id)
  }

  isActive(id: string): boolean {
    return this.records.get(id)?.active === true
  }

  setActive(id: string, active: boolean): void {
    const r = this.records.get(id)
    if (r) r.active = active
  }

  /** 用持久化状态覆盖 disabled 集合(未知 id 忽略,防止历史残留) */
  setDisabled(ids: string[]): void {
    this.disabled = new Set(ids.filter((id) => this.records.has(id)))
  }

  disabledIds(): string[] {
    return this.order.filter((id) => this.disabled.has(id))
  }

  setEnabledState(id: string, enabled: boolean): void {
    if (!this.records.has(id)) return
    if (enabled) this.disabled.delete(id)
    else this.disabled.add(id)
  }

  list(): PluginInfo[] {
    return this.order.map((id) => {
      const r = this.records.get(id)!
      return {
        ...r.manifest,
        builtin: true as const,
        enabled: !this.disabled.has(id),
        capabilities: [...r.capabilities]
      }
    })
  }
}
