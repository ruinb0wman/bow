/**
 * 插件插槽合并(纯函数,不依赖 Vue runtime,可单测)。
 *
 * host(App.vue)负责按「已启用插件」过滤后渲染;同一个槽被多个插件占用时,
 * 展示顺序 = `preferredOrder` 里列出的插件按列表顺序靠前,未列出的保持注册顺序排在其后。
 * 于是「新增插件按钮」永远是往末尾追加,host 代码零改动。
 */
import type { Component } from 'vue'
import type { PluginSlot } from './types'

/** 合并所需的最小结构:测试可用假组件代入 */
export interface SlotContribution {
  id: string
  slots?: Partial<Record<PluginSlot, Component[]>>
}

/** 摊平某个插槽的组件列表(已启用插件才贡献;停用的插件整段跳过) */
export function collectSlot(
  contributions: readonly SlotContribution[],
  slot: PluginSlot,
  isEnabled: (pluginId: string) => boolean,
  preferredOrder: readonly string[] = []
): Component[] {
  const rank = new Map(preferredOrder.map((id, i) => [id, i]))
  const ordered = contributions
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ra = rank.get(a.c.id) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(b.c.id) ?? Number.MAX_SAFE_INTEGER
      return ra - rb || a.i - b.i
    })

  const out: Component[] = []
  for (const { c } of ordered) {
    if (!isEnabled(c.id)) continue
    const list = c.slots?.[slot]
    if (list) out.push(...list)
  }
  return out
}
