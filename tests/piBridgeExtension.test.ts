/**
 * pi 插件包(`packages/pi-bow/`)与 bow 侧协议、以及「一键接入」的共享不变式。
 *
 * 这个包不参与 bow 的构建(它是给 pi 加载的),所以没有类型检查与运行期覆盖兜底;
 * 它的**字符串常量与事件名**必须和 bow 侧逐字对上,否则表现是「什么都没发生」—— 最难查的那种。
 * 这里钉三类:①协议(OSC 前缀 / 版本 / 门禁)、②包的形状(manifest / 自包含 / skill 在包里)、
 * ③安装路径(包内源 ↔ 安装脚本 ↔ 设置页一键接入 ↔ `build.files`)。
 *
 * 状态机的行为(三态、done、去重)在 `packages/pi-bow/tests/bow-agent-state.test.ts` 里用假 pi 覆盖。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOW_OSC_KEY, BOW_OSC_CODE, BOW_SIGNAL_VERSION } from '../src/shared/agentState'
import { PI_BRIDGE_FILENAME, PI_BRIDGE_MARKER, PI_BRIDGE_SOURCE_REL } from '../src/plugins/terminal/piBridge'

const pkgRoot = new URL('../packages/pi-bow/', import.meta.url)
const source = readFileSync(new URL('extensions/bow-agent-state.ts', pkgRoot), 'utf-8')
const manifest = JSON.parse(readFileSync(new URL('package.json', pkgRoot), 'utf-8')) as {
  keywords?: string[]
  pi?: { extensions?: string[]; skills?: string[] }
}
const installer = readFileSync(new URL('../scripts/install-pi-agent-state.mjs', import.meta.url), 'utf-8')

describe('协议:pi 侧扩展与 bow 侧逐字一致', () => {
  it('OSC 前缀与协议版本', () => {
    // 源码里写的是转义序列文本(`\x1b]1337;bow;`),与 BOW_OSC_PREFIX 的**值**对应
    expect(source).toContain(`\\x1b]${BOW_OSC_CODE};${BOW_OSC_KEY};`)
    expect(source).toContain('SIGNAL_VERSION = 1')
    expect(BOW_SIGNAL_VERSION).toBe(1)
  })

  it('用一手事件而不是解析 TUI 文本', () => {
    for (const event of ['session_start', 'agent_start', 'agent_settled', 'ui_prompt_start', 'ui_prompt_end', 'session_shutdown']) {
      expect(source, `缺少事件监听:${event}`).toContain(`pi.on('${event}'`)
    }
    // `agent_end` 会在重试/压缩/续跑时提前触发,不能用来判「完成」
    expect(source).not.toContain("pi.on('agent_end'")
  })

  it('用 BOW_TERMINAL 门禁(别的终端里什么都不做)', () => {
    expect(source).toContain("process.env.BOW_TERMINAL === '1'")
    // 这个变量由 bow 的终端插件注入(cleanEnv),名字必须一致
    const cleanEnv = readFileSync(new URL('../src/plugins/terminal/shared.ts', import.meta.url), 'utf-8')
    expect(cleanEnv).toContain('BOW_TERMINAL')
  })
})

describe('包的形状', () => {
  it('是一个 pi 包(pi-package),扩展与 skill 都在包里声明到', () => {
    expect(manifest.keywords).toContain('pi-package')
    expect(manifest.pi?.extensions).toContain('./extensions/*.ts')
    expect(manifest.pi?.skills).toContain('./skills')
    // extensions 目录里真的躺着这个文件(glob 打错字的话这里会先红)
    expect(readdirSync(new URL('extensions/', pkgRoot))).toContain('bow-agent-state.ts')
    expect(existsSync(new URL('skills/bow-browser/SKILL.md', pkgRoot))).toBe(true)
  })

  it('扩展文件必须**自包含**:一键接入会把单个文件复制进 pi 的扩展目录', () => {
    // 复制之后相对路径会找不到,所以只允许 node: 内建与 pi 自己(仅类型导入)
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const s of specifiers) {
      expect(s.startsWith('node:') || s.startsWith('@earendil-works/'), `不允许的 import:${s}`).toBe(true)
    }
    expect(source).not.toContain('import(')
  })
})

describe('安装路径:包内源 ↔ 安装脚本 ↔ 设置页一键接入 ↔ build.files', () => {
  it('扩展源码里有归属标记(两份安装实现都靠它判断「这文件是不是 bow 装的」)', () => {
    expect(source).toContain(PI_BRIDGE_MARKER)
  })

  it('文件名/标记/源路径三处一致', () => {
    // 文件名:pi 只把该目录下的 .ts 当扩展;源文件名与目标文件名是同一个约定
    expect(PI_BRIDGE_FILENAME).toBe('bow-agent-state.ts')
    expect(installer).toContain(PI_BRIDGE_FILENAME)
    // 归属标记:脚本里的字面量必须与常量一致
    expect(installer).toContain(`const marker = '${PI_BRIDGE_MARKER}'`)
    // 源路径:脚本从仓库读,应用从 app.getAppPath() 读 —— 相对路径必须一致
    expect(PI_BRIDGE_SOURCE_REL.join('/')).toBe('packages/pi-bow/extensions/bow-agent-state.ts')
    expect(installer).toContain("'packages', 'pi-bow', 'extensions', 'bow-agent-state.ts'")
    expect(installer).toContain("'packages', 'pi-bow', 'extensions'")
  })

  it('打包配置里带着包内的状态桥源(否则打包版的一键接入会显示「没有扩展源码」)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
    // 只要这一个文件:bow 从不加载 bow-mcp.ts / bow-command.ts,没必要把半个包打进产物
    expect(pkg.build.files).toContain('packages/pi-bow/extensions/bow-agent-state.ts')
  })
})
