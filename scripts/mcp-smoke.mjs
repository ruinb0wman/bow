#!/usr/bin/env node
/**
 * MCP 端到端冒烟测试:通过标准 MCP 客户端(stdout/stderr 管道)拉起浏览器并调用全部关键工具。
 *
 * 前置条件:
 *  - 有可用的显示环境(X/Wayland)
 *  - Linux 上若缺 libasound,可用 LD_LIBRARY_PATH 指定(见 README / 本文件顶部 env)
 *
 * 用法: npm run test:mcp
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const transport = new StdioClientTransport({
  command: process.env.ELECTRON_BIN || join(root, 'node_modules', '.bin', 'electron'),
  args: ['.', '--no-sandbox'],
  cwd: root,
  env: {
    ...process.env,
    MCP: 'stdio',
    ...(process.env.SMOKE_LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.SMOKE_LD_LIBRARY_PATH } : {})
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function assert(cond, msg) {
  if (!cond) {
    console.error('✗ 断言失败: ' + msg)
    process.exitCode = 1
    throw new Error(msg)
  }
}

const client = new Client({ name: 'mcp-browser-smoke', version: '0.1.0' })

await client.connect(transport)
console.log('✓ 已连接 MCP stdio')

const { tools } = await client.listTools()
const names = tools.map((t) => t.name)
console.log(`✓ 工具数: ${names.length} -> ${names.join(', ')}`)
assert(names.includes('browser_navigate') && names.includes('browser_screenshot'), '工具清单完整')

// 1. 新标签 + 导航
const nt = await client.callTool({ name: 'browser_new_tab', arguments: { url: 'https://example.com' } })
const tabId = JSON.parse(nt.content[0].text).tabId
console.log('✓ browser_new_tab → tab', tabId)
assert(typeof tabId === 'number', '返回 tabId')

await sleep(3500)

// 2. 信息
const info = await client.callTool({ name: 'browser_get_info', arguments: { tabId } })
const infoText = JSON.parse(info.content[0].text)
console.log('✓ browser_get_info:', infoText.info?.url, '/', infoText.info?.title)
assert(infoText.info?.url?.startsWith('https://'), '已加载页面')

// 3. 快照
const snap = await client.callTool({ name: 'browser_snapshot', arguments: { tabId, maxElements: 50 } })
const snapText = JSON.parse(snap.content[0].text)
console.log(`✓ browser_snapshot: ${snapText.data?.elements?.length ?? 0} 个元素, title=${snapText.data?.title}`)
assert(Array.isArray(snapText.data?.elements), '快照含元素列表')

// 4. 截图(PNG image content)
const shot = await client.callTool({ name: 'browser_screenshot', arguments: { tabId } })
const imageContent = shot.content.find((c) => c.type === 'image')
assert(imageContent && imageContent.mimeType === 'image/png' && imageContent.data.length > 1000, '截图返回 PNG')
console.log(`✓ browser_screenshot: ${(imageContent.data.length / 1024).toFixed(0)} KiB PNG`)
// 落盘便于人工检查
const shotPath = process.env.SMOKE_SHOT_PATH || '/tmp/mcp-shot.png'
writeFileSync(shotPath, Buffer.from(imageContent.data, 'base64'))
console.log(`✓ 截图已保存: ${shotPath}`)

// 5. 列表
const lt = await client.callTool({ name: 'browser_list_tabs', arguments: {} })
const ltText = JSON.parse(lt.content[0].text)
console.log(`✓ browser_list_tabs: ${ltText.tabs.length} 个标签`)
assert(ltText.tabs.some((t) => t.id === tabId), '列表中包含新标签')

// 6. 搜索
const sr = await client.callTool({ name: 'browser_search', arguments: { query: 'electron', engine: 'duckduckgo' } })
const srText = JSON.parse(sr.content[0].text)
console.log('✓ browser_search →', srText.url)
assert(srText.url.includes('duckduckgo.com'), '搜索 URL 正确')

// 7. 点开结果(等待 DuckDuckGo 加载后快照)
await sleep(4000)
const snap2 = await client.callTool({ name: 'browser_snapshot', arguments: { maxElements: 30 } })
const snap2Text = JSON.parse(snap2.content[0].text)
const links = (snap2Text.data?.elements ?? []).filter((e) => e.tag === 'a' && e.href && e.visible)
console.log(`✓ 搜索结果页可见链接: ${links.length} 个, 首个: ${links[0]?.text ?? '-'}`)
if (links[0]) {
  const click = await client.callTool({ name: 'browser_click', arguments: { selector: links[0].selector } })
  console.log('✓ browser_click →', JSON.parse(click.content[0].text))
  await sleep(3500)
  const info2 = await client.callTool({ name: 'browser_get_info', arguments: {} })
  console.log('✓ 点击后地址:', JSON.parse(info2.content[0].text).info?.url)
}

// 7.5 在搜索框输入并回车(验证 browser_type / browser_press_key)
const snapI = await client.callTool({ name: 'browser_snapshot', arguments: {} })
const snapIText = JSON.parse(snapI.content[0].text)
const allInputs = (snapIText.data?.elements ?? []).filter((e) => e.tag === 'input')
const inputs = allInputs.filter((e) => e.visible).length > 0 ? allInputs.filter((e) => e.visible) : allInputs
const inputTarget = inputs.find((e) => e.name || e.id) ?? inputs[0]
if (inputTarget) {
  const ty = await client.callTool({
    name: 'browser_type',
    arguments: { selector: inputTarget.selector, text: '模型上下文协议', clear: true }
  })
  const tyText = JSON.parse(ty.content[0].text)
  assert(tyText.ok === true, '输入成功')
  console.log(`✓ browser_type → value: ${JSON.stringify(tyText.value)}`)
  const kp = await client.callTool({ name: 'browser_press_key', arguments: { key: 'Enter' } })
  const kpText = JSON.parse(kp.content[0].text)
  assert(kpText.ok === true, '回车成功')
  console.log('✓ browser_press_key →', kpText.pressed)
  await sleep(3500)
  const i3 = await client.callTool({ name: 'browser_get_info', arguments: {} })
  console.log('  ↳ 输入搜索后地址:', JSON.parse(i3.content[0].text).info?.url)
} else {
  console.log('⚠ 未找到输入框,跳过 browser_type 测试')
}

// 8. 书签
const bm = await client.callTool({ name: 'browser_add_bookmark', arguments: { title: 'Example', url: 'https://example.com' } })
const bmText = JSON.parse(bm.content[0].text)
console.log('✓ browser_add_bookmark →', bmText.id)
const lb = await client.callTool({ name: 'browser_list_bookmarks', arguments: {} })
const lbText = JSON.parse(lb.content[0].text)
assert(lbText.bookmarks.some((b) => b.url === 'https://example.com'), '书签已持久化')
console.log(`✓ browser_list_bookmarks: ${lbText.bookmarks.length} 条`)

// 9. 关标签
const ct = await client.callTool({ name: 'browser_close_tab', arguments: { tabId } })
console.log('✓ browser_close_tab →', JSON.parse(ct.content[0].text))

await client.close()
console.log('\n✅ MCP 冒烟测试全部通过')
process.exit(0)