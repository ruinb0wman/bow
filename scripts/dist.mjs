#!/usr/bin/env node
/**
 * 打包 Windows 产物:产出 dist/win-unpacked/bow.exe(双击即用,自带 Electron 运行时)。
 *
 * 为什么不直接写一行 npm script:
 *  1. `ELECTRON_BUILDER_BINARIES_MIRROR=x electron-builder` 这种内联赋值在 Windows 的
 *     cmd / PowerShell 下不成立(会把变量名当命令名),和 scripts/open-bow.mjs 是同一个原因;
 *  2. electron-builder 除了 Electron 发行包,还要下 nsis / winCodeSign 工具链,
 *     后者只能靠环境变量指定镜像、默认走 GitHub —— 国内网络经常拿不下来
 *     (本项目 scripts/ensure-electron.mjs 就是为同样的问题存在的)。
 *     这里统一解析并注入镜像,保证跨平台、跨网络一致。
 *
 * 用法:
 *   npm run dist                      # 构建 + 打包(--win dir)
 *   npm run dist -- --win portable    # 透传参数给 electron-builder(试别的目标)
 *   node scripts/dist.mjs --no-build  # 跳过前面的 electron-vite build
 *   node scripts/dist.mjs --dry-run   # 只打印将执行什么
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const noBuild = argv.includes('--no-build')
const passthrough = argv.filter((a) => !a.startsWith('--dry-run') && a !== '--no-build' && a !== '--')
/** 默认只打 Windows dir 目标;传了参数就完全交给调用方 */
const ebArgs = passthrough.length ? passthrough : ['--win']

/** 与 scripts/ensure-electron.mjs 同源:显式 env > .npmrc 的 electron_mirror > npmmirror 默认值 */
function resolveElectronMirror() {
  if (process.env.ELECTRON_MIRROR) return process.env.ELECTRON_MIRROR
  try {
    const npmrc = existsSync(join(root, '.npmrc')) ? readFileSync(join(root, '.npmrc'), 'utf-8') : ''
    const m = npmrc.match(/^\s*electron_mirror\s*=\s*(.+?)\s*$/m)
    if (m && m[1]) return m[1].trim()
  } catch {
    /* 读不到就用默认镜像 */
  }
  return 'https://npmmirror.com/mirrors/electron/'
}

/** electron-builder 的工具链(nsis / winCodeSign)只能靠这个环境变量换源 */
const BINARIES_MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const env = {
  ...process.env,
  ELECTRON_MIRROR: resolveElectronMirror(),
  ELECTRON_BUILDER_BINARIES_MIRROR: BINARIES_MIRROR
}

/**
 * 解析包的 bin 入口,直接用 node 拉起。
 *
 * 为什么不用 node_modules/.bin:各包管理器在 Windows 上的垫片命名不一致
 * (npm 生成 .cmd / .ps1,bun 用自己的格式),按文件名猜必然踩空 —— 包自己的
 * package.json 里的 bin 字段才是权威,而且这样不经过 shell,路径带空格也安全。
 */
function resolveBin(pkgName, binName) {
  const pkgDir = join(root, 'node_modules', pkgName)
  const pkgFile = join(pkgDir, 'package.json')
  if (!existsSync(pkgFile)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'))
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName]
    if (!rel) return null
    const target = join(pkgDir, rel)
    return existsSync(target) ? target : null
  } catch {
    return null
  }
}

function requireBin(pkgName, binName, hint) {
  const bin = resolveBin(pkgName, binName)
  if (!bin) {
    console.error(`✗ 找不到 ${pkgName}。${hint}`)
    process.exit(1)
  }
  return bin
}

function run(cmd, args, label) {
  console.log(`\n▶ ${label}\n  ${cmd} ${args.join(' ')}`)
  if (dryRun) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: 'inherit' })
    child.on('error', (e) => reject(new Error(`${label} 无法启动:${e.message}`)))
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} 失败(退出码 ${code})`))))
  })
}

// 预检:两个工具都是本地 devDependency。这里先查清楚,避免后面只报一句难懂的 ENOENT。
const electronViteBin = requireBin('electron-vite', 'electron-vite', '先在仓库目录执行 `bun install`。')
const electronBuilderBin = requireBin(
  'electron-builder',
  'electron-builder',
  '先在仓库目录执行 `bun install`(打包依赖,0.1.0 之后新增)。'
)

console.log('Electron 镜像:        ' + env.ELECTRON_MIRROR)
console.log('builder 工具链镜像:   ' + env.ELECTRON_BUILDER_BINARIES_MIRROR)
console.log('electron-builder 参数:' + ' ' + ebArgs.join(' '))
if (process.platform !== 'win32') {
  console.log('\n⚠ 当前不是 Windows:打 Windows 包通常需要 wine(改写 exe 图标/版本信息),建议在 Windows 侧执行。')
}

try {
  if (!noBuild) {
    await run(process.execPath, [electronViteBin, 'build'], '编译(main / preload / renderer → out/)')
  }
  await run(process.execPath, [electronBuilderBin, ...ebArgs], '打包')
  await run(process.execPath, [join(root, 'scripts', 'verify-dist.mjs')], '产物自检(应用文件 + 运行时依赖)')
  const outDir = join(root, 'dist', 'win-unpacked')
  console.log(
    dryRun
      ? '\n(dry-run,未真正执行)'
      : `\n✅ 完成。产物:${outDir}${process.platform === 'win32' ? '\\bow.exe' : '/bow.exe'}`
  )
} catch (e) {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}
