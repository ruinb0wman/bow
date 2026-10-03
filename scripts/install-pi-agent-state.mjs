#!/usr/bin/env node
/**
 * 把 bow 的 pi 状态桥扩展装进 pi 的扩展目录(默认 `~/.pi/agent/extensions/bow-agent-state.ts`)。
 *
 * 为什么需要它:bow 靠 pi 写的 OSC 控制序列来显示「终端标签正在执行 / 等待确认 / 已完成」,
 * 而这条序列只能由 pi 进程里的扩展发出(见 `integrations/pi/bow-agent-state.ts` 顶部注释)。
 * 装上它只是让效果完整;**不装也能跑** —— 靠 pi 内建的 `terminal.showTerminalProgress` 至少
 * 有「正在执行」角标(那一档要用户在 pi 设置里打开)。
 *
 * 幂等:内容相同就什么都不做;目标文件存在但不是 bow 装的(没有 managed 标记)则拒写,
 * 除非显式 `--force`。卸载只删带标记的那个文件。
 *
 * 用法:
 *   node scripts/install-pi-agent-state.mjs              # 安装 / 更新
 *   node scripts/install-pi-agent-state.mjs --dry-run    # 只打印将要做什么
 *   node scripts/install-pi-agent-state.mjs --print      # 把扩展源码打到 stdout
 *   node scripts/install-pi-agent-state.mjs --uninstall  # 卸载
 *   node scripts/install-pi-agent-state.mjs --extension-dir <dir>   # 换目标目录(测试 / 自定义 agent dir)
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = join(root, 'integrations', 'pi', 'bow-agent-state.ts')

/** 只认 pi 的 agent 目录约定:环境变量优先,否则 ~/.pi/agent(见 pi docs/configuration.md) */
const defaultDir = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent'), 'extensions')

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function help() {
  console.log('用法:node scripts/install-pi-agent-state.mjs [--dry-run] [--print] [--uninstall] [--force] [--extension-dir <dir>]')
  console.log(`默认目标目录:${defaultDir}`)
}

if (has('--help') || has('-h')) {
  help()
  process.exit(0)
}

const dir = valueOf('--extension-dir') ?? defaultDir
const target = join(dir, 'bow-agent-state.ts')

if (!existsSync(source)) {
  console.error(`✗ 找不到扩展源码:${source}`)
  process.exit(1)
}
const content = readFileSync(source, 'utf-8')

if (has('--print')) {
  process.stdout.write(content)
  process.exit(0)
}

const dryRun = has('--dry-run')
const marker = 'managed by bow'
const existing = existsSync(target) ? readFileSync(target, 'utf-8') : null
const isOurs = existing === null || existing.includes(marker)

if (has('--uninstall')) {
  if (existing === null) {
    console.log(`— 未安装(${target} 不存在)`)
    process.exit(0)
  }
  if (!isOurs && !has('--force')) {
    console.error(`✗ ${target} 不是 bow 装的(没有 "${marker}" 标记),拒绝删除。确认要删请加 --force`)
    process.exit(1)
  }
  if (dryRun) console.log(`[dry-run] 将删除 ${target}`)
  else {
    rmSync(target)
    console.log(`✓ 已卸载 ${target}`)
  }
  process.exit(0)
}

if (existing === content) {
  console.log(`✓ 已是最新 ${target}`)
  process.exit(0)
}
if (!isOurs && !has('--force')) {
  console.error(`✗ ${target} 已存在且不是 bow 装的(没有 "${marker}" 标记),拒绝覆盖。`)
  console.error('  想用 bow 的版本请先备份并删除它,或加 --force 覆盖。')
  process.exit(1)
}

if (dryRun) {
  console.log(`[dry-run] 将写入 ${target}(${content.length} 字节,源:${source})`)
  console.log(`[dry-run] 目标目录${existsSync(dir) ? '已存在' : '不存在,会被创建'}`)
  process.exit(0)
}

mkdirSync(dir, { recursive: true })
writeFileSync(target, content, 'utf-8')
console.log(`✓ ${existing === null ? '已安装' : '已更新'} ${target}`)
console.log('  在 bow 的终端里重开(或 /reload)pi 即可生效;BOW_TERMINAL=1 之外的终端里它什么都不做。')
