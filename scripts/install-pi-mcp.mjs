#!/usr/bin/env node
/**
 * 把 bow 浏览器的 MCP 服务器写入 pi 的 MCP 配置(幂等、可回滚)。
 *
 * 目标文件:
 *   默认  ~/.pi/agent/mcp.json   (全局,所有项目的 pi 会话可用)
 *   --project  ./.pi/mcp.json    (当前工作目录的项目级配置)
 *
 * 用法:
 *   npm run mcp:install                 # 安装 stdio 版(pi 自动拉起浏览器)
 *   npm run mcp:install -- --http       # 安装 HTTP 版(浏览器常驻,多客户端可共享)
 *   npm run mcp:install -- --dry-run    # 只打印将写入的内容
 *   npm run mcp:install -- --remove     # 卸载
 *   npm run mcp:install -- --direct-core  # 额外把核心 5 个工具提升为 pi 原生工具
 *
 * 其它参数:--port <n> --token <t> --direct-all --project
 *
 * 行为约定:目标文件存在但不是合法 JSON 时直接报错退出,绝不覆盖无法解析的配置。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_NAME = 'browser'
const CORE_TOOLS = ['browser_navigate', 'browser_snapshot', 'browser_wait', 'browser_click', 'browser_eval']
/** 能力索引 skill:代理模式下工具 schema 不常驻上下文,靠它把「能做什么 / 怎么做」放进上下文 */
const SKILL_NAME = 'bow-browser'
const SKILL_REL = join('.pi', 'skills', SKILL_NAME, 'SKILL.md')

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

if (has('--help') || has('-h')) {
  console.log(`把 bow 浏览器的 MCP 服务器写入 pi 配置(幂等、可回滚)。

  npm run mcp:install                     安装 stdio 版(pi 自动拉起浏览器)
  npm run mcp:install -- --http           安装 HTTP 版(浏览器常驻,多客户端可共享)
  npm run mcp:install -- --direct-core    额外把核心 5 个工具提升为原生工具
  npm run mcp:install -- --direct-all     额外把全部工具提升为原生工具
  npm run mcp:install -- --dry-run        只打印将写入的内容
  npm run mcp:install -- --remove         卸载(配置 + skill)

可选参数:
  --project           写入 ./.pi/mcp.json(项目级)而非 ~/.pi/agent/mcp.json
  --port <n>          HTTP 模式端口,默认 8765
  --token <t>         HTTP 模式 Bearer 令牌(默认取 MCP_HTTP_TOKEN)
  --no-skill          不安装 bow-browser skill(默认会装)
  --tool-prefix <m>   同时设置 settings.toolPrefix(none / server / short)
`)
  process.exit(0)
}

const useHttp = has('--http')
const port = Number(opt('--port', '8765'))
const token = opt('--token', process.env.MCP_HTTP_TOKEN || '')
const dryRun = has('--dry-run')
const remove = has('--remove')
const project = has('--project')
const withSkill = !has('--no-skill')
const toolPrefix = opt('--tool-prefix', '')
if (toolPrefix && !['none', 'server', 'short'].includes(toolPrefix)) {
  console.error(`--tool-prefix 只支持 none / server / short,收到: ${toolPrefix}`)
  process.exit(2)
}
const target = project
  ? join(process.cwd(), '.pi', 'mcp.json')
  : join(homedir(), '.pi', 'agent', 'mcp.json')

const skillSource = join(PROJECT, SKILL_REL)
const skillTarget = project
  ? join(process.cwd(), SKILL_REL)
  : join(homedir(), '.pi', 'agent', 'skills', SKILL_NAME, 'SKILL.md')

if (useHttp && !Number.isInteger(port)) {
  console.error(`端口无效: ${opt('--port', '')}`)
  process.exit(2)
}

function readConfig(file) {
  if (!existsSync(file)) return {}
  const raw = readFileSync(file, 'utf-8')
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层不是对象')
    }
    return parsed
  } catch (e) {
    console.error(`✗ ${file} 存在但不是合法 JSON:${e.message}`)
    console.error('  为避免覆盖你的配置,已中止。请先修好该文件(或手动添加下面的条目)。')
    console.error(JSON.stringify({ mcpServers: { [SERVER_NAME]: buildEntry() } }, null, 2))
    process.exit(1)
  }
}

