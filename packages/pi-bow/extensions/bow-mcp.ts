/**
 * bow MCP 服务器的自动注册(装了这个包就不用再动 `mcp.json`、不用重启 pi)。
 *
 * bow 的端点是个本机常驻服务,不是每次都在 —— 所以先探端口,探不到就**不注册也不报错**
 * (`bow` 没开是常态,每次都弹提示会变成噪音);要查状态就 `/bow`。
 *
 * 同名时 `mcp.json` 的条目优先于这里的注册(pi 的规则),`/bow` 会把这件事指出来。
 * 不落盘:每次加载都重新注册;`/bow off` 只影响本次会话。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerBowMcp } from '../src/bow-mcp'

export default async function bowMcp(pi: ExtensionAPI): Promise<void> {
  // 异步工厂:pi 会等它返回再继续启动,所以不会出现「先连一次、再断开」的抖动
  const result = await registerBowMcp(pi)
  // 只有真的坏了才说一句话(unreachable / disabled 都是正常状态,状态随时可用 /bow 查)
  if (result.outcome === 'failed') console.error(`[pi-bow] ${result.message}`)
}
