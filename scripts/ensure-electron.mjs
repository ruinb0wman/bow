#!/usr/bin/env node
/**
 * Electron 二进制兜底修复(postinstall 钩子)
 *
 * 背景 1:electron 的 postinstall 调用 extract-zip@2.0.1(内部 yauzl@2.10.0)
 * 解压二进制。在 Node 26+ 上 yauzl 读取流会发完数据但永不触发 end/pipeline
 * 结束,install.js 随即"静默成功"(exit 0)退出:
 *   - dist/ 里只留下 locales/ 一个目录
 *   - path.txt 没写(它写在解压完成之后)
 * 结果 electron-vite 的 getElectronPath() 抛 "Error: Electron uninstall"。
 * Bun 运行时的流行为正常,因此这里优先用 bun 重跑 install.js。
 *
 * 背景 2:electron@42+ 起二进制下载改为按需触发,install.js 仍会执行下载,
 * 但镜像解析只能靠环境变量(@electron/get v5 只读 env,npmrc 的
 * `electron_mirror` 需由包管理器转成 npm_config_* 才会生效;bun 不做这
 * 个转换)。因此 Windows 等网络不通 GitHub 的环境会连不上默认源。
 * 这里统一解析镜像(env > .npmrc > npmmirror 默认值),以 ELECTRON_MIRROR
 * 显式注入 install.js,保证跨平台稳定走镜像。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = path.join(root, 'node_modules', 'electron')

/** 解析 Electron 二进制镜像源:显式 env > 项目 .npmrc 的 electron_mirror > npmmirror 默认 */
function resolveMirror() {
  if (process.env.ELECTRON_MIRROR) return process.env.ELECTRON_MIRROR
  try {
    const npmrc = existsSync(path.join(root, '.npmrc')) ? readFileSync(path.join(root, '.npmrc'), 'utf-8') : ''
    const m = npmrc.match(/^\s*electron_mirror\s*=\s*(.+?)\s*$/m)
    if (m && m[1]) return m[1].trim()
  } catch {
    /* 读取失败则用默认镜像 */
  }
  return 'https://npmmirror.com/mirrors/electron/'
}

const MIRROR = resolveMirror()
// @electron/get 的 mirrorVar 依次读 npm_config_electron_mirror / ELECTRON_MIRROR 等,
// 注入 ELECTRON_MIRROR 对 bun/npm 两种运行时都生效
const SPAWN_ENV = { ...process.env, ELECTRON_MIRROR: MIRROR }

function isInstalled() {
  try {
    const exeName = readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim()
    const exe = path.join(electronDir, 'dist', exeName)
    return existsSync(exe) && statSync(exe).size > 1_000_000
  } catch {
    return false
  }
}

// 未安装 electron(比如生产环境 npm install --omit=dev)时直接跳过
if (!existsSync(electronDir)) process.exit(0)
if (isInstalled()) process.exit(0)

console.warn(
  `[ensure-electron] 检测到 Electron 二进制缺失/不完整(常见于 Node 26 + extract-zip 解压静默失败),开始重试安装… 镜像源: ${MIRROR}`
)

for (const [cmd, args] of [
  ['bun', ['node_modules/electron/install.js']],
  ['node', ['node_modules/electron/install.js']],
]) {
  console.log(`[ensure-electron] 尝试: ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: SPAWN_ENV })
  if (isInstalled()) {
    console.log('[ensure-electron] ✅ Electron 二进制已就位')
    process.exit(0)
  }
  if (r.error) console.warn(`[ensure-electron] 无法执行 ${cmd}: ${r.error.message}`)
}

console.error(`
[ensure-electron] ❌ 自动修复失败,请手动执行:
    cd ${root}
    ELECTRON_MIRROR=${MIRROR} bun node_modules/electron/install.js

若仍失败,可改用 Node 22/24 运行 electron 的 postinstall:
    fnm install 22 && fnm use 22
    bun pm untrusted        # 查看哪些依赖的生命周期脚本未运行
    # 若怀疑镜像目录下残留损坏缓存,可先清除后再重试:
    #   rm -rf ~/.cache/electron
`)
process.exit(1)