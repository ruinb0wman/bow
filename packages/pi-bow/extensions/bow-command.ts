/**
 * `/bow` 命令:看 bow 集成的状态、临时开/关 MCP 注册。
 *
 * 存在理由:「装了这个包,`/mcp` 里怎么没有 / 怎么还是旧那条 / 为什么连不上」这三问
 * 光看文档答不出来 —— 一条命令给出端点、可达性、注册状态、被 `mcp.json` 覆盖的情况。
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { collectBowMcpReport, formatBowMcpReport, registerBowMcp, unregisterBowMcp } from '../src/bow-mcp'

const SUBCOMMANDS = ['status', 'on', 'off', 'reload'] as const

export default function bowCommand(pi: ExtensionAPI): void {
  pi.registerCommand('bow', {
    description: 'bow 集成:MCP 注册状态 / on / off / reload',
    getArgumentCompletions: (prefix) => {
      const hits = SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim()))
      return hits.length > 0 ? hits.map((value) => ({ value, label: value })) : null
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase() || 'status'

      if (sub === 'off') {
        unregisterBowMcp(pi)
        ctx.ui.notify('已注销 bow MCP(仅本次会话;重开或 /bow on 恢复)', 'info')
        return
      }

      if (sub === 'on' || sub === 'reload') {
        if (sub === 'reload') unregisterBowMcp(pi)
        const result = await registerBowMcp(pi)
        ctx.ui.notify(result.message, result.outcome === 'registered' ? 'info' : 'warning')
        return
      }

      if (sub !== 'status') {
        ctx.ui.notify(`未知参数「${sub}」,用法:/bow [${SUBCOMMANDS.join('|')}]`, 'warning')
        return
      }

      ctx.ui.notify(formatBowMcpReport(await collectBowMcpReport(pi)), 'info')
    }
  })
}
