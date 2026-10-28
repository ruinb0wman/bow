/**
 * `scripts/install-pi-agent-state.mjs` —— pi 状态桥扩展的**唯一**安装路径(应用内那份一键接入已删除)。
 *
 * 跑真脚本 + 真临时目录,验三件最容易坏的事:幂等(内容相同不重写)、归属(别人的同名文件不覆盖)、
 * 卸载只删自己那个。`--extension-dir` 就是给这里用的,所以不会碰到真实的 `~/.pi`。
 *
 * 与 `tests/piBridgeExtension.test.ts` 的分工:那边钉字符串/路径约定(脚本 ↔ 包内源),这里跑行为。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = new URL('../scripts/install-pi-agent-state.mjs', import.meta.url).pathname
const source = readFileSync(new URL('../packages/pi-bow/extensions/bow-agent-state.ts', import.meta.url), 'utf-8')

let dir = ''
const target = (): string => join(dir, 'bow-agent-state.ts')

/** 返回 stdout;非零退出码抛错(调用方用 `runFail` 断言失败面)。stderr 收起来,免得意料中的失败刷屏 */
function run(...args: string[]): string {
  return execFileSync(process.execPath, [script, '--extension-dir', dir, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function runFail(...args: string[]): string {
  try {
    run(...args)
  } catch (e) {
    return String((e as { stderr?: string }).stderr ?? '')
  }
  throw new Error(`应当失败却成功了:${args.join(' ')}`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bow-pi-bridge-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('install-pi-agent-state.mjs', () => {
  it('装出与包内源逐字相同的文件,带 managed by bow 标记', () => {
    expect(run()).toContain('已安装')
    expect(readFileSync(target(), 'utf-8')).toBe(source)
    expect(source).toContain('managed by bow')
  })

  it('重复跑是幂等的:文件内容不变,输出说「已是最新」', () => {
    run()
    const first = readFileSync(target(), 'utf-8')
    expect(run()).toContain('已是最新')
    expect(readFileSync(target(), 'utf-8')).toBe(first)
  })

  it('源文件变了才更新(改一行再跑)', () => {
    run()
    writeFileSync(target(), source.replace('managed by bow', 'managed by bow (旧)'), 'utf-8')
    expect(run()).toContain('已更新')
    expect(readFileSync(target(), 'utf-8')).toBe(source)
  })

  it('目标存在但不是 bow 装的:拒绝覆盖,除非 --force', () => {
    writeFileSync(target(), '// 用户自己的扩展\n', 'utf-8')
    expect(runFail()).toContain('拒绝覆盖')
    expect(readFileSync(target(), 'utf-8')).toBe('// 用户自己的扩展\n')
    run('--force')
    expect(readFileSync(target(), 'utf-8')).toBe(source)
  })

  it('--uninstall 只删 bow 装的那个;没装时说「未安装」', () => {
    expect(run('--uninstall')).toContain('未安装')
    run()
    expect(run('--uninstall')).toContain('已卸载')
    expect(existsSync(target())).toBe(false)
  })

  it('--uninstall 不碰别人的同名文件', () => {
    writeFileSync(target(), '// 用户自己的扩展\n', 'utf-8')
    expect(runFail('--uninstall')).toContain('拒绝删除')
    expect(existsSync(target())).toBe(true)
  })

  it('--dry-run 什么都不写,--print 只吐源码', () => {
    expect(run('--dry-run')).toContain('[dry-run]')
    expect(existsSync(target())).toBe(false)
    expect(run('--print')).toBe(source)
    expect(existsSync(target())).toBe(false)
  })
})
