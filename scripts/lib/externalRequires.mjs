/**
 * 从主进程 bundle 里扫出「运行时外部依赖」:非相对、非 node: 内置、非 electron 的模块引用。
 *
 * 单独放在这里是为了能被单测直接调用:这个正则曾经把 bundle 里的普通字符串当成依赖 ——
 * 广告规则选项表里的 `"from",`(后跟下一行的 `"ipaddress",`)命中了 `from\s*["']`,
 * 扫出一个依赖名 `",\n  "`,产物自检因此误报「asar 里缺少运行时依赖 node_modules/」,
 * 让整个 `npm run dist` 失败。所以现在要求:必须是独立的 require(...) / from "..." 语句,
 * 且引号里不含空白(模块名里不会有空白)。
 */

/** 抓 require("x") / from "x";`(?<![\w$])` 挡住标识符或字符串尾段里的同名子串 */
const REFERENCE_RE = /(?<![\w$])(?:require\(\s*["']([^"']+)["']|from\s+["']([^"']+)["'])/g

/** 扫出 bundle 里实际外部化的包名(去重、排序;作用域包保留 @scope/name) */
export function externalRequires(bundleSource) {
  const names = new Set()
  for (const m of bundleSource.matchAll(REFERENCE_RE)) {
    const spec = m[1] ?? m[2]
    if (!spec || /\s/.test(spec)) continue
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
    if (spec === 'electron' || spec.startsWith('electron/')) continue
    // 作用域包取前两段,普通包取第一段
    const parts = spec.split('/')
    names.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0])
  }
  return [...names].sort()
}
