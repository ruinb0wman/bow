/**
 * 本地文件认领注册表 —— 看住这四条语义:
 * ① 按注册顺序问,第一个认领成功的说了算(后面的不再被问);
 * ② 认领了但打不开(返回 false / 抛错)→ 下一个继续接手;
 * ③ 谁都没认领 → 返回 false(调用方照旧开标签 = 今天的行为);
 * ④ 插件停用时 disposer 真的把它摘掉。
 */

import { describe, expect, it } from 'vitest'
import { FileOpenerHost } from '../src/main/plugins/fileOpeners'
import type { LocalFileMode } from '../src/main/plugins/fileOpeners'

type Spec = Parameters<FileOpenerHost['add']>[1]

function opener(opts: {
  match?: (path: string, mode: LocalFileMode) => boolean
  open?: (path: string, mode: LocalFileMode) => boolean
}): Spec {
  return {
    match: opts.match ?? (() => true),
    open: opts.open ?? (() => true)
  }
}

describe('FileOpenerHost.claim', () => {
  it('没人注册时返回 false', () => {
    const host = new FileOpenerHost()
    expect(host.claim('/tmp/a.txt', 'open')).toBe(false)
  })

  it('空路径不认领(不把路径解析的锅丢给插件)', () => {
    const host = new FileOpenerHost()
    host.add('editor', opener({}))
    expect(host.claim('', 'open')).toBe(false)
  })

  it('按注册顺序问,第一个认领成功就停', () => {
    const host = new FileOpenerHost()
    const asked: string[] = []
    host.add('first', opener({ open: () => { asked.push('first'); return true } }))
    host.add('second', opener({ open: () => { asked.push('second'); return true } }))
    expect(host.claim('/tmp/a.txt', 'open')).toBe(true)
    expect(asked).toEqual(['first'])
  })

  it('match 为假的跳过,轮到下一个;`edit` 模式原样传给 match', () => {
    const host = new FileOpenerHost()
    const modes: LocalFileMode[] = []
    host.add('a', opener({ match: (_p, mode) => { modes.push(mode); return false } }))
    host.add('b', opener({ open: () => true }))
    expect(host.claim('/tmp/a.md', 'edit')).toBe(true)
    expect(modes).toEqual(['edit'])
  })

  it('认领了但 open 返回 false → 下一个继续接手', () => {
    const host = new FileOpenerHost()
    const calls: string[] = []
    host.add('a', opener({ open: () => { calls.push('a'); return false } }))
    host.add('b', opener({ open: () => { calls.push('b'); return true } }))
    expect(host.claim('/tmp/a.txt', 'open')).toBe(true)
    expect(calls).toEqual(['a', 'b'])
  })

  it('match / open 抛错只记日志,不影响别的插件,最后可回落', () => {
    const errors: string[] = []
    const host = new FileOpenerHost((id, phase) => errors.push(`${id}:${phase}`))
    host.add('boom-match', opener({ match: () => { throw new Error('x') } }))
    host.add('boom-open', opener({ open: () => { throw new Error('y') } }))
    expect(host.claim('/tmp/a.txt', 'open')).toBe(false)
    expect(errors).toEqual(['boom-match:match', 'boom-open:open'])
  })

  it('disposer 摘掉注册者(插件停用)', () => {
    const host = new FileOpenerHost()
    const off = host.add('editor', opener({}))
    expect(host.list()).toEqual(['editor'])
    off()
    expect(host.list()).toEqual([])
    expect(host.claim('/tmp/a.txt', 'open')).toBe(false)
  })
})
