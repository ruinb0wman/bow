#!/usr/bin/env node
/**
 * MCP 端到端冒烟测试:通过标准 MCP 客户端调用浏览器并断言全部关键工具。
 *
 * 两种传输:
 *  1. stdio(默认):自己拉起浏览器子进程 —— `npm run test:mcp`
 *  2. HTTP:连接已在运行的常驻浏览器 —— `npm run test:mcp:http` 或 `node scripts/mcp-smoke.mjs --http [url]`
 *     默认 http://127.0.0.1:8765/mcp,可用 MCP_SMOKE_URL 覆盖;设了 MCP_HTTP_TOKEN 会带 Bearer 头。
 *     ⚠️ HTTP 模式下操作的是你正在用的真实浏览器(会开标签、搜网页、截图);
 *        书签写入有副作用,默认跳过,确需验证时设 SMOKE_ALLOW_MUTATIONS=1。
 *
 * 前置条件:
 *  - stdio 模式需有可用的显示环境(X/Wayland)
 *  - Linux 上若缺 libasound,可用 LD_LIBRARY_PATH 指定(见 README / 本文件顶部 env)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const argv = process.argv.slice(2)
const httpFlagAt = argv.indexOf('--http')
const isHttp = httpFlagAt >= 0 || !!process.env.MCP_SMOKE_URL
const httpUrl =
  (httpFlagAt >= 0 && argv[httpFlagAt + 1] && !argv[httpFlagAt + 1].startsWith('--') ? argv[httpFlagAt + 1] : null) ??
  process.env.MCP_SMOKE_URL ??
  'http://127.0.0.1:8765/mcp'
/** HTTP 模式操作的是真实浏览器:默认不做书签写入这类有副作用的操作 */
const allowMutations = !isHttp || process.env.SMOKE_ALLOW_MUTATIONS === '1'

