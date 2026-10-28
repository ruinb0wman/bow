/**
 * 内置 OpenKnowledge 的纯逻辑用例:设置归一、从横幅里认端口、lock 形状校验。
 *
 * 这几条判据写错的表现都很具体:端口认错 = 打开白页;lock 解析抛异常 = 启动轮询直接崩;
 * 设置归一漏掉 = 自启开关点了没反应。所以它们不在 main.ts 里(那里要 electron,跑不了单测)。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings, parseLock, parsePortFromStdout } from '../src/plugins/ok/shared'

/** OK `start` 的真实横幅(实测 0.88.5),首尾留空行 */
const BANNER = `
  ╭─────────────────────────────────────────────────────────╮
  │  open-knowledge v0.88.5                                 │
  │                                                         │
  │  Local:   http://127.0.0.1:45167                        │
  │                                                         │
  │  Open the Editor URL in your browser to start editing.  │
  ╰─────────────────────────────────────────────────────────╯
`

describe('normalizeSettings', () => {
  it('空/坏输入回落到默认值', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('去掉目录两侧空白,其它类型当没设置', () => {
    expect(normalizeSettings({ projectPath: '  /home/u/kb  ' }).projectPath).toBe('/home/u/kb')
    expect(normalizeSettings({ projectPath: 42 }).projectPath).toBe('')
  })

  it('autoStart 只有显式 false 才关(默认开,其它值一律当默认)', () => {
    expect(normalizeSettings({ autoStart: false }).autoStart).toBe(false)
    expect(normalizeSettings({ autoStart: undefined }).autoStart).toBe(true)
    expect(normalizeSettings({ autoStart: 'no' }).autoStart).toBe(true)
  })
})

describe('parsePortFromStdout', () => {
  it('从完整横幅里认出端口', () => {
    expect(parsePortFromStdout(BANNER)).toBe(45167)
  })

  it('横幅跨 chunk 到达也能认(必须喂累积文本)', () => {
    // 按真实情况切两半:第一块停在端口中间
    const first = BANNER.slice(0, 90)
    const second = BANNER.slice(90)
    expect(parsePortFromStdout(first)).toBeNull()
    expect(parsePortFromStdout(first + second)).toBe(45167)
  })

  it('"already running" 那行也算(服务已存在时不打印横幅)', () => {
    const text = 'OpenKnowledge is already running on this project (pid 149716).\n  http://127.0.0.1:45375\n'
    expect(parsePortFromStdout(text)).toBe(45375)
  })

  it('多次出现取最后一个(端口每次随机,后出现的才是当前服务)', () => {
    expect(parsePortFromStdout('http://127.0.0.1:45167\n...restart...\nhttp://127.0.0.1:45375')).toBe(45375)
  })

  it('没有端口 / 越界端口返回 null', () => {
    expect(parsePortFromStdout('')).toBeNull()
    expect(parsePortFromStdout('Local: http://localhost:45167')).toBeNull()
    expect(parsePortFromStdout('http://127.0.0.1:99999')).toBeNull()
  })
})

describe('parseLock', () => {
  const lock = JSON.stringify({
    pid: 151332,
    hostname: 'Albedo',
    port: 45985,
    startedAt: '2026-10-28T04:46:12.883Z',
    worktreeRoot: '/tmp/okprobe',
    kind: 'interactive',
    protocolVersion: 2,
    runtimeVersion: '0.88.5',
    url: 'http://127.0.0.1:45985'
  })

  it('正常 lock 取出 pid / port / url / 版本', () => {
    expect(parseLock(lock)).toEqual({
      pid: 151332,
      port: 45985,
      runtimeVersion: '0.88.5',
      url: 'http://127.0.0.1:45985'
    })
  })

  it('半截 JSON 返回 null(服务刚起时文件可能正被写,不能抛异常)', () => {
    expect(parseLock(lock.slice(0, 40))).toBeNull()
    expect(parseLock('')).toBeNull()
  })

  it('缺 pid / port 或类型不对都当"还没好"', () => {
    expect(parseLock(JSON.stringify({ port: 45985 }))).toBeNull()
    expect(parseLock(JSON.stringify({ pid: 1 }))).toBeNull()
    expect(parseLock(JSON.stringify({ pid: '1', port: 45985 }))).toBeNull()
    expect(parseLock(JSON.stringify({ pid: 1, port: 0 }))).toBeNull()
    expect(parseLock('[]')).toBeNull()
    expect(parseLock('null')).toBeNull()
  })

  it('没有 url 时用端口拼;没有版本就是 null', () => {
    expect(parseLock(JSON.stringify({ pid: 7, port: 8080 }))).toEqual({
      pid: 7,
      port: 8080,
      url: 'http://127.0.0.1:8080',
      runtimeVersion: null
    })
  })
})
