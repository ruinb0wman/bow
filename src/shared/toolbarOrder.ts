/**
 * 工具栏插件按钮的顺序(纯函数,可单测)。
 *
 * 保存值只记插件 id;`available` 是当前实际贡献了 toolbar 按钮的插件 ——
 * 不在其中的 id 一律丢弃,所以插件下线后配置里不留残渣。
 * 顺序兜底仍由注册表给(`SLOT_PLUGIN_ORDER.toolbar`),保存值只用来覆盖它。
 */

/** 保存的顺序在前,默认顺序与其余可用插件按序补在后(新插件永远是往末尾追加) */
export function mergeToolbarOrder(
  saved: readonly string[],
  defaults: readonly string[],
  available: readonly string[]
): string[] {
  const ok = new Set(available)
  const out: string[] = []
  for (const id of [...saved, ...defaults, ...available]) {
    if (ok.has(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/** 把 id 上移(-1)/下移(+1);到边界时原样返回 */
export function moveToolbarEntry(order: readonly string[], id: string, delta: -1 | 1): string[] {
  const i = order.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= order.length) return [...order]
  const out = [...order]
  out[i] = order[j]
  out[j] = id
  return out
}