const transport = isHttp
  ? new StreamableHTTPClientTransport(new URL(httpUrl), {
      ...(process.env.MCP_HTTP_TOKEN
        ? { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_HTTP_TOKEN}` } } }
        : {})
    })
  : new StdioClientTransport({
      command: process.env.ELECTRON_BIN || join(root, 'node_modules', '.bin', 'electron'),
      // 无显示环境(CI/容器)可传 SMOKE_ELECTRON_ARGS=--ozone-platform=headless,
      // 但截图可能为黑帧或空图,完整验证仍需真实桌面。
      args: ['.', '--no-sandbox', ...(process.env.SMOKE_ELECTRON_ARGS?.split(' ').filter(Boolean) ?? [])],
      cwd: root,
      env: {
        ...process.env,
        MCP: 'stdio',
        ...(process.env.SMOKE_LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.SMOKE_LD_LIBRARY_PATH } : {})
      }
    })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 PNG base64 读 IHDR 里的宽高(不引依赖:签名 8B + 长度 4B + 'IHDR' 4B + 宽 4B + 高 4B) */
function pngSize(base64) {
  const buf = Buffer.from(base64.slice(0, 64), 'base64')
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function assert(cond, msg, detail) {
  if (!cond) {
    console.error('✗ 断言失败: ' + msg)
    if (detail !== undefined) console.error('  ↳ 返回体: ' + JSON.stringify(detail))
    process.exitCode = 1
    throw new Error(msg)
  }
}

const client = new Client({ name: 'mcp-browser-smoke', version: '0.1.0' })

try {
  await client.connect(transport)
} catch (e) {
  const hint = isHttp
    ? `\n  HTTP 端点连不上:${httpUrl}\n` +
      '  · 浏览器是否以 HTTP 模式常驻?在浏览器所在机器上跑 `npm run mcp:http`\n' +
      '    (Windows 的 PowerShell / cmd 也能跑:环境变量由 scripts/open-bow.mjs 注入,不必手写)\n' +
      '  · WSL2 连 Windows 上的浏览器需要 [wsl2] networkingMode=Mirrored,否则 127.0.0.1 不通\n' +
      '  · 若服务端设了 MCP_HTTP_TOKEN,这里也要设成同一个值'
    : '\n  stdio 模式需要可用的显示环境(X/Wayland);容器/CI 可试 SMOKE_ELECTRON_ARGS=--ozone-platform=headless'
  console.error(`✗ 连接 MCP 失败:${e?.message ?? e}${hint}`)
  process.exit(1)
}
console.log(isHttp ? `✓ 已连接 MCP HTTP: ${httpUrl}` : '✓ 已连接 MCP stdio')

const { tools } = await client.listTools()
const names = tools.map((t) => t.name)
console.log(`✓ 工具数: ${names.length} -> ${names.join(', ')}`)
assert(names.includes('browser_navigate') && names.includes('browser_screenshot'), '工具清单完整')
assert(names.includes('browser_wait'), '等待工具 browser_wait 已注册')
// 插件贡献的工具应随插件激活一并注册(书签插件 / 广告拦截参考插件)
assert(names.includes('browser_add_bookmark'), '书签插件已贡献 MCP 工具')
assert(names.includes('adblock_stats'), '广告拦截插件已贡献 MCP 工具')

// 0. 服务器级使用说明(instructions)应随 initialize 下发
const instructions = client.getInstructions()
assert(typeof instructions === 'string' && instructions.length > 200, 'instructions 已下发')
assert(instructions.includes('isError') && instructions.includes('browser_wait'), 'instructions 含关键约定')
console.log(`✓ instructions 已下发(${instructions.length} 字符)`)

// 1. 新标签 + 导航(默认 waitUntil:'load',返回时已加载完成,无需额外 sleep)
const nt = await client.callTool({ name: 'browser_new_tab', arguments: { url: 'https://example.com' } })
const ntText = JSON.parse(nt.content[0].text)
const tabId = ntText.tabId
console.log(`✓ browser_new_tab → tab ${tabId}, waited=${ntText.waited}`)
assert(typeof tabId === 'number', '返回 tabId', ntText)
assert(nt.isError !== true, 'new_tab 不应报错', ntText)
assert(ntText.waited === true, 'new_tab 默认应等待加载完成(waited=true)', ntText)

// 2. 信息(加载等待已生效:此时不应仍在 loading)
const info = await client.callTool({ name: 'browser_get_info', arguments: { tabId } })
const infoText = JSON.parse(info.content[0].text)
console.log('✓ browser_get_info:', infoText.info?.url, '/', infoText.info?.title)
assert(infoText.info?.url?.startsWith('https://'), '已加载页面')
assert(infoText.info?.loading === false, '加载等待生效:loading 应为 false')

// 2.8 tabId 语义守卫:navigate 必须作用于指定标签,不存在的 tabId 必须报错
//     (曾经:navigate 的 schema 里没有 tabId,而 zod 静默丢弃未知参数 → 静默导航活动标签)
const other = await client.callTool({
  name: 'browser_new_tab',
  arguments: { url: 'https://www.iana.org/', activate: false }
})
const otherId = JSON.parse(other.content[0].text).tabId
// 这次调用必须「真的等到本次导航完成」:
//  - waited=false → 等待被宽限期提前结算(导航才刚开始)
//  - loadedUrl 不是 example.org → 被上一次导航迟到的 did-finish-load 结算了
const navOther = await client.callTool({
  name: 'browser_navigate',
  arguments: { url: 'https://example.org/', tabId: otherId, waitUntil: 'load' }
})
const navOtherText = JSON.parse(navOther.content[0].text)
assert(navOther.isError !== true, 'navigate{tabId} 不应报错', navOtherText)
assert(navOtherText.waited === true, 'navigate{tabId} 必须等到真实加载完成(waited=true)', navOtherText)
assert(
  String(navOtherText.loadedUrl).startsWith('https://example.org'),
  'navigate{tabId} 返回的 loadedUrl 必须是本次导航后的地址',
  navOtherText
)
const otherInfo = JSON.parse(
  (await client.callTool({ name: 'browser_get_info', arguments: { tabId: otherId } })).content[0].text
)
assert(
  String(otherInfo.info?.url).startsWith('https://example.org'),
  `navigate 未作用于指定标签,实际 ${otherInfo.info?.url}`,
  otherInfo
)
const untouched = JSON.parse(
  (await client.callTool({ name: 'browser_get_info', arguments: { tabId } })).content[0].text
)
assert(
  String(untouched.info?.url).startsWith('https://example.com'),
  `navigate 误改了活动标签,实际 ${untouched.info?.url}`,
  untouched
)
console.log(`✓ browser_navigate {tabId} 就地导航标签 ${otherId},活动标签未被波及`)

const badTab = await client.callTool({
  name: 'browser_navigate',
  arguments: { url: 'https://example.org/', tabId: 999999 }
})
assert(badTab.isError === true, '不存在的 tabId 必须报错(曾经静默导航活动标签)', badTab.content[0].text)
console.log('✓ 不存在的 tabId 已报错:', JSON.parse(badTab.content[0].text).error)

// 2.9 未知参数必须被拒绝,而不是被静默丢弃
const unknownArg = await client.callTool({
  name: 'browser_snapshot',
  arguments: { tabId, maxElement: 10 }
})
assert(unknownArg.isError === true, '未知参数 maxElement 应被拒绝', unknownArg.content[0].text)
assert(String(unknownArg.content[0].text).includes('Unrecognized key'), '报错应指出未知参数')
console.log('✓ 未知参数已被拒绝')

await client.callTool({ name: 'browser_close_tab', arguments: { tabId: otherId } })

// 2.95 浏览器签名:页面侧 UA 应为 bow,且无 Electron / window.process 泄漏
const ua = await client.callTool({
  name: 'browser_eval',
  arguments: { tabId, code: 'navigator.userAgent + "|sep|" + (typeof window.process)' }
})
const uaJson = JSON.parse(ua.content[0].text)
const uaParts = String(uaJson.result).split('|sep|')
const uaStr = uaParts[0] ?? ''
const procType = uaParts[1] ?? ''
assert(/bow\/\d/.test(uaStr), `UA 应含 bow 签名,实际: ${uaStr}`)
assert(!/Electron/.test(uaStr), `UA 不应含 Electron,实际: ${uaStr}`)
assert(procType === 'undefined', '页面不应暴露 window.process')
console.log(`✓ 浏览器签名 UA: ${uaStr}`)

// 2.6 内容注入(广告拦截参考插件,dom-ready 注入标记属性)
const abMark = await client.callTool({
  name: 'browser_eval',
  arguments: { tabId, code: "document.documentElement.getAttribute('data-bow-adblock')" }
})
const abMarkVal = JSON.parse(abMark.content[0].text).result
assert(abMarkVal === '1', `内容注入未生效,data-bow-adblock=${abMarkVal}`)
console.log('✓ 内容注入标记 data-bow-adblock =', abMarkVal)

// 2.7 网络钩子:向拦截清单域名发一个子资源请求,应被取消并计数
await client.callTool({
  name: 'browser_eval',
  arguments: {
    tabId,
    code: "var i=new Image();i.src='https://ad.doubleclick.net/x.png?'+Date.now();document.body.appendChild(i);'sent'"
  }
})
await sleep(900)
const abHook = await client.callTool({ name: 'adblock_stats', arguments: {} })
const abHookText = JSON.parse(abHook.content[0].text)
assert(abHookText.blockedCount >= 1, `网络钩子未拦截,blockedCount=${abHookText.blockedCount}`)
console.log('✓ 网络钩子已拦截子资源请求,blockedCount =', abHookText.blockedCount)

// 3. 快照
const snap = await client.callTool({ name: 'browser_snapshot', arguments: { tabId, maxElements: 50 } })
const snapText = JSON.parse(snap.content[0].text)
console.log(`✓ browser_snapshot: ${snapText.data?.elements?.length ?? 0} 个元素, title=${snapText.data?.title}`)
assert(Array.isArray(snapText.data?.elements), '快照含元素列表')

// 3.5 等待原语:browser_wait 等元素
const wOk = await client.callTool({
  name: 'browser_wait',
  arguments: { tabId, selector: 'body', state: 'attached', timeoutMs: 5000 }
})
assert(wOk.isError !== true, 'browser_wait 等已存在元素应成功')
console.log('✓ browser_wait 命中元素:', JSON.parse(wOk.content[0].text).selector)

// 3.6 等待超时:应 ok=false 且在协议层标记 isError
const wTimeout = await client.callTool({
  name: 'browser_wait',
  arguments: { tabId, selector: '#bow-definitely-not-here', timeoutMs: 500 }
})
const wTimeoutText = JSON.parse(wTimeout.content[0].text)
assert(wTimeout.isError === true, 'browser_wait 超时应标记 isError')
assert(wTimeoutText.ok === false, 'browser_wait 超时 ok 应为 false')
console.log('✓ browser_wait 超时已标记 isError:', wTimeoutText.error)

// 3.7 非法选择器应立即失败,不空等到超时
const invalidStartedAt = Date.now()
const invalidWait = await client.callTool({
  name: 'browser_wait',
  arguments: { tabId, selector: '>>bad>>', timeoutMs: 8000 }
})
const invalidMs = Date.now() - invalidStartedAt
assert(invalidWait.isError === true, '非法选择器应标记 isError')
assert(invalidMs < 3000, `非法选择器应立即失败,实际 ${invalidMs}ms`)
console.log(`✓ browser_wait 非法选择器立即失败(${invalidMs}ms)`)

// 3.8 失败的工具调用不再伪装成成功
const badClick = await client.callTool({ name: 'browser_click', arguments: { tabId, selector: '#bow-nope' } })
assert(badClick.isError === true, 'click 失败应标记 isError')
console.log('✓ browser_click 失败已标记 isError:', JSON.parse(badClick.content[0].text).error)

// 4. 截图(PNG image content)
const shot = await client.callTool({ name: 'browser_screenshot', arguments: { tabId } })
const imageContent = shot.content.find((c) => c.type === 'image')
assert(imageContent && imageContent.mimeType === 'image/png' && imageContent.data.length > 1000, '截图返回 PNG')
console.log(`✓ browser_screenshot: ${(imageContent.data.length / 1024).toFixed(0)} KiB PNG`)
// 落盘便于人工检查
const shotPath = process.env.SMOKE_SHOT_PATH || '/tmp/mcp-shot.png'
writeFileSync(shotPath, Buffer.from(imageContent.data, 'base64'))
console.log(`✓ 截图已保存: ${shotPath}`)

// 4.5 整页截图(fullPage):当前页只有一屏,先塞一个 5000px 高的元素,验证真的截到了视口外
const tall = await client.callTool({
  name: 'browser_eval',
  arguments: {
    tabId,
    code: `document.body.innerHTML = '<div style="height:5000px;background:linear-gradient(#ffffff,#000000)"></div>'; JSON.stringify({
      scrollHeight: document.documentElement.scrollHeight,
      clientWidth: document.documentElement.clientWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio
    })`
  }
})
const doc = JSON.parse(JSON.parse(tall.content[0].text).result)
assert(doc.scrollHeight >= 5000, `注入高页面失败,scrollHeight=${doc.scrollHeight}`, doc)

const full = await client.callTool({ name: 'browser_screenshot', arguments: { tabId, fullPage: true } })
const fullImg = full.content.find((c) => c.type === 'image')
assert(fullImg && fullImg.mimeType === 'image/png', '整页截图返回 PNG', full.content[0]?.text ?? full)
const fullSize = pngSize(fullImg.data)
// 输出分辨率 = 文档 CSS 尺寸 × devicePixelRatio(实测 dpr 1.25 下 12900 CSS px 的页面得到 16125 设备像素)
assert(
  Math.abs(fullSize.width - doc.clientWidth * doc.dpr) <= 2,
  `整页截图宽度应为内容宽 × dpr(${fullSize.width} vs ${doc.clientWidth}×${doc.dpr})`,
  fullSize
)
assert(
  Math.abs(fullSize.height - doc.scrollHeight * doc.dpr) <= 2,
  `整页截图高度应覆盖整页(${fullSize.height} vs ${doc.scrollHeight}×${doc.dpr})`,
  fullSize
)
assert(
  fullSize.height > doc.innerHeight * doc.dpr,
  '整页截图必须高于一屏(视口截图高度)',
  { fullSize, viewport: doc }
)
console.log(`✓ browser_screenshot {fullPage:true}: ${fullSize.width}×${fullSize.height}(视口 ${doc.clientWidth}×${doc.innerHeight} CSS px,dpr ${doc.dpr})`)
const fullShotPath = process.env.SMOKE_FULL_PAGE_SHOT_PATH || shotPath.replace(/\.png$/, '-full.png')
writeFileSync(fullShotPath, Buffer.from(fullImg.data, 'base64'))
console.log(`✓ 整页截图已保存: ${fullShotPath}`)

// 4.6 超过设备像素上限时必须明确报错 —— Chromium 不会报错,而是返回内容重复的错图
//     (实测 dpr 1.25 下 16500 设备像素开始出错,所以按 16000 设备像素卡住)
await client.callTool({
  name: 'browser_eval',
  arguments: { tabId, code: `document.body.innerHTML = '<div style="height:20000px"></div>'` }
})
const tooTall = await client.callTool({ name: 'browser_screenshot', arguments: { tabId, fullPage: true } })
assert(tooTall.isError === true, '超高页面必须报错而不是返回错图', tooTall.content[0]?.text)
assert(
  String(tooTall.content[0]?.text).includes('超过单张整页截图上限'),
  '超高页面应给出上限提示',
  tooTall.content[0]?.text
)
console.log('✓ 超高页面已报错:', JSON.parse(tooTall.content[0].text).error)

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
  // waitUntil:'load' 会等到回车引发的跳转完成,返回体带 waited(默认 'none' 时不带该字段)
  const kp = await client.callTool({
    name: 'browser_press_key',
    arguments: { key: 'Enter', waitUntil: 'load' }
  })
  const kpText = JSON.parse(kp.content[0].text)
  assert(kpText.ok === true, '回车成功')
  assert('waited' in kpText, "waitUntil:'load' 时应返回 waited 字段", kpText)
  console.log(`✓ browser_press_key → ${kpText.pressed}, waited=${kpText.waited}`)
  await sleep(3500)
  const i3 = await client.callTool({ name: 'browser_get_info', arguments: {} })
  console.log('  ↳ 输入搜索后地址:', JSON.parse(i3.content[0].text).info?.url)
} else {
  console.log('⚠ 未找到输入框,跳过 browser_type 测试')
}

// 8. 书签(HTTP 模式操作真实浏览器,默认跳过写入)
if (allowMutations) {
  const bm = await client.callTool({ name: 'browser_add_bookmark', arguments: { title: 'Example', url: 'https://example.com' } })
  const bmText = JSON.parse(bm.content[0].text)
  console.log('✓ browser_add_bookmark →', bmText.id)
} else {
  console.log('⏭ 跳过 browser_add_bookmark(HTTP 模式,避免改动真实书签;需要就设 SMOKE_ALLOW_MUTATIONS=1)')
}
const lb = await client.callTool({ name: 'browser_list_bookmarks', arguments: {} })
const lbText = JSON.parse(lb.content[0].text)
assert(Array.isArray(lbText.bookmarks), '书签列表可读', lbText)
if (allowMutations) assert(lbText.bookmarks.some((b) => b.url === 'https://example.com'), '书签已持久化')
console.log(`✓ browser_list_bookmarks: ${lbText.bookmarks.length} 条`)

// 9. 广告拦截参考插件统计
const ab = await client.callTool({ name: 'adblock_stats', arguments: {} })
const abText = JSON.parse(ab.content[0].text)
assert(typeof abText.blockedCount === 'number' && abText.networkRuleCount + abText.cosmeticRuleCount > 0, 'adblock_stats 返回统计')
console.log(
  `✓ adblock_stats: 已拦截 ${abText.blockedCount} 次 / ${abText.networkRuleCount} 条网络规则 + ${abText.cosmeticRuleCount} 条元素规则(启用=${abText.enabled})`
)

// 10. 关标签
const ct = await client.callTool({ name: 'browser_close_tab', arguments: { tabId } })
console.log('✓ browser_close_tab →', JSON.parse(ct.content[0].text))

await client.close()
console.log('\n✅ MCP 冒烟测试全部通过')
process.exit(0)