function buildEntry() {
  const entry = useHttp
    ? {
        url: `http://127.0.0.1:${port}/mcp`,
        // 常驻服务:允许浏览器还没起来就先配置好,起来后自动重连
        lifecycle: 'keep-alive'
      }
    : {
        command: 'npm',
        args: ['run', 'mcp'],
        cwd: PROJECT,
        // 浏览器没有单实例锁:空闲断开后再连会多开一个窗口,因此禁用空闲断开
        lifecycle: 'lazy',
        idleTimeout: 0
      }
  if (useHttp && token) entry.headers = { Authorization: `Bearer ${token}` }
  if (has('--direct-all')) entry.directTools = true
  else if (has('--direct-core')) entry.directTools = CORE_TOOLS
  return entry
}

const config = readConfig(target)
const servers = { ...(config.mcpServers ?? {}) }
const previous = servers[SERVER_NAME]
const entry = buildEntry()

if (remove) delete servers[SERVER_NAME]
else servers[SERVER_NAME] = entry

const next = { ...config, mcpServers: servers }
if (toolPrefix) next.settings = { ...(config.settings ?? {}), toolPrefix }
const output = JSON.stringify(next, null, 2) + '\n'

const skillIsSource = resolve(skillTarget) === resolve(skillSource)

console.log(`目标文件: ${target}`)
console.log(`模式:     ${remove ? '卸载' : useHttp ? `HTTP(127.0.0.1:${port})` : 'stdio(pi 自动拉起浏览器)'}`)
if (previous && !remove) console.log('覆盖:     该条目已存在,将被替换')
if (toolPrefix) console.log(`前缀:     settings.toolPrefix → ${toolPrefix}(影响所有服务器)`)
if (Object.keys(servers).length > 1) {
  console.log(`保留:     其它 ${Object.keys(servers).length - (remove ? 0 : 1)} 个服务器不受影响`)
}
if (withSkill) {
  const action = skillIsSource ? '源即目标,跳过' : remove ? '将移除' : '将安装'
  console.log(`skill:    ${action} ${skillTarget}`)
}

if (dryRun) {
  console.log('\n--- dry-run,未写入 ---')
  console.log(output)
  process.exit(0)
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, output)
console.log(remove ? '✓ 已卸载配置条目' : `✓ 已写入 ${SERVER_NAME} 条目`)

if (withSkill && !skillIsSource) {
  if (remove) {
    // 只删除我们自己的 skill 目录
    let mine = false
    try {
      mine = existsSync(skillTarget) && readFileSync(skillTarget, 'utf-8').includes(`name: ${SKILL_NAME}`)
    } catch {
      mine = false
    }
    if (mine) {
      rmSync(dirname(skillTarget), { recursive: true, force: true })
      console.log('✓ 已移除 skill')
    } else {
      console.log('· skill 不存在或不是本项目的,未动')
    }
  } else if (!existsSync(skillSource)) {
    console.log(`⚠ 找不到 skill 源文件 ${skillSource},跳过`)
  } else {
    mkdirSync(dirname(skillTarget), { recursive: true })
    copyFileSync(skillSource, skillTarget)
    console.log(`✓ 已安装 skill → ${skillTarget}`)
  }
}

if (!remove && useHttp) {
  console.log('\n下一步:先启动常驻浏览器,再重启 pi')
  console.log(`  npm run mcp:http${token ? `   # 记住 MCP_HTTP_TOKEN=${token}` : ''}`)
} else if (!remove) {
  console.log('\n下一步:重启 pi(服务器清单与 skill 都在启动时加载)')
}
if (!remove && withSkill) {
  console.log(`\nskill 会以 /skill:${SKILL_NAME} 注册。模型不一定会主动加载它 ——`)
  console.log('需要时直接输入该命令强制加载(参数跟在后面即可)。')
}
if (!remove && !has('--direct-all') && !has('--direct-core')) {
  console.log('\n提示:代理模式下工具 schema 不常驻上下文,模型需先 describe。')
  console.log('     若发现模型不主动调用,可重跑并加 --direct-core,把常用工具提升为原生工具。')
}
