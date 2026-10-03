/**
 * pi 桥接扩展(仓库内 `integrations/pi/bow-agent-state.ts`)与 bow 侧协议、
 * 以及**两份安装实现**(仓库脚本 + 设置页的一键接入)之间的一致。
 *
 * 这个文件不参与 bow 的构建(它是给 pi 加载的),所以没有类型检查与运行期覆盖兜底;
 * 但它的**字符串常量与事件名**必须和 bow 侧逐字对上,否则表现是「什么都没发生」——
 * 最难查的那种。同理,「该装到哪个文件名 / 怎么判断这文件是不是 bow 装的」在两处实现里重复,
 * 这里把三处共享的不变式全部钉住。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOW_OSC_KEY, BOW_OSC_CODE, BOW_SIGNAL_VERSION } from '../src/shared/agentState'
import { PI_BRIDGE_FILENAME, PI_BRIDGE_MARKER, PI_BRIDGE_SOURCE_REL } from '../src/plugins/terminal/piBridge'

const source = readFileSync(new URL('../integrations/pi/bow-agent-state.ts', import.meta.url), 'utf-8')
const installer = readFileSync(new URL('../scripts/install-pi-agent-state.mjs', import.meta.url), 'utf-8')

describe('pi 桥接扩展', () => {
  it('OSC 前缀与协议版本和 bow 侧一致', () => {
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

  it('安装脚本与设置页的一键接入共享同一套不变式(文件名 / 标记 / 源路径)', () => {
    // 扩展源码里必须有归属标记 —— 两份实现都靠它判断「这文件是不是 bow 装的」
    expect(source).toContain(PI_BRIDGE_MARKER)
    // 文件名:pi 只把该目录下的 .ts 当扩展;源文件名与目标文件名是同一个约定
    expect(PI_BRIDGE_FILENAME).toBe('bow-agent-state.ts')
    expect(installer).toContain(PI_BRIDGE_FILENAME)
    // 归属标记:脚本里的字面量必须与常量一致
    expect(installer).toContain(`const marker = '${PI_BRIDGE_MARKER}'`)
    // 源路径:脚本从仓库读,应用从 app.getAppPath() 读 —— 相对路径必须一致
    expect(PI_BRIDGE_SOURCE_REL.join('/')).toBe('integrations/pi/bow-agent-state.ts')
    expect(installer).toContain("'integrations', 'pi', 'bow-agent-state.ts'")
  })

  it('打包配置里带着源目录(否则打包版的一键接入会显示「没有扩展源码」)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
    expect(pkg.build.files).toContain('integrations/**/*')
  })
})
