#!/usr/bin/env node
/**
 * 打包产物自检:确认 dist/<platform>-unpacked/resources/app.asar 真的能跑起来。
 *
 * 为什么需要它:electron-vite 默认**外部化依赖**,主进程 bundle 里留着
 * `require("@modelcontextprotocol/sdk/...")`、`require("zod")` 这类运行时加载,
 * 这些包必须原样出现在 app.asar 的 node_modules 里。一旦缺失,产物双击后立刻
 * MODULE_NOT_FOUND 崩掉 —— 而且崩在主进程,窗口都不弹,极难看出原因。
 *
 * 这里不硬编码包名,而是从 bundle 里**实际扫出**外部 require 再逐个核对,
 * 所以以后新增依赖忘了配置也能被抓住。
 *
 * 用法:
 *   node scripts/verify-dist.mjs                # 自动找 dist/<平台>-unpacked/resources/app.asar
 *   node scripts/verify-dist.mjs <app.asar>
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { externalRequires } from './lib/externalRequires.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 解析 asar 头部。
 * 不依赖固定偏移:asar 头是「4 个 UInt32 前缀 + JSON + 填充」,各版本填充长度不一致,
 * 所以直接做括号配对扫描 + JSON.parse(遇到字符串与转义要跳过)。
 */
function readAsarHeader(buf) {
  const start = buf.indexOf(0x7b) // '{'
  if (start < 0) throw new Error('不是有效的 asar:找不到头部 JSON')
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < buf.length; i++) {
    const c = buf[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === 0x5c) esc = true
      else if (c === 0x22) inStr = false
      continue
    }
    if (c === 0x22) inStr = true
    else if (c === 0x7b) depth += 1
    else if (c === 0x7d) {
      depth -= 1
      if (depth === 0) return JSON.parse(buf.subarray(start, i + 1).toString('utf8'))
    }
  }
  throw new Error('asar 头部 JSON 未闭合')
}

/**
 * 把 asar 头部里的文件树摊平成路径列表(统一用 / 分隔,兼容 Windows 打的包)。
 * 目录本身也要登记 —— 否则像 node_modules/zod 这种「存在与否」按目录判定会永远匹配不上。
 */
function collectEntries(node, prefix = '') {
  const out = []
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    out.push(p)
    if (value && typeof value === 'object' && 'files' in value) out.push(...collectEntries(value, p))
  }
  return out
}

/** 当前平台 dir 目标的目录名(优先检查,避免 dist 里同时存在多平台产物时看错平台) */
function platformDirs() {
  switch (process.platform) {
    case 'win32':
      return ['win-unpacked', 'win-arm64-unpacked']
    case 'linux':
      return ['linux-unpacked', 'linux-arm64-unpacked']
    case 'darwin':
      return ['mac', 'mac-arm64', 'mac-universal']
    default:
      return []
  }
}

function findAsar(argPath) {
  if (argPath) return argPath
  const distDir = join(root, 'dist')
  if (!existsSync(distDir)) return null
  const names = readdirSync(distDir)
  const preferred = platformDirs().filter((n) => names.includes(n))
  // 先看当前平台目录,再按字母序退回其余目录(顺序确定,保证可复现)
  const ordered = [...preferred, ...names.filter((n) => !preferred.includes(n)).sort()]
  for (const name of ordered) {
    const candidate = join(distDir, name, 'resources', 'app.asar')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const asarPath = findAsar(process.argv[2])
if (!asarPath) {
  console.error('✗ 找不到 app.asar。先在仓库里跑 `npm run dist`,或用参数指定路径。')
  process.exit(1)
}
if (!existsSync(asarPath)) {
  console.error(`✗ 文件不存在:${asarPath}`)
  process.exit(1)
}

console.log(
  `检查产物:${asarPath.startsWith(root) ? relative(root, asarPath) : asarPath} (${(statSync(asarPath).size / 1024 / 1024).toFixed(1)} MiB)`
)

const entries = collectEntries(readAsarHeader(readFileSync(asarPath)))
const entrySet = new Set(entries)
const failures = []

// 1) 应用自身文件必须齐全
for (const required of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
  if (!entrySet.has(required)) failures.push(`缺少应用文件:${required}`)
}

// 2) bundle 里外部化的运行时依赖必须在 asar 里
const mainBundle = join(root, 'out', 'main', 'index.js')
if (!existsSync(mainBundle)) {
  failures.push('缺少 out/main/index.js —— 先跑 npm run build')
} else {
  const required = externalRequires(readFileSync(mainBundle, 'utf-8'))
  const missing = required.filter((name) => !entrySet.has(`node_modules/${name}`))
  console.log(`运行时外部依赖 ${required.length} 个:${required.join(', ')}`)
  for (const name of missing) failures.push(`asar 里缺少运行时依赖:node_modules/${name}`)
}

// 3) 顺手确认没有把开发依赖整包塞进去(体积异常通常意味着打包范围失控)
const devOnly = ['electron-builder', 'vitest', 'typescript']
const packedDevDeps = devOnly.filter((name) => entrySet.has(`node_modules/${name}`))

console.log(`asar 条目总数:${entries.length}`)
if (packedDevDeps.length) console.log(`⚠ 疑似打进开发依赖(仅提示,多半无害):${packedDevDeps.join(', ')}`)

if (failures.length) {
  console.error('\n✗ 产物自检失败:')
  for (const f of failures) console.error(`  · ${f}`)
  console.error('\n这类问题会让 bow 双击后一闪即退(主进程 MODULE_NOT_FOUND)。')
  console.error('检查 package.json 的 build.files 是否漏了 out/**,以及依赖是否声明在 dependencies 而非 devDependencies。')
  process.exit(1)
}

console.log('\n✅ 产物自检通过:应用文件齐全,运行时依赖都在 asar 内。')